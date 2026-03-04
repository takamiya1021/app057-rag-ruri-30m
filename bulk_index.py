#!/usr/bin/env python3
"""
ruri-v3-130m バルクインデックス生成スクリプト
APP053のDBからチャンクを読み込み、Embedding生成してAPP056のDBに保存する
"""

import os
import time
import sqlite3
import struct

os.environ["TOKENIZERS_PARALLELISM"] = "false"

SOURCE_DB = os.path.expanduser("~/.local/share/rag-mcp/rag.db")
TARGET_DB = os.path.expanduser("~/.local/share/rag-mcp-ruri/rag.db")
MODEL_ID = "cl-nagoya/ruri-v3-130m"
PREFIX = "検索文書: "
EMBEDDING_DIM = 512
BATCH_SIZE = 64


def float_array_to_bytes(arr):
    """float配列をbytesに変換（sqlite-vec互換）"""
    return struct.pack(f"{len(arr)}f", *arr)


def main():
    print("=== ruri-v3-130m バルクインデックス ===")

    # モデル読み込み
    print("モデル読み込み中...")
    t0 = time.time()
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer(MODEL_ID)
    print(f"モデル読み込み: {time.time()-t0:.1f}秒")

    # ソースDBからチャンクを読み込み
    print("ソースDBからチャンクを読み込み中...")
    src_db = sqlite3.connect(SOURCE_DB)
    rows = src_db.execute(
        "SELECT id, source, chunk_text, chunk_index, metadata, created_at FROM chunks ORDER BY id"
    ).fetchall()
    src_db.close()
    print(f"チャンク数: {len(rows)}")

    texts = [PREFIX + r[2] for r in rows]

    # Embedding生成（単一プロセスで十分速い）
    print("Embedding生成開始...")
    t_start = time.time()
    import numpy as np
    all_embeddings = model.encode(
        texts,
        normalize_embeddings=True,
        batch_size=BATCH_SIZE,
        show_progress_bar=True,
    )
    t_encode = time.time()
    encode_time = t_encode - t_start
    print(f"Embedding生成完了: {encode_time:.1f}秒 ({encode_time/len(texts)*1000:.1f}ms/chunk)")
    print(f"Embedding shape: {all_embeddings.shape}")

    # ターゲットDB作成・保存
    print("DBに保存中...")
    target_dir = os.path.dirname(TARGET_DB)
    os.makedirs(target_dir, exist_ok=True)

    # 既存DB削除
    for p in [TARGET_DB, TARGET_DB + "-wal", TARGET_DB + "-shm"]:
        if os.path.exists(p):
            os.remove(p)

    tgt_db = sqlite3.connect(TARGET_DB)

    import sqlite_vec
    tgt_db.enable_load_extension(True)
    sqlite_vec.load(tgt_db)

    tgt_db.execute("PRAGMA journal_mode = WAL")
    tgt_db.execute("PRAGMA synchronous = NORMAL")

    tgt_db.execute(f"""
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
            embedding float[{EMBEDDING_DIM}]
        )
    """)
    tgt_db.execute("""
        CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY,
            source TEXT NOT NULL,
            chunk_text TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            metadata TEXT,
            created_at TEXT
        )
    """)

    t_db_start = time.time()
    tgt_db.execute("BEGIN")
    for i, row in enumerate(rows):
        _, source, chunk_text, chunk_index, metadata, created_at = row
        tgt_db.execute(
            "INSERT INTO chunks (source, chunk_text, chunk_index, metadata, created_at) VALUES (?, ?, ?, ?, ?)",
            (source, chunk_text, chunk_index, metadata, created_at),
        )
        rowid = i + 1
        emb_bytes = float_array_to_bytes(all_embeddings[i])
        tgt_db.execute(
            "INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)",
            (rowid, emb_bytes),
        )
    tgt_db.execute("COMMIT")
    tgt_db.close()
    t_db_end = time.time()

    total_time = time.time() - t0
    print(f"\nDB保存完了: {t_db_end - t_db_start:.1f}秒")
    print(f"=== 合計: {total_time:.1f}秒 ({total_time/60:.1f}分) ===")
    print(f"  モデル読み込み: {time.time()-t0 - total_time + (time.time()-t0):.1f}秒")
    print(f"  Embedding: {encode_time:.1f}秒")
    print(f"  DB保存: {t_db_end - t_db_start:.1f}秒")
    print(f"  {len(rows)} chunks @ {total_time/len(rows)*1000:.1f}ms/chunk")


if __name__ == "__main__":
    main()
