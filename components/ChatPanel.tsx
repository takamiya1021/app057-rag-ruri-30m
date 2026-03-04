"use client";

import { useChat } from "@ai-sdk/react";
import { useEffect, useRef, useState } from "react";

export default function ChatPanel({ hasApiKey }: { hasApiKey: boolean }) {
  const { messages, sendMessage, status, error } = useChat();
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const isLoading = status === "submitted" || status === "streaming";

  // メッセージ追加時に自動スクロール
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading || !hasApiKey) return;
    sendMessage({ text: input.trim() });
    setInput("");
  };

  /** UIMessageのpartsからテキストを抽出 */
  const getMessageText = (
    parts: Array<{ type: string; text?: string }>,
  ): string => {
    return parts
      .filter(
        (p): p is { type: "text"; text: string } =>
          p.type === "text" && typeof p.text === "string",
      )
      .map((p) => p.text)
      .join("");
  };

  return (
    <div className="flex flex-col h-full">
      <h2 className="text-lg font-semibold text-cyan-100 mb-3">
        ナレッジベースに質問
      </h2>

      {/* メッセージ一覧 */}
      <div className="flex-1 overflow-y-auto space-y-4 mb-4 pr-1">
        {messages.length === 0 && (
          <div className="text-center text-gray-500 mt-8">
            <p className="text-lg mb-2">RAG ナレッジベース</p>
            <p className="text-sm">
              登録した文書をもとにAIが回答します。
              <br />
              質問を入力してください。
            </p>
          </div>
        )}

        {messages.map((m) => (
          <div
            key={m.id}
            className={`${m.role === "user" ? "flex justify-end" : ""}`}
          >
            <div
              className={`max-w-[85%] rounded-lg p-3 ${
                m.role === "user"
                  ? "bg-cyan-800/40 border border-cyan-700/30 text-white"
                  : "bg-slate-800/60 border border-gray-700/30 text-gray-200"
              }`}
            >
              <div className="text-sm whitespace-pre-wrap leading-relaxed">
                {getMessageText(m.parts)}
              </div>
            </div>
          </div>
        ))}

        {/* ローディング表示 */}
        {isLoading && (
          <div className="flex items-center gap-2 text-cyan-400 text-sm">
            <div className="w-2 h-2 bg-cyan-400 rounded-full animate-pulse" />
            回答を生成中...
          </div>
        )}

        {/* エラー表示 */}
        {error && (
          <div className="p-3 bg-red-900/30 border border-red-700/30 rounded text-red-300 text-sm">
            {error.message.includes("401")
              ? "APIキーが設定されていません。右上の設定ボタンからAPIキーを入力してください。"
              : `エラー: ${error.message}`}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* 入力欄 */}
      <form onSubmit={handleSubmit} className="flex gap-2 shrink-0">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            hasApiKey
              ? "質問を入力..."
              : "APIキーを設定してから質問してください"
          }
          disabled={!hasApiKey || isLoading}
          className="flex-1 p-3 bg-slate-900 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:border-cyan-500 focus:outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!hasApiKey || isLoading || !input.trim()}
          className="px-4 py-3 bg-cyan-700 hover:bg-cyan-600 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg transition-colors"
        >
          送信
        </button>
      </form>
    </div>
  );
}
