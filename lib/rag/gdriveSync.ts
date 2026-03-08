// Google Drive差分同期
// gws drive changes APIでトークンベースの差分検出 → 変更ファイルDL → インデックス更新
//
// トークン = 「どこまで見たか」のブックマーク
// 1. getStartPageToken で現在地点のトークンを取得・保存
// 2. changes list でそのトークン以降の変更を検出
// 3. 変更ファイルだけDL → インデックス更新

import { execSync, exec } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";

const execAsync = promisify(exec);
import { getGdriveChangeToken, setGdriveChangeToken } from "./config";
import { removeSource, addChunks, upsertSourceFile } from "./vectorStore";
import { loadDocument } from "./documentLoader";
import { splitText, splitMarkdown } from "./chunker";
import { generateEmbeddings } from "./embedding";

const GWS = "gws";
const DL_DIR = "/tmp/gdrive-sync/files";

// DL対象のmimeType（ホワイトリスト方式）
// Google Apps形式: exportでテキスト変換してDL
const EXPORT_MIME_MAP: Record<string, { exportMime: string; ext: string }> = {
  "application/vnd.google-apps.document": { exportMime: "text/plain", ext: ".txt" },
  "application/vnd.google-apps.spreadsheet": { exportMime: "text/csv", ext: ".csv" },
  "application/vnd.google-apps.presentation": { exportMime: "text/plain", ext: ".txt" },
};

// バイナリ/テキスト形式: そのままDL（PDFは除外: 請求書・領収書等が多くノイズになる）
const DIRECT_DL_MIME_MAP: Record<string, string> = {
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "application/json": ".json",
};

// ファイルサイズ上限（10MB）
const MAX_FILE_SIZE = 10 * 1024 * 1024;

interface DriveChange {
  fileId: string;
  removed: boolean;
  file?: {
    id: string;
    name: string;
    mimeType: string;
    trashed?: boolean;
  };
}

/** gws CLIを実行してJSONを返す */
function gwsExec(args: string): unknown {
  const cmd = `${GWS} ${args}`;
  const result = execSync(cmd, { encoding: "utf-8", timeout: 30000 });
  return JSON.parse(result);
}

/** DL対象かどうか判定（ホワイトリスト方式） */
export function isDownloadTarget(mimeType: string): boolean {
  return mimeType in EXPORT_MIME_MAP || mimeType in DIRECT_DL_MIME_MAP;
}

/** ファイル名をファイルシステム・シェル安全な文字列に変換 */
export function makeSafeName(name: string): string {
  return name.replace(/[/\\:*?"<>|']/g, "_");
}

/** ファイル名に拡張子を付加（既に同じ拡張子なら付加しない） */
export function addExtIfNeeded(name: string, ext: string): string {
  return name.toLowerCase().endsWith(ext.toLowerCase()) ? name : `${name}${ext}`;
}

/** ファイルを1件DL */
function downloadFile(fileId: string, name: string, mimeType: string): string | null {
  const safeName = makeSafeName(name);

  try {
    const exportInfo = EXPORT_MIME_MAP[mimeType];
    if (exportInfo) {
      // Google Apps形式: exportでテキスト変換
      const outPath = path.join(DL_DIR, addExtIfNeeded(safeName, exportInfo.ext));
      execSync(
        `${GWS} drive files export --params '{"fileId": "${fileId}", "mimeType": "${exportInfo.exportMime}"}' --output '${outPath}'`,
        { timeout: 30000 },
      );
      return outPath;
    }

    const ext = DIRECT_DL_MIME_MAP[mimeType];
    if (ext) {
      // バイナリ/テキスト形式: そのままDL
      const outPath = path.join(DL_DIR, addExtIfNeeded(safeName, ext));
      execSync(
        `${GWS} drive files get --params '{"fileId": "${fileId}", "alt": "media"}' --output '${outPath}'`,
        { timeout: 30000 },
      );
      return outPath;
    }

    // ホワイトリストにない → DLしない（ここには到達しないはず）
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[gdrive-sync] DLエラー: ${name} — ${msg}`);
    return null;
  }
}

/** 初回トークン取得・保存 */
export function initChangeToken(): { token: string; isNew: boolean } {
  const existing = getGdriveChangeToken();
  if (existing) {
    return { token: existing, isNew: false };
  }

  const result = gwsExec("drive changes getStartPageToken") as { startPageToken?: string };
  const token = result.startPageToken;
  if (!token) {
    throw new Error(`トークン取得失敗: ${JSON.stringify(result)}`);
  }

  setGdriveChangeToken(token);
  return { token, isNew: true };
}

/** 変更リストを取得 */
export function getChanges(): { changes: DriveChange[]; newToken: string } {
  const token = getGdriveChangeToken();
  if (!token) {
    throw new Error("changeトークンがありません。先に initChangeToken() を実行してください");
  }

  const allChanges: DriveChange[] = [];
  let pageToken = token;
  let newStartPageToken = token;

  while (true) {
    const result = gwsExec(
      `drive changes list --params '{"pageToken": "${pageToken}", "fields": "changes(fileId,removed,file(id,name,mimeType,trashed)),newStartPageToken,nextPageToken", "pageSize": 1000}'`,
    ) as {
      changes?: DriveChange[];
      newStartPageToken?: string;
      nextPageToken?: string;
    };

    if (result.changes) {
      allChanges.push(...result.changes);
    }
    if (result.newStartPageToken) {
      newStartPageToken = result.newStartPageToken;
    }
    if (!result.nextPageToken) break;
    pageToken = result.nextPageToken;
  }

  return { changes: allChanges, newToken: newStartPageToken };
}

/** 変更チェック（レポートのみ、DLしない） */
export function checkChanges(): {
  modified: DriveChange[];
  removed: DriveChange[];
  total: number;
  newToken: string;
} {
  const { changes, newToken } = getChanges();

  const modified: DriveChange[] = [];
  const removed: DriveChange[] = [];

  for (const change of changes) {
    if (change.removed || change.file?.trashed) {
      removed.push(change);
    } else if (change.file && isDownloadTarget(change.file.mimeType)) {
      modified.push(change);
    }
  }

  return { modified, removed, total: changes.length, newToken };
}

/** 差分同期（DL→インデックス更新） */
export async function syncChanges(): Promise<{
  downloaded: number;
  indexed: number;
  deleted: number;
  errors: number;
  newToken: string;
}> {
  const { modified, removed, newToken } = checkChanges();

  if (modified.length === 0 && removed.length === 0) {
    setGdriveChangeToken(newToken);
    return { downloaded: 0, indexed: 0, deleted: 0, errors: 0, newToken };
  }

  // DLディレクトリ作成
  fs.mkdirSync(DL_DIR, { recursive: true });

  // 削除処理
  let deletedCount = 0;
  for (const change of removed) {
    if (change.file?.name) {
      const count = removeSource(change.file.name);
      if (count > 0) deletedCount++;
    }
  }

  // DL → インデックス（1件ずつ順次）
  let dlCount = 0;
  let indexCount = 0;
  let errorCount = 0;

  for (const change of modified) {
    const file = change.file!;
    const dlPath = downloadFile(file.id, file.name, file.mimeType);
    if (!dlPath) {
      errorCount++;
      continue;
    }

    if (!fs.existsSync(dlPath)) {
      errorCount++;
      console.error(`[gdrive-sync] DL後ファイル不在: ${file.name} — ${dlPath}`);
      continue;
    }
    dlCount++;

    try {
      const doc = await loadDocument(dlPath);
      const textChunks = doc.format === "md" ? splitMarkdown(doc.text) : splitText(doc.text);
      if (textChunks.length === 0) continue;

      removeSource(doc.source);
      const embeddings = await generateEmbeddings(textChunks, "RETRIEVAL_DOCUMENT");
      const chunks = textChunks.map((text, i) => ({
        text,
        source: doc.source,
        chunkIndex: i,
      }));
      addChunks(chunks, embeddings);

      const stat = fs.statSync(dlPath);
      upsertSourceFile(doc.source, dlPath, stat.mtimeMs);
      indexCount++;
    } catch (e) {
      errorCount++;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[gdrive-sync] インデックスエラー: ${file.name} — ${msg}`);
    }
  }

  // トークン更新
  setGdriveChangeToken(newToken);

  // 後片付け
  if (fs.existsSync(DL_DIR)) {
    fs.rmSync(DL_DIR, { recursive: true, force: true });
  }

  return { downloaded: dlCount, indexed: indexCount, deleted: deletedCount, errors: errorCount, newToken };
}

/** changeトークンが設定済みか（Google Drive同期が有効か） */
export function isGdriveSyncEnabled(): boolean {
  return !!getGdriveChangeToken();
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string; // Google Drive APIはstring型で返す
}

/** Google Driveの全ファイル一覧を取得（DL対象のみ） */
function listAllFiles(limit?: number): DriveFile[] {
  const allFiles: DriveFile[] = [];
  let pageToken: string | undefined;
  let skippedSize = 0;

  while (true) {
    const params: Record<string, unknown> = {
      q: "trashed=false",
      pageSize: 1000,
      fields: "files(id,name,mimeType,size),nextPageToken",
    };
    if (pageToken) params.pageToken = pageToken;

    const result = gwsExec(
      `drive files list --params '${JSON.stringify(params)}'`,
    ) as { files?: DriveFile[]; nextPageToken?: string };

    if (result.files) {
      for (const f of result.files) {
        if (!isDownloadTarget(f.mimeType)) continue;
        // Google Apps形式はsizeがない（export時にテキスト変換されるため）
        const fileSize = f.size ? parseInt(f.size, 10) : 0;
        if (fileSize > MAX_FILE_SIZE) {
          skippedSize++;
          continue;
        }
        allFiles.push(f);
        if (limit && allFiles.length >= limit) {
          if (skippedSize > 0) console.log(`  サイズ超過スキップ: ${skippedSize}件`);
          return allFiles;
        }
      }
    }
    if (!result.nextPageToken) break;
    pageToken = result.nextPageToken;
  }

  if (skippedSize > 0) console.log(`  サイズ超過スキップ: ${skippedSize}件`);
  return allFiles;
}

/** ファイルを1件DL（非同期版） */
async function downloadFileAsync(fileId: string, name: string, mimeType: string): Promise<string | null> {
  const safeName = makeSafeName(name);

  try {
    const exportInfo = EXPORT_MIME_MAP[mimeType];
    if (exportInfo) {
      const outPath = path.join(DL_DIR, addExtIfNeeded(safeName, exportInfo.ext));
      await execAsync(
        `${GWS} drive files export --params '{"fileId": "${fileId}", "mimeType": "${exportInfo.exportMime}"}' --output '${outPath}'`,
        { timeout: 30000 },
      );
      return outPath;
    }

    const ext = DIRECT_DL_MIME_MAP[mimeType];
    if (ext) {
      const outPath = path.join(DL_DIR, addExtIfNeeded(safeName, ext));
      await execAsync(
        `${GWS} drive files get --params '{"fileId": "${fileId}", "alt": "media"}' --output '${outPath}'`,
        { timeout: 30000 },
      );
      return outPath;
    }

    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[gdrive-sync] DLエラー: ${name} — ${msg}`);
    return null;
  }
}

/** 1件のインデックス処理（テキスト抽出→エンベディング→DB保存） */
async function indexFile(dlPath: string, fileName: string, gdriveFileId?: string): Promise<boolean> {
  try {
    const doc = await loadDocument(dlPath);
    // 空 or ほぼ無意味なテキストはスキップ（50文字未満）
    if (!doc.text || doc.text.trim().length < 50) return false;
    const textChunks = doc.format === "md" ? splitMarkdown(doc.text) : splitText(doc.text);
    if (textChunks.length === 0) return false;

    removeSource(doc.source);
    const embeddings = await generateEmbeddings(textChunks, "RETRIEVAL_DOCUMENT");
    const chunks = textChunks.map((text, j) => ({
      text,
      source: doc.source,
      chunkIndex: j,
    }));
    addChunks(chunks, embeddings);

    // Google Drive経由はgdrive://パスで記録（ファイル削除後も消えない）
    if (gdriveFileId) {
      upsertSourceFile(doc.source, `gdrive://${gdriveFileId}`, Date.now());
    } else {
      const stat = fs.statSync(dlPath);
      upsertSourceFile(doc.source, dlPath, stat.mtimeMs);
    }
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[gdrive-bulk] インデックスエラー: ${fileName} — ${msg}`);
    return false;
  }
}

/** 初回一括DL: DLとインデックスをパイプライン並行処理 */
export async function bulkDownload(limit?: number): Promise<{
  total: number;
  downloaded: number;
  indexed: number;
  errors: number;
}> {
  console.log("Google Driveファイル一覧を取得中...");
  const files = listAllFiles(limit);
  console.log(`DL対象: ${files.length}件${limit ? ` (limit: ${limit})` : ""}`);

  // 前回の残留ファイルを削除してクリーンスタート
  if (fs.existsSync(DL_DIR)) {
    fs.rmSync(DL_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(DL_DIR, { recursive: true });

  let dlCount = 0;
  let indexCount = 0;
  let errorCount = 0;

  // インデックス処理キュー（1件ずつ直列で処理。DLとは並行で動く）
  let indexChain = Promise.resolve();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if ((i + 1) % 100 === 0) {
      console.log(`  DL進捗: ${i + 1}/${files.length}`);
    }

    // DLは1件ずつシングルでawait（待ち時間中にインデックス処理が進む）
    const dlPath = await downloadFileAsync(file.id, file.name, file.mimeType);
    if (!dlPath) {
      errorCount++;
      continue;
    }

    if (!fs.existsSync(dlPath)) {
      errorCount++;
      console.error(`[gdrive-bulk] DL後ファイル不在: ${file.name} — ${dlPath}`);
      continue;
    }
    dlCount++;

    // インデックスをキューに追加（gdrive://パスで記録）
    const fileId = file.id;
    indexChain = indexChain.then(async () => {
      const ok = await indexFile(dlPath, file.name, fileId);
      if (ok) indexCount++;
    });
  }

  // 全DL完了後、残りのインデックス処理の完了を待つ
  console.log(`DL完了: ${dlCount}件。インデックス処理の完了を待機中...`);
  await indexChain;

  // 後片付け
  if (fs.existsSync(DL_DIR)) {
    fs.rmSync(DL_DIR, { recursive: true, force: true });
  }

  // トークン保存（bulk後は差分同期に移行できるように）
  const tokenResult = gwsExec("drive changes getStartPageToken") as { startPageToken?: string };
  if (tokenResult.startPageToken) {
    setGdriveChangeToken(tokenResult.startPageToken);
    console.log(`差分同期トークン保存: ${tokenResult.startPageToken}`);
  }

  return { total: files.length, downloaded: dlCount, indexed: indexCount, errors: errorCount };
}
