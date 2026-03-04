// RAG検索 + Gemini回答ストリーミングAPI（AI SDK v6）
import { generateText, streamText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { cookies } from "next/headers";
import type { UIMessage } from "ai";
import { generateEmbedding } from "@/lib/rag/embedding";
import { hybridSearch, initDb, getStatus } from "@/lib/rag/vectorStore";
import { applyDbConfig } from "@/lib/next/applyDbConfig";

const SYSTEM_PROMPT = `あなたは親切なナレッジベースアシスタントです。
以下の参照情報を基に、ユーザーの質問に日本語で回答してください。
参照情報に含まれない内容は「ナレッジベースに該当する情報がありません」と正直に伝えてください。
回答は簡潔で分かりやすくしてください。
参照情報がある場合は、回答の最後に「参照ソース」として元のファイル名を箇条書きで示してください。`;

const QUERY_REWRITE_PROMPT = `ユーザーの質問を、ナレッジベース検索に最適なキーワードに変換してください。

ルール:
- ひらがなの固有名詞はカタカナに変換（例: なのばなな → ナノバナナ）
- 口語的な表現は検索向けキーワードに変換
- 検索キーワードのみを出力（説明や前置きは不要）
- 複数キーワードはスペース区切り

例:
質問: なのばななのファイルはどこにある
出力: ナノバナナ ファイル

質問: おーぷんくろーの使い方教えて
出力: OpenClaw 使い方 機能

質問: ぷれいらいとでブラウザ動かしたい
出力: Playwright ブラウザ自動化`;

/** UIMessageからテキストを抽出 */
function extractText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/** LLMでクエリを検索向けに最適化 */
async function rewriteQuery(
  google: ReturnType<typeof createGoogleGenerativeAI>,
  userQuery: string,
): Promise<string> {
  try {
    const { text } = await generateText({
      model: google("gemini-2.5-flash"),
      system: QUERY_REWRITE_PROMPT,
      prompt: userQuery,
    });
    return text.trim() || userQuery;
  } catch {
    // クエリ最適化に失敗したら元のクエリをそのまま使う
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

    // ナレッジベースにデータがあるか確認
    const status = getStatus();
    let contextText = "";

    if (status.totalChunks > 0) {
      // LLMでクエリを検索向けに最適化
      const optimizedQuery = await rewriteQuery(google, query);

      // 最適化されたクエリで検索
      const queryEmbedding = await generateEmbedding(optimizedQuery, "RETRIEVAL_QUERY");
      const searchResults = hybridSearch(queryEmbedding, optimizedQuery, 5);

      if (searchResults.length > 0) {
        contextText = searchResults
          .map((r, i) => `[${i + 1}] (${r.chunk.source})\n${r.chunk.text}`)
          .join("\n\n");
      }
    }

    const contextualPrompt = contextText
      ? `--- 参照情報 ---\n${contextText}\n--- 参照情報ここまで ---\n\n質問: ${query}`
      : `ナレッジベースに情報が登録されていません。一般的な知識で回答してください。\n\n質問: ${query}`;

    const result = streamText({
      model: google("gemini-2.5-flash"),
      system: SYSTEM_PROMPT,
      prompt: contextualPrompt,
    });

    return result.toUIMessageStreamResponse();
  } catch (err) {
    const message = err instanceof Error ? err.message : "不明なエラー";
    console.error("Chat APIエラー:", message);
    return new Response(`エラー: ${message}`, { status: 500 });
  }
}
