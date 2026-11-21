import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const workerOrigin = "http://127.0.0.1:8787";

const proxy = {
  "/api": workerOrigin,
  "/auth": workerOrigin,
  "/authorize": workerOrigin,
  "/callback": workerOrigin,
  "/mcp": workerOrigin,
  "/oauth": workerOrigin,
  "/.well-known": workerOrigin,
  "/health": workerOrigin,
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 4173, strictPort: true, proxy },
});
