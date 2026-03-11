#!/bin/bash
# リランク済み検索結果を収集してJSONLに出力するスクリプト
# 使い方: bash eval/collect_reranked.sh > eval/reranked_contexts.jsonl

queries=(
  "Graphitiとは何か、どのようなフレームワークか"
  "AIボットの記憶システムはどのような仕組みか"
  "CursorとClaude Code CLIでのGraphiti利用の違い"
  "CLAUDE.mdの設計パターンと設定方法"
  "ベクトル検索とキーワード検索の違いは何か"
  "100本アプリ開発チャレンジとは"
  "Neo4jデータベースの接続設定はどうなっているか"
  "Gemini APIをアプリ開発でどう活用しているか"
)

for q in "${queries[@]}"; do
  echo "--- $q ---" >&2
  npx tsx cli/rag-cli.ts search "$q" 3 2>/dev/null | grep -v "^検索:" | grep -v "^RRF候補"
  echo "===END==="
done
