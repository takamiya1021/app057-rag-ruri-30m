"use client";

import { useChat } from "@ai-sdk/react";
import { useEffect, useRef, useState, useCallback } from "react";

interface DocumentViewerState {
  source: string;
  content: string;
  chunkCount: number;
}

export default function ChatPanel({ hasApiKey }: { hasApiKey: boolean }) {
  const { messages, sendMessage, status, error } = useChat();
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<DocumentViewerState | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);

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

  /** Cookieから値を取得 */
  const getCookie = (name: string): string => {
    const match = document.cookie.match(new RegExp("(^| )" + name + "=([^;]+)"));
    return match ? decodeURIComponent(match[2]) : "";
  };

  // ソース名クリック：モーダル or VSCode
  const handleSourceClick = useCallback(async (source: string) => {
    const mode = getCookie("link_mode") || "modal";

    if (mode === "vscode") {
      setViewerLoading(true);
      try {
        const res = await fetch(`/api/resolve-path?source=${encodeURIComponent(source)}&action=open`);
        if (res.ok) {
          setViewerLoading(false);
          return;
        }
        // VSCodeで開けなかった → モーダル表示にフォールバック
      } catch {
        // 通信エラー → モーダル表示にフォールバック
      }
      setViewerLoading(false);
    }

    // モーダル表示（LLM不使用）
    setViewerLoading(true);
    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(source)}`);
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || "ファイルの取得に失敗しました");
        return;
      }
      const data = await res.json();
      setViewer({
        source: data.source,
        content: data.content,
        chunkCount: data.chunkCount,
      });
    } catch {
      alert("通信エラーが発生しました");
    } finally {
      setViewerLoading(false);
    }
  }, []);

  /** テキスト内のファイルパスをクリック可能なリンクに変換 */
  const renderMessageContent = (
    text: string,
    onSourceClick: (source: string) => void,
  ) => {
    // パス区切り（/）を含み、ファイル拡張子で終わる文字列をリンク化
    // マークダウン装飾（**、`）も除去して検出
    // **path/file.md** / `path/file.md` / path/file.md を検出
    const pathPattern = /\*\*([^*]+\.(?:md|txt|json|pdf))\*\*|`([^`]+\.(?:md|txt|json|pdf))`|(?:^|\n)-\s+((?:[^\n`,()*]+\/)+[^\n`,()*]+\.(?:md|txt|json|pdf))|((?:[^\s`,()*]+\/)+[^\s`,()*]+\.(?:md|txt|json|pdf))/gm;
    const parts: (string | { type: "link"; source: string })[] = [];
    let lastIndex = 0;
    let match;

    while ((match = pathPattern.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(text.slice(lastIndex, match.index));
      }
      const source = match[1] || match[2] || match[3] || match[4];
      // `- path`パターンの場合、`- `部分はリンクに含めない
      if (match[3]) {
        const prefixLen = match[0].indexOf(source);
        parts.push(text.slice(match.index, match.index + prefixLen));
      }
      parts.push({ type: "link", source });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      parts.push(text.slice(lastIndex));
    }

    return parts.map((part, i) => {
      if (typeof part === "string") {
        return <span key={i}>{part}</span>;
      }
      return (
        <button
          key={i}
          onClick={() => onSourceClick(part.source)}
          className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2 cursor-pointer transition-colors"
          title={`${part.source} を開く`}
        >
          {part.source}
        </button>
      );
    });
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

        {messages.map((m) => {
          const text = getMessageText(m.parts);
          return (
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
                  {m.role === "assistant"
                    ? renderMessageContent(text, handleSourceClick)
                    : text}
                </div>
              </div>
            </div>
          );
        })}

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

      {/* ローディングオーバーレイ */}
      {viewerLoading && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <div className="text-cyan-400 text-sm flex items-center gap-2">
            <div className="w-2 h-2 bg-cyan-400 rounded-full animate-pulse" />
            ファイルを読み込み中...
          </div>
        </div>
      )}

      {/* ドキュメントビューアモーダル */}
      {viewer && (
        <div
          className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
          onClick={() => setViewer(null)}
        >
          <div
            className="bg-slate-900 border border-gray-700 rounded-lg w-full max-w-3xl max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* ヘッダー */}
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <div>
                <h3 className="text-white font-mono text-sm">{viewer.source}</h3>
                <p className="text-xs text-gray-500">{viewer.chunkCount}チャンク</p>
              </div>
              <button
                onClick={() => setViewer(null)}
                className="text-gray-400 hover:text-white text-lg transition-colors"
              >
                ✕
              </button>
            </div>
            {/* 内容 */}
            <div className="flex-1 overflow-y-auto p-4">
              <pre className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed font-sans">
                {viewer.content}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
