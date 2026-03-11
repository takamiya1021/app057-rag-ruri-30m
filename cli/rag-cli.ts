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
async function searchOnly(query: string, topK: number) {
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

switch (command) {
  case "ask": {
    const query = args.join(" ");
    if (!query) {
      console.error("使い方: npx tsx cli/rag-cli.ts ask <質問>");
      process.exit(1);
    }
    ask(query);
    break;
  }
  case "add": {
    const filePath = args[0];
    if (!filePath) {
      console.error("使い方: npx tsx cli/rag-cli.ts add <ファイルパス>");
      process.exit(1);
    }
    add(filePath);
    break;
  }
  case "add-dir": {
    const dir = args[0];
    if (!dir) {
      console.error("使い方: npx tsx cli/rag-cli.ts add-dir <ディレクトリパス> [バッチサイズ]");
      process.exit(1);
    }
    const bs = args[1] ? parseInt(args[1], 10) : 50;
    addDir(dir, bs);
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
    const sq = args.join(" ");
    if (!sq) {
      console.error("使い方: npx tsx cli/rag-cli.ts search <クエリ> [件数]");
      process.exit(1);
    }
    const tk = args.length > 1 && !isNaN(Number(args[args.length - 1]))
      ? parseInt(args.pop()!, 10)
      : 5;
    const searchQuery = args.join(" ");
    searchOnly(searchQuery, tk);
    break;
  }
  case "build-softmatcha":
    buildSoftmatcha();
    break;
  case "check-updates":
    checkUpdates();
    break;
  case "sync-updates":
    syncUpdates();
    break;
  case "status":
    showStatus();
    break;
  default:
    console.log(`RAG CLI ツール（MCPを通さず直接DB操作）

使い方:
  npx tsx cli/rag-cli.ts ask <質問>                     質問してAI回答を取得
  npx tsx cli/rag-cli.ts search <クエリ> [件数]          検索のみ（AI回答なし、デフォルト5件）
  npx tsx cli/rag-cli.ts add <ファイルパス>              文書を1件登録
  npx tsx cli/rag-cli.ts add-dir <ディレクトリ> [バッチサイズ]  ディレクトリ一括登録（デフォルト: バッチ50）
  npx tsx cli/rag-cli.ts build-softmatcha               SoftMatchaインデックス構築
  npx tsx cli/rag-cli.ts check-updates                  更新チェック（レポートのみ）
  npx tsx cli/rag-cli.ts sync-updates                   更新同期（変更ファイルを再インデックス）
  npx tsx cli/rag-cli.ts list                           ソース一覧を表示
  npx tsx cli/rag-cli.ts remove <ソース名>              ソースを削除
  npx tsx cli/rag-cli.ts status                         インデックス状態を表示`);
}
