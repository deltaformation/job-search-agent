import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // better-sqlite3 stays outside the server bundle (native binding) and
  // loads from node_modules at runtime instead.
  serverExternalPackages: ["better-sqlite3"],
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
