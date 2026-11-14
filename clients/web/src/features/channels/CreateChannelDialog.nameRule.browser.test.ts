import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import type { Browser, Page } from "playwright";
import { ENGINES, type EngineName } from "@/design/appearance/compileTokensTestKit";
import { normalizeChannelName } from "@momo/core/features/channels/model";

// =============================================================================
// 채널 만들기 창의 이름 칸은 줄이 서고 걷혀도 창이 움직이지 않는다 (#5833, ADR-0225 D13)
//
// 진짜 `CreateChannelDialog`(진짜 토큰·진짜 사전)를 실제 엔진(설치된 Chromium·WebKit 전부)에 열고, 서버 응답은 경로 가로채기로 흉내 낸다.
// 한 장면 안에서 「한글 조합 → 확정 → 지움 → 영문 대문자·빈칸 → 거절 넷 → 아주 긴 이름 → 서버 409 → 400」을 지나며 **프레임마다**(requestAnimationFrame)
// 창 위치·창 높이·단추 줄 y·공개 범위 y·주제 y·이름 아래 줄 높이를 적고, 모든 프레임의 값이 같음(0px 차이)을 본다. 그 사이 칸 값은 치는 대로여야 하고,
// 값이 같다는 것이 「줄이 아예 안 섰다」는 뜻이 아니도록 장면마다 보인 문장도 같이 적어 기대한 문장이 모두 섰는지 본다.
// 부하에 흔들리지 않게: 시간(ms)이나 한 프레임 표본에 기대지 않는다. 상태가 선 것을 `waitForFunction`으로 기다린 뒤 「그 뒤 세 프레임」을 더 받아 적고, 좌표는 누르는 동안 모양이 바뀌는 단추가 아니라 단추 줄(그릇)에서 잰다.
// 사보타주(각각 이 시험이 붉어진다): 칸 값을 onChange에서 접기 · 자리 예약 층 빼기 · 보낼 때 접기 빼기 · 조합 가드 빼기 · 한글 갈래 빼기 · 예약 층의 `aria-hidden`/`invisible` 빼기.
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
}, 300_000);

afterAll(async () => {
  for (const rig of rigs) await rig.browser.close();
  await server?.close();
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});

type Frame = { dlgTop: number; dlgH: number; btnY: number; kindY: number; topicY: number; slotH: number; text: string };
type Opened = { page: Page; errors: string[]; posted: { name: string }[]; setMode: (mode: "409" | "400") => void; close: () => Promise<void> };

const INPUT = '[data-testid="create-channel-name"]';
const SLOT = '[data-testid="create-channel-name-status"]';

async function open(rig: Rig, vp: { width: number; height: number; rootFontPx: number }, lang: "ko-KR" | "en-US"): Promise<Opened> {
  const context = await rig.browser.newContext({ viewport: { width: vp.width, height: vp.height }, locale: lang, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
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
  await frames(page, 3);
  return { page, errors, posted, setMode: (next) => { mode = next; }, close: () => context.close() };
}

/** 지금부터 n프레임이 그려질 때까지 기다린다(시간이 아니라 프레임 수). */
async function frames(page: Page, count: number) {
  await page.evaluate((n) => new Promise<void>((resolve) => { let left = n; const tick = () => { left -= 1; if (left <= 0) resolve(); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); }), count);
}

/** 이름 아래 줄에 보이는 문장이 `part`를 담을 때까지 기다린 뒤, 그 상태로 세 프레임을 더 받는다. */
async function waitSaid(page: Page, part: string) {
  await page.waitForFunction(([selector, wanted]) => (document.querySelector(selector!)!.children[1] as HTMLElement).innerText.replace(/\s+/g, " ").includes(wanted!), [SLOT, part] as const);
  await frames(page, 3);
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
        // 단추 줄(그릇)의 위: 눌린 단추는 모양이 0.28px 줄어 값이 흔들리지만 그릇은 안 그렇다.
        btnY: document.querySelector('[data-testid="create-channel-cancel"]')!.parentElement!.getBoundingClientRect().top,
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
  await frames(page, 2);
  return page.evaluate(() => {
    const w = window as unknown as { __frames: Frame[]; __stop: boolean };
    w.__stop = true;
    return w.__frames;
  });
}

const GEOMETRY: (keyof Frame)[] = ["dlgTop", "dlgH", "btnY", "kindY", "topicY", "slotH"];
function spread(frameList: Frame[]): Record<string, number> {
  return Object.fromEntries(GEOMETRY.map((key) => {
    const values = frameList.map((frame) => frame[key] as number);
    return [key, Math.round((Math.max(...values) - Math.min(...values)) * 100) / 100];
  }));
}

/** 칸 값이 `value`가 되고 아래 줄이 그 값에 맞는 문장을 말할 때까지 기다린다. */
async function expectField(page: Page, value: string, said: string | null, what: string) {
  await page.waitForFunction(([selector, wanted]) => (document.querySelector(selector!) as HTMLInputElement).value === wanted, [INPUT, value] as const);
  if (said !== null) await waitSaid(page, said);
  expect(await page.locator(INPUT).inputValue(), `${what}: 칸 값은 입력기가 넣은 그대로`).toBe(value);
}

/** 입력기가 조합 글자를 칸에 넣는 순서(compositionstart → input(isComposing) → compositionupdate(data) …)를 그대로 낸다. 실제 입력기는 Chromium CDP 시험이 따로 쓴다. */
async function composeStep(page: Page, value: string, composing: string, first: boolean) {
  await page.locator(INPUT).focus();
  if (first) await page.evaluate((selector) => document.querySelector(selector)!.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })), INPUT);
  await page.evaluate(([selector, text, data]) => {
    const input = document.querySelector<HTMLInputElement>(selector!)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data }));
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true, data }));
  }, [INPUT, value, composing] as const);
}
async function composeEnd(page: Page, commit: string) {
  await page.evaluate(([selector, value]) => document.querySelector(selector!)!.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: value })), [INPUT, commit] as const);
}

async function fillThenWait(page: Page, value: string) {
  await page.locator(INPUT).fill(value);
  await page.waitForFunction(([selector, wanted]) => (document.querySelector(selector!) as HTMLInputElement).value === wanted, [INPUT, value] as const);
  await frames(page, 3);
  expect(await page.locator(INPUT).inputValue(), "칸 값은 친 그대로").toBe(value);
}

/** `디자인 리뷰`를 2벌식으로 치는 걸음: [칸 값, 조합 중인 글자(조합이 아닐 때 null)]. 마지막 음절 `뷰`는 확정되지 않은 채 멈춘다. */
const HANGUL_STEPS: [string, string | null][] = [
  ["ㄷ", "ㄷ"], ["디", "디"], ["딪", "딪"], ["디자", "자"], ["디잔", "잔"], ["디자니", "니"], ["디자인", "인"],
  ["디자인 ", null], ["디자인 ㄹ", "ㄹ"], ["디자인 리", "리"], ["디자인 립", "립"], ["디자인 리ㅂ", "ㅂ"], ["디자인 리뷰", "뷰"],
];
const lineFor = (value: string, lang: "ko-KR" | "en-US"): string | null => {
  const folded = normalizeChannelName(value);
  return folded !== value ? `${lang === "ko-KR" ? "" : "Will be created as "}#${folded}` : null;
};

const VIEWPORTS = [
  { name: "넓은 창 1280×800", width: 1280, height: 800, rootFontPx: 16, langs: ["ko-KR"] as const },
  { name: "폭 390", width: 390, height: 844, rootFontPx: 16, langs: ["ko-KR", "en-US"] as const },
  { name: "데스크탑 최소 창 720×480", width: 720, height: 480, rootFontPx: 16, langs: ["ko-KR"] as const },
  { name: "큰 글자 200%(뿌리 32px)", width: 1280, height: 800, rootFontPx: 32, langs: ["ko-KR", "en-US"] as const },
  { name: "폭 390 · 큰 글자 200%", width: 390, height: 844, rootFontPx: 32, langs: ["ko-KR"] as const },
];
const LONG_FOLDED = "디자인 ".repeat(20).trim(); // 79자, 저장될 이름은 -로 이어져 칸보다 길다.

describe("채널 만들기 창의 이름 아래 줄은 서고 걷혀도 창이 움직이지 않는다 (#5833)", () => {
  for (const vp of VIEWPORTS) {
    for (const lang of vp.langs) {
      it.skipIf(ENGINES.length === 0)(`${vp.name} · ${lang}: 한글 조합·미리보기·거절 넷·긴 이름·서버 409/400을 지나는 모든 프레임에서 창 위치·높이·단추 줄 y·아래 칸 y가 같다`, async () => {
        for (const rig of rigs) {
          const at = `[${rig.engine} ${vp.name} ${lang}]`;
          const { page, errors, posted, setMode, close } = await open(rig, vp, lang);
          const ko = lang === "ko-KR";
          try {
            await startRecording(page);
            let composing = false;
            for (const [value, text] of HANGUL_STEPS) {
              if (text === null) { await composeEnd(page, ""); composing = false; await page.locator(INPUT).fill(value); } else { await composeStep(page, value, text, !composing); composing = true; }
              // 걸음마다 아래 줄 = 그때 칸 값을 접은 이름(한 음절 뒤처지지 않는다). 접어도 같으면 안내 글.
              const line = lineFor(value, lang);
              await expectField(page, value, line ?? (ko ? "글자, 숫자, 하이픈(-)" : "Letters, numbers, hyphens"), `${at} 「${value}」`);
            }
            // 다 치고 멈춘 화면(마지막 음절 조합 중): 저장될 이름은 `#디자인-리뷰`.
            await waitSaid(page, `${ko ? "" : "Will be created as "}#디자인-리뷰`);
            await composeEnd(page, "뷰");
            await fillThenWait(page, "");
            await fillThenWait(page, "Design Review");
            await waitSaid(page, `${ko ? "" : "Will be created as "}#design-review`);
            await fillThenWait(page, "a.b");
            await waitSaid(page, ko ? "글자, 숫자, 하이픈(-), 밑줄(_)만 쓸 수 있어요." : "Use only letters, numbers, hyphens (-) and underscores (_).");
            await fillThenWait(page, "ab\u200bcd");
            await waitSaid(page, ko ? "보이지 않는 글자가 들어 있어요." : "The name contains invisible characters.");
            await fillThenWait(page, "-ab");
            await waitSaid(page, ko ? "처음과 끝은 글자나 숫자여야 해요." : "The name must start and end with a letter or number.");
            await fillThenWait(page, "a".repeat(81));
            await waitSaid(page, ko ? "채널 이름은 80자까지 쓸 수 있어요." : "Channel names can be up to 80 characters.");
            await fillThenWait(page, "A".repeat(80));
            await waitSaid(page, "#aaaaaaaa");
            await fillThenWait(page, LONG_FOLDED);
            await waitSaid(page, "#디자인-디자인");
            await fillThenWait(page, "Ops Room");
            await page.locator('[data-testid="create-channel-submit"]').click();
            await page.locator('[data-testid="create-channel-name-error"]').waitFor();
            await waitSaid(page, "같은 이름의 채널이 이미 있습니다.");
            setMode("400");
            await fillThenWait(page, "Ops Room 2");
            await page.locator('[data-testid="create-channel-submit"]').click();
            await waitSaid(page, ko ? "서버가 이 이름을 받지 않았어요." : "The server did not accept this name.");
            const frameList = await stopRecording(page);

            expect(frameList.length, `${at} 프레임이 쌓였다`).toBeGreaterThan(30);
            expect(spread(frameList), `${at} 모든 프레임의 값 차이(px)`).toEqual({ dlgTop: 0, dlgH: 0, btnY: 0, kindY: 0, topicY: 0, slotH: 0 });
            // 보낼 때 접은 이름이 나간다(칸에는 친 그대로였다).
            expect(posted.map((body) => body.name), `${at} 보낸 이름`).toEqual(["ops-room", "ops-room-2"]);
            const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth - innerWidth, form: (() => { const form = document.getElementById("create-channel-form")!; return form.scrollWidth - form.clientWidth; })() }));
            expect(overflow, `${at} 가로 넘침`).toEqual({ page: 0, form: 0 });
            expect(errors, `${at} 페이지 오류`).toEqual([]);
          } finally { await close(); }
        }
      }, 300_000);
    }
  }

  it.skipIf(ENGINES.length === 0)("81번째 음절이 조합 중이어도 「80자까지」 거절이 서고, 병음·변환 전 가나 조합 중에는 거절·미리보기가 한 번도 안 선다", async () => {
    for (const rig of rigs) {
      const { page, close } = await open(rig, { width: 1280, height: 800, rootFontPx: 16 }, "ko-KR");
      try {
        await fillThenWait(page, "가".repeat(80));
        await composeStep(page, "가".repeat(80) + "ㄴ", "ㄴ", true);
        await waitSaid(page, "채널 이름은 80자까지 쓸 수 있어요.");
        expect(await page.locator(INPUT).getAttribute("aria-invalid"), `[${rig.engine}] 81번째 음절 조합 중 aria-invalid`).toBe("true");
        await composeEnd(page, "");
        await fillThenWait(page, "");
        await startRecording(page);
        await composeStep(page, "team n", "n", true);
        for (const [value, data] of [["team ni", "ni"], ["team ni'", "ni'"], ["team ni'h", "ni'h"], ["team でざ", "でざ"], ["team でざいん", "でざいん"]] as const) {
          await composeStep(page, value, data, false);
          await expectField(page, value, "글자, 숫자, 하이픈(-)", `[${rig.engine}] ${value}`);
        }
        const seen = (await stopRecording(page)).map((frame) => frame.text);
        await composeEnd(page, "");
        expect(seen.filter((text) => text.includes("쓸 수 있어요") || text.includes("이름으로 만들어져요")), `[${rig.engine}] 조합 중 거절·미리보기 프레임`).toEqual([]);
      } finally { await close(); }
    }
  }, 240_000);

  it.skipIf(ENGINES.length === 0)("큰 글자(390 · 200%)에서 미리보기는 예약된 줄 안에서 줄바꿈하고 이름이 잘리지 않으며, 아주 긴 이름은 …로 줄고 자리를 넘지 않는다", async () => {
    for (const rig of rigs) {
      const { page, close } = await open(rig, { width: 390, height: 844, rootFontPx: 32 }, "ko-KR");
      try {
        await fillThenWait(page, "디자인 리뷰 회의록 모음 정리 목록");
        await waitSaid(page, "#디자인-리뷰-회의록-모음-정리-목록");
        const probe = () => page.evaluate(() => {
          const preview = document.querySelector<HTMLElement>('[data-testid="create-channel-name-preview"]')!;
          const slot = document.querySelector<HTMLElement>('[data-testid="create-channel-name-status"]')!;
          const lineHeight = Number.parseFloat(getComputedStyle(preview).lineHeight);
          return { previewH: preview.getBoundingClientRect().height, slotH: slot.getBoundingClientRect().height, lineHeight, clipped: preview.scrollHeight - preview.clientHeight, right: preview.getBoundingClientRect().right, slotRight: slot.getBoundingClientRect().right, nameRight: preview.querySelector("span")!.getBoundingClientRect().right, text: preview.innerText.replace(/\s+/g, "") };
        });
        const normal = await probe();
        expect(normal.text, `[${rig.engine}] 이름이 전부 보인다`).toContain("#디자인-리뷰-회의록-모음-정리-목록");
        expect(normal.clipped, `[${rig.engine}] 잘림 0`).toBeLessThanOrEqual(1);
        expect(normal.nameRight, `[${rig.engine}] 이름이 칸 오른쪽을 넘어 가려지지 않는다`).toBeLessThanOrEqual(normal.slotRight + 0.5);
        expect(normal.previewH, `[${rig.engine}] 줄바꿈해서 예약된 자리 안(${normal.slotH}px)`).toBeLessThanOrEqual(normal.slotH);
        await fillThenWait(page, LONG_FOLDED);
        await waitSaid(page, "#디자인-디자인");
        const long = await probe();
        expect(long.previewH, `[${rig.engine}] 긴 이름도 자리(${long.slotH}px) 안`).toBeLessThanOrEqual(long.slotH);
        expect(long.previewH, `[${rig.engine}] 여러 줄로 쓴다(한 줄 ${long.lineHeight}px)`).toBeGreaterThan(long.lineHeight * 1.5);
        expect(long.right, `[${rig.engine}] 오른쪽이 칸 안`).toBeLessThanOrEqual(long.slotRight + 0.01);
      } finally { await close(); }
    }
  }, 240_000);

  it.skipIf(ENGINES.length === 0)("겹쳐 둔 예약 문장은 낭독기에 읽히지 않는다: aria-hidden·계산된 visibility·접근성 스냅샷 모두", async () => {
    for (const rig of rigs) {
      const { page, close } = await open(rig, { width: 390, height: 844, rootFontPx: 16 }, "ko-KR");
      try {
        const reservedSentences = ["채널 이름을 입력해 주세요.", "보이지 않는 글자가 들어 있어요.", "서버가 이 이름을 받지 않았어요.", "같은 이름의 채널이 이미 있습니다."];
        for (const value of ["", "Design Review", "a.b"]) {
          await fillThenWait(page, value);
          const layer = await page.evaluate((selector) => {
            const box = document.querySelector(selector)!.children[0] as HTMLElement;
            return { ariaHidden: box.getAttribute("aria-hidden"), visibility: getComputedStyle(box).visibility, count: box.children.length, paragraphs: [...box.querySelectorAll("p")].map((p) => getComputedStyle(p).visibility) };
          }, SLOT);
          const at = `[${rig.engine}] 「${value}」`;
          expect(layer.count, `${at} 예약 문장이 실제로 겹쳐 있다`).toBeGreaterThan(5);
          expect(layer.ariaHidden, `${at} aria-hidden`).toBe("true");
          expect(layer.visibility, `${at} 계산된 visibility`).toBe("hidden");
          expect(new Set(layer.paragraphs), `${at} 문장마다 hidden`).toEqual(new Set(["hidden"]));
          const tree = await page.locator(SLOT).ariaSnapshot();
          for (const sentence of reservedSentences) expect(tree, `${at} 접근성 스냅샷에 예약 문장이 없다`).not.toContain(sentence);
          if (value === "a.b") expect(tree, `${at} 서 있는 거절 문장은 읽힌다`).toContain("글자, 숫자, 하이픈(-), 밑줄(_)만 쓸 수 있어요.");
          if (value === "") expect(tree, `${at} 서 있는 안내 글은 읽힌다`).toContain("글자, 숫자, 하이픈(-)");
        }
      } finally { await close(); }
    }
  }, 240_000);

  it.skipIf(!ENGINES.includes("chromium"))("실제 입력기(Chromium CDP): 음절마다 조합하며 쳐도 걸음마다 아래 줄이 칸 값을 따라가고 멈춘 화면이 `#디자인-리뷰`이며, 병음 조합 글자는 거절하지 않는다", async () => {
    const rig = rigs.find((candidate) => candidate.engine === "chromium")!;
    const { page, errors, close } = await open(rig, { width: 1280, height: 800, rootFontPx: 16 }, "ko-KR");
    try {
      const cdp = await page.context().newCDPSession(page);
      await startRecording(page);
      await page.locator(INPUT).focus();
      for (const text of ["n", "ni", "ni'", "ni'h", "ni'ha"]) {
        await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
        await expectField(page, text, "글자, 숫자, 하이픈(-)", `병음 ${text}`);
      }
      await cdp.send("Input.insertText", { text: "你好" });
      await expectField(page, "你好", null, "병음 확정");
      await fillThenWait(page, "");
      // 음절마다 조합하고 확정한다. 마지막 음절 `뷰`는 확정하지 않은 채 멈춘다.
      const syllables: [string, string[]][] = [["디", ["ㄷ", "디"]], ["자", ["ㅈ", "자"]], ["인", ["ㅇ", "이", "인"]], [" ", []], ["리", ["ㄹ", "리"]], ["뷰", ["ㅂ", "뷰"]]];
      let committed = "";
      for (const [syllable, composingSteps] of syllables) {
        if (composingSteps.length === 0) { await cdp.send("Input.insertText", { text: syllable }); committed += syllable; await expectField(page, committed, null, "공백"); continue; }
        for (const text of composingSteps) {
          await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
          const value = committed + text;
          const line = lineFor(value, "ko-KR");
          await expectField(page, value, line ?? "글자, 숫자, 하이픈(-)", `한글 ${value}`);
        }
        if (syllable !== "뷰") { await cdp.send("Input.insertText", { text: syllable }); committed += syllable; }
      }
      await waitSaid(page, "#디자인-리뷰");
      expect(await page.locator(INPUT).inputValue()).toBe("디자인 리뷰");
      const frameList = await stopRecording(page);
      const texts = frameList.map((frame) => frame.text);
      expect(texts.filter((text) => text.includes("쓸 수 있어요")), "조합 중 거절 문장이 한 프레임도 서지 않았다").toEqual([]);
      expect(spread(frameList), "실제 입력기로 치는 내내 창이 움직이지 않았다").toEqual({ dlgTop: 0, dlgH: 0, btnY: 0, kindY: 0, topicY: 0, slotH: 0 });
      expect(errors).toEqual([]);
    } finally { await close(); }
  }, 240_000);
});
