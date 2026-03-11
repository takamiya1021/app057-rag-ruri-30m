// 文書管理API — ソース一覧(GET) + 文書登録(POST)
import { NextResponse } from "next/server";
import { initDb, addChunks, listSources } from "@/lib/rag/vectorStore";
import { loadDocument } from "@/lib/rag/documentLoader";
import { chunkDocument } from "@/lib/rag/chunker";
import { generateEmbeddings } from "@/lib/rag/embedding";
import { applyDbConfig } from "@/lib/next/applyDbConfig";

/** ソース一覧取得 */
export async function GET() {
  try {
    await applyDbConfig();
    initDb();
    const sources = listSources();
    return NextResponse.json({ sources });
  } catch (err) {
    const message = err instanceof Error ? err.message : "不明なエラー";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** 文書登録 */
export async function POST(request: Request) {
  try {
    const { filePath } = await request.json();

    if (!filePath || typeof filePath !== "string") {
      return NextResponse.json(
        { error: "filePath が必要です" },
        { status: 400 },
      );
    }

    await applyDbConfig();
    initDb();

    // ファイル読み込み
    const doc = await loadDocument(filePath);

    // データ型に応じたチャンク分割
    const chunks = chunkDocument(doc.text, doc.format);

    if (chunks.length === 0) {
      return NextResponse.json(
        { error: "テキストが空です" },
        { status: 400 },
      );
    }

    // バッチ埋め込み生成
    const embeddings = await generateEmbeddings(chunks, "RETRIEVAL_DOCUMENT");

    // DB保存
    const chunkData = chunks.map((text, i) => ({
      text,
      source: doc.source,
      chunkIndex: i,
    }));
    addChunks(chunkData, embeddings);

    return NextResponse.json({
      source: doc.source,
      chunksAdded: chunks.length,
      message: "文書を登録しました",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "不明なエラー";
    const status = message.includes("Unsupported") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
