import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import path from "node:path";

// Tauri expects a fixed dev port and does not want Vite to obscure Rust errors.
// The desktop shell (clients/desktop) loads this exact dev server, so the same
// bundle runs in the browser and inside the WKWebView — the "one codebase"
// proof for ADR-0133.
const host = process.env.TAURI_DEV_HOST;

// Same-origin REST by design (ADR-0119 D1-A / ADR-0110): the browser talks to a
// relative /v1, and the dev/preview server proxies it to momowebqa so there is
// no CORS (the momowebqa REST server emits none). Port 5173 is the origin
// Centrifugo whitelists for local dev (infra/centrifugo.json client
// allowed_origins), so the realtime WS — dialed at the login-returned address,
// never derived — is accepted. The proxy target is overridable for other envs.
const proxyTarget = process.env.MOMO_PROXY_TARGET || "http://127.0.0.1:28000";
const proxy = {
  "/v1": { target: proxyTarget, changeOrigin: true },
  "/health": { target: proxyTarget, changeOrigin: true },
};

// Used only by `gates/gate-csp.mjs`: it serves the production `dist/` through
// Vite preview with the desktop shell policy read from tauri.conf.json. Keeping
// the value out of this file means the gate cannot drift from the packaged CSP.
const cspGateHeader = process.env.MOMO_CSP_GATE_HEADER;

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    proxy,
    hmr: host ? { protocol: "ws", host, port: 5174 } : undefined,
  },
  preview: {
    port: 5173,
    strictPort: true,
    proxy,
    ...(cspGateHeader
      ? { headers: { "Content-Security-Policy": cspGateHeader } }
      : {}),
  },
});
