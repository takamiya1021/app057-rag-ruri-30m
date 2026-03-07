---
name: rag-search
description: MCPのRAG検索を使う前にクエリを最適化する。ひらがな→カタカナ変換、口語→検索キーワード変換をクロが行ってからMCP searchを呼ぶ。「ラグ」「RAG」「ラグ検索」「ラグで検索」「ラグで探して」「ラグで調べて」等のRAG検索依頼時に自動発動。
---

# RAG検索スキル

## いつ使うか

- ユーザーが「ラグ」「RAG」というキーワードを含む依頼をした時
  - 例: 「ラグで検索して」「ラグで〇〇探して」「ラグで調べて」「ラグ検索」
- MCP `kuro-rag-ruri-30m` の `search` ツールを使う前

**注意**: 「検索して」「探して」だけではファイル検索（Grep）と区別がつかない。ユーザーは明示的に「ラグ」と言う運用なので、「ラグ」がなければRAG検索は発動しない。

## クエリ最適化ルール

MCPの`search`を呼ぶ**前に**、クロが以下の最適化を行う。

### 1. ひらがな固有名詞→カタカナ変換
| ユーザー入力 | 検索クエリ |
|-------------|-----------|
| なのばなな | ナノバナナ |
| おーぷんくろー | OpenClaw |
| ぷれいらいと | Playwright |
| てれぐらむ | Telegram |
| でぃすこーど | Discord |

### 2. 口語→検索キーワード変換
| ユーザー入力 | 検索クエリ |
|-------------|-----------|
| なのばななのファイルはどこにある？ | ナノバナナ |
| おーぷんくろーの使い方教えて | OpenClaw 使い方 機能 |
| ぷれいらいとでブラウザ動かしたい | Playwright ブラウザ自動化 |

### 3. 原則
- **助詞・接続詞は除去**: 「の」「は」「を」「で」「が」等は検索に不要
- **キーワードだけを抽出**: 意味のある名詞・動詞のみ残す
- **英語名があれば英語も併用**: 固有名詞は英語表記の方がヒットしやすい場合がある
- **複数回検索OK**: 1回でヒットしなければキーワードを変えて再検索

## 実行フロー

```
1. インデックス存在チェック（rag://status を確認）
   - totalChunks === 0（インデックスなし）→ ユーザーに報告
     「インデックスがありません。作成しますか？」
     - はい → 「インデックス新規作成の手順」に従って作成 → 完了後にステップ4へ
     - いいえ → 検索できない旨を伝えて終了
   - totalChunks > 0（インデックスあり）→ ステップ2へ

2. クエリを最適化（上記ルール）
3. MCP kuro-rag-ruri-30m search を呼ぶ
4. 結果をユーザーに分かりやすく回答
5. ヒットしなければキーワードを変えて再検索

```

## インデックス新規作成の手順

インデックスがない状態（totalChunks === 0）でユーザーが「作成して」と言った場合:

**重要: MCPツール（add_directory等）は使わない。CLIで直接DB書き込みする。**

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

## Google Driveのインデックス作成

Google Drive上のファイルをRAGインデックスに登録する手順。

### 前提
- gws CLI（Google Workspace CLI）がインストール・認証済みであること

### 手順

1. **ファイルリスト取得**
   ```bash
   gws drive files list --params '{"pageSize": 1000, "fields": "files(id,name,mimeType,size),nextPageToken"}' --page-all > /tmp/gdrive-dl/drive_all.json
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

手動で即時更新したい場合:
- **ローカルファイル**: check_updates → sync_updates → build_softmatcha_index
- **Google Drive**: `npx tsx cli/gdrive-sync.ts sync` → build_softmatcha_index

## 注意

- MCPにLLMクエリ最適化は組み込まない（MCPは検索エンジンのみ）
- クエリ最適化はクロの責務
- Web UIは独自にLLMクエリ最適化を内蔵済み（chat/route.ts）
