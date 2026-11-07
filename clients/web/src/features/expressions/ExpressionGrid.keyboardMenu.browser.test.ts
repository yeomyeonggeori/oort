import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import type { Browser, Page } from "playwright";
import { ENGINES, type EngineName } from "@/design/appearance/compileTokensTestKit";

// =============================================================================
// 이모티콘 칸 메뉴의 키보드 길과 세트 띠의 「지금 구역」 표시 (#5486, 검수 7a H1·M1)
//
// H1: 칸 메뉴(즐겨찾기·신고·삭제)는 Radix `ContextMenu` 라서 `contextmenu` 이벤트로만 열렸다. macOS WebKit(데스크탑 Tauri 의 엔진)은 Shift+F10 에도
// 메뉴 키에도 그 이벤트를 내지 않으므로 키보드만 쓰는 사람은 이 메뉴에 닿을 수 없었다. 예전 시험은 합성 `fireEvent.contextMenu` 만 써서 이 결함에서 붉어질 수 없었다.
// 이 시험은 **실제 엔진에서 실제 키 누름**(`page.keyboard.press`)으로 잰다. jsdom 합성 이벤트는 하나도 쓰지 않는다.
//
// M1: 세트 띠 단추의 `p-0.5` 는 간격 사다리 밖이라 컴파일되지 않아 안여백이 0 이었고, 가장자리까지 칠해진 그림은 `aria-current` 채움을 통째로 덮었다.
// 하네스의 그림은 불투명 정사각형이라 계산된 안여백과 그 자리의 히트 테스트(채움이 그림에 덮이지 않고 단추로 남는지)로 잰다.
//
// 엔진은 `ENGINES`(설치된 WebKit·Chromium 전부)다. 하나도 없으면 건너뛴다(다른 브라우저 시험과 같은 규약). 사보타주: `ExpressionGrid.tsx` 칸의 `onKeyDown` 을 지우면
// H1 두 시험이 「메뉴 0개」로 붉고, `p-1` 을 `p-0.5` 로 되돌리면 M1 시험이 안여백 0 으로 붉다.
// =============================================================================

const CELL = (name: string) => `[data-testid="expression-grid"] button[aria-label="${name} 메시지에 넣기"]`;
const MENU = '[role="menu"]';

type Rig = { engine: EngineName; browser: Browser; origin: string };
const rigs: Rig[] = [];
let server: ViteDevServer | null = null;
let cacheDir = "";

beforeAll(async () => {
  if (ENGINES.length === 0) return;
  cacheDir = mkdtempSync(join(tmpdir(), "oort-expression-menu-vite-"));
  server = await createServer({
    cacheDir,
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
    plugins: [{ name: "expression-grid-menu-fixture", configureServer(vite) {
      vite.middlewares.use("/__expression-grid-menu", async (_req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml("/__expression-grid-menu", `<!doctype html><html lang="en"><head><style>
          html,body{margin:0}#root{width:420px;margin:24px}
          </style></head><body><div id="root"></div><script type="module">import {mountExpressionGridMenuHarness} from '/measure/expressionGridMenu.harness.tsx';mountExpressionGridMenuHarness();</script></body></html>`));
      });
    } }],
  });
  await server.listen();
  console.info(`expression grid keyboard menu: real engines = ${ENGINES.join(", ")}`);
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

/** 하네스 화면을 새 컨텍스트에 열고 그림 여섯 장이 다 그려질 때까지 기다린다. 페이지 오류는 모았다가 시험이 0개인지 본다. */
async function openHarness(rig: Rig, search = ""): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const context = await rig.browser.newContext({ viewport: { width: 900, height: 700 }, locale: "en-US", reducedMotion: "reduce" });
  const page = await context.newPage();
  // 붉을 때 오래 기다리지 않는다: 키를 누르면 메뉴는 한 프레임 안에 선다.
  page.setDefaultTimeout(8_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/v1/**", (route) => route.fulfill({ json: [] }));
  await page.goto(`${rig.origin}/__expression-grid-menu${search}`);
  await page.locator('[data-testid="expression-grid"]').waitFor();
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll<HTMLImageElement>('[data-testid="expression-grid"] img')];
    return images.length === 6 && images.every((image) => image.complete && image.naturalWidth > 0);
  });
  return { page, errors, close: () => context.close() };
}

/** 키를 누른 뒤 메뉴가 서기를 기다린다. 서지 않으면 어느 엔진인지 말한다(그 엔진이 `contextmenu` 를 내지 않는데 키 처리도 없다는 뜻이다). */
async function menuOpened(page: Page, at: string): Promise<void> {
  await page.locator(MENU).waitFor({ timeout: 4_000 }).catch(() => { throw new Error(`${at} 키를 눌렀는데 칸 메뉴가 열리지 않았다`); });
}
const activeLabel = (page: Page) => page.evaluate(() => (document.activeElement?.textContent ?? "").trim());
const rectOf = (page: Page, selector: string) => page.evaluate((target) => {
  const box = document.querySelector(target)!.getBoundingClientRect();
  return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
}, selector);

describe("칸 메뉴의 키보드 길: 실제 엔진, 실제 키 누름 (#5486 H1)", () => {
  it.skipIf(ENGINES.length === 0)("초점을 쥔 칸에서 Shift+F10 이 칸 메뉴를 칸 위치에 열고, 화살표·Enter 로 쓴다. 다른 키는 열지 않는다", async () => {
    for (const rig of rigs) {
      const { page, errors, close } = await openHarness(rig);
      const at = `[${rig.engine}]`;
      try {
        await page.locator(CELL("dam_b")).focus();
        // 아무 키나 열지 않는다: Shift 없는 F10 도, 글자 키도, 화살표도. (이 줄이 없으면 아래 「열렸다」는 「키를 누르면 늘 열린다」로도 통과한다.)
        for (const key of ["F10", "m", "ArrowRight", "ArrowLeft"]) {
          await page.keyboard.press(key);
          expect(await page.locator(MENU).count(), `${at} ${key}`).toBe(0);
        }
        await page.locator(CELL("dam_b")).focus();
        const id = await page.locator(CELL("dam_b")).getAttribute("data-manage");
        const cell = await rectOf(page, CELL("dam_b"));
        await page.keyboard.press("Shift+F10");
        await menuOpened(page, at);
        expect(await page.locator(MENU).count(), `${at} 메뉴는 하나`).toBe(1);
        expect(await page.locator(`${MENU} [role="menuitem"]`).allTextContents(), at).toEqual(["Add to favorites", "신고하기", "삭제하기"]);
        // 칸 위치: 메뉴의 왼쪽 위 모서리가 그 칸의 가로 안, 칸의 아래 가장자리에 선다(화면 왼쪽 위나 마우스 자리가 아니다).
        const menu = await rectOf(page, MENU);
        expect(menu.left, `${at} 메뉴 왼쪽`).toBeGreaterThanOrEqual(cell.left);
        expect(menu.left, `${at} 메뉴 왼쪽`).toBeLessThanOrEqual(cell.right);
        expect(Math.abs(menu.top - cell.bottom), `${at} 메뉴 위쪽과 칸 아래쪽의 거리`).toBeLessThanOrEqual(8);
        // 캐럿이 메뉴 안으로 들어가 첫 항목에 선다 - 여기서 멈추면 「열렸다」의 절반만 증명한 것이다.
        await expect.poll(() => activeLabel(page), { message: `${at} 첫 항목`, timeout: 4_000 }).toBe("Add to favorites");
        // 화살표가 항목 사이를 걷고 메뉴를 떠나지 않는다.
        await page.keyboard.press("ArrowDown");
        await expect.poll(() => activeLabel(page), { message: `${at} 둘째 항목`, timeout: 4_000 }).toBe("신고하기");
        await page.keyboard.press("ArrowDown");
        await expect.poll(() => activeLabel(page), { message: `${at} 셋째 항목`, timeout: 4_000 }).toBe("삭제하기");
        await page.keyboard.press("ArrowUp");
        await expect.poll(() => activeLabel(page), { message: `${at} 다시 둘째 항목`, timeout: 4_000 }).toBe("신고하기");
        await page.keyboard.press("ArrowUp");
        await expect.poll(() => activeLabel(page), { message: `${at} 첫 항목으로 돌아옴`, timeout: 4_000 }).toBe("Add to favorites");
        // Enter 가 그 항목을 실행한다: 즐겨찾기 구역이 서고 메뉴가 닫힌다. 칸을 고르는 일(onPick)은 일어나지 않는다.
        await page.keyboard.press("Enter");
        await page.locator('[data-section="favorites"]').waitFor();
        await page.locator(MENU).waitFor({ state: "detached" });
        expect(await page.evaluate(() => (window as unknown as { expressionGridMenuHarness: { picked: string[] } }).expressionGridMenuHarness.picked), `${at} 메뉴 키가 칸을 고르지 않는다`).toEqual([]);
        // 항목을 골라 닫혀도 초점은 그 칸으로 돌아온다(즐겨찾기 구역이 위에 서도 칸은 그대로 있다).
        await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-manage") ?? null), { message: `${at} 고른 뒤 초점이 그 칸으로`, timeout: 4_000 }).toBe(id);
        expect(errors, `${at} 페이지 오류`).toEqual([]);
      } finally { await close(); }
    }
  }, 180_000);

  it.skipIf(ENGINES.length === 0)("메뉴 키(ContextMenu)도 같은 문이고, Esc 가 메뉴를 닫으면 초점이 그 칸으로 돌아온다", async () => {
    for (const rig of rigs) {
      const { page, errors, close } = await openHarness(rig);
      const at = `[${rig.engine}]`;
      try {
        const cell = page.locator(CELL("chi_b"));
        const id = await cell.getAttribute("data-manage");
        await cell.focus();
        await page.keyboard.press("ContextMenu");
        await menuOpened(page, at);
        expect(await page.locator(MENU).count(), `${at} 메뉴는 하나`).toBe(1);
        await expect.poll(() => activeLabel(page), { message: `${at} 첫 항목`, timeout: 4_000 }).toBe("Add to favorites");
        await page.keyboard.press("Escape");
        await page.locator(MENU).waitFor({ state: "detached" });
        // 닫힘 복귀는 Radix 의 setTimeout(0) 에 실려 온다.
        await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-manage") ?? null), { message: `${at} 초점이 그 칸으로`, timeout: 4_000 }).toBe(id);
        expect(errors, `${at} 페이지 오류`).toEqual([]);
      } finally { await close(); }
    }
  }, 180_000);
});

describe("고르개 안에서도 Esc 한 번은 메뉴만 닫는다 (#5486 H1)", () => {
  it.skipIf(ENGINES.length === 0)("진짜 고르개(모달 팝오버) 안에서 Shift+F10 으로 연 메뉴를 Esc 가 닫아도 고르개는 남고 초점은 그 칸이다. 두 번째 Esc 가 고르개를 닫는다", async () => {
    for (const rig of rigs) {
      const { page, errors, close } = await openHarness(rig, "?host=picker");
      const at = `[${rig.engine}]`;
      try {
        const cell = page.locator(CELL("chi_a"));
        const id = await cell.getAttribute("data-manage");
        await cell.focus();
        await page.keyboard.press("Shift+F10");
        await menuOpened(page, at);
        await expect.poll(() => activeLabel(page), { message: `${at} 첫 항목`, timeout: 4_000 }).toBe("Add to favorites");
        // 사람이 Esc 를 누르는 속도로 기다린다. 메뉴가 선 직후 20ms 미만에 Esc 를 쏘면 Chromium 에서 가끔(실측 40번 중 3~4번) 바깥 층(고르개)도 함께 닫힌다.
        // 20ms 이상 뒤에는 40/40 이었고 사람이 닿을 수 있는 간격이 아니다. 오른쪽 클릭으로 연 메뉴는 같은 기계 속도에서 40/40 이었다(후속 관찰, 인계 참고).
        await page.waitForTimeout(150);
        await page.keyboard.press("Escape");
        await page.locator(MENU).waitFor({ state: "detached" });
        expect(await page.locator('[data-testid="picker"]').count(), `${at} 첫 Esc 는 메뉴만 닫는다`).toBe(1);
        await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-manage") ?? null), { message: `${at} 초점이 그 칸으로`, timeout: 4_000 }).toBe(id);
        await page.keyboard.press("Escape");
        await page.locator('[data-testid="picker"]').waitFor({ state: "detached" });
        expect(errors, `${at} 페이지 오류`).toEqual([]);
      } finally { await close(); }
    }
  }, 180_000);
});

describe("세트 띠의 「지금 구역」 표시는 가장자리까지 칠해진 그림에 가려지지 않는다 (#5486 M1)", () => {
  it.skipIf(ENGINES.length === 0)("불투명 그림 세트가 지금 구역일 때 단추에 안여백이 있고, 그 자리는 그림이 아니라 단추(채움)다", async () => {
    for (const rig of rigs) {
      const { page, close } = await openHarness(rig);
      const at = `[${rig.engine}]`;
      try {
        // 그림이 있는 세트 단추를 눌러 지금 구역으로 만든다(첫 구역이 아니라서 눌러야 표시가 옮겨 온다).
        await page.locator('[data-strip="set:dam"]').click();
        await page.waitForFunction(() => document.querySelector('[data-strip="set:dam"]')?.getAttribute("aria-current") === "true");
        await page.waitForFunction(() => document.querySelector<HTMLImageElement>('[data-strip="set:dam"] img')?.complete === true);
        await page.mouse.move(0, 0); // 호버 채움이 이웃 단추의 값을 흐리지 않게 포인터를 치운다.
        const measured = await page.evaluate(() => {
          const button = document.querySelector<HTMLElement>('[data-strip="set:dam"]')!;
          const image = button.querySelector("img")!;
          const frame = button.getBoundingClientRect();
          const picture = image.getBoundingClientRect();
          const style = getComputedStyle(button);
          // 채움의 값은 지금 구역이 아닌 이웃 단추의 채움(없음)과 달라야 한다. 색 글자를 이 시험에 적지 않고, 스타일을 쓰지도 않는다(`designSystem.test.ts` 의 런타임 스타일 작성자 잔량).
          const neighbor = document.querySelector<HTMLElement>('[data-strip="set:chi"]')!;
          const ring = document.elementFromPoint(frame.left + 2, frame.top + frame.height / 2);
          return {
            padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
            inset: [picture.top - frame.top, frame.right - picture.right, frame.bottom - picture.bottom, picture.left - frame.left],
            fill: style.backgroundColor,
            neighborFill: getComputedStyle(neighbor).backgroundColor,
            ringIsButton: ring === button,
          };
        });
        expect(measured.padding, `${at} 단추의 안여백(px)`).toEqual(["4px", "4px", "4px", "4px"]);
        expect(measured.inset, `${at} 그림이 단추 안쪽으로 들어앉은 거리(px)`).toEqual([4, 4, 4, 4]);
        expect(measured.fill, `${at} 현재 표시의 채움은 현재가 아닌 단추와 다르다`).not.toBe(measured.neighborFill);
        expect(measured.ringIsButton, `${at} 안여백 자리의 히트 테스트는 그림이 아니라 단추다`).toBe(true);
      } finally { await close(); }
    }
  }, 180_000);
});
