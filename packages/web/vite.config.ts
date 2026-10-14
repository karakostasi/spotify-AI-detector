import { defineConfig } from "vite";
import { resolve } from "node:path";

// Spotify requires loopback redirect URIs to use 127.0.0.1, not "localhost" (used by the cleaner's login).
export default defineConfig({
  server: { host: "127.0.0.1", port: 5173, open: true, proxy: { "/api": "http://127.0.0.1:8787" } },
  build: {
    rollupOptions: { input: { main: resolve(__dirname, "index.html"), cleaner: resolve(__dirname, "cleaner.html") } },
  },
});
