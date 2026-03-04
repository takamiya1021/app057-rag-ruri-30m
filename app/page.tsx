"use client";

import { useState, useEffect, useCallback } from "react";
import ChatPanel from "@/components/ChatPanel";
import DocumentManager from "@/components/DocumentManager";
import SettingsModal from "@/components/SettingsModal";

type Tab = "chat" | "docs";

export default function Home() {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("chat");
  const [status, setStatus] = useState<{
    totalSources: number;
    totalChunks: number;
  } | null>(null);

  const checkApiKey = useCallback(() => {
    const match = document.cookie.match(
      new RegExp("(^| )gemini_api_key=([^;]+)"),
    );
    setHasApiKey(!!(match && match[2].trim() !== ""));
  }, []);

  useEffect(() => {
    checkApiKey();
    // ステータス取得
    fetch("/api/status")
      .then((res) => res.json())
      .then((data) =>
        setStatus({
          totalSources: data.totalSources,
          totalChunks: data.totalChunks,
        }),
      )
      .catch(() => {});
  }, [checkApiKey]);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* ヘッダー */}
      <header className="border-b border-gray-800 bg-slate-900/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold text-white">
              RAG ナレッジベース
            </h1>
            {status && (
              <span className="text-xs bg-slate-800 text-gray-400 px-2 py-1 rounded-full border border-gray-700">
                {status.totalSources}ソース / {status.totalChunks}チャンク
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* APIキー状態表示 */}
            <span
              className={`w-2 h-2 rounded-full ${hasApiKey ? "bg-green-400" : "bg-red-400"}`}
              title={hasApiKey ? "APIキー設定済み" : "APIキー未設定"}
            />
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="text-sm text-gray-400 hover:text-white transition-colors"
            >
              設定
            </button>
          </div>
        </div>
      </header>

      {/* APIキー未設定バナー */}
      {!hasApiKey && (
        <div className="bg-amber-900/20 border-b border-amber-700/30 px-4 py-3">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <p className="text-amber-200 text-sm">
              APIキーが未設定です。AI回答機能を使用するにはGemini
              APIキーを設定してください。
            </p>
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="px-3 py-1 bg-amber-700 hover:bg-amber-600 text-white rounded text-sm transition-colors"
            >
              設定する
            </button>
          </div>
        </div>
      )}

      {/* モバイル用タブ切替 */}
      <div className="md:hidden border-b border-gray-800">
        <div className="flex">
          <button
            onClick={() => setActiveTab("chat")}
            className={`flex-1 py-2 text-sm text-center transition-colors ${
              activeTab === "chat"
                ? "text-cyan-400 border-b-2 border-cyan-400"
                : "text-gray-500"
            }`}
          >
            チャット
          </button>
          <button
            onClick={() => setActiveTab("docs")}
            className={`flex-1 py-2 text-sm text-center transition-colors ${
              activeTab === "docs"
                ? "text-cyan-400 border-b-2 border-cyan-400"
                : "text-gray-500"
            }`}
          >
            文書管理
          </button>
        </div>
      </div>

      {/* メインエリア（2カラム / タブ切替） */}
      <main className="flex-1 max-w-7xl mx-auto w-full flex overflow-hidden">
        {/* チャットパネル */}
        <div
          className={`flex-1 p-4 flex flex-col ${
            activeTab === "docs" ? "hidden md:flex" : "flex"
          }`}
          style={{ minHeight: 0 }}
        >
          <ChatPanel hasApiKey={hasApiKey} />
        </div>

        {/* 文書管理パネル */}
        <div
          className={`md:w-80 lg:w-96 border-l border-gray-800 p-4 flex flex-col ${
            activeTab === "chat" ? "hidden md:flex" : "flex"
          }`}
          style={{ minHeight: 0 }}
        >
          <DocumentManager />
        </div>
      </main>

      {/* 設定モーダル */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => {
          setIsSettingsOpen(false);
          checkApiKey();
        }}
      />
    </div>
  );
}
