// RAGの型定義（app056-rag-ruriから流用）

/** チャンク分割されたテキスト */
export interface Chunk {
  text: string;
  source: string;
  chunkIndex: number;
  metadata?: Record<string, string>;
}

/** DB保存済みチャンク（IDつき） */
export interface StoredChunk extends Chunk {
  id: number;
  createdAt: string;
}

/** 検索結果 */
export interface SearchResult {
  chunk: StoredChunk;
  distance: number;
}

/** ソース情報 */
export interface SourceInfo {
  source: string;
  chunkCount: number;
  createdAt: string;
}

/** インデックス状態 */
export interface IndexStatus {
  totalSources: number;
  totalChunks: number;
  dbSizeBytes: number;
  sources: SourceInfo[];
}

/** ドキュメント読み込み結果 */
export interface LoadedDocument {
  text: string;
  source: string;
  format: "txt" | "md" | "pdf" | "json" | "csv";
}

/** ruri-v3のプレフィックス方式によるタスクタイプ */
export type EmbeddingTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

/**
 * ruri-v3プレフィックスマッピング
 * RETRIEVAL_QUERY → "検索クエリ: "
 * RETRIEVAL_DOCUMENT → "検索文書: "
 */
export const RURI_PREFIX: Record<EmbeddingTaskType, string> = {
  RETRIEVAL_QUERY: "検索クエリ: ",
  RETRIEVAL_DOCUMENT: "検索文書: ",
};

/** ハイブリッド検索結果（ベクトル + BM25キーワード + SoftMatchaソフトパターンマッチ） */
export interface HybridSearchResult {
  chunk: StoredChunk;
  /** RRFスコア（高いほど関連性が高い） */
  score: number;
  /** ベクトル検索での順位（ヒットしなかった場合はnull） */
  vectorRank: number | null;
  /** BM25検索での順位（ヒットしなかった場合はnull） */
  bm25Rank: number | null;
  /** SoftMatchaソフトパターンマッチでの順位（ヒットしなかった場合はnull） */
  softmatchaRank: number | null;
}
