import { readPetRegistry } from "./tools/petRegistry.mjs";
import { resolveBackendEnvironment } from "./src/shared/backendConfig.js";
import { defineConfig, loadEnv } from "vite";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  resolveBackendEnvironment(loadEnv(mode, __dirname, "VITE_"));
  return {
  clearScreen: false,
  test: { include: ["src/**/*.test.ts", "tools/**/*.test.{ts,mjs}"] },
  plugins: [{
    name: "pet-assets",
    resolveId(id) { if (id === "virtual:pet-assets") return "\0pet-assets"; },
    load(id) {
      if (id !== "\0pet-assets") return;
      const assets = readPetRegistry(resolve(__dirname, "public/pets"));
      for (const pet of Object.values(assets)) this.addWatchFile(resolve(__dirname, "public/pets", pet.dir, "pet.json"));
      return `export default ${JSON.stringify(assets)};`;
    },
  }],
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
        bubble: resolve(__dirname, "windows/bubble.html"),
        toast: resolve(__dirname, "windows/toast.html"),
        lounge: resolve(__dirname, "windows/lounge.html"),
      },
    },
  },
  };
});
