<div align="center">

# クロラグ（kuro-rag-ruri-30m）

日本語特化の軽量RAGシステム。
ローカルで動作するエンベディングモデルで、APIキー不要のセマンティック検索を実現します。

[![TypeScript][TypeScript-shield]][TypeScript-url]
[![Next.js][Next-shield]][Next-url]
[![SQLite][SQLite-shield]][SQLite-url]
[![License: MIT][license-shield]][license-url]

[使い方](#使い方) | [セットアップ](#セットアップ) | [MCPツール一覧](#mcpツール一覧) | [技術スタック](#技術スタック)

</div>

## 目次

- [このプロジェクトについて](#このプロジェクトについて)
- [特徴](#特徴)
- [アーキテクチャ](#アーキテクチャ)
- [セットアップ](#セットアップ)
- [使い方](#使い方)
  - [MCPサーバー（推奨）](#1-mcpサーバーとして使う推奨)
  - [スキルの設定](#スキルの設定)
  - [CLI](#2-cliで使う)
  - [Web UI](#3-web-uiで使う)
- [対応ファイル形式](#対応ファイル形式)
- [データベース](#データベース)
- [技術スタック](#技術スタック)
- [ライセンス](#ライセンス)

## このプロジェクトについて

ローカルのドキュメント（Markdown、テキスト、PDF、JSON）をインデックスし、日本語に特化したセマンティック検索を提供するRAGシステムです。

**なぜこれが必要か？**

- 外部APIに依存せずにエンベディング生成したい
- 日本語ドキュメントを高精度で検索したい
- Claude Code（MCP）から直接ナレッジベースを検索したい

エンベディングモデルには名古屋大学が開発した [ruri-v3-30m](https://huggingface.co/cl-nagoya/ruri-v3-30m)（256次元、37Mパラメータ）を採用。ONNX Runtime によるCPU推論で、GPUなしでも動作します。

### Built With

| カテゴリ | 技術 |
|----------|------|
| エンベディング | [ruri-v3-30m](https://huggingface.co/cl-nagoya/ruri-v3-30m)（[ONNX版](https://huggingface.co/sirasagi62/ruri-v3-30m-ONNX)） |
| 推論 | [@huggingface/transformers](https://github.com/huggingface/transformers.js)（ONNX Runtime） |
| ベクトル検索 | [sqlite-vec](https://github.com/asg017/sqlite-vec) + SQLite FTS5 |
| MCPフレームワーク | [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) |
| Web UI | Next.js 16 + React 19 + Tailwind CSS 4 |
| LLM連携 | Vercel AI SDK + Google Gemini |

<p align="right">(<a href="#目次">トップに戻る</a>)</p>

## 特徴

- **完全ローカル動作** - エンベディング生成にAPIキー不要（ONNX Runtime で CPU推論）
- **日本語特化** - ruri-v3-30m モデルによる高精度な日本語ベクトル表現
- **ハイブリッド検索** - ベクトル検索 + BM25全文検索を RRF（k=60）で統合
- **3つのインターフェース** - MCP サーバー / Web UI / CLI
- **軽量ストレージ** - SQLite + sqlite-vec（外部DBサーバー不要）
- **インデックス自動管理** - ファイルの更新・削除を検出し、差分同期が可能

<p align="right">(<a href="#目次">トップに戻る</a>)</p>

## アーキテクチャ

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
              ┌─────────▼─────────┐
              │  SQLite + FTS5    │
              │  + sqlite-vec    │
              └───────────────────┘
```

<p align="right">(<a href="#目次">トップに戻る</a>)</p>

## セットアップ

### 前提条件

- Node.js 20+
- npm

### インストール

```bash
git clone https://github.com/takamiya1021/app057-rag-ruri-30m.git
cd app057-rag-ruri-30m
npm install
```

> **Note**
> 初回実行時にエンベディングモデル（約150MB）が自動ダウンロードされます。

<p align="right">(<a href="#目次">トップに戻る</a>)</p>

## 使い方

### 1. MCPサーバーとして使う（推奨）

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
- **インデックス更新チェック**: 検索前にファイルの更新・削除を自動検出し、確認の上で同期

スキルを有効にするには、プロジェクトのスキルディレクトリをClaude Codeが認識できる状態にしてください。このリポジトリをcloneした状態でClaude Codeを起動すれば、`.claude/skills/` 内のスキルは自動で認識されます。

#### 使い方の例

スキルは「**ラグ**」または「**RAG**」というキーワードを含む発話で自動発動します。

```
# 検索する
「ラグで〇〇を検索して」
「RAGで△△について調べて」
「ラグで□□探して」

# 具体例
「ラグでPT3を検索して」
「RAGで資金管理について調べて」
```

スキルが発動すると、以下が自動で行われます：

1. インデックスの更新チェック（更新があれば確認の上で同期）
2. 口語からの検索キーワード最適化
3. MCP `search` ツールの呼び出し
4. 結果の表示

> **Note**
> 「検索して」だけではファイル検索と区別がつかないため、必ず「**ラグ**」を含めてください。
> スキルが発動しない場合は、スキル名を直接指定してください：「**/rag-search** で〇〇を検索して」

#### MCPツール一覧

| ツール | 説明 |
|--------|------|
| `search` | セマンティック検索（ハイブリッド） |
| `add_document` | ファイルをインデックスに追加 |
| `add_directory` | ディレクトリを再帰的にインデックス |
| `add_text` | テキストを直接インデックスに追加 |
| `list_sources` | インデックス済みソース一覧 |
| `remove_source` | ソースをインデックスから削除 |
| `check_updates` | ファイルの更新・削除を検出 |
| `sync_updates` | 検出された変更をインデックスに反映 |

### 2. CLIで使う

```bash
# ドキュメントを追加
npm run cli:add -- /path/to/document.md

# 検索
npm run cli -- search "検索クエリ"

# 質問（RAG検索 + Gemini回答）※GEMINI_API_KEY必要
npm run cli:ask -- "質問内容"

# ソース一覧
npm run cli:list

# ステータス確認
npm run cli:status
```

### 3. Web UIで使う

```bash
npm run dev
# http://localhost:3057 でアクセス
```

Web UIでは以下の機能が利用できます:

- チャットベースの対話的検索（Gemini連携、要APIキー）
- ドキュメント管理（追加・削除）
- ソースリンクからのドキュメント閲覧（モーダル表示 / VSCode連携）
- 設定画面（APIキー管理、VSCode連携設定）

<p align="right">(<a href="#目次">トップに戻る</a>)</p>

## 対応ファイル形式

| 形式 | 拡張子 | チャンク分割方式 |
|------|--------|------------------|
| Markdown | `.md` | 見出し（h1〜h3）ベース |
| テキスト | `.txt` | 固定長（500文字、100文字オーバーラップ） |
| PDF | `.pdf` | 固定長 |
| JSON | `.json` | 固定長 |

## データベース

デフォルトの保存先: `~/.local/share/rag-mcp-ruri-30m/rag.db`

環境変数 `RAG_DB_PATH` で変更可能です。

<p align="right">(<a href="#目次">トップに戻る</a>)</p>

## 技術スタック

| カテゴリ | 技術 | 用途 |
|----------|------|------|
| エンベディング | ruri-v3-30m | 日本語テキストのベクトル化（256次元） |
| 推論 | ONNX Runtime | CPU上でのモデル推論 |
| ベクトル検索 | sqlite-vec | ベクトル近傍検索 |
| 全文検索 | SQLite FTS5 | BM25ベースのキーワード検索 |
| MCP | @modelcontextprotocol/sdk | Claude Code との連携 |
| Web UI | Next.js 16 / React 19 | 対話的検索インターフェース |
| スタイリング | Tailwind CSS 4 | UIスタイリング |
| LLM | Vercel AI SDK / Gemini | RAG回答生成 |

<p align="right">(<a href="#目次">トップに戻る</a>)</p>

## ライセンス

MIT License - 詳細は [LICENSE](LICENSE) を参照してください。

## コンタクト

- GitHub: [@takamiya1021](https://github.com/takamiya1021)
- プロジェクトリンク: [https://github.com/takamiya1021/app057-rag-ruri-30m](https://github.com/takamiya1021/app057-rag-ruri-30m)

<p align="right">(<a href="#目次">トップに戻る</a>)</p>

<!-- MARKDOWN LINKS & IMAGES -->
[TypeScript-shield]: https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white
[TypeScript-url]: https://www.typescriptlang.org/
[Next-shield]: https://img.shields.io/badge/Next.js-000000?style=for-the-badge&logo=nextdotjs&logoColor=white
[Next-url]: https://nextjs.org/
[SQLite-shield]: https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white
[SQLite-url]: https://www.sqlite.org/
[license-shield]: https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge
[license-url]: https://opensource.org/licenses/MIT
