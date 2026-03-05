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
} from "../lib/rag/vectorStore";
import { splitText, splitMarkdown } from "../lib/rag/chunker";
import { loadDocument } from "../lib/rag/documentLoader";
import {
  searchSoftMatcha,
  buildSoftMatchaIndex,
  hasSoftMatchaIndex,
  isIndexStale,
  getSoftMatchaStatus,
} from "../lib/rag/softmatcha";
import { addIndexedDir, getIndexedDirs } from "../lib/rag/config";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "kuro-rag-ruri-30m",
    version: "2.0.0",
  });

  // DB初期化
  initDb();

  // SoftMatchaインデックスの定期チェック（起動時にバックグラウンド実行）
  // 前回構築から24時間以上経過 & チャンクが存在する場合に自動再構築
  setTimeout(async () => {
    try {
      const chunks = getAllChunks();
      if (chunks.length > 0 && isIndexStale()) {
        console.error("[softmatcha] インデックスが古いため自動再構築を開始します...");
        const result = await buildSoftMatchaIndex(chunks);
        if (result.ok) {
          console.error(`[softmatcha] 自動再構築完了（${chunks.length}チャンク, ${result.numTokens}トークン）`);
        } else {
          console.error(`[softmatcha] 自動再構築失敗: ${result.error}`);
        }
      }
    } catch (e) {
      console.error(`[softmatcha] 自動再構築エラー: ${e}`);
    }
  }, 5000); // サーバー起動から5秒後に実行（起動を妨げないように）

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
          doc.format === "md" ? splitMarkdown(doc.text) : splitText(doc.text);

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

  // 3. トリプルハイブリッド検索（ベクトル + BM25 + SoftMatcha構造検索）
  server.tool(
    "search",
    "RAGインデックスをトリプルハイブリッド検索（ベクトル + BM25 + 構造検索）し、関連するチャンクを返す",
    {
      query: z.string().describe("検索クエリ"),
      topK: z.number().optional().default(5).describe("返す結果の最大数"),
    },
    async ({ query, topK }) => {
      try {
        // ベクトル検索用のエンベディング生成
        const queryEmbedding = await generateEmbedding(query, "RETRIEVAL_QUERY");

        // SoftMatcha 2 構造検索（インデックスがあれば並行実行）
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
        const results = hybridSearch(queryEmbedding, query, topK, softmatchaResults);

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "該当するドキュメントが見つかりませんでした" }],
          };
        }

        const formatted = results.map((r, i) => ({
          rank: i + 1,
          source: r.chunk.source,
          score: Math.round(r.score * 10000) / 10000,
          vectorRank: r.vectorRank,
          bm25Rank: r.bm25Rank,
          softmatchaRank: r.softmatchaRank,
          text: r.chunk.text,
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formatted, null, 2),
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
    "ディレクトリ内の対応ファイル(.md, .txt, .pdf, .json)を再帰的にインデックスする（upsert対応）。batchSizeでエンベディング生成のバッチサイズを調整可能。",
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
      const SUPPORTED_EXTS = new Set([".md", ".txt", ".pdf", ".json"]);

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
              doc.format === "md" ? splitMarkdown(doc.text) : splitText(doc.text);

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
              doc.format === "md" ? splitMarkdown(doc.text) : splitText(doc.text);

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
    "SoftMatcha 2の構造検索インデックスを構築または再構築する。ドキュメント追加後に実行すると検索精度が向上する。",
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

  // SoftMatcha構造検索の状態
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
