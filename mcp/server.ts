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
} from "../lib/rag/vectorStore";
import { splitText, splitMarkdown } from "../lib/rag/chunker";
import { loadDocument } from "../lib/rag/documentLoader";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "kuro-rag-ruri-30m",
    version: "2.0.0",
  });

  // DB初期化
  initDb();

  // --- ツール登録 ---

  // 1. ファイルからドキュメントをインデックス
  server.tool(
    "add_document",
    "ファイルパスからドキュメントを読み込み、RAGインデックスに追加する",
    {
      filePath: z.string().describe("インデックスするファイルのパス（.txt, .md, .pdf, .json対応）"),
      metadata: z.record(z.string()).optional().describe("任意のメタデータ"),
    },
    async ({ filePath, metadata }) => {
      try {
        const doc = await loadDocument(filePath);

        // 形式に応じたチャンク分割
        const textChunks =
          doc.format === "md" ? splitMarkdown(doc.text) : splitText(doc.text);

        if (textChunks.length === 0) {
          return {
            content: [{ type: "text", text: "ドキュメントにテキストが含まれていません" }],
          };
        }

        // Embedding生成
        const embeddings = await generateEmbeddings(textChunks, "RETRIEVAL_DOCUMENT");

        // DB保存
        const chunks = textChunks.map((text, i) => ({
          text,
          source: doc.source,
          chunkIndex: i,
          metadata,
        }));
        const ids = addChunks(chunks, embeddings);

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

  // 3. セマンティック検索
  server.tool(
    "search",
    "RAGインデックスをセマンティック検索し、関連するチャンクを返す",
    {
      query: z.string().describe("検索クエリ"),
      topK: z.number().optional().default(5).describe("返す結果の最大数"),
    },
    async ({ query, topK }) => {
      try {
        const queryEmbedding = await generateEmbedding(query, "RETRIEVAL_QUERY");
        const results = hybridSearch(queryEmbedding, query, topK);

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

  // 6. ディレクトリ一括インデックス
  server.tool(
    "add_directory",
    "ディレクトリ内の対応ファイル(.md, .txt, .pdf, .json)を再帰的にインデックスする",
    {
      dirPath: z.string().describe("インデックスするディレクトリのパス"),
      skipDirs: z
        .array(z.string())
        .optional()
        .default([".git", ".obsidian", "node_modules", "Excalidraw", ".claude"])
        .describe("スキップするディレクトリ名"),
    },
    async ({ dirPath, skipDirs }) => {
      const SUPPORTED_EXTS = new Set([".md", ".txt", ".pdf", ".json"]);
      const results: { file: string; chunks: number; error?: string }[] = [];

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
          // シンボリックリンクの実体を確認
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

        // 1ファイルずつ順次処理
        for (const filePath of files) {
          try {
            const doc = await loadDocument(filePath);
            const textChunks =
              doc.format === "md" ? splitMarkdown(doc.text) : splitText(doc.text);

            if (textChunks.length === 0) {
              results.push({ file: filePath, chunks: 0 });
              continue;
            }

            const embeddings = await generateEmbeddings(textChunks, "RETRIEVAL_DOCUMENT");
            // ソース名をディレクトリからの相対パスにする
            const relativePath = path.relative(dirPath, filePath);
            const chunks = textChunks.map((text, i) => ({
              text,
              source: relativePath,
              chunkIndex: i,
            }));
            const ids = addChunks(chunks, embeddings);
            results.push({ file: relativePath, chunks: ids.length });
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            results.push({ file: path.relative(dirPath, filePath), chunks: 0, error: msg });
          }
        }

        const success = results.filter((r) => r.chunks > 0);
        const failed = results.filter((r) => r.error);
        const empty = results.filter((r) => r.chunks === 0 && !r.error);
        const totalChunks = success.reduce((sum, r) => sum + r.chunks, 0);

        const summary = [
          `完了: ${files.length}ファイル処理`,
          `成功: ${success.length}ファイル（${totalChunks}チャンク）`,
          empty.length > 0 ? `空ファイル: ${empty.length}` : null,
          failed.length > 0 ? `エラー: ${failed.length}` : null,
        ]
          .filter(Boolean)
          .join("\n");

        const detail =
          failed.length > 0
            ? "\n\nエラー詳細:\n" + failed.map((r) => `- ${r.file}: ${r.error}`).join("\n")
            : "";

        return {
          content: [{ type: "text", text: summary + detail }],
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

  return server;
}
