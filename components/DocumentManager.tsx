"use client";

import { useState, useEffect, useCallback } from "react";

interface SourceInfo {
  source: string;
  chunkCount: number;
  createdAt: string;
}

export default function DocumentManager() {
  const [filePath, setFilePath] = useState("");
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    type: "success" | "error";
  } | null>(null);

  const fetchSources = useCallback(async () => {
    try {
      const res = await fetch("/api/documents");
      const data = await res.json();
      setSources(data.sources || []);
    } catch {
      // 初期読み込みエラーは無視
    }
  }, []);

  useEffect(() => {
    fetchSources();
  }, [fetchSources]);

  // メッセージを一定時間後に消す
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 5000);
    return () => clearTimeout(timer);
  }, [message]);

  const handleAdd = async () => {
    if (!filePath.trim()) return;
    setLoading(true);
    setMessage(null);

    try {
      const res = await fetch("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: filePath.trim() }),
      });
      const data = await res.json();

      if (res.ok) {
        setMessage({
          text: `${data.source} を登録しました（${data.chunksAdded}チャンク）`,
          type: "success",
        });
        setFilePath("");
        fetchSources();
      } else {
        setMessage({ text: data.error || "登録に失敗しました", type: "error" });
      }
    } catch {
      setMessage({ text: "通信エラーが発生しました", type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async (source: string) => {
    try {
      const res = await fetch(
        `/api/documents/${encodeURIComponent(source)}`,
        { method: "DELETE" },
      );
      const data = await res.json();

      if (res.ok) {
        setMessage({
          text: `${source} を削除しました（${data.chunksRemoved}チャンク）`,
          type: "success",
        });
        fetchSources();
      } else {
        setMessage({ text: data.error || "削除に失敗しました", type: "error" });
      }
    } catch {
      setMessage({ text: "通信エラーが発生しました", type: "error" });
    }
  };

  return (
    <div className="flex flex-col h-full">
      <h2 className="text-lg font-semibold text-cyan-100 mb-3">文書管理</h2>

      {/* 文書登録 */}
      <div className="mb-4">
        <label className="block text-sm text-gray-400 mb-1">
          ファイルパスを指定して登録
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={filePath}
            onChange={(e) => setFilePath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder="/path/to/document.md"
            className="flex-1 p-2 bg-slate-900 border border-gray-700 rounded text-sm text-white placeholder-gray-500 focus:border-cyan-500 focus:outline-none font-mono"
            disabled={loading}
          />
          <button
            onClick={handleAdd}
            disabled={loading || !filePath.trim()}
            className="px-3 py-2 bg-cyan-700 hover:bg-cyan-600 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded text-sm whitespace-nowrap transition-colors"
          >
            {loading ? "処理中..." : "登録"}
          </button>
        </div>
        <p className="text-xs text-gray-500 mt-1">
          対応形式: .txt .md .pdf .json
        </p>
      </div>

      {/* メッセージ表示 */}
      {message && (
        <div
          className={`p-2 rounded text-sm mb-3 ${
            message.type === "success"
              ? "bg-green-900/30 text-green-300 border border-green-700/30"
              : "bg-red-900/30 text-red-300 border border-red-700/30"
          }`}
        >
          {message.text}
        </div>
      )}

      {/* ソース一覧 */}
      <div className="flex-1 overflow-y-auto">
        <h3 className="text-sm font-medium text-gray-400 mb-2">
          登録済みソース ({sources.length})
        </h3>
        {sources.length === 0 ? (
          <p className="text-sm text-gray-500">
            文書がまだ登録されていません
          </p>
        ) : (
          <div className="space-y-2">
            {sources.map((s) => (
              <div
                key={s.source}
                className="flex items-center justify-between p-2 bg-slate-900/50 rounded border border-gray-800"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-white truncate font-mono">
                    {s.source}
                  </p>
                  <p className="text-xs text-gray-500">
                    {s.chunkCount}チャンク
                  </p>
                </div>
                <button
                  onClick={() => handleRemove(s.source)}
                  className="ml-2 text-red-400 hover:text-red-300 text-xs shrink-0"
                >
                  削除
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
