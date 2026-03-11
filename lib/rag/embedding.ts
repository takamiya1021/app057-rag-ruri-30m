// ruri-v3-30m によるローカルEmbedding生成
// @huggingface/transformers の pipeline API を使用（バッチ処理対応）

import { EmbeddingTaskType, RURI_PREFIX } from "./types";

// ONNX変換版（コミュニティ提供、Transformers.js対応）
const MODEL_ID = "sirasagi62/ruri-v3-30m-ONNX";
export const EMBEDDING_DIMENSIONS = 256;

// デフォルトバッチサイズ（環境に応じて変更可能）
const DEFAULT_BATCH_SIZE = 50;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractor: any = null;

/** パイプラインの遅延初期化（初回のみモデルDL） */
async function getExtractor() {
  if (!extractor) {
    console.error("ruri-v3-30m を読み込み中...（初回はモデルをダウンロードします）");
    const { pipeline } = await import("@huggingface/transformers");
    extractor = await pipeline("feature-extraction", MODEL_ID, {
      dtype: "fp32",
    });
    console.error("ruri-v3-30m の読み込み完了");
  }
  return extractor;
}

/** 単一テキストのEmbedding生成 */
export async function generateEmbedding(
  text: string,
  taskType: EmbeddingTaskType,
): Promise<number[]> {
  const ext = await getExtractor();
  const prefix = RURI_PREFIX[taskType];
  const input = prefix + text;

  const output = await ext(input, {
    pooling: "mean",
    normalize: true,
  });

  const data = output.data as Float32Array;
  return Array.from(data).slice(0, EMBEDDING_DIMENSIONS);
}

/** 複数テキストのEmbedding生成（バッチ処理で高速化） */
export async function generateEmbeddings(
  texts: string[],
  taskType: EmbeddingTaskType,
  options?: { batchSize?: number },
): Promise<number[][]> {
  const ext = await getExtractor();
  const prefix = RURI_PREFIX[taskType];
  const inputs = texts.map((t) => prefix + t);
  const results: number[][] = [];
  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;

  for (let i = 0; i < inputs.length; i += batchSize) {
    const batch = inputs.slice(i, i + batchSize);
    const progress = Math.min(i + batchSize, inputs.length);
    // バッチが複数回ある場合のみ進捗表示（1回で終わる場合は無意味なので省略）
    if (inputs.length > batchSize) {
      console.error(`  エンベディング: ${progress}/${inputs.length}`);
    }
    const output = await ext(batch, {
      pooling: "mean",
      normalize: true,
    });

    // バッチ出力のTensorから各embeddingを抽出
    const data = output.data as Float32Array;
    const count = batch.length;
    for (let j = 0; j < count; j++) {
      const start = j * EMBEDDING_DIMENSIONS;
      const embedding = Array.from(data.slice(start, start + EMBEDDING_DIMENSIONS));
      results.push(embedding);
    }
  }

  return results;
}
