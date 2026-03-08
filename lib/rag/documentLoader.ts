// ドキュメント読み込み

import { promises as fs } from "fs";
import path from "path";
import { LoadedDocument } from "./types";

/**
 * ファイルパスからドキュメントを読み込む
 * 拡張子に応じて処理を分岐
 */
export async function loadDocument(filePath: string): Promise<LoadedDocument> {
  const ext = path.extname(filePath).toLowerCase();
  const source = path.basename(filePath);

  switch (ext) {
    case ".txt": {
      const text = await fs.readFile(filePath, "utf-8");
      return { text, source, format: "txt" };
    }
    case ".md": {
      const text = await fs.readFile(filePath, "utf-8");
      return { text, source, format: "md" };
    }
    case ".pdf": {
      // pdf-parse v1: default exportが関数
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require("pdf-parse");
      const buffer = await fs.readFile(filePath);
      const data = await pdfParse(buffer);
      return { text: data.text, source, format: "pdf" };
    }
    case ".json": {
      const raw = await fs.readFile(filePath, "utf-8");
      const obj = JSON.parse(raw);
      const text = extractJsonText(obj);
      return { text, source, format: "json" };
    }
    case ".csv": {
      const text = await fs.readFile(filePath, "utf-8");
      return { text, source, format: "csv" };
    }
    default:
      throw new Error(`Unsupported file format: ${ext}`);
  }
}

/**
 * JSON値を再帰的にテキスト化するヘルパー関数
 */
export function extractJsonText(obj: unknown): string {
  if (obj === null || obj === undefined) return "";
  if (typeof obj === "string") return obj;
  if (typeof obj === "number" || typeof obj === "boolean") return String(obj);
  if (Array.isArray(obj)) {
    return obj.map((item) => extractJsonText(item)).filter(Boolean).join("\n");
  }
  if (typeof obj === "object") {
    return Object.values(obj as Record<string, unknown>)
      .map((val) => extractJsonText(val))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
