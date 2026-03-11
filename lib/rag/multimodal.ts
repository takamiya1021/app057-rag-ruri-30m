// マルチモーダルファイル（画像・動画・音声）のチャンキング支援
// Gemini Embedding V2のマルチモーダル対応用

import { execSync } from "node:child_process";
import { promises as fs } from "fs";
import * as path from "path";

// メディアファイルの拡張子→MIMEタイプマッピング（Gemini Embedding 2 対応形式）
export const MEDIA_MIME_MAP: Record<string, string> = {
  // 画像
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  // 動画
  ".mp4": "video/mp4",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".mov": "video/mov",
  ".avi": "video/avi",
  ".flv": "video/x-flv",
  ".webm": "video/webm",
  ".wmv": "video/wmv",
  ".3gp": "video/3gpp",
  // 音声
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

// メディア拡張子セット（ファイル収集用）
export const MEDIA_EXTENSIONS = new Set(Object.keys(MEDIA_MIME_MAP));

// Gemini Embedding 2 がサポートする全拡張子（テキスト系含む）
export const GEMINI_SUPPORTED_EXTENSIONS = new Set([
  // 画像
  ".png", ".jpg", ".jpeg", ".webp", ".bmp",
  // 動画
  ".mp4", ".mpeg", ".mpg", ".mov", ".avi", ".flv", ".webm", ".wmv", ".3gp",
  // 音声
  ".mp3", ".wav",
  // ドキュメント
  ".pdf",
  // テキスト
  ".txt", ".html", ".css", ".csv", ".xml", ".rtf", ".js", ".json", ".md",
]);

export type MediaType = "image" | "video" | "audio";

/** 拡張子からメディアタイプを判定 */
export function getMediaType(ext: string): MediaType | null {
  const mime = MEDIA_MIME_MAP[ext.toLowerCase()];
  if (!mime) return null;
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return null;
}

/** メディアファイルかどうか判定 */
export function isMediaFile(ext: string): boolean {
  return ext.toLowerCase() in MEDIA_MIME_MAP;
}

/** PDFファイルかどうか判定 */
export function isPdfFile(ext: string): boolean {
  return ext.toLowerCase() === ".pdf";
}

// チャンキング設定
export const CHUNK_CONFIG = {
  video: { chunkSizeSec: 60, overlapSec: 10 },
  audio: { chunkSizeSec: 40, overlapSec: 5 },
  pdf: { chunkSizePages: 3, overlapPages: 1 },
} as const;

/** inlineData形式のパーツ（Gemini Embedding APIに送る形式） */
export interface InlineDataPart {
  inlineData: {
    mimeType: string;
    data: string; // base64
  };
}

/** マルチモーダルチャンクの情報 */
export interface MediaChunk {
  part: InlineDataPart;
  label: string; // 表示用ラベル（例: "[画像] photo.png", "[動画 00:00-01:00] movie.mp4"）
}

/** メディアファイルの長さ（秒）をffprobeで取得 */
export function getMediaDuration(filePath: string): number {
  const result = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`,
    { encoding: "utf-8", timeout: 10000 },
  );
  return parseFloat(result.trim());
}

/** 秒数を MM:SS 形式に変換 */
function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** ファイルをbase64 inlineDataとして読み込み */
async function loadAsInlineData(filePath: string): Promise<InlineDataPart> {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MEDIA_MIME_MAP[ext];
  if (!mimeType) throw new Error(`未対応のメディア形式: ${ext}`);

  const buffer = await fs.readFile(filePath);
  return {
    inlineData: {
      mimeType,
      data: buffer.toString("base64"),
    },
  };
}

/**
 * 画像ファイルを1チャンクとして処理（分割なし）
 */
export async function chunkImage(filePath: string): Promise<MediaChunk[]> {
  const fileName = path.basename(filePath);
  const part = await loadAsInlineData(filePath);
  return [{ part, label: `[画像] ${fileName}` }];
}

/**
 * 動画/音声ファイルをチャンク分割して処理
 * ffmpegでセグメント分割 → 各セグメントをbase64読み込み
 */
export async function chunkMedia(
  filePath: string,
  mediaType: "video" | "audio",
): Promise<MediaChunk[]> {
  const config = CHUNK_CONFIG[mediaType];
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const typeLabel = mediaType === "video" ? "動画" : "音声";
  const duration = getMediaDuration(filePath);

  // 短いファイルは分割なし
  if (duration <= config.chunkSizeSec) {
    const part = await loadAsInlineData(filePath);
    return [{ part, label: `[${typeLabel}] ${fileName}` }];
  }

  // ffmpegでセグメント分割
  const tmpDir = `/tmp/rag-media-chunks/${Date.now()}`;
  await fs.mkdir(tmpDir, { recursive: true });

  const chunks: MediaChunk[] = [];
  let start = 0;
  let index = 0;

  try {
    while (start < duration) {
      const segPath = path.join(tmpDir, `seg_${index}${ext}`);
      execSync(
        `ffmpeg -y -i "${filePath}" -ss ${start} -t ${config.chunkSizeSec} -c copy "${segPath}" 2>/dev/null`,
        { timeout: 30000 },
      );

      const endTime = Math.min(start + config.chunkSizeSec, duration);
      const part = await loadAsInlineData(segPath);
      chunks.push({
        part,
        label: `[${typeLabel} ${formatTime(start)}-${formatTime(endTime)}] ${fileName}`,
      });

      start += config.chunkSizeSec - config.overlapSec;
      index++;
    }
  } finally {
    // 一時ファイル削除
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  return chunks;
}

/**
 * PDFファイルをページ分割してチャンク化
 * 3ページずつ、1ページオーバーラップ
 */
export async function chunkPdf(filePath: string): Promise<MediaChunk[]> {
  const fileName = path.basename(filePath);
  const buffer = await fs.readFile(filePath);

  // PDFのページ数を取得
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse");
  const data = await pdfParse(buffer);
  const totalPages = data.numpages;

  if (totalPages <= CHUNK_CONFIG.pdf.chunkSizePages) {
    // 3ページ以内ならそのままembedding用にbase64で返す
    return [{
      part: {
        inlineData: {
          mimeType: "application/pdf",
          data: buffer.toString("base64"),
        },
      },
      label: `[PDF] ${fileName}`,
    }];
  }

  // ページ分割が必要 → ghostscriptでページ抽出
  const tmpDir = `/tmp/rag-pdf-chunks/${Date.now()}`;
  await fs.mkdir(tmpDir, { recursive: true });

  const chunks: MediaChunk[] = [];
  const { chunkSizePages, overlapPages } = CHUNK_CONFIG.pdf;
  let startPage = 1;
  let index = 0;

  try {
    while (startPage <= totalPages) {
      const endPage = Math.min(startPage + chunkSizePages - 1, totalPages);
      const segPath = path.join(tmpDir, `seg_${index}.pdf`);

      // ghostscriptでページ範囲を抽出
      execSync(
        `gs -sDEVICE=pdfwrite -dNOPAUSE -dBATCH -dQUIET -dFirstPage=${startPage} -dLastPage=${endPage} -sOutputFile="${segPath}" "${filePath}"`,
        { timeout: 30000 },
      );

      const segBuffer = await fs.readFile(segPath);
      chunks.push({
        part: {
          inlineData: {
            mimeType: "application/pdf",
            data: segBuffer.toString("base64"),
          },
        },
        label: `[PDF p.${startPage}-${endPage}] ${fileName}`,
      });

      startPage += chunkSizePages - overlapPages;
      index++;
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  return chunks;
}

/**
 * メディアファイルをチャンク分割する統一エントリポイント
 */
export async function chunkMediaFile(filePath: string): Promise<MediaChunk[]> {
  const ext = path.extname(filePath).toLowerCase();

  // PDF
  if (isPdfFile(ext)) {
    return chunkPdf(filePath);
  }

  // 画像・動画・音声
  const mediaType = getMediaType(ext);
  switch (mediaType) {
    case "image":
      return chunkImage(filePath);
    case "video":
      return chunkMedia(filePath, "video");
    case "audio":
      return chunkMedia(filePath, "audio");
    default:
      throw new Error(`未対応のメディアタイプ: ${ext}`);
  }
}
