// RAG CLIツール — サーバー不要で直接RAGモジュールを使用
import { generateEmbedding, generateEmbeddings } from "../lib/rag/embedding";
import {
  initDb,
  hybridSearch,
  addChunks,
  listSources,
  removeSource,
  getStatus,
  upsertSourceFile,
  getStaleOrDeletedSources,
  getAllChunks,
} from "../lib/rag/vectorStore";
import { loadDocument } from "../lib/rag/documentLoader";
import { chunkDocument } from "../lib/rag/chunker";
import {
  buildSoftMatchaIndex,
  searchSoftMatcha,
  hasSoftMatchaIndex,
  getSoftMatchaStatus,
} from "../lib/rag/softmatcha";
import { streamText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { promises as fs } from "fs";
import * as path from "path";
import { addIndexedDir } from "../lib/rag/config";
import {
  generateGeminiEmbedding,
  generateGeminiEmbeddings,
  generateGeminiMultimodalEmbedding,
  cosineSimilarity,
  setGeminiModel,
  getGeminiModelId,
  GEMINI_EMBEDDING_DIMENSIONS,
} from "../lib/rag/geminiEmbedding";
import {
  MEDIA_EXTENSIONS,
  isMediaFile,
  chunkMediaFile,
} from "../lib/rag/multimodal";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import * as os from "os";


const SYSTEM_PROMPT = `あなたは親切なナレッジベースアシスタントです。
以下の参照情報を基に、ユーザーの質問に日本語で回答してください。
参照情報に含まれない内容は「ナレッジベースに該当する情報がありません」と正直に伝えてください。
回答は簡潔で分かりやすくしてください。
参照情報がある場合は、回答の最後に「参照ソース」として元のファイル名を箇条書きで示してください。`;

/** 質問 → RAG検索 → Gemini回答 */
async function ask(query: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error(
      "GEMINI_API_KEY が設定されていません。.bashrc または .env.local を確認してください。",
    );
    process.exit(1);
  }

  initDb();

  const status = getStatus();
  let contextText = "";

  if (status.totalChunks > 0) {
    console.error("検索中...");
    const queryEmbedding = await generateEmbedding(query, "RETRIEVAL_QUERY");
    const searchResults = hybridSearch(queryEmbedding, query, 5);

    if (searchResults.length > 0) {
      contextText = searchResults
        .map((r, i) => `[${i + 1}] (${r.chunk.source})\n${r.chunk.text}`)
        .join("\n\n");

      // 参照ソースを表示（ハイブリッド検索情報つき）
      console.error("\n--- 参照ソース ---");
      searchResults.forEach((r) => {
        const sources = [];
        if (r.vectorRank !== null) sources.push(`Vec:${r.vectorRank}`);
        if (r.bm25Rank !== null) sources.push(`BM25:${r.bm25Rank}`);
        console.error(
          `  - ${r.chunk.source} (スコア: ${r.score.toFixed(4)}, ${sources.join(", ")})`,
        );
      });
      console.error("---\n");
    }
  }

  const contextualPrompt = contextText
    ? `--- 参照情報 ---\n${contextText}\n--- 参照情報ここまで ---\n\n質問: ${query}`
    : `ナレッジベースに情報が登録されていません。一般的な知識で回答してください。\n\n質問: ${query}`;

  const google = createGoogleGenerativeAI({ apiKey });
  const result = streamText({
    model: google("gemini-2.5-flash"),
    system: SYSTEM_PROMPT,
    prompt: contextualPrompt,
  });

  // ストリーミング出力
  for await (const chunk of result.textStream) {
    process.stdout.write(chunk);
  }
  console.log();
}

/** ファイルを文書登録 */
async function add(filePath: string) {
  initDb();

  console.log(`読み込み中: ${filePath}`);
  const doc = await loadDocument(filePath);

  const chunks =
    chunkDocument(doc.text, doc.format);

  if (chunks.length === 0) {
    console.error("テキストが空です");
    process.exit(1);
  }

  console.log(`チャンク分割: ${chunks.length}チャンク`);
  console.log("埋め込み生成中...");
  const embeddings = await generateEmbeddings(chunks, "RETRIEVAL_DOCUMENT");

  const chunkData = chunks.map((text, i) => ({
    text,
    source: doc.source,
    chunkIndex: i,
  }));
  addChunks(chunkData, embeddings);

  console.log(`完了: ${doc.source} (${chunks.length}チャンク登録)`);
}

/** ソース一覧表示 */
function list() {
  initDb();
  const sources = listSources();

  if (sources.length === 0) {
    console.log("登録済みソースはありません");
    return;
  }

  console.log(`登録済みソース (${sources.length}件):\n`);
  sources.forEach((s) => {
    console.log(`  ${s.source}  (${s.chunkCount}チャンク, ${s.createdAt})`);
  });
}

/** ソース削除 */
function remove(source: string) {
  initDb();
  const removed = removeSource(source);

  if (removed === 0) {
    console.error(`ソース "${source}" が見つかりません`);
    process.exit(1);
  }

  console.log(`削除: ${source} (${removed}チャンク)`);
}

/** ディレクトリ一括登録（MCPを通さず直接DB書き込み） */
async function addDir(dirPath: string, batchSize: number) {
  const SUPPORTED_EXTS = new Set([".md", ".txt", ".pdf", ".json", ".csv", ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".rb", ".sh"]);
  const SKIP_DIRS = new Set([".git", ".obsidian", "node_modules", "Excalidraw", ".claude"]);

  // 再帰的にファイル収集
  async function collectFiles(dir: string): Promise<string[]> {
    const files: string[] = [];
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return files;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        files.push(...await collectFiles(fullPath));
      } else if (stat.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTS.has(ext)) files.push(fullPath);
      }
    }
    return files;
  }

  initDb();
  const resolvedDir = path.resolve(dirPath);
  console.log(`ディレクトリ: ${resolvedDir}`);
  console.log("ファイル収集中...");

  const files = await collectFiles(resolvedDir);
  if (files.length === 0) {
    console.error("対応ファイルが見つかりませんでした");
    process.exit(1);
  }
  console.log(`${files.length}ファイル検出`);

  // フェーズ1: 全ファイルを読み込み・チャンク分割
  interface FileChunks {
    source: string;
    filePath: string;
    mtimeMs: number;
    textChunks: string[];
  }
  const fileChunksList: FileChunks[] = [];
  let totalChunks = 0;
  let errorCount = 0;

  for (const filePath of files) {
    try {
      const doc = await loadDocument(filePath);
      // 中身がないファイルはスキップ（GDriveと同じ基準）
      if (!doc.text || doc.text.trim().length < 50) continue;
      const resolvedFilePath = path.resolve(filePath);
      const fileStat = await fs.stat(resolvedFilePath);
      const relativePath = path.relative(resolvedDir, filePath);

      const textChunks =
        chunkDocument(doc.text, doc.format);

      if (textChunks.length === 0) continue;

      fileChunksList.push({
        source: relativePath,
        filePath: resolvedFilePath,
        mtimeMs: fileStat.mtimeMs,
        textChunks,
      });
      totalChunks += textChunks.length;
    } catch (error) {
      errorCount++;
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`  エラー: ${path.relative(resolvedDir, filePath)}: ${msg}`);
    }
  }

  console.log(`${fileChunksList.length}ファイル, ${totalChunks}チャンク`);

  // フェーズ2: 全チャンクをまとめてエンベディング生成
  const allTexts = fileChunksList.flatMap((f) => f.textChunks);
  console.log(`エンベディング生成中...（バッチサイズ: ${batchSize}）`);
  const allEmbeddings = await generateEmbeddings(allTexts, "RETRIEVAL_DOCUMENT", { batchSize });

  // フェーズ3: ファイルごとにDB保存
  let embeddingOffset = 0;
  let successCount = 0;
  for (const fc of fileChunksList) {
    try {
      removeSource(fc.source);
      const embeddings = allEmbeddings.slice(embeddingOffset, embeddingOffset + fc.textChunks.length);
      embeddingOffset += fc.textChunks.length;

      const chunks = fc.textChunks.map((text, i) => ({
        text,
        source: fc.source,
        chunkIndex: i,
      }));
      addChunks(chunks, embeddings);
      upsertSourceFile(fc.source, fc.filePath, fc.mtimeMs);
      successCount++;
    } catch (error) {
      errorCount++;
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`  エラー: ${fc.source}: ${msg}`);
    }
  }

  // インデックス対象ディレクトリをconfigに記録
  addIndexedDir(resolvedDir);

  console.log(`完了: ${successCount}ファイル, ${totalChunks}チャンク（エラー: ${errorCount}件）`);
}

/** トリプルハイブリッド検索（AI回答なし） */
async function searchOnly(query: string, topK: number, engine?: string) {
  // Gemini検索モード
  if (engine === "gemini") {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("GEMINI_API_KEY が設定されていません。");
      process.exit(1);
    }
    const geminiDbPath = getGeminiDbPath();
    if (!require("fs").existsSync(geminiDbPath)) {
      console.error(`❌ Gemini DB が見つかりません: ${geminiDbPath}`);
      console.error(`   先に build-gemini-index を実行してください。`);
      process.exit(1);
    }

    console.log(`検索 [Gemini Embedding 2]: "${query}" (top ${topK})`);
    const queryEmb = await generateGeminiEmbedding(query, apiKey, {
      taskType: "RETRIEVAL_QUERY",
    });
    const results = searchGeminiDb(queryEmb, topK);

    if (results.length === 0) {
      console.log("該当するドキュメントが見つかりませんでした");
      return;
    }

    results.forEach((r, i) => {
      console.log(`\n[${i + 1}] ${r.source} (距離: ${r.distance.toFixed(4)})`);
      console.log(r.text.slice(0, 200));
    });
    return;
  }

  // 通常のruri検索
  initDb();

  console.log(`検索: "${query}" (top ${topK})`);
  const queryEmbedding = await generateEmbedding(query, "RETRIEVAL_QUERY");

  // SoftMatcha検索（インデックスがあれば）
  let softmatchaResults: Array<{ score: number; chunk_ids: number[] }> | undefined;
  if (hasSoftMatchaIndex()) {
    try {
      const smResults = await searchSoftMatcha(query, topK * 2);
      if (smResults.length > 0) {
        softmatchaResults = smResults.map((r) => ({
          score: r.score,
          chunk_ids: r.chunk_ids,
        }));
      }
    } catch (e) {
      console.error(`[softmatcha] 検索スキップ: ${e}`);
    }
  }

  // トリプルハイブリッド検索（RRF統合）
  const rrfResults = hybridSearch(queryEmbedding, query, topK, softmatchaResults);

  if (rrfResults.length === 0) {
    console.log("該当するドキュメントが見つかりませんでした");
    return;
  }

  const results = rrfResults;

  results.forEach((r, i) => {
    const ranks = [];
    if (r.vectorRank !== null) ranks.push(`Vec:${r.vectorRank}`);
    if (r.bm25Rank !== null) ranks.push(`BM25:${r.bm25Rank}`);
    if (r.softmatchaRank !== null) ranks.push(`SM:${r.softmatchaRank}`);
    console.log(`\n[${i + 1}] ${r.chunk.source} (RRF: ${r.score.toFixed(4)}, ${ranks.join(", ")})`);
    console.log(r.chunk.text.slice(0, 200));
  });
}

/** SoftMatchaインデックス構築 */
async function buildSoftmatcha() {
  initDb();

  const chunks = getAllChunks();
  if (chunks.length === 0) {
    console.error("チャンクがありません。先にドキュメントを追加してください。");
    process.exit(1);
  }

  console.log(`SoftMatchaインデックス構築開始（${chunks.length}チャンク）`);
  const result = await buildSoftMatchaIndex(chunks);

  if (result.ok) {
    console.log(`完了（${chunks.length}チャンク, ${result.numTokens}トークン）`);
  } else {
    console.error(`エラー: ${result.error}`);
    process.exit(1);
  }
}

/** 更新チェック（レポートのみ） */
function checkUpdates() {
  initDb();

  const { stale, deleted } = getStaleOrDeletedSources();

  if (stale.length === 0 && deleted.length === 0) {
    console.log("すべてのインデックスは最新です");
    return;
  }

  if (stale.length > 0) {
    console.log(`更新されたファイル（${stale.length}件）:`);
    for (const s of stale) {
      console.log(`  - ${s.source}`);
    }
  }
  if (deleted.length > 0) {
    console.log(`削除されたファイル（${deleted.length}件）:`);
    for (const d of deleted) {
      console.log(`  - ${d}`);
    }
  }
  console.log("\nsync-updates を実行するとインデックスを更新できます。");
}

/** 更新同期（変更ファイルを再インデックス） */
async function syncUpdates() {
  initDb();

  const { stale, deleted } = getStaleOrDeletedSources();

  if (stale.length === 0 && deleted.length === 0) {
    console.log("すべてのインデックスは最新です。更新不要。");
    return;
  }

  // 削除されたファイルをインデックスから除去
  for (const source of deleted) {
    const count = removeSource(source);
    console.log(`削除: ${source}（${count}チャンク除去）`);
  }

  // 更新されたファイルを再インデックス
  for (const { source, filePath } of stale) {
    try {
      const doc = await loadDocument(filePath);
      const stat = await fs.stat(filePath);
      removeSource(source);

      const textChunks =
        chunkDocument(doc.text, doc.format);

      if (textChunks.length === 0) {
        console.log(`スキップ: ${source}（テキストなし）`);
        continue;
      }

      const embeddings = await generateEmbeddings(textChunks, "RETRIEVAL_DOCUMENT");
      const chunks = textChunks.map((text, i) => ({
        text,
        source,
        chunkIndex: i,
      }));
      const ids = addChunks(chunks, embeddings);
      upsertSourceFile(source, filePath, stat.mtimeMs);
      console.log(`更新: ${source}（${ids.length}チャンク）`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`エラー: ${source} - ${msg}`);
    }
  }

  console.log("同期完了");
}

/** ruri-v3-30m vs Gemini Embedding 2 比較検索 */
async function compare(query: string, topK: number) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY が設定されていません。");
    process.exit(1);
  }

  initDb();

  // === Phase 1: ruri-v3-30m（ローカル）で検索 ===
  console.log(`\n🔍 クエリ: "${query}"\n`);
  console.log("━".repeat(60));

  const ruriStart = performance.now();
  console.log("⏳ ruri-v3-30m で検索中...");
  const queryEmbedding = await generateEmbedding(query, "RETRIEVAL_QUERY");

  // SoftMatcha検索（インデックスがあれば）
  let softmatchaResults: Array<{ score: number; chunk_ids: number[] }> | undefined;
  if (hasSoftMatchaIndex()) {
    try {
      const smResults = await searchSoftMatcha(query, topK * 2);
      if (smResults.length > 0) {
        softmatchaResults = smResults.map((r) => ({
          score: r.score,
          chunk_ids: r.chunk_ids,
        }));
      }
    } catch {
      // SoftMatchaエラーはスキップ
    }
  }

  const ruriResults = hybridSearch(queryEmbedding, query, topK, softmatchaResults);
  const ruriTime = performance.now() - ruriStart;

  // === Phase 2: Gemini Embedding（API）でリスコアリング ===
  console.log(`⏳ ${getGeminiModelId()} で検索中...`);
  const geminiStart = performance.now();

  // ruriが見つけたチャンク + 追加でDBから幅広く取得（最大30件）
  const expandedRuriResults = hybridSearch(queryEmbedding, query, 30, softmatchaResults);
  const candidateChunks = expandedRuriResults.map((r) => r.chunk);

  if (candidateChunks.length === 0) {
    console.log("該当するドキュメントが見つかりませんでした");
    return;
  }

  // クエリとチャンクをまとめてGemini Embedding 2でベクトル化
  const allTexts = [query, ...candidateChunks.map((c) => c.text)];
  const geminiEmbeddings = await generateGeminiEmbeddings(allTexts, apiKey, {
    taskType: "RETRIEVAL_QUERY",
  });

  const queryGeminiEmb = geminiEmbeddings[0];
  const chunkGeminiEmbs = geminiEmbeddings.slice(1);

  // コサイン類似度でランキング
  const geminiScored = candidateChunks.map((chunk, i) => ({
    chunk,
    similarity: cosineSimilarity(queryGeminiEmb, chunkGeminiEmbs[i]),
  }));
  geminiScored.sort((a, b) => b.similarity - a.similarity);
  const geminiResults = geminiScored.slice(0, topK);
  const geminiTime = performance.now() - geminiStart;

  // === Phase 3: 結果を並べて表示 ===
  console.log("\n" + "━".repeat(60));
  console.log("📊 比較結果");
  console.log("━".repeat(60));

  // 処理時間
  console.log(`\n⏱  処理時間:`);
  console.log(`   ruri-v3-30m (ローカル):     ${ruriTime.toFixed(0)}ms`);
  console.log(`   ${getGeminiModelId()} (API):   ${geminiTime.toFixed(0)}ms`);

  // ruri結果
  console.log(`\n${"─".repeat(60)}`);
  console.log(`🏠 ruri-v3-30m（ローカル・256次元・トリプルハイブリッド）`);
  console.log(`${"─".repeat(60)}`);
  ruriResults.forEach((r, i) => {
    const ranks = [];
    if (r.vectorRank !== null) ranks.push(`Vec:${r.vectorRank}`);
    if (r.bm25Rank !== null) ranks.push(`BM25:${r.bm25Rank}`);
    if (r.softmatchaRank !== null) ranks.push(`SM:${r.softmatchaRank}`);
    console.log(`  [${i + 1}] ${r.chunk.source}`);
    console.log(`      RRF: ${r.score.toFixed(4)} (${ranks.join(", ")})`);
    console.log(`      ${r.chunk.text.slice(0, 100)}...`);
  });

  // Gemini結果
  console.log(`\n${"─".repeat(60)}`);
  console.log(`☁️  ${getGeminiModelId()}（API・768次元・ベクトルのみ）`);
  console.log(`${"─".repeat(60)}`);
  geminiResults.forEach((r, i) => {
    console.log(`  [${i + 1}] ${r.chunk.source}`);
    console.log(`      類似度: ${r.similarity.toFixed(4)}`);
    console.log(`      ${r.chunk.text.slice(0, 100)}...`);
  });

  // 一致度分析
  console.log(`\n${"─".repeat(60)}`);
  console.log(`🔄 ランキング一致度`);
  console.log(`${"─".repeat(60)}`);

  const ruriSources = ruriResults.map((r) => r.chunk.source);
  const geminiSources = geminiResults.map((r) => r.chunk.source);
  const commonSources = ruriSources.filter((s) => geminiSources.includes(s));
  const onlyRuri = ruriSources.filter((s) => !geminiSources.includes(s));
  const onlyGemini = geminiSources.filter((s) => !ruriSources.includes(s));

  console.log(`  両方がヒット:       ${commonSources.length}件`);
  if (commonSources.length > 0) {
    commonSources.forEach((s) => {
      const ruriRank = ruriSources.indexOf(s) + 1;
      const geminiRank = geminiSources.indexOf(s) + 1;
      console.log(`    ${s}  (ruri:#${ruriRank} → gemini:#${geminiRank})`);
    });
  }
  if (onlyRuri.length > 0) {
    console.log(`  ruriだけがヒット:   ${onlyRuri.length}件`);
    onlyRuri.forEach((s) => console.log(`    ${s}`));
  }
  if (onlyGemini.length > 0) {
    console.log(`  Geminiだけがヒット: ${onlyGemini.length}件`);
    onlyGemini.forEach((s) => console.log(`    ${s}`));
  }

  console.log("\n" + "━".repeat(60));

  // バッチモード用に結果を返す
  return {
    query,
    ruriTime,
    geminiTime,
    common: commonSources.length,
    onlyRuri: onlyRuri.length,
    onlyGemini: onlyGemini.length,
    total: topK,
  };
}

/** 複数クエリでバッチ比較（モデルロード1回で高速） */
async function compareBatch(queries: string[], topK: number) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY が設定されていません。");
    process.exit(1);
  }

  initDb();

  // ruri-v3-30mを事前ウォームアップ（初回モデルロード）
  console.log("⏳ ruri-v3-30m モデルをロード中...");
  await generateEmbedding("ウォームアップ", "RETRIEVAL_QUERY");
  console.log("✅ モデルロード完了\n");

  const results: Array<{
    query: string;
    ruriTime: number;
    geminiTime: number;
    common: number;
    onlyRuri: number;
    onlyGemini: number;
    total: number;
  }> = [];

  for (let i = 0; i < queries.length; i++) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  Q${i + 1}/${queries.length}`);
    console.log(`${"═".repeat(60)}`);
    const result = await compare(queries[i], topK);
    if (result) results.push(result);
    // Gemini APIのレート制限対策（クエリ間に3秒待機）
    if (i < queries.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  // === 総合サマリー ===
  console.log(`\n\n${"═".repeat(60)}`);
  console.log("📋 総合サマリー（全クエリ）");
  console.log(`${"═".repeat(60)}\n`);

  console.log("| # | クエリ | ruri(ms) | Gemini(ms) | 両方 | ruriのみ | Geminiのみ |");
  console.log("|---|--------|----------|------------|------|----------|------------|");
  let totalCommon = 0;
  let totalOnlyRuri = 0;
  let totalOnlyGemini = 0;

  results.forEach((r, i) => {
    const q = r.query.length > 20 ? r.query.slice(0, 20) + "…" : r.query;
    console.log(`| ${i + 1} | ${q} | ${r.ruriTime.toFixed(0)} | ${r.geminiTime.toFixed(0)} | ${r.common}/${r.total} | ${r.onlyRuri} | ${r.onlyGemini} |`);
    totalCommon += r.common;
    totalOnlyRuri += r.onlyRuri;
    totalOnlyGemini += r.onlyGemini;
  });

  const totalResults = results.reduce((sum, r) => sum + r.total, 0);
  const avgRuri = results.reduce((sum, r) => sum + r.ruriTime, 0) / results.length;
  const avgGemini = results.reduce((sum, r) => sum + r.geminiTime, 0) / results.length;

  console.log(`\n📊 統計:`);
  console.log(`  平均処理時間: ruri ${avgRuri.toFixed(0)}ms / Gemini ${avgGemini.toFixed(0)}ms`);
  console.log(`  ランキング一致率: ${totalCommon}/${totalResults} (${(totalCommon / totalResults * 100).toFixed(1)}%)`);
  console.log(`  ruriだけがヒット: ${totalOnlyRuri}件`);
  console.log(`  Geminiだけがヒット: ${totalOnlyGemini}件`);
}

// ============================================================
// Gemini Embedding インデックス構築・フル比較
// ============================================================

/** Gemini用DBパスを取得 */
function getGeminiDbPath(): string {
  const modelId = getGeminiModelId();
  const suffix = modelId.replace(/[^a-z0-9]/g, "-");
  return path.join(os.homedir(), `.local/share/rag-mcp-ruri-30m/rag-${suffix}.db`);
}

/** Gemini用DBを初期化（sqlite-vec付き） */
function initGeminiDb(): InstanceType<typeof Database> {
  const dbPath = getGeminiDbPath();
  const dbDir = path.dirname(dbPath);
  if (!require("fs").existsSync(dbDir)) {
    require("fs").mkdirSync(dbDir, { recursive: true });
  }
  const gdb = new Database(dbPath);
  sqliteVec.load(gdb);
  gdb.pragma("journal_mode = WAL");
  gdb.pragma("synchronous = NORMAL");

  gdb.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      embedding float[${GEMINI_EMBEDDING_DIMENSIONS}]
    );
  `);
  gdb.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      chunk_text TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  gdb.exec(`
    CREATE TABLE IF NOT EXISTS source_files (
      source TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      indexed_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return gdb;
}

// 共通定数（ファイル収集用）
const GEMINI_SUPPORTED_EXTS = new Set([
  // テキスト系
  ".md", ".txt", ".pdf", ".json", ".csv", ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".rb", ".sh",
  // マルチモーダル（Gemini Embedding V2対応）
  ...MEDIA_EXTENSIONS,
]);
const GEMINI_SKIP_DIRS = new Set([".git", ".obsidian", "node_modules", "Excalidraw", ".claude"]);

/** 再帰的にファイル収集 */
async function collectFilesForGemini(dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (GEMINI_SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      files.push(...await collectFilesForGemini(fullPath));
    } else if (stat.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (GEMINI_SUPPORTED_EXTS.has(ext)) files.push(fullPath);
    }
  }
  return files;
}

/** チャンクをGemini APIでバッチベクトル化してDBに保存 */
async function geminiEmbedAndStore(
  gdb: InstanceType<typeof Database>,
  allTexts: string[],
  chunkData: Array<{ text: string; source: string; chunkIndex: number }>,
  apiKey: string,
) {
  const BATCH_SIZE = 100;
  const insertChunk = gdb.prepare("INSERT INTO chunks (source, chunk_text, chunk_index) VALUES (?, ?, ?)");
  const insertVec = gdb.prepare("INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)");

  let processed = 0;
  const startTime = performance.now();

  for (let i = 0; i < allTexts.length; i += BATCH_SIZE) {
    const batchTexts = allTexts.slice(i, i + BATCH_SIZE);
    const batchChunks = chunkData.slice(i, i + BATCH_SIZE);

    try {
      const embeddings = await generateGeminiEmbeddings(batchTexts, apiKey, {
        taskType: "RETRIEVAL_DOCUMENT",
      });

      const transaction = gdb.transaction(() => {
        for (let j = 0; j < batchChunks.length; j++) {
          const result = insertChunk.run(batchChunks[j].source, batchChunks[j].text, batchChunks[j].chunkIndex);
          const rowid = BigInt(result.lastInsertRowid);
          insertVec.run(rowid, Buffer.from(new Float32Array(embeddings[j]).buffer));
        }
      });
      transaction();

      processed += batchTexts.length;
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
      const pct = ((processed / allTexts.length) * 100).toFixed(1);
      const rate = (processed / ((performance.now() - startTime) / 1000)).toFixed(1);
      console.log(`  [${pct}%] ${processed}/${allTexts.length} (${elapsed}s, ${rate}チャンク/s)`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n❌ バッチ ${i / BATCH_SIZE + 1} でエラー: ${msg}`);
      if (msg.includes("429")) {
        console.log("⏳ レート制限。60秒待機してリトライ...");
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        i -= BATCH_SIZE;
        continue;
      }
      break;
    }

    if (i + BATCH_SIZE < allTexts.length) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

/** Geminiソースを削除（チャンク + ベクトル + source_files） */
function removeGeminiSource(gdb: InstanceType<typeof Database>, source: string): number {
  const rows = gdb.prepare("SELECT id FROM chunks WHERE source = ?").all(source) as Array<{ id: number }>;
  for (const row of rows) {
    gdb.prepare("DELETE FROM vec_chunks WHERE rowid = ?").run(row.id);
  }
  gdb.prepare("DELETE FROM chunks WHERE source = ?").run(source);
  gdb.prepare("DELETE FROM source_files WHERE source = ?").run(source);
  return rows.length;
}

/** Gemini用: ディレクトリからファイル読み込み→チャンク→ベクトル化→V2 DB */
async function addDirGemini(dirPath: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY が設定されていません。");
    process.exit(1);
  }

  const resolvedDir = path.resolve(dirPath);
  console.log(`📁 ディレクトリ: ${resolvedDir}`);
  console.log("ファイル収集中...");

  const files = await collectFilesForGemini(resolvedDir);
  if (files.length === 0) {
    console.error("対応ファイルが見つかりませんでした");
    process.exit(1);
  }

  // テキストファイルとメディアファイルを分離
  const textFiles: string[] = [];
  const mediaFiles: string[] = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (isMediaFile(ext)) {
      mediaFiles.push(f);
    } else {
      textFiles.push(f);
    }
  }
  console.log(`${files.length}ファイル検出（テキスト: ${textFiles.length}, メディア: ${mediaFiles.length}）`);

  const gdb = initGeminiDb();
  const modelId = getGeminiModelId();
  console.log(`🤖 モデル: ${modelId}`);
  console.log(`📁 DB: ${getGeminiDbPath()}\n`);

  // === テキストファイル処理（既存のバッチ処理） ===
  interface FileChunks {
    source: string;
    filePath: string;
    mtimeMs: number;
    textChunks: string[];
  }
  const fileChunksList: FileChunks[] = [];
  let totalChunks = 0;
  let errorCount = 0;

  for (const filePath of textFiles) {
    try {
      const doc = await loadDocument(filePath);
      if (!doc.text || doc.text.trim().length < 50) continue;
      const resolvedFilePath = path.resolve(filePath);
      const fileStat = await fs.stat(resolvedFilePath);
      const relativePath = path.relative(resolvedDir, filePath);

      const textChunks = chunkDocument(doc.text, doc.format);
      if (textChunks.length === 0) continue;

      fileChunksList.push({
        source: relativePath,
        filePath: resolvedFilePath,
        mtimeMs: fileStat.mtimeMs,
        textChunks,
      });
      totalChunks += textChunks.length;
    } catch (error) {
      errorCount++;
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`  エラー: ${path.relative(resolvedDir, filePath)}: ${msg}`);
    }
  }

  if (fileChunksList.length > 0) {
    console.log(`テキスト: ${fileChunksList.length}ファイル, ${totalChunks}チャンク`);

    const allTexts: string[] = [];
    const allChunkData: Array<{ text: string; source: string; chunkIndex: number }> = [];

    for (const fc of fileChunksList) {
      removeGeminiSource(gdb, fc.source);
      for (let i = 0; i < fc.textChunks.length; i++) {
        allTexts.push(fc.textChunks[i]);
        allChunkData.push({ text: fc.textChunks[i], source: fc.source, chunkIndex: i });
      }
    }

    await geminiEmbedAndStore(gdb, allTexts, allChunkData, apiKey);

    // source_filesを更新
    const upsert = gdb.prepare(`
      INSERT INTO source_files (source, file_path, mtime_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET
        file_path = excluded.file_path,
        mtime_ms = excluded.mtime_ms,
        indexed_at = datetime('now')
    `);
    for (const fc of fileChunksList) {
      upsert.run(fc.source, fc.filePath, fc.mtimeMs);
    }
  }

  // === メディアファイル処理（1件ずつマルチモーダルAPI） ===
  if (mediaFiles.length > 0) {
    console.log(`\nメディアファイル処理中... (${mediaFiles.length}件)`);

    const insertChunk = gdb.prepare("INSERT INTO chunks (source, chunk_text, chunk_index) VALUES (?, ?, ?)");
    const insertVec = gdb.prepare("INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)");
    const upsertSource = gdb.prepare(`
      INSERT INTO source_files (source, file_path, mtime_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET
        file_path = excluded.file_path,
        mtime_ms = excluded.mtime_ms,
        indexed_at = datetime('now')
    `);

    let mediaIndexed = 0;
    let mediaChunkCount = 0;

    for (let i = 0; i < mediaFiles.length; i++) {
      const filePath = mediaFiles[i];
      const relativePath = path.relative(resolvedDir, filePath);

      try {
        console.error(`  [${i + 1}/${mediaFiles.length}] ${relativePath}`);

        const resolvedFilePath = path.resolve(filePath);
        const fileStat = await fs.stat(resolvedFilePath);

        // メディアをチャンク分割
        const mediaChunks = await chunkMediaFile(filePath);

        // 既存ソースがあれば削除
        removeGeminiSource(gdb, relativePath);

        // 各チャンクを1件ずつエンベディング
        for (let j = 0; j < mediaChunks.length; j++) {
          const chunk = mediaChunks[j];

          const embedding = await generateGeminiMultimodalEmbedding(
            chunk.part,
            apiKey,
            { taskType: "RETRIEVAL_DOCUMENT" },
          );

          const vecData = new Float32Array(embedding);

          // DB保存（chunk_textにはラベルを保存）
          const result = insertChunk.run(relativePath, chunk.label, j);
          const rowId = result.lastInsertRowid;
          insertVec.run(rowId, Buffer.from(vecData.buffer));
          mediaChunkCount++;
        }

        upsertSource.run(relativePath, resolvedFilePath, fileStat.mtimeMs);
        mediaIndexed++;
      } catch (error) {
        errorCount++;
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`  エラー: ${relativePath}: ${msg}`);
      }
    }

    console.log(`メディア: ${mediaIndexed}ファイル, ${mediaChunkCount}チャンク`);
  }

  const finalCount = (gdb.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number }).c;
  console.log(`\n✅ 完了: ${finalCount}チャンク（エラー: ${errorCount}件）`);
  gdb.close();
}

/** Gemini用: 差分更新（mtime比較→変更ファイルだけ再インデックス） */
async function syncGeminiUpdates() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY が設定されていません。");
    process.exit(1);
  }

  const gdb = initGeminiDb();
  const rows = gdb.prepare("SELECT source, file_path, mtime_ms FROM source_files").all() as Array<{
    source: string;
    file_path: string;
    mtime_ms: number;
  }>;

  if (rows.length === 0) {
    console.log("Gemini DBにソースが登録されていません。先に add-dir-gemini を実行してください。");
    gdb.close();
    return;
  }

  const stale: Array<{ source: string; filePath: string }> = [];
  const deleted: string[] = [];

  for (const row of rows) {
    try {
      const stat = require("fs").statSync(row.file_path);
      if (stat.mtimeMs > row.mtime_ms) {
        stale.push({ source: row.source, filePath: row.file_path });
      }
    } catch {
      deleted.push(row.source);
    }
  }

  if (stale.length === 0 && deleted.length === 0) {
    console.log("✅ すべてのインデックスは最新です。更新不要。");
    gdb.close();
    return;
  }

  console.log(`更新: ${stale.length}件, 削除: ${deleted.length}件\n`);

  // 削除されたファイルを除去
  for (const source of deleted) {
    const count = removeGeminiSource(gdb, source);
    console.log(`削除: ${source}（${count}チャンク除去）`);
  }

  // 更新されたファイルを再インデックス
  for (const { source, filePath } of stale) {
    try {
      const doc = await loadDocument(filePath);
      const stat = await fs.stat(filePath);
      removeGeminiSource(gdb, source);

      const textChunks = chunkDocument(doc.text, doc.format);
      if (textChunks.length === 0) {
        console.log(`スキップ: ${source}（テキストなし）`);
        continue;
      }

      const chunkData = textChunks.map((text, i) => ({ text, source, chunkIndex: i }));
      await geminiEmbedAndStore(gdb, textChunks, chunkData, apiKey);

      gdb.prepare(`
        INSERT INTO source_files (source, file_path, mtime_ms)
        VALUES (?, ?, ?)
        ON CONFLICT(source) DO UPDATE SET
          file_path = excluded.file_path,
          mtime_ms = excluded.mtime_ms,
          indexed_at = datetime('now')
      `).run(source, filePath, stat.mtimeMs);

      console.log(`更新: ${source}（${textChunks.length}チャンク）`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`エラー: ${source} - ${msg}`);
    }
  }

  const finalCount = (gdb.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number }).c;
  console.log(`\n同期完了: ${finalCount}チャンク`);
  gdb.close();
}

/** Gemini用: 更新チェック（レポートのみ） */
function checkGeminiUpdates() {
  const gdb = initGeminiDb();
  const rows = gdb.prepare("SELECT source, file_path, mtime_ms FROM source_files").all() as Array<{
    source: string;
    file_path: string;
    mtime_ms: number;
  }>;

  if (rows.length === 0) {
    console.log("Gemini DBにソースが登録されていません。");
    gdb.close();
    return;
  }

  let staleCount = 0;
  let deletedCount = 0;

  for (const row of rows) {
    try {
      const stat = require("fs").statSync(row.file_path);
      if (stat.mtimeMs > row.mtime_ms) {
        console.log(`  更新あり: ${row.source}`);
        staleCount++;
      }
    } catch {
      console.log(`  削除済み: ${row.source}`);
      deletedCount++;
    }
  }

  const totalSources = rows.length;
  const totalChunks = (gdb.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number }).c;
  console.log(`\nGemini DB: ${totalSources}ソース, ${totalChunks}チャンク`);
  console.log(`更新必要: ${staleCount}件, 削除必要: ${deletedCount}件`);
  if (staleCount === 0 && deletedCount === 0) console.log("✅ すべて最新です。");
  gdb.close();
}

/** Gemini DBから独立にKNN検索 */
function searchGeminiDb(queryEmbedding: number[], topK: number): Array<{ source: string; text: string; distance: number }> {
  const gdb = initGeminiDb();
  const rows = gdb
    .prepare(
      `SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
    )
    .all(Buffer.from(new Float32Array(queryEmbedding).buffer), topK) as Array<{
    rowid: number;
    distance: number;
  }>;

  const results: Array<{ source: string; text: string; distance: number }> = [];
  const getChunk = gdb.prepare("SELECT source, chunk_text FROM chunks WHERE id = ?");

  for (const row of rows) {
    const chunk = getChunk.get(row.rowid) as { source: string; chunk_text: string } | undefined;
    if (chunk) {
      results.push({ source: chunk.source, text: chunk.chunk_text, distance: row.distance });
    }
  }
  gdb.close();
  return results;
}

/** 10パターンフル比較: ruri(自前DB) vs Gemini(Gemini DB)、それぞれ独立に検索 */
async function compareFullBatch(queries: string[], topK: number) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY が設定されていません。");
    process.exit(1);
  }

  // Gemini DBの存在確認
  const geminiDbPath = getGeminiDbPath();
  if (!require("fs").existsSync(geminiDbPath)) {
    console.error(`❌ Gemini DB が見つかりません: ${geminiDbPath}`);
    console.error(`   先に build-gemini-index を実行してください。`);
    process.exit(1);
  }

  initDb();
  const modelId = getGeminiModelId();
  console.log(`📊 フル比較テスト: ruri vs ${modelId}`);
  console.log(`   ruri: 既存DB（ハイブリッド検索）`);
  console.log(`   Gemini: 専用DB（ベクトル検索）\n`);

  // ruriウォームアップ
  console.log("⏳ ruri-v3-30m モデルをロード中...");
  await generateEmbedding("ウォームアップ", "RETRIEVAL_QUERY");
  console.log("✅ モデルロード完了\n");

  const results: Array<{
    query: string;
    ruriTime: number;
    geminiTime: number;
    common: number;
    total: number;
    ruriSources: string[];
    geminiSources: string[];
  }> = [];

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  Q${i + 1}/${queries.length}: ${query}`);
    console.log(`${"═".repeat(60)}`);

    // === ruri検索（ハイブリッド） ===
    const ruriStart = performance.now();
    const queryEmbedding = await generateEmbedding(query, "RETRIEVAL_QUERY");

    // SoftMatchaも使う
    let softmatchaResults: Array<{ score: number; chunk_ids: number[] }> = [];
    if (await hasSoftMatchaIndex()) {
      try {
        const smResults = await searchSoftMatcha(query, topK * 2);
        if (smResults.length > 0) {
          softmatchaResults = smResults.map((r) => ({ score: r.score, chunk_ids: r.chunk_ids }));
        }
      } catch { /* skip */ }
    }
    const ruriResults = hybridSearch(queryEmbedding, query, topK, softmatchaResults);
    const ruriTime = performance.now() - ruriStart;

    // === Gemini検索（専用DBからKNN） ===
    const geminiStart = performance.now();
    const geminiQueryEmb = await generateGeminiEmbedding(query, apiKey, {
      taskType: "RETRIEVAL_QUERY",
    });
    const geminiResults = searchGeminiDb(geminiQueryEmb, topK);
    const geminiTime = performance.now() - geminiStart;

    // 結果表示
    const ruriSources = ruriResults.map((r) => r.chunk.source);
    const geminiSources = geminiResults.map((r) => r.source);
    const commonSources = ruriSources.filter((s) => geminiSources.includes(s));

    console.log(`\n  🏠 ruri (${ruriTime.toFixed(0)}ms):`);
    ruriResults.forEach((r, j) => {
      const mark = geminiSources.includes(r.chunk.source) ? "✅" : "  ";
      console.log(`    ${mark} [${j + 1}] ${r.chunk.source}`);
    });

    console.log(`\n  ☁️  ${modelId} (${geminiTime.toFixed(0)}ms):`);
    geminiResults.forEach((r, j) => {
      const mark = ruriSources.includes(r.source) ? "✅" : "  ";
      console.log(`    ${mark} [${j + 1}] ${r.source}`);
    });

    console.log(`\n  🔄 一致: ${commonSources.length}/${topK}`);

    results.push({
      query,
      ruriTime,
      geminiTime,
      common: commonSources.length,
      total: topK,
      ruriSources,
      geminiSources,
    });

    // Gemini APIレート制限対策
    if (i < queries.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  // === 総合サマリー ===
  console.log(`\n\n${"═".repeat(60)}`);
  console.log(`📋 フル比較サマリー: ruri vs ${modelId}`);
  console.log(`${"═".repeat(60)}\n`);

  console.log("| # | クエリ | ruri(ms) | Gemini(ms) | 一致 |");
  console.log("|---|--------|----------|------------|------|");

  let totalCommon = 0;
  results.forEach((r, i) => {
    const q = r.query.length > 25 ? r.query.slice(0, 25) + "…" : r.query;
    console.log(
      `| ${i + 1} | ${q} | ${r.ruriTime.toFixed(0)} | ${r.geminiTime.toFixed(0)} | ${r.common}/${r.total} |`,
    );
    totalCommon += r.common;
  });

  const totalResults = results.length * topK;
  const avgRuri = results.reduce((sum, r) => sum + r.ruriTime, 0) / results.length;
  const avgGemini = results.reduce((sum, r) => sum + r.geminiTime, 0) / results.length;

  console.log(`\n📊 統計:`);
  console.log(`  平均処理時間: ruri ${avgRuri.toFixed(0)}ms / Gemini ${avgGemini.toFixed(0)}ms`);
  console.log(`  ランキング一致率: ${totalCommon}/${totalResults} (${(totalCommon / totalResults * 100).toFixed(1)}%)`);
}

/** インデックス状態表示 */
function showStatus() {
  initDb();
  const s = getStatus();

  console.log("RAG インデックス状態:");
  console.log(`  ソース数: ${s.totalSources}`);
  console.log(`  チャンク数: ${s.totalChunks}`);
  console.log(
    `  DBサイズ: ${(s.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`,
  );

  if (s.sources.length > 0) {
    console.log("\n  ソース一覧:");
    s.sources.forEach((src) => {
      console.log(`    - ${src.source} (${src.chunkCount}チャンク)`);
    });
  }
}

// メインエントリー
const [, , command, ...args] = process.argv;

(async () => {
switch (command) {
  case "ask": {
    const query = args.join(" ");
    if (!query) {
      console.error("使い方: npx tsx cli/rag-cli.ts ask <質問>");
      process.exit(1);
    }
    await ask(query);
    break;
  }
  case "add": {
    const filePath = args[0];
    if (!filePath) {
      console.error("使い方: npx tsx cli/rag-cli.ts add <ファイルパス>");
      process.exit(1);
    }
    await add(filePath);
    break;
  }
  case "add-dir": {
    const dir = args[0];
    if (!dir) {
      console.error("使い方: npx tsx cli/rag-cli.ts add-dir <ディレクトリパス> [バッチサイズ]");
      process.exit(1);
    }
    const bs = args[1] ? parseInt(args[1], 10) : 50;
    await addDir(dir, bs);
    break;
  }
  case "list":
    list();
    break;
  case "remove": {
    const source = args[0];
    if (!source) {
      console.error("使い方: npx tsx cli/rag-cli.ts remove <ソース名>");
      process.exit(1);
    }
    remove(source);
    break;
  }
  case "search": {
    // --engine gemini フラグを抽出
    let searchEngine: string | undefined;
    const engineIdx = args.indexOf("--engine");
    if (engineIdx !== -1 && args[engineIdx + 1]) {
      searchEngine = args[engineIdx + 1];
      args.splice(engineIdx, 2);
    }
    const sq = args.join(" ");
    if (!sq) {
      console.error("使い方: npx tsx cli/rag-cli.ts search [--engine gemini] <クエリ> [件数]");
      process.exit(1);
    }
    const tk = args.length > 1 && !isNaN(Number(args[args.length - 1]))
      ? parseInt(args.pop()!, 10)
      : 5;
    const searchQuery = args.join(" ");
    await searchOnly(searchQuery, tk, searchEngine);
    break;
  }
  case "build-softmatcha":
    await buildSoftmatcha();
    break;
  case "check-updates":
    await checkUpdates();
    break;
  case "sync-updates":
    await syncUpdates();
    break;
  case "status":
    showStatus();
    break;
  case "compare": {
    const cq = args.join(" ");
    if (!cq) {
      console.error("使い方: npx tsx cli/rag-cli.ts compare <クエリ> [件数]");
      process.exit(1);
    }
    const ck = args.length > 1 && !isNaN(Number(args[args.length - 1]))
      ? parseInt(args.pop()!, 10)
      : 5;
    const compareQuery = args.join(" ");
    await compare(compareQuery, ck);
    break;
  }
  case "compare-batch":
  case "compare-batch-v1": {
    // v1指定時はGemini Embedding 1を使用
    if (command === "compare-batch-v1") {
      setGeminiModel("v1");
      console.log("📌 Gemini Embedding 1 (gemini-embedding-001) で比較します\n");
    }
    // 10パターンの比較クエリ（ハードコード）
    const batchQueries = [
      "記憶システムの仕組み",
      "Google Driveのファイルを検索したい",
      "Gemini APIの使い方",
      "チャンキングの方法",
      "SoftMatchaとは何か",
      "Obsidianのノートを整理する方法",
      "エンベディングモデルの比較",
      "RAGの精度を上げるには",
      "Neo4jグラフデータベースの活用",
      "PWAのオフライン対応方法",
    ];
    await compareBatch(batchQueries, 5);
    break;
  }
  case "add-dir-gemini": {
    const geminiDir = args[0];
    if (!geminiDir) {
      console.error("使い方: npx tsx cli/rag-cli.ts add-dir-gemini <ディレクトリパス>");
      process.exit(1);
    }
    await addDirGemini(geminiDir);
    break;
  }
  case "sync-gemini":
    await syncGeminiUpdates();
    break;
  case "check-gemini":
    checkGeminiUpdates();
    break;
  case "compare-full":
  case "compare-full-v1": {
    if (command === "compare-full-v1") {
      setGeminiModel("v1");
    }
    const fullQueries = [
      "記憶システムの仕組み",
      "Google Driveのファイルを検索したい",
      "Gemini APIの使い方",
      "チャンキングの方法",
      "SoftMatchaとは何か",
      "Obsidianのノートを整理する方法",
      "エンベディングモデルの比較",
      "RAGの精度を上げるには",
      "Neo4jグラフデータベースの活用",
      "PWAのオフライン対応方法",
    ];
    await compareFullBatch(fullQueries, 5);
    break;
  }
  default:
    console.log(`RAG CLI ツール（MCPを通さず直接DB操作）

使い方:
  npx tsx cli/rag-cli.ts ask <質問>                     質問してAI回答を取得
  npx tsx cli/rag-cli.ts search <クエリ> [件数]          検索のみ（AI回答なし、デフォルト5件）
  npx tsx cli/rag-cli.ts compare <クエリ> [件数]         ruri vs Gemini Embedding 比較
  npx tsx cli/rag-cli.ts compare-batch                  ruri vs Gemini Embedding 2 バッチ比較（簡易版）
  npx tsx cli/rag-cli.ts compare-batch-v1               ruri vs Gemini Embedding 1 バッチ比較（簡易版）
  npx tsx cli/rag-cli.ts add-dir-gemini <ディレクトリ>    Gemini Embedding 2 インデックス構築（ソースから）
  npx tsx cli/rag-cli.ts sync-gemini                     Gemini Embedding 2 差分更新
  npx tsx cli/rag-cli.ts check-gemini                    Gemini Embedding 2 更新チェック
  npx tsx cli/rag-cli.ts compare-full                    ruri vs Gemini Embedding 2 フル比較（独立検索）
  npx tsx cli/rag-cli.ts compare-full-v1                 ruri vs Gemini Embedding 1 フル比較（独立検索）
  npx tsx cli/rag-cli.ts add <ファイルパス>              文書を1件登録
  npx tsx cli/rag-cli.ts add-dir <ディレクトリ> [バッチサイズ]  ディレクトリ一括登録（デフォルト: バッチ50）
  npx tsx cli/rag-cli.ts build-softmatcha               SoftMatchaインデックス構築
  npx tsx cli/rag-cli.ts check-updates                  更新チェック（レポートのみ）
  npx tsx cli/rag-cli.ts sync-updates                   更新同期（変更ファイルを再インデックス）
  npx tsx cli/rag-cli.ts list                           ソース一覧を表示
  npx tsx cli/rag-cli.ts remove <ソース名>              ソースを削除
  npx tsx cli/rag-cli.ts status                         インデックス状態を表示`);
}
process.exit(0);
})();
