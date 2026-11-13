import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import { ENGINES, type EngineName } from "@/design/appearance/compileTokensTestKit";

// =============================================================================
// 로그아웃하면 이 기기에 쓰다 만 글이 남지 않는다 (#5799) — 실제 엔진에서 앱 전체를 띄워 잰다.
//
// 로그아웃 확인 창은 「쓰다 만 초안이 지워집니다」라고 말한다. 지우는 일은 로그아웃 순간에 일어나지만, 세션이 실제로 내려가는 것은
// 그 **뒤**다(React 가 화면을 바꾸며 입력창을 내린다). 그 사이·그 뒤에 쓰는 손이 있으면 지운 자리가 되살아난다. 내려가는 순서는
// jsdom 과 실제 브라우저가 다르므로 이 시험은 진짜 번들을 진짜 엔진에서 돌리고, 저장소를 직접 센다.
//
//   (1) 대화를 연 채 프로필 메뉴로 로그아웃: 그 자리·로그인 화면이 선 뒤 한 박자 기다린 뒤 모두 0건. 같은 페이지에서 다른 사람이
//       이어 들어와 같은 대화를 열어도 입력창은 비어 있다.
//   (2) 보내는 중인 글을 두고 설정에서 워크스페이스를 나간다: 그 요청이 로그아웃 **뒤에** 실패해도 0건.
//   (3) 로그아웃하지 않는 평소 길(대화 옮기기·새로 고침)에서는 초안이 그대로 남는다 — 다음 사람의 로그인이 저장소를 다시 연다.
//   (4) 같은 앱이 두 탭에 열려 있을 때 한 탭에서 로그아웃해도, 다른 탭이 내려가며 쓰는 글이 남지 않는다.
//
// 세는 것은 같은 약속 아래 있는 세 묶음(초안·답글 초안·보내지 못한 글)의 열쇠 수다. 서버는 고정 응답이고 실시간은 가짜 소켓이다.
// 엔진은 `ENGINES`(설치된 WebKit·Chromium)이다. 하나도 없으면 건너뛴다(다른 브라우저 시험과 같은 규약).
// 사보타주: `draftStore.ts`의 `writeRaw` 첫 줄(닫힌 동안 쓰지 않는다)을 지우면 (1)·(2)·(4)가 붉고, `session.tsx`의
// `openDraftsForSignIn()`을 지우면 (3)이 붉고, 닫힘 표지를 공유 저장소가 아니라 이 탭에만 두면 (4)만 붉다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const CH1 = "00000000-0000-7000-8000-000000000201";
const CH2 = "00000000-0000-7000-8000-000000000202";
const DOHYEON = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const SEOYEON = "019f94e3-7a10-79cd-9dee-208f47edd9b9";
const FAMILIES = ["momo.draft.v1:", "momo.thread-draft.v1:", "momo.failed-send.v1:"];
/** 로그인 화면이 선 뒤 기다리는 한 박자. 입력창 저장에 미룸이 생겨도 이 안에 끝난다. */
const SETTLE_MS = 1_500;

const channels = [
  { id: CH1, workspaceId: WS, kind: "public", name: "general", muted: false },
  { id: CH2, workspaceId: WS, kind: "public", name: "random", muted: false },
];
const people = [
  { id: DOHYEON, displayName: "김도현", handle: "dohyeon" },
  { id: SEOYEON, displayName: "이서연", handle: "seoyeon" },
];
const roster = people.map((person) => ({
  ...person,
  workspaceId: WS,
  kind: "human",
  status: "active",
  role: "owner",
  channelCount: channels.length,
  channelIds: channels.map((c) => c.id),
  capabilities: [],
  createdAtMs: 0,
  updatedAtMs: 0,
}));

type Rig = { engine: EngineName; browser: Browser };
type Fixture = { context: BrowserContext; page: Page; heldPosts: Route[] };
const rigs: Rig[] = [];
let vite: ViteDevServer | null = null;
let http: Server | null = null;
let origin = "";
let cacheDir = "";

beforeAll(async () => {
  if (ENGINES.length === 0) return;
  cacheDir = mkdtempSync(join(tmpdir(), "oort-signout-drafts-vite-"));
  // 미들웨어로만 붙이고 포트는 운영체제가 고른다: 설정의 고정 개발 포트(5173)를 이 시험이 차지하지 않게.
  vite = await createServer({ cacheDir, logLevel: "error", appType: "spa", server: { middlewareMode: true, hmr: false } });
  const server = createHttpServer(vite.middlewares);
  http = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("브라우저 시험 포트가 없어요");
  origin = `http://127.0.0.1:${address.port}`;
  console.info(`sign-out drafts: real engines = ${ENGINES.join(", ")}`);
  const playwright = await import("playwright");
  for (const engine of ENGINES) rigs.push({ engine, browser: await playwright[engine].launch({ headless: true }) });
}, 180_000);

afterAll(async () => {
  for (const rig of rigs) await rig.browser.close();
  await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
  await vite?.close();
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});

const FAKE_SOCKET = `
class FakeSocket {
  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    queueMicrotask(() => { this.readyState = 1; if (this.onopen) this.onopen(new Event("open")); });
  }
  send(data) {
    const replies = String(data).trim().split("\\n").map((line) => {
      const command = JSON.parse(line);
      if (command.connect) return { id: command.id, connect: { client: "fixture", version: "6" } };
      if (command.subscribe) return { id: command.id, subscribe: { recoverable: true, positioned: true, recovered: false, epoch: "fixture", offset: 0 } };
      return { id: command.id };
    });
    queueMicrotask(() => { if (this.onmessage) this.onmessage(new MessageEvent("message", { data: replies.map((reply) => JSON.stringify(reply)).join("\\n") })); });
  }
  close() { this.readyState = 3; if (this.onclose) this.onclose(new CloseEvent("close", { code: 1000 })); }
}
FakeSocket.CONNECTING = 0; FakeSocket.OPEN = 1; FakeSocket.CLOSING = 2; FakeSocket.CLOSED = 3;
window.WebSocket = FakeSocket;
`;

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** 앱 하나를 새 컨텍스트에 띄운다. 로그인은 차례로 김도현 → 이서연이다. `holdPosts`면 보내기 요청을 붙들어 둔다. */
async function openApp(rig: Rig, { holdPosts = false } = {}): Promise<Fixture> {
  const context = await rig.browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "ko-KR", reducedMotion: "reduce", serviceWorkers: "block" });
  const heldPosts: Route[] = [];
  let logins = 0;
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/v1/auth/login") {
      const person = people[Math.min(logins, people.length - 1)];
      logins += 1;
      return json(route, { accessToken: "fixture", refreshToken: "fixture", member: { ...person, workspaceId: WS, kind: "human" }, realtimeWebSocketUrl: "ws://fixture.invalid/connection/websocket" });
    }
    if (path === "/v1/auth/refresh") return json(route, { accessToken: "fixture", refreshToken: "fixture" });
    if (path === "/v1/auth/logout") return json(route, {});
    if (path === "/v1/auth/realtime-token") return json(route, { token: "fixture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId: WS, memberId: DOHYEON });
    if (path === `/v1/workspaces/${WS}/members/me` && method === "DELETE") return json(route, { memberId: DOHYEON, status: "left" });
    if (method === "POST" && path.endsWith("/messages") && holdPosts) {
      heldPosts.push(route);
      return;
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith(`/workspaces/${WS}`)) return json(route, { workspace: { id: WS, slug: "saebyeok", name: "새벽팀", updatedAtMs: 1_760_000_000_000, roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: false } });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  // 실시간 레일은 붙기만 하는 가짜다: 이 시험은 저장소를 잰다. 글자 그대로 넘겨 변환기의 도움 함수가 끼지 않게 한다.
  await page.addInitScript({ content: FAKE_SOCKET });
  // 서버 주소를 한 번만 심는다(첫 화면을 건너뛴다). 새로 고침은 심지 않는다.
  await page.addInitScript((server: string) => {
    try {
      if (!sessionStorage.getItem("fixture.seeded")) {
        localStorage.setItem("momo.web.server.v1", server);
        sessionStorage.setItem("fixture.seeded", "1");
      }
    } catch {
      /* 저장소가 없으면 첫 화면부터 간다. */
    }
  }, origin);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await signIn(page, "dohyeon");
  return { context, page, heldPosts };
}

async function signIn(page: Page, who: string): Promise<void> {
  await page.locator('[data-testid="onboarding-welcome"], [data-testid="onboarding-sign-in"], [data-testid="onboarding-join"]').first().waitFor({ state: "visible", timeout: 120_000 });
  const welcome = page.getByTestId("onboarding-welcome");
  if (await welcome.isVisible()) await page.getByTestId("connect-entry-submit").click();
  await page.getByTestId("login-email").fill(`${who}@example.test`);
  await page.getByTestId("login-password").fill("fixture-only");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("workspace-current").waitFor({ state: "attached", timeout: 120_000 });
}

const composer = (page: Page) => page.getByTestId("composer-input");

async function openChannel(page: Page, channelId: string): Promise<void> {
  await page.evaluate((id) => {
    window.location.hash = `#/c/${id}`;
  }, channelId);
  await composer(page).waitFor({ state: "visible" });
}

async function typeInComposer(page: Page, text: string): Promise<void> {
  await composer(page).click();
  await page.keyboard.type(text);
}

/** 같은 약속 아래 있는 세 묶음의 열쇠: 초안 · 답글 초안 · 보내지 못한 글. */
function deviceDrafts(page: Page): Promise<string[]> {
  return page.evaluate((families) => Object.keys(localStorage).filter((key) => families.some((family) => key.startsWith(family))), FAMILIES);
}

function readDraftText(page: Page, channelId: string): Promise<string | null> {
  return page.evaluate(([ws, ch]) => {
    const raw = localStorage.getItem(`momo.draft.v1:${ws}:${ch}`);
    return raw === null ? null : (JSON.parse(raw) as { text: string }).text;
  }, [WS, channelId] as const);
}

async function logoutFromProfileMenu(page: Page): Promise<void> {
  // 메뉴는 포인터 누름으로 열린다(Radix). 헤드리스에서 확실히 열리게 누름과 클릭을 함께 낸다.
  await page.getByTestId("profile-card").first().evaluate((el) => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
    (el as HTMLElement).click();
  });
  await page.getByTestId("profile-card-menu").waitFor();
  await page.getByTestId("profile-logout").click();
  await page.getByTestId("profile-logout-confirm-action").click();
}

describe("로그아웃하면 이 기기에 쓰다 만 글이 남지 않는다 (#5799)", () => {
  it("대화를 연 채 로그아웃: 그 자리와 한 박자 뒤 모두 0건, 다음 사람의 같은 대화 입력창은 비어 있고, 그 사람의 초안은 평소처럼 남는다", async () => {
    if (rigs.length === 0) return;
    for (const rig of rigs) {
      const { context, page } = await openApp(rig);
      try {
        await openChannel(page, CH1);
        await typeInComposer(page, "쓰다 만 초안");
        // 대조: 로그아웃 전에는 저장돼 있다(아무것도 저장하지 않아 0건이 되는 수리를 막는다).
        expect(await readDraftText(page, CH1), rig.engine).toBe("쓰다 만 초안");

        await logoutFromProfileMenu(page);
        expect(await deviceDrafts(page), `${rig.engine}: 로그아웃 직후`).toEqual([]);
        await page.getByTestId("login-email").waitFor({ state: "visible" });
        await page.waitForTimeout(SETTLE_MS);
        expect(await deviceDrafts(page), `${rig.engine}: 로그인 화면이 선 뒤 한 박자`).toEqual([]);

        // 같은 페이지에서 다른 사람이 이어 들어와 같은 대화를 연다.
        await signIn(page, "seoyeon");
        await openChannel(page, CH1);
        expect(await composer(page).inputValue(), `${rig.engine}: 다음 사람의 입력창`).toBe("");
        expect(await deviceDrafts(page), `${rig.engine}: 다음 사람이 들어온 뒤`).toEqual([]);

        // 평소 길: 대화를 옮기면 남고, 새로 고침 뒤에도 그 자리에 돌아온다(다음 로그인이 저장소를 다시 열었다).
        await typeInComposer(page, "이서연의 글");
        await openChannel(page, CH2);
        expect(await readDraftText(page, CH1), `${rig.engine}: 대화를 옮긴 뒤`).toBe("이서연의 글");
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByTestId("workspace-current").waitFor({ state: "attached", timeout: 120_000 });
        await openChannel(page, CH1);
        await expect.poll(() => composer(page).inputValue(), { message: `${rig.engine}: 새로 고침 뒤` }).toBe("이서연의 글");
      } finally {
        await context.close();
      }
    }
  }, 600_000);

  it("같은 앱이 두 탭에 열려 있다: 한 탭에서 로그아웃하면 다른 탭이 내려가며 쓰는 글도 남지 않는다", async () => {
    if (rigs.length === 0) return;
    for (const rig of rigs) {
      const { context, page } = await openApp(rig);
      try {
        await openChannel(page, CH1);
        await typeInComposer(page, "쓰다 만 초안");
        // 둘째 탭: 같은 기기·같은 저장소. 같은 대화를 열면 그 입력창이 초안을 들고 있다(대조).
        const second = await context.newPage();
        await second.addInitScript({ content: FAKE_SOCKET });
        await second.goto(page.url(), { waitUntil: "domcontentloaded" });
        await second.getByTestId("workspace-current").waitFor({ state: "attached", timeout: 120_000 });
        await openChannel(second, CH1);
        expect(await composer(second).inputValue(), `${rig.engine}: 둘째 탭 대조`).toBe("쓰다 만 초안");

        await logoutFromProfileMenu(page);
        await page.getByTestId("login-email").waitFor({ state: "visible" });
        // 둘째 탭도 세션이 끝나 로그인 화면으로 간다(그 입력창이 내려가며 마지막 글을 쓰려 한다).
        await second.getByTestId("login-email").waitFor({ state: "visible" });
        await page.waitForTimeout(SETTLE_MS);
        expect(await deviceDrafts(page), `${rig.engine}: 두 탭이 모두 내려간 뒤 한 박자`).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 600_000);

  it("보내는 중인 글을 두고 워크스페이스를 나간다: 그 요청이 로그아웃 뒤에 실패해도 0건", async () => {
    if (rigs.length === 0) return;
    for (const rig of rigs) {
      const { context, page, heldPosts } = await openApp(rig, { holdPosts: true });
      try {
        await openChannel(page, CH1);
        await typeInComposer(page, "날아가는 글");
        await page.keyboard.press("Enter");
        await expect.poll(() => heldPosts.length, { message: `${rig.engine}: 보내기 요청이 나갔다` }).toBe(1);

        // 설정으로 가면 대화가 내려가며 결과를 모르는 글을 「못 보낸 글」로 남긴다(로그인한 동안의 정상 동작).
        await page.evaluate(() => {
          window.location.hash = "#/settings?section=profile";
        });
        await page.getByTestId("workspace-leave").click();
        expect((await deviceDrafts(page)).length, `${rig.engine}: 나가기 전 대조`).toBe(1);
        await page.getByTestId("workspace-leave-confirm").click();
        await page.getByTestId("login-email").waitFor({ state: "visible" });
        expect(await deviceDrafts(page), `${rig.engine}: 나간 직후`).toEqual([]);

        // 붙들어 둔 요청이 이제 실패한다: 늦게 도착한 실패가 지운 자리를 되살리면 안 된다.
        for (const route of heldPosts) await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
        await page.waitForTimeout(SETTLE_MS);
        expect(await deviceDrafts(page), `${rig.engine}: 늦은 실패 뒤 한 박자`).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 600_000);
});
