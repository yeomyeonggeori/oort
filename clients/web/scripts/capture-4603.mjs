#!/usr/bin/env node
// =============================================================================
// #4603 · #4601 캡처 + 실제 브라우저 확인: 관리자 「재설정 링크 만들기」와 로그인 「비밀번호를 잊으셨나요?」·claim 화면
// (ADR-0215 D5·D6·D8). 백엔드 없음(`/v1/**` 고정 응답, 가짜 소켓, 외부 네트워크 0). 인물은 가상 인물이다.
//
//   npm run build && OUT_DIR=<폴더> node scripts/capture-4603.mjs
//
// 번들 Chromium(헤드리스)만 쓴다. 라이트·다크 × 1440·720에서 다음 장면을 찍고, 단언이 하나라도 틀리면 종료 코드 1이다:
//   A. 멤버 프로필 → 확인 단계(다섯 줄 + 내 비밀번호) → 틀린 비밀번호 → 링크 카드(복사·Esc·닫기)
//   B. 로그인 안내(서버를 부르지 않는다) → 링크 입구
//   C. claim 화면(웹) → 막힌 링크(재설정 410) / 규칙 400
//   D. claim 화면(데스크탑 셸 흉내): 서버 확인 단계 → 확인 뒤 입력칸
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/4603");
const PORT = Number(process.env.CAPTURE_PORT || 5603);
const SCHEMES = ["light", "dark"];
const WIDTHS = [1440, 720];

const workspaceId = "00000000-0000-7000-8000-000000000001";
const me = "00000000-0000-7000-8000-000000000101";
const peer = "00000000-0000-7000-8000-000000000103";
const peer2 = "00000000-0000-7000-8000-000000000104";
const agentId = "00000000-0000-7000-8000-000000000102";
const GENERAL = "00000000-0000-7000-8000-000000000202";
const TOKEN = "Zk3Zk3Zk3Zk3Zk3Zk3Zk3Zk3Zk3Zk3Zk3Zk3Zk3Zk3Q"; // 43자, 모양만 같은 가짜 토큰
const SHARE_ORIGIN = "https://team.example.com";
const FAKE_SERVER = "https://team.example.com";
const CORRECT_PASSWORD = "내 비밀번호 Pw-1234";

const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", role: "member", displayName, handle, channelCount: 1,
  channelIds: [GENERAL], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person(me, "human", "박서연", "seoyeon", { role: "owner" }),
  person(peer, "human", "이도현", "dohyun"),
  person(peer2, "human", "최민수", "minsu", { role: "admin" }),
  person(agentId, "agent", "김인턴", "kim-intern", { ownerHumanId: me, hostOnline: false }),
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: me, workspaceId, kind: "human", displayName: "박서연", handle: "seoyeon" },
  realtimeWebSocketUrl: "ws://capture-4603.invalid/connection/websocket",
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** 어떤 요청이 몇 번 나갔는지(안내 화면이 서버를 안 부르는지 재려고). */
const hits = [];

async function installRoutes(context, claimAnswer) {
  // 가짜 서버 주소(team.example.com)로 가는 모든 것을 여기서 끝낸다: 어떤 요청도 이 기계 밖으로 나가지 않는다.
  await context.route(/team\.example\.com/, (route) => route.fulfill({ status: 404, body: "" }));
  await context.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    hits.push(`${method} ${path}`);
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId: me });
    }
    if (path === "/v1/claim") return claimAnswer(route);
    const reset = /\/members\/([^/]+)\/password-reset$/.exec(path);
    if (reset && method === "POST") {
      const body = JSON.parse(route.request().postData() ?? "{}");
      if (body.currentPassword === "") return json(route, { error: { code: "current_password_required", message: "currentPassword is required" } }, 400);
      if (body.currentPassword !== CORRECT_PASSWORD) {
        return json(route, { error: { code: "current_password_incorrect", message: "current password is incorrect" } }, 403);
      }
      return json(route, {
        token: TOKEN, kind: "password_reset", expiresAtMs: Date.now() + 24 * 3600_000,
        claimPath: `/claim/${TOKEN}`, claimUrl: `${SHARE_ORIGIN}/claim/${TOKEN}`, claimUrlSecure: true,
      }, 201);
    }
    if (/\/inbox(\/|$)/.test(path)) return json(route, { items: [], nextCursor: null, unreadCount: 0, approvalsPending: 0 });
    if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: { version: 1, sections: [], starredChannelIds: [] } });
    if (path.endsWith("/channels")) return json(route, { channels: [{ id: GENERAL, workspaceId, kind: "public", name: "일반", topic: "팀 공지", muted: false }] });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state") && method === "GET") {
      return json(route, { read_states: [{ channel_id: GENERAL, last_read_seq: 9, latest_seq: 9, unread_count: 0, mention_count: 0, marked_unread_before_seq: null }] });
    }
    if (path.endsWith(`/workspaces/${workspaceId}`)) {
      return json(route, { workspace: { id: workspaceId, name: "달무리 스튜디오", slug: "team", updatedAtMs: 1, roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: true } });
    }
    if (path.includes("/messages")) return json(route, { messages: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null, participants: [] });
    if (path.endsWith("/approvals")) return json(route, { approvals: [] });
    return json(route, {});
  });
}

async function installPage(page, { shell }) {
  await page.addInitScript(
    ({ shellOn }) => {
      class CaptureSocket {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
        constructor(url) {
          this.url = String(url); this.readyState = 0;
          queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
        }
        send(data) {
          const replies = String(data).trim().split("\n").map((line) => {
            const c = JSON.parse(line);
            if (c.connect) return { id: c.id, connect: { client: "4603-capture", version: "6" } };
            if (c.subscribe) return { id: c.id, subscribe: { recoverable: false, positioned: false, recovered: false, epoch: "cap", offset: 0 } };
            return { id: c.id };
          });
          queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
        }
        close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
      }
      window.WebSocket = CaptureSocket;
      if (shellOn) {
        // 셸(Tauri)은 가짜 `__TAURI_INTERNALS__`로 흉내 낸다. 신호등 같은 네이티브 부분은 이 캡처에 없다.
        let n = 0;
        window.__TAURI_INTERNALS__ = {
          metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
          transformCallback: () => ++n, unregisterCallback: () => {}, convertFileSrc: (p) => p,
          invoke: async (cmd) => {
            if (cmd === "keychain_available") return false;
            if (cmd === "plugin:event|listen") return ++n;
            return null;
          },
        };
        Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
      }
    },
    { shellOn: shell }
  );
}

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(name);
}

async function openContext(browser, origin, { scheme, width, loggedIn = false, shell = false, claimAnswer }) {
  const context = await browser.newContext({
    viewport: { width, height: 900 }, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block",
    deviceScaleFactor: 1, locale: "ko-KR", timezoneId: "Asia/Seoul", permissions: ["clipboard-read", "clipboard-write"],
  });
  await installRoutes(context, claimAnswer ?? ((route) => json(route, { error: { message: "nope" } }, 404)));
  const page = await context.newPage();
  await installPage(page, { shell });
  const server = shell ? FAKE_SERVER : origin;
  await page.addInitScript(
    ({ serverBase, session, withSession, record }) => {
      try {
        localStorage.setItem("momo.web.server.v1", serverBase);
        if (withSession) localStorage.setItem("momo.web.session.v1", JSON.stringify(session));
        localStorage.setItem("momo.web.appearance.v2", JSON.stringify(record));
        localStorage.setItem("oort.locale.preference", "ko-KR");
      } catch { /* 저장소 없는 캡처 */ }
    },
    {
      serverBase: server,
      session: { refreshToken: auth.refreshToken, realtimeWebSocketUrl: auth.realtimeWebSocketUrl, member: auth.member },
      withSession: loggedIn,
      record: { v: 2, scheme, theme: "dawnsky", signal: null, density: "comfortable", glass: { on: false } },
    }
  );
  return { context, page };
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  await page.waitForTimeout(250);
}

const shot = async (page, name) => {
  await settle(page);
  await page.screenshot({ path: resolve(OUT_DIR, `${name}.png`) });
};

const overflowX = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function fillPassword(page, value) {
  await page.getByTestId("member-profile-reset-password").fill(value);
}

/** A. 멤버 프로필: 확인 단계 → 틀린 비밀번호 → 링크 카드. */
async function sceneProfile(browser, origin, scheme, width) {
  const tag = `${scheme}-${width}`;
  const { context, page } = await openContext(browser, origin, { scheme, width, loggedIn: true });
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.getByTestId("profile-card").waitFor({ timeout: 20_000 });
    // 좁은 폭에서는 사이드바가 서랍이라 목록의 단추가 안 보인다: 경로로 간다.
    await page.evaluate(() => { location.hash = "#/directory"; });
    await page.locator('[data-testid="directory-row"][data-member-id="' + peer + '"]').first().click();
    const dialog = page.getByTestId("member-profile-dialog");
    await dialog.waitFor({ timeout: 10_000 });
    await shot(page, `A1-profile-${tag}`);
    check(`A1 ${tag} 프로필에 「재설정 링크 만들기」가 보인다`, await page.getByTestId("member-profile-reset-open").isVisible());

    await page.getByTestId("member-profile-reset-open").click();
    await page.getByTestId("member-profile-reset-stage").waitFor();
    check(`A2 ${tag} 확인 단계의 초점이 묶음으로 들어온다`, await page.evaluate(() => document.activeElement?.getAttribute("role") === "group"));
    const lines = await page.getByTestId("member-profile-reset-lines").locator("li").count();
    check(`A2 ${tag} 확인 단계에 다섯 줄이 있다`, lines === 5, lines);
    await shot(page, `A2-confirm-${tag}`);

    await fillPassword(page, "틀린 비밀번호");
    await page.getByTestId("member-profile-reset-submit").click();
    await page.getByTestId("member-profile-reset-password-error").waitFor();
    check(
      `A3 ${tag} 틀린 비밀번호는 그 칸 아래에서 말하고 칸이 비고 초점이 칸에 있다`,
      (await page.getByTestId("member-profile-reset-password-error").textContent()) === "내 비밀번호가 맞지 않아요. 다시 입력하세요." &&
        (await page.getByTestId("member-profile-reset-password").inputValue()) === "" &&
        (await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "member-profile-reset-password"
    );
    await shot(page, `A3-wrong-${tag}`);

    await fillPassword(page, CORRECT_PASSWORD);
    await page.getByTestId("member-profile-reset-submit").click();
    await page.getByTestId("member-profile-reset-issued").waitFor();
    const link = (await page.getByTestId("member-profile-reset-link").textContent()) ?? "";
    check(`A4 ${tag} 링크 카드에 서버가 준 링크가 한 번 보인다`, link === `${SHARE_ORIGIN}/claim/${TOKEN}`, link);
    check(`A4 ${tag} 링크가 서 있는 동안 초점이 카드에 있다`, await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "member-profile-reset-issued"));
    check(`A4 ${tag} 입력한 비밀번호는 화면 어디에도 없다`, !(await page.locator("body").innerText()).includes(CORRECT_PASSWORD));
    check(`A4 ${tag} 가로로 넘치지 않는다`, (await overflowX(page)) <= 0, await overflowX(page));
    await shot(page, `A4-issued-${tag}`);

    await page.getByTestId("member-profile-reset-copy").click();
    await page.waitForTimeout(150);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    check(`A5 ${tag} 복사 단추가 링크를 클립보드에 쓴다`, copied === link, copied);
    check(`A5 ${tag} 복사 뒤 단추가 「복사됨」이다`, (await page.getByTestId("member-profile-reset-copy").textContent()) === "복사됨");

    await page.keyboard.press("Escape");
    check(`A6 ${tag} 링크가 선 뒤의 Esc는 닫지 않는다`, (await dialog.isVisible()) && (await page.getByTestId("member-profile-reset-link").isVisible()));

    await page.getByTestId("member-profile-reset-close").click();
    await dialog.waitFor({ state: "detached" });
    await page.locator('[data-testid="directory-row"][data-member-id="' + peer + '"]').first().click();
    await page.getByTestId("member-profile-dialog").waitFor();
    check(`A7 ${tag} 닫고 다시 열면 링크가 화면 어디에도 없다`, !(await page.locator("body").innerText()).includes(TOKEN) && (await page.getByTestId("member-profile-reset-link").count()) === 0);
  } finally {
    await context.close();
  }
}

/** B. 로그인 안내: 서버를 부르지 않는다. */
async function sceneHelp(browser, origin, scheme, width) {
  const tag = `${scheme}-${width}`;
  const { context, page } = await openContext(browser, origin, { scheme, width });
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.getByTestId("onboarding-sign-in").waitFor({ timeout: 20_000 });
    await page.getByTestId("login-email").fill("ada@team.example.com");
    await shot(page, `B1-signin-${tag}`);
    check(`B1 ${tag} 로그인 폼에 「비밀번호를 잊으셨나요?」가 있다`, (await page.getByTestId("login-forgot").textContent()) === "비밀번호를 잊으셨나요?");

    await settle(page);
    const before = hits.length;
    await page.getByTestId("login-forgot").click();
    await page.getByTestId("onboarding-password-help").waitFor();
    await settle(page);
    check(`B2 ${tag} 안내 화면이 서고 서버를 부르지 않는다(요청 0건)`, hits.length - before === 0, hits.slice(before));
    check(`B2 ${tag} 안내 화면의 초점이 제목 줄로 들어온다`, await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "password-help-title"));
    check(`B2 ${tag} 가로로 넘치지 않는다`, (await overflowX(page)) <= 0, await overflowX(page));
    await shot(page, `B2-help-${tag}`);

    await page.getByTestId("password-help-copy").click();
    await page.waitForTimeout(150);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    check(`B3 ${tag} 복사한 문구에 서버 호스트와 이메일만 있다`, copied === "oort 비밀번호를 잊어서 재설정 링크가 필요해요. 서버: 127.0.0.1:" + PORT + ", 이메일: ada@team.example.com", copied);

    await page.getByTestId("password-help-link").fill("team.example.com");
    await page.getByTestId("password-help-open").click();
    await page.getByTestId("password-help-link-error").waitFor();
    check(`B4 ${tag} 재설정 링크가 아닌 입력은 그 칸에서 이유를 말한다`, (await page.getByTestId("password-help-link").getAttribute("aria-invalid")) === "true");
    await shot(page, `B4-help-error-${tag}`);
    check(`B4 ${tag} 입구를 눌러도 서버를 부르지 않는다`, hits.length - before === 0, hits.slice(before));

    await page.getByTestId("password-help-back").click();
    await page.getByTestId("login-forgot").waitFor();
    check(`B5 ${tag} 돌아오면 초점이 「잊으셨나요?」에 있고 이메일이 남아 있다`,
      (await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "login-forgot" &&
        (await page.getByTestId("login-email").inputValue()) === "ada@team.example.com");
  } finally {
    await context.close();
  }
}

/** C. claim 화면(웹): 중립 머리, 규칙 안내, 막힌 링크. */
async function sceneClaimWeb(browser, origin, scheme, width) {
  const tag = `${scheme}-${width}`;
  let mode = "expired";
  const claimAnswer = (route) => {
    if (mode === "expired") return json(route, { error: { message: "claim token has expired" }, claimKind: "password_reset" }, 410);
    return json(route, { error: { code: "password_too_short", message: "password must be at least 10 characters" } }, 400);
  };
  const { context, page } = await openContext(browser, origin, { scheme, width, claimAnswer });
  try {
    await page.goto(`${origin}/claim/${TOKEN}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("claim-password").waitFor({ timeout: 20_000 });
    check(`C1 ${tag} 입력 전 머리는 첫 주인이라 말하지 않는다`, (await page.getByTestId("claim-title").textContent()) === "새 비밀번호를 정해요.");
    check(`C1 ${tag} 웹 브라우저에는 서버 확인 단계도 칩도 없다(주소창이 대신한다)`, (await page.getByTestId("claim-host-gate").count()) === 0 && (await page.getByTestId("connect-server-chip-host").count()) === 0);
    check(`C1 ${tag} 규칙 안내가 칸 아래에 있다`, ((await page.getByTestId("claim-password-hint").textContent()) ?? "").includes("10자 이상"));
    await shot(page, `C1-claim-web-${tag}`);

    mode = "short";
    await page.getByTestId("claim-password").fill("short");
    await page.getByTestId("claim-confirm").fill("short");
    await page.getByTestId("claim-submit").click();
    await page.getByTestId("claim-error").waitFor();
    check(`C2 ${tag} 규칙을 어긴 400은 입력칸에 연결된다`, (await page.getByTestId("claim-password").getAttribute("aria-invalid")) === "true");
    await shot(page, `C2-claim-rule-${tag}`);
    await page.getByTestId("claim-password").fill("short2");
    check(`C2 ${tag} 칸을 고치면 오류가 걷힌다`, (await page.getByTestId("claim-error").count()) === 0);

    mode = "expired";
    await page.getByTestId("claim-password").fill("a-long-enough-pass");
    await page.getByTestId("claim-confirm").fill("a-long-enough-pass");
    await page.getByTestId("claim-submit").click();
    await page.getByTestId("claim-error").waitFor();
    check(`C3 ${tag} 만료된 재설정 링크는 관리자에게 새 링크를 요청하라고 한다`, ((await page.getByTestId("claim-error").textContent()) ?? "").includes("관리자에게 새 링크를 요청하세요"));
    check(`C3 ${tag} 가로로 넘치지 않는다`, (await overflowX(page)) <= 0, await overflowX(page));
    await shot(page, `C3-claim-expired-${tag}`);
  } finally {
    await context.close();
  }
}

/** D. claim 화면(데스크탑 셸): 서버 확인 단계. */
async function sceneClaimShell(browser, origin, scheme, width) {
  const tag = `${scheme}-${width}`;
  const { context, page } = await openContext(browser, origin, { scheme, width, shell: true });
  try {
    await page.goto(`${origin}/claim/${TOKEN}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("claim-host-gate").waitFor({ timeout: 20_000 });
    check(`D1 ${tag} 서버 호스트가 칩으로 보이고 비밀번호 칸은 닫혀 있다`,
      (await page.getByTestId("connect-server-chip-host").textContent()) === "team.example.com" && (await page.getByTestId("claim-password").count()) === 0);
    check(`D1 ${tag} 서버 확인 단계의 초점이 그 묶음으로 들어온다`, await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "claim-host-gate"));
    check(`D1 ${tag} 가로로 넘치지 않는다`, (await overflowX(page)) <= 0, await overflowX(page));
    await shot(page, `D1-claim-gate-${tag}`);

    await page.getByTestId("claim-host-confirm").click();
    await page.getByTestId("claim-password").waitFor();
    check(`D2 ${tag} 확인하면 칸이 열리고 칩이 남는다`, (await page.getByTestId("connect-server-chip-host").textContent()) === "team.example.com");
    await shot(page, `D2-claim-confirmed-${tag}`);
  } finally {
    await context.close();
  }
}

if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
mkdirSync(OUT_DIR, { recursive: true });
const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
const origin = preview.origin;
const browser = await chromium.launch();
try {
  for (const scheme of SCHEMES) {
    for (const width of WIDTHS) {
      await sceneProfile(browser, origin, scheme, width);
      await sceneHelp(browser, origin, scheme, width);
      await sceneClaimWeb(browser, origin, scheme, width);
      await sceneClaimShell(browser, origin, scheme, width);
    }
  }
} finally {
  await browser.close();
  await preview.stop();
}
console.log(failures.length === 0 ? "ALL OK" : `FAILED: ${failures.length}`);
process.exit(failures.length === 0 ? 0 : 1);
