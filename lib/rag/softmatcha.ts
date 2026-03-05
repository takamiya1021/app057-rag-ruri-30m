// SoftMatcha 2 構造検索クライアント
// Pythonブリッジプロセスとstdin/stdout JSON通信で連携する

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

let process_: ChildProcess | null = null;
let rl: readline.Interface | null = null;
let pendingResolve: ((value: unknown) => void) | null = null;
let ready = false;
let dataDir = DEFAULT_DATA_DIR;

/** データディレクトリを設定 */
export function setSoftMatchaDataDir(dir: string): void {
  dataDir = dir;
}

/** データディレクトリのパスを取得 */
function getDataDir(): string {
  return dataDir;
}

/** コーパスファイルのパス */
function getCorpusPath(): string {
  return path.join(getDataDir(), "corpus.txt");
}

/** コーパスマッピングファイルのパス */
function getMapPath(): string {
  return path.join(getDataDir(), "corpus_map.json");
}

/** インデックスディレクトリのパス */
function getIndexPath(): string {
  return path.join(getDataDir(), "index");
}

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

    // 最初の行は起動メッセージ {"status": "ready"}
    rl.once("line", (line: string) => {
      try {
        const msg = JSON.parse(line);
        if (msg.status === "ready") {
          ready = true;
          // 行の読み取りをコマンド応答用に切り替え
          rl!.on("line", handleResponse);
          resolve();
        } else {
          reject(new Error(`予期しない起動メッセージ: ${line}`));
        }
      } catch {
        reject(new Error(`起動メッセージのパースエラー: ${line}`));
      }
    });

    // 10秒タイムアウト
    setTimeout(() => {
      if (!ready) reject(new Error("SoftMatcha 2ブリッジの起動タイムアウト"));
    }, 30000);
  });
}

/** レスポンスハンドラ */
function handleResponse(line: string): void {
  if (pendingResolve) {
    try {
      const result = JSON.parse(line);
      pendingResolve(result);
    } catch {
      pendingResolve({ error: `JSONパースエラー: ${line}` });
    }
    pendingResolve = null;
  }
}

/** コマンドを送信して結果を受信 */
async function sendCommand(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
  await ensureProcess();

  if (!process_ || !process_.stdin) {
    throw new Error("SoftMatcha 2ブリッジプロセスが利用できません");
  }

  return new Promise((resolve, reject) => {
    pendingResolve = resolve as (value: unknown) => void;
    const json = JSON.stringify(cmd);
    process_!.stdin!.write(json + "\n");

    // 60秒タイムアウト（インデックス構築は時間がかかる）
    setTimeout(() => {
      if (pendingResolve) {
        pendingResolve = null;
        reject(new Error("SoftMatcha 2コマンドタイムアウト"));
      }
    }, 60000);
  });
}

/**
 * コーパスファイルとマッピングを生成
 * DBから全チャンクを読み出して1つのテキストファイルに結合する
 */
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

  // 各チャンクを改行区切りでテキストファイルに書き出す
  const fd = fs.openSync(corpusPath, "w");
  for (const chunk of chunks) {
    // テキスト内の改行をスペースに置換（1行1チャンク）
    const cleanText = chunk.text.replace(/\n/g, " ").trim();
    const line = cleanText + "\n";
    const bytes = Buffer.byteLength(line, "utf-8");

    corpusMap.push({
      chunk_id: chunk.id,
      byte_start: currentByte,
      byte_end: currentByte + bytes - 1, // 改行を除く
      text_preview: cleanText.slice(0, 200), // 検索マッチング用プレビュー
    });

    fs.writeSync(fd, line);
    currentByte += bytes;
  }
  fs.closeSync(fd);

  // マッピングファイルを保存
  fs.writeFileSync(mapPath, JSON.stringify(corpusMap, null, 2));

  return { corpusPath, mapPath };
}

/** SoftMatcha 2のインデックスを構築 */
export async function buildSoftMatchaIndex(
  chunks: Array<{ id: number; text: string }>,
): Promise<{ ok: boolean; numTokens?: number; error?: string }> {
  if (chunks.length === 0) {
    return { ok: false, error: "チャンクが空です" };
  }

  // コーパスファイルを生成
  const { corpusPath, mapPath } = buildCorpus(chunks);
  const indexPath = getIndexPath();

  // ブリッジにインデックス構築を依頼
  const result = await sendCommand({
    action: "build",
    corpus_path: corpusPath,
    index_path: indexPath,
    map_path: mapPath,
  }) as { ok: boolean; num_tokens?: number; error?: string };

  return {
    ok: result.ok,
    numTokens: result.num_tokens,
    error: result.error,
  };
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

/** SoftMatcha 2で構造検索 */
export async function searchSoftMatcha(
  query: string,
  numCandidates: number = 20,
  minSimilarity: number = 0.3,
): Promise<SoftMatchaResult[]> {
  // インデックスが存在しない場合は空結果を返す
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

/** インデックスが存在するか */
export function hasSoftMatchaIndex(): boolean {
  return fs.existsSync(path.join(getIndexPath(), "metadata.bin"));
}

/** SoftMatcha 2の状態を取得 */
export async function getSoftMatchaStatus(): Promise<{
  ready: boolean;
  hasIndex: boolean;
  numChunks: number;
}> {
  if (!ready) {
    return {
      ready: false,
      hasIndex: hasSoftMatchaIndex(),
      numChunks: 0,
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
