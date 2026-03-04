// RAG CLIツール — サーバー不要で直接RAGモジュールを使用
import { generateEmbedding, generateEmbeddings } from "../lib/rag/embedding";
import {
  initDb,
  hybridSearch,
  addChunks,
  listSources,
  removeSource,
  getStatus,
} from "../lib/rag/vectorStore";
import { loadDocument } from "../lib/rag/documentLoader";
import { splitText, splitMarkdown } from "../lib/rag/chunker";
import { streamText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

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
    doc.format === "md" ? splitMarkdown(doc.text) : splitText(doc.text);

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
  case "status":
    showStatus();
    break;
  default:
    console.log(`RAG CLI ツール

使い方:
  npx tsx cli/rag-cli.ts ask <質問>          質問してAI回答を取得
  npx tsx cli/rag-cli.ts add <ファイルパス>   文書を登録
  npx tsx cli/rag-cli.ts list                ソース一覧を表示
  npx tsx cli/rag-cli.ts remove <ソース名>   ソースを削除
  npx tsx cli/rag-cli.ts status              インデックス状態を表示`);
}
