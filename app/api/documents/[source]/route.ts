// ソース取得・削除API
import { NextResponse } from "next/server";
import { initDb, removeSource, getChunksBySource } from "@/lib/rag/vectorStore";
import { applyDbConfig } from "@/lib/next/applyDbConfig";

/** ソースの全チャンクを取得 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ source: string }> },
) {
  try {
    const { source } = await params;
    const decodedSource = decodeURIComponent(source);

    await applyDbConfig();
    initDb();
    const chunks = getChunksBySource(decodedSource);

    if (chunks.length === 0) {
      return NextResponse.json(
        { error: "ソースが見つかりません" },
        { status: 404 },
      );
    }

    const content = chunks.map((c) => c.text).join("\n\n");
    return NextResponse.json({
      source: decodedSource,
      chunkCount: chunks.length,
      content,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "不明なエラー";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ source: string }> },
) {
  try {
    const { source } = await params;
    const decodedSource = decodeURIComponent(source);

    await applyDbConfig();
    initDb();
    const chunksRemoved = removeSource(decodedSource);

    if (chunksRemoved === 0) {
      return NextResponse.json(
        { error: "ソースが見つかりません" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      source: decodedSource,
      chunksRemoved,
      message: "ソースを削除しました",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "不明なエラー";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
