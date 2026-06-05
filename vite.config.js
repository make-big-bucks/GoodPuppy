import { defineConfig } from "vite";

// Tauri 期望前端 dev server 在固定端口（与 tauri.conf.json devUrl 一致）
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    target: "esnext",
    emptyOutDir: true,
  },
});
