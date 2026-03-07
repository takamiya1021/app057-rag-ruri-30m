// RAG設定ファイル管理
// インデックス対象ディレクトリ等の設定を永続化する

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  ".local/share/rag-mcp-ruri-30m/config.json",
);

interface RagConfig {
  // インデックス対象ディレクトリの絶対パス一覧
  indexedDirs: string[];
  // Google Drive差分同期用のchangeトークン
  gdriveChangeToken?: string;
}

const DEFAULT_CONFIG: RagConfig = {
  indexedDirs: [],
};

/** 設定ファイルのパスを取得 */
function getConfigPath(): string {
  return process.env.RAG_CONFIG_PATH || DEFAULT_CONFIG_PATH;
}

/** 設定を読み込み */
export function loadConfig(): RagConfig {
  const configPath = getConfigPath();
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      indexedDirs: Array.isArray(parsed.indexedDirs) ? parsed.indexedDirs : [],
      gdriveChangeToken: parsed.gdriveChangeToken ?? undefined,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** 設定を保存 */
export function saveConfig(config: RagConfig): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

/** インデックス対象ディレクトリを追加（重複しない） */
export function addIndexedDir(dirPath: string): void {
  const resolved = path.resolve(dirPath);
  const config = loadConfig();
  if (!config.indexedDirs.includes(resolved)) {
    config.indexedDirs.push(resolved);
    saveConfig(config);
  }
}

/** インデックス対象ディレクトリを削除 */
export function removeIndexedDir(dirPath: string): void {
  const resolved = path.resolve(dirPath);
  const config = loadConfig();
  config.indexedDirs = config.indexedDirs.filter((d) => d !== resolved);
  saveConfig(config);
}

/** インデックス対象ディレクトリ一覧を取得 */
export function getIndexedDirs(): string[] {
  return loadConfig().indexedDirs;
}

/** Google Drive差分同期用のchangeトークンを取得 */
export function getGdriveChangeToken(): string | undefined {
  return loadConfig().gdriveChangeToken;
}

/** Google Drive差分同期用のchangeトークンを保存 */
export function setGdriveChangeToken(token: string): void {
  const config = loadConfig();
  config.gdriveChangeToken = token;
  saveConfig(config);
}
