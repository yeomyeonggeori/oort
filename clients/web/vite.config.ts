import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

// momo web v0 (ADR-0119 D2-A): Vite + React + TypeScript.
//
// Production serving is same-origin behind Caddy ({$APP_DOMAIN} site,
// infra/prod/Caddyfile): the SPA and /v1/* live on one origin, so the app
// calls the API with relative paths and needs no CORS. The dev proxy below
// mirrors that shape for local iteration only; it is not a deploy path.
//
// The serving CSP is strict (no inline script/style). The production build
// must not emit inline <script>/<style> into index.html — Vite's default
// output (external module + external stylesheet) satisfies this; keep it
// that way when touching build options.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/v1": {
        target: process.env.MOMO_DEV_API_URL ?? "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },
  build: {
    sourcemap: false,
  },
});
