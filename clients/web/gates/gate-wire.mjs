#!/usr/bin/env node
// GATE — malformed JSON must not blank the signed-in shell (MOMO-632).
//
// This deliberately serves values a typed DTO cannot describe: null, missing
// fields, and a value of the wrong primitive kind. The assertion is structural,
// not a screenshot: React must retain a root child and the sidebar navigation
// must remain usable while the affected panel reports its own empty/error state.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.WIRE_GATE_PORT || 5180);
const origin = `http://127.0.0.1:${port}`;
const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const session = {
  accessToken: "gate-only-not-a-credential", refreshToken: "gate-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: `ws://127.0.0.1:${port + 900}/connection/websocket`,
};

function json(route, body) {
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function installFaults(context) {
  await context.route("**/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/refresh") return json(route, {
      accessToken: "gate-only-not-a-credential", refreshToken: "gate-only-not-a-credential",
    });
    if (path.endsWith("/channels")) return json(route, { channels: null });
    if (path.endsWith("/roster")) return json(route, { members: {} });
    if (path.endsWith("/read-state")) return json(route, { read_states: "wrong" });
    if (path.includes("/messages")) return json(route, { messages: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: null });
    if (path.endsWith("/work-tier-policy") || path.endsWith("/work-tier-policy/me")) return json(route, {});
    if (path.endsWith("/invites")) return json(route, { invites: {} });
    if (path.endsWith("/approvals")) return json(route, { approvals: "wrong" });
    if (path === "/v1/provider/link") return json(route, { configured: true, diagnostics: null });
    return json(route, {});
  });
}

async function waitForServer() {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    try { if ((await fetch(origin)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("preview server never came up");
}

async function assertShell(page, surface) {
  await page.waitForTimeout(350);
  const state = await page.evaluate(() => ({
    rootChildren: document.getElementById("root")?.children.length ?? 0,
    sidebar: Boolean(document.querySelector("nav[aria-label='워크스페이스 탐색']")),
    settings: Boolean(document.querySelector('[data-testid="settings-route"]')),
    // Only the boundary's own fallback counts. Inline field/section errors also
    // use role=alert and are exactly the graceful degradation we want to keep.
    caught: Boolean(document.querySelector('[data-testid="render-error-boundary"]')),
  }));
  if (state.rootChildren === 0 || !state.sidebar || !state.settings) {
    throw new Error(`${surface}: shell blanked: ${JSON.stringify(state)}`);
  }
  // Without this the gate proves only that the error boundary works: a render
  // throw is caught, the route shell survives, and every assertion above still
  // holds while the wire validation is broken (measured — reverting
  // `listWorkHosts` to its unchecked unwrap kept this gate green). The section
  // must degrade to its own empty state, not be rescued mid-render.
  if (state.caught) {
    throw new Error(
      `${surface}: the error boundary caught a render throw — wire validation ` +
      `did not degrade this section gracefully: ${JSON.stringify(state)}`
    );
  }
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  const server = spawn(resolve(webRoot, "node_modules/.bin/vite"), ["preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: webRoot, stdio: "ignore" });
  try {
    await waitForServer();
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
      await installFaults(context);
      const page = await context.newPage();
      await page.goto(origin, { waitUntil: "networkidle" });
      await page.getByTestId("login-email").fill("wire@example.test");
      await page.getByTestId("login-password").fill("not-a-secret");
      await page.getByTestId("login-submit").click();
      await page.waitForSelector("nav[aria-label='워크스페이스 탐색']");
      // 설정 진입은 <Link>라 role=link다. 사이드바가 이 컨트롤을 어떤 요소로
      // 그리는지에 게이트가 묶이지 않도록 testid로 잡는다.
      await page.getByTestId("nav-settings").click();
      await page.waitForSelector('[data-testid="settings-route"]');
      for (const [section, label] of [["ai", "AI 연결"], ["code", "코드 실행 호스트"], ["members", "멤버와 초대"], ["account", "계정"]]) {
        await page.getByRole("button", { name: label, exact: true }).click();
        await assertShell(page, `settings ${section}`);
      }
      await context.close();
    } finally { await browser.close(); }
  } finally { server.kill("SIGTERM"); }
  console.log("GATE PASS: malformed wire responses kept the shell and navigation alive.");
}

main().catch((error) => { console.error(error); process.exit(1); });
