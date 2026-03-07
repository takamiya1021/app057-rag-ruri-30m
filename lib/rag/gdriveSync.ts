// Google Drive差分同期
// gws drive changes APIでトークンベースの差分検出 → 変更ファイルDL → インデックス更新
//
// トークン = 「どこまで見たか」のブックマーク
// 1. getStartPageToken で現在地点のトークンを取得・保存
// 2. changes list でそのトークン以降の変更を検出
// 3. 変更ファイルだけDL → インデックス更新

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getGdriveChangeToken, setGdriveChangeToken } from "./config";
import { removeSource, addChunks, upsertSourceFile } from "./vectorStore";
import { loadDocument } from "./documentLoader";
import { splitText, splitMarkdown } from "./chunker";
import { generateEmbeddings } from "./embedding";

const GWS = "gws";
const DL_DIR = "/tmp/gdrive-sync/files";

// DL対象外のmimeType
const SKIP_MIME_PREFIXES = ["image/", "video/", "audio/"];
const SKIP_MIME_TYPES = new Set([
  "application/vnd.google-apps.shortcut",
  "application/vnd.google-apps.folder",
  "application/vnd.google-apps.form",
  "application/vnd.google-apps.map",
  "application/vnd.google-apps.site",
  "application/vnd.google-apps.drawing",
]);

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

/** DL対象かどうか判定 */
function isDownloadTarget(mimeType: string): boolean {
  if (SKIP_MIME_TYPES.has(mimeType)) return false;
  for (const prefix of SKIP_MIME_PREFIXES) {
    if (mimeType.startsWith(prefix)) return false;
  }
  return true;
}

/** ファイルを1件DL */
function downloadFile(fileId: string, name: string, mimeType: string): string | null {
  const safeName = name.replace(/[/\\:*?"<>|]/g, "_");

  try {
    if (mimeType === "application/vnd.google-apps.document") {
      const outPath = path.join(DL_DIR, `${safeName}.txt`);
      execSync(
        `${GWS} drive files export --params '{"fileId": "${fileId}", "mimeType": "text/plain"}' --output '${outPath}'`,
        { timeout: 30000 },
      );
      return outPath;
    } else if (mimeType === "application/vnd.google-apps.spreadsheet") {
      const outPath = path.join(DL_DIR, `${safeName}.csv`);
      execSync(
        `${GWS} drive files export --params '{"fileId": "${fileId}", "mimeType": "text/csv"}' --output '${outPath}'`,
        { timeout: 30000 },
      );
      return outPath;
    } else if (mimeType === "application/vnd.google-apps.presentation") {
      const outPath = path.join(DL_DIR, `${safeName}.txt`);
      execSync(
        `${GWS} drive files export --params '{"fileId": "${fileId}", "mimeType": "text/plain"}' --output '${outPath}'`,
        { timeout: 30000 },
      );
      return outPath;
    } else {
      const outPath = path.join(DL_DIR, safeName);
      execSync(
        `${GWS} drive files get --params '{"fileId": "${fileId}", "alt": "media"}' --output '${outPath}'`,
        { timeout: 30000 },
      );
      return outPath;
    }
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
  const SUPPORTED_EXTS = new Set([".md", ".txt", ".pdf", ".json", ".csv"]);
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
    dlCount++;

    const ext = path.extname(dlPath).toLowerCase();
    if (!SUPPORTED_EXTS.has(ext)) continue;

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
