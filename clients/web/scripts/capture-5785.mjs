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
//   join-confirm     계속 → 확인 걸음(로그아웃·초안 삭제·넘어갈 곳)
//   profile-menu     프로필 카드 → 메뉴(내 상태 → 워크스페이스 이름 머리글 → 네 줄)
//   leave-confirm    「워크스페이스 나가기」 → 확인 창
//   leave-last-owner 나가기 → 서버 409 → 창 안의 거절 문장(로그아웃 안 됨)
//   handoff          (1280 밝게만) 확인 → 로그아웃 → 로그인 화면이 초대 링크로 가입 걸음에 서고 주소창에 코드가 없다
//
// 단정이 하나라도 빨가면 exit 1.
// =============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

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

async function installRoutes(context, role) {
  await context.route("**/v1/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/logout") return json(route, {});
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    // 나가기는 늘 마지막 소유자 409다(캡처가 실제로 로그아웃되지 않게).
    if (path === `/v1/workspaces/${workspaceId}/members/me` && method === "DELETE") {
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

async function newContext(browser, origin, scheme, vp, role) {
  const context = await browser.newContext({
    viewport: { width: vp.w, height: vp.h },
    deviceScaleFactor: vp.dpr,
    colorScheme: scheme,
    locale: "ko-KR",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin }).catch(() => {});
  await installRoutes(context, role);
  const page = await context.newPage();
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

async function ownerRun(page, origin, tag, withHandoff) {
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
  await page.getByTestId("add-workspace-join-next").click();
  await page.getByTestId("add-workspace-join-confirm").waitFor();
  const confirmText = await page.getByTestId("add-workspace-dialog").innerText();
  check(tag, "확인 걸음이 로그아웃·초안 삭제·넘어갈 곳을 말한다", confirmText.includes("로그아웃되고") && confirmText.includes("초안은 지워져요") && confirmText.includes("team.example.com의 초대로 넘어가요"), null);
  const confirmFocus = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  check(tag, "확인 걸음의 초점은 위험 단추가 아니라 확인 묶음", confirmFocus === "add-workspace-join-confirm", { confirmFocus });
  await fits(page, tag, "join-confirm", "add-workspace-join-logout");
  await shot(page, tag, "join-confirm");

  if (withHandoff) {
    await page.getByTestId("add-workspace-join-logout").click();
    await page.getByTestId("join-sign-in-instead").waitFor({ timeout: 15_000 });
    // 첫 그림은 저장된 서버로 서고, 링크를 읽은 효과가 다음 커밋에서 칩을 바꾼다. 그 커밋을 기다린다.
    await page.waitForFunction(
      () => document.querySelector("[data-testid=connect-server-chip-host]")?.textContent?.includes("team.example.com"),
      null,
      { timeout: 5_000 }
    ).catch(() => {});
    const chip = await page.getByTestId("connect-server-chip-host").innerText().catch(() => "");
    const href = page.url();
    check(tag, "넘김: 로그인 화면이 초대 가입 걸음에 서고 서버 칩이 그 주소다", chip.includes("team.example.com"), { chip });
    check(tag, "넘김: 주소창에서 초대 코드를 지웠다", !href.includes("code="), { href: href.replace(INVITE_SHAPE, "<code>") });
    await shot(page, tag, "handoff-login");
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
  // 줄 아이콘이 한 세로 줄에 선다.
  const iconXs = await page.evaluate(() =>
    ["profile-set-status", "profile-copy-address", "profile-workspace-settings", "profile-leave-workspace", "profile-add-workspace", "nav-settings", "profile-logout"]
      .map((id) => document.querySelector(`[data-testid=${id}] svg`)?.getBoundingClientRect().x ?? null)
  );
  const spread = Math.max(...iconXs) - Math.min(...iconXs);
  check(tag, "메뉴 줄 아이콘의 x가 한 줄(차이 ≤ 0.5px)", iconXs.every((x) => x !== null) && spread <= 0.5, { iconXs, spread });
  await fits(page, tag, "profile-menu", "profile-card-menu");
  await shot(page, tag, "profile-menu");

  // 주소 복사(1280 밝게에서 클립보드까지 읽는다)
  await page.getByTestId("profile-copy-address").click();
  await page.waitForTimeout(200);
  const copyLabel = await page.getByTestId("profile-copy-address").innerText();
  check(tag, "주소 복사 → 메뉴가 열린 채 「주소 복사됨」", copyLabel.includes("주소 복사됨"), { copyLabel });
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `ERR ${String(e).slice(0, 60)}`);
  check(tag, "주소 복사: 클립보드가 이 서버 주소", clip === origin, { clip, origin });

  // 나가기 확인 → 409
  await page.getByTestId("profile-leave-workspace").click();
  await page.getByTestId("workspace-leave-dialog").waitFor();
  const leaveFocus = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  check(tag, "나가기 확인: 초점이 「취소」", leaveFocus === "workspace-leave-dialog-cancel", { leaveFocus });
  check(tag, "나가기 확인: 제목이 워크스페이스 이름", (await page.getByTestId("workspace-leave-dialog").innerText()).includes("새벽팀에서 나갈까요?"), null);
  await fits(page, tag, "leave-confirm", "workspace-leave-dialog");
  await shot(page, tag, "leave-confirm");
  await page.getByTestId("workspace-leave-dialog-confirm").click();
  await page.getByTestId("workspace-leave-dialog-last-owner").waitFor({ timeout: 10_000 });
  const stillIn = await page.getByTestId("workspace-current").count();
  check(tag, "409: 거절 문장이 창 안에 서고 로그아웃되지 않는다", stillIn > 0, { stillIn });
  await fits(page, tag, "leave-last-owner", "workspace-leave-dialog");
  await shot(page, tag, "leave-last-owner");
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
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT", extraArgs: [] });
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
    // 넘김은 한 번이면 된다(로그아웃한다).
    const { context, page } = wants("handoff")
      ? await newContext(browser, preview.origin, "light", allSizes[0], "owner")
      : { context: null, page: null };
    if (page) try {
      await ownerRun(page, preview.origin, "1280-light", true);
    } catch (error) {
      await page.screenshot({ path: resolve(OUT_DIR, "FAIL-handoff.png") }).catch(() => {});
      check("1280-light", "handoff 장면이 끝까지 간다", false, String(error).slice(0, 400));
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
    await preview.stop?.();
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
