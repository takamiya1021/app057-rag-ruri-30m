// Google Drive差分同期CLI
// 共有ライブラリ lib/rag/gdriveSync.ts を使用
//
// 使い方:
//   npx tsx cli/gdrive-sync.ts init       — 初回: changeトークンを取得・保存（DLしない）
//   npx tsx cli/gdrive-sync.ts check      — 変更を検出してレポート（DLしない）
//   npx tsx cli/gdrive-sync.ts sync       — 変更を検出 → DL → インデックス更新

import { initDb } from "../lib/rag/vectorStore";
import {
  initChangeToken,
  checkChanges,
  syncChanges,
} from "../lib/rag/gdriveSync";

/** 初回トークン取得 */
function init(): void {
  const { token, isNew } = initChangeToken();
  if (isNew) {
    console.log(`トークン保存完了: ${token}`);
    console.log("次回以降、このトークン以降の変更が検出されます");
  } else {
    console.log(`既存トークンあり: ${token}`);
    console.log("上書きする場合は手動でconfig.jsonを編集してください");
  }
}

/** 変更チェック（レポートのみ） */
function check(): void {
  const { modified, removed, total, newToken } = checkChanges();

  if (total === 0) {
    console.log("変更なし");
    return;
  }

  console.log(`\n変更検出結果:`);
  console.log(`  変更/追加: ${modified.length}件`);
  console.log(`  削除/ゴミ箱: ${removed.length}件`);
  console.log(`  合計: ${total}件（スキップ含む）`);
  console.log(`  新トークン: ${newToken}`);

  if (modified.length > 0) {
    console.log(`\n変更/追加ファイル（上位20件）:`);
    for (const c of modified.slice(0, 20)) {
      console.log(`  - ${c.file?.name} (${c.file?.mimeType})`);
    }
    if (modified.length > 20) {
      console.log(`  ... 他${modified.length - 20}件`);
    }
  }

  console.log(`\nsync を実行するとDL→インデックス更新します`);
}

/** 差分同期（DL→インデックス更新） */
async function sync(): Promise<void> {
  initDb();
  const result = await syncChanges();

  console.log(`\n完了:`);
  console.log(`  DL: ${result.downloaded}件`);
  console.log(`  インデックス更新: ${result.indexed}件`);
  console.log(`  エラー: ${result.errors}件`);
  console.log(`  削除: ${result.deleted}件`);
  console.log(`  新トークン: ${result.newToken}`);
  console.log(`\nSoftMatcha 2の再構築が必要な場合は build_softmatcha_index を実行してください`);
}

// メインエントリー
const [, , command] = process.argv;

switch (command) {
  case "init":
    init();
    break;
  case "check":
    check();
    break;
  case "sync":
    sync();
    break;
  default:
    console.log(`Google Drive差分同期CLI

使い方:
  npx tsx cli/gdrive-sync.ts init    初回セットアップ（changeトークン取得・保存）
  npx tsx cli/gdrive-sync.ts check   変更を検出してレポート（DLしない）
  npx tsx cli/gdrive-sync.ts sync    変更を検出 → DL → インデックス更新`);
}
