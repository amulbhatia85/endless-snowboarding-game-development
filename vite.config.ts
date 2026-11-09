import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  // In sandboxed preview environments (e.g. e2b) the dev server is proxied under
  // an external hostname; opt in to allowing arbitrary hosts when previewing.
  server: process.env.ALLOW_PREVIEW_HOSTS === "1" ? { allowedHosts: true } : undefined,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
