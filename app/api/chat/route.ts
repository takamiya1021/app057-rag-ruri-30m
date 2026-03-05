// RAG検索 + Gemini回答ストリーミングAPI（AI SDK v6）
// tool use で「ファイル閲覧」と「検索」を使い分ける
import { generateText, streamText, tool, convertToModelMessages, stepCountIs } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { cookies } from "next/headers";
import type { UIMessage } from "ai";
import { z } from "zod";
import { generateEmbedding } from "@/lib/rag/embedding";
import { hybridSearch, initDb, getStatus, getChunksBySource, findSources, listSources } from "@/lib/rag/vectorStore";
import { applyDbConfig } from "@/lib/next/applyDbConfig";

const SYSTEM_PROMPT = `あなたは親切なナレッジベースアシスタントです。
ユーザーの質問に日本語で回答してください。

## ツール選択ルール（重要）
1. **まずsearchDocumentsを使う**: 質問・検索・「探して」「調べて」等 → 必ずsearchDocumentsで内容検索する。findDocumentはファイル名検索なので内容はヒットしない。
2. **viewDocument**: ユーザーが具体的なファイル名を指定して「見たい」「開いて」と言った時だけ使う。
3. **findDocument**: ファイル名の一部でファイルを探す時だけ使う（内容検索には使わない）。
4. **listDocuments**: 「何が入ってる？」「一覧見せて」等、登録済みソースの一覧を確認する時に使う。
5. **summarizeDocument**: 「要約して」「概要教えて」等、ファイルの要約を求められた時に使う。
6. **compareDocuments**: 「AとBの違いは？」「比較して」等、複数ファイルの比較を求められた時に使う。

## 注意
- searchDocumentsはクエリ最適化機能内蔵。ひらがな固有名詞も自動変換される（例: なのばなな→ナノバナナ）。ユーザーの質問をそのまま渡してOK。

回答は簡潔で分かりやすくしてください。
参照情報がある場合は、回答の最後に「参照ソース」として元のファイル名を箇条書きで示してください。`;

const QUERY_REWRITE_PROMPT = `ユーザーの質問を、ナレッジベース検索に最適なキーワードに変換してください。

ルール:
- ひらがなの固有名詞はカタカナに変換
- 英語の結合語はスペースで分割し、元の表記も併記
- 口語的な表現は正式名称や検索向けキーワードに変換
- 略語・俗称は正式名称に展開
- 日本語と英語の両方の表記を含める
- 検索キーワードのみを出力（説明や前置きは不要）
- 複数キーワードはスペース区切り

例:
入力: なのばなな関連ファイル探して → 出力: ナノバナナ nano banana 画像生成
入力: nanobanana設定 → 出力: nano banana ナノバナナ 設定
入力: おーぷんくろーの使い方 → 出力: OpenClaw 使い方 設定`;

/** UIMessageからテキストを抽出 */
function extractText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

// タイムアウト設定（ミリ秒）
const REWRITE_TIMEOUT_MS = 10_000; // クエリ最適化: 10秒
const STREAM_TIMEOUT_MS = 60_000; // 回答生成: 60秒（tool use含むため長め）

/** LLMでクエリを検索向けに最適化 */
async function rewriteQuery(
  google: ReturnType<typeof createGoogleGenerativeAI>,
  userQuery: string,
): Promise<string> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REWRITE_TIMEOUT_MS);
    const { text } = await generateText({
      model: google("gemini-2.5-flash"),
      system: QUERY_REWRITE_PROMPT,
      prompt: userQuery,
      abortSignal: controller.signal,
      providerOptions: {
        google: { thinkingConfig: { thinkingBudget: 128 } },
      },
    });
    clearTimeout(timer);
    return text.trim() || userQuery;
  } catch {
    // タイムアウトまたはエラー時は元のクエリをそのまま使う
    return userQuery;
  }
}

export async function POST(request: Request) {
  try {
    const { messages } = (await request.json()) as { messages: UIMessage[] };

    // 最後のユーザーメッセージからクエリを抽出
    const lastUserMessage = [...messages]
      .reverse()
      .find((m) => m.role === "user");
    const query = lastUserMessage ? extractText(lastUserMessage) : "";

    if (!query.trim()) {
      return new Response("質問テキストが必要です", { status: 400 });
    }

    // CookieからAPIキーを取得
    const cookieStore = await cookies();
    const apiKey = cookieStore.get("gemini_api_key")?.value;

    if (!apiKey) {
      return new Response("Gemini APIキーが設定されていません", { status: 401 });
    }

    const google = createGoogleGenerativeAI({ apiKey });

    await applyDbConfig();
    initDb();

    const streamController = new AbortController();
    const streamTimer = setTimeout(() => streamController.abort(), STREAM_TIMEOUT_MS);

    const result = streamText({
      model: google("gemini-2.5-flash"),
      system: SYSTEM_PROMPT,
      messages: await convertToModelMessages(messages),
      abortSignal: streamController.signal,
      onFinish: () => clearTimeout(streamTimer),
      stopWhen: stepCountIs(5),
      tools: {
        // ナレッジベース検索ツール
        searchDocuments: tool({
          description: "ナレッジベースの内容をセマンティック検索する。「探して」「調べて」「〜について教えて」等、情報を探す時は必ずこのツールを最初に使う。クエリ最適化内蔵のため、ひらがなの固有名詞もそのまま渡してよい。",
          inputSchema: z.object({
            query: z.string().describe("検索キーワード（日本語OK）"),
          }),
          execute: async ({ query: searchQuery }) => {
            console.log("[searchDocuments] query:", searchQuery);
            const status = getStatus();
            if (status.totalChunks === 0) {
              return { results: [], message: "ナレッジベースにデータがありません" };
            }

            // クエリ最適化
            const optimizedQuery = await rewriteQuery(google, searchQuery);
            console.log("[searchDocuments] optimized:", optimizedQuery);
            const queryEmbedding = await generateEmbedding(optimizedQuery, "RETRIEVAL_QUERY");
            const searchResults = hybridSearch(queryEmbedding, optimizedQuery, 5);

            return {
              results: searchResults.map((r, i) => ({
                rank: i + 1,
                source: r.chunk.source,
                text: r.chunk.text,
                score: r.score,
              })),
            };
          },
        }),

        // ファイル内容表示ツール
        viewDocument: tool({
          description: "指定したソース（ファイル）の全内容を取得する。「見たい」「開いて」「中身を見せて」等のリクエスト時に使う。",
          inputSchema: z.object({
            source: z.string().describe("ソース名（ファイルパス）。正確な名前が分からない場合はfindDocumentを先に使う。"),
          }),
          execute: async ({ source }) => {
            const chunks = getChunksBySource(source);
            if (chunks.length === 0) {
              // 部分一致で探してみる
              const candidates = findSources(source);
              if (candidates.length > 0) {
                return {
                  found: false,
                  message: `「${source}」は見つかりませんでした。似たソースがあります:`,
                  candidates: candidates.map((c) => c.source),
                };
              }
              return { found: false, message: `「${source}」は見つかりませんでした。` };
            }

            const fullText = chunks.map((c) => c.text).join("\n\n");
            return {
              found: true,
              source: chunks[0].source,
              chunkCount: chunks.length,
              content: fullText,
            };
          },
        }),

        // ファイル名検索ツール
        findDocument: tool({
          description: "ファイル名（ソース名）を部分一致で検索する。内容検索には使えない。viewDocumentの前にソース名を確認する時だけ使う。",
          inputSchema: z.object({
            keyword: z.string().describe("ファイル名の一部（例: app044, トレード日記）"),
          }),
          execute: async ({ keyword }) => {
            console.log("[findDocument] keyword:", keyword);
            const sources = findSources(keyword);
            if (sources.length === 0) {
              return { found: false, message: `「${keyword}」を含むソースは見つかりませんでした。` };
            }
            return {
              found: true,
              sources: sources.map((s) => ({
                source: s.source,
                chunkCount: s.chunkCount,
              })),
            };
          },
        }),

        // ソース一覧ツール
        listDocuments: tool({
          description: "ナレッジベースに登録済みの全ソース（ファイル）一覧を取得する。「何が入ってる？」「一覧見せて」「登録されてるファイルは？」等のリクエスト時に使う。",
          inputSchema: z.object({}),
          execute: async () => {
            const sources = listSources();
            if (sources.length === 0) {
              return { message: "ナレッジベースにソースが登録されていません。" };
            }
            return {
              totalSources: sources.length,
              sources: sources.map((s) => ({
                source: s.source,
                chunkCount: s.chunkCount,
                createdAt: s.createdAt,
              })),
            };
          },
        }),

        // 要約ツール
        summarizeDocument: tool({
          description: "指定したソース（ファイル）の内容を取得して要約する。「要約して」「概要教えて」「まとめて」等のリクエスト時に使う。",
          inputSchema: z.object({
            source: z.string().describe("ソース名（ファイルパス）。正確な名前が分からない場合はfindDocumentを先に使う。"),
          }),
          execute: async ({ source }) => {
            const chunks = getChunksBySource(source);
            if (chunks.length === 0) {
              const candidates = findSources(source);
              if (candidates.length > 0) {
                return {
                  found: false,
                  message: `「${source}」は見つかりませんでした。似たソースがあります:`,
                  candidates: candidates.map((c) => c.source),
                };
              }
              return { found: false, message: `「${source}」は見つかりませんでした。` };
            }

            const fullText = chunks.map((c) => c.text).join("\n\n");
            return {
              found: true,
              source: chunks[0].source,
              chunkCount: chunks.length,
              content: fullText,
              instruction: "この内容を簡潔に要約してユーザーに伝えてください。",
            };
          },
        }),

        // 比較ツール
        compareDocuments: tool({
          description: "2つのソース（ファイル）の内容を取得して比較する。「AとBの違いは？」「比較して」等のリクエスト時に使う。",
          inputSchema: z.object({
            sourceA: z.string().describe("比較するソースA（ファイルパス）"),
            sourceB: z.string().describe("比較するソースB（ファイルパス）"),
          }),
          execute: async ({ sourceA, sourceB }) => {
            const chunksA = getChunksBySource(sourceA);
            const chunksB = getChunksBySource(sourceB);

            const result: Record<string, unknown> = {};

            if (chunksA.length === 0) {
              const candidates = findSources(sourceA);
              result.sourceA = { found: false, message: `「${sourceA}」は見つかりませんでした。`, candidates: candidates.map((c) => c.source) };
            } else {
              result.sourceA = { found: true, source: sourceA, content: chunksA.map((c) => c.text).join("\n\n") };
            }

            if (chunksB.length === 0) {
              const candidates = findSources(sourceB);
              result.sourceB = { found: false, message: `「${sourceB}」は見つかりませんでした。`, candidates: candidates.map((c) => c.source) };
            } else {
              result.sourceB = { found: true, source: sourceB, content: chunksB.map((c) => c.text).join("\n\n") };
            }

            result.instruction = "2つのドキュメントの共通点と相違点を分析してユーザーに伝えてください。";
            return result;
          },
        }),
      },
    });

    return result.toUIMessageStreamResponse();
  } catch (err) {
    const message = err instanceof Error ? err.message : "不明なエラー";
    console.error("Chat APIエラー:", message);
    return new Response(`エラー: ${message}`, { status: 500 });
  }
}
