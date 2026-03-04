// API Route用: CookieからDBパス設定を適用
import { cookies } from "next/headers";
import { setCustomDbPath } from "../rag/vectorStore";

/** CookieのDBパス設定をvectorStoreに反映 */
export async function applyDbConfig(): Promise<void> {
  const cookieStore = await cookies();
  const dbPath = cookieStore.get("rag_db_path")?.value;
  setCustomDbPath(dbPath || null);
}
