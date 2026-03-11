import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { promises as fs } from "fs";
import * as path from "path";
import { generateEmbedding, generateEmbeddings } from "../lib/rag/embedding";
import {
  initDb,
  addChunks,
  hybridSearch,
  listSources,
  removeSource,
  getStatus,
  upsertSourceFile,
  getStaleOrDeletedSources,
  getAllChunks,
  resetDatabase,
  getSourceFilePaths,
} from "../lib/rag/vectorStore";
import { chunkDocument, splitText } from "../lib/rag/chunker";
import { loadDocument } from "../lib/rag/documentLoader";
import {
  searchSoftMatcha,
  buildSoftMatchaIndex,
  hasSoftMatchaIndex,
  isIndexStale,
  getSoftMatchaStatus,
} from "../lib/rag/softmatcha";
import { addIndexedDir, getIndexedDirs } from "../lib/rag/config";
import { isGdriveSyncEnabled, syncChanges } from "../lib/rag/gdriveSync";
import {
  generateGeminiEmbedding,
  generateGeminiEmbeddings,
  GEMINI_EMBEDDING_DIMENSIONS,
} from "../lib/rag/geminiEmbedding";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import * as os from "os";


export function createServer(): McpServer {
  const server = new McpServer({
    name: "kuro-rag-ruri-30m",
    version: "2.0.0",
  });

  // DB初期化
  initDb();

  // --- 検索時バックグラウンド更新 ---
  // 最終チェック時刻を記録（検索のたびにチェックしないようにする）
  let lastUpdateCheckMs = 0;
  let lastGeminiUpdateCheckMs = 0;
  const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1時間
  let updateRunning = false;
  let geminiUpdateRunning = false;
  let softmatchaStaleNotified = false; // 24時間超過通知済みフラグ（1回だけ通知）

  /** 検索時にバックグラウンドで更新チェック+更新を実行（検索をブロックしない） */
  function triggerBackgroundUpdate(): void {
    const now = Date.now();
    if (updateRunning || now - lastUpdateCheckMs < UPDATE_CHECK_INTERVAL_MS) return;
    lastUpdateCheckMs = now;
    updateRunning = true;

    (async () => {
      try {
        // 1a. Google Drive差分同期（トークン設定済みの場合のみ）
        let gdriveChanged = false;
        if (isGdriveSyncEnabled()) {
          try {
            const result = await syncChanges();
            if (result.downloaded > 0 || result.deleted > 0) {
              gdriveChanged = true;
              console.error(`[auto-update] Google Drive同期完了（DL: ${result.downloaded}, インデックス: ${result.indexed}, 削除: ${result.deleted}, エラー: ${result.errors}）`);
            }
          } catch (e) {
            console.error(`[auto-update] Google Drive同期エラー: ${e}`);
          }
        }

        // 1b. ローカルファイルの差分更新
        const { stale, deleted } = getStaleOrDeletedSources();
        if (stale.length > 0 || deleted.length > 0) {
          console.error(`[auto-update] ruri+BM25差分更新開始（更新: ${stale.length}, 削除: ${deleted.length}）`);
          for (const source of deleted) {
            removeSource(source);
          }
          for (const { source, filePath } of stale) {
            try {
              const doc = await loadDocument(filePath);
              const stat = await fs.stat(filePath);
              removeSource(source);
              const textChunks = chunkDocument(doc.text, doc.format);
              if (textChunks.length === 0) continue;
              const embeddings = await generateEmbeddings(textChunks, "RETRIEVAL_DOCUMENT");
              const chunks = textChunks.map((text, i) => ({ text, source, chunkIndex: i }));
              addChunks(chunks, embeddings);
              upsertSourceFile(source, filePath, stat.mtimeMs);
            } catch (e) {
              console.error(`[auto-update] ${source}: ${e}`);
            }
          }
          console.error("[auto-update] ruri+BM25差分更新完了");
        }

        // 2. SoftMatcha 2: 再構築は検索結果で通知→手動実行（build_softmatcha_index）
        //    triggerBackgroundUpdateでは自動再構築しない
      } catch (e) {
        console.error(`[auto-update] エラー: ${e}`);
      } finally {
        updateRunning = false;
      }
    })();
  }

  /** Gemini検索時にバックグラウンドで更新チェック+更新を実行（検索をブロックしない） */
  function triggerGeminiBackgroundUpdate(): void {
    const now = Date.now();
    if (geminiUpdateRunning || now - lastGeminiUpdateCheckMs < UPDATE_CHECK_INTERVAL_MS) return;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return;
    if (!require("fs").existsSync(geminiDbPath)) return;

    lastGeminiUpdateCheckMs = now;
    geminiUpdateRunning = true;

    (async () => {
      try {
        const gdb = new Database(geminiDbPath);
        sqliteVec.load(gdb);
        const rows = gdb.prepare("SELECT source, file_path, mtime_ms FROM source_files").all() as Array<{
          source: string;
          file_path: string;
          mtime_ms: number;
        }>;

        const stale: Array<{ source: string; filePath: string }> = [];
        const deleted: string[] = [];

        for (const row of rows) {
          try {
            const stat = require("fs").statSync(row.file_path);
            if (stat.mtimeMs > row.mtime_ms) {
              stale.push({ source: row.source, filePath: row.file_path });
            }
          } catch {
            deleted.push(row.source);
          }
        }

        if (stale.length > 0 || deleted.length > 0) {
          console.error(`[auto-update] Gemini差分更新開始（更新: ${stale.length}, 削除: ${deleted.length}）`);

          // 削除
          for (const source of deleted) {
            const chunkRows = gdb.prepare("SELECT id FROM chunks WHERE source = ?").all(source) as Array<{ id: number }>;
            for (const r of chunkRows) {
              gdb.prepare("DELETE FROM vec_chunks WHERE rowid = ?").run(r.id);
            }
            gdb.prepare("DELETE FROM chunks WHERE source = ?").run(source);
            gdb.prepare("DELETE FROM source_files WHERE source = ?").run(source);
          }

          // 更新
          for (const { source, filePath } of stale) {
            try {
              const doc = await loadDocument(filePath);
              const stat = await fs.stat(filePath);

              // 古いチャンクを削除
              const oldChunks = gdb.prepare("SELECT id FROM chunks WHERE source = ?").all(source) as Array<{ id: number }>;
              for (const r of oldChunks) {
                gdb.prepare("DELETE FROM vec_chunks WHERE rowid = ?").run(r.id);
              }
              gdb.prepare("DELETE FROM chunks WHERE source = ?").run(source);
              gdb.prepare("DELETE FROM source_files WHERE source = ?").run(source);

              const textChunks = chunkDocument(doc.text, doc.format);
              if (textChunks.length === 0) continue;

              // Gemini APIでエンベディング生成（バッチ100件ずつ）
              const insertChunk = gdb.prepare("INSERT INTO chunks (source, chunk_text, chunk_index) VALUES (?, ?, ?)");
              const insertVec = gdb.prepare("INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)");
              const BATCH_SIZE = 100;

              for (let i = 0; i < textChunks.length; i += BATCH_SIZE) {
                const batchTexts = textChunks.slice(i, i + BATCH_SIZE);
                const embeddings = await generateGeminiEmbeddings(batchTexts, apiKey, {
                  taskType: "RETRIEVAL_DOCUMENT",
                });
                const transaction = gdb.transaction(() => {
                  for (let j = 0; j < batchTexts.length; j++) {
                    const result = insertChunk.run(source, batchTexts[j], i + j);
                    const rowid = BigInt(result.lastInsertRowid);
                    insertVec.run(rowid, Buffer.from(new Float32Array(embeddings[j]).buffer));
                  }
                });
                transaction();

                // レート制限対策
                if (i + BATCH_SIZE < textChunks.length) {
                  await new Promise((resolve) => setTimeout(resolve, 1_000));
                }
              }

              gdb.prepare(`
                INSERT INTO source_files (source, file_path, mtime_ms)
                VALUES (?, ?, ?)
                ON CONFLICT(source) DO UPDATE SET
                  file_path = excluded.file_path,
                  mtime_ms = excluded.mtime_ms,
                  indexed_at = datetime('now')
              `).run(source, filePath, stat.mtimeMs);
            } catch (e) {
              console.error(`[auto-update] Gemini ${source}: ${e}`);
            }
          }
          console.error("[auto-update] Gemini差分更新完了");
        }

        gdb.close();
      } catch (e) {
        console.error(`[auto-update] Geminiエラー: ${e}`);
      } finally {
        geminiUpdateRunning = false;
      }
    })();
  }

  // --- ツール登録 ---

  // 1. ファイルからドキュメントをインデックス（同期処理）
  server.tool(
    "add_document",
    "ファイルパスからドキュメントを読み込み、RAGインデックスに追加する（upsert: 同名ソースは自動差し替え）。",
    {
      filePath: z.string().describe("インデックスするファイルのパス（.txt, .md, .pdf, .json対応）"),
      metadata: z.record(z.string()).optional().describe("任意のメタデータ"),
    },
    async ({ filePath, metadata }) => {
      try {
        const doc = await loadDocument(filePath);
        const resolvedPath = path.resolve(filePath);
        const stat = await fs.stat(resolvedPath);

        const textChunks =
          chunkDocument(doc.text, doc.format);

        if (textChunks.length === 0) {
          return {
            content: [{ type: "text", text: "ドキュメントにテキストが含まれていません" }],
          };
        }

        // 既存ソースがあれば削除（upsert）
        removeSource(doc.source);

        const embeddings = await generateEmbeddings(textChunks, "RETRIEVAL_DOCUMENT");
        const chunks = textChunks.map((text, i) => ({
          text,
          source: doc.source,
          chunkIndex: i,
          metadata,
        }));
        const ids = addChunks(chunks, embeddings);
        upsertSourceFile(doc.source, resolvedPath, stat.mtimeMs);

        return {
          content: [
            {
              type: "text",
              text: `ドキュメント "${doc.source}" を追加しました（${ids.length}チャンク）`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `エラー: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // 2. テキストを直接インデックス
  server.tool(
    "add_text",
    "テキストを直接RAGインデックスに追加する",
    {
      text: z.string().describe("インデックスするテキスト"),
      source: z.string().describe("ソース識別名"),
    },
    async ({ text, source }) => {
      try {
        const textChunks = splitText(text);

        if (textChunks.length === 0) {
          return {
            content: [{ type: "text", text: "テキストが空です" }],
          };
        }

        const embeddings = await generateEmbeddings(textChunks, "RETRIEVAL_DOCUMENT");

        const chunks = textChunks.map((t, i) => ({
          text: t,
          source,
          chunkIndex: i,
        }));
        const ids = addChunks(chunks, embeddings);

        return {
          content: [
            {
              type: "text",
              text: `テキスト "${source}" を追加しました（${ids.length}チャンク）`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `エラー: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // 3. トリプルハイブリッド検索（ベクトル + BM25 + SoftMatchaソフトパターンマッチ）
  // Gemini Embedding 2 DBパス
  const geminiDbPath = path.join(os.homedir(), ".local/share/rag-mcp-ruri-30m/rag-gemini-embedding-2-preview.db");

  /** Gemini DBで検索 */
  function searchGeminiIndex(queryEmbedding: number[], topK: number): Array<{ source: string; text: string; distance: number }> {
    const gdb = new Database(geminiDbPath, { readonly: true });
    sqliteVec.load(gdb);
    const rows = gdb
      .prepare("SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT ?")
      .all(Buffer.from(new Float32Array(queryEmbedding).buffer), topK) as Array<{ rowid: number; distance: number }>;

    const results: Array<{ source: string; text: string; distance: number }> = [];
    const getChunk = gdb.prepare("SELECT source, chunk_text FROM chunks WHERE id = ?");
    for (const row of rows) {
      const chunk = getChunk.get(row.rowid) as { source: string; chunk_text: string } | undefined;
      if (chunk) {
        results.push({ source: chunk.source, text: chunk.chunk_text, distance: row.distance });
      }
    }
    gdb.close();
    return results;
  }

  server.tool(
    "search",
    "RAGインデックスを検索し、関連するチャンクを返す。engine未指定時はトリプルハイブリッド検索（ベクトル+BM25+ソフトパターンマッチ）、engine='gemini'でGemini Embedding 2による意味検索",
    {
      query: z.string().describe("検索クエリ"),
      topK: z.number().optional().default(5).describe("返す結果の最大数"),
      engine: z.enum(["ruri", "gemini"]).optional().default("ruri").describe("検索エンジン: ruri（デフォルト）またはgemini"),
    },
    async ({ query, topK, engine }) => {
      try {
        // === Gemini Embedding 2 検索 ===
        if (engine === "gemini") {
          const apiKey = process.env.GEMINI_API_KEY;
          if (!apiKey) {
            return {
              content: [{ type: "text", text: "エラー: GEMINI_API_KEY が設定されていません" }],
              isError: true,
            };
          }
          if (!require("fs").existsSync(geminiDbPath)) {
            return {
              content: [{ type: "text", text: "エラー: Gemini Embedding インデックスが未構築です。CLI で build-gemini-index を実行してください。" }],
              isError: true,
            };
          }

          // バックグラウンドで更新チェック（検索をブロックしない）
          triggerGeminiBackgroundUpdate();

          const queryEmb = await generateGeminiEmbedding(query, apiKey, {
            taskType: "RETRIEVAL_QUERY",
          });
          const geminiResults = searchGeminiIndex(queryEmb, topK);

          if (geminiResults.length === 0) {
            return {
              content: [{ type: "text", text: "該当するドキュメントが見つかりませんでした" }],
            };
          }

          // ソース名からフルパスを取得
          const uniqueSources = [...new Set(geminiResults.map((r) => r.source))];
          const sourcePathMap = getSourceFilePaths(uniqueSources);

          const formatted = geminiResults.map((r, i) => ({
            rank: i + 1,
            source: r.source,
            filePath: sourcePathMap[r.source] || null,
            distance: Math.round(r.distance * 10000) / 10000,
            engine: "gemini-embedding-2-preview",
            text: r.text,
          }));

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(formatted, null, 2),
              },
            ],
          };
        }

        // === 通常のruri検索 ===
        // バックグラウンドで更新チェック（検索をブロックしない）
        triggerBackgroundUpdate();

        // ベクトル検索用のエンベディング生成
        const queryEmbedding = await generateEmbedding(query, "RETRIEVAL_QUERY");

        // SoftMatcha 2 ソフトパターンマッチ（インデックスがあれば並行実行）
        let softmatchaResults: Array<{ score: number; chunk_ids: number[] }> | undefined;
        if (hasSoftMatchaIndex()) {
          try {
            const smResults = await searchSoftMatcha(query, topK * 2);
            if (smResults.length > 0) {
              softmatchaResults = smResults.map((r) => ({
                score: r.score,
                chunk_ids: r.chunk_ids,
              }));
            }
          } catch (e) {
            // SoftMatcha検索エラーは無視してベクトル+BM25で続行
            console.error(`[softmatcha] 検索スキップ: ${e}`);
          }
        }

        // トリプルハイブリッド検索（RRF統合）
        const rrfResults = hybridSearch(queryEmbedding, query, topK, softmatchaResults);

        if (rrfResults.length === 0) {
          return {
            content: [{ type: "text", text: "該当するドキュメントが見つかりませんでした" }],
          };
        }

        const results = rrfResults;

        // ソース名からフルパスを取得
        const uniqueSources = [...new Set(results.map((r) => r.chunk.source))];
        const sourcePathMap = getSourceFilePaths(uniqueSources);

        const formatted = results.map((r, i) => ({
          rank: i + 1,
          source: r.chunk.source,
          filePath: sourcePathMap[r.chunk.source] || null,
          score: Math.round(r.score * 10000) / 10000,
          vectorRank: r.vectorRank,
          bm25Rank: r.bm25Rank,
          softmatchaRank: r.softmatchaRank,
          text: r.chunk.text,
        }));

        // SoftMatchaインデックスが24時間以上古い場合は初回のみ通知
        let softmatchaNotice = "";
        if (isIndexStale() && !softmatchaStaleNotified) {
          softmatchaNotice = "\n\n⚠️ SoftMatchaインデックスが24時間以上古くなっています。再構築する場合は build_softmatcha_index を実行してください。";
          softmatchaStaleNotified = true;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formatted, null, 2) + softmatchaNotice,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `エラー: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // 4. ソース一覧
  server.tool(
    "list_sources",
    "インデックス済みのソース一覧を返す",
    {},
    async () => {
      try {
        const sources = listSources();

        if (sources.length === 0) {
          return {
            content: [{ type: "text", text: "インデックスにドキュメントがありません" }],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(sources, null, 2),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `エラー: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // 5. ソース削除
  server.tool(
    "remove_source",
    "特定のソースに属する全チャンクをインデックスから削除する",
    {
      source: z.string().describe("削除するソース名"),
    },
    async ({ source }) => {
      try {
        const count = removeSource(source);

        if (count === 0) {
          return {
            content: [{ type: "text", text: `ソース "${source}" は見つかりませんでした` }],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `ソース "${source}" を削除しました（${count}チャンク）`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `エラー: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // 6. ディレクトリ一括インデックス（同期処理）
  // 全ファイルのチャンクを集約してからまとめてエンベディング生成（効率重視）
  server.tool(
    "add_directory",
    "ディレクトリ内の対応ファイル(.md, .txt, .pdf, .json, .csv, コード)を再帰的にインデックスする（upsert対応）。batchSizeでエンベディング生成のバッチサイズを調整可能。",
    {
      dirPath: z.string().describe("インデックスするディレクトリのパス"),
      batchSize: z.number().optional().default(50).describe("エンベディング生成のバッチサイズ（デフォルト50。メモリに余裕があれば100〜200に増やすと高速化）"),
      skipDirs: z
        .array(z.string())
        .optional()
        .default([".git", ".obsidian", "node_modules", "Excalidraw", ".claude"])
        .describe("スキップするディレクトリ名"),
    },
    async ({ dirPath, batchSize, skipDirs }) => {
      const SUPPORTED_EXTS = new Set([".md", ".txt", ".pdf", ".json", ".csv", ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".rb", ".sh"]);

      // 再帰的にファイル収集（シンボリックリンク対応）
      async function collectFiles(dir: string): Promise<string[]> {
        const files: string[] = [];
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return files;
        }
        for (const entry of entries) {
          if (skipDirs.includes(entry.name)) continue;
          const fullPath = path.join(dir, entry.name);
          let stat;
          try {
            stat = await fs.stat(fullPath);
          } catch {
            continue;
          }
          if (stat.isDirectory()) {
            const subFiles = await collectFiles(fullPath);
            files.push(...subFiles);
          } else if (stat.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (SUPPORTED_EXTS.has(ext)) {
              files.push(fullPath);
            }
          }
        }
        return files;
      }

      try {
        const files = await collectFiles(dirPath);

        if (files.length === 0) {
          return {
            content: [{ type: "text", text: "対応ファイルが見つかりませんでした" }],
          };
        }

        // フェーズ1: 全ファイルを読み込み・チャンク分割（I/O）
        interface FileChunks {
          source: string;
          filePath: string;
          mtimeMs: number;
          textChunks: string[];
        }
        const fileChunksList: FileChunks[] = [];
        let totalChunks = 0;
        let errorCount = 0;

        for (const filePath of files) {
          try {
            const doc = await loadDocument(filePath);
            const resolvedFilePath = path.resolve(filePath);
            const fileStat = await fs.stat(resolvedFilePath);
            const relativePath = path.relative(dirPath, filePath);

            const textChunks =
              chunkDocument(doc.text, doc.format);

            if (textChunks.length === 0) continue;

            fileChunksList.push({
              source: relativePath,
              filePath: resolvedFilePath,
              mtimeMs: fileStat.mtimeMs,
              textChunks,
            });
            totalChunks += textChunks.length;
          } catch (error) {
            errorCount++;
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`[index] ${path.relative(dirPath, filePath)}: ${msg}`);
          }
        }

        if (fileChunksList.length === 0) {
          return {
            content: [{ type: "text", text: `対応ファイルにテキストが含まれていませんでした（エラー: ${errorCount}件）` }],
          };
        }

        // フェーズ2: 全チャンクをまとめてエンベディング生成（CPU集約）
        const allTexts = fileChunksList.flatMap((f) => f.textChunks);
        console.error(`[index] エンベディング生成開始（${allTexts.length}チャンク, バッチサイズ${batchSize}）`);
        const allEmbeddings = await generateEmbeddings(allTexts, "RETRIEVAL_DOCUMENT", { batchSize });

        // フェーズ3: ファイルごとにDB保存
        let embeddingOffset = 0;
        let successCount = 0;
        for (const fc of fileChunksList) {
          try {
            removeSource(fc.source);

            const embeddings = allEmbeddings.slice(embeddingOffset, embeddingOffset + fc.textChunks.length);
            embeddingOffset += fc.textChunks.length;

            const chunks = fc.textChunks.map((text, i) => ({
              text,
              source: fc.source,
              chunkIndex: i,
            }));
            addChunks(chunks, embeddings);
            upsertSourceFile(fc.source, fc.filePath, fc.mtimeMs);
            successCount++;
          } catch (error) {
            errorCount++;
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`[index] ${fc.source}: ${msg}`);
          }
        }

        // インデックス対象ディレクトリをconfigに記録
        addIndexedDir(dirPath);

        return {
          content: [{
            type: "text",
            text: `ディレクトリ "${dirPath}" のインデックス完了（成功: ${successCount}ファイル, ${totalChunks}チャンク, エラー: ${errorCount}件）`,
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `エラー: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // 7. インデックス更新チェック（起動時に呼ぶ想定）
  server.tool(
    "check_updates",
    "インデックス済みファイルの更新・削除を検出する。実際の更新はsync_updatesで行う。",
    {},
    async () => {
      try {
        const { stale, deleted } = getStaleOrDeletedSources();

        if (stale.length === 0 && deleted.length === 0) {
          return {
            content: [{ type: "text", text: "すべてのインデックスは最新です" }],
          };
        }

        const lines: string[] = [];
        if (stale.length > 0) {
          lines.push(`更新されたファイル（${stale.length}件）:`);
          for (const s of stale) {
            lines.push(`  - ${s.source}`);
          }
        }
        if (deleted.length > 0) {
          lines.push(`削除されたファイル（${deleted.length}件）:`);
          for (const d of deleted) {
            lines.push(`  - ${d}`);
          }
        }
        lines.push("");
        lines.push("sync_updates を実行するとインデックスを更新できます。");

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `エラー: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // 8. インデックス同期（更新されたファイルを再インデックス、削除されたファイルをインデックスから除去）
  server.tool(
    "sync_updates",
    "check_updatesで検出された変更をインデックスに反映する。更新ファイルは再インデックス、削除ファイルはインデックスから除去する。",
    {},
    async () => {
      try {
        const { stale, deleted } = getStaleOrDeletedSources();

        if (stale.length === 0 && deleted.length === 0) {
          return {
            content: [{ type: "text", text: "すべてのインデックスは最新です。更新不要。" }],
          };
        }

        const results: string[] = [];

        // 削除されたファイルをインデックスから除去
        for (const source of deleted) {
          const count = removeSource(source);
          results.push(`削除: ${source}（${count}チャンク除去）`);
        }

        // 更新されたファイルを再インデックス
        for (const { source, filePath } of stale) {
          try {
            const doc = await loadDocument(filePath);
            const stat = await fs.stat(filePath);

            // 古いインデックスを削除
            removeSource(source);

            const textChunks =
              chunkDocument(doc.text, doc.format);

            if (textChunks.length === 0) {
              results.push(`スキップ: ${source}（テキストなし）`);
              continue;
            }

            const embeddings = await generateEmbeddings(textChunks, "RETRIEVAL_DOCUMENT");
            const chunks = textChunks.map((text, i) => ({
              text,
              source,
              chunkIndex: i,
            }));
            const ids = addChunks(chunks, embeddings);
            upsertSourceFile(source, filePath, stat.mtimeMs);
            results.push(`更新: ${source}（${ids.length}チャンク）`);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            results.push(`エラー: ${source} - ${msg}`);
          }
        }


        return {
          content: [{ type: "text", text: results.join("\n") }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `エラー: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // 9. SoftMatchaインデックス構築/再構築
  server.tool(
    "build_softmatcha_index",
    "SoftMatcha 2のソフトパターンマッチ用インデックスを構築または再構築する。ドキュメント追加後に実行すると検索精度が向上する。",
    {},
    async () => {
      try {
        const chunks = getAllChunks();
        if (chunks.length === 0) {
          return {
            content: [{ type: "text", text: "インデックスにチャンクがありません。先にドキュメントを追加してください。" }],
          };
        }

        const result = await buildSoftMatchaIndex(chunks);
        if (result.ok) {
          softmatchaStaleNotified = false; // 通知フラグリセット
          return {
            content: [{
              type: "text",
              text: `SoftMatcha 2インデックスを構築しました（${chunks.length}チャンク, ${result.numTokens}トークン）`,
            }],
          };
        } else {
          return {
            content: [{ type: "text", text: `SoftMatcha 2インデックス構築エラー: ${result.error}` }],
            isError: true,
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `エラー: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // 10. データベースリセット（フォルダごと削除）
  server.tool(
    "reset_database",
    "RAGデータベースを完全にリセットする。データディレクトリ（DB、config、SoftMatchaインデックス）をすべて削除する。実行後はMCPサーバーの再起動が必要。",
    {
      confirm: z.literal("YES").describe("誤操作防止。リセットするには 'YES' を指定"),
    },
    async ({ confirm }) => {
      try {
        const result = resetDatabase();
        return {
          content: [{
            type: "text",
            text: `データベースをリセットしました。削除ディレクトリ: ${result.deleted}\nMCPサーバーを再起動してください。`,
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `エラー: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // --- リソース登録 ---

  // インデックス状態
  server.resource("rag-status", "rag://status", async () => {
    const status = getStatus();
    return {
      contents: [
        {
          uri: "rag://status",
          text: JSON.stringify(status, null, 2),
        },
      ],
    };
  });

  // 設定情報（インデックス対象ディレクトリ等）
  server.resource("rag-config", "rag://config", async () => {
    const indexedDirs = getIndexedDirs();
    return {
      contents: [
        {
          uri: "rag://config",
          text: JSON.stringify({ indexedDirs }, null, 2),
        },
      ],
    };
  });

  // SoftMatchaソフトパターンマッチの状態
  server.resource("softmatcha-status", "rag://softmatcha-status", async () => {
    const status = await getSoftMatchaStatus();
    return {
      contents: [
        {
          uri: "rag://softmatcha-status",
          text: JSON.stringify(status, null, 2),
        },
      ],
    };
  });

  return server;
}
