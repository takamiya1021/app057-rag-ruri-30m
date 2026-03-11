---
name: rag-search
description: RAG検索のクエリ最適化とインデックス管理。「ラグ」「RAG」を含む依頼時、またはMCP kuro-rag-ruri-30m の search を使う前に発動。
---

# RAG検索スキル

## 実行手順

```
1. 使用エンジンを判定
   - ユーザーが「Gemini」「gemini」「エンベディング2」等を明示 → Gemini Embedding 2
   - それ以外 → デフォルト（ruri+BM25）

2. インデックス存在チェック（rag://status を確認）
   - デフォルトの場合: totalChunks === 0 → インデックスなし
   - Geminiの場合: geminiChunks === 0 → インデックスなし
   - インデックスなし → ユーザーに報告
     「インデックスがありません。作成しますか？」
     - はい → 下記「インデックス新規作成」の手順に従って作成 → 完了後にステップ5へ
     - いいえ → 検索できない旨を伝えて終了
   - インデックスあり → ステップ3へ

3. クエリを最適化（下記ルールに従う）
4. MCP kuro-rag-ruri-30m search を呼ぶ（Geminiの場合は engine: "gemini" を指定）
5. 結果をユーザーに分かりやすく回答
6. ヒットしなければキーワードを変えて再検索
```

## クエリ最適化ルール

### ひらがな固有名詞→カタカナ変換
| ユーザー入力 | 検索クエリ |
|-------------|-----------|
| なのばなな | ナノバナナ |
| おーぷんくろー | OpenClaw |
| ぷれいらいと | Playwright |
| てれぐらむ | Telegram |
| でぃすこーど | Discord |

### 口語→検索キーワード変換
| ユーザー入力 | 検索クエリ |
|-------------|-----------|
| なのばななのファイルはどこにある？ | ナノバナナ |
| おーぷんくろーの使い方教えて | OpenClaw 使い方 機能 |
| ぷれいらいとでブラウザ動かしたい | Playwright ブラウザ自動化 |

### 原則
- **助詞・接続詞は除去**: 「の」「は」「を」「で」「が」等は検索に不要
- **キーワードだけを抽出**: 意味のある名詞・動詞のみ残す
- **英語名があれば英語も併用**: 固有名詞は英語表記の方がヒットしやすい場合がある
- **複数回検索OK**: 1回でヒットしなければキーワードを変えて再検索

## 検索エンジンの使い分け

- **デフォルト（ruri+BM25）**: 通常の検索
- **SoftMatcha 2**: ソフトパターンマッチ（フレーズ検索）
- **Gemini Embedding 2（隠し機能）**: ユーザーが「Gemini」「gemini」「エンベディング2」等を明示した時のみ。こちらからは提案しない

### Gemini Embedding 2 検索方法
- **CLI**: `npx tsx cli/rag-cli.ts search --engine gemini "クエリ"`
- **MCP**: `search({ query: "クエリ", engine: "gemini" })`
- 検索のたびにクエリのベクトル化でGemini APIを1回呼ぶ（課金はほぼゼロ）
- ruriの検索とは完全に独立。結果のマージはしない

## インデックス新規作成

**重要: MCPツール（add_directory等）は使わない。CLIで直接DB書き込みする。**

### ローカルファイル

1. ユーザーにインデックス対象のディレクトリパスを聞く
2. **CLI `rag-cli.ts add-dir` を使う**（MCPを通さず直接DB書き込み）
   ```bash
   npx tsx cli/rag-cli.ts add-dir <ディレクトリパス> [バッチサイズ]
   ```
   - 全ファイルのチャンクをまとめて一括エンベディング生成（ファイル単位ではない）
   - バッチサイズはデフォルト50。メモリに余裕があれば100〜200に増やすと高速化
   - プロジェクトルートディレクトリで実行すること
3. 複数ディレクトリがある場合は、各ディレクトリに対して `add-dir` を実行
4. ruri+BM25のインデックス作成が完了したら、MCP `build_softmatcha_index` でSoftMatcha 2も構築
5. （オプション）Gemini Embedding 2インデックスも構築する場合:
   ```bash
   npx tsx cli/rag-cli.ts add-dir-gemini <ディレクトリパス>
   ```

### Google Drive

#### 前提
- gws CLI（Google Workspace CLI）がインストール・認証済みであること

#### 手順

1. **ファイルリスト取得**
   ```bash
   gws drive files list --params '{"pageSize": 1000, "q": "trashed = false", "fields": "files(id,name,mimeType,size),nextPageToken"}' --page-all > /tmp/gdrive-dl/drive_all.json
   ```

2. **DL対象フィルタリング** — 以下を除外:
   - `image/*`, `video/*`, `audio/*`
   - `application/vnd.google-apps.shortcut`, `.folder`, `.form`, `.map`, `.site`, `.drawing`

3. **1件ずつ順次DL**（並列禁止、APIエラー時リトライ禁止）
   | 種類 | DL方法 |
   |------|--------|
   | 通常ファイル | `gws drive files get --params '{"fileId": "<ID>", "alt": "media"}' --output <path>` |
   | Google Docs | `gws drive files export --params '{"fileId": "<ID>", "mimeType": "text/plain"}' --output <path>.txt` |
   | スプレッドシート | `gws drive files export --params '{"fileId": "<ID>", "mimeType": "text/csv"}' --output <path>.csv` |
   | スライド | `gws drive files export --params '{"fileId": "<ID>", "mimeType": "text/plain"}' --output <path>.txt` |

4. **CLIでバッチインデックス作成**（MCPではなくCLI）
   ```bash
   npx tsx cli/rag-cli.ts add-dir /tmp/gdrive-dl/files 50
   ```

5. **SoftMatcha 2インデックス再構築** — MCP `build_softmatcha_index` を実行

6. **後片付け** — `rm -rf /tmp/gdrive-dl/`
7. **changeトークン取得** — `npx tsx cli/gdrive-sync.ts init`
   - 以降の差分同期で使うトークンを取得・保存する

## インデックス更新

### 自動更新（検索時バックグラウンド）
- **ruri+BM25**: 検索時に前回チェックから1時間経過していればmtime比較で差分更新（ローカル+GDrive）
- **Gemini**: 同上（検索時に前回チェックから1時間経過していればmtime比較で差分更新）
- **SoftMatcha**: 自動更新なし。24時間超過で検索時に1回だけ通知 → 手動再構築

### 手動で即時更新したい場合

#### デフォルト（ruri+BM25）
- **ローカルファイル**: check_updates → sync_updates → build_softmatcha_index
- **Google Drive**: `npx tsx cli/gdrive-sync.ts sync` → build_softmatcha_index

#### Gemini Embedding 2
```bash
npx tsx cli/rag-cli.ts check-gemini     # 更新チェック（レポートのみ）
npx tsx cli/rag-cli.ts sync-gemini      # 差分更新（mtime比較→変更分だけ再インデックス）
```

## Gemini Embedding 2 インデックス構築（隠し機能）

### 前提
- `GEMINI_API_KEY` が設定されていること

### 構築コマンド（ruriとは独立したパイプライン）
```bash
npx tsx cli/rag-cli.ts add-dir-gemini <ディレクトリパス>
```
- ソースファイルから直接読み込み→チャンク分割→Gemini API でベクトル化
- 別DB（`rag-gemini-embedding-2-preview.db`）に保存
- ruriのDBには依存しない（V2単独で完結）
- バッチ100件ずつ、レート制限対策あり（1秒間隔）
- 所要時間: 約12分（22,000チャンクの場合）

## 注意

- MCPにLLMクエリ最適化は組み込まない（MCPは検索エンジンのみ）
- クエリ最適化はクロの責務
- Web UIは独自にLLMクエリ最適化を内蔵済み（chat/route.ts）
