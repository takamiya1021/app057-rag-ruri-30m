"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Cookieから値を取得 */
function getCookie(name: string): string {
  const match = document.cookie.match(new RegExp("(^| )" + name + "=([^;]+)"));
  return match ? decodeURIComponent(match[2]) : "";
}

/** Cookieに値を保存（1年有効） */
function setCookie(name: string, value: string): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=31536000; SameSite=Strict`;
}

/** Cookieを削除 */
function deleteCookie(name: string): void {
  document.cookie = `${name}=; path=/; max-age=0`;
}

const DEFAULT_DB_PATH = "~/.local/share/rag-mcp-ruri/rag.db";

export default function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [apiKey, setApiKey] = useState("");
  const [savedApiKey, setSavedApiKey] = useState("");
  const [dbPath, setDbPath] = useState("");
  const [savedDbPath, setSavedDbPath] = useState("");
  const [linkMode, setLinkMode] = useState("modal");

  useEffect(() => {
    if (!isOpen) return;
    const key = getCookie("gemini_api_key");
    setSavedApiKey(key);
    setApiKey(key);
    const path = getCookie("rag_db_path");
    setSavedDbPath(path);
    setDbPath(path);
    setLinkMode(getCookie("link_mode") || "modal");
  }, [isOpen]);

  const handleSave = () => {
    // APIキー保存
    if (apiKey.trim()) {
      setCookie("gemini_api_key", apiKey.trim());
      setSavedApiKey(apiKey.trim());
    }
    // DBパス保存（空欄ならCookie削除でデフォルトに戻る）
    if (dbPath.trim()) {
      setCookie("rag_db_path", dbPath.trim());
      setSavedDbPath(dbPath.trim());
    } else {
      deleteCookie("rag_db_path");
      setSavedDbPath("");
    }
    // リンク表示方法を保存
    setCookie("link_mode", linkMode);
    onClose();
  };

  const handleDeleteApiKey = () => {
    deleteCookie("gemini_api_key");
    setSavedApiKey("");
    setApiKey("");
  };

  const handleResetDbPath = () => {
    deleteCookie("rag_db_path");
    setSavedDbPath("");
    setDbPath("");
  };

  if (!isOpen) return null;

  const modalContent = (
    <div className="fixed inset-0 z-[10000] bg-black/80 backdrop-blur-sm overflow-y-auto">
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="bg-slate-800 border border-cyan-500/30 p-6 rounded-lg w-full max-w-md shadow-2xl">
          <h2 className="text-xl font-bold text-cyan-100 mb-4">設定</h2>

          <div className="space-y-6">
            {/* APIキー設定 */}
            <div>
              <h3 className="text-sm font-semibold text-gray-300 mb-2">
                Gemini APIキー
              </h3>
              <p className="text-gray-500 text-xs mb-2">
                AI回答機能に必要です。
                <a
                  href="https://aistudio.google.com/app/apikey"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-cyan-400 hover:text-cyan-300 underline ml-1"
                >
                  APIキーを取得
                </a>
              </p>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="AIzaSy..."
                className="w-full p-2 bg-slate-900 border border-gray-700 rounded focus:border-cyan-500 focus:outline-none text-white font-mono text-sm"
              />
              {savedApiKey && (
                <button
                  onClick={handleDeleteApiKey}
                  className="text-red-400 hover:text-red-300 text-xs underline mt-1"
                >
                  キーを削除
                </button>
              )}
            </div>

            {/* DBパス設定 */}
            <div>
              <h3 className="text-sm font-semibold text-gray-300 mb-2">
                データベースパス
              </h3>
              <p className="text-gray-500 text-xs mb-2">
                RAGデータベースの保存先。空欄でデフォルトパスを使用。
              </p>
              <input
                type="text"
                value={dbPath}
                onChange={(e) => setDbPath(e.target.value)}
                placeholder={DEFAULT_DB_PATH}
                className="w-full p-2 bg-slate-900 border border-gray-700 rounded focus:border-cyan-500 focus:outline-none text-white font-mono text-sm"
              />
              {savedDbPath && (
                <button
                  onClick={handleResetDbPath}
                  className="text-red-400 hover:text-red-300 text-xs underline mt-1"
                >
                  デフォルトに戻す
                </button>
              )}
              <p className="text-gray-600 text-xs mt-1">
                デフォルト: {DEFAULT_DB_PATH}
              </p>
            </div>

            {/* リンク表示方法 */}
            <div>
              <h3 className="text-sm font-semibold text-gray-300 mb-2">
                ソースリンクの開き方
              </h3>
              <p className="text-gray-500 text-xs mb-2">
                検索結果のファイル名をクリックした時の動作。
              </p>
              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="linkMode"
                    value="modal"
                    checked={linkMode === "modal"}
                    onChange={(e) => setLinkMode(e.target.value)}
                    className="accent-cyan-500"
                  />
                  <span className="text-sm text-gray-300">モーダルで表示（API消費なし）</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="linkMode"
                    value="vscode"
                    checked={linkMode === "vscode"}
                    onChange={(e) => setLinkMode(e.target.value)}
                    className="accent-cyan-500"
                  />
                  <span className="text-sm text-gray-300">VSCodeで開く</span>
                </label>
              </div>
              {linkMode === "vscode" && (
                <p className="text-gray-500 text-xs mt-2">
                  事前にVSCodeを開いておく必要があります。未起動時はモーダル表示にフォールバックします。
                </p>
              )}
            </div>
          </div>

          {/* ボタン */}
          <div className="flex justify-end space-x-3 mt-6 pt-4 border-t border-gray-700">
            <button
              onClick={onClose}
              className="px-4 py-2 text-gray-400 hover:text-white"
            >
              キャンセル
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 bg-cyan-700 hover:bg-cyan-600 text-white rounded"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return typeof window !== "undefined"
    ? createPortal(modalContent, document.body)
    : null;
}
