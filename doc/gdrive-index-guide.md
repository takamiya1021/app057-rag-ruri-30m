# Google Drive インデックス作成手順

Google Drive上のファイルをkuro-ragのトリプルハイブリッド検索（ruri + BM25 + SoftMatcha 2）に対応させる手順。

## 前提

- gws CLI（Google Workspace CLI）がインストール・認証済みであること
- kuro-ragのruri + BM25インデックスが動作していること

## 全体の流れ

```
1. Google Driveから全ファイルをDL（1つずつ順次、並列禁止）
2. DLしたファイルのうち変換が必要なものを変換
3. インデックス作成（ruri + BM25）— CLIでバッチ一括
4. SoftMatcha 2インデックスの再構築
```

## 1. ファイルのダウンロード

### DL対象

Google Drive上の全ファイルから画像・動画・音声・ショートカットを除いたもの。

### DL方法（mimeType別）

| 種類 | mimeType | DL方法 |
|------|----------|--------|
| テキスト/MD/PDF/JSON等 | text/*, application/pdf, application/json等 | `gws drive files get` でそのままDL |
| Google Docs | application/vnd.google-apps.document | `gws drive files export` でテキスト化 |
| Google スプレッドシート | application/vnd.google-apps.spreadsheet | `gws drive files export` でCSV化 |
| Google スライド | application/vnd.google-apps.presentation | `gws drive files export` でテキスト化 |
| Office系（Word/Excel/PowerPoint） | application/msword, application/vnd.openxmlformats-*等 | `gws drive files get` でDL後、テキスト抽出が必要 |

### DLコマンド例

```bash
# 通常ファイル（テキスト/PDF等）
gws drive files get --params '{"fileId": "<ID>", "alt": "media"}' --output /tmp/gdrive-dl/files/<filename>

# Google Docs → テキスト
gws drive files export --params '{"fileId": "<ID>", "mimeType": "text/plain"}' --output /tmp/gdrive-dl/files/<filename>.txt

# Google スプレッドシート → CSV
gws drive files export --params '{"fileId": "<ID>", "mimeType": "text/csv"}' --output /tmp/gdrive-dl/files/<filename>.csv

# Google スライド → テキスト
gws drive files export --params '{"fileId": "<ID>", "mimeType": "text/plain"}' --output /tmp/gdrive-dl/files/<filename>.txt
```

### 重要ルール

- **並列DL禁止**: APIリクエストは1つずつ順次実行。並列で大量リクエストを送るとGoogleから攻撃と見なされる
- **APIエラー時のリトライ禁止**: 503等のエラーが返ったら1回で止めて報告

## 2. ファイルの変換

DL後、Office系ファイル（Word/Excel/PowerPoint）はそのままではインデックスに登録できないため、テキスト抽出が必要。

対応方法は今後追記。

## 3. インデックス作成（ruri + BM25）

MCP経由ではなくCLIでバッチ一括実行する（MCP経由は遅いため）。

```bash
npx tsx cli/rag-cli.ts add-dir /tmp/gdrive-dl/files [バッチサイズ]
```

- バッチサイズのデフォルトは50
- 全チャンクのエンベディングをまとめて生成してからDB保存する

## 4. SoftMatcha 2 インデックスの再構築

新しいチャンクが追加されるため、SoftMatcha 2のインデックスを再構築する。

MCP経由で実行:
```
build_softmatcha_index
```

または直接:
```bash
uv run softmatcha-index --backend fasttext --model fasttext-ja-vectors --index ~/.local/share/rag-mcp-ruri-30m/softmatcha/index ~/.local/share/rag-mcp-ruri-30m/softmatcha/corpus.txt
```

## 5. フィルタリング（任意）

インデックス登録前または登録後に、以下を除外することを推奨:

- シークレット情報（パスワード、APIキー、バックアップコード等）
- ジャンクファイル（VMwareログ、文字化けファイル等）
- 空ファイル

## 6. 差分同期（2回目以降）

初回インデックス後の差分更新は `gws drive changes` APIを使用する。

```bash
# 初回: changeトークンを取得・保存（config.jsonに記録）
npx tsx cli/gdrive-sync.ts init

# 変更を確認（DLしない）
npx tsx cli/gdrive-sync.ts check

# 変更を検出 → DL → インデックス更新 → tmpファイル削除
npx tsx cli/gdrive-sync.ts sync
```

### 仕組み

1. `gws drive changes getStartPageToken` でトークンを取得（初回のみ）
2. `gws drive changes list` でトークン以降の変更を取得
3. 変更ファイルだけDL → インデックス更新
4. 削除/ゴミ箱ファイルはインデックスから除去
5. 新しいトークンを保存

トークンはconfig.json（`gdriveChangeToken`）に永続化される。

### 自動実行

トークン設定済みの場合、MCP検索時に1時間に1回バックグラウンドで差分同期が自動実行される（`mcp/server.ts` `triggerBackgroundUpdate`）。
上記CLIコマンド（check/sync）は必要な時に手動で実行する用。

## 参考: 前回実績

| 項目 | 値 |
|------|-----|
| Google Drive全ファイル | 11,844件 |
| DL対象（画像/動画/音声除外） | 6,816件 |
| DL成功 | 4,740件 |
| インデックス登録（対応形式のみ） | 1,938ファイル / 36,891チャンク |
| DL所要時間目安 | 1件約1秒 |
