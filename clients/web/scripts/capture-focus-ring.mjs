#!/usr/bin/env node
// =============================================================================
// 포커스 링 실측 (#2938 ②): 포인터로 움직일 때 링이 서는가, 키보드일 때 서는가.
//
// 성재 0.1.12(데스크탑): 「설정 창이나 그런 곳 가면 포커스링 같은 게 노출」.
// 데스크탑 셸은 WKWebView(WebKit)다. WebKit은 마우스로 누른 <button>에 포커스를
// 주지 않고, 그 뒤 스크립트가 옮긴 포커스(설정 진입 포커스·포커스 복귀·다이얼로그
// 첫 칸)를 `:focus-visible`로 친다. Chromium은 누른 버튼이 포커스를 받아 같은
// 흐름에서 링이 서지 않는다. 그래서 이 스크립트는 **WebKit과 Chromium 둘 다**
// 제품 빌드(dist)로 같은 흐름을 몰고, 각 단계에서 캐럿이 있는 요소의 실제 계산된
// outline을 잰다.
//
//   npm run build && node scripts/capture-focus-ring.mjs
//   OUT_DIR=/tmp/shots node scripts/capture-focus-ring.mjs
//
// 출력: 단계별 JSON 한 줄(엔진·단계·요소·:focus-visible·outline) + 스크린숏.
// 기대: 포인터 단계는 링 0, 키보드 탐색 단계(Tab·화살표)는 링 있음. null은 기록만.
// 끝 코드는 기대와 다른 단계가 있으면 1이다.
// =============================================================================

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/design");
const PORT = Number(process.env.CAPTURE_PORT || 5193);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 1280, height: 800 };

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";

const SESSION = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: {
    id: ME,
    workspaceId: WORKSPACE_ID,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  realtimeWebSocketUrl: `ws://127.0.0.1:${PORT + 900}/connection/websocket`,
};

const CHANNELS = [
  { id: GENERAL_ID, workspaceId: WORKSPACE_ID, kind: "public", name: "general", muted: false },
];

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installMocks(context) {
  await context.route("**/v1/**", (route) =>
    json(route, { channels: [], members: [], read_states: [], messages: [] })
  );
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
  await context.route("**/v1/auth/refresh", (route) =>
    json(route, { accessToken: SESSION.accessToken, refreshToken: SESSION.refreshToken })
  );
  await context.route("**/v1/auth/realtime-token", (route) =>
    json(route, {
      token: "capture-only-not-a-credential",
      tokenType: "jwt",
      expiresAtMs: Date.now() + 60_000,
      ttlSeconds: 60,
      workspaceId: WORKSPACE_ID,
      memberId: ME,
    })
  );
  await context.route("**/v1/workspaces/*/channels", (route) =>
    json(route, { channels: CHANNELS })
  );
  await context.route("**/v1/workspaces/*/roster", (route) => json(route, { members: [] }));
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`preview server never came up: ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** 캐럿이 있는 요소와 그 요소에 실제로 그려지는 outline. */
async function ring(page) {
  await page.waitForTimeout(250);
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || el === document.body) {
      return { el: "body", focusVisible: false, outline: "none", ringed: false };
    }
    const style = getComputedStyle(el);
    const ringed =
      style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
    const id = el.getAttribute("data-testid") ?? el.id ?? "";
    return {
      el: `${el.tagName.toLowerCase()}${id ? `[${id}]` : ""}`,
      focusVisible: el.matches(":focus-visible"),
      outline: `${style.outlineStyle} ${style.outlineWidth}`,
      ringed,
    };
  });
}

async function run(browserType, engine) {
  const browser = await browserType.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  await installMocks(context);
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });

  const rows = [];
  let bad = 0;
  async function step(name, expectRing, shot = false) {
    const got = await ring(page);
    const ok = expectRing === null || got.ringed === expectRing;
    if (!ok) bad += 1;
    const row = { engine, step: name, expectRing, ...got, ok };
    rows.push(row);
    console.log(JSON.stringify(row));
    if (shot) {
      await page.screenshot({ path: `${OUT_DIR}/focus-ring-${engine}-${name}.png` });
    }
  }

  const mod = process.platform === "darwin" ? "Meta" : "Control";

  // ── 포인터 흐름: 링이 서면 안 된다 ──────────────────────────────────────────
  // ① 프로필 카드 → 설정(메뉴 항목). 설정은 진입 때 현재 절 버튼에 캐럿을 둔다.
  await page.getByTestId("profile-card").click();
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-route").waitFor({ state: "visible" });
  await step("pointer-settings-enter", false, true);

  // ② 절 목록에서 AI 연결을 마우스로. WebKit은 버튼 대신 가장 가까운 포커스
  //    가능한 조상(라우트 상자, tabindex=-1)에 캐럿을 준다.
  await page.getByTestId("settings-nav-ai").click();
  await step("pointer-settings-nav-ai", false, true);

  // ③ 마우스로 쓰던 사람이 Esc로 설정을 닫는다 → 캐럿 복귀.
  await page.keyboard.press("Escape");
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
  await step("pointer-then-escape-return", false, true);

  // ④ 본문을 마우스로 누른 뒤 ⌘, 로 설정을 연다 → 진입 포커스.
  await page.mouse.click(900, 300);
  await page.keyboard.press(`${mod}+Comma`);
  await page.getByTestId("settings-route").waitFor({ state: "visible" });
  await step("pointer-then-shortcut-settings-enter", false, true);

  // ⑤ 마우스로 절을 누른 뒤 아무 키(여기서는 Shift)를 누른다.
  await page.getByTestId("settings-nav-ai").click();
  await page.keyboard.press("Shift");
  await step("pointer-then-modifier-key", false, true);

  // ⑤b 마우스로 절을 누른 뒤 화살표. WebKit은 캐럿이 라우트 상자(tabindex=-1,
  //     착지점)에 있어 UA 기본 링(outline: auto)이 판 전체를 둘렀다. Chromium은
  //     캐럿이 절 버튼에 있어 화살표가 다음 절로 옮기고 링이 선다(키보드 탐색).
  await page.getByTestId("settings-nav-ai").click();
  await page.keyboard.press("ArrowDown");
  await step("pointer-then-arrow", engine !== "webkit", true);

  // ⑥ 앱으로 돌아가기(마우스) → 캐럿 복귀.
  await page.getByTestId("settings-back-to-app").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
  await step("pointer-settings-return", false, true);

  // ⑦ 단축키로 팔레트를 열고 Esc로 닫는다 → 여는 이에게 캐럿 복귀(모달).
  await page.getByTestId("channel-list").click({ position: { x: 20, y: 20 } });
  await page.keyboard.press(`${mod}+KeyK`);
  await page.getByTestId("quick-switcher").waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.getByTestId("quick-switcher").waitFor({ state: "detached" });
  await step("pointer-palette-escape-return", false, true);

  // ── 키보드 흐름: 링이 서야 한다(접근성 회귀 금지) ─────────────────────────
  // ⑧ Tab으로 버튼에 닿을 때까지. WebKit 기본값(macOS 「Tab으로 모든 항목」 꺼짐)은
  //    Tab이 버튼에 가지 않는다 — 엔진 기본값이라 여기서는 기록만 한다.
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press("Tab");
    const tag = await page.evaluate(() => document.activeElement?.tagName ?? "");
    if (tag === "BUTTON" || tag === "A") break;
  }
  await step("keyboard-tab", engine === "webkit" ? null : true, true);

  // ⑧ Tab 뒤 ⌘, → 진입 포커스(키보드 사용자에게는 링).
  await page.keyboard.press(`${mod}+Comma`);
  await page.getByTestId("settings-route").waitFor({ state: "visible" });
  await step("keyboard-settings-enter", true, true);

  // ⑨ 절 목록 화살표 이동.
  await page.keyboard.press("ArrowDown");
  await step("keyboard-arrow-in-settings-nav", true, true);

  // ⑩ 마우스를 누르면 링이 걷힌다.
  await page.getByTestId("settings-nav-ai").click();
  await step("keyboard-then-pointer", false);

  // ⑪ 다시 화살표 → 링.
  await page.getByTestId("settings-nav-ai").focus();
  await page.keyboard.press("ArrowUp");
  await step("keyboard-arrow-after-pointer", true, true);

  await context.close();
  await browser.close();
  return bad;
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run `npm run build` first.");
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const server = spawn(
    resolve(WEB_ROOT, "node_modules/.bin/vite"),
    ["preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: WEB_ROOT, stdio: "ignore" }
  );
  const shutdown = () => server.kill("SIGTERM");
  process.on("exit", shutdown);
  let bad = 0;
  try {
    await waitForServer(ORIGIN);
    const engines = (process.env.ENGINES || "webkit,chromium").split(",");
    if (engines.includes("webkit")) bad += await run(webkit, "webkit");
    if (engines.includes("chromium")) bad += await run(chromium, "chromium");
  } finally {
    shutdown();
  }
  console.log(bad === 0 ? "FOCUS-RING PASS" : `FOCUS-RING FAIL (${bad} steps)`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
