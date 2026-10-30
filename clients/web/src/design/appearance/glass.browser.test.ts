import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { blend } from "@momo/core/design/scrim";
import { firstPartyGlassSources, glassChrome, glassFloor, glassVariables } from "@momo/core/design/glass";
import { THEMES, type Mode, type ThemeId } from "@momo/core/design/themes";
import { browserLaunchBlocked } from "@/testing/agentSandbox";

/**
 * 유리 CSS가 **실제로 그리는 것**을 엔진이 계산한 픽셀로 잰다 (AP-3 #4190, AC 3·5·6).
 *
 * core의 하한·보정 산수(`glass.ts`)는 「바닥색 한 겹을 α로 뒤 픽셀 위에 칠한다」는 합성을 전제로 한다. 진짜 앱에서
 * 그 「뒤」는 웹뷰 **밑**의 네이티브 블러 층이다. 이 시험은 같은 구조를 흉내 낸다: 문서를 **투명한 캔버스**로
 * 찍어(`omitBackground`, 알파가 있는 PNG) 웹이 칠한 층만 얻고, 그 위에 아는 뒤 색(빨강·파랑)을 직접 합성한다.
 * 그러면 사이드바·타이틀바·가장자리의 한 픽셀이 `blend(바닥, 뒤 색, α)`와 같은지(±3), 알파가 α인지를 잴 수 있다.
 * 같은 시험이 본문 판은 알파 1(뒤 색과 무관하게 불투명)이고, `data-glass`가 없으면 알파 1이고, 셸이 없는 화면은
 * 통째로 알파 1이고(`body` 배경이 캔버스로 퍼지기 때문이다), 접근성 질의에서 불투명으로 돌아가는 것도 잰다. 같은
 * 문서를 유리 없이도 그려 보아 「알파가 α인 것」이 **하네스의 우연이 아님**을 확인한다.
 *
 * 바닥은 평면(세 정지점이 같은 색)으로 고정한다: 그러면 픽셀 위치와 무관하게 기댓값이 한 값이고, 그라데이션 식은 이
 * 시험이 아니라 `tokens.css`의 몫이다(식이 어긋나지 않는지는 문자열 시험이 잰다).
 *
 * 엔진: 설치된 Playwright 엔진 전부(Chromium, WebKit). 하나도 없으면 경고를 남기고 건너뛴다(다른 브라우저 시험과
 * 같은 규약). 진짜 WKWebView에서의 결과는 PR의 실제 앱 캡처가 맡는다.
 */

const require_ = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS = join(HERE, "..", "tokens.css");

type EngineName = "webkit" | "chromium";

function engineMissing(name: EngineName): string | null {
  const blocked = browserLaunchBlocked();
  if (blocked !== null) return blocked;
  try {
    const playwright = require_("playwright") as typeof import("playwright");
    const exe = playwright[name].executablePath();
    return existsSync(exe) ? null : exe;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const ENGINES: EngineName[] = (["webkit", "chromium"] as const).filter((name) => {
  const missing = engineMissing(name);
  if (missing !== null) console.warn(`glass browser test: Playwright ${name} missing (${missing})`);
  return missing === null;
});

async function loadStylesheet(id: string, base: string) {
  if (id === "tailwindcss" || id.endsWith("tailwindcss/index.css")) {
    const path = require_.resolve("tailwindcss/index.css");
    return { path, base: dirname(path), content: readFileSync(path, "utf8") };
  }
  const path = id.startsWith(".") || id.startsWith("/") ? `${base}/${id}` : id;
  return { path, base: dirname(path), content: readFileSync(path, "utf8") };
}

async function buildCss(): Promise<string> {
  const compiler = await compile(readFileSync(TOKENS, "utf8"), { base: join(HERE, ".."), loadStylesheet });
  return compiler.build(["app-shell", "app-titlebar", "sidebar-drawer", "app-pane", "settings-nav", "text-ink-muted"]);
}

const channels = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** 색 리터럴을 소스에 적지 않으려는 도구(lint가 소스의 `#rrggbb` 문자열을 막는다). */
const hexOf = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;

const BACKDROPS = {
  red: hexOf(255, 0, 0),
  blue: hexOf(0, 0, 255),
} as const;

interface Scene {
  theme: ThemeId;
  mode: Mode;
  /** 루트에 `data-glass`를 찍는가. */
  glass: boolean;
  /** 뒤 색: 시험이 웹이 칠한 층 밑에 직접 합성한다(`composite`). 문서에는 들어가지 않는다. */
  backdrop: keyof typeof BACKDROPS;
  /** 저장된 불투명도(퍼센트). 없으면 기본. */
  opacity?: number;
  /** 셸 속성: `collapsed` · `work-rail` · `work-rail-collapsed` · `settings` · `none`(셸 없는 화면). */
  shell?: "collapsed" | "work-rail" | "work-rail-collapsed" | "settings" | "none";
}

/** 루트에 꽂을 변수. 바닥은 평면으로 덮고(세 정지점 같은 색), 띠가 있는 테마는 띠 변수도 꽂는다. */
function rootVars(scene: Scene): { style: string; flat: string } {
  const tokens = THEMES[scene.theme];
  const flat = tokens[scene.mode].canvas[1];
  const lightDark = (role: (mode: Mode) => string) => `light-dark(${role("light")}, ${role("dark")})`;
  const canvas = lightDark((mode) => tokens[mode].canvas[1]);
  const vars: Record<string, string> = {
    "--canvas-top": canvas,
    "--canvas-mid": canvas,
    "--canvas-bottom": canvas,
  };
  if (tokens.light.band && tokens.dark.band) {
    vars["--band"] = lightDark((mode) => (tokens[mode].band as NonNullable<typeof tokens.light.band>).band);
    vars["--on-band"] = lightDark((mode) => (tokens[mode].band as NonNullable<typeof tokens.light.band>)["on-band"]);
    vars["--on-band-muted"] = lightDark(
      (mode) => (tokens[mode].band as NonNullable<typeof tokens.light.band>)["on-band-muted"]
    );
  }
  if (scene.glass) Object.assign(vars, glassVariables(firstPartyGlassSources(scene.theme), scene.opacity));
  return {
    flat,
    style: Object.entries(vars)
      .map(([name, value]) => `${name}: ${value}`)
      .join("; "),
  };
}

function html(css: string, scene: Scene): string {
  const { style } = rootVars(scene);
  const attrs = (scene.glass ? " data-glass" : "") + ` data-theme="${scene.mode}"`;
  const shellAttr =
    scene.shell === "collapsed"
      ? " data-sidebar-collapsed"
      : scene.shell === "work-rail"
        ? " data-work-rail"
        : scene.shell === "work-rail-collapsed"
          ? " data-work-rail data-sidebar-collapsed"
          : scene.shell === "settings"
            ? " data-settings-surface"
            : "";
  const body =
    scene.shell === "none"
      ? `<main id="plain">로그인 전 화면</main>`
      : scene.shell === "settings"
        ? `<div class="app-shell"${shellAttr}><main class="app-pane" id="pane"><nav class="settings-nav" id="nav"><span id="nav-label" class="text-ink-muted">설정 목록</span></nav></main></div>`
        : `<div class="app-shell"${shellAttr}>
             <header class="app-titlebar"><span id="titlebar-label" class="text-ink-muted">토글</span></header>
             <aside class="sidebar-drawer"><span id="side-label" class="text-ink-muted">사이드바</span></aside>
             <main class="app-pane" id="pane"></main>
           </div>`;
  return `<!doctype html><html lang="ko"${attrs} style="${style}"><head>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>${css}</style></head><body>
${body}</body></html>`;
}

type Rgba = [number, number, number, number];

/** 웹이 칠한 한 픽셀(투명한 캔버스 위). 알파가 0이면 웹이 아무것도 칠하지 않은 자리(네이티브 층이 그대로 보인다)다. */
async function pixel(page: Page, x: number, y: number): Promise<Rgba> {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 }, omitBackground: true });
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, 1, 1).data;
    return [data[0], data[1], data[2], data[3]] as Rgba;
  }, png.toString("base64"));
}

/** 그 픽셀 밑에 뒤 색을 깐 합성(sRGB 값 선형 혼합, CSS 알파 합성과 같다). */
function composite(over: Rgba, backdrop: string): [number, number, number] {
  const under = channels(backdrop);
  const a = over[3] / 255;
  return [0, 1, 2].map((i) => Math.round(a * over[i] + (1 - a) * under[i])) as [number, number, number];
}

const within = (actual: readonly number[], expected: readonly number[], tolerance = 3): boolean =>
  expected.every((value, index) => Math.abs(actual[index] - value) <= tolerance);

/** 계산된 글자색의 세 채널. 문자열이 아니라 채널로 비교한다(엔진마다 표기가 다르고, 색 리터럴을 시험에 쓰지 않는다). */
const colorOf = async (page: Page, selector: string): Promise<number[]> => {
  const computed = await page.evaluate((s) => getComputedStyle(document.querySelector(s) as Element).color, selector);
  return (computed.match(/\d+(?:\.\d+)?/g) ?? []).slice(0, 3).map(Number);
};

const VIEWPORT = { width: 1000, height: 700 };

interface Context {
  engine: EngineName;
  css: string;
  open: (scene: Scene, options?: { contrast?: "more" }) => Promise<Page>;
  close: () => Promise<void>;
}

async function launch(engine: EngineName, css: string): Promise<Context> {
  const playwright = await import("playwright");
  const browser = await playwright[engine].launch();
  const contexts: Array<{ close: () => Promise<void> }> = [];
  return {
    engine,
    css,
    async open(scene, options = {}) {
      const context = await browser.newContext({
        viewport: VIEWPORT,
        colorScheme: scene.mode,
        reducedMotion: "reduce",
        ...(options.contrast ? { contrast: options.contrast } : {}),
      });
      contexts.push(context);
      const page = await context.newPage();
      await page.setContent(html(css, scene));
      return page;
    },
    async close() {
      for (const context of contexts) await context.close();
      await browser.close();
    },
  };
}

const ALPHA = (percent: number): number => percent / 100;
const OPAQUE = 254;

/** 사이드바 열·타이틀바 줄·판 위 가장자리 띠. 아래·오른쪽 가장자리는 판의 그림자가 덮어서 뺀다. */
const GLASS_SPOTS = [
  ["사이드바", 100, 300],
  ["타이틀바", 100, 10],
  ["위 가장자리", 600, 3],
] as const;

describe.skipIf(ENGINES.length === 0)("유리 CSS의 실제 렌더 (AP-3 #4190)", () => {
  for (const engine of ENGINES) {
    describe(`엔진 ${engine}`, () => {
      it("사이드바·타이틀바·가장자리는 α로 뒤 색 위에 비치고(알파 = α), 본문 판은 불투명이다 (AC 3)", async () => {
        const ctx = await launch(engine, await buildCss());
        try {
          for (const mode of ["light", "dark"] as const) {
            const flat = THEMES.dawnsky[mode].canvas[1];
            const floor = Math.round(glassFloor(firstPartyGlassSources("dawnsky")[mode]!) * 100);
            const percent = Math.max(80, floor);
            const page = await ctx.open({ theme: "dawnsky", mode, glass: true, backdrop: "red", opacity: percent });
            for (const [label, x, y] of GLASS_SPOTS) {
              const got = await pixel(page, x, y);
              // 알파가 α다: 웹은 바닥색을 α로만 칠했고, 나머지 (1 - α)는 밑의 층이 채운다.
              expect(Math.abs(got[3] - Math.round(ALPHA(percent) * 255)), `${engine} ${mode} ${label} 알파 ${got[3]}`).toBeLessThanOrEqual(2);
              for (const backdrop of ["red", "blue"] as const) {
                const seen = composite(got, BACKDROPS[backdrop]);
                const want = channels(blend(flat, BACKDROPS[backdrop], ALPHA(percent)));
                expect(within(seen, want), `${engine} ${mode} ${backdrop} ${label}: ${seen} vs ${want}`).toBe(true);
              }
            }
            // 본문 판: 알파 1이라 뒤 색이 무엇이든 같은 면이고, 판 색 그대로다.
            const pane = await pixel(page, 600, 300);
            expect(pane[3], `${engine} ${mode} 판 알파`).toBeGreaterThanOrEqual(OPAQUE);
            // 라이트의 판은 `--surface`, 다크의 판은 `--canvas-mid`다(tokens.css `--pane`).
            const paneToken = mode === "light" ? THEMES.dawnsky.light.color.surface : THEMES.dawnsky.dark.canvas[1];
            expect(within(pane, channels(paneToken)), `${engine} ${mode} 판 색 ${pane} vs ${paneToken}`).toBe(true);
          }
        } finally {
          await ctx.close();
        }
      }, 90_000);

      it("data-glass가 없으면 알파 1이다: 같은 문서가 불투명으로 그려진다(알파 = α가 하네스의 우연이 아니다)", async () => {
        const ctx = await launch(engine, await buildCss());
        try {
          for (const mode of ["light", "dark"] as const) {
            const flat = channels(THEMES.dawnsky[mode].canvas[1]);
            const glassed = await ctx.open({ theme: "dawnsky", mode, glass: true, backdrop: "red", opacity: 80 });
            const plain = await ctx.open({ theme: "dawnsky", mode, glass: false, backdrop: "red" });
            const glassPixel = await pixel(glassed, 100, 300);
            const plainPixel = await pixel(plain, 100, 300);
            expect(plainPixel[3], `${engine} ${mode} 끔 알파`).toBeGreaterThanOrEqual(OPAQUE);
            expect(within(plainPixel, flat), `${engine} ${mode} 끔: ${plainPixel} vs ${flat}`).toBe(true);
            expect(glassPixel[3], `${engine} ${mode} 켬 알파`).toBeLessThan(OPAQUE);
          }
        } finally {
          await ctx.close();
        }
      }, 90_000);

      it("내 작업 탭(본문이 판 없이 바닥 위에 서는 자리)은 유리 아래에서도 알파 1이다", async () => {
        const ctx = await launch(engine, await buildCss());
        try {
          const page = await ctx.open({ theme: "dawnsky", mode: "light", glass: true, backdrop: "red", opacity: 80, shell: "work-rail" });
          const body = await pixel(page, 600, 300);
          expect(body[3]).toBeGreaterThanOrEqual(OPAQUE);
          const side = await pixel(page, 100, 300);
          expect(side[3], "사이드바는 여전히 유리다").toBeLessThan(OPAQUE);
        } finally {
          await ctx.close();
        }
      }, 90_000);

      it("내 작업 탭의 판은 다른 탭의 판과 같은 문법으로 서서 오른쪽·아래 가장자리에 유리가 남는다. 끄면·고대비면 원래 모양이다 (design-review M3)", async () => {
        const ctx = await launch(engine, await buildCss());
        try {
          const geometry = (page: Page) =>
            page.evaluate(() => {
              const main = document.querySelector("main") as HTMLElement;
              const box = main.getBoundingClientRect();
              const style = getComputedStyle(main);
              return {
                left: box.left,
                right: innerWidth - box.right,
                bottom: innerHeight - box.bottom,
                radius: style.borderTopLeftRadius,
                shadow: style.boxShadow !== "none",
                overflow: style.overflow,
              };
            });
          const scene = { theme: "dawnsky", mode: "light", glass: true, backdrop: "red", opacity: 80 } as const;
          const chat = await geometry(await ctx.open(scene));
          const rail = await geometry(await ctx.open({ ...scene, shell: "work-rail" }));
          // 다른 탭의 판: 오른쪽·아래 인셋 8, 반경 18, 그림자·테두리, 잘림. 내 작업은 같은 문법이다.
          expect(chat).toMatchObject({ right: 8, bottom: 8, radius: "18px", shadow: true, overflow: "clip" });
          expect(rail).toMatchObject({ right: chat.right, bottom: chat.bottom, radius: chat.radius, shadow: true, overflow: "clip" });
          // 접힘: 목록 열을 접으면 레일 옆 인셋도 다른 탭의 접힘과 같다.
          const collapsedChat = await geometry(await ctx.open({ ...scene, shell: "collapsed" }));
          const collapsedRail = await geometry(await ctx.open({ ...scene, shell: "work-rail-collapsed" }));
          expect(collapsedRail.left).toBe(collapsedChat.left);
          expect(collapsedRail.right).toBe(8);
          // 끄면 원래 모양이다(판 없이 창 끝까지).
          const off = await geometry(await ctx.open({ ...scene, glass: false, shell: "work-rail" }));
          expect(off).toMatchObject({ right: 0, bottom: 0, radius: "0px", shadow: false });
          // 대비 높이기: CSS가 불투명 바닥으로 돌아가며 이 탭도 원래 모양이다.
          const contrast = await geometry(await ctx.open({ ...scene, shell: "work-rail" }, { contrast: "more" }));
          expect(contrast).toMatchObject({ right: 0, bottom: 0, radius: "0px", shadow: false });
        } finally {
          await ctx.close();
        }
      }, 90_000);

      it("셸이 없는 화면(연결·온보딩)은 data-glass가 서 있어도 통째로 알파 1이다", async () => {
        const ctx = await launch(engine, await buildCss());
        try {
          const page = await ctx.open({ theme: "dawnsky", mode: "light", glass: true, backdrop: "red", opacity: 80, shell: "none" });
          for (const [x, y] of [[500, 350], [5, 5], [995, 695]] as const) {
            expect((await pixel(page, x, y))[3], `${engine} (${x},${y})`).toBeGreaterThanOrEqual(OPAQUE);
          }
        } finally {
          await ctx.close();
        }
      }, 90_000);

      it("대비 높이기(prefers-contrast: more)에서는 CSS가 불투명 바닥으로 돌아간다 (AC 5, 폴백 2)", async () => {
        const ctx = await launch(engine, await buildCss());
        try {
          const page = await ctx.open({ theme: "dawnsky", mode: "light", glass: true, backdrop: "red", opacity: 80 }, { contrast: "more" });
          // 축이 흉내 내어지지 않으면 이 칸의 초록은 아무것도 재지 않은 것이다.
          expect(await page.evaluate(() => matchMedia("(prefers-contrast: more)").matches), `${engine} 대비 질의`).toBe(true);
          const flat = channels(THEMES.dawnsky.light.canvas[1]);
          for (const [label, x, y] of GLASS_SPOTS) {
            const got = await pixel(page, x, y);
            expect(got[3], `${engine} ${label} 알파`).toBeGreaterThanOrEqual(OPAQUE);
            expect(within(got, flat, 8), `${engine} ${label}: ${got} vs ${flat}`).toBe(true);
          }
        } finally {
          await ctx.close();
        }
      }, 90_000);

      it("사이드바 글자·아이콘 색은 core가 보정한 값으로 묶인다. 유리를 걷으면 원래 값이다 (AC 6)", async () => {
        const ctx = await launch(engine, await buildCss());
        try {
          for (const mode of ["light", "dark"] as const) {
            const source = firstPartyGlassSources("dawnsky")[mode]!;
            const percent = Math.round(glassFloor(source) * 100);
            const fitted = glassChrome(source, mode, percent);
            const on = await ctx.open({ theme: "dawnsky", mode, glass: true, backdrop: "red", opacity: percent });
            expect(await colorOf(on, "#side-label"), `${engine} ${mode} 사이드바 보조 글자`).toEqual(channels(fitted.band["ink-muted"]));
            expect(await colorOf(on, "#titlebar-label"), `${engine} ${mode} 타이틀바 보조 글자`).toEqual(channels(fitted.band["ink-muted"]));
            const off = await ctx.open({ theme: "dawnsky", mode, glass: false, backdrop: "red" });
            expect(await colorOf(off, "#side-label"), `${engine} ${mode} 끔`).toEqual(channels(THEMES.dawnsky[mode].color["ink-muted"]));
            // 하한에서는 보정이 실제로 색을 옮긴다(안 옮겼으면 이 단정은 아무것도 재지 않는다).
            expect(fitted.band["ink-muted"]).not.toBe(THEMES.dawnsky[mode].color["ink-muted"].toLowerCase());
          }
        } finally {
          await ctx.close();
        }
      }, 90_000);

      it("노을띠: 띠 위(사이드바·펼친 타이틀바·설정 목록)는 띠 위 값, 접힌 타이틀바는 바닥 위 값이다", async () => {
        const ctx = await launch(engine, await buildCss());
        try {
          const mode: Mode = "light";
          const source = firstPartyGlassSources("noeul")[mode]!;
          const percent = Math.round(glassFloor(source) * 100) + 5;
          const fitted = glassChrome(source, mode, percent);
          expect(fitted.band["ink-muted"]).not.toBe(fitted.canvas["ink-muted"]);
          const open = await ctx.open({ theme: "noeul", mode, glass: true, backdrop: "red", opacity: percent });
          expect(await colorOf(open, "#side-label")).toEqual(channels(fitted.band["ink-muted"]));
          expect(await colorOf(open, "#titlebar-label")).toEqual(channels(fitted.band["ink-muted"]));
          const collapsed = await ctx.open({ theme: "noeul", mode, glass: true, backdrop: "red", opacity: percent, shell: "collapsed" });
          expect(await colorOf(collapsed, "#titlebar-label")).toEqual(channels(fitted.canvas["ink-muted"]));
          const settings = await ctx.open({ theme: "noeul", mode, glass: true, backdrop: "red", opacity: percent, shell: "settings" });
          expect(await colorOf(settings, "#nav-label")).toEqual(channels(fitted.band["ink-muted"]));
        } finally {
          await ctx.close();
        }
      }, 90_000);

      it("다크 스킴은 다크의 하한과 다크의 색조를 쓴다(라이트 값을 쓰지 않는다)", async () => {
        const ctx = await launch(engine, await buildCss());
        try {
          const source = firstPartyGlassSources("dawnsky");
          const floorLight = Math.round(glassFloor(source.light!) * 100);
          const floorDark = Math.round(glassFloor(source.dark!) * 100);
          expect(floorDark).toBeGreaterThan(floorLight);
          // 저장 74는 라이트에서 74, 다크에서 78로 올라 그려진다.
          const dark = await ctx.open({ theme: "dawnsky", mode: "dark", glass: true, backdrop: "red", opacity: 74 });
          const light = await ctx.open({ theme: "dawnsky", mode: "light", glass: true, backdrop: "red", opacity: 74 });
          const tint = (page: Page) =>
            page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--glass-tint").trim());
          expect(await tint(dark)).toBe(`${floorDark}%`);
          expect(await tint(light)).toBe("74%");
          // 그리고 그 값이 실제 알파다.
          expect(Math.abs((await pixel(dark, 100, 300))[3] - Math.round(ALPHA(floorDark) * 255))).toBeLessThanOrEqual(2);
          expect(Math.abs((await pixel(light, 100, 300))[3] - Math.round(ALPHA(74) * 255))).toBeLessThanOrEqual(2);
        } finally {
          await ctx.close();
        }
      }, 90_000);
    });
  }
});
