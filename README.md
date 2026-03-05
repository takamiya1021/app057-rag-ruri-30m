# クロラグ（kuro-rag-ruri-30m）

日本語特化の軽量RAGシステム。ローカルで動作するエンベディングモデル [ruri-v3-30m](https://huggingface.co/cl-nagoya/ruri-v3-30m) を使用し、ドキュメントのセマンティック検索を提供します。

## 特徴

- **完全ローカル動作**: エンベディング生成にAPIキー不要（ONNX Runtime で CPU推論）
- **日本語特化**: 名古屋大学の ruri-v3-30m モデル（256次元, 37Mパラメータ）
- **ハイブリッド検索**: ベクトル検索 + BM25全文検索を RRF（k=60）で統合
- **3つのインターフェース**: MCP サーバー / Web UI / CLI
- **軽量ストレージ**: SQLite + sqlite-vec（外部DBサーバー不要）
- **インデックス自動管理**: ファイルの更新・削除を検出し、差分同期が可能

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

## セットアップ

### 必要環境

- Node.js 20+
- npm

### インストール

```bash
git clone <repository-url>
cd app057-rag-ruri-30m
npm install
```

初回実行時にエンベディングモデル（約150MB）が自動ダウンロードされます。

## 使い方

### 1. MCPサーバーとして使う（推奨）

Claude Code の MCP設定に追加します。

**`~/.claude/claude_desktop_config.json` の設定例:**

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

## 技術スタック

- **エンベディング**: [ruri-v3-30m](https://huggingface.co/cl-nagoya/ruri-v3-30m)（ONNX版: [sirasagi62/ruri-v3-30m-ONNX](https://huggingface.co/sirasagi62/ruri-v3-30m-ONNX)）
- **推論**: [@huggingface/transformers](https://github.com/huggingface/transformers.js)（ONNX Runtime）
- **ベクトルDB**: [sqlite-vec](https://github.com/asg017/sqlite-vec)
- **全文検索**: SQLite FTS5
- **MCPフレームワーク**: [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- **Web UI**: Next.js 16 + React 19 + Tailwind CSS 4
- **LLM連携**: Vercel AI SDK + Google Gemini

## ライセンス

MIT
