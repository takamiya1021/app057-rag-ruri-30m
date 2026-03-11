// ローカルリランカー
// japanese-reranker-tiny-v2 で検索結果を関連度順に並び替える
// bridge.py常駐プロセス経由（モデルは初回のみロード）
// API不要、完全ローカルで動作

import { HybridSearchResult } from "./types";
import { rerankViaBridge } from "./softmatcha";

/**
 * ローカルリランク: 検索結果を質問との関連度で並び替える
 * @param query ユーザーの検索クエリ
 * @param results RRF統合後の検索結果（広めに取得したもの）
 * @param topK 最終的に返す件数
 * @returns 関連度順に並び替えられたtopK件
 */
export async function rerankWithLLM(
  query: string,
  results: HybridSearchResult[],
  topK: number,
): Promise<HybridSearchResult[]> {
  if (results.length === 0) {
    return [];
  }

  // テキストはそのまま渡す（トークナイザーが512トークンで切り詰める）
  const texts = results.map((r) => r.chunk.text);

  try {
    const scored = await rerankViaBridge(query, texts, topK);

    const valid = scored
      .filter((s) => s.index >= 0 && s.index < results.length)
      .slice(0, topK);

    return valid.map((s) => results[s.index]);
  } catch (e) {
    // リランク失敗時はRRFスコア順のまま返す（フォールバック）
    console.error(`[reranker] fallback to RRF order: ${e}`);
    return results.slice(0, topK);
  }
}
