import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// The app lives in Frontend/; the domain layer it imports lives in src/domain/.
// One repo, one node_modules, no workspace machinery — the domain layer is the
// point of sharing, and a package boundary between them would only make the
// prototype harder to wire to the real backend later.
export default defineConfig({
  root: fileURLToPath(new URL("./Frontend", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@domain": fileURLToPath(new URL("./src/domain", import.meta.url)),
      "@app": fileURLToPath(new URL("./Frontend/src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    open: true,
    fs: {
      // src/domain is outside the Vite root, so it has to be allowed explicitly.
      allow: [fileURLToPath(new URL(".", import.meta.url))],
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./Frontend/dist", import.meta.url)),
    emptyOutDir: true,
  },
});
