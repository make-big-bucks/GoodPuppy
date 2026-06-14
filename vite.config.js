import { defineConfig } from "vite";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  clearScreen: false,
  server: {
    port: Number(process.env.DEV_PORT) || 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/target/**"],
    },
  },
  build: {
    outDir: "dist",
    target: "esnext",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        pet: resolve(__dirname, "windows/pet.html"),
        login: resolve(__dirname, "windows/login.html"),
        connect: resolve(__dirname, "windows/connect.html"),
      },
    },
  },
});
