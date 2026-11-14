#!/usr/bin/env node
// =============================================================================
// #5785 (QA 14 1단) 캡처 + 실측: 워크스페이스 추가 창 두 카드 · 프로필 메뉴의 워크스페이스 줄 묶음.
//
//   npm run build && OUT_DIR=<스크래치>/cap5785 node scripts/capture-5785.mjs
//
// 진짜 앱 셸을 번들 Chromium(헤드리스)으로 열고 `/v1/**`는 고정 응답, 실시간 소켓은 곧바로 연결되는 흉내다
// (운영 환경에 닿지 않는다). 브라우저 언어는 ko-KR(사전 문구가 한국어로 그려진다).
//
// 크기: 1280×800(2x) · 최소 창 720×480(1x) · 200%(1280×800 창의 200% = 640×400 CSS, 2x). 밝게·어둡게.
//
//   cards-owner      레일 「+」 → 두 카드(소유자: 만들기 카드는 「서버 운영자만」, 열림)
//   cards-member     같은 창, 명부가 멤버라 만들기 카드가 「이 계정으로는 만들 수 없어요」(aria-disabled)
//   create-form      만들기 카드 → 폼(설명은 설정 › 워크스페이스와 같은 문장)
//   join-step        참여 카드 → 주소 칸에 초대 링크
//   join-confirm     계속 → 확인 걸음(웹: 새 탭 / 데스크탑의 다른 서버: 로그인 화면이 받는 링크 · 복사 · 로그아웃)
//   profile-menu     프로필 카드 → 메뉴(내 상태 → 워크스페이스 이름 머리글 → 네 줄)
//   leave-confirm    「워크스페이스 나가기」 → 확인 창
//   leave-last-owner 나가기 → 서버 409 → 창 안의 거절 문장(로그아웃 안 됨)
//   handoff          (1280 밝게만, 데스크탑) 다른 서버의 초대 → 확인 걸음은 넘기지 않는다 → 「로그아웃」 → 로그인 화면이
//                    지금 서버의 로그인 걸음으로 서고, 원래 서버의 답이 늦게 와도 칩·저장된 서버·초점이 그대로다.
//                    로그아웃 요청은 원래 서버로 1건, 넘어갈 서버에 인증 값이 실린 요청 0건.
//   menu-steady      (네 크기) 「서버 주소 복사」 전 · 직후 · 2.5초 뒤 메뉴의 모든 줄의 y와 메뉴의 높이 · 위 끝 ·
//                    스크롤이 같다(±0.5px). 다섯 줄 각각에 포인터를 둔 채 복사하고 2.5초 뒤에도 포인터 밑이 같은 줄.
//
// `CAPTURE_DIST=<폴더>`이면 그 빌드를 연다(고치기 전 빌드로 RED를 볼 때).
//
// 단정이 하나라도 빨가면 exit 1.
// =============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

/** 웹 배포의 CSP(`infra/rust/Caddyfile`의 모양): 다른 출처로의 fetch는 전부 막힌다. 미리보기 응답 머리글로 단다. */
const PROD_CSP = "default-src 'self'; connect-src 'self' ws://localhost:* ws://127.0.0.1:* https://www.googleapis.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'";
const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/cap5785");
const PORT = Number(process.env.CAPTURE_PORT || 5785);
/** `ONLY=member` 처럼 주면 그 묶음만 돈다(owner · member · handoff). */
const ONLY = (process.env.ONLY || "").split(",").map((v) => v.trim()).filter(Boolean);
const wants = (name) => ONLY.length === 0 || ONLY.includes(name);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const channels = [
  { id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "general", muted: false },
  { id: "00000000-0000-7000-8000-000000000202", workspaceId, kind: "public", name: "엔진", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "김도현", handle: "dohyeon" },
  realtimeWebSocketUrl: "ws://cap-5785.invalid/connection/websocket",
};
const rosterFor = (role) => [
  {
    id: memberId, workspaceId, kind: "human", status: "active", role, displayName: "김도현", handle: "dohyeon",
    channelCount: 2, channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0,
  },
];
const WORKSPACE = {
  id: workspaceId, slug: "saebyeok", name: "새벽팀", updatedAtMs: 1_760_000_000_000,
  roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: false,
};
// 서버가 만드는 초대 코드 모양(base64url 24자). 캡처용 가짜 값이다.
const INVITE_SHAPE = "Q".repeat(24);
const JOIN_INPUT = `https://team.example.com/?code=${INVITE_SHAPE}`;

const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const results = [];
function check(tag, name, ok, detail) {
  results.push({ tag, name, ok: Boolean(ok), detail });
  console.log(JSON.stringify({ tag, check: name, ok: Boolean(ok), detail }));
}

/** 참여 걸음이 로그아웃 전에 닿는지 보는 요청(`/healthz`, no-cors). 닿는 주소는 응답하고 `unreachable` 호스트는 끊는다. */
async function installHealthRoutes(context) {
  await context.route("**/healthz", async (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host.startsWith("unreachable.")) return route.abort("namenotresolved");
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "{}" });
  });
}

/** 나가기 응답을 늦추는 시간(ms). 0이면 곧바로 409. */
let leaveDelayMs = 0;
/** 원래 서버의 로그아웃 답을 늦추는 시간(ms). */
let holdLogoutMs = 0;
/** `/v1/**` 요청마다 출처 · 경로 · 인증 값(머리글 · 본문의 refresh 값)이 실렸는지. 값 자체는 적지 않는다. */
const apiLog = [];

async function installRoutes(context, role, pageOrigin) {
  await installHealthRoutes(context);
  // 새 탭이 열 「다른 서버」: 닿는 것처럼 빈 페이지로 답한다(요청이 그 주소로 갔는지만 본다).
  await context.route("https://team.example.com/**", async (route) => {
    if (new URL(route.request().url()).pathname === "/healthz") return route.fulfill({ status: 200, body: "{}" });
    return route.fulfill({ status: 200, contentType: "text/html", body: "<title>team</title>" });
  });
  await context.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const headers = await req.allHeaders();
    apiLog.push({ origin: url.origin, path, auth: Boolean(headers.authorization) || /refreshToken/.test(req.postData() ?? "") });
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/logout") {
      if (holdLogoutMs > 0 && url.origin === pageOrigin) await new Promise((r) => setTimeout(r, holdLogoutMs));
      return json(route, {});
    }
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    // 나가기는 늘 마지막 소유자 409다(캡처가 실제로 로그아웃되지 않게).
    if (path === `/v1/workspaces/${workspaceId}/members/me` && method === "DELETE") {
      if (leaveDelayMs > 0) await new Promise((r) => setTimeout(r, leaveDelayMs));
      return json(route, { error: "last owner" }, 409);
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: rosterFor(role) });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: WORKSPACE });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}

async function installRealtime(page) {
  await page.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) {
        this.url = String(url);
        this.readyState = 0;
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "cap-5785", version: "6" } };
          if (c.subscribe) return { id: c.id, subscribe: { recoverable: true, positioned: true, recovered: false, epoch: "cap", offset: 0 } };
          return { id: c.id };
        });
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    }
    window.WebSocket = CaptureSocket;
  });
}

/**
 * 데스크탑 셸의 키체인 대역: 셸 명령 몇 개만 흉내 낸다(키체인 있음 · 저장 · 손잡이 · 셸이 나르는 갱신과 폐기).
 * 셸이 받은 갱신 · 폐기 요청의 `apiBase`만 적는다. 폐기의 답은 3초 늦춘다(그동안 저장된 서버를 본다).
 * 나머지 명령은 셸이 없는 것처럼 거절한다.
 */
async function installKeychainShell(page) {
  await page.addInitScript(() => {
    const handle = "shell:0123456789abcdef0123456789abcdef";
    let stored = false;
    let callbacks = 0;
    window.__shellCalls = [];
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => (callbacks += 1),
      unregisterCallback: () => {},
      convertFileSrc: (path) => path,
      invoke: async (cmd, args) => {
        const apiBase = args?.request?.apiBase;
        if (cmd === "keychain_available") return true;
        if (cmd === "keychain_store_refresh_token") { stored = true; return null; }
        if (cmd === "keychain_refresh_token_handle") return stored ? handle : null;
        if (cmd === "keychain_clear_refresh_token") { stored = false; return null; }
        if (cmd === "session_rotation_begin" || cmd === "session_rotation_end") return null;
        if (cmd === "session_refresh_attempt") {
          window.__shellCalls.push({ cmd, apiBase });
          return { status: 200, accessToken: "capture-access", refreshToken: handle, proved: true };
        }
        if (cmd === "session_revoke") {
          window.__shellCalls.push({ cmd, apiBase });
          await new Promise((r) => setTimeout(r, 3_000));
          return true;
        }
        throw new Error(`capture: no shell command ${cmd}`);
      },
    };
  });
}

async function newContext(browser, origin, scheme, vp, role, desktop = false, keychain = false) {
  const context = await browser.newContext({
    viewport: { width: vp.w, height: vp.h },
    deviceScaleFactor: vp.dpr,
    colorScheme: scheme,
    locale: "ko-KR",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin }).catch(() => {});
  await installRoutes(context, role, new URL(origin).origin);
  const page = await context.newPage();
  // 데스크탑 길: 셸 판정(`IS_TAURI`)이 읽는 전역만 단다. 나머지 셸 호출은 없다.
  if (desktop) await page.addInitScript(() => { window.__TAURI__ = {}; });
  if (keychain) await installKeychainShell(page);
  await page.addInitScript(() => {
    window.__cspv = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__cspv.push(e.blockedURI));
  });
  await installRealtime(page);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없음 */ } }, origin);
  return { context, page };
}

async function signIn(page, origin) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("dohyeon@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("workspace-current").waitFor({ state: "attached", timeout: 30_000 });
}

const shots = [];
async function shot(page, tag, name) {
  await page.waitForTimeout(250);
  const file = `${name}-${tag}.png`;
  await page.screenshot({ path: resolve(OUT_DIR, file) });
  shots.push(file);
  console.log("shot", file);
}

/** 화면 안에 다 들어가는가(가로 넘침 0, 아래 끝이 창 안). */
async function fits(page, tag, name, testId) {
  const box = await page.getByTestId(testId).boundingBox();
  const vp = page.viewportSize();
  const ok = box !== null && box.x >= 0 && box.y >= -0.5 && box.x + box.width <= vp.width + 0.5 && box.y + box.height <= vp.height + 0.5;
  check(tag, `${name}: ${testId}가 창 안에 든다`, ok, box && { x: Math.round(box.x), top: Math.round(box.y), right: Math.round(box.x + box.width), bottom: Math.round(box.y + box.height), vw: vp.width, vh: vp.height });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(tag, `${name}: 가로 넘침 0`, overflow <= 0, { overflow });
}

async function openAdd(page) {
  const opener = page.getByTestId("add-workspace");
  await opener.waitFor({ state: "attached", timeout: 10_000 });
  await opener.evaluate((el) => el.click());
  await page.getByTestId("add-workspace-dialog").waitFor({ timeout: 10_000 });
}

async function closeLayers(page) {
  for (let i = 0; i < 3; i += 1) {
    if ((await page.locator("[data-overlay-layer=surface]").count()) === 0) break;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
}

async function openProfileMenu(page) {
  const card = page.getByTestId("profile-card").first();
  await card.evaluate((el) => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
    el.click();
  });
  await page.getByTestId("profile-card-menu").waitFor({ timeout: 10_000 });
}

async function ownerRun(page, origin, tag, withHandoff, keychain = false) {
  await signIn(page, origin);

  // 두 카드
  await openAdd(page);
  await page.getByTestId("add-workspace-choose-create").waitFor();
  await page.waitForTimeout(300);
  const createDisabled = await page.getByTestId("add-workspace-choose-create").getAttribute("aria-disabled");
  check(tag, "소유자: 만들기 카드는 열려 있다", createDisabled === null, { createDisabled });
  check(tag, "소유자: 만들기 카드가 「서버 운영자만」을 말한다", (await page.getByTestId("add-workspace-choose-create").innerText()).includes("서버 운영자만 만들 수 있어요"), null);
  check(tag, "참여 카드가 로그아웃 뒤 로그인 화면이라고 말한다", (await page.getByTestId("add-workspace-choose-join").innerText()).includes("로그아웃한 뒤 로그인 화면"), null);
  // 키보드: 처음 초점이 첫 카드, ↓가 둘째 카드, Tab이 「취소」.
  const first = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  await page.keyboard.press("ArrowDown");
  const second = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  await page.keyboard.press("Tab");
  const third = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  check(tag, "키보드: 첫 카드 → ↓ 참여 카드 → Tab 취소", first === "add-workspace-choose-create" && second === "add-workspace-choose-join" && third === "add-workspace-cancel", { first, second, third });
  await page.keyboard.press("Shift+Tab");
  await fits(page, tag, "cards-owner", "add-workspace-dialog");
  await shot(page, tag, "cards-owner");

  // 만들기 폼
  await page.getByTestId("add-workspace-choose-create").click();
  await page.getByTestId("add-workspace-name").waitFor();
  const nameFocused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  check(tag, "만들기 카드 → 초점이 이름 칸", nameFocused === "add-workspace-name", { nameFocused });
  check(tag, "만들기 걸음 설명은 설정 › 워크스페이스와 같은 문장", (await page.getByTestId("add-workspace-dialog").innerText()).includes("만든 사람이 소유자가 되고 #general 채널 하나로 시작해요"), null);
  await fits(page, tag, "create-form", "add-workspace-dialog");
  await shot(page, tag, "create-form");

  // 참여 걸음
  await page.getByTestId("add-workspace-back").click();
  await page.getByTestId("add-workspace-choose-join").click();
  await page.getByTestId("add-workspace-join-link").fill(JOIN_INPUT);
  await fits(page, tag, "join-step", "add-workspace-dialog");
  await shot(page, tag, "join-step");

  // 거절: 지금 서버의 주소(웹·데스크탑 같다). 로그아웃 요청 0회, 걸음은 그대로.
  let logoutRequests = 0;
  const healthHosts = [];
  const onRequest = (req) => {
    const u = new URL(req.url());
    if (u.pathname === "/v1/auth/logout") logoutRequests += 1;
    if (u.pathname === "/healthz") healthHosts.push(u.hostname);
  };
  page.on("request", onRequest);
  await page.getByTestId("add-workspace-join-link").fill(origin);
  await page.getByTestId("add-workspace-join-next").click();
  await page.getByTestId("add-workspace-join-link-error").waitFor();
  const sameText = await page.getByTestId("add-workspace-join-link-error").innerText();
  const sameStep = await page.getByTestId("add-workspace-dialog").getAttribute("data-step");
  check(tag, "지금 서버 주소: 「이미 이 서버에 있어요」, 걸음은 join", sameText.includes("이미 이 서버에 있어요") && sameStep === "join", { sameText, sameStep });
  await fits(page, tag, "join-refuse-same", "add-workspace-dialog");
  await shot(page, tag, "join-refuse-same");
  await page.getByTestId("add-workspace-join-link").fill("javascript:alert(1)");
  await page.getByTestId("add-workspace-join-next").click();
  await page.getByTestId("add-workspace-join-link-error").waitFor();
  check(tag, "javascript: 주소는 거절되고 걸음은 join", (await page.getByTestId("add-workspace-dialog").getAttribute("data-step")) === "join", null);
  if (withHandoff) {
    // 데스크탑 길(셸 판정 true): 닿지 않는 주소는 확인 fetch 1건 뒤 거절, 로그아웃 0회.
    await page.getByTestId("add-workspace-join-link").fill("https://unreachable.example.invalid");
    await page.getByTestId("add-workspace-join-next").click();
    await page.waitForFunction(() => document.querySelector("[data-testid=add-workspace-join-link-error]")?.textContent?.includes("닿지 않아서"), null, { timeout: 10_000 });
    check(tag, "데스크탑: 닿지 않는 주소는 확인 fetch 1건 뒤 거절·로그아웃 0회", healthHosts.filter((h) => h.startsWith("unreachable.")).length === 1 && logoutRequests === 0, { healthHosts, logoutRequests });
    await shot(page, tag, "join-refuse-unreachable");
  }
  await page.waitForTimeout(300);
  const stillSignedIn = await page.getByTestId("workspace-current").count();
  check(tag, "거절들 뒤 로그아웃 요청 0회·세션 유지", logoutRequests === 0 && stillSignedIn > 0, { logoutRequests, stillSignedIn });
  await page.getByTestId("add-workspace-join-link").fill(JOIN_INPUT);
  await shot(page, tag, "join-before-next");
  await page.getByTestId("add-workspace-join-next").click();
  if (!withHandoff) {
    // 웹(운영 CSP): 다른 출처의 서버는 확인도 로그아웃도 없이 새 탭으로 연다.
    await page.getByTestId("add-workspace-join-open").waitFor({ timeout: 10_000 });
    const webText = await page.getByTestId("add-workspace-dialog").innerText();
    const href = await page.getByTestId("add-workspace-join-open").getAttribute("href");
    const rel = await page.getByTestId("add-workspace-join-open").getAttribute("rel");
    const cspv = await page.evaluate(() => window.__cspv);
    check(tag, "웹: 다른 서버는 새 탭 열기(확인 걸음, 「닿지 않아서」 0)", webText.includes("새 탭에서 열까요?") && !webText.includes("닿지 않아서"), null);
    check(tag, "웹: 열 주소가 초대 링크 그대로(서버+코드)", href === `https://team.example.com/?code=${INVITE_SHAPE}` && rel === "noopener noreferrer", { href: href?.replace(INVITE_SHAPE, "<code>"), rel });
    check(tag, "웹: 그 서버로 가는 확인 요청 0건·CSP 위반 0건", !healthHosts.includes("team.example.com") && cspv.length === 0, { healthHosts, cspv });
    await fits(page, tag, "join-open", "add-workspace-join-open");
    await shot(page, tag, "join-open");
    const popupPromise = page.context().waitForEvent("page", { timeout: 10_000 }).catch(() => null);
    await page.getByTestId("add-workspace-join-open").click();
    const popup = await popupPromise;
    const popupUrl = popup ? popup.url() : null;
    if (popup) await popup.close().catch(() => {});
    await page.waitForTimeout(300);
    check(tag, "웹: 눌러도 로그아웃 0회·세션 유지, 새 탭이 그 주소", logoutRequests === 0 && (await page.getByTestId("workspace-current").count()) > 0 && (popupUrl ?? "").startsWith("https://team.example.com"), { logoutRequests, popupUrl: popupUrl?.replace(INVITE_SHAPE, "<code>") });
  }
  page.off("request", onRequest);
  if (withHandoff) {
    // 데스크탑 길: 다른 서버는 넘기지 않는다. 확인 걸음은 로그인 화면이 받는 링크와 「복사」, 보통의 「로그아웃」이다.
    await page.getByTestId("add-workspace-join-confirm").waitFor();
    check(tag, "데스크탑: 맞는 주소의 확인 fetch 1건 뒤 확인 걸음", healthHosts.filter((h) => h === "team.example.com").length === 1, { healthHosts });
    const confirmText = await page.getByTestId("add-workspace-dialog").innerText();
    const pasteLink = await page.getByTestId("add-workspace-join-paste-link").innerText();
    const handOffButtons = await page.getByTestId("add-workspace-join-logout").count();
    check(
      tag,
      "데스크탑: 다른 서버는 넘기지 않고 링크·복사·로그아웃을 준다(초안은 말하지 않는다)",
      confirmText.includes("로그아웃할까요?") && confirmText.includes("「바꾸기」") && !confirmText.includes("초안") && pasteLink === JOIN_INPUT && handOffButtons === 0,
      { pasteLink: pasteLink.replace(INVITE_SHAPE, "<code>"), handOffButtons }
    );
    await fits(page, tag, "join-confirm", "add-workspace-join-signout");
    await shot(page, tag, "join-confirm");
    // 원래 서버의 로그아웃 답을 늦춘다: 그 답이 로그인 화면의 무엇이든 바꾸면 아래 단정이 빨갛다.
    holdLogoutMs = 3_000;
    const logFrom = apiLog.length;
    if (keychain) {
      const shellBefore = await page.evaluate(() => window.__shellCalls);
      check(tag, "키체인 대역: 로그인 뒤 셸이 갱신을 날라 세션이 손잡이 상태다", shellBefore.some((c) => c.cmd === "session_refresh_attempt"), shellBefore);
    }
    // 프레임마다 걸음 · 칩 · 초점을 적는다(누르기 전에 건다): 첫 그림부터 칸에 초점이 있고, 그 뒤로 아무것도 바뀌지 않는가.
    await page.evaluate(() => {
      const ids = ["onboarding-welcome", "onboarding-sign-in", "onboarding-join"];
      const rec = { frames: [], live: true };
      window.__loginFrames = rec;
      const tick = () => {
        if (!rec.live) return;
        const step = ids.find((id) => document.querySelector(`[data-testid=${id}]`));
        if (step) {
          const f = { step, chip: document.querySelector("[data-testid=connect-server-chip-host]")?.textContent ?? null, focus: document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName ?? null };
          const last = rec.frames[rec.frames.length - 1];
          if (!last || JSON.stringify(last) !== JSON.stringify(f)) rec.frames.push(f);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.getByTestId("add-workspace-join-signout").click();
    await page.getByTestId("onboarding-sign-in").waitFor({ timeout: 2_500 });
    const loginState = () =>
      page.evaluate(() => ({
        step: ["onboarding-welcome", "onboarding-sign-in", "onboarding-join"].find((id) => document.querySelector(`[data-testid=${id}]`)) ?? null,
        chip: document.querySelector("[data-testid=connect-server-chip-host]")?.textContent ?? null,
        stored: localStorage.getItem("momo.web.server.v1"),
        focus: document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName ?? null,
        code: location.search.includes("code="),
      }));
    const first = await loginState();
    check(tag, "로그아웃: 로그인 화면이 지금 서버의 로그인 걸음으로 서고 주소에 링크가 없다", first.step === "onboarding-sign-in" && first.stored === origin && first.chip === new URL(origin).host && !first.code, first);
    await shot(page, tag, "handoff-login");
    await page.waitForTimeout(holdLogoutMs + 500);
    const later = await loginState();
    check(tag, "로그아웃: 원래 서버의 답이 늦게 와도 걸음·칩·저장된 서버·초점이 그대로", JSON.stringify(later) === JSON.stringify(first), { first, later });
    const frames = await page.evaluate(() => {
      window.__loginFrames.live = false;
      return window.__loginFrames.frames;
    });
    check(tag, "로그아웃: 로그인 화면의 첫 프레임부터 칸에 초점이 있고 모든 프레임이 같다", frames.length === 1 && /^login-(email|password)$/.test(frames[0].focus ?? ""), { frames });
    holdLogoutMs = 0;
    const after = apiLog.slice(logFrom);
    const originLogouts = after.filter((r) => r.origin === origin && r.path === "/v1/auth/logout").length;
    const otherAuthed = after.filter((r) => r.origin === "https://team.example.com" && r.auth);
    if (keychain) {
      const revokes = (await page.evaluate(() => window.__shellCalls)).filter((c) => c.cmd === "session_revoke");
      check(tag, "키체인 대역: 셸이 받은 폐기 1건, 그 서버가 원래 서버", revokes.length === 1 && revokes[0].apiBase === origin && originLogouts === 0, { revokes, originLogouts });
    } else {
      check(tag, "로그아웃: 원래 서버가 받은 로그아웃 1건", originLogouts === 1, { originLogouts });
    }
    check(tag, "로그아웃: 넘어갈 서버에 인증 값이 실린 요청 0건", otherAuthed.length === 0, { otherAuthed });
    return;
  }
  await closeLayers(page);

  // 프로필 메뉴
  await openProfileMenu(page);
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll("[data-testid=profile-card-menu] [data-testid]")]
      .map((n) => n.getAttribute("data-testid"))
      .filter((id) => /^(profile-(set-status|workspace-head|copy-address|workspace-settings|leave-workspace|add-workspace|logout)|nav-settings)$/.test(id))
  );
  check(tag, "메뉴 차례: 상태 설정 → 이름 머리글 → 주소 복사·설정·나가기·추가 → 설정 → 로그아웃", JSON.stringify(ids) === JSON.stringify(["profile-set-status", "profile-workspace-head", "profile-copy-address", "profile-workspace-settings", "profile-leave-workspace", "profile-add-workspace", "nav-settings", "profile-logout"]), ids);
  // 줄마다 아이콘(점 칸) 왼쪽 x · 글자 시작 x. 아이콘이 한 세로 줄, 글자 시작이 한 세로 줄이어야 한다.
  const rows = await page.evaluate(() => {
    const first = (el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if ((n.textContent ?? "").trim() === "") continue;
        const r = document.createRange();
        r.selectNodeContents(n);
        return r.getBoundingClientRect().x;
      }
      return null;
    };
    const glyph = (el) => (el.querySelector("[data-testid^=presence-dot-slot-]") ?? el.querySelector("svg"))?.getBoundingClientRect();
    const ids = ["presence-option-auto", "presence-option-away", "presence-option-dnd", "profile-set-status", "profile-copy-address", "profile-workspace-settings", "profile-leave-workspace", "profile-add-workspace", "nav-settings", "profile-logout"];
    const out = ids.map((id) => {
      const el = document.querySelector(`[data-testid=${id}]`);
      const g = el ? glyph(el) : null;
      return { id, iconX: g ? Math.round(g.x * 100) / 100 : null, iconW: g ? Math.round(g.width * 100) / 100 : null, textX: el ? Math.round(first(el) * 100) / 100 : null };
    });
    return out;
  });
  console.log(JSON.stringify({ tag, rows }));
  const iconXs = rows.filter((r) => r.iconX !== null).map((r) => r.iconX);
  const textXs = rows.map((r) => r.textX);
  const spread = Math.max(...iconXs) - Math.min(...iconXs);
  const textSpread = Math.max(...textXs) - Math.min(...textXs);
  check(tag, "메뉴 열 줄의 아이콘 칸 x가 한 세로 줄(차이 ≤ 0.5px)", iconXs.length === 10 && spread <= 0.5, { iconXs, spread });
  check(tag, "메뉴 열 줄의 글자 시작 x가 한 세로 줄(차이 ≤ 0.5px)", textXs.every((x) => x !== null) && textSpread <= 0.5, { textXs, textSpread });
  check(tag, "아이콘 칸 폭이 열 줄 모두 16px", rows.filter((r) => r.iconW !== null).every((r) => r.iconW === 16), rows.map((r) => r.iconW));
  await fits(page, tag, "profile-menu", "profile-card-menu");
  const hidden = await page.evaluate(() => {
    const m = document.querySelector("[data-testid=profile-card-menu]");
    return { scrollHeight: m.scrollHeight, clientHeight: m.clientHeight, hiddenPx: m.scrollHeight - m.clientHeight };
  });
  console.log(JSON.stringify({ tag, menuHidden: hidden }));
  await shot(page, tag, "profile-menu");

  // 주소 복사(1280 밝게에서 클립보드까지 읽는다)
  const topBefore = await page.evaluate(() => document.querySelector("[data-testid=profile-copy-address]").getBoundingClientRect().y);
  await page.getByTestId("profile-copy-address").click();
  await page.waitForTimeout(200);
  const noteBox = await page.evaluate(() => {
    const n = document.querySelector("[data-testid=profile-copy-address-note]");
    const r = n.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(n.firstChild);
    return { w: Math.round(r.width), h: Math.round(r.height), sr: n.className.includes("sr-only"), textX: Math.round(range.getBoundingClientRect().x * 100) / 100 };
  });
  const topAfter = await page.evaluate(() => document.querySelector("[data-testid=profile-copy-address]").getBoundingClientRect().y);
  const copyRowShiftPx = Math.round((topAfter - topBefore) * 10) / 10;
  check(tag, "복사 뒤에도 안내 글은 낭독 전용(sr-only), 복사 줄은 움직이지 않는다(±0.5px)", noteBox.sr && Math.abs(copyRowShiftPx) <= 0.5, { ...noteBox, copyRowShiftPx });
  await shot(page, tag, "profile-menu-copied");
  const copyLabel = await page.getByTestId("profile-copy-address").innerText();
  check(tag, "서버 주소 복사 → 메뉴가 열린 채 「서버 주소 복사됨」", copyLabel.includes("서버 주소 복사됨"), { copyLabel });
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `ERR ${String(e).slice(0, 60)}`);
  check(tag, "주소 복사: 클립보드가 이 서버 주소", clip === origin, { clip, origin });

  // 나가기 확인 → (늦은 응답 동안 「취소」 잠김) → 409
  leaveDelayMs = 1_500;
  await page.getByTestId("profile-leave-workspace").click();
  await page.getByTestId("workspace-leave-dialog").waitFor();
  const leaveFocus = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  check(tag, "나가기 확인: 초점이 「취소」", leaveFocus === "workspace-leave-dialog-cancel", { leaveFocus });
  check(tag, "나가기 확인: 제목이 워크스페이스 이름", (await page.getByTestId("workspace-leave-dialog").innerText()).includes("새벽팀에서 나갈까요?"), null);
  await fits(page, tag, "leave-confirm", "workspace-leave-dialog");
  await shot(page, tag, "leave-confirm");
  check(tag, "나가기 확인: 「보낸 메시지는 남아요」", (await page.getByTestId("workspace-leave-dialog").innerText()).includes("보낸 메시지는 남아요"), null);
  await page.getByTestId("workspace-leave-dialog-confirm").click();
  await page.getByTestId("workspace-leave-dialog-cancel").evaluate((el) => el.getAttribute("aria-disabled") === "true" || new Promise((r) => setTimeout(r, 50)));
  const pendingCancel = await page.evaluate(() => {
    const el = document.querySelector("[data-testid=workspace-leave-dialog-cancel]");
    const s = getComputedStyle(el);
    return { ariaDisabled: el.getAttribute("aria-disabled"), opacity: Number(s.opacity), cursor: s.cursor };
  });
  check(tag, "나가는 동안 「취소」가 잠긴 모양(aria-disabled·옅게·not-allowed)", pendingCancel.ariaDisabled === "true" && pendingCancel.opacity < 1 && pendingCancel.cursor === "not-allowed", pendingCancel);
  await shot(page, tag, "leave-pending");
  await page.getByTestId("workspace-leave-dialog-cancel").evaluate((el) => el.click());
  check(tag, "나가는 동안 「취소」를 눌러도 창이 그대로", (await page.getByTestId("workspace-leave-dialog").count()) === 1, null);
  await page.getByTestId("workspace-leave-dialog-last-owner").waitFor({ timeout: 10_000 });
  leaveDelayMs = 0;
  const after409 = await page.evaluate(() => ({
    confirmDisabled: document.querySelector("[data-testid=workspace-leave-dialog-confirm]").hasAttribute("disabled"),
    focus: document.activeElement?.getAttribute("data-testid"),
    sentence: document.querySelector("[data-testid=workspace-leave-dialog-last-owner]").textContent,
  }));
  check(tag, "409 뒤 「나가기」가 잠기고 초점이 「취소」, 다음 걸음 문장이 있다", after409.confirmDisabled && after409.focus === "workspace-leave-dialog-cancel" && after409.sentence.includes("멤버 탭") && !after409.sentence.includes("멤버와 초대"), after409);
  const stillIn = await page.getByTestId("workspace-current").count();
  check(tag, "409: 거절 문장이 창 안에 서고 로그아웃되지 않는다", stillIn > 0, { stillIn });
  await fits(page, tag, "leave-last-owner", "workspace-leave-dialog");
  await shot(page, tag, "leave-last-owner");
}

/** 메뉴 판과 그 안의 모든 줄(머리글 · 줄 · 구분선 · 묶음 안 줄)의 위치. */
async function menuGeometry(page) {
  return page.evaluate(() => {
    const menu = document.querySelector("[data-testid=profile-card-menu]");
    const box = menu.getBoundingClientRect();
    const rows = [...menu.querySelectorAll(":scope > *, [role=group] > *")].map((el, i) => {
      const r = el.getBoundingClientRect();
      return { key: el.getAttribute("data-testid") ?? `${el.getAttribute("role") ?? el.tagName.toLowerCase()}#${i}`, y: r.y, h: r.height };
    });
    return { top: box.y, height: box.height, width: box.width, scrollTop: menu.scrollTop, rows };
  });
}

/** 두 순간의 차이(가장 큰 값). 줄 수가 다르면 Infinity. */
function geometryDelta(a, b) {
  if (a.rows.length !== b.rows.length) return { max: Infinity, moved: ["rows"] };
  const moved = [];
  let max = Math.max(Math.abs(a.top - b.top), Math.abs(a.height - b.height), Math.abs(a.scrollTop - b.scrollTop));
  if (max > 0.5) moved.push("menu");
  a.rows.forEach((r, i) => {
    const d = Math.max(Math.abs(r.y - b.rows[i].y), Math.abs(r.h - b.rows[i].h));
    if (r.key !== b.rows[i].key || d > 0.5) moved.push(`${r.key}:${Math.round((b.rows[i].y - r.y) * 10) / 10}`);
    max = Math.max(max, d);
  });
  return { max: Math.round(max * 100) / 100, moved };
}

/** (x, y) 밑의 메뉴 줄 testid. */
const rowAt = (page, x, y) =>
  page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest("[data-testid]")?.getAttribute("data-testid") ?? null, [x, y]);

/** 실제 포인터로 복사 줄을 누른다(판 안으로 먼저 보이게). 누른 시각을 돌려준다. */
async function clickCopyRow(page) {
  await page.getByTestId("profile-copy-address").evaluate((el) => el.scrollIntoView({ block: "nearest" }));
  const box = await page.getByTestId("profile-copy-address").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  return Date.now();
}

async function menuSteadyRun(page, origin, tag, withShots) {
  await signIn(page, origin);
  await closeLayers(page);
  await openProfileMenu(page);
  await page.waitForTimeout(300);
  // ① 복사 전 · ② 복사 직후(줄 글이 「복사됨」) · ③ 2.5초 뒤(줄 글이 되돌아옴).
  await page.getByTestId("profile-copy-address").evaluate((el) => el.scrollIntoView({ block: "nearest" }));
  const before = await menuGeometry(page);
  if (withShots) await shot(page, tag, "menu-steady-1-before");
  const t0 = await clickCopyRow(page);
  await page.waitForFunction(() => document.querySelector("[data-testid=profile-copy-address]")?.textContent?.includes("서버 주소 복사됨"), null, { timeout: 2_000 });
  const copied = await menuGeometry(page);
  if (withShots) await shot(page, tag, "menu-steady-2-copied");
  await page.waitForTimeout(Math.max(0, t0 + 2_500 - Date.now()));
  const label3 = await page.getByTestId("profile-copy-address").innerText();
  const later = await menuGeometry(page);
  if (withShots) await shot(page, tag, "menu-steady-3-after2500");
  const d1 = geometryDelta(before, copied);
  const d2 = geometryDelta(before, later);
  console.log(JSON.stringify({ tag, steady: { before: { top: before.top, height: before.height, scrollTop: before.scrollTop, rows: before.rows.length }, d1, d2 } }));
  check(tag, "복사 직후: 줄 글만 「서버 주소 복사됨」, 메뉴의 모든 줄 y · 높이 · 위 끝 · 스크롤이 그대로(±0.5px)", d1.max <= 0.5, d1);
  check(tag, "2.5초 뒤: 줄 글이 「서버 주소 복사」로 돌아오고 모든 줄이 그대로(±0.5px)", label3.trim() === "서버 주소 복사" && d2.max <= 0.5, { label3, ...d2 });

  // 다섯 겨눔: 복사한 뒤 그 줄에 포인터를 두고 2.5초를 기다린다. 포인터 밑은 줄곧 같은 줄이어야 한다.
  const targets = ["profile-workspace-settings", "nav-settings", "profile-leave-workspace", "profile-add-workspace", "presence-option-away"];
  for (const target of targets) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    await openProfileMenu(page);
    await page.waitForTimeout(200);
    const t1 = await clickCopyRow(page);
    // 영수증이 선 뒤에 겨눈다(사람이 복사하고 다음 줄로 옮기는 순서). 그 뒤로 메뉴가 움직이면 포인터 밑이 바뀐다.
    await page.waitForFunction(() => document.querySelector("[data-testid=profile-copy-address]")?.textContent?.includes("서버 주소 복사됨"), null, { timeout: 2_000 });
    await page.getByTestId(target).evaluate((el) => el.scrollIntoView({ block: "nearest" }));
    const box = await page.getByTestId(target).boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    const atMove = await rowAt(page, x, y);
    await page.waitForTimeout(Math.max(0, t1 + 2_500 - Date.now()));
    const atLater = await rowAt(page, x, y);
    check(tag, `포인터를 「${target}」에 둔 채 복사 → 2.5초 뒤에도 포인터 밑이 같은 줄`, atMove === target && atLater === target, { atMove, atLater, x: Math.round(x), y: Math.round(y) });
  }
}

async function memberRun(page, origin, tag) {
  await signIn(page, origin);
  await openAdd(page);
  await page.waitForFunction(() => document.querySelector("[data-testid=add-workspace-choose-create]")?.getAttribute("aria-disabled") === "true", null, { timeout: 10_000 });
  const text = await page.getByTestId("add-workspace-choose-create").innerText();
  check(tag, "멤버: 만들기 카드가 「이 계정으로는 만들 수 없어요」", text.includes("이 계정으로는 만들 수 없어요"), { text });
  await fits(page, tag, "cards-member", "add-workspace-dialog");
  await shot(page, tag, "cards-member");
  // aria-disabled 단추는 Playwright가 「누를 수 없음」으로 기다리므로 DOM 클릭으로 누른다.
  await page.getByTestId("add-workspace-choose-create").evaluate((el) => el.click());
  await page.waitForTimeout(200);
  check(tag, "멤버: 만들기 카드를 눌러도 폼으로 가지 않는다", (await page.getByTestId("add-workspace-name").count()) === 0, null);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  // 웹은 운영 CSP를, 데스크탑 길은 `tauri.conf.json`의 CSP를 문서 응답 머리글로 단 미리보기에서 잰다.
  const deskCsp = JSON.parse(readFileSync(resolve(WEB_ROOT, "../desktop/src-tauri/tauri.conf.json"), "utf8")).app.security.csp;
  const distArgs = process.env.CAPTURE_DIST ? ["--outDir", resolve(process.env.CAPTURE_DIST)] : [];
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT", extraArgs: distArgs, env: { ...process.env, MOMO_CSP_GATE_HEADER: PROD_CSP } });
  const deskPreview = wants("handoff")
    ? await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT + 1, portEnvVar: "CAPTURE_PORT", extraArgs: distArgs, env: { ...process.env, MOMO_CSP_GATE_HEADER: deskCsp } })
    : null;
  const browser = await chromium.launch();
  const allSizes = [
    { w: 1280, h: 800, dpr: 2, name: "1280" },
    { w: 720, h: 480, dpr: 1, name: "720x480" },
    { w: 640, h: 400, dpr: 2, name: "zoom200" },
  ];
  /** `SIZES=zoom200` 처럼 주면 그 크기만. */
  const SIZES = (process.env.SIZES || "").split(",").map((v) => v.trim()).filter(Boolean);
  const sizes = SIZES.length === 0 ? allSizes : allSizes.filter((v) => SIZES.includes(v.name));
  const SCHEMES = (process.env.SCHEMES || "light,dark").split(",").map((v) => v.trim()).filter(Boolean);
  try {
    for (const vp of sizes) {
      for (const scheme of SCHEMES) {
        const tag = `${vp.name}-${scheme}`;
        for (const [role, run] of [["owner", ownerRun], ["member", memberRun]]) {
          if (!wants(role)) continue;
          const { context, page } = await newContext(browser, preview.origin, scheme, vp, role);
          try {
            await run(page, preview.origin, tag, false);
          } catch (error) {
            await page.screenshot({ path: resolve(OUT_DIR, `FAIL-${role}-${tag}.png`) }).catch(() => {});
            check(tag, `${role} 장면이 끝까지 간다`, false, String(error).slice(0, 400));
          } finally {
            await context.close();
          }
        }
      }
    }
    // 메뉴가 복사 영수증 동안 움직이지 않는가: 네 크기(1280×800 · 1280×510 · 720×480 · 200%).
    if (wants("menu-steady")) {
      const steadySizes = [
        { w: 1280, h: 800, dpr: 2, name: "1280" },
        { w: 1280, h: 510, dpr: 1, name: "1280x510" },
        { w: 720, h: 480, dpr: 1, name: "720x480" },
        { w: 640, h: 400, dpr: 2, name: "zoom200" },
      ].filter((v) => SIZES.length === 0 || SIZES.includes(v.name));
      for (const vp of steadySizes) {
        for (const scheme of SCHEMES) {
          const tag = `${vp.name}-${scheme}`;
          const { context, page } = await newContext(browser, preview.origin, scheme, vp, "owner");
          try {
            await menuSteadyRun(page, preview.origin, tag, vp.name === "1280" || vp.name === "720x480");
          } catch (error) {
            await page.screenshot({ path: resolve(OUT_DIR, `FAIL-menu-steady-${tag}.png`) }).catch(() => {});
            check(tag, "menu-steady 장면이 끝까지 간다", false, String(error).slice(0, 400));
          } finally {
            await context.close();
          }
        }
      }
    }
    // 넘김은 한 번이면 된다(로그아웃한다).
    const { context, page } = wants("handoff")
      ? await newContext(browser, deskPreview.origin, "light", allSizes[0], "owner", true)
      : { context: null, page: null };
    if (page) try {
      await ownerRun(page, deskPreview.origin, "1280-light", true);
    } catch (error) {
      await page.screenshot({ path: resolve(OUT_DIR, "FAIL-handoff.png") }).catch(() => {});
      check("1280-light", "handoff 장면이 끝까지 간다", false, String(error).slice(0, 400));
    } finally {
      await context.close();
    }
    // 같은 넘김을 키체인 방식(셸이 토큰을 쥔 상태) 대역으로 한 번 더.
    const keyed = wants("handoff")
      ? await newContext(browser, deskPreview.origin, "light", allSizes[0], "owner", true, true)
      : null;
    if (keyed) try {
      await ownerRun(keyed.page, deskPreview.origin, "1280-light-keychain", true, true);
    } catch (error) {
      await keyed.page.screenshot({ path: resolve(OUT_DIR, "FAIL-handoff-keychain.png") }).catch(() => {});
      check("1280-light-keychain", "handoff(키체인) 장면이 끝까지 간다", false, String(error).slice(0, 400));
    } finally {
      await keyed.context.close();
    }
  } finally {
    await browser.close();
    await preview.stop?.();
    await deskPreview?.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  writeFileSync(resolve(OUT_DIR, "results.json"), JSON.stringify({ shots, results }, null, 1));
  console.log(bad.length === 0 ? `PASS ${results.length} checks, ${shots.length} shots` : `FAIL ${bad.length}/${results.length}`);
  process.exit(bad.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
