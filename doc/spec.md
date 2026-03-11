# APP057: クロラグ Ruri版（ruri-v3-30m） — 仕様書

## 概要

日本語特化エンベディングモデル **ruri-v3-30m**（名古屋大学）を使用したセマンティック検索システム。
MCPサーバー + Web UIの2つのインターフェースでナレッジベースを検索・質問できる。

APP056（ruri-v3-130m版）の後継。軽量モデル（37Mパラメータ）に切り替え、起動速度とリソース効率を改善。

### v2.2.0: Gemini Embedding 2 マルチモーダル対応

**テキスト検索に加え、画像・動画・音声・PDFをネイティブにベクトル検索できるようになった。**

- Google Drive上の全メディアファイルをDL → Gemini Embedding 2でベクトル化 → 同じDBに保存
- テキストクエリで画像・動画・音声・PDFをクロスモーダル検索可能
- テキスト系ファイルは従来通りruri-v3-30mでローカル処理（無料・高速）
- メディア/PDFファイルのみGemini Embedding 2 API使用（有料）

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

## エンベディングモデル V2: Gemini Embedding 2（マルチモーダル）

メディアファイル（画像・動画・音声）とPDFのベクトル化に使用。テキスト・画像・動画・音声・PDFを同一ベクトル空間に埋め込む、Googleのマルチモーダルエンベディングモデル。

| 項目 | 値 |
|------|-----|
| モデルID | gemini-embedding-2-preview |
| 開発元 | Google DeepMind |
| 出力次元 | 768（128〜3072で可変、デフォルト768） |
| 対応モダリティ | テキスト、画像、動画、音声、PDF |
| API | REST（generativelanguage.googleapis.com） |
| 認証 | URLパラメータ方式（`?key=API_KEY`） |
| コスト | 有料（メディアファイルのみ使用） |

### 使い分け

| 対象 | 使用モデル | 理由 |
|------|-----------|------|
| テキスト系（.txt, .md, .csv, .json, コード） | ruri-v3-30m（ローカル） | 無料・高速・日本語特化 |
| 画像・動画・音声・PDF | Gemini Embedding 2（API） | マルチモーダル対応が必要 |

### Gemini Embedding 2 の入力制約

| モダリティ | 制限 |
|-----------|------|
| テキスト | 8,192トークン |
| 画像 | 最大6枚/リクエスト（PNG, JPEG, WebP, BMP） |
| 動画 | 最大128秒（MP4, MPEG, MOV, AVI, FLV, WebM, WMV, 3GP） |
| 音声 | 最大80秒（MP3, WAV） |
| PDF | 最大6ページ |

### 対応ファイル形式（Google Drive DL対象）

```
画像: .png, .jpg, .jpeg, .webp, .bmp
動画: .mp4, .mpeg, .mpg, .mov, .avi, .flv, .webm, .wmv, .3gp
音声: .mp3, .wav
PDF:  .pdf
テキスト: .txt, .md, .csv, .json（+ Google Docs/Sheets/Slidesはexport変換）
```

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

#### 検索時のトークン制限

SoftMatcha 2は12トークン（MeCab分割単位）以下のフレーズを対象とする。検索クエリが12トークンを超える場合は、先頭12トークンに切り詰めて検索する（13トークン以降は切り捨て）。

- 短いクエリ（12トークン以下）: そのまま渡す
- 長いクエリ（13トークン以上）: 先頭12トークンで切り詰めて検索

長い文章の意味検索はベクトル検索（ruri）、キーワード一致はBM25が担当するため、SoftMatchaは短いフレーズの類似パターン検出に集中する設計。

## アーキテクチャ

### システム構成

```
[Web UI] ← Next.js App Router
    ├── チャット画面（tool use方式でGemini 2.5 Flashが検索ツールを使い分け）
    ├── ドキュメントビューア（モーダル or VSCode連携）
    └── 設定画面（APIキー、DBパス、リンク表示方法）

[MCP Server] ← Claude Code等のMCPクライアントから利用
    ├── 10ツール（検索・追加・削除・更新チェック・同期・SoftMatchaインデックス構築・DBリセット）
    └── stdio接続

[SoftMatcha 2 ブリッジ] ← Python常駐プロセス（stdin/stdout JSON通信）
    ├── fastText日本語モデル + MeCabトークナイザー
    ├── サフィックス配列ベースのソフトパターンマッチ（soft pattern matching）
    └── コーパスファイル + インデックス管理

[共通RAGエンジン] lib/rag/
    ├── embedding.ts          — ruri-v3-30m ONNX推論（テキスト用）
    ├── geminiEmbedding.ts    — Gemini Embedding 2 API（マルチモーダル用）
    ├── multimodal.ts         — メディアファイルのチャンキング（画像/動画/音声/PDF）
    ├── vectorStore.ts        — SQLite + sqlite-vec + FTS5 + RRF統合
    ├── softmatcha.ts         — SoftMatcha 2クライアント（ブリッジ通信）
    ├── chunker.ts            — データ型別チャンク分割（Markdown/CSV/コード/テキスト）
    ├── documentLoader.ts     — ファイル読み込み（txt/md/pdf/json/csv/コード）
    ├── gdriveSync.ts         — Google Drive差分同期（マルチモーダル対応）
    └── types.ts              — 型定義
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
│   ├── embedding.ts           # ruri-v3-30m ONNX推論（テキスト用）
│   ├── geminiEmbedding.ts     # Gemini Embedding 2 API（マルチモーダル用）
│   ├── multimodal.ts          # メディアチャンキング（画像/動画/音声/PDF）
│   ├── vectorStore.ts         # SQLite + sqlite-vec + FTS5 + RRF統合
│   ├── chunker.ts             # テキストチャンク分割
│   ├── documentLoader.ts      # ファイル読み込み
│   ├── gdriveSync.ts          # Google Drive差分同期（マルチモーダル対応）
│   ├── softmatcha.ts          # SoftMatcha 2クライアント
│   └── types.ts               # 型定義
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
| `reset_database` | データベース完全リセット（データディレクトリごと削除。confirm: "YES" 必須） |

### リソース

| URI | 説明 |
|-----|------|
| `rag://status` | インデックス状態 |
| `rag://config` | 設定情報（インデックス対象ディレクトリ等） |
| `rag://softmatcha-status` | SoftMatchaソフトパターンマッチの状態 |

### インデックス作成の仕組み

ファイルの種類によって処理パイプラインが分岐する。

#### テキスト系ファイル（ruri-v3-30m）

1. **ファイル読み込み** — 対応形式（.txt, .md, .pdf, .json, .csv, コード）のファイルからテキストを抽出
2. **チャンク分割** — データ型に応じた分割（下記参照）。短すぎるチャンクは自動結合される
3. **エンベディング生成** — ruri-v3-30mで各チャンクの256次元ベクトルを生成（プレフィックス: `"検索文書: "`）
4. **DB保存** — チャンクテキスト・ベクトル・FTS5インデックスをSQLiteに一括保存

#### メディア/PDFファイル（Gemini Embedding 2）

1. **ファイル読み込み** — バイナリファイルをそのまま読み込み
2. **チャンク分割** — モダリティに応じた分割（下記参照）。画像は分割なし
3. **エンベディング生成** — Gemini Embedding 2 APIで各チャンクの768次元ベクトルを生成（1件ずつ順次）
4. **DB保存** — ラベルテキスト（例: `[画像] photo.png`）・ベクトルをSQLiteに保存

同じソース名のファイルを再登録すると、古いインデックスを自動削除してから新しいデータを登録する（upsert）。

### チャンク分割の詳細

#### テキスト系: データ型別の分割方式（`chunkDocument`）

| format | 分割単位 | 対応拡張子 |
|--------|----------|-----------|
| md | 見出し（`#`）→ 段落 | .md |
| csv | 行グループ（各チャンクにヘッダ行付与） | .csv |
| code | 関数・クラス定義の境界 | .ts, .tsx, .js, .jsx, .py, .rs, .go, .java, .c, .cpp, .h, .rb, .sh |
| txt/pdf/json | 段落 → 句点 → 固定長 | .txt, .pdf, .json |

共通原則: **意味のある境界で切る → 短すぎたら結合 → 長すぎたら再分割**

コード分割で関数・クラス境界が見つからない場合はテキスト分割（段落ベース）にフォールバックする。

#### マルチモーダル: モダリティ別の分割方式（`chunkMediaFile`）

| モダリティ | チャンクサイズ | オーバーラップ | 分割ツール |
|-----------|-------------|--------------|-----------|
| テキスト | 500文字 | 200文字 | 段落・句点ベース |
| PDF | 3ページ | 1ページ | ghostscript |
| 動画 | 60秒 | 10秒 | ffmpeg |
| 音声 | 40秒 | 5秒 | ffmpeg |
| 画像 | 分割なし（1枚=1チャンク） | — | — |

- **動画**: 60秒以内ならそのまま、超えたらffmpegで時間分割（公式推奨: 重複セグメント方式）
- **音声**: 40秒以内ならそのまま、超えたら同様に時間分割
- **PDF**: 3ページ以内ならそのままGemini Embedding 2に渡す、超えたらghostscriptでページ分割
- **画像**: 常に1枚まるごと1チャンク（分割不可）

#### テキスト系チャンク品質の共通処理

インデックス登録時に以下の処理が上から順に適用される。

| 処理 | 値 | 意味 | ローカル | GDrive |
|------|-----|------|:---:|:---:|
| ファイルスキップ | 50文字未満 | 中身がないファイルをインデックスに入れない | ✅ | ✅ |
| セクション結合 | 200文字未満 | 見出し分割後、短いセクションを次にくっつける | ✅ | ✅ |
| チャンク分割 | 500文字超 | 長いセクションを段落ベースで分割する | ✅ | ✅ |
| 末尾断片結合 | 250文字未満 | 分割後、最後の短い断片を前にくっつける | ✅ | ✅ |
| オーバーラップ | 200文字 | 前チャンクの末尾を次チャンクの先頭に重複させる | ✅ | ✅ |

### インデックス更新の仕組み

#### 対応ソース

| ソース | CLI | 差分同期 | マルチモーダル対応 |
|--------|-----|---------|:---:|
| ローカルファイル | `cli/rag-cli.ts` | mtime比較 | ✅ |
| Google Drive | `cli/gdrive-sync.ts` | changeトークン | ✅ |

#### Google Drive DL対象（v2.2.0で大幅拡張）

| カテゴリ | MIMEタイプ | DL方式 | エンベディング |
|---------|-----------|--------|-------------|
| Google Docs | application/vnd.google-apps.document | export → .txt | ruri-v3-30m |
| Google Sheets | application/vnd.google-apps.spreadsheet | export → .csv | ruri-v3-30m |
| Google Slides | application/vnd.google-apps.presentation | export → .txt | ruri-v3-30m |
| テキスト系 | text/plain, text/markdown, text/csv, application/json | そのままDL | ruri-v3-30m |
| PDF | application/pdf | そのままDL | Gemini Embedding 2 |
| 画像 | image/png, image/jpeg, image/webp, image/bmp | そのままDL | Gemini Embedding 2 |
| 動画 | video/mp4, video/mpeg, video/quicktime 等 | そのままDL | Gemini Embedding 2 |
| 音声 | audio/mpeg, audio/wav | そのままDL | Gemini Embedding 2 |

ファイルサイズ上限: 100MB（Gemini APIのインラインデータ上限に合わせる）

#### バックグラウンド自動更新（検索時トリガー）

検索実行時に1時間に1回、バックグラウンドで以下を自動実行する（検索はブロックしない）。

1. **ruri+BM25 差分更新** — ファイルのmtimeをDBと比較し、変更・削除されたファイルを検出して再インデックス/除去
2. **SoftMatcha 2 再構築** — ruri+BM25に変更があった場合、または前回構築から24時間以上経過した場合に再構築

#### 手動更新

即時更新が必要な場合は `check_updates` / `sync_updates` / `build_softmatcha_index` のMCPツールで実行できる。

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
| `chunks` | チャンクテキスト・ソース名・メタデータ（マルチモーダルチャンクはラベルを保存、metadata: `{"type":"multimodal"}` ） |
| `vec_chunks` | ベクトルインデックス（sqlite-vec, float[256] for ruri / float[768] for Gemini Embedding 2） |
| `fts_chunks` | FTS5全文検索インデックス（content-sync方式） |
| `source_files` | ファイルパス・更新日時の記録（起動時チェック用、GDrive経由は `gdrive://fileId` 形式） |

**注意**: ruri-v3-30m（256次元）とGemini Embedding 2（768次元）はベクトル次元が異なるため、同一のvec_chunksテーブルで混在させる場合はDB初期化時の次元設定に注意が必要。

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
| `GEMINI_API_KEY` | はい | — | Gemini APIキー（Web UIチャット回答 + マルチモーダルエンベディング） |

**注意**: `GEMINI_API_KEY` はv2.2.0からマルチモーダルファイルのインデックス作成にも必要。未設定時はメディア/PDFファイルがスキップされる（テキスト系はruri-v3-30mで処理されるため影響なし）。

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

### マルチモーダル処理（システム要件）

| ツール | 用途 | インストール |
|--------|------|------------|
| `ffmpeg` | 動画・音声のチャンク分割 | `apt install ffmpeg` |
| `ffprobe` | 動画・音声の長さ取得 | ffmpegに同梱 |
| `gs` (ghostscript) | PDFのページ分割 | `apt install ghostscript` |

### SoftMatcha 2 データファイル

| ファイル | 場所 | 説明 |
|---------|------|------|
| `corpus.txt` | `~/.local/share/rag-mcp-ruri-30m/softmatcha/` | 全チャンク結合テキスト |
| `corpus_map.json` | 同上 | チャンクID↔バイトオフセットのマッピング |
| `index/` | 同上 | SoftMatcha 2インデックスファイル群 |
