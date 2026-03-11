// 検索結果を収集してtest_data.jsonを更新する
import { generateEmbedding } from "../lib/rag/embedding";
import { initDb, hybridSearch } from "../lib/rag/vectorStore";
import { searchSoftMatcha, hasSoftMatchaIndex } from "../lib/rag/softmatcha";
import { rerankWithLLM } from "../lib/rag/reranker";
import * as fs from "fs";
import * as path from "path";

const TEST_DATA_PATH = path.join(__dirname, "test_data.json");

async function main() {
  initDb();

  const testData = JSON.parse(fs.readFileSync(TEST_DATA_PATH, "utf-8"));

  console.log(`${testData.length}問の検索を実行\n`);

  for (let i = 0; i < testData.length; i++) {
    const item = testData[i];
    const query = item.question;
    console.log(`[${i + 1}/${testData.length}] ${query}`);

    // エンベディング生成
    const queryEmbedding = await generateEmbedding(query, "RETRIEVAL_QUERY");

    // SoftMatcha検索
    let softmatchaResults: Array<{ score: number; chunk_ids: number[] }> | undefined;
    if (hasSoftMatchaIndex()) {
      try {
        const smResults = await searchSoftMatcha(query, 20);
        if (smResults.length > 0) {
          softmatchaResults = smResults.map((r) => ({
            score: r.score,
            chunk_ids: r.chunk_ids,
          }));
        }
      } catch {
        // スキップ
      }
    }

    // RRF統合で広めに取得してリランカーで絞る
    const RERANK_POOL_SIZE = 20;
    const rrfResults = hybridSearch(queryEmbedding, query, RERANK_POOL_SIZE, softmatchaResults);
    const results = await rerankWithLLM(query, rrfResults, 3);

    // contextsを更新
    const newContexts = results.map((r) => r.chunk.text);
    item.contexts = newContexts;

    for (const r of results) {
      console.log(`  → ${r.chunk.source.slice(0, 60)}`);
    }
  }

  // 更新されたtest_dataを保存
  const outputPath = path.join(__dirname, "test_data_reranked.json");
  fs.writeFileSync(outputPath, JSON.stringify(testData, null, 2));
  console.log(`\n保存: ${outputPath}`);
}

main().catch(console.error);
