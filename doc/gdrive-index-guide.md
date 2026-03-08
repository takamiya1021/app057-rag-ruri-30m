# Google Drive インデックス作成手順

Google Drive上のファイルをkuro-ragのトリプルハイブリッド検索（ruri + BM25 + SoftMatcha 2）に対応させる手順。

## 前提

- gws CLI（Google Workspace CLI）がインストール・認証済みであること
- kuro-ragのruri + BM25インデックスが動作していること

## 全体の流れ

```
1. bulkコマンドでGoogle Driveの全ファイルをDL → インデックス一括作成
2. SoftMatcha 2インデックスの再構築
3. 以降は差分同期で自動更新
```

## 1. 初回一括インデックス（bulkコマンド）

```bash
npx tsx cli/gdrive-sync.ts bulk
```

bulkコマンドが自動で行うこと:
1. Google Drive APIでDL対象ファイル一覧を取得（ホワイトリスト方式でフィルタリング）
2. ファイルを1件ずつ順次DL（並列DL禁止）
3. DLと並行してインデックス処理を実行（パイプライン方式）
4. 完了後、差分同期用トークンを自動保存
5. 一時ファイルを自動削除

### DL対象（ホワイトリスト方式）

Google Apps形式はテキスト変換してDL、バイナリ/テキスト形式はそのままDL。
ホワイトリストにないmimeType（画像、動画、音声、フォルダ等）はすべてスキップ。

| 種類 | mimeType | DL方法 | 変換後 |
|------|----------|--------|--------|
| Google Docs | application/vnd.google-apps.document | export | .txt |
| Google スプレッドシート | application/vnd.google-apps.spreadsheet | export | .csv |
| Google スライド | application/vnd.google-apps.presentation | export | .txt |
| PDF | application/pdf | そのままDL | .pdf |
| テキスト | text/plain | そのままDL | .txt |
| Markdown | text/markdown | そのままDL | .md |
| CSV | text/csv | そのままDL | .csv |
| JSON | application/json | そのままDL | .json |

### パイプライン処理

```
DL（1件ずつ順次）  ──→ ファイルA → ファイルB → ファイルC → ...
                          ↓
インデックス（1件ずつ順次）→ ファイルA → ファイルB → ...
```

- DLとインデックスは並行で動く（DL待ち時間中にインデックス処理が進む）
- DL同士は直列（APIレート制限対策）
- インデックス同士も直列（リソース競合防止）

### 重要ルール

- **並列DL禁止**: APIリクエストは1つずつ順次実行
- **APIエラー時のリトライ禁止**: 503等のエラーが返ったら1回で止めて報告
- **ファイル名サニタイズ**: シングルクォート等の特殊文字はアンダースコアに置換
- **二重拡張子防止**: ファイル名が既に正しい拡張子を持つ場合は追加しない

### 想定されるスキップ/エラー

| 種類 | 原因 | 対応 |
|------|------|------|
| DL後ファイル不在 | gwsがDL成功と返すがファイルが作られない（一部JSONファイル等） | エラーログに記録、スキップ |
| パスワード保護PDF | pdf-parseがパスワード付きPDFを処理できない | エラーログに記録、スキップ |
| PDFフォント警告 | pdf-parseの内部警告（"Ran out of space in font private use area"等） | 無害、正常にインデックスされる |

## 2. SoftMatcha 2 インデックスの再構築

bulkコマンド完了後、SoftMatcha 2のインデックスを再構築する。

MCP経由で実行:
```
build_softmatcha_index
```

## 3. 差分同期（2回目以降）

bulkコマンドが差分同期用トークンを自動保存するため、以降は差分同期で更新できる。

```bash
# 変更を確認（DLしない）
npx tsx cli/gdrive-sync.ts check

# 変更を検出 → DL → インデックス更新 → tmpファイル削除
npx tsx cli/gdrive-sync.ts sync
```

### 自動実行

トークン設定済みの場合、MCP検索時に1時間に1回バックグラウンドで差分同期が自動実行される（`mcp/server.ts` `triggerBackgroundUpdate`）。

## テスト結果

全1693ファイルを5セットに分割してテスト済み。

| セット | 範囲 | DL成功 | インデックス | アプリバグエラー |
|--------|------|--------|-------------|----------------|
| 1 | 1〜300 | 299/300 | 260 | 0 |
| 2 | 301〜600 | 300/300 | 122 | 0 |
| 3 | 601〜900 | 300/300 | 114 | 0 |
| 4 | 901〜1200 | 296/300 | 259 | 0 |
| 5 | 1201〜1693 | 493/493 | 287 | 0 |
| **合計** | **全1693件** | **1688/1693** | **1042** | **0** |

全エラーはファイル側の問題（gwsのDL後ファイル未生成、パスワード保護PDF）であり、アプリのバグによるエラーは0件。
