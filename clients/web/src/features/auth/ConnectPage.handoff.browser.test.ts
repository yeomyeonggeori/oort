import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import type { Browser, BrowserContext, Page } from "playwright";
import { ENGINES, type EngineName } from "@/design/appearance/compileTokensTestKit";

// =============================================================================
// 로그인 화면의 첫 그림 전 초점과, 데스크탑에서 다른 서버로 가는 길 (#5785): 진짜 앱을 진짜 엔진에서.
//
// jsdom 은 두 가지를 구별하지 못한다. (1) `act`가 레이아웃 효과와 일반 효과를 같이 비워서, 초점을 `useEffect`로 되돌려도
// 초록이다 — 여기서는 로그인 화면이 마운트된 **첫 rAF**에서 초점이 그 걸음의 첫 칸에 있는지 본다. (2) 칸에 채워진 글의
// 선택은 진짜 입력 칸에서만 붙여 넣기·타자가 채운 글을 대신하는 것으로 드러난다.
//
// 앱은 Vite 개발 서버로 띄우고, 서버(앞 서버 A · 넘어갈 서버 B)는 `/v1/**`·`/healthz`를 가로채 흉내 낸다(요청이 어느
// 서버로 갔는지만 센다). 데스크탑은 셸 판정 전역(`__TAURI__`)만 단다.
//
// 몸짓은 확인 걸음이 시키는 그대로다: (링크 복사 → 로그아웃 →) 로그인 화면의 「바꾸기」 → 곧바로 붙여 넣기. 붙여 넣기는
// 선택 영역을 글로 바꾸는 `insertText`(진짜 붙여 넣기와 같은 효과)이고, 다른 칸을 누르거나 ⌘A 하지 않는다.
//
// 잠금: 초점 효과를 `useEffect`로 되돌리면 첫 프레임 단정이, 「바꾸기」 뒤의 `select()`를 빼면 붙여 넣기 단정이,
// 서버가 바뀔 때 비밀번호를 비우지 않으면 본문 단정이 붉다(사보타주 표는 인계). 엔진이 없으면 건너뛴다(다른 브라우저 시험과 같은 규약).
// =============================================================================

const WEB_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CODE_B = "Q".repeat(24);
const B = "https://next.example.com";
const LINK_B = `${B}/?code=${CODE_B}`;
const FIRST = "abcdefgh";
const SECOND = "zq91xk3m";

/** 앞 서버 주소의 세 모양: 포트 있는 것 · 포트 없는 https · 경로가 붙은 것. */
const A_SHAPES = [
  "http://127.0.0.1:6051",
  "https://oort.team-a.example.com",
  "https://team-a.example.com/oort",
] as const;

type Rig = { engine: EngineName; browser: Browser };
const rigs: Rig[] = [];
let server: ViteDevServer | null = null;
let origin = "";
let cacheDir = "";

beforeAll(async () => {
  if (ENGINES.length === 0) return;
  cacheDir = mkdtempSync(join(tmpdir(), "oort-connect-handoff-vite-"));
  server = await createServer({
    root: WEB_ROOT,
    cacheDir,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("브라우저 시험 포트가 없어요");
  origin = `http://127.0.0.1:${address.port}`;
  const playwright = await import("playwright");
  for (const engine of ENGINES) rigs.push({ engine, browser: await playwright[engine].launch({ headless: true }) });
}, 180_000);

afterAll(async () => {
  for (const rig of rigs) await rig.browser.close();
  await server?.close();
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});

type Call = { host: string; path: string; method: string; body: string };
type Frame = { field: string | null; active: string | null };

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*",
};

/** 앱 말고는 모두 흉내 낸다. 닿은 요청(서버 주소 · 경로 · 본문)을 적는다. 서버는 로그인·가입을 거절해 화면에 머문다. */
async function openApp(rig: Rig, options: { stored: string | null; path?: string }): Promise<{ context: BrowserContext; page: Page; calls: Call[] }> {
  const context = await rig.browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: "ko-KR",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  const calls: Call[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin && !url.pathname.startsWith("/v1") && url.pathname !== "/healthz") return route.continue();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    calls.push({ host: url.origin + (url.pathname.startsWith("/oort/") ? "/oort" : ""), path: url.pathname, method: request.method(), body: request.postData() ?? "" });
    const headers = { ...CORS, "content-type": "application/json" };
    if (url.pathname === "/healthz") return route.fulfill({ status: 200, headers, body: "{}" });
    return route.fulfill({ status: 401, headers, body: JSON.stringify({ error: { code: "unauthorized", message: "x" } }) });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.addInitScript(
    ({ stored }) => {
      (window as unknown as { __TAURI__: object }).__TAURI__ = {};
      try {
        if (stored) localStorage.setItem("momo.web.server.v1", stored);
      } catch {
        /* 저장소 없음 */
      }
      // 프레임마다: 로그인 화면의 칸이 이미 있는가, 있다면 초점이 어디 있는가.
      const frames: Frame[] = [];
      (window as unknown as { __frames: Frame[] }).__frames = frames;
      const FIELDS = ["connect-entry", "login-email", "login-password"];
      const tick = () => {
        const field = FIELDS.find((id) => document.querySelector(`[data-testid="${id}"]`)) ?? null;
        frames.push({ field, active: document.activeElement?.getAttribute("data-testid") ?? null });
        if (frames.length < 600) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    { stored: options.stored }
  );
  await page.goto(`${origin}${options.path ?? "/"}`, { waitUntil: "domcontentloaded" });
  return { context, page, calls };
}

const framesOf = (page: Page) => page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames);
const entryOf = (page: Page) => page.getByTestId("connect-entry");

/** 칸을 가진 첫 프레임의 초점이 기대한 칸이다. */
async function expectFirstPaintFocus(page: Page, expected: string, at: string) {
  await page.waitForFunction(() => (window as unknown as { __frames: Frame[] }).__frames.some((f) => f.field !== null), null, { timeout: 30_000 });
  const first = (await framesOf(page)).find((f) => f.field !== null)!;
  expect(first, `${at}: 칸이 처음 보인 프레임의 초점`).toEqual({ field: expect.any(String), active: expected });
}

/** 앞 서버 로그인 걸음에서 「바꾸기」까지 간 뒤 붙여 넣기 전의 상태. */
async function toChange(page: Page) {
  await page.getByTestId("onboarding-sign-in").waitFor({ state: "visible" });
  await page.getByTestId("connect-server-change").click();
  await entryOf(page).waitFor({ state: "visible" });
}

const chipHost = (page: Page) => page.getByTestId("connect-server-chip-host").textContent();

describe.each(ENGINES.map((engine) => [engine] as const))("로그인 화면 첫 그림 전 초점 · 데스크탑 다른 서버 길 (%s)", (engine) => {
  const rig = () => rigs.find((r) => r.engine === engine)!;

  it.skipIf(ENGINES.length === 0)("로그인 화면이 마운트된 첫 프레임에 초점이 그 걸음의 첫 칸에 있다 (주소 걸음 · 로그인 걸음 · 가입 걸음)", async () => {
    const scenes: { name: string; stored: string | null; path?: string; expected: string }[] = [
      { name: "주소 걸음", stored: null, expected: "connect-entry" },
      { name: "로그인 걸음", stored: A_SHAPES[1], expected: "login-email" },
      { name: "가입 걸음", stored: A_SHAPES[1], path: `/?code=${CODE_B}`, expected: "login-email" },
    ];
    for (const scene of scenes) {
      const { context, page } = await openApp(rig(), scene);
      try {
        await expectFirstPaintFocus(page, scene.expected, `${engine} ${scene.name}`);
      } finally {
        await context.close();
      }
    }
  }, 120_000);

  it.skipIf(ENGINES.length === 0)("「바꾸기」 뒤 그대로 붙여 넣으면 넘어갈 서버의 가입 걸음 · 칩이 서고 가입 1건이 그 서버로 간다 (앞 서버 세 모양)", async () => {
    for (const a of A_SHAPES) {
      const { context, page, calls } = await openApp(rig(), { stored: a });
      try {
        await toChange(page);
        const box = entryOf(page);
        expect(await box.inputValue(), `${engine} ${a}: 「바꾸기」가 채운 글`).toBe(a);
        expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), `${engine} ${a}: 초점`).toBe("connect-entry");
        await page.keyboard.insertText(LINK_B);
        expect(await box.inputValue(), `${engine} ${a}: 붙여 넣은 뒤 칸`).toBe(LINK_B);
        await page.keyboard.press("Enter");
        await page.getByTestId("onboarding-join").waitFor({ state: "visible" });
        expect(await chipHost(page), `${engine} ${a}: 칩`).toBe("next.example.com");
        await page.getByTestId("login-email").fill("dohyeon@example.test");
        await page.getByTestId("login-password").fill(SECOND);
        await page.getByTestId("login-submit").click();
        await expect.poll(() => calls.filter((c) => c.path === "/v1/join").length, { message: `${engine} ${a}: 가입 요청` }).toBe(1);
        const join = calls.find((c) => c.path === "/v1/join")!;
        expect(join.host, `${engine} ${a}: 가입이 간 서버`).toBe(B);
        expect(join.body, `${engine} ${a}: 가입 본문의 초대 코드`).toContain(CODE_B);
        expect(calls.filter((c) => c.host !== B && c.path.startsWith("/v1")), `${engine} ${a}: 다른 서버로 간 요청`).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 180_000);

  it.skipIf(ENGINES.length === 0)("「바꾸기」 뒤 그대로 타자한 첫 글자가 채운 글을 대신한다", async () => {
    const { context, page } = await openApp(rig(), { stored: A_SHAPES[0] });
    try {
      await toChange(page);
      await page.keyboard.type("n");
      expect(await entryOf(page).inputValue()).toBe("n");
    } finally {
      await context.close();
    }
  }, 60_000);

  it.skipIf(ENGINES.length === 0)("서버가 바뀌면 앞 서버에서 친 비밀번호 8자는 다음 서버의 본문에 0자다", async () => {
    const { context, page, calls } = await openApp(rig(), { stored: A_SHAPES[1] });
    try {
      await page.getByTestId("onboarding-sign-in").waitFor({ state: "visible" });
      await page.getByTestId("login-email").fill("dohyeon@example.test");
      await page.getByTestId("login-password").fill(FIRST);
      await page.getByTestId("connect-server-change").click();
      await entryOf(page).waitFor({ state: "visible" });
      await page.keyboard.insertText(LINK_B);
      await page.keyboard.press("Enter");
      await page.getByTestId("onboarding-join").waitFor({ state: "visible" });
      expect(await page.getByTestId("login-password").inputValue(), "넘어간 뒤 비밀번호 칸").toBe("");
      expect(await page.getByTestId("login-email").inputValue(), "이메일은 남는다").toBe("dohyeon@example.test");
      await page.getByTestId("login-password").fill(SECOND);
      await page.getByTestId("login-submit").click();
      await expect.poll(() => calls.filter((c) => c.path === "/v1/join").length).toBe(1);
      const body = calls.find((c) => c.path === "/v1/join")!.body;
      expect(body.includes(FIRST), "앞 서버 비밀번호가 본문에").toBe(false);
      expect(body.includes(SECOND), "새로 친 비밀번호가 본문에").toBe(true);
    } finally {
      await context.close();
    }
  }, 60_000);
});

// 엔진이 하나도 없으면(CI 레인 · 에이전트 격리) 위 시험은 만들어지지 않는다: 빈 파일로 실패하지 않게 건너뜀 표시만 남긴다.
if (ENGINES.length === 0) it.skip("엔진 없음: 건너뜀", () => undefined);
