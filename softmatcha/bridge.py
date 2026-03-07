#!/usr/bin/env python3
"""
SoftMatcha 2 ブリッジスクリプト
TypeScript側からstdin/stdout JSON通信で呼び出す常駐プロセス。

コマンド:
  build  — コーパスファイルからSoftMatcha 2インデックスを構築
  search — クエリで語順パターンマッチ検索し、マッチしたチャンクIDとスコアを返す
  status — インデックス状態を返す
  shutdown — プロセス終了
"""

import json
import sys
import os
import bisect
import logging
import numpy as np
from pathlib import Path
from dataclasses import asdict

# ログはstderrに出力（stdoutはJSON通信用）
logging.basicConfig(
    format="[softmatcha-bridge] %(message)s",
    level=logging.INFO,
    stream=sys.stderr,
)
logger = logging.getLogger("bridge")

# SoftMatcha 2のモジュール
from softmatcha.embeddings import get_embedding
from softmatcha.tokenizers import get_tokenizer
from softmatcha.search import Searcher
from softmatcha.struct import Pattern
from softmatcha.index import tokenize, build_index
from softmatcha import stopwatch

# 日本語対応: fastTextバックエンド + MeCabトークナイザ
BACKEND = "fasttext"
MODEL = "fasttext-ja-vectors"


class SoftMatchaBridge:
    def __init__(self):
        self.embedding = None
        self.tokenizer = None
        self.searcher = None
        self.corpus_map = []  # [{chunk_id, byte_start, byte_end}, ...]
        self.index_path = None
        self.ready = False

    def load_models(self):
        """エンベディングモデルとトークナイザーをロード"""
        if self.embedding is not None:
            return

        logger.info("fastTextモデルとMeCabトークナイザーを読み込み中...")
        embedding_class = get_embedding(BACKEND)
        self.embedding = embedding_class.build(
            embedding_class.Config(MODEL, mmap=True)
        )
        tokenizer_class = get_tokenizer(BACKEND)
        self.tokenizer = tokenizer_class.build(
            tokenizer_class.Config(name_or_path=MODEL)
        )
        logger.info("モデル読み込み完了")

    def load_index(self, index_path: str, map_path: str):
        """インデックスとコーパスマッピングをロード"""
        self.load_models()

        if not os.path.exists(os.path.join(index_path, "metadata.bin")):
            return False

        logger.info(f"インデックスをロード中: {index_path}")
        self.searcher = Searcher(index_path, self.tokenizer, self.embedding)
        self.index_path = index_path

        # コーパスマッピングをロード
        if os.path.exists(map_path):
            with open(map_path, "r", encoding="utf-8") as f:
                self.corpus_map = json.load(f)

        self.ready = True
        logger.info(f"インデックスロード完了（{len(self.corpus_map)}チャンク）")
        return True

    def build_index(self, corpus_path: str, index_path: str):
        """コーパスファイルからインデックスを構築"""
        self.load_models()
        stopwatch.timers.reset(profile=True)
        os.environ["RUST_LOG"] = "info"

        logger.info(f"インデックス構築開始: {corpus_path} → {index_path}")

        # インデックスディレクトリを作成
        os.makedirs(index_path, exist_ok=True)

        # トークナイズ
        num_tokens = tokenize(
            index_path,
            os.path.abspath(corpus_path),
            self.tokenizer,
            num_workers=os.cpu_count(),
            buffer_size=2500,
            max_vocab=2**19,
        )

        # インデックスサイズ計算
        mem_size = 500
        mem_size_ex = 100
        dict_size = min(num_tokens * 2, 1_000_000 * mem_size_ex // 2) * 8
        pair_cons = min(100_000, max(32, int((dict_size // 4) ** (1.0 / 2.0))))
        pair_cons = (pair_cons // 32) * 32
        trio_cons = min(10_000, max(32, int((max(1, dict_size - pair_cons * pair_cons) * 6) ** (1.0 / 3.0))))
        trio_cons = (trio_cons // 32) * 32

        avail_rough = 1_000_000 * mem_size_ex - (
            pair_cons * pair_cons + trio_cons * (trio_cons - 1) * (trio_cons - 2) // 6
        ) // 8
        rough_size = max(avail_rough, 0) // 32
        rough_div = 65_536
        while rough_div > 128:
            rough_div //= 2
            if (num_tokens - rough_div + 1) // rough_div >= rough_size:
                rough_div *= 2
                break

        # インデックス構築
        build_index(
            index_path,
            self.embedding,
            write_thread=4,
            chunk_size=mem_size * (1_000_000 // 120),
            pair_cons=pair_cons,
            trio_cons=trio_cons,
            rough_div=rough_div,
            num_shards=3,
        )

        # 一時ファイル削除
        tokens_bin = Path(index_path) / "tokens.bin"
        if tokens_bin.exists():
            tokens_bin.unlink()

        logger.info(f"インデックス構築完了（{num_tokens}トークン）")
        return num_tokens

    def search(self, query: str, num_candidates: int = 20, min_similarity: float = 0.3):
        """クエリで語順パターンマッチ検索し、チャンクIDとスコアを返す"""
        if not self.ready or self.searcher is None:
            return {"error": "インデックスが読み込まれていません"}

        # クエリをトークナイズ
        pattern_tokens = self.tokenizer(query)
        if len(pattern_tokens) == 0:
            return {"results": [], "message": "クエリをトークナイズできませんでした"}

        pattern_embeddings = self.searcher.normalize(self.embedding(pattern_tokens))
        pattern = Pattern.build(
            pattern_tokens, pattern_embeddings, [0.0] * len(pattern_embeddings)
        )

        if len(pattern) > 12:
            return {"error": f"トークン数が12以下である必要があります（現在: {len(pattern)}）"}

        # 未知語チェック
        for i, token_id in enumerate(pattern.tokens):
            if token_id >= min(self.searcher.max_vocab, len(self.embedding.embeddings)) - 1:
                list_words = self.tokenizer.tokenize(query)
                word = list_words[i] if i < len(list_words) else "unknown"
                return {"results": [], "message": f'未知語 "{word}" が含まれています'}

        # SoftMatcha 2 検索
        matched_pattern, match_score, match_count, thres = self.searcher.search(
            pattern, num_candidates, min_similarity, 10.0
        )

        results = []
        for i in range(len(matched_pattern)):
            # パターンのトークンを文字列に変換
            pat_str = ""
            for j in range(len(matched_pattern[i])):
                if matched_pattern[i][j] >= 1_000_000_000:
                    break
                if j >= 1:
                    pat_str += " "
                pat_str += self.tokenizer.tokens[matched_pattern[i][j]]

            score = float(match_score[i])
            count = int(match_count[i])

            # このパターンのexact match位置を取得してチャンクにマッピング
            chunk_ids = set()
            if count > 0 and self.corpus_map:
                try:
                    pat_for_exact = Pattern.build(
                        matched_pattern[i][matched_pattern[i] < 1_000_000_000],
                        self.embedding(matched_pattern[i][matched_pattern[i] < 1_000_000_000]),
                        [0.0] * int(np.sum(matched_pattern[i] < 1_000_000_000)),
                    )
                    list_str, match_num = self.searcher.get_exact_match(
                        pat_for_exact, min(count, 50), 0
                    )
                    # get_exact_matchの内部でバイト位置を計算するが、
                    # 直接アクセスできないので、コンテキストテキストから照合する
                    for ctx in list_str:
                        match_text = ctx[1]  # マッチしたテキスト部分
                        left_text = ctx[0]
                        # マッピング: マッチテキストが含まれるチャンクを特定
                        for entry in self.corpus_map:
                            cid = entry["chunk_id"]
                            text = entry.get("text_preview", "")
                            if match_text and match_text in text:
                                chunk_ids.add(cid)
                except Exception as e:
                    logger.warning(f"位置特定エラー: {e}")

            # チャンク特定できなかった場合はテキストマッチで補完
            if not chunk_ids and pat_str:
                for entry in self.corpus_map:
                    # パターン文字列の単語がチャンクテキストに含まれるかチェック
                    words = pat_str.split()
                    text = entry.get("text_preview", "")
                    if all(w in text for w in words):
                        chunk_ids.add(entry["chunk_id"])

            results.append({
                "pattern": pat_str,
                "score": round(score * 100, 1),
                "count": count,
                "chunk_ids": sorted(chunk_ids),
            })

        return {
            "results": results,
            "threshold": round(float(thres) * 100, 1),
        }

    def handle_command(self, cmd: dict) -> dict:
        """コマンドを処理"""
        action = cmd.get("action", "")

        if action == "build":
            corpus_path = cmd["corpus_path"]
            index_path = cmd["index_path"]
            map_path = cmd.get("map_path", "")
            try:
                num_tokens = self.build_index(corpus_path, index_path)
                # 構築後にインデックスをリロード
                if map_path:
                    self.load_index(index_path, map_path)
                return {"ok": True, "num_tokens": num_tokens}
            except Exception as e:
                return {"ok": False, "error": str(e)}

        elif action == "load":
            index_path = cmd["index_path"]
            map_path = cmd.get("map_path", "")
            try:
                ok = self.load_index(index_path, map_path)
                return {"ok": ok}
            except Exception as e:
                return {"ok": False, "error": str(e)}

        elif action == "search":
            query = cmd["query"]
            num_candidates = cmd.get("num_candidates", 20)
            min_similarity = cmd.get("min_similarity", 0.3)
            return self.search(query, num_candidates, min_similarity)

        elif action == "status":
            return {
                "ready": self.ready,
                "num_chunks": len(self.corpus_map),
                "has_index": self.searcher is not None,
            }

        elif action == "shutdown":
            return {"ok": True, "message": "shutting down"}

        else:
            return {"error": f"不明なコマンド: {action}"}


def main():
    bridge = SoftMatchaBridge()
    logger.info("SoftMatcha 2 ブリッジプロセス開始")

    # SoftMatchaライブラリがstdoutに直接書き出す問題への対策:
    # - Python側: "loading begin...", "loading finished" 等
    # - Rust/C拡張側: "#Search = ..." 等（fd 1に直接write）
    # fd 1（stdout）をstderr（fd 2）にリダイレクトし、
    # JSON通信用に元のstdoutのfdを保持する。
    json_fd = os.dup(1)        # 元のstdout fdを複製
    os.dup2(2, 1)              # fd 1をstderr（fd 2）に向ける
    json_out = os.fdopen(json_fd, "w")  # JSON出力用のファイルオブジェクト

    # 起動メッセージ
    json_out.write(json.dumps({"status": "ready"}) + "\n")
    json_out.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"JSONパースエラー: {str(e)}"}), flush=True)
            continue

        result = bridge.handle_command(cmd)
        json_out.write(json.dumps(result, ensure_ascii=False) + "\n")
        json_out.flush()

        if cmd.get("action") == "shutdown":
            break

    logger.info("SoftMatcha 2 ブリッジプロセス終了")


if __name__ == "__main__":
    main()
