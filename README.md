<div align="center">

# クロラグ（kuro-rag-ruri-30m）

日本語特化の軽量RAGシステム。
ベクトル検索 + BM25 + SoftMatcha 2 の**トリプルハイブリッド検索**で、ローカル完結のセマンティック検索を実現します。

[![TypeScript][TypeScript-shield]][TypeScript-url]
[![Python][Python-shield]][Python-url]
[![Next.js][Next-shield]][Next-url]
[![SQLite][SQLite-shield]][SQLite-url]
[![License: MIT][license-shield]][license-url]

[使い方](#-使い方) | [セットアップ](#-セットアップ) | [MCPツール一覧](#mcpツール一覧) | [技術スタック](#-技術スタック)

</div>

---

## 目次

- [このプロジェクトについて](#-このプロジェクトについて)
- [特徴](#-特徴)
- [アーキテクチャ](#-アーキテクチャ)
- [セットアップ](#-セットアップ)
- [使い方](#-使い方)
  - [1. MCP サーバー（推奨）](#1-mcp-サーバーとして使う推奨)
  - [2. CLI](#2-cli-で使う)
  - [3. Web UI](#3-web-ui-で使う)
- [対応ファイル形式](#-対応ファイル形式)
- [データベース](#-データベース)
  - [Google Driveのインデックス作成](#google-driveのインデックス作成)
- [技術スタック](#-技術スタック)
- [ライセンス](#-ライセンス)
- [コンタクト](#-コンタクト)

---

## ■ このプロジェクトについて

ローカルのドキュメント（Markdown、テキスト、PDF、JSON）をインデックスし、日本語に特化したセマンティック検索を提供するRAGシステムです。

**なぜこれが必要か？**

- 外部APIに依存せずにエンベディング生成したい
- 日本語ドキュメントを高精度で検索したい
- Claude Code（MCP）から直接ナレッジベースを検索したい

3種類の検索エンジンを組み合わせた**トリプルハイブリッド検索**で、単一の検索方式では取りこぼしていた結果を補完し合います。

```
ruri（ベクトル検索）    → 「意味が近い」を見つける
BM25（キーワード検索）  → 「単語が一致する」を見つける
SoftMatcha 2（ソフトパターンマッチ） → 「フレーズの類似パターン」を見つける
```

### Built With

| カテゴリ | 技術 |
|----------|------|
| エンベディング | [ruri-v3-30m](https://huggingface.co/cl-nagoya/ruri-v3-30m)（[ONNX版](https://huggingface.co/sirasagi62/ruri-v3-30m-ONNX)、名古屋大学） |
| ソフトパターンマッチ | [SoftMatcha 2](https://github.com/softmatcha/softmatcha2)（東京大学・京都大学・Sakana AI 他） |
| 推論 | [@huggingface/transformers](https://github.com/huggingface/transformers.js)（ONNX Runtime） |
| ベクトル検索 | [sqlite-vec](https://github.com/asg017/sqlite-vec) + SQLite FTS5 |
| MCPフレームワーク | [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) |
| Web UI | Next.js 16 + React 19 + Tailwind CSS 4 |
| LLM連携 | Vercel AI SDK + Google Gemini |

<p align="right">(<a href="#目次">トップに戻る</a>)</p>

---

## ■ 特徴

- **完全ローカル動作** — エンベディング生成にAPIキー不要（ONNX Runtime で CPU推論）
- **日本語特化** — ruri-v3-30m（37Mパラメータ、256次元）による高精度な日本語ベクトル表現
- **トリプルハイブリッド検索** — ベクトル検索 + BM25 + SoftMatcha 2 を RRF（k=60）で統合
- **3つのインターフェース** — MCP サーバー / Web UI / CLI
- **軽量ストレージ** — SQLite + sqlite-vec（外部DBサーバー不要。参考: Vault約1,200ファイル + Google Drive約1,200ファイルで約75MB）
- **インデックス自動管理** — ファイルの更新・削除を検出し、差分同期が可能
- **Google Drive対応** — gws CLI経由でGoogle Driveのファイルをインデックス。差分同期も自動実行（gws CLIコマンドの直接実行で完結）

### トリプルハイブリッド検索とは

| 検索方式 | 技術 | 得意なケース |
|---------|------|------------|
| ベクトル検索 | ruri-v3-30m + sqlite-vec | 意味検索、言い換え表現、言語横断 |
| BM25検索 | SQLite FTS5 | 固有名詞、コマンド名、完全一致 |
| ソフトパターンマッチ | SoftMatcha 2（fastText + MeCab） | フレーズの類似パターン検出（置換・挿入・削除を許容） |

3つの検索結果を **RRF（Reciprocal Rank Fusion, k=60）** で統合します。複数の方式にヒットした結果ほどスコアが高くなり、上位に浮上します。

#### 検索デモ

**例1: 意味で探す — 「AIの記憶を永続化する方法」**

```
[1位] メモリーMCP.md                     Vec:1位
  → 「メモリーMCPは、AIアシスタントに"記憶"機能を追加するサーバーです…」

[2位] obsidian-graphiti-serena-guide.md    Vec:2位
  → 「これは、AI自身の長期記憶を作る仕組みだ…」
```

「永続化」という単語がなくても、「記憶機能を追加」「長期記憶を作る」を意味的に見つけ出す。**ベクトル検索の得意パターン**。

**例2: コマンド名で探す — 「git rebase」**

```
[1位] git-setup-prompt-improved.md     Vec:5位  BM25:7位  SM:2位  → RRF合算で1位に浮上
[2位] git-setup-prompt-improved.md     Vec:1位  BM25:1位
[3位] claude-code-2.1.2-update-report.md  BM25:2位  SM:1位
```

コマンド名の完全一致は**BM25**、「rebase」パターンの出現は**SoftMatcha**が検出。3方式のスコアをRRFで合算し、単独では埋もれていた結果を上位に引き上げる。

**例3: 記憶システムの仕組みを探す**

```
[1位] smart-hub-v2-development-journey.md  BM25:1位  SM:1位
  → 「記憶システムの仕組み…MCPログを巧妙に活用…」

[2位] 記憶喪失AIに脳みそを実装してみた.md    Vec:1位
  → 「記憶システムの全体像…」
```

BM25+SoftMatchaが「記憶システム」のキーワード・パターンを検出、ベクトル検索が意味的に関連するドキュメントを補完。

> **Note**
> SoftMatcha 2は12トークン（MeCab分割単位）以下のフレーズが対象です。クエリが12トークンを超える場合は先頭12トークンに切り詰めて検索します。長い文章の検索はベクトル検索とBM25が担当します。

<p align="right">(<a href="#目次">トップに戻る</a>)</p>

---

## ■ アーキテクチャ

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Claude Code │  │   Web UI    │  │     CLI     │
│  (MCP Client)│  │  (Next.js)  │  │  (tsx)      │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       └────────┬────────┴────────┬────────┘
                │                 │
        ┌───────▼───────┐ ┌──────▼──────┐
        │  MCP Server   │ │  RAG Core   │
        │  (stdio)      │ │  (lib/rag/) │
        └───────┬───────┘ └──────┬──────┘
                │                │
         ┌──────▼────────────────▼──────┐
         │  ruri-v3-30m (ONNX)          │
         │  @huggingface/transformers   │
         └──────────────┬───────────────┘
                        │
           ┌────────────▼────────────┐
           │  SQLite + FTS5          │
           │  + sqlite-vec           │
           └────────────┬────────────┘
                        │
           ┌────────────▼────────────┐
           │  SoftMatcha 2 Bridge    │
           │  (Python常駐プロセス)     │
           │  fastText + MeCab       │
           └─────────────────────────┘
```

SoftMatcha 2はPython + Rustで実装されており、TypeScript側とはstdin/stdout JSON通信で連携します。

<p align="right">(<a href="#目次">トップに戻る</a>)</p>

---

## ■ セットアップ

### 前提条件

- Node.js 20+
- npm
- Python 3.10+（SoftMatcha 2用）
- [uv](https://docs.astral.sh/uv/)（Python パッケージ管理）
- MeCab（日本語トークナイザー）

### インストール

```bash
git clone https://github.com/takamiya1021/app057-rag-ruri-30m.git
cd app057-rag-ruri-30m
npm install
```

#### SoftMatcha 2のセットアップ

```bash
# MeCab（Ubuntu/WSL2）
sudo apt install mecab libmecab-dev mecab-ipadic-utf8

# Python依存パッケージ
cd softmatcha
uv sync
```

> **Note**
> 初回実行時にエンベディングモデル（ruri-v3-30m ONNX 約150MB、fastText日本語モデル）が自動ダウンロードされます。

<p align="right">(<a href="#目次">トップに戻る</a>)</p>

---

## ■ 使い方

### 1. MCP サーバーとして使う（推奨）

Claude Code の MCP設定に追加します。

**コマンドで追加（簡単）:**

```bash
claude mcp add kuro-rag-ruri-30m npx tsx /path/to/app057-rag-ruri-30m/mcp/index.ts
```

**または `~/.claude.json` に手動追加:**

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

#### スキルの設定

プロジェクトに同梱されている Claude Code スキル（`.claude/skills/rag-search/`）を使うと、以下が自動で行われます：

- **クエリ最適化**: ひらがな→カタカナ変換、口語→検索キーワード変換
- **インデックス存在チェック**: インデックスがない場合は作成を案内

このリポジトリをcloneした状態でClaude Codeを起動すれば、`.claude/skills/` 内のスキルは自動で認識されます。

#### 使い方の例

スキルは「**ラグ**」または「**RAG**」というキーワードを含む発話で自動発動します。

```
「ラグでReactの設定方法を検索して」
「RAGでエラーの対処法を調べて」
「ラグでインストール手順を探して」
```

スキルが発動すると、以下が自動で行われます：

1. インデックス存在チェック（なければ作成を案内）
2. 口語からの検索キーワード最適化
3. MCP `search` ツールの呼び出し（トリプルハイブリッド検索）
4. 結果の表示

> **Note**
> インデックスの更新（ruri+BM25差分更新・SoftMatcha再構築）は、検索時に1時間に1回バックグラウンドで自動実行されます。
> 手動で即時更新したい場合はCLIで `check-updates` → `sync-updates` → `build-softmatcha` の順に実行してください。

> **Note**
> 「検索して」だけではファイル検索と区別がつかないため、必ず「**ラグ**」を含めてください。
> スキルが発動しない場合は、スキル名を直接指定してください：「**/rag-search** で〇〇を検索して」

#### MCPツール一覧

| ツール | 説明 |
|--------|------|
| `search` | トリプルハイブリッド検索（ベクトル + BM25 + SoftMatcha 2） |
| `add_document` | ファイルをインデックスに追加 |
| `add_directory` | ディレクトリを再帰的にインデックス |
| `add_text` | テキストを直接インデックスに追加 |
| `list_sources` | インデックス済みソース一覧 |
| `remove_source` | ソースをインデックスから削除 |
| `check_updates` | ファイルの更新・削除を検出 |
| `sync_updates` | 検出された変更をインデックスに反映 |
| `build_softmatcha_index` | SoftMatcha 2のソフトパターンマッチ用インデックスを構築/再構築 |

---

### 2. CLI で使う

MCPツールの全機能はCLIでも利用できます。インデックス作成・更新はCLIで行い、MCPは検索専用として使う運用を推奨します。

#### CLIコマンド一覧

| コマンド | 説明 |
|----------|------|
| `ask <質問>` | RAG検索 + Gemini回答（※GEMINI_API_KEY必要） |
| `search <クエリ> [件数]` | トリプルハイブリッド検索（AI回答なし、デフォルト5件） |
| `add <ファイルパス>` | ファイルを1件インデックスに追加 |
| `add-dir <ディレクトリ> [バッチサイズ]` | ディレクトリを再帰的にインデックス（デフォルト: バッチ50） |
| `build-softmatcha` | SoftMatcha 2インデックスを構築/再構築 |
| `check-updates` | ファイルの更新・削除を検出（レポートのみ） |
| `sync-updates` | 検出された変更をインデックスに反映 |
| `list` | インデックス済みソース一覧を表示 |
| `remove <ソース名>` | ソースをインデックスから削除 |
| `status` | インデックスの状態を表示 |

```bash
# 実行例
npx tsx cli/rag-cli.ts add-dir ~/vaults 100
npx tsx cli/rag-cli.ts build-softmatcha
npx tsx cli/rag-cli.ts search "API設計"
npx tsx cli/rag-cli.ts ask "Reactの設定方法は？"
npx tsx cli/rag-cli.ts check-updates
npx tsx cli/rag-cli.ts sync-updates
```

#### Google Drive CLI

| コマンド | 説明 |
|----------|------|
| `bulk` | 初回一括DL + インデックス作成（全ファイル） |
| `init` | changeトークン取得・保存（bulkで自動設定済みなら不要） |
| `check` | 変更を検出してレポート（DLしない） |
| `sync` | 変更を検出 → DL → インデックス更新 |

```bash
npx tsx cli/gdrive-sync.ts bulk
npx tsx cli/gdrive-sync.ts sync
```

---

### 3. Web UI で使う

```bash
npm run dev
# http://localhost:3057 でアクセス
```

#### 初回セットアップ

1. ブラウザで `http://localhost:3057` を開く
2. 右上の設定アイコンをクリック
3. Gemini APIキーを入力して保存（チャット機能に必要）

#### 使い方の例

**チャットで検索（メイン機能）:**

チャット欄に質問を入力すると、RAG検索 → Gemini回答が自動で行われます。

```
「〇〇の使い方を教えて」
「△△のエラーの原因は？」
「□□の設定手順をまとめて」
```

**ドキュメント管理:**

- サイドバーからファイルを選んでインデックスに追加
- インデックス済みのソース一覧を表示・削除

**ソースリンク:**

回答に表示されるソースリンクをクリックすると、元ドキュメントを閲覧できます（モーダル表示 or VSCodeで開く）。

<p align="right">(<a href="#目次">トップに戻る</a>)</p>

---

## ■ 対応ファイル形式

データ型に応じて、意味のある単位で自動的にチャンクを分割します。

| 形式 | 拡張子 | チャンク分割方式 |
|------|--------|------------------|
| Markdown | `.md` | 見出し（h1〜h3）→ 段落ベースで再分割 |
| CSV | `.csv` | 行グループ（各チャンクにヘッダ行を自動付与） |
| ソースコード | `.ts`, `.js`, `.py`, `.go`, `.rs` 等 | 関数・クラス定義の境界で分割 |
| テキスト / PDF / JSON | `.txt`, `.pdf`, `.json` | 段落 → 句点 → 固定長（500文字） |

共通原則: **意味のある境界で切る → 短すぎたら結合 → 長すぎたら再分割**

---

## ■ データベース

デフォルトのデータディレクトリ: `~/.local/share/rag-mcp-ruri-30m/`（XDG Base Directory準拠、存在しなければ自動作成）

```
~/.local/share/rag-mcp-ruri-30m/
├── rag.db              # SQLite DB（ベクトル検索 + BM25、環境変数 RAG_DB_PATH で変更可）
├── config.json         # 設定ファイル（インデックス対象ディレクトリ等）
└── softmatcha/         # SoftMatcha 2 インデックス
    ├── corpus.txt      #   全チャンク結合テキスト
    ├── corpus_map.json #   チャンクID↔バイトオフセットのマッピング
    ├── index/          #   インデックスファイル群
    └── last_build      #   最終構築日時
```

### config.json

`add_directory` でディレクトリをインデックスすると、対象パスが自動で記録されます。

```json
{
  "indexedDirs": [
    "/home/user/vaults",
    "/path/to/documents"
  ]
}
```

### インデックスの自動更新

検索時に1時間に1回、バックグラウンドで以下が自動実行されます（検索はブロックしません）。

1. **Google Drive 差分同期** — `gws drive changes` APIで変更を検出し、DL→インデックス更新（トークン設定済みの場合）
2. **ローカルファイル差分更新** — ファイルのmtimeを比較し、変更・削除を検出して再インデックス/除去
3. **SoftMatcha 2 再構築** — 差分があった場合、または前回構築から24時間以上経過した場合に再構築

#### Google Driveのインデックス作成

Google Drive上のファイルもインデックス対象にできます。

```bash
# 初回: Google Driveの全ファイルをDL → インデックス一括作成
npx tsx cli/gdrive-sync.ts bulk

# 差分同期の初期化（changeトークン取得）— bulkで自動保存されるため通常不要
npx tsx cli/gdrive-sync.ts init

# 手動で差分同期
npx tsx cli/gdrive-sync.ts sync
```

> **Note**
> [gws CLI](https://github.com/googleworkspace/cli)（Google Workspace CLI）のインストールと認証が必要です。gws CLIコマンドの直接実行で連携しています。

<p align="right">(<a href="#目次">トップに戻る</a>)</p>

---

## ■ 技術スタック

| カテゴリ | 技術 | 用途 |
|----------|------|------|
| エンベディング | ruri-v3-30m | 日本語テキストのベクトル化（256次元、37Mパラメータ） |
| 推論 | ONNX Runtime | CPU上でのモデル推論 |
| ベクトル検索 | sqlite-vec | ベクトル近傍検索（KNN） |
| 全文検索 | SQLite FTS5 | BM25ベースのキーワード検索 |
| ソフトパターンマッチ | SoftMatcha 2 | soft pattern matching（fastText + MeCab） |
| スコア統合 | RRF（k=60） | 3方式の検索結果を統合 |
| MCP | @modelcontextprotocol/sdk | Claude Code との連携 |
| Web UI | Next.js 16 / React 19 | 対話的検索インターフェース |
| スタイリング | Tailwind CSS 4 | UIスタイリング |
| LLM | Vercel AI SDK / Gemini | RAG回答生成 |

<p align="right">(<a href="#目次">トップに戻る</a>)</p>

---

## ■ ライセンス

MIT License - 詳細は [LICENSE](LICENSE) を参照してください。

---

## ■ コンタクト

- GitHub: [@takamiya1021](https://github.com/takamiya1021)
- プロジェクトリンク: [https://github.com/takamiya1021/app057-rag-ruri-30m](https://github.com/takamiya1021/app057-rag-ruri-30m)

<p align="right">(<a href="#目次">トップに戻る</a>)</p>

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
