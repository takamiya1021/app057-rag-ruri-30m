// インデックス状態取得API
import { NextResponse } from "next/server";
import { initDb, getStatus, getCurrentDbPath } from "@/lib/rag/vectorStore";
import { applyDbConfig } from "@/lib/next/applyDbConfig";

export async function GET() {
  try {
    await applyDbConfig();
    initDb();
    const status = getStatus();
    return NextResponse.json({ ...status, dbPath: getCurrentDbPath() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "不明なエラー";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
