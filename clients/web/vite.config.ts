import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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

/**
 * 서비스 워커를 빌드 끝에서 찍어낸다 (goal B10).
 *
 * `public/`에 그냥 두지 않는 이유는 하나다: 거기 있는 파일은 빌드마다 **바이트가
 * 같다**. 브라우저는 sw.js를 바이트로 비교해서 업데이트를 판단하므로, 정적
 * 워커는 배포를 해도 자기가 낡았다는 사실을 영영 모른다. 여기서 두 자리를
 * 채우면 그 문제가 사라진다.
 *
 *   __MOMO_BUILD_ID__      번들 파일 이름(내용 해시 포함)에서 뽑은 값. 앱이
 *                          바뀌면 바뀌고, 안 바뀌면 그대로다. 그래서 빌드는
 *                          재현 가능한 채로 남고, 같은 소스를 두 번 빌드해도
 *                          쓸데없는 워커 업데이트가 생기지 않는다.
 *   __MOMO_SHELL_ASSETS__  설치 때 미리 받아 둘 셸. 문서와 진입 청크, 그 청크가
 *                          정적으로 부르는 청크, 그리고 CSS. 지연 로드되는
 *                          청크(xterm, LiveKit)는 일부러 뺀다: 쓰지도 않을 수
 *                          있는 수백 KB를 설치 순간에 내려받게 하는 것은 콜드
 *                          스타트를 줄이는 것이 아니라 늘리는 일이다.
 */
function momoServiceWorker(): Plugin {
  const source = path.resolve(__dirname, "src/features/pwa/sw.js");
  return {
    name: "momo-service-worker",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const template = readFileSync(source, "utf8");
      const entry = Object.values(bundle).find(
        (file) => file.type === "chunk" && file.isEntry
      );
      // `/theme-boot.js`는 번들 그래프에 없다: public/의 정적 파일이라 진입 청크가
      // import하지 않는다. 그래도 셸에 속한다. 그 파일이 오지 못하면 저장된 테마가
      // 첫 페인트에 적용되지 않고, 홈 화면 앱의 콜드 스타트는 정확히 네트워크가
      // 없을 수 있는 그 순간이다. 이름에 내용 해시가 없지만 캐시가 빌드마다 통째로
      // 갈리므로(CACHE = oort-shell-${BUILD_ID}) 낡을 창은 생기지 않는다.
      const shell = ["/index.html", "/theme-boot.js"];
      if (entry && entry.type === "chunk") {
        shell.push(`/${entry.fileName}`);
        for (const imported of entry.imports) shell.push(`/${imported}`);
        for (const css of entry.viteMetadata?.importedCss ?? []) {
          shell.push(`/${css}`);
        }
      }

      // 빌드 아이덴티티는 산출물 이름 전체 + 워커 템플릿 자신이다. 파일 이름에
      // 내용 해시가 들어 있으므로 앱 코드가 바뀌면 여기가 바뀌고, 워커 자체를
      // 고쳐도 바뀐다.
      const buildId = createHash("sha256")
        .update(Object.keys(bundle).sort().join("\n"))
        .update(template)
        .digest("hex")
        .slice(0, 12);

      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: template
          .replace("__MOMO_BUILD_ID__", buildId)
          .replace("__MOMO_SHELL_ASSETS__", JSON.stringify(shell)),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwind(), momoServiceWorker()],
  resolve: {
    // `@momo/core` is the shared, platform-free domain layer (ADR-0137 D3). It
    // is an npm workspace at packages/momo-core, but the web client resolves it
    // by path rather than through node_modules on purpose: an alias cannot drift
    // with a lockfile, and this client's dependency graph — the thing every
    // bundle-size and behaviour comparison in goal RN-C1 is measured against —
    // stays byte-identical to what it was before the extraction.
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@momo/core": path.resolve(__dirname, "../../packages/momo-core/src"),
    },
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
