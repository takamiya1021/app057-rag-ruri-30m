// Gemini Embedding 2 (gemini-embedding-2-preview) によるエンベディング生成
// REST API直接呼び出し（追加依存なし）

// Gemini Embedding モデル定義
export const GEMINI_MODELS = {
  v1: { id: "gemini-embedding-001", dimensions: 768, apiVersion: "v1beta" },
  v2: { id: "gemini-embedding-2-preview", dimensions: 768, apiVersion: "v1beta" },
} as const;
export type GeminiModelVersion = keyof typeof GEMINI_MODELS;

let currentModel: GeminiModelVersion = "v2";
export function setGeminiModel(version: GeminiModelVersion) {
  currentModel = version;
}
export function getGeminiModelId() {
  return GEMINI_MODELS[currentModel].id;
}

function getApiBase() {
  return `https://generativelanguage.googleapis.com/${GEMINI_MODELS[currentModel].apiVersion}/models`;
}

// デフォルト次元数（MRLで縮小可能: 3072, 1536, 768）
export const GEMINI_EMBEDDING_DIMENSIONS = 768;

interface EmbedContentResponse {
  embedding: {
    values: number[];
  };
}

interface BatchEmbedContentsResponse {
  embeddings: Array<{
    values: number[];
  }>;
}

/** Gemini Embedding 2 で単一テキストのエンベディングを生成 */
export async function generateGeminiEmbedding(
  text: string,
  apiKey: string,
  options?: { dimensions?: number; taskType?: string },
): Promise<number[]> {
  const dimensions = options?.dimensions ?? GEMINI_EMBEDDING_DIMENSIONS;
  const modelId = getGeminiModelId();
  const url = `${getApiBase()}/${modelId}:embedContent?key=${apiKey}`;

  const body: Record<string, unknown> = {
    model: `models/${modelId}`,
    content: {
      parts: [{ text }],
    },
    outputDimensionality: dimensions,
  };

  if (options?.taskType) {
    body.taskType = options.taskType;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Gemini Embedding API エラー (${res.status}): ${errorText}`);
  }

  const data = (await res.json()) as EmbedContentResponse;
  return data.embedding.values;
}

/** 複数テキストのエンベディングをバッチ生成 */
export async function generateGeminiEmbeddings(
  texts: string[],
  apiKey: string,
  options?: { dimensions?: number; taskType?: string },
): Promise<number[][]> {
  const dimensions = options?.dimensions ?? GEMINI_EMBEDDING_DIMENSIONS;
  const modelId = getGeminiModelId();

  const url = `${getApiBase()}/${modelId}:batchEmbedContents?key=${apiKey}`;

  const requests = texts.map((text) => {
    const req: Record<string, unknown> = {
      model: `models/${modelId}`,
      content: {
        parts: [{ text }],
      },
      outputDimensionality: dimensions,
    };
    if (options?.taskType) {
      req.taskType = options.taskType;
    }
    return req;
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Gemini Embedding Batch API エラー (${res.status}): ${errorText}`);
  }

  const data = (await res.json()) as BatchEmbedContentsResponse;
  return data.embeddings.map((e) => e.values);
}

/** マルチモーダルコンテンツ（画像・動画・音声）のエンベディングを1件生成 */
export async function generateGeminiMultimodalEmbedding(
  part: { inlineData: { mimeType: string; data: string } },
  apiKey: string,
  options?: { dimensions?: number; taskType?: string },
): Promise<number[]> {
  const dimensions = options?.dimensions ?? GEMINI_EMBEDDING_DIMENSIONS;
  const modelId = getGeminiModelId();
  const url = `${getApiBase()}/${modelId}:embedContent?key=${apiKey}`;

  const body: Record<string, unknown> = {
    model: `models/${modelId}`,
    content: {
      parts: [part],
    },
    outputDimensionality: dimensions,
  };

  if (options?.taskType) {
    body.taskType = options.taskType;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000), // マルチモーダルは処理時間が長い
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Gemini Multimodal Embedding API エラー (${res.status}): ${errorText}`);
  }

  const data = (await res.json()) as EmbedContentResponse;
  return data.embedding.values;
}

/** コサイン類似度を計算 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
