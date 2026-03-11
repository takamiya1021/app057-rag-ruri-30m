/**
 * 決定論的IR指標の評価スクリプト
 *
 * LLM審判を使わず、検索結果のソースパスと正解ソースの一致で評価する。
 * 再現性100%（同じDBなら毎回同じ結果）。
 *
 * 使い方:
 *   npx tsx eval/run_ir_metrics.ts
 */

import { generateEmbedding } from "../lib/rag/embedding";
import { initDb, hybridSearch } from "../lib/rag/vectorStore";
import { searchSoftMatcha, hasSoftMatchaIndex } from "../lib/rag/softmatcha";
import { rerankWithLLM } from "../lib/rag/reranker";
import { HybridSearchResult } from "../lib/rag/types";
import * as fs from "fs";
import * as path from "path";

const TEST_DATA_PATH = path.join(__dirname, "test_data.json");
const OUTPUT_PATH = path.join(__dirname, "ir_metrics_result.json");

// 評価対象のK値
const K_VALUES = [1, 3, 5];

/** テストデータの型 */
interface TestItem {
  question: string;
  contexts: string[];
  reference: string;
  relevant_sources: string[];
}

/** 検索結果が正解ソースに含まれるかチェック */
function isRelevant(result: HybridSearchResult, relevantSources: string[]): boolean {
  return relevantSources.some((src) => result.chunk.source === src);
}

/** Hit Rate@K: Top-Kに正解が1つでもあるか（0 or 1） */
function hitRateAtK(results: HybridSearchResult[], relevantSources: string[], k: number): number {
  const topK = results.slice(0, k);
  return topK.some((r) => isRelevant(r, relevantSources)) ? 1 : 0;
}

/** MRR@K: 最初の正解の順位の逆数 */
function mrrAtK(results: HybridSearchResult[], relevantSources: string[], k: number): number {
  const topK = results.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    if (isRelevant(topK[i], relevantSources)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/** Precision@K: Top-Kのうち正解の割合 */
function precisionAtK(results: HybridSearchResult[], relevantSources: string[], k: number): number {
  const topK = results.slice(0, k);
  const hits = topK.filter((r) => isRelevant(r, relevantSources)).length;
  return hits / k;
}

/** Recall@K: 全正解のうちTop-Kで拾えた割合 */
function recallAtK(results: HybridSearchResult[], relevantSources: string[], k: number): number {
  if (relevantSources.length === 0) return 0;
  const topK = results.slice(0, k);
  // 正解ソースのうち、Top-K内に1つでもチャンクがあるソースの割合
  const foundSources = new Set<string>();
  for (const r of topK) {
    for (const src of relevantSources) {
      if (r.chunk.source === src) {
        foundSources.add(src);
      }
    }
  }
  return foundSources.size / relevantSources.length;
}

/** 指標をまとめて計算 */
function computeMetrics(
  results: HybridSearchResult[],
  relevantSources: string[],
): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const k of K_VALUES) {
    metrics[`hit_rate@${k}`] = hitRateAtK(results, relevantSources, k);
    metrics[`mrr@${k}`] = mrrAtK(results, relevantSources, k);
    metrics[`precision@${k}`] = precisionAtK(results, relevantSources, k);
    metrics[`recall@${k}`] = recallAtK(results, relevantSources, k);
  }
  return metrics;
}

/** 指標の平均を計算 */
function averageMetrics(allMetrics: Record<string, number>[]): Record<string, number> {
  if (allMetrics.length === 0) return {};
  const keys = Object.keys(allMetrics[0]);
  const avg: Record<string, number> = {};
  for (const key of keys) {
    const sum = allMetrics.reduce((acc, m) => acc + m[key], 0);
    avg[key] = sum / allMetrics.length;
  }
  return avg;
}

/** 数値を小数点3桁でフォーマット */
function fmt(n: number): string {
  return n.toFixed(3);
}

/** バーグラフ表示 */
function bar(n: number, width: number = 20): string {
  const filled = Math.round(n * width);
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
}

async function main() {
  console.log("=== 決定論的IR指標評価 ===\n");

  // DB初期化
  initDb();

  // テストデータ読み込み
  const testData: TestItem[] = JSON.parse(fs.readFileSync(TEST_DATA_PATH, "utf-8"));
  console.log(`テストデータ: ${testData.length}問`);

  // relevant_sourcesがあるか確認
  const hasRelevantSources = testData.every((item) => item.relevant_sources && item.relevant_sources.length > 0);
  if (!hasRelevantSources) {
    console.error("エラー: test_data.jsonにrelevant_sourcesフィールドがないよ");
    process.exit(1);
  }

  // SoftMatchaインデックスの確認
  const hasSM = hasSoftMatchaIndex();
  console.log(`SoftMatcha: ${hasSM ? "あり" : "なし"}`);
  console.log();

  // 各質問を検索して指標を計算
  const POOL_SIZE = 20; // リランカーに渡すプールサイズ
  const rrfAllMetrics: Record<string, number>[] = [];
  const rerankAllMetrics: Record<string, number>[] = [];

  // 質問ごとの詳細結果
  const perQuestion: Array<{
    question: string;
    relevant_sources: string[];
    rrf_sources: string[];
    rerank_sources: string[];
    rrf_metrics: Record<string, number>;
    rerank_metrics: Record<string, number>;
  }> = [];

  for (let i = 0; i < testData.length; i++) {
    const item = testData[i];
    console.log(`[${i + 1}/${testData.length}] ${item.question}`);

    // エンベディング生成
    const queryEmbedding = await generateEmbedding(item.question, "RETRIEVAL_QUERY");

    // SoftMatcha検索（存在する場合）
    let softmatchaResults: Array<{ score: number; chunk_ids: number[] }> | undefined;
    if (hasSM) {
      try {
        const smResults = await searchSoftMatcha(item.question, POOL_SIZE);
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

    // --- RRFのみ（リランクなし） ---
    const rrfResults = hybridSearch(queryEmbedding, item.question, POOL_SIZE, softmatchaResults);
    const rrfMetrics = computeMetrics(rrfResults, item.relevant_sources);
    rrfAllMetrics.push(rrfMetrics);

    // --- RRF + リランカー ---
    const rerankedResults = await rerankWithLLM(item.question, rrfResults, Math.max(...K_VALUES));
    const rerankMetrics = computeMetrics(rerankedResults, item.relevant_sources);
    rerankAllMetrics.push(rerankMetrics);

    // 結果表示（ソース上位5件）
    const rrfTop = rrfResults.slice(0, 5).map((r) => r.chunk.source);
    const rerankTop = rerankedResults.slice(0, 5).map((r) => r.chunk.source);
    console.log(`  RRF    : hit@3=${fmt(rrfMetrics["hit_rate@3"])} recall@3=${fmt(rrfMetrics["recall@3"])}`);
    console.log(`  Rerank : hit@3=${fmt(rerankMetrics["hit_rate@3"])} recall@3=${fmt(rerankMetrics["recall@3"])}`);

    perQuestion.push({
      question: item.question,
      relevant_sources: item.relevant_sources,
      rrf_sources: rrfTop,
      rerank_sources: rerankTop,
      rrf_metrics: rrfMetrics,
      rerank_metrics: rerankMetrics,
    });
  }

  // 平均指標の計算
  const rrfAvg = averageMetrics(rrfAllMetrics);
  const rerankAvg = averageMetrics(rerankAllMetrics);

  // === 比較表の出力 ===
  console.log("\n" + "=".repeat(70));
  console.log("  IR指標比較: RRFのみ vs RRF+リランカー");
  console.log("=".repeat(70));

  // ヘッダー
  const metricKeys = Object.keys(rrfAvg);
  console.log(`\n${"指標".padEnd(18)}${"RRFのみ".padEnd(12)}${"RRF+Rerank".padEnd(12)}差分`);
  console.log("-".repeat(55));

  for (const key of metricKeys) {
    const rrfVal = rrfAvg[key];
    const rerankVal = rerankAvg[key];
    const diff = rerankVal - rrfVal;
    const diffStr = diff >= 0 ? `+${fmt(diff)}` : fmt(diff);
    const indicator = diff > 0.01 ? " (+)" : diff < -0.01 ? " (-)" : "    ";
    console.log(
      `${key.padEnd(18)}${fmt(rrfVal).padEnd(12)}${fmt(rerankVal).padEnd(12)}${diffStr}${indicator}`,
    );
  }

  // 主要指標のバーグラフ表示
  console.log("\n--- 主要指標（バーグラフ） ---\n");
  const keyMetrics = ["hit_rate@3", "mrr@3", "precision@3", "recall@3", "recall@5"];
  for (const key of keyMetrics) {
    if (rrfAvg[key] !== undefined) {
      console.log(`  ${key.padEnd(16)} RRF:    ${bar(rrfAvg[key])} ${fmt(rrfAvg[key])}`);
      console.log(`  ${"".padEnd(16)} Rerank: ${bar(rerankAvg[key])} ${fmt(rerankAvg[key])}`);
      console.log();
    }
  }

  // 質問ごとの詳細
  console.log("\n--- 質問別 Hit Rate@3 ---\n");
  for (const pq of perQuestion) {
    const rrfHit = pq.rrf_metrics["hit_rate@3"];
    const rerankHit = pq.rerank_metrics["hit_rate@3"];
    const mark = (v: number) => (v === 1 ? "o" : "x");
    console.log(`  [RRF:${mark(rrfHit)} Rerank:${mark(rerankHit)}] ${pq.question}`);
  }

  // JSON保存
  const output = {
    timestamp: new Date().toISOString(),
    num_questions: testData.length,
    softmatcha_available: hasSM,
    pool_size: POOL_SIZE,
    k_values: K_VALUES,
    rrf_average: rrfAvg,
    rerank_average: rerankAvg,
    per_question: perQuestion,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\n結果を保存: ${OUTPUT_PATH}`);
}

main().catch(console.error);
