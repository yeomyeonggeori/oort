import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import type { Browser, Page } from "playwright";
import { ENGINES, type EngineName } from "@/design/appearance/compileTokensTestKit";

// =============================================================================
// 채널 만들기 창의 이름 칸은 줄이 서고 걷혀도 창이 움직이지 않는다 (#5833, ADR-0225 D13)
//
// 진짜 `CreateChannelDialog`(진짜 토큰·진짜 사전)를 실제 엔진(설치된 Chromium·WebKit 전부)에 열고, 서버 응답은 경로 가로채기로 흉내 낸다.
// 한 장면 안에서 「한글 조합 → 확정 → 지움 → 영문 대문자·빈칸 → 거절 넷 → 아주 긴 이름 → 서버 409 → 400」을 지나며 **프레임마다**(requestAnimationFrame)
// 창 위치·창 높이·단추 줄 y·공개 범위 y·주제 y·이름 아래 줄 높이를 적고, 모든 프레임의 값이 같음(0px 차이)을 본다. 그 사이 칸 값은 치는 대로여야 하고,
// 값이 같다는 것이 「줄이 아예 안 섰다」는 뜻이 아니도록 장면마다 보인 문장도 같이 적어 기대한 문장이 모두 섰는지 본다.
// 사보타주(각각 이 시험이 붉어진다): 칸 값을 onChange에서 접기 · 자리 예약 층 빼기 · 보낼 때 접기 빼기 · 조합 가드 빼기(후자 둘은 단위 시험 `CreateChannelDialog.nameRule.test.tsx`도).
// =============================================================================

type Rig = { engine: EngineName; browser: Browser; origin: string };
const rigs: Rig[] = [];
let server: ViteDevServer | null = null;
let cacheDir = "";

beforeAll(async () => {
  if (ENGINES.length === 0) return;
  cacheDir = mkdtempSync(join(tmpdir(), "oort-create-channel-name-vite-"));
  server = await createServer({
    cacheDir,
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
    plugins: [{ name: "create-channel-name-fixture", configureServer(vite) {
      vite.middlewares.use("/__create-channel", async (_req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml("/__create-channel", `<!doctype html><html lang="ko"><head><style>html,body{margin:0;height:100%}</style></head><body class="bg-surface text-ink"><div id="root"></div><script type="module">import {mountCreateChannelHarness} from '/measure/createChannel.harness.tsx';mountCreateChannelHarness();</script></body></html>`));
      });
    } }],
  });
  await server.listen();
  console.info(`create channel name: real engines = ${ENGINES.join(", ")}`);
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("브라우저 시험 포트가 없어요");
  const playwright = await import("playwright");
  for (const engine of ENGINES) rigs.push({ engine, browser: await playwright[engine].launch({ headless: true }), origin: `http://127.0.0.1:${address.port}` });
}, 180_000);

afterAll(async () => {
  for (const rig of rigs) await rig.browser.close();
  await server?.close();
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});

type Frame = { dlgTop: number; dlgH: number; btnY: number; kindY: number; topicY: number; slotH: number; text: string };
type Opened = { page: Page; errors: string[]; posted: { name: string }[]; setMode: (mode: "409" | "400") => void; close: () => Promise<void> };

const INPUT = '[data-testid="create-channel-name"]';

async function open(rig: Rig, vp: { width: number; height: number; rootFontPx: number }, lang: "ko-KR" | "en-US"): Promise<Opened> {
  const context = await rig.browser.newContext({ viewport: { width: vp.width, height: vp.height }, locale: lang, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  const posted: { name: string }[] = [];
  let mode: "409" | "400" = "409";
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/v1/**", (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      posted.push(request.postDataJSON() as { name: string });
      return route.fulfill({ status: mode === "409" ? 409 : 400, json: { error: { code: mode === "409" ? "conflict" : "invalid", message: "channel name must use letters" } } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(`${rig.origin}/__create-channel?lang=${lang}`);
  await page.locator('[data-testid="create-channel-dialog"]').waitFor();
  // 열림 움직임(확대)은 잰 값에 섞이지 않게 멈추고, 큰 글자는 뿌리 글자 크기로 만든다(200% = 32px).
  await page.addStyleTag({ content: `html{font-size:${vp.rootFontPx}px} *,*::before,*::after{animation:none!important;transition:none!important}` });
  await page.waitForTimeout(400);
  return { page, errors, posted, setMode: (next) => { mode = next; }, close: () => context.close() };
}

/** 프레임마다 창 상자를 적기 시작한다. 읽을 때는 모아 둔 프레임을 가져온다. */
async function startRecording(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: unknown[]; __stop: boolean };
    w.__frames = [];
    w.__stop = false;
    const y = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().top ?? -1;
    const loop = () => {
      const dialog = document.querySelector('[data-testid="create-channel-dialog"]')!.getBoundingClientRect();
      const slot = document.querySelector('[data-testid="create-channel-name-status"]')!;
      w.__frames.push({
        dlgTop: dialog.top,
        dlgH: dialog.height,
        btnY: y('[data-testid="create-channel-submit"]'),
        kindY: y('[data-testid="create-channel-kind"]'),
        topicY: y('[data-testid="create-channel-topic"]'),
        slotH: slot.getBoundingClientRect().height,
        text: (slot.children[1] as HTMLElement).innerText,
      });
      if (!w.__stop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}
async function stopRecording(page: Page): Promise<Frame[]> {
  await page.waitForTimeout(100);
  return page.evaluate(() => {
    const w = window as unknown as { __frames: Frame[]; __stop: boolean };
    w.__stop = true;
    return w.__frames;
  });
}

const GEOMETRY: (keyof Frame)[] = ["dlgTop", "dlgH", "btnY", "kindY", "topicY", "slotH"];
function spread(frames: Frame[]): Record<string, number> {
  return Object.fromEntries(GEOMETRY.map((key) => {
    const values = frames.map((frame) => frame[key] as number);
    return [key, Math.round((Math.max(...values) - Math.min(...values)) * 100) / 100];
  }));
}

/** 입력기가 조합 글자를 칸에 넣는 순서(compositionstart → input(isComposing)… → compositionend)를 그대로 낸다. 실제 입력기는 아래 Chromium 시험이 따로 쓴다. */
async function compose(page: Page, steps: string[], commit: string) {
  await page.locator(INPUT).focus();
  await page.evaluate((selector) => document.querySelector(selector)!.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })), INPUT);
  for (const step of steps) {
    await page.evaluate((value) => {
      const input = document.querySelector<HTMLInputElement>('[data-testid="create-channel-name"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true, data: value }));
      input.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: value }));
    }, step);
    await page.waitForTimeout(30);
    expect(await page.locator(INPUT).inputValue(), "조합 중 칸 값 = 입력기가 넣은 그대로").toBe(step);
  }
  await page.evaluate(([selector, value]) => document.querySelector(selector!)!.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: value })), [INPUT, commit] as const);
  await page.waitForTimeout(60);
  expect(await page.locator(INPUT).inputValue(), "확정 뒤 칸 값").toBe(steps[steps.length - 1]);
}

async function fillThenWait(page: Page, value: string) {
  await page.locator(INPUT).fill(value);
  await page.waitForTimeout(60);
  expect(await page.locator(INPUT).inputValue(), "칸 값은 친 그대로").toBe(value);
}

const VIEWPORTS = [
  { name: "넓은 창 1280×800", width: 1280, height: 800, rootFontPx: 16, langs: ["ko-KR"] as const },
  { name: "폭 390", width: 390, height: 844, rootFontPx: 16, langs: ["ko-KR", "en-US"] as const },
  { name: "데스크탑 최소 창 720×480", width: 720, height: 480, rootFontPx: 16, langs: ["ko-KR"] as const },
  { name: "큰 글자 200%(뿌리 32px)", width: 1280, height: 800, rootFontPx: 32, langs: ["ko-KR", "en-US"] as const },
  { name: "폭 390 · 큰 글자 200%", width: 390, height: 844, rootFontPx: 32, langs: ["ko-KR"] as const },
];
const HANGUL_STEPS = ["ㄷ", "디", "디ㅈ", "디자", "디잉", "디자인", "디자인 ", "디자인 ㄹ", "디자인 리", "디자인 릐", "디자인 리뷰"];
const LONG_FOLDED = "디자인 ".repeat(20).trim(); // 79자, 저장될 이름은 -로 이어져 칸보다 길다.

describe("채널 만들기 창의 이름 아래 줄은 서고 걷혀도 창이 움직이지 않는다 (#5833)", () => {
  for (const vp of VIEWPORTS) {
    for (const lang of vp.langs) {
      it.skipIf(ENGINES.length === 0)(`${vp.name} · ${lang}: 조합·미리보기·거절 넷·긴 이름·서버 409/400을 지나는 모든 프레임에서 창 위치·높이·단추 줄 y·아래 칸 y가 같다`, async () => {
        for (const rig of rigs) {
          const at = `[${rig.engine} ${vp.name} ${lang}]`;
          const { page, errors, posted, setMode, close } = await open(rig, vp, lang);
          try {
            await startRecording(page);
            await compose(page, HANGUL_STEPS, "디자인 리뷰");
            await fillThenWait(page, "");
            await fillThenWait(page, "Design Review");
            await fillThenWait(page, "a.b");
            await fillThenWait(page, "ab\u200bcd");
            await fillThenWait(page, "-ab");
            await fillThenWait(page, "a".repeat(81));
            await fillThenWait(page, "A".repeat(80));
            await fillThenWait(page, LONG_FOLDED);
            await fillThenWait(page, "Ops Room");
            await page.locator('[data-testid="create-channel-submit"]').click();
            await page.locator('[data-testid="create-channel-name-error"]').waitFor();
            await page.waitForTimeout(120);
            setMode("400");
            await fillThenWait(page, "Ops Room 2");
            await page.locator('[data-testid="create-channel-submit"]').click();
            await page.waitForFunction(() => document.querySelector('[data-testid="create-channel-name-error"]')?.textContent?.length);
            await page.waitForTimeout(120);
            const frames = await stopRecording(page);

            expect(frames.length, `${at} 프레임이 충분히 쌓였다`).toBeGreaterThan(30);
            const moved = spread(frames);
            expect(moved, `${at} 모든 프레임의 값 차이(px)`).toEqual({ dlgTop: 0, dlgH: 0, btnY: 0, kindY: 0, topicY: 0, slotH: 0 });
            // 값이 같다는 것이 줄이 안 섰다는 뜻이 아니다: 기대한 문장이 모두 한 번은 섰다.
            const seen = new Set(frames.map((frame) => frame.text.replace(/\s+/g, " ").trim()));
            const has = (part: string) => [...seen].some((text) => text.includes(part));
            const ko = lang === "ko-KR";
            expect(has(ko ? "#디자인-리뷰 이름으로 만들어져요" : "Will be created as #디자인-리뷰"), `${at} 한글 미리보기`).toBe(true);
            expect(has(ko ? "#design-review 이름으로 만들어져요" : "Will be created as #design-review"), `${at} 영문 미리보기`).toBe(true);
            expect(has(ko ? "글자, 숫자, 하이픈(-), 밑줄(_)만 쓸 수 있어요." : "Use only letters, numbers, hyphens (-) and underscores (_)."), `${at} 쓸 수 없는 글자`).toBe(true);
            expect(has(ko ? "보이지 않는 글자가 들어 있어요." : "The name contains invisible characters."), `${at} 보이지 않는 글자`).toBe(true);
            expect(has(ko ? "처음과 끝은 글자나 숫자여야 해요." : "The name must start and end with a letter or number."), `${at} 처음·끝`).toBe(true);
            expect(has(ko ? "채널 이름은 80자까지 쓸 수 있어요." : "Channel names can be up to 80 characters."), `${at} 80자 넘음`).toBe(true);
            expect(has(ko ? "같은 이름의 채널이 이미 있습니다." : "같은 이름의 채널이 이미 있습니다."), `${at} 409`).toBe(true);
            expect(has(ko ? "서버가 이 이름을 받지 않았어요." : "The server did not accept this name."), `${at} 400`).toBe(true);
            // 보낼 때 접은 이름이 나간다(칸에는 친 그대로였다).
            expect(posted.map((body) => body.name), `${at} 보낸 이름`).toEqual(["ops-room", "ops-room-2"]);
            // 아주 긴 미리보기도 칸 안에 머물고 옆으로 밀지 않는다.
            const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth - innerWidth, form: (() => { const form = document.getElementById("create-channel-form")!; return form.scrollWidth - form.clientWidth; })() }));
            expect(overflow, `${at} 가로 넘침`).toEqual({ page: 0, form: 0 });
            expect(errors, `${at} 페이지 오류`).toEqual([]);
          } finally { await close(); }
        }
      }, 120_000);
    }
  }

  it.skipIf(ENGINES.length === 0)("미리보기 줄은 80자에 가까운 이름에서도 한 줄이고 칸 폭을 넘지 않는다(390 · 200%)", async () => {
    for (const rig of rigs) {
      const { page, close } = await open(rig, { width: 390, height: 844, rootFontPx: 32 }, "ko-KR");
      try {
        await fillThenWait(page, LONG_FOLDED);
        const box = await page.evaluate(() => {
          const preview = document.querySelector<HTMLElement>('[data-testid="create-channel-name-preview"]')!;
          const slot = document.querySelector<HTMLElement>('[data-testid="create-channel-name-status"]')!;
          const name = preview.children[1] as HTMLElement;
          return { previewH: preview.getBoundingClientRect().height, slotH: slot.getBoundingClientRect().height, previewRight: preview.getBoundingClientRect().right, slotRight: slot.getBoundingClientRect().right, nameClipped: name.scrollWidth > name.clientWidth };
        });
        expect(box.previewRight, `[${rig.engine}] 미리보기 오른쪽이 칸 안`).toBeLessThanOrEqual(box.slotRight + 0.01);
        expect(box.previewH, `[${rig.engine}] 한 줄이라 자리(${box.slotH}px)보다 낮거나 같다`).toBeLessThanOrEqual(box.slotH);
        expect(box.nameClipped, `[${rig.engine}] 긴 이름은 …으로 줄어 보인다`).toBe(true);
      } finally { await close(); }
    }
  }, 120_000);

  it.skipIf(!ENGINES.includes("chromium"))("실제 입력기(Chromium CDP): 병음 조합 글자는 거절하지 않고, 한글 조합 중 칸 값은 입력기 그대로이며, 확정되면 저장될 이름을 말한다", async () => {
    const rig = rigs.find((candidate) => candidate.engine === "chromium")!;
    const { page, errors, close } = await open(rig, { width: 1280, height: 800, rootFontPx: 16 }, "ko-KR");
    try {
      const cdp = await page.context().newCDPSession(page);
      await startRecording(page);
      await page.locator(INPUT).focus();
      for (const step of ["n", "ni", "ni'", "ni'h", "ni'ha"]) {
        await cdp.send("Input.imeSetComposition", { text: step, selectionStart: step.length, selectionEnd: step.length });
        await page.waitForTimeout(40);
        expect(await page.locator(INPUT).inputValue(), "병음 조합 중 칸 값").toBe(step);
      }
      await cdp.send("Input.insertText", { text: "你好" });
      await page.waitForTimeout(60);
      expect(await page.locator(INPUT).inputValue()).toBe("你好");
      await fillThenWait(page, "");
      for (const step of HANGUL_STEPS) {
        await cdp.send("Input.imeSetComposition", { text: step, selectionStart: step.length, selectionEnd: step.length });
        await page.waitForTimeout(40);
        expect(await page.locator(INPUT).inputValue(), "한글 조합 중 칸 값").toBe(step);
      }
      await cdp.send("Input.insertText", { text: "디자인 리뷰" });
      await page.waitForTimeout(80);
      expect(await page.locator(INPUT).inputValue()).toBe("디자인 리뷰");
      const frames = await stopRecording(page);
      const texts = frames.map((frame) => frame.text);
      expect(texts.filter((text) => text.includes("쓸 수 있어요")), "병음 조합 중에는 거절 문장이 한 프레임도 서지 않았다").toEqual([]);
      expect(texts.some((text) => text.includes("#디자인-리뷰")), "확정 뒤 저장될 이름이 섰다").toBe(true);
      expect(spread(frames), "실제 입력기로 치는 내내 창이 움직이지 않았다").toEqual({ dlgTop: 0, dlgH: 0, btnY: 0, kindY: 0, topicY: 0, slotH: 0 });
      expect(errors).toEqual([]);
    } finally { await close(); }
  }, 120_000);
});
