import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {},
  // better-sqlite3, sqlite-vec はNode.jsネイティブバインディングのためバンドル除外
  serverExternalPackages: [
    "better-sqlite3",
    "sqlite-vec",
    "@huggingface/transformers",
  ],
};

export default nextConfig;
