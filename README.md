<div align="center">

# クロラグ（kuro-rag-ruri-30m）

日本語特化の軽量RAGシステム。
ベクトル検索 + BM25 + SoftMatcha 2 の**トリプルハイブリッド検索**で、ローカル完結のセマンティック検索を実現。

[![TypeScript][TypeScript-shield]][TypeScript-url]
[![Python][Python-shield]][Python-url]
[![Next.js][Next-shield]][Next-url]
[![SQLite][SQLite-shield]][SQLite-url]
[![License: MIT][license-shield]][license-url]

</div>

---

## 目次

- [このプロジェクトについて](#このプロジェクトについて)
- [セットアップ](#セットアップ)
- [使い方](#使い方)
- [対応ファイル形式](#対応ファイル形式)
- [データベース](#データベース)
- [環境変数](#環境変数)
- [技術スタック](#技術スタック)
- [ライセンス](#ライセンス)

---

## このプロジェクトについて

ローカルのドキュメント（Markdown、テキスト、PDF、CSV、ソースコード、画像、動画、音声）をインデックスし、日本語に特化したセマンティック検索を提供するRAGシステムです。

- 外部APIに依存せずにエンベディング生成（ONNX Runtime CPU推論）
- 3つのインターフェース: **MCP サーバー** / **Web UI** / **CLI**
- Claude Code（MCP）から直接ナレッジベースを検索可能

```
ruri（ベクトル検索）→ 意味が近いものを発見
BM25（キーワード検索）→ 単語一致で発見
SoftMatcha 2（ソフトパターンマッチ）→ フレーズの類似パターンを発見
    ↓ RRF統合（k=60）→ 上位結果を返却
```

### 主な特徴

| 特徴 | 説明 |
|------|------|
| 完全ローカル動作 | エンベディング生成にAPIキー不要 |
| 日本語特化 | ruri-v3-30m（37Mパラメータ、256次元） |
| トリプルハイブリッド検索 | ベクトル + BM25 + SoftMatcha 2 → RRF統合 |
| デュアルエンジン | ローカル ruri（デフォルト）+ Gemini Embedding 2（マルチモーダル対応） |
| 軽量ストレージ | SQLite + sqlite-vec（約2,400ファイルで約75MB） |
| インデックス自動管理 | ファイルの更新・削除を検出し差分同期 |
| Google Drive対応 | gws CLI経由で一括DL・差分同期 |

### デュアルエンジン

| エンジン | モデル | 次元 | 特徴 |
|---------|--------|------|------|
| `ruri`（デフォルト） | ruri-v3-30m（ONNX） | 256 | ローカル完結、APIキー不要、トリプルハイブリッド検索 |
| `gemini`（実験的） | Gemini Embedding 2 | 768 | マルチモーダル対応（画像・動画・音声）、高次元、API必要 ※隠し機能 |

### 検索デモ — 「git rebase」で検索

```
[1位] git-setup-prompt-improved.md   Vec:5位 BM25:7位 SM:2位 → RRF合算で1位に浮上
[2位] git-setup-prompt-improved.md   Vec:1位 BM25:1位
[3位] claude-code-update-report.md   BM25:2位 SM:1位
```

BM25がコマンド名の完全一致、SoftMatchaが「rebase」パターンの出現を検出。3方式のRRF合算で、単独では埋もれていた結果を上位に引き上げる。

<p align="right">(<a href="#目次">トップに戻る</a>)</p>

---

## セットアップ

### Claude Code スキルでセットアップ（推奨）

同梱の **rag-search スキル**を使えば、インデックス作成から検索まですべて対話的にガイドされます。cloneしてClaude Codeを起動すればスキルは自動認識されます。

**「ラグ」または「RAG」を含む発話で自動発動:**

```
「ラグでインデックスを作りたい」   → セットアップを案内
「ラグでReactの設定方法を検索して」 → クエリ最適化 → 検索
```

| フェーズ | 内容 |
|---------|------|
| **セットアップ** | インデックス存在チェック → ディレクトリのヒアリング → CLIでバッチ構築 → SoftMatcha 2構築 → Google Drive対応 |
| **検索** | ひらがな→カタカナ変換、口語→キーワード抽出 → MCP `search` → 結果表示 |
| **更新** | 検索時に1時間に1回バックグラウンドで差分更新を自動実行 |

### 手動セットアップ

**前提条件:** Node.js 20+ / Python 3.10+ / [uv](https://docs.astral.sh/uv/) / MeCab

```bash
git clone https://github.com/takamiya1021/app057-rag-ruri-30m.git
cd app057-rag-ruri-30m
npm install

# SoftMatcha 2
sudo apt install mecab libmecab-dev mecab-ipadic-utf8
cd softmatcha && uv sync
```

> 初回実行時にruri-v3-30m ONNX（約150MB）、fastText日本語モデルが自動DLされます。

<p align="right">(<a href="#目次">トップに戻る</a>)</p>

---

## 使い方

### 1. MCP サーバー（推奨）

```bash
claude mcp add kuro-rag-ruri-30m npx tsx /path/to/app057-rag-ruri-30m/mcp/index.ts
```

<details>
<summary>~/.claude.json に手動追加する場合</summary>

```json
{
  "mcpServers": {
    "kuro-rag-ruri-30m": {
      "command": "npx",
      "args": ["tsx", "/path/to/app057-rag-ruri-30m/mcp/index.ts"]
    }
  }
}
```
</details>

#### MCPツール一覧

| ツール | 説明 |
|--------|------|
| `search` | トリプルハイブリッド検索（`engine`: `ruri`/`gemini`） |
| `add_document` | ファイルをインデックスに追加（upsert） |
| `add_directory` | ディレクトリを再帰的にインデックス |
| `add_text` | テキストを直接追加 |
| `list_sources` | ソース一覧 |
| `remove_source` | ソース削除 |
| `check_updates` | 更新・削除の検出（レポートのみ） |
| `sync_updates` | 変更をインデックスに反映 |
| `build_softmatcha_index` | SoftMatcha 2インデックス構築/再構築 |
| `reset_database` | DB完全削除（`confirm: "YES"` 必須） |

#### MCPリソース

| URI | 説明 |
|-----|------|
| `rag://status` | インデックス状態（ソース数・チャンク数・DBサイズ） |
| `rag://config` | 設定情報（インデックス対象ディレクトリ） |
| `rag://softmatcha-status` | SoftMatcha 2の状態 |

#### MCPの使い方

| 方法 | 使い方 | 特徴 |
|------|--------|------|
| **MCP直接** | 「ドキュメントを検索して」「~/vaults をインデックスに追加して」 | Claude Codeがツールを直接呼び出す |
| **スキル経由** | 「**ラグ**で〇〇を検索して」「**RAG**でインデックス作りたい」 | クエリ最適化（ひらがな→カタカナ等）やインデックス作成のガイドが自動で付く |

---

### 2. CLI

インデックス作成・更新はCLIで行い、MCPは検索専用として使う運用を推奨します。

**検索:**

| コマンド | 説明 |
|----------|------|
| `search <クエリ> [件数]` | トリプルハイブリッド検索（デフォルト5件、`--engine gemini` 可） |
| `ask <質問>` | RAG検索 + Gemini回答（GEMINI_API_KEY必要） |

**インデックス管理:**

| コマンド | 説明 |
|----------|------|
| `add <ファイル>` | 1件追加 |
| `add-dir <ディレクトリ> [バッチ]` | 再帰的に追加（デフォルトバッチ50） |
| `build-softmatcha` | SoftMatcha 2インデックス構築 |
| `check-updates` / `sync-updates` | 差分検出 / 反映 |
| `list` / `remove <ソース>` / `status` | 一覧 / 削除 / 状態表示 |
| `add-dir-gemini <ディレクトリ>` | Gemini Embedding 2でインデックス構築 |
| `check-gemini` / `sync-gemini` | Geminiインデックスの差分検出 / 反映 |
| `compare <クエリ>` | ruri vs Gemini の結果比較 |

```bash
npx tsx cli/rag-cli.ts add-dir ~/vaults 100
npx tsx cli/rag-cli.ts build-softmatcha
npx tsx cli/rag-cli.ts search "API設計"
```

**Google Drive CLI** (`cli/gdrive-sync.ts`):

| コマンド | 説明 |
|----------|------|
| `bulk [limit]` | 全ファイル一括DL + インデックス作成 |
| `sync` | 変更検出 → DL → インデックス更新 |
| `init` / `check` | changeトークン取得 / 変更レポート |

> テキスト系はruriエンジン、メディア/PDFはGemini Embedding 2で自動振り分けされます。
> [gws CLI](https://github.com/googleworkspace/cli) のインストールと認証が必要です。

---

### 3. Web UI

```bash
npm run dev   # http://localhost:3057
```

1. 右上の設定アイコンからGemini APIキーを入力
2. チャット欄に質問を入力 → RAG検索 + Gemini回答が自動実行

チャットAIが使える6ツール: `searchDocuments`（検索）/ `viewDocument`（全文取得）/ `findDocument`（ファイル名検索）/ `listDocuments`（一覧）/ `summarizeDocument`（要約）/ `compareDocuments`（比較）

<p align="right">(<a href="#目次">トップに戻る</a>)</p>

---

## 対応ファイル形式

### テキスト系（ruriエンジン）

| 形式 | 拡張子 | チャンク分割 |
|------|--------|-------------|
| Markdown | `.md` | 見出し境界 → 段落再分割 |
| CSV | `.csv` | 行グループ（ヘッダ自動付与） |
| ソースコード | `.ts` `.js` `.py` `.go` `.rs` `.java` `.c` `.cpp` `.rb` `.sh` 等 | 関数・クラス定義境界 |
| テキスト/PDF/JSON | `.txt` `.pdf` `.json` | 段落 → 句点 → 固定長（500文字） |

### マルチモーダル（Geminiエンジン）

| 形式 | 拡張子 | チャンク分割 |
|------|--------|-------------|
| 画像 | `.png` `.jpg` `.webp` `.bmp` | 1画像 = 1チャンク |
| 動画 | `.mp4` `.mov` `.avi` `.webm` 等 | 60秒/10秒オーバーラップ（ffmpeg） |
| 音声 | `.mp3` `.wav` | 40秒/5秒オーバーラップ（ffmpeg） |
| PDF | `.pdf` | 3ページ/1ページオーバーラップ（ghostscript） |

<p align="right">(<a href="#目次">トップに戻る</a>)</p>

---

## データベース

データディレクトリ: `~/.local/share/rag-mcp-ruri-30m/`

```
├── rag.db                            # ruri用（ベクトル256次元 + BM25）
├── rag-gemini-embedding-2-preview.db # Gemini用（768次元）
├── config.json                       # 設定（インデックス対象ディレクトリ、GDrive changeトークン）
└── softmatcha/                       # SoftMatcha 2インデックス
```

検索時に1時間に1回、バックグラウンドでローカルファイル差分更新・Google Drive差分同期が自動実行されます。

<p align="right">(<a href="#目次">トップに戻る</a>)</p>

---

## 環境変数

| 変数名 | 必須 | 説明 |
|--------|------|------|
| `GEMINI_API_KEY` | 条件付き | Web UIチャット、Geminiエンジン、マルチモーダルに必要 |
| `RAG_DB_PATH` | 任意 | ruri用DBパス（デフォルト: `~/.local/share/rag-mcp-ruri-30m/rag.db`） |
| `RAG_CONFIG_PATH` | 任意 | 設定ファイルパス |

> ローカルのruri検索のみ使う場合、環境変数は一切不要です。

<p align="right">(<a href="#目次">トップに戻る</a>)</p>

---

## 技術スタック

| カテゴリ | 技術 |
|----------|------|
| エンベディング | [ruri-v3-30m](https://huggingface.co/cl-nagoya/ruri-v3-30m)（ONNX、256次元） / [Gemini Embedding 2](https://ai.google.dev/)（768次元） |
| ソフトパターンマッチ | [SoftMatcha 2](https://github.com/softmatcha/softmatcha2)（fastText + MeCab） |
| 推論 | [ONNX Runtime](https://onnxruntime.ai/) via [@huggingface/transformers](https://github.com/huggingface/transformers.js) |
| DB | SQLite + [sqlite-vec](https://github.com/asg017/sqlite-vec)（KNN）+ FTS5（BM25） |
| MCP | [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) |
| Web UI | Next.js 16 / React 19 / Tailwind CSS 4 |
| LLM | [Vercel AI SDK](https://sdk.vercel.ai/) + Google Gemini |

<p align="right">(<a href="#目次">トップに戻る</a>)</p>

---

## ライセンス

MIT License - [LICENSE](LICENSE)

## コンタクト

- GitHub: [@takamiya1021](https://github.com/takamiya1021)
- プロジェクト: [app057-rag-ruri-30m](https://github.com/takamiya1021/app057-rag-ruri-30m)

<!-- MARKDOWN LINKS & IMAGES -->
[TypeScript-shield]: https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white
[TypeScript-url]: https://www.typescriptlang.org/
[Python-shield]: https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white
[Python-url]: https://www.python.org/
[Next-shield]: https://img.shields.io/badge/Next.js-000000?style=for-the-badge&logo=nextdotjs&logoColor=white
[Next-url]: https://nextjs.org/
[SQLite-shield]: https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white
[SQLite-url]: https://www.sqlite.org/
[license-shield]: https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge
[license-url]: https://opensource.org/licenses/MIT
