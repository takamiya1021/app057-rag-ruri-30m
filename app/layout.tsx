import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RAG ナレッジベース",
  description: "ローカルナレッジベース検索・質問システム",
};

export const viewport: Viewport = {
  themeColor: "#0f172a",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body className="h-screen overflow-hidden bg-slate-900 text-slate-200 antialiased">
        {children}
      </body>
    </html>
  );
}
