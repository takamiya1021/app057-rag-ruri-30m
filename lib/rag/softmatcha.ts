// SoftMatcha 2 構造検索クライアント
// 検索: 常駐Pythonブリッジ（stdin/stdout JSON通信）
// 構築: 別プロセスで非同期実行（検索をブロックしない）

import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as readline from "node:readline";

// SoftMatcha 2関連のパス
const SOFTMATCHA_DIR = path.join(__dirname, "../../softmatcha");
const BRIDGE_SCRIPT = path.join(SOFTMATCHA_DIR, "bridge.py");

// デフォルトのデータディレクトリ（DBと同じ場所）
const DEFAULT_DATA_DIR = path.join(
  os.homedir(),
  ".local/share/rag-mcp-ruri-30m/softmatcha",
);

// インデックス自動再構築の間隔（24時間）
const REBUILD_INTERVAL_MS = 24 * 60 * 60 * 1000;



/** SoftMatcha 2の検索結果 */
export interface SoftMatchaResult {
  pattern: string;
  score: number; // 0-100
  count: number;
  chunk_ids: number[];
}

/** SoftMatcha 2の検索レスポンス */
interface SearchResponse {
  results?: SoftMatchaResult[];
  threshold?: number;
  error?: string;
  message?: string;
}

/** コーパスマッピングエントリ */
interface CorpusMapEntry {
  chunk_id: number;
  byte_start: number;
  byte_end: number;
  text_preview: string;
}

// --- 検索ブリッジ（常駐プロセス） ---
let process_: ChildProcess | null = null;
let rl: readline.Interface | null = null;
let pendingResolve: ((value: unknown) => void) | null = null;
let ready = false;
let dataDir = DEFAULT_DATA_DIR;

// --- 構築状態 ---
let buildInProgress = false;

/** データディレクトリを設定 */
export function setSoftMatchaDataDir(dir: string): void {
  dataDir = dir;
}

function getDataDir(): string {
  return dataDir;
}

function getCorpusPath(): string {
  return path.join(getDataDir(), "corpus.txt");
}

function getMapPath(): string {
  return path.join(getDataDir(), "corpus_map.json");
}

function getIndexPath(): string {
  return path.join(getDataDir(), "index");
}

function getStagingIndexPath(): string {
  return path.join(getDataDir(), "index_staging");
}

function getLastBuildPath(): string {
  return path.join(getDataDir(), "last_build");
}

// =====================================================
// 検索ブリッジ（常駐プロセス管理）
// =====================================================

/** ブリッジプロセスを起動 */
async function ensureProcess(): Promise<void> {
  if (process_ && !process_.killed) return;

  const dir = getDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return new Promise((resolve, reject) => {
    const uvPath = path.join(os.homedir(), ".local/bin/uv");
    process_ = spawn(uvPath, ["run", "python", BRIDGE_SCRIPT], {
      cwd: SOFTMATCHA_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    });

    process_.stderr?.on("data", (data: Buffer) => {
      console.error(`[softmatcha] ${data.toString().trim()}`);
    });

    process_.on("error", (err) => {
      console.error(`[softmatcha] プロセスエラー: ${err.message}`);
      ready = false;
      process_ = null;
    });

    process_.on("exit", (code) => {
      console.error(`[softmatcha] プロセス終了 (code: ${code})`);
      ready = false;
      process_ = null;
      rl = null;
    });

    rl = readline.createInterface({ input: process_.stdout! });

    rl.once("line", (line: string) => {
      try {
        const msg = JSON.parse(line);
        if (msg.status === "ready") {
          ready = true;
          rl!.on("line", handleResponse);
          resolve();
        } else {
          reject(new Error(`予期しない起動メッセージ: ${line}`));
        }
      } catch {
        reject(new Error(`起動メッセージのパースエラー: ${line}`));
      }
    });

    setTimeout(() => {
      if (!ready) reject(new Error("SoftMatcha 2ブリッジの起動タイムアウト"));
    }, 30000);
  });
}

function handleResponse(line: string): void {
  // SoftMatchaライブラリが出すデバッグ行（"loading begin..."、"#Search = ..."等）を無視
  if (!line.startsWith("{")) return;

  if (pendingResolve) {
    try {
      const result = JSON.parse(line);
      pendingResolve(result);
    } catch {
      // JSONパース失敗でもresolveを消費しない（次の正規JSONを待つ）
      console.error(`[softmatcha] 非JSONレスポンスをスキップ: ${line.slice(0, 100)}`);
      return;
    }
    pendingResolve = null;
  }
}

async function sendCommand(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
  await ensureProcess();

  if (!process_ || !process_.stdin) {
    throw new Error("SoftMatcha 2ブリッジプロセスが利用できません");
  }

  return new Promise((resolve, reject) => {
    pendingResolve = resolve as (value: unknown) => void;
    const json = JSON.stringify(cmd);
    process_!.stdin!.write(json + "\n");

    setTimeout(() => {
      if (pendingResolve) {
        pendingResolve = null;
        reject(new Error("SoftMatcha 2コマンドタイムアウト"));
      }
    }, 60000);
  });
}

// =====================================================
// コーパス・インデックス管理
// =====================================================

/** コーパスファイルとマッピングを生成 */
export function buildCorpus(
  chunks: Array<{ id: number; text: string }>,
): { corpusPath: string; mapPath: string } {
  const corpusPath = getCorpusPath();
  const mapPath = getMapPath();

  const dir = getDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const corpusMap: CorpusMapEntry[] = [];
  let currentByte = 0;

  const fd = fs.openSync(corpusPath, "w");
  for (const chunk of chunks) {
    const cleanText = chunk.text.replace(/\n/g, " ").trim();
    const line = cleanText + "\n";
    const bytes = Buffer.byteLength(line, "utf-8");

    corpusMap.push({
      chunk_id: chunk.id,
      byte_start: currentByte,
      byte_end: currentByte + bytes - 1,
      text_preview: cleanText.slice(0, 200),
    });

    fs.writeSync(fd, line);
    currentByte += bytes;
  }
  fs.closeSync(fd);

  fs.writeFileSync(mapPath, JSON.stringify(corpusMap, null, 2));
  return { corpusPath, mapPath };
}

/** 最終構築日時を記録 */
function recordBuildTime(): void {
  const dir = getDataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getLastBuildPath(), new Date().toISOString());
}

/** 最終構築日時を取得 */
function getLastBuildTime(): Date | null {
  const p = getLastBuildPath();
  if (!fs.existsSync(p)) return null;
  try {
    return new Date(fs.readFileSync(p, "utf-8").trim());
  } catch {
    return null;
  }
}

// =====================================================
// インデックス構築（別プロセス・非同期）
// =====================================================

/**
 * SoftMatchaインデックスを非同期で構築する（検索をブロックしない）
 *
 * 1. コーパスファイルを生成（同期・軽量）
 * 2. 別プロセスで softmatcha-index を実行（staging ディレクトリに出力）
 * 3. 完了後にアトミックにインデックスを入れ替え
 * 4. 検索ブリッジにリロードを通知
 */
export async function buildSoftMatchaIndex(
  chunks: Array<{ id: number; text: string }>,
): Promise<{ ok: boolean; numTokens?: number; error?: string }> {
  if (chunks.length === 0) {
    return { ok: false, error: "チャンクが空です" };
  }

  if (buildInProgress) {
    return { ok: false, error: "構築中です。完了をお待ちください。" };
  }

  buildInProgress = true;

  try {
    // 1. コーパスファイルを生成
    const { corpusPath, mapPath } = buildCorpus(chunks);
    const stagingPath = getStagingIndexPath();
    const indexPath = getIndexPath();

    // ステージングディレクトリをクリーンアップ
    if (fs.existsSync(stagingPath)) {
      fs.rmSync(stagingPath, { recursive: true });
    }

    // 2. 別プロセスでインデックス構築
    const result = await runBuildProcess(corpusPath, stagingPath);

    if (!result.ok) {
      buildInProgress = false;
      return result;
    }

    // 3. アトミックにインデックスを入れ替え
    const oldPath = indexPath + "_old";
    if (fs.existsSync(oldPath)) fs.rmSync(oldPath, { recursive: true });
    if (fs.existsSync(indexPath)) fs.renameSync(indexPath, oldPath);
    fs.renameSync(stagingPath, indexPath);
    if (fs.existsSync(oldPath)) fs.rmSync(oldPath, { recursive: true });

    recordBuildTime();

    // 4. 検索ブリッジにリロードを通知（起動している場合）
    if (ready) {
      try {
        await sendCommand({ action: "load", index_path: indexPath, map_path: mapPath });
      } catch (e) {
        console.error(`[softmatcha] リロード通知失敗（次回検索時にロードされます）: ${e}`);
      }
    }

    buildInProgress = false;
    return { ok: true, numTokens: result.numTokens };
  } catch (e) {
    buildInProgress = false;
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

/** softmatcha-index CLI を別プロセスで実行 */
function runBuildProcess(
  corpusPath: string,
  indexPath: string,
): Promise<{ ok: boolean; numTokens?: number; error?: string }> {
  return new Promise((resolve) => {
    const uvPath = path.join(os.homedir(), ".local/bin/uv");
    const args = [
      "run", "softmatcha-index",
      "--backend", "fasttext",
      "--model", "fasttext-ja-vectors",
      "--index", indexPath,
      "--mem_size", "500",
      "--mem_size_ex", "100",
      corpusPath,
    ];

    console.error(`[softmatcha] インデックス構築開始（バックグラウンド）`);
    const proc = spawn(uvPath, args, {
      cwd: SOFTMATCHA_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrOutput = "";
    proc.stderr?.on("data", (data: Buffer) => {
      const line = data.toString();
      stderrOutput += line;
      // 進捗をログに出力
      if (line.includes("Tokenize") || line.includes("Phase") || line.includes("finished")) {
        console.error(`[softmatcha-build] ${line.trim()}`);
      }
    });

    proc.on("exit", (code) => {
      if (code === 0) {
        // トークン数をログから抽出
        const match = stderrOutput.match(/#Tokens\s*:\s*([\d,]+)/);
        const numTokens = match ? parseInt(match[1].replace(/,/g, ""), 10) : undefined;
        console.error(`[softmatcha] インデックス構築完了`);
        resolve({ ok: true, numTokens });
      } else {
        console.error(`[softmatcha] インデックス構築失敗 (code: ${code})`);
        resolve({ ok: false, error: `構築プロセス終了コード: ${code}` });
      }
    });

    proc.on("error", (err) => {
      resolve({ ok: false, error: err.message });
    });
  });
}

// =====================================================
// 検索
// =====================================================

/** SoftMatcha 2で構造検索 */
export async function searchSoftMatcha(
  query: string,
  numCandidates: number = 20,
  minSimilarity: number = 0.3,
): Promise<SoftMatchaResult[]> {
  if (!fs.existsSync(path.join(getIndexPath(), "metadata.bin"))) {
    return [];
  }

  // プロセスが起動していなければ起動してインデックスをロード
  if (!ready) {
    const loaded = await loadSoftMatchaIndex();
    if (!loaded) return [];
  }

  const response = await sendCommand({
    action: "search",
    query,
    num_candidates: numCandidates,
    min_similarity: minSimilarity,
  }) as SearchResponse;

  if (response.error) {
    console.error(`[softmatcha] 検索エラー: ${response.error}`);
    return [];
  }

  return response.results || [];
}

/** SoftMatcha 2のインデックスをロード */
export async function loadSoftMatchaIndex(): Promise<boolean> {
  const indexPath = getIndexPath();
  const mapPath = getMapPath();

  if (!fs.existsSync(path.join(indexPath, "metadata.bin"))) {
    return false;
  }

  const result = await sendCommand({
    action: "load",
    index_path: indexPath,
    map_path: mapPath,
  }) as { ok: boolean };

  return result.ok;
}

// =====================================================
// 状態確認
// =====================================================

/** インデックスが存在するか */
export function hasSoftMatchaIndex(): boolean {
  return fs.existsSync(path.join(getIndexPath(), "metadata.bin"));
}

/** インデックスが古い（前回構築から24時間以上経過）か */
export function isIndexStale(): boolean {
  const lastBuild = getLastBuildTime();
  if (!lastBuild) return true;
  return Date.now() - lastBuild.getTime() > REBUILD_INTERVAL_MS;
}

/** 構築中か */
export function isBuildInProgress(): boolean {
  return buildInProgress;
}

/** SoftMatcha 2の状態を取得 */
export async function getSoftMatchaStatus(): Promise<{
  ready: boolean;
  hasIndex: boolean;
  numChunks: number;
  building: boolean;
  lastBuild: string | null;
}> {
  const lastBuild = getLastBuildTime();

  if (!ready) {
    return {
      ready: false,
      hasIndex: hasSoftMatchaIndex(),
      numChunks: 0,
      building: buildInProgress,
      lastBuild: lastBuild?.toISOString() ?? null,
    };
  }

  const result = await sendCommand({ action: "status" }) as {
    ready: boolean;
    num_chunks: number;
    has_index: boolean;
  };

  return {
    ready: result.ready,
    hasIndex: result.has_index,
    numChunks: result.num_chunks,
    building: buildInProgress,
    lastBuild: lastBuild?.toISOString() ?? null,
  };
}

/** ブリッジプロセスを停止 */
export async function shutdownSoftMatcha(): Promise<void> {
  if (process_ && !process_.killed) {
    try {
      await sendCommand({ action: "shutdown" });
    } catch {
      // タイムアウトやエラーは無視
    }
    process_.kill();
    process_ = null;
    rl = null;
    ready = false;
  }
}
