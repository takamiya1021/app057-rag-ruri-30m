#!/usr/bin/env python3
"""
RAGAS評価スクリプト
RAGシステムの検索品質・回答品質を定量評価する。

使い方:
  python eval/run_ragas.py [--data eval/test_data.json]

必要な環境変数:
  GEMINI_API_KEY — Gemini APIキー（LLM審判 + 回答生成に使用）
"""

import json
import sys
import os
from pathlib import Path

# Gemini APIキーを確認
api_key = os.environ.get("GEMINI_API_KEY")
if not api_key:
    # .env.localから読み込み
    env_file = Path(__file__).parent.parent / ".env.local"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("GEMINI_API_KEY="):
                api_key = line.split("=", 1)[1].strip()
                os.environ["GEMINI_API_KEY"] = api_key
                break
    if not api_key:
        print("エラー: GEMINI_API_KEY が設定されていないよ")
        sys.exit(1)

import google.generativeai as genai
from ragas import evaluate
from ragas.dataset_schema import SingleTurnSample, EvaluationDataset
from ragas.metrics import (
    Faithfulness,
    ResponseRelevancy,
    LLMContextPrecisionWithReference,
    LLMContextRecall,
)
from ragas.llms import LangchainLLMWrapper
from ragas.embeddings import LangchainEmbeddingsWrapper
from langchain_google_genai import ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings


def generate_answer(question: str, contexts: list[str]) -> str:
    """Geminiで検索コンテキストに基づいた回答を生成"""
    genai.configure(api_key=api_key)
    model = genai.GenerativeModel("gemini-2.5-flash")

    context_text = "\n---\n".join(contexts)
    prompt = f"""以下の検索結果に基づいて、質問に簡潔に回答してください。
検索結果に情報がない場合は「情報が見つかりませんでした」と答えてください。

【検索結果】
{context_text}

【質問】
{question}

【回答】"""

    response = model.generate_content(prompt)
    return response.text.strip()


def main():
    # テストデータ読み込み
    data_path = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).parent / "test_data.json")
    print(f"テストデータ: {data_path}")

    with open(data_path) as f:
        test_data = json.load(f)

    print(f"テスト件数: {len(test_data)}件")
    print()

    # 各質問にGeminiで回答を生成
    print("=== 回答生成中 ===")
    samples = []
    for i, item in enumerate(test_data):
        q = item["question"]
        print(f"  [{i+1}/{len(test_data)}] {q}")
        answer = generate_answer(q, item["contexts"])
        print(f"    → {answer[:80]}...")

        samples.append(
            SingleTurnSample(
                user_input=q,
                response=answer,
                retrieved_contexts=item["contexts"],
                reference=item.get("reference", ""),
            )
        )

    dataset = EvaluationDataset(samples=samples)

    # Geminiを審判LLMとして設定
    print("\n=== RAGAS評価実行中 ===")
    evaluator_llm = LangchainLLMWrapper(
        ChatGoogleGenerativeAI(
            model="gemini-2.5-flash",
            google_api_key=api_key,
        )
    )
    evaluator_embeddings = LangchainEmbeddingsWrapper(
        GoogleGenerativeAIEmbeddings(
            model="models/text-embedding-004",
            google_api_key=api_key,
        )
    )

    # 評価指標（ResponseRelevancyはEmbedding APIの互換性問題があるため除外）
    metrics = [
        Faithfulness(llm=evaluator_llm),
        LLMContextPrecisionWithReference(llm=evaluator_llm),
        LLMContextRecall(llm=evaluator_llm),
    ]

    # 評価実行
    result = evaluate(
        dataset=dataset,
        metrics=metrics,
    )

    # 結果表示
    print("\n" + "=" * 60)
    print("📊 RAGAS評価結果")
    print("=" * 60)

    # 全体スコア
    df = result.to_pandas()
    score_cols = [c for c in df.columns if c not in ("user_input", "response", "retrieved_contexts", "reference")]

    print("\n【全体スコア（0.0〜1.0、高いほど良い）】")
    overall = {}
    for col in score_cols:
        vals = df[col].dropna()
        if len(vals) > 0:
            avg = float(vals.mean())
            overall[col] = avg
            bar = "█" * int(avg * 20) + "░" * (20 - int(avg * 20))
            print(f"  {col:40s} {bar} {avg:.3f}")

    # 質問ごとの詳細
    print("\n【質問別スコア】")
    for _, row in df.iterrows():
        print(f"\n  Q: {row['user_input']}")
        for col in score_cols:
            val = row[col]
            if val is not None and not (isinstance(val, float) and val != val):  # NaN判定
                print(f"    {col}: {val:.3f}")

    # 結果をJSONで保存
    output_path = Path(__file__).parent / "ragas_result.json"
    result_dict = {
        "overall": overall,
        "per_question": df.to_dict(orient="records"),
    }
    # floatに変換（numpy対策）
    def convert(obj):
        if hasattr(obj, "item"):
            return obj.item()
        if isinstance(obj, list):
            return [convert(x) for x in obj]
        if isinstance(obj, dict):
            return {k: convert(v) for k, v in obj.items()}
        return obj

    with open(output_path, "w") as f:
        json.dump(convert(result_dict), f, ensure_ascii=False, indent=2)
    print(f"\n結果を保存: {output_path}")


if __name__ == "__main__":
    main()
