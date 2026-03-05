// SQLite + sqlite-vec ベクトルストア

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { StoredChunk, SearchResult, HybridSearchResult, SourceInfo, IndexStatus } from "./types";
import { EMBEDDING_DIMENSIONS } from "./embedding";

const DEFAULT_DB_PATH = path.join(os.homedir(), ".local/share/rag-mcp-ruri-30m/rag.db");

let db: Database.Database | null = null;
let customDbPath: string | null = null;

/** カスタムDBパスを設定（パス変更時は接続をリセット） */
export function setCustomDbPath(newPath: string | null): void {
  const resolved = newPath?.trim() || null;
  if (resolved === customDbPath) return;
  if (db) {
    db.close();
    db = null;
  }
  customDbPath = resolved;
}

/** DBパスを取得 */
function getDbPath(): string {
  return customDbPath || process.env.RAG_DB_PATH || DEFAULT_DB_PATH;
}

/** 現在のDBパスを取得（外部公開用） */
export function getCurrentDbPath(): string {
  return getDbPath();
}

/** DB初期化・テーブル作成 */
export function initDb(): Database.Database {
  if (db) return db;

  const dbPath = getDbPath();
  const dbDir = path.dirname(dbPath);

  // ディレクトリがなければ再帰的に作成
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(dbPath);

  // sqlite-vec 拡張を読み込み
  sqliteVec.load(db);

  // WALモードで書き込み性能を向上
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  // テーブル作成
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      embedding float[${EMBEDDING_DIMENSIONS}]
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      chunk_text TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // FTS5 全文検索テーブル（chunksテーブルと連動）
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
      chunk_text,
      content='chunks',
      content_rowid='id',
      tokenize='unicode61'
    );
  `);

  // ソースファイル管理テーブル（起動時チェック用）
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_files (
      source TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      indexed_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // 既存チャンクがFTS5に未登録の場合、バックフィル
  // ※ content-sync FTS5ではCOUNT(*)がcontentテーブルの行数を返すため、
  //    実際のインデックス状態はfts_chunks_dataの行数で判定する
  //    （空のFTS5は内部メタデータのみで数行、インデックス構築後は多数になる）
  const ftsDataCount = db.prepare(
    `SELECT COUNT(*) as count FROM fts_chunks_data`,
  ).get() as { count: number };
  const chunksCount = db.prepare(
    `SELECT COUNT(*) as count FROM chunks`,
  ).get() as { count: number };

  if (chunksCount.count > 0 && ftsDataCount.count < 10) {
    db.prepare(
      `INSERT INTO fts_chunks(fts_chunks) VALUES(?)`,
    ).run("rebuild");
  }

  return db;
}

/** DBインスタンスを取得（未初期化ならinitDb） */
function getDb(): Database.Database {
  if (!db) return initDb();
  return db;
}

/** チャンクとembeddingをDBに追加 */
export function addChunks(
  chunks: Array<{
    text: string;
    source: string;
    chunkIndex: number;
    metadata?: Record<string, string>;
  }>,
  embeddings: number[][],
): number[] {
  const database = getDb();
  const ids: number[] = [];

  const insertChunk = database.prepare(`
    INSERT INTO chunks (source, chunk_text, chunk_index, metadata)
    VALUES (?, ?, ?, ?)
  `);
  const insertVec = database.prepare(`
    INSERT INTO vec_chunks (rowid, embedding)
    VALUES (?, ?)
  `);
  const insertFts = database.prepare(`
    INSERT INTO fts_chunks (rowid, chunk_text)
    VALUES (?, ?)
  `);

  const transaction = database.transaction(() => {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i];
      const metadataJson = chunk.metadata ? JSON.stringify(chunk.metadata) : null;

      const result = insertChunk.run(
        chunk.source,
        chunk.text,
        chunk.chunkIndex,
        metadataJson,
      );
      const rowid = BigInt(result.lastInsertRowid);

      insertVec.run(rowid, Buffer.from(new Float32Array(embedding).buffer));
      insertFts.run(rowid, chunk.text);
      ids.push(Number(rowid));
    }
  });

  transaction();
  return ids;
}

/** KNN検索 */
export function search(
  queryEmbedding: number[],
  topK: number,
): SearchResult[] {
  const database = getDb();

  const rows = database
    .prepare(
      `
      SELECT rowid, distance
      FROM vec_chunks
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `,
    )
    .all(Buffer.from(new Float32Array(queryEmbedding).buffer), topK) as Array<{
    rowid: number;
    distance: number;
  }>;

  if (rows.length === 0) return [];

  const results: SearchResult[] = [];
  const getChunk = database.prepare(`
    SELECT id, source, chunk_text, chunk_index, metadata, created_at
    FROM chunks WHERE id = ?
  `);

  for (const row of rows) {
    const chunkRow = getChunk.get(row.rowid) as {
      id: number;
      source: string;
      chunk_text: string;
      chunk_index: number;
      metadata: string | null;
      created_at: string;
    } | undefined;

    if (chunkRow) {
      results.push({
        chunk: {
          id: chunkRow.id,
          text: chunkRow.chunk_text,
          source: chunkRow.source,
          chunkIndex: chunkRow.chunk_index,
          metadata: chunkRow.metadata ? JSON.parse(chunkRow.metadata) : undefined,
          createdAt: chunkRow.created_at,
        },
        distance: row.distance,
      });
    }
  }

  return results;
}

/** BM25キーワード検索（内部用） */
function ftsSearch(
  query: string,
  topK: number,
): Array<{ id: number; chunk: StoredChunk; bm25Score: number }> {
  const database = getDb();

  const rows = database
    .prepare(
      `
      SELECT
        c.id,
        c.source,
        c.chunk_text,
        c.chunk_index,
        c.metadata,
        c.created_at,
        bm25(fts_chunks) as bm25_score
      FROM fts_chunks
      JOIN chunks c ON c.id = fts_chunks.rowid
      WHERE fts_chunks MATCH ?
      ORDER BY bm25(fts_chunks)
      LIMIT ?
    `,
    )
    .all(query, topK) as Array<{
    id: number;
    source: string;
    chunk_text: string;
    chunk_index: number;
    metadata: string | null;
    created_at: string;
    bm25_score: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    chunk: {
      id: row.id,
      text: row.chunk_text,
      source: row.source,
      chunkIndex: row.chunk_index,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.created_at,
    },
    bm25Score: row.bm25_score,
  }));
}

/** ハイブリッド検索（ベクトル + BM25キーワード検索をRRFで統合） */
export function hybridSearch(
  queryEmbedding: number[],
  queryText: string,
  topK: number,
): HybridSearchResult[] {
  // 各検索でtopK*2件取得して統合後にtopK件に絞る
  const expandedK = topK * 2;

  // 1. ベクトル検索
  const vectorResults = search(queryEmbedding, expandedK);

  // 2. BM25キーワード検索
  let ftsResults: Array<{ id: number; chunk: StoredChunk; bm25Score: number }> = [];
  try {
    ftsResults = ftsSearch(queryText, expandedK);
  } catch {
    // FTS5検索エラー（不正なクエリ等）はスキップしてベクトルのみで続行
  }

  // 3. RRF（Reciprocal Rank Fusion）でスコア統合
  const RRF_K = 60;
  const scoreMap = new Map<
    number,
    {
      chunk: StoredChunk;
      score: number;
      vectorRank: number | null;
      bm25Rank: number | null;
    }
  >();

  // ベクトル検索結果のRRFスコア加算
  vectorResults.forEach((result, index) => {
    const rank = index + 1;
    const rrfScore = 1 / (RRF_K + rank);
    scoreMap.set(result.chunk.id, {
      chunk: result.chunk,
      score: rrfScore,
      vectorRank: rank,
      bm25Rank: null,
    });
  });

  // BM25検索結果のRRFスコア加算
  ftsResults.forEach((result, index) => {
    const rank = index + 1;
    const rrfScore = 1 / (RRF_K + rank);
    const existing = scoreMap.get(result.id);

    if (existing) {
      // 両方にヒット → スコアを合算
      existing.score += rrfScore;
      existing.bm25Rank = rank;
    } else {
      scoreMap.set(result.id, {
        chunk: result.chunk,
        score: rrfScore,
        vectorRank: null,
        bm25Rank: rank,
      });
    }
  });

  // 4. スコア降順でソートし、topK件に絞る
  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/** ソース一覧を取得 */
export function listSources(): SourceInfo[] {
  const database = getDb();
  const rows = database
    .prepare(
      `
      SELECT source, COUNT(*) as chunk_count, MIN(created_at) as created_at
      FROM chunks
      GROUP BY source
      ORDER BY created_at DESC
    `,
    )
    .all() as Array<{
    source: string;
    chunk_count: number;
    created_at: string;
  }>;

  return rows.map((row) => ({
    source: row.source,
    chunkCount: row.chunk_count,
    createdAt: row.created_at,
  }));
}

/** ソースの全チャンクをテキスト順に取得 */
export function getChunksBySource(source: string): StoredChunk[] {
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT id, source, chunk_text, chunk_index, metadata, created_at
       FROM chunks WHERE source = ?
       ORDER BY chunk_index ASC`,
    )
    .all(source) as Array<{
    id: number;
    source: string;
    chunk_text: string;
    chunk_index: number;
    metadata: string | null;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    text: row.chunk_text,
    source: row.source,
    chunkIndex: row.chunk_index,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: row.created_at,
  }));
}

/** ソース名を部分一致で検索 */
export function findSources(keyword: string): SourceInfo[] {
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT source, COUNT(*) as chunk_count, MIN(created_at) as created_at
       FROM chunks WHERE source LIKE ?
       GROUP BY source
       ORDER BY source ASC`,
    )
    .all(`%${keyword}%`) as Array<{
    source: string;
    chunk_count: number;
    created_at: string;
  }>;

  return rows.map((row) => ({
    source: row.source,
    chunkCount: row.chunk_count,
    createdAt: row.created_at,
  }));
}

/** ソースの全チャンクを削除 */
export function removeSource(source: string): number {
  const database = getDb();

  // 対象チャンクのIDとテキストを取得（FTS5削除に必要）
  const rows = database
    .prepare(`SELECT id, chunk_text FROM chunks WHERE source = ?`)
    .all(source) as Array<{ id: number; chunk_text: string }>;

  if (rows.length === 0) return 0;

  const deleteFts = database.prepare(
    `INSERT INTO fts_chunks(fts_chunks, rowid, chunk_text) VALUES('delete', ?, ?)`,
  );

  const transaction = database.transaction(() => {
    for (const row of rows) {
      database.prepare(`DELETE FROM vec_chunks WHERE rowid = ?`).run(row.id);
      deleteFts.run(row.id, row.chunk_text);
    }
    database.prepare(`DELETE FROM chunks WHERE source = ?`).run(source);
    database.prepare(`DELETE FROM source_files WHERE source = ?`).run(source);
  });

  transaction();
  return rows.length;
}

/** インデックス状態を取得 */
export function getStatus(): IndexStatus {
  const database = getDb();
  const dbPath = getDbPath();

  const countRow = database
    .prepare(`SELECT COUNT(*) as count FROM chunks`)
    .get() as { count: number };

  const sources = listSources();

  let dbSizeBytes = 0;
  try {
    const stat = fs.statSync(dbPath);
    dbSizeBytes = stat.size;
  } catch {
    // DBファイルが存在しない場合は0
  }

  return {
    totalSources: sources.length,
    totalChunks: countRow.count,
    dbSizeBytes,
    sources,
  };
}

/** ソースのファイル情報を記録（起動時チェック用） */
export function upsertSourceFile(source: string, filePath: string, mtimeMs: number): void {
  const database = getDb();
  database.prepare(`
    INSERT INTO source_files (source, file_path, mtime_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET
      file_path = excluded.file_path,
      mtime_ms = excluded.mtime_ms,
      indexed_at = datetime('now')
  `).run(source, filePath, mtimeMs);
}

/** ソースのファイル情報を削除 */
export function removeSourceFile(source: string): void {
  const database = getDb();
  database.prepare(`DELETE FROM source_files WHERE source = ?`).run(source);
}

/** 更新が必要なソース一覧を取得（ファイルのmtimeがDB記録より新しい、またはファイルが消えた） */
export function getStaleOrDeletedSources(): { stale: Array<{ source: string; filePath: string }>; deleted: string[] } {
  const database = getDb();
  const rows = database.prepare(`SELECT source, file_path, mtime_ms FROM source_files`).all() as Array<{
    source: string;
    file_path: string;
    mtime_ms: number;
  }>;

  const stale: Array<{ source: string; filePath: string }> = [];
  const deleted: string[] = [];

  for (const row of rows) {
    try {
      const stat = fs.statSync(row.file_path);
      if (stat.mtimeMs > row.mtime_ms) {
        stale.push({ source: row.source, filePath: row.file_path });
      }
    } catch {
      // ファイルが存在しない
      deleted.push(row.source);
    }
  }

  return { stale, deleted };
}

/** DB接続をクローズ */
export function close(): void {
  if (db) {
    db.close();
    db = null;
  }
}
