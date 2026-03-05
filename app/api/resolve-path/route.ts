// ソース名から実ファイルパスを解決するAPI
import { NextResponse } from "next/server";
import { execSync } from "child_process";

/** findコマンドでソース名のファイルを検索し実パスを返す */
function resolveFilePath(source: string): string | null {
  // ファイル名部分を取得
  const fileName = source.split("/").pop();
  if (!fileName) return null;

  try {
    // ホームディレクトリ配下を検索（5秒タイムアウト）
    const result = execSync(
      `find ~ -name ${JSON.stringify(fileName)} -type f -not -path '*/node_modules/*' -not -path '*/.next/*' -not -path '*/.git/*' 2>/dev/null | head -10`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim();

    if (!result) return null;

    const candidates = result.split("\n");

    // 候補が1つならそのまま返す
    if (candidates.length === 1) return candidates[0];

    // ソースパスの末尾部分が一致するものを優先
    const sourceParts = source.split("/");

    // 全パーツが含まれる完全一致
    for (const candidate of candidates) {
      const allMatch = sourceParts.every((part) => candidate.includes(part));
      if (allMatch) return candidate;
    }

    // 最後の2階層で判定
    const tail = sourceParts.slice(-2).join("/");
    for (const candidate of candidates) {
      if (candidate.includes(tail)) return candidate;
    }

    // 最初の候補を返す
    return candidates[0];
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const source = url.searchParams.get("source");

  if (!source) {
    return NextResponse.json({ error: "sourceパラメータが必要です" }, { status: 400 });
  }

  const filePath = resolveFilePath(source);
  if (!filePath) {
    return NextResponse.json(
      { error: "実ファイルが見つかりません", source },
      { status: 404 },
    );
  }

  // ?action=open の場合は code コマンドでVSCodeで開く
  if (url.searchParams.get("action") === "open") {
    try {
      // まずWSL側のcodeコマンドを試す（IPCソケット経由、高速）
      let opened = false;
      const sockets = execSync(
        "ls -t /run/user/1000/vscode-ipc-*.sock 2>/dev/null",
        { encoding: "utf-8", timeout: 2000 },
      ).trim();
      if (sockets) {
        // 各ソケットを新しい順に試す（古いソケットが残っている場合があるため）
        for (const sock of sockets.split("\n")) {
          try {
            const env = { ...process.env, VSCODE_IPC_HOOK_CLI: sock };
            execSync(`code ${JSON.stringify(filePath)}`, { timeout: 5000, env });
            opened = true;
            break;
          } catch {
            // このソケットは無効、次を試す
          }
        }
      }
      // WSL側で開けなかった場合、Windows側のcodeコマンドで開く
      if (!opened) {
        const winPath = execSync(`wslpath -w ${JSON.stringify(filePath)}`, { encoding: "utf-8", timeout: 2000 }).trim();
        execSync(`cmd.exe /c "cd /d C:\\Users\\takam && code \\"${winPath}\\""`, { timeout: 10000 });
      }
      return NextResponse.json({ source, filePath, opened: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "不明なエラー";
      return NextResponse.json(
        { error: "VSCodeで開けませんでした: " + msg, source, filePath },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ source, filePath });
}
