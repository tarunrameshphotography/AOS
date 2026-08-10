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
    // The API runs as its own process on 4321 (Backend/api-server.ts). Proxying
    // it under the dev server's own origin rather than calling it directly
    // means the browser makes same-origin requests: no CORS preflight on every
    // mutation, and one base path (`/api`) that is identical in dev, in the
    // Playwright suite, and behind whatever serves the built app in the office.
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.AOS_API_PORT ?? 4321}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./Frontend/dist", import.meta.url)),
    emptyOutDir: true,
  },
});
