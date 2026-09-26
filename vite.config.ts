import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    watch: {
      // 写入防抖：AI 连续保存配置文件时，等文件稳定后再触发重启/HMR
      awaitWriteFinish: {
        stabilityThreshold: 1500,
        pollInterval: 100,
      },
      ignored: [
        "**/src-tauri/**",
        "**/target/**",
        "**/sidecar/**",
        "**/dist/**",
        "**/release-dist/**",
        "**/.git/**",
      ],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
});
