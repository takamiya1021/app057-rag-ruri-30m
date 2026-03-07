# APP057: クロラグ Ruri版（ruri-v3-30m） — 仕様書

## 概要

日本語特化エンベディングモデル **ruri-v3-30m**（名古屋大学）を使用したセマンティック検索システム。
MCPサーバー + Web UIの2つのインターフェースでナレッジベースを検索・質問できる。

APP056（ruri-v3-130m版）の後継。軽量モデル（37Mパラメータ）に切り替え、起動速度とリソース効率を改善。

## エンベディングモデル: ruri-v3-30m

| 項目 | 値 |
|------|-----|
| 正式名称 | cl-nagoya/ruri-v3-30m |
| ONNXモデル | sirasagi62/ruri-v3-30m-ONNX |
| 開発元 | 名古屋大学 自然言語処理研究室 |
| パラメータ数 | 37M |
| 出力次元 | 256 |
| JMTEBスコア | 72.95（text-embedding-3-large超え圏内） |
| 実行方式 | ローカル（ONNX、APIキー不要） |
| コスト | 無料 |

### プレフィックス方式

| 用途 | プレフィックス |
|------|-------------|
| 検索クエリ | `"検索クエリ: "` |
| 検索対象ドキュメント | `"検索文書: "` |

## 検索方式: トリプルハイブリッド検索

3種類の検索エンジン + LLMによる4層構成。それぞれ得意分野がまったく異なるため、組み合わせることで単独では拾えなかった結果をカバーし、検索精度を大幅に向上させる。

### 検索エンジン一覧

| 検索方式 | 技術 | 得意なケース |
|---------|------|------------|
| ベクトル検索 | ruri-v3-30m + sqlite-vec（KNN） | 意味検索、カタカナ→英語の言語横断 |
| BM25検索 | SQLite FTS5（unicode61トークナイザ） | 固有名詞、略語、コマンド名の完全一致 |
| ソフトパターンマッチ | SoftMatcha 2（soft pattern matching） | フレーズの類似パターン検出（置換・挿入・削除を許容） |
| 統合 | RRF（Reciprocal Rank Fusion, k=60） | 3方式にヒットした結果のスコア合算 |
| 回答生成 | LLM（Gemini 2.5 Flash） | 検索結果の統合・要約・質問応答 |

### 各検索方式の役割と補完関係

```
ruri（ベクトル検索）   — 「意味が近い」を見つける
BM25（キーワード検索） — 「単語が一致する」を見つける
SoftMatcha 2（ソフトパターンマッチ）— 「フレーズの類似パターン」を見つける
LLM                   — 検索結果を理解し、回答を生成する
```

- **ruriが得意、SoftMatcha 2が苦手**: 言い換え表現（「削除する」→「消す」）
- **BM25が得意、ruriが苦手**: 固有名詞・コマンド名の完全一致（`git rebase`）
- **SoftMatcha 2が得意、ruri/BM25が苦手**: フレーズの類似パターン検出（置換・挿入・削除を許容）

3方式を併用することで、どれか1つでは取りこぼしていた結果を補完し合う。

### SoftMatcha 2 について

| 項目 | 値 |
|------|-----|
| 正式名称 | SoftMatcha 2 |
| 論文 | [SoftMatcha 2: A Fast and Soft Pattern Matcher for Trillion-Scale Corpora](https://arxiv.org/abs/2602.10908) |
| GitHub | [softmatcha/softmatcha2](https://github.com/softmatcha/softmatcha2) |
| 実装言語 | Python 54% + Rust 46% |
| 検索方式 | サフィックス配列 + 転置インデックス + 動的プルーニング |
| 単語類似度 | fastText エンベディング（日本語対応） |
| スケール | 1.4兆トークン（6TB+）で0.3秒以下 |
| ライセンス | Apache License 2.0（一部MIT） |
| 前身 | SoftMatcha v1（ICLR 2025、Billionスケール） |

#### v1との違い

- v1: Billion（10億）スケール → v2: Trillion（兆）スケール
- v2: 挿入・削除パターンにも対応（v1は置換のみ）
- v2: サフィックス配列ベースでさらに高速化

## アーキテクチャ

### システム構成

```
[Web UI] ← Next.js App Router
    ├── チャット画面（tool use方式でGemini 2.5 Flashが検索ツールを使い分け）
    ├── ドキュメントビューア（モーダル or VSCode連携）
    └── 設定画面（APIキー、DBパス、リンク表示方法）

[MCP Server] ← Claude Code等のMCPクライアントから利用
    ├── 9ツール（検索・追加・削除・更新チェック・同期・SoftMatchaインデックス構築）
    └── stdio接続

[SoftMatcha 2 ブリッジ] ← Python常駐プロセス（stdin/stdout JSON通信）
    ├── fastText日本語モデル + MeCabトークナイザー
    ├── サフィックス配列ベースのソフトパターンマッチ（soft pattern matching）
    └── コーパスファイル + インデックス管理

[共通RAGエンジン] lib/rag/
    ├── embedding.ts     — ruri-v3-30m ONNX推論
    ├── vectorStore.ts   — SQLite + sqlite-vec + FTS5 + RRF統合
    ├── softmatcha.ts    — SoftMatcha 2クライアント（ブリッジ通信）
    ├── chunker.ts       — テキスト分割（段落ベース + Markdown対応）
    ├── documentLoader.ts — ファイル読み込み（txt/md/pdf/json）
    └── types.ts         — 型定義
```

### ファイル構成

```
app057-rag-ruri-30m/
├── app/                    # Next.js App Router
│   ├── api/
│   │   ├── chat/route.ts       # チャットAPI（tool use方式）
│   │   ├── documents/[source]/  # ドキュメント取得API
│   │   └── resolve-path/       # VSCode連携API
│   └── page.tsx
├── components/
│   ├── ChatPanel.tsx           # チャットUI + ドキュメントビューア
│   └── SettingsModal.tsx       # 設定モーダル
├── lib/rag/                # 共通RAGエンジン
│   ├── softmatcha.ts          # SoftMatcha 2クライアント
│   └── ...
├── softmatcha/             # SoftMatcha 2（Python + Rust）
│   ├── bridge.py              # ブリッジスクリプト（JSON通信）
│   ├── src/                   # SoftMatcha 2ソースコード
│   └── rust/                  # Rust拡張
├── mcp/
│   ├── server.ts               # MCPサーバー定義
│   └── index.ts                # エントリポイント
├── cli/
│   └── rag-cli.ts              # CLIインターフェース
└── doc/                    # ドキュメント
```

## MCPツール仕様

### ツール一覧

| ツール名 | 説明 |
|---------|------|
| `add_document` | ファイルからインデックス追加（upsert: 同名ソースは自動差し替え） |
| `add_text` | テキストを直接インデックス追加 |
| `add_directory` | ディレクトリ一括インデックス（upsert対応） |
| `search` | トリプルハイブリッド検索（ベクトル + BM25 + SoftMatchaソフトパターンマッチ） |
| `list_sources` | インデックス済みソース一覧 |
| `remove_source` | ソース削除 |
| `check_updates` | ファイル更新・削除の検出（レポートのみ、実行しない） |
| `sync_updates` | check_updatesで検出された変更をインデックスに反映 |
| `build_softmatcha_index` | SoftMatcha 2のソフトパターンマッチ用インデックスを構築/再構築 |

### リソース

| URI | 説明 |
|-----|------|
| `rag://status` | インデックス状態 |
| `rag://config` | 設定情報（インデックス対象ディレクトリ等） |
| `rag://softmatcha-status` | SoftMatchaソフトパターンマッチの状態 |

### インデックス更新の仕組み

#### Upsert（追加時の自動差し替え）

`add_document` / `add_directory` で同じソース名のファイルを再登録すると、古いインデックスを自動削除してから新しいデータを登録する。手動で `remove_source` する必要がない。

#### バックグラウンド自動更新（検索時トリガー）

検索実行時に1時間に1回、バックグラウンドで以下を自動実行する（検索はブロックしない）。

1. **ruri+BM25 差分更新** — ファイルのmtimeをDBと比較し、変更・削除されたファイルを検出して再インデックス/除去
2. **SoftMatcha 2 再構築** — ruri+BM25に変更があった場合、または前回構築から24時間以上経過した場合に再構築

#### 手動更新（check_updates / sync_updates）

即時更新が必要な場合は手動で実行する。

1. `check_updates` — 変更されたファイル・削除されたファイルを検出してレポート
2. `sync_updates` — 実際にインデックスを更新（更新ファイルは再インデックス、削除ファイルはインデックスから除去）
3. `build_softmatcha_index` — SoftMatcha 2のインデックスを再構築

## Web UI機能

### チャット（tool use方式）

Gemini 2.5 Flashが以下のツールを使い分けて回答を生成する。

| ツール | 用途 |
|--------|------|
| searchDocuments | ナレッジベースのセマンティック検索（クエリ最適化内蔵） |
| viewDocument | ファイル全文表示 |
| findDocument | ファイル名の部分一致検索 |
| listDocuments | 登録済みソース一覧 |
| summarizeDocument | ファイル要約 |
| compareDocuments | 2ファイルの比較 |

### ソースリンク

回答中のファイルパスがクリック可能なリンクになる。

| 設定 | 動作 |
|------|------|
| モーダル表示 | ドキュメントビューアでファイル内容を表示（API消費なし） |
| VSCodeで開く | WSLのIPCソケット経由でVSCodeに開く。VSCode未起動時はモーダルにフォールバック |

## DB設計

| テーブル | 用途 |
|---------|------|
| `chunks` | チャンクテキスト・ソース名・メタデータ |
| `vec_chunks` | ベクトルインデックス（sqlite-vec, float[256]） |
| `fts_chunks` | FTS5全文検索インデックス（content-sync方式） |
| `source_files` | ファイルパス・更新日時の記録（起動時チェック用） |

### source_filesスキーマ

```sql
CREATE TABLE source_files (
  source TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  indexed_at TEXT DEFAULT (datetime('now'))
);
```

## 環境変数

| 変数名 | 必須 | デフォルト | 説明 |
|--------|------|----------|------|
| `RAG_DB_PATH` | いいえ | `~/.local/share/rag-mcp-ruri-30m/rag.db` | DBファイルパス |
| `RAG_CONFIG_PATH` | いいえ | `~/.local/share/rag-mcp-ruri-30m/config.json` | 設定ファイルパス |
| `GEMINI_API_KEY` | はい（Web UIのみ） | — | Gemini APIキー（チャット回答生成用） |

## 依存パッケージ

| パッケージ | 用途 |
|-----------|------|
| `@huggingface/transformers` | ruri-v3-30m ONNXモデルのローカル推論 |
| `@modelcontextprotocol/sdk` | MCPサーバーフレームワーク |
| `better-sqlite3` | SQLiteデータベース |
| `sqlite-vec` | ベクトル検索拡張 |
| `pdf-parse` | PDF読み込み |
| `zod` | バリデーション |
| `ai` / `@ai-sdk/google` | Web UIのチャットAPI（Gemini連携） |
| `next` | Web UIフレームワーク |

### SoftMatcha 2（Python側）

| パッケージ | 用途 |
|-----------|------|
| `softmatcha` | ソフトパターンマッチエンジン本体（Python + Rust） |
| `fasttext` | 日本語単語エンベディング（fasttext-ja-vectors） |
| `mecab-python3` | 日本語トークナイザー |
| `numba` | JITコンパイルによる高速化 |
| `numpy` | 数値計算 |

### SoftMatcha 2 データファイル

| ファイル | 場所 | 説明 |
|---------|------|------|
| `corpus.txt` | `~/.local/share/rag-mcp-ruri-30m/softmatcha/` | 全チャンク結合テキスト |
| `corpus_map.json` | 同上 | チャンクID↔バイトオフセットのマッピング |
| `index/` | 同上 | SoftMatcha 2インデックスファイル群 |
