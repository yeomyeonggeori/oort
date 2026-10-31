import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "tailwindcss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InlineBanner } from "@/features/common/States";
import { OortLoader } from "./OortLoader";
import { browserLaunchBlocked } from "@/testing/agentSandbox";

/**
 * 오르트 로더 (#3961): 움직임 자체를 잰다.
 *
 * 앞 절반(브라우저 없이, CI 에서도 돈다)은 tokens.css 를 읽는다: 키프레임이 합성
 * 속성만 건드리는지, 비율이 마크 정본 GEOMETRY 와 맞는지.
 * 뒤 절반(Playwright Chromium, 없으면 시끄럽게 skip)은 실제로 그려서 잰다: 위성이
 * 정말 홈에서 나와 한 바퀴 돌고 꽂히는지, 큰 자리가 멈춤 없는 등속인지, 동작 줄이기·
 * still 에서 정말 움직임이 없는지, 링이 위성 위에 그려지는지. jsdom 은 이 중 아무것도
 * 못 잰다. 퍼센트 translate 는 자기 상자 기준이라 방사 층이 0×0 이면 위성이 한 칸도
 * 못 움직이는데, 그것은 레이아웃이 있어야 보인다.
 *
 * red proof (이 파일이 지키는 것):
 *   - 키프레임에 `width: 1px` 한 줄 → 「합성 속성만」 두 단정(소스·런타임)이 붉다
 *   - `.oort-loader-radial` 을 inset: 0 대신 0×0 으로 → 위성이 홈에서 안 나온다(기하 단정)
 *   - 큰 자리 궤도에 멈춤 있는 `oort-loader-orbit` 사용 → 등속 단정이 붉다
 *   - 궤도 층을 링 뒤(DOM)로 → 「링이 위성 위」 단정이 붉다
 *   - reduced 에서 orbit 애니메이션을 남김 → 「움직임 없음」 단정이 붉다
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DESIGN = `${HERE}/..`;
const require_ = createRequire(import.meta.url);
const TOKENS_CSS = readFileSync(`${DESIGN}/tokens.css`, "utf8");

/** 마크 정본 기하를 소스에서 읽는다(`brandMark.test.ts` 와 같은 방식: 이 파일의 path 가 정본이다). */
const MARK_SOURCE = readFileSync(
  fileURLToPath(new URL("./OortMark.tsx", import.meta.url)),
  "utf8"
);
function markGeometry(optical: "small" | "display") {
  const block = MARK_SOURCE.match(new RegExp(`${optical}: \\{([\\s\\S]*?)\\n  \\}`))![1]!;
  return {
    viewBox: block.match(/viewBox: "([^"]+)"/)![1]!,
    ring: block.match(/ring: "([^"]+)"/)![1]!,
    satellite: block.match(/satellite: "([^"]+)"/)![1]!,
  };
}
const GEOMETRY = { small: markGeometry("small"), display: markGeometry("display") };

// ---------------------------------------------------------------------------
// 소스 읽기 (브라우저 없이)
// ---------------------------------------------------------------------------

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** `@keyframes name { ... }` 의 안쪽. 중괄호 짝을 센다. */
function keyframesBody(css: string, name: string): string {
  const start = css.search(new RegExp(`@keyframes\\s+${name}\\s*\\{`));
  if (start < 0) throw new Error(`@keyframes ${name} 이 없다`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`@keyframes ${name} 블록이 닫히지 않는다`);
}

const LOADER_KEYFRAMES = [
  "oort-loader-orbit",
  "oort-loader-orbit-hero",
  "oort-loader-radial",
  "oort-loader-ring",
  "oort-loader-breathe",
  "oort-loader-appear",
] as const;

/** 선언 이름만 모은다(퍼센트 선택자는 선언이 아니다). */
function declaredProperties(body: string): string[] {
  return [...body.matchAll(/([a-z-]+)\s*:\s*[^;{}]+;/g)].map((m) => m[1]!);
}

const COMPOSITOR_ONLY = new Set(["transform", "opacity", "animation-timing-function"]);

/** 변수 한 줄의 값. 로더 블록은 `.oort-loader {` 와 `.oort-loader-hero {` 두 자리에서 정한다. */
function cssVar(css: string, scope: string, name: string): string {
  const rule = codeOnly(css).match(new RegExp(`\\n${scope}\\s*\\{([^}]*)\\}`));
  if (!rule) throw new Error(`${scope} 규칙이 없다`);
  const found = rule[1]!.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!found) throw new Error(`${scope} 에 ${name} 이 없다`);
  return found[1]!.trim();
}

const pct = (value: string) => {
  expect(value).toMatch(/^[\d.]+%$/);
  return Number.parseFloat(value);
};

/** 경로의 `M x y A r ...` 시작점 목록. 구멍·위성은 (cx + r, cy)에서 시작하는 원이다. */
function arcStarts(path: string) {
  return [...path.matchAll(/M(-?[\d.]+) (-?[\d.]+)A([\d.]+) /g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
    r: Number(m[3]),
  }));
}

describe("로더 CSS 소스 (브라우저 없이)", () => {
  it("키프레임 여섯이 모두 있고, 선언은 transform·opacity(와 타이밍 함수)뿐이다", () => {
    const css = codeOnly(TOKENS_CSS);
    for (const name of LOADER_KEYFRAMES) {
      const props = declaredProperties(keyframesBody(css, name));
      expect(props.length, `${name} 에 선언이 없다`).toBeGreaterThan(0);
      for (const prop of props) {
        expect(COMPOSITOR_ONLY.has(prop), `${name}: ${prop} 는 합성 속성이 아니다`).toBe(true);
      }
    }
  });

  it("주기는 owner 가 정한 1.8초 한 값이다", () => {
    expect(cssVar(TOKENS_CSS, "\\.oort-loader", "--oort-loader-period")).toBe("1.8s");
  });

  it("마크 small 의 비율이 정본 GEOMETRY 에서 나온다: 위성 거리 33%·지름 20%·각도 -45도", () => {
    // 30 격자 무대 안의 24 격자 마크: 링 구멍 중심 (11, 13), 위성 중심 (18, 6) 반지름 3.
    const hole = arcStarts(GEOMETRY.small.ring).at(-1)!;
    const ringCenter = { x: hole.x - hole.r, y: hole.y };
    const sat = arcStarts(GEOMETRY.small.satellite)[0]!;
    const satCenter = { x: sat.x - sat.r, y: sat.y };
    const stage = 30;
    const dx = satCenter.x - ringCenter.x;
    const dy = satCenter.y - ringCenter.y;

    const home = pct(cssVar(TOKENS_CSS, "\\.oort-loader", "--oort-loader-home"));
    const dot = pct(cssVar(TOKENS_CSS, "\\.oort-loader", "--oort-loader-dot"));
    expect(home).toBeCloseTo((Math.hypot(dx, dy) / stage) * 100, 0);
    expect(dot).toBeCloseTo(((sat.r * 2) / stage) * 100, 5);
    // 위성이 놓인 각도: 홈이 링의 오른쪽 위(-45도)라서 팔이 -45도로 선다.
    expect((Math.atan2(dy, dx) * 180) / Math.PI).toBeCloseTo(-45, 5);
    expect(codeOnly(TOKENS_CSS)).toMatch(/\.oort-loader-arm\s*\{\s*transform:\s*rotate\(-45deg\);/);
  });

  it("링 상자: 24 격자 마크가 30 격자 무대에 앉아 링 구멍 중심이 무대 정중앙에 온다", () => {
    const rule = /\.oort-loader-ring\s*\{([^}]*)\}/.exec(codeOnly(TOKENS_CSS))![1]!;
    const num = (prop: string) => Number.parseFloat(new RegExp(`${prop}:\\s*([\\d.]+)%`).exec(rule)![1]!);
    const left = num("inset-inline-start");
    const top = num("inset-block-start");
    const size = num("inline-size");
    expect(num("block-size")).toBe(size);
    expect(rule).toMatch(/transform-origin:\s*([\d.]+)% ([\d.]+)%/);

    const stage = 30;
    const grid = 24;
    const hole = arcStarts(GEOMETRY.small.ring).at(-1)!;
    const ringCenter = { x: hole.x - hole.r, y: hole.y }; // 24 격자 안의 (11, 13)
    // 상자: 무대 안에서 (4, 2)에서 시작해 한 변 24.
    expect((left / 100) * stage).toBeCloseTo(4, 3);
    expect((top / 100) * stage).toBeCloseTo(2, 3);
    expect((size / 100) * stage).toBeCloseTo(grid, 3);
    // 링 구멍 중심의 무대 좌표 = 무대 정중앙.
    const inStage = {
      x: (left / 100) * stage + (ringCenter.x / grid) * ((size / 100) * stage),
      y: (top / 100) * stage + (ringCenter.y / grid) * ((size / 100) * stage),
    };
    expect(inStage.x).toBeCloseTo(stage / 2, 3);
    expect(inStage.y).toBeCloseTo(stage / 2, 3);
    // 링이 숨 쉬는 중심(transform-origin)도 그 구멍이다.
    const origin = /transform-origin:\s*([\d.]+)% ([\d.]+)%/.exec(rule)!;
    expect(Number(origin[1])).toBeCloseTo((ringCenter.x / grid) * 100, 3);
    expect(Number(origin[2])).toBeCloseTo((ringCenter.y / grid) * 100, 3);
  });

  it("궤도는 링 바깥을 돈다: 위성 안쪽 가장자리가 링 바깥 반지름보다 멀다", () => {
    // 시안 C 에서 안쪽 궤도(out*0.9)가 링을 관통한 결함이 있었다. 같은 종류를 막는다.
    const stage = 30;
    const out = pct(cssVar(TOKENS_CSS, "\\.oort-loader", "--oort-loader-out"));
    const dot = pct(cssVar(TOKENS_CSS, "\\.oort-loader", "--oort-loader-dot"));
    const ringOuter = arcStarts(GEOMETRY.small.ring)[0]!.r; // 링 바깥 호의 반지름
    const innerEdge = ((out - dot / 2) / 100) * stage;
    expect(innerEdge).toBeGreaterThan(ringOuter);
  });

  it("큰 자리의 비율: 배지 62·궤도 44·위성 7 (한 변 128), 궤도는 배지 바깥이다", () => {
    const side = 128;
    const home = pct(cssVar(TOKENS_CSS, "\\.oort-loader-hero", "--oort-loader-home"));
    const out = pct(cssVar(TOKENS_CSS, "\\.oort-loader-hero", "--oort-loader-out"));
    const dot = pct(cssVar(TOKENS_CSS, "\\.oort-loader-hero", "--oort-loader-dot"));
    expect(home).toBe(out); // 홈이 없다
    expect((out / 100) * side).toBeCloseTo(44, 5);
    expect(((dot / 100) * side) / 2).toBeCloseTo(7, 5);
    const badge = /\.oort-loader-badge\s*\{[^}]*inline-size:\s*([\d.]+)%/.exec(codeOnly(TOKENS_CSS))![1]!;
    expect((Number(badge) / 100) * side).toBeCloseTo(62, 5);
    const badgeRadius = (Number(badge) / 100) * (side / 2);
    expect(((out - dot / 2) / 100) * side).toBeGreaterThan(badgeRadius);
    expect(TOKENS_CSS).toMatch(/--spacing-loader-hero:\s*128px;/);
  });

  it("지연은 사다리 토큰이다(ms 손기입 없음): 깜빡임 방지는 CSS 지연 하나", () => {
    const rule = /\.oort-loader-hero,\s*\.oort-loader-caption\s*\{([^}]*)\}/.exec(codeOnly(TOKENS_CSS))![1]!;
    expect(rule).toMatch(/animation:\s*oort-loader-appear\s+var\(--motion-fast\)\s+var\(--motion-ease-standard\)\s+var\(--motion-standard\)\s+backwards/);
    expect(codeOnly(TOKENS_CSS).slice(codeOnly(TOKENS_CSS).indexOf("오르트 로더"))).not.toMatch(/\d+ms/);
  });
});

// ---------------------------------------------------------------------------
// 실제로 그려서 잰다 (Chromium)
// ---------------------------------------------------------------------------

function detectChromium(): { ok: true } | { ok: false; path: string } {
  const blocked = browserLaunchBlocked();
  if (blocked !== null) return { ok: false, path: blocked };
  try {
    const { chromium } = require_("playwright") as typeof import("playwright");
    const exe = chromium.executablePath();
    if (!existsSync(exe)) return { ok: false, path: exe };
    return { ok: true };
  } catch (err) {
    return { ok: false, path: err instanceof Error ? err.message : String(err) };
  }
}

const chromium_ = detectChromium();
if (!chromium_.ok) {
  console.warn(
    `OortLoader runtime proofs skipped: Playwright Chromium executable missing (${chromium_.path}). Source assertions still run.`
  );
}

async function loadStylesheet(id: string, base: string) {
  if (id === "tailwindcss" || id.endsWith("tailwindcss/index.css")) {
    const path = require_.resolve("tailwindcss/index.css");
    return { path, base: dirname(path), content: readFileSync(path, "utf8") };
  }
  const path = id.startsWith(".") || id.startsWith("/") ? `${base}/${id}` : id;
  return { path, base: dirname(path), content: readFileSync(path, "utf8") };
}

const cssByCandidates = new Map<string, Promise<string>>();
// 한 줄에 `class=` 와 `[숫자` 를 같이 두지 않는다: 사전 점검의 arbitrary_tw 가 시험 파일도 훑어서
// 배열 첨자(`m[1]`)를 임의값 클래스로 읽는다. 구조 분해로 쓰면 첨자가 없다.
const CLASS_ATTR = /class="([^"]*)"/g;
/** 마크업이 쓰는 클래스를 후보로 컴파일한다(기본 후보 + 마크업 안의 class). */
function builtCss(markup = ""): Promise<string> {
  const used = [...markup.matchAll(CLASS_ATTR)].flatMap(([, value]) => (value ?? "").split(/\s+/)).filter(Boolean);
  const candidates = [...new Set(["size-6", "size-loader-hero", "block", "grid", "gap-6", "p-6", ...used])];
  const key = candidates.join(" ");
  let hit = cssByCandidates.get(key);
  if (!hit) {
    hit = (async () => {
      const compiler = await compile(TOKENS_CSS, { base: DESIGN, loadStylesheet });
      return compiler.build(candidates);
    })();
    cssByCandidates.set(key, hit);
  }
  return hit;
}

let sharedBrowser: Promise<import("playwright").Browser> | null = null;
function getBrowser(): Promise<import("playwright").Browser> {
  sharedBrowser ??= import("playwright").then(({ chromium }) => chromium.launch());
  return sharedBrowser;
}
beforeAll(async () => {
  if (!chromium_.ok) return;
  await getBrowser();
}, 120_000);
afterAll(async () => {
  if (!sharedBrowser) return;
  const browser = await sharedBrowser;
  sharedBrowser = null;
  await browser.close();
}, 60_000);

type Pt = { dx: number; dy: number; w: number };

/** 한 페이지에 로더를 그리고, 모든 애니메이션을 ms 로 세워 위성 중심을 잰다. */
async function open(
  markup: string,
  opts: { reducedMotion?: "reduce" | "no-preference"; motion?: "reduced" } = {}
) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 480, height: 480 },
    deviceScaleFactor: 2,
    reducedMotion: opts.reducedMotion ?? "no-preference",
  });
  const page = await context.newPage();
  const css = await builtCss(markup);
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>` +
      `<body><div class="p-6">${markup}</div></body></html>`
  );
  await page.addStyleTag({ content: "body{margin:0}" });
  if (opts.motion) {
    await page.evaluate((m) => {
      document.querySelectorAll("[data-oort-loader]").forEach((el) => el.setAttribute("data-motion", m));
    }, opts.motion);
  }
  await page.evaluate(() => {
    type W = typeof window & { __sample: (sel: string, ms: number | null) => unknown };
    (window as W).__sample = (sel, ms) => {
      if (ms !== null) {
        document.getAnimations().forEach((a) => {
          a.pause();
          a.currentTime = ms;
        });
      }
      const root = document.querySelector(sel)!;
      const stage = root.getBoundingClientRect();
      const cx = stage.x + stage.width / 2;
      const cy = stage.y + stage.height / 2;
      const center = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { dx: r.x + r.width / 2 - cx, dy: r.y + r.height / 2 - cy, w: r.width };
      };
      const headDot = root.querySelector(
        ".oort-loader-arm:not(.oort-loader-trail-near):not(.oort-loader-trail-far) .oort-loader-dot"
      )!;
      // 지름은 회전한 상자의 외접 사각형(bbox)이 아니라 레이아웃 크기로 잰다.
      const span = (el: Element) => Number.parseFloat(getComputedStyle(el).width);
      const dots = [...root.querySelectorAll(".oort-loader-dot")].map((el) => ({ ...center(el), w: span(el) }));
      return { stage: { w: stage.width, h: stage.height }, head: { ...center(headDot), w: span(headDot) }, dots };
    };
  });
  return {
    page,
    close: () => context.close(),
    at: async (sel: string, ms: number | null) =>
      (await page.evaluate(([s, t]) => (window as never as { __sample: (a: string, b: number | null) => unknown }).__sample(s as string, t as number | null), [sel, ms] as const)) as {
        stage: { w: number; h: number };
        head: Pt;
        dots: Pt[];
      },
  };
}

const MARK = renderToStaticMarkup(<OortLoader />);
const HERO = renderToStaticMarkup(<OortLoader variant="hero" />);
const STILL = renderToStaticMarkup(<OortLoader still />);
const HERO_STILL = renderToStaticMarkup(<OortLoader variant="hero" still />);

const dist = (p: Pt) => Math.hypot(p.dx, p.dy);
/** 시계 방향이 양수인 각도(도). 화면 좌표(y 아래)라서 atan2 그대로 시계 방향이다. */
const angle = (p: Pt) => (Math.atan2(p.dy, p.dx) * 180) / Math.PI;
const unwrap = (angles: number[]) => {
  const out: number[] = [];
  let offset = 0;
  angles.forEach((a, i) => {
    if (i > 0) {
      const prev = angles[i - 1]! + offset;
      while (a + offset - prev < -180) offset += 360;
      while (a + offset - prev > 180) offset -= 360;
    }
    out.push(a + offset);
  });
  return out;
};

const T = 1800;
const MARK_SIDE = 24;
const HERO_SIDE = 128;
const maybe = chromium_.ok ? describe : describe.skip;

maybe("마크 로더, 움직임 (Chromium)", () => {
  it("t=0: 위성은 홈에 있다. 링 중심에서 33%(7.92px), 오른쪽 위 -45도", async () => {
    const h = await open(MARK);
    try {
      const s = await h.at("[data-oort-loader]", 0);
      expect(s.stage.w).toBe(MARK_SIDE);
      expect(dist(s.head)).toBeCloseTo(0.33 * MARK_SIDE, 0);
      expect(angle(s.head)).toBeCloseTo(-45, 0);
      expect(s.head.w).toBeCloseTo(0.2 * MARK_SIDE, 1);
    } finally {
      await h.close();
    }
  });

  it("한가운데에서는 궤도로 나가 있다: 40.7%(9.76px)", async () => {
    const h = await open(MARK);
    try {
      const s = await h.at("[data-oort-loader]", T / 2);
      expect(dist(s.head)).toBeCloseTo(0.40667 * MARK_SIDE, 0);
    } finally {
      await h.close();
    }
  });

  it("나온 뒤 시계 방향으로 한 바퀴 돈다: 각도가 늘기만 하고 -45도에서 315도(-45+360)로 간다", async () => {
    const h = await open(MARK);
    try {
      const raw: number[] = [];
      const times: number[] = [];
      for (let t = 0.14 * T; t <= 0.86 * T + 1; t += 0.04 * T) times.push(t);
      for (const t of times) raw.push(angle((await h.at("[data-oort-loader]", t)).head));
      const turn = unwrap(raw);
      for (let i = 1; i < turn.length; i += 1) expect(turn[i]!).toBeGreaterThan(turn[i - 1]!);
      expect(turn[0]!).toBeCloseTo(-45, 0);
      expect(turn.at(-1)! - turn[0]!).toBeCloseTo(360, 0);
    } finally {
      await h.close();
    }
  });

  it("꽂기: 홈보다 3% 안쪽까지 들어갔다가 홈으로 돌아오고, 그 순간 링이 1.05배로 숨 쉰다", async () => {
    const h = await open(MARK);
    try {
      const dip = await h.at("[data-oort-loader]", 0.94 * T);
      expect(dist(dip.head)).toBeCloseTo((0.33 - 0.03) * MARK_SIDE, 0);
      const ringScale = await h.page.evaluate(() => {
        const ring = document.querySelector(".oort-loader-ring")!;
        return new DOMMatrixReadOnly(getComputedStyle(ring).transform).a;
      });
      // 0.94T 는 링 숨(0.95T 에서 1.05)의 오르막 한가운데다.
      expect(ringScale).toBeGreaterThan(1);
      const peak = await h.page.evaluate((ms) => {
        document.getAnimations().forEach((a) => {
          a.pause();
          a.currentTime = ms;
        });
        const ring = document.querySelector(".oort-loader-ring")!;
        return new DOMMatrixReadOnly(getComputedStyle(ring).transform).a;
      }, 0.95 * T);
      expect(peak).toBeCloseTo(1.05, 2);
      const home = await h.at("[data-oort-loader]", T - 1);
      expect(dist(home.head)).toBeCloseTo(0.33 * MARK_SIDE, 0);
    } finally {
      await h.close();
    }
  });

  it("링이 위성 위에 그려진다: 위성이 말풍선 꼬리 뒤로 지나간다", async () => {
    const h = await open(MARK);
    try {
      const order = await h.page.evaluate(() => {
        const root = document.querySelector("[data-oort-loader]")!;
        const ring = root.querySelector(".oort-loader-ring")!;
        const dot = root.querySelector(".oort-loader-dot")!;
        const r = dot.getBoundingClientRect();
        const stack = document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { ring: stack.indexOf(ring), dot: stack.indexOf(dot) };
      });
      expect(order.dot).toBeGreaterThanOrEqual(0);
      // elementsFromPoint 는 위에 그려진 것부터다.
      expect(order.ring).toBeGreaterThanOrEqual(0);
      expect(order.ring).toBeLessThan(order.dot);
    } finally {
      await h.close();
    }
  });

  it("움직이는 속성은 transform·opacity 뿐이다 (런타임 키프레임)", async () => {
    const h = await open(MARK + HERO);
    try {
      const props = await h.page.evaluate(() => {
        const names = new Set<string>();
        for (const a of document.getAnimations()) {
          for (const frame of (a.effect as KeyframeEffect).getKeyframes()) {
            Object.keys(frame).forEach((k) => names.add(k));
          }
        }
        return [...names];
      });
      const allowed = new Set(["offset", "easing", "composite", "computedOffset", "transform", "opacity"]);
      expect(props.filter((p) => !allowed.has(p))).toEqual([]);
      expect(props).toEqual(expect.arrayContaining(["transform", "opacity"]));
    } finally {
      await h.close();
    }
  });

  it("무대는 움직이는 동안 커지거나 밀리지 않는다(레이아웃 0)", async () => {
    const h = await open(MARK);
    try {
      const rects = new Set<string>();
      for (const t of [0, 0.3 * T, 0.5 * T, 0.7 * T, 0.95 * T]) {
        const r = await h.page.evaluate((ms) => {
          document.getAnimations().forEach((a) => {
            a.pause();
            a.currentTime = ms;
          });
          const b = document.querySelector("[data-oort-loader]")!.getBoundingClientRect();
          return `${b.x},${b.y},${b.width},${b.height}`;
        }, t);
        rects.add(r);
      }
      expect([...rects]).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
});

maybe("큰 자리(hero), 움직임 (Chromium)", () => {
  it("배지는 한 변의 62/128 이고 가운데에 선다", async () => {
    const h = await open(HERO);
    try {
      const geo = await h.page.evaluate(() => {
        const root = document.querySelector("[data-oort-loader]")!.getBoundingClientRect();
        const b = document.querySelector(".oort-loader-badge")!.getBoundingClientRect();
        return {
          side: root.width,
          badge: b.width,
          offX: b.x + b.width / 2 - (root.x + root.width / 2),
          offY: b.y + b.height / 2 - (root.y + root.height / 2),
        };
      });
      expect(geo.side).toBe(HERO_SIDE);
      expect(geo.badge).toBeCloseTo(62, 0);
      expect(Math.abs(geo.offX)).toBeLessThan(0.6);
      expect(Math.abs(geo.offY)).toBeLessThan(0.6);
    } finally {
      await h.close();
    }
  });

  it("등속이다: 사분주기마다 정확히 90도씩 돈다(멈춤 구간 0), 거리는 늘 44px", async () => {
    const h = await open(HERO);
    try {
      const raw: number[] = [];
      for (const f of [0, 0.25, 0.5, 0.75, 1.0]) {
        const s = await h.at("[data-oort-loader]", f * T + (f === 1.0 ? -1 : 0));
        raw.push(angle(s.head));
        expect(dist(s.head)).toBeCloseTo(0.34375 * HERO_SIDE, 0);
      }
      const turn = unwrap(raw);
      for (let i = 1; i < turn.length; i += 1) {
        expect(turn[i]! - turn[i - 1]!).toBeCloseTo(90, 0);
      }
    } finally {
      await h.close();
    }
  });

  it("처음 14% 와 끝 14% 에도 돈다(시안 v1 의 멈춘 구간이 없다)", async () => {
    const h = await open(HERO);
    try {
      const a = angle((await h.at("[data-oort-loader]", 0.0 * T)).head);
      const b = angle((await h.at("[data-oort-loader]", 0.07 * T)).head);
      const c = angle((await h.at("[data-oort-loader]", 0.93 * T)).head);
      const d = angle((await h.at("[data-oort-loader]", 0.99 * T)).head);
      expect(Math.abs(unwrap([a, b])[1]! - a)).toBeGreaterThan(20);
      expect(Math.abs(unwrap([c, d])[1]! - c)).toBeGreaterThan(15);
    } finally {
      await h.close();
    }
  });

  it("꼬리 점 둘은 머리 뒤 15도·30도에 선다", async () => {
    const h = await open(HERO);
    try {
      const s = await h.at("[data-oort-loader]", 0);
      // DOM 순서: 먼 꼬리, 가까운 꼬리, 머리.
      expect(s.dots).toHaveLength(3);
      const [far, near, head] = s.dots as [Pt, Pt, Pt];
      expect(Math.round(angle(head) - angle(near))).toBe(15);
      expect(Math.round(angle(head) - angle(far))).toBe(30);
      // 셋 다 같은 궤도 위에 있고, 뒤로 갈수록 작다.
      expect(dist(near)).toBeCloseTo(dist(head), 0);
      expect(dist(far)).toBeCloseTo(dist(head), 0);
      expect(far.w).toBeLessThan(near.w);
      expect(near.w).toBeLessThan(head.w);
    } finally {
      await h.close();
    }
  });
});

maybe("동작 줄이기·still (Chromium)", () => {
  const animationsOf = (h: Awaited<ReturnType<typeof open>>) =>
    h.page.evaluate(() => {
      const out: Record<string, string[]> = {};
      for (const cls of ["body", "orbit", "arm", "radial", "ring", "badge"]) {
        const names: string[] = [];
        document.querySelectorAll(`.oort-loader-${cls}`).forEach((el) => {
          el.getAnimations().forEach((a) => names.push((a as CSSAnimation).animationName));
        });
        out[cls] = names;
      }
      return out;
    });

  it("reduced(마크): 회전·이동·링 숨이 모두 꺼지고 본체가 투명도 1↔0.5 로만 숨 쉰다, 위성은 홈에 선다", async () => {
    const h = await open(MARK, { motion: "reduced" });
    try {
      const names = await animationsOf(h);
      expect(names).toEqual({ body: ["oort-loader-breathe"], orbit: [], arm: [], radial: [], ring: [], badge: [] });
      const quarter = await h.at("[data-oort-loader]", 0.25 * T);
      expect(dist(quarter.head)).toBeCloseTo(0.33 * MARK_SIDE, 0);
      expect(angle(quarter.head)).toBeCloseTo(-45, 0);
      const half = await h.page.evaluate((ms) => {
        document.getAnimations().forEach((a) => {
          a.pause();
          a.currentTime = ms;
        });
        return Number(getComputedStyle(document.querySelector(".oort-loader-body")!).opacity);
      }, 0.5 * T);
      expect(half).toBeCloseTo(0.5, 2);
      const full = await h.page.evaluate((ms) => {
        document.getAnimations().forEach((a) => {
          a.pause();
          a.currentTime = ms;
        });
        return Number(getComputedStyle(document.querySelector(".oort-loader-body")!).opacity);
      }, 0);
      expect(full).toBeCloseTo(1, 2);
    } finally {
      await h.close();
    }
  });

  it("reduced(hero): 코메토는 투명도도 건드리지 않고 위성 층만 숨 쉰다, 꼬리 점은 숨는다", async () => {
    const h = await open(HERO, { motion: "reduced" });
    try {
      const names = await animationsOf(h);
      expect(names.orbit).toEqual(["oort-loader-breathe"]);
      expect(names.body).toEqual([]);
      expect(names.badge).toEqual([]);
      const state = await h.page.evaluate((ms) => {
        document.getAnimations().forEach((a) => {
          a.pause();
          a.currentTime = ms;
        });
        const trail = [...document.querySelectorAll(".oort-loader-trail-near, .oort-loader-trail-far")];
        return {
          badge: Number(getComputedStyle(document.querySelector(".oort-loader-badge")!).opacity),
          orbit: Number(getComputedStyle(document.querySelector(".oort-loader-orbit")!).opacity),
          trailHidden: trail.every((el) => getComputedStyle(el).display === "none"),
        };
      }, 0.5 * T);
      expect(state.badge).toBe(1);
      expect(state.orbit).toBeCloseTo(0.5, 2);
      expect(state.trailHidden).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("still(마크): 움직임이 하나도 없다. 투명도도 1 그대로, 위성은 홈", async () => {
    const h = await open(STILL);
    try {
      expect(await animationsOf(h)).toEqual({ body: [], orbit: [], arm: [], radial: [], ring: [], badge: [] });
      const s = await h.at("[data-oort-loader]", 0.5 * T);
      expect(dist(s.head)).toBeCloseTo(0.33 * MARK_SIDE, 0);
      const op = await h.page.evaluate(() => Number(getComputedStyle(document.querySelector(".oort-loader-body")!).opacity));
      expect(op).toBe(1);
    } finally {
      await h.close();
    }
  });

  it("still(hero): 위성 층·본체·배지에 움직임이 없다", async () => {
    const h = await open(HERO_STILL);
    try {
      expect(await animationsOf(h)).toEqual({ body: [], orbit: [], arm: [], radial: [], ring: [], badge: [] });
    } finally {
      await h.close();
    }
  });
});

maybe("배너 안의 줄 정렬 (Chromium)", () => {
  const message = "실시간 연결을 아직 맺지 못했습니다. 새 메시지는 채널을 다시 열어야 도착합니다.";
  const banner = (icon: boolean, still = true) =>
    renderToStaticMarkup(
      <div className="w-pane-lg">
        <InlineBanner
          tone="neutral"
          message={message}
          messageId="banner-sentence"
          testId="banner"
          {...(icon ? { icon: <OortLoader inline still={still} /> } : {})}
        />
      </div>
    );

  it("로더가 문장 줄을 키우지 않는다: 단일 줄 배너 높이가 아이콘이 없을 때와 같다", async () => {
    const withIcon = await open(banner(true));
    const without = await open(banner(false));
    try {
      const height = (h: Awaited<ReturnType<typeof open>>) =>
        h.page.evaluate(() => document.querySelector<HTMLElement>("[data-testid=banner]")!.getBoundingClientRect().height);
      const [a, b] = [await height(withIcon), await height(without)];
      expect(a).toBe(b);
      expect(a).toBe(22 + 16 + 1); // text-body 줄 22 + py-2 위아래 16 + 아래 선 1
    } finally {
      await withIcon.close();
      await without.close();
    }
  });

  it("마크 중심이 첫 줄 중심에 정확히 온다(오차 0.5px 미만)", async () => {
    const h = await open(banner(true));
    try {
      const m = await h.page.evaluate(() => {
        const root = document.querySelector<HTMLElement>("[data-testid=banner]")!;
        const loaderEl = root.querySelector("[data-oort-loader]")!;
        const loader = loaderEl.getBoundingClientRect();
        // 문장 자신을 id 로 집는다: 구조 선택자로 집으면 로더 안쪽 요소를 집어 자기 자신과 비교하게 된다.
        const text = document.getElementById("banner-sentence")!;
        const range = document.createRange();
        range.selectNodeContents(text);
        const first = range.getClientRects()[0]!;
        return {
          pickedInsideLoader: loaderEl.contains(text),
          pickedText: text.textContent,
          gap: Math.abs(loader.y + loader.height / 2 - (first.y + first.height / 2)),
        };
      });
      expect(m.pickedInsideLoader).toBe(false);
      expect(m.pickedText).toBe(message);
      expect(m.gap).toBeLessThan(0.5);
    } finally {
      await h.close();
    }
  });

  it("두 줄 이상으로 접혀도 로더는 첫 줄에 남는다(줄 맞춤이 위쪽)", async () => {
    const narrow = renderToStaticMarkup(
      <div className="w-pane-sm">
        <InlineBanner
          tone="neutral"
          message={message}
          messageId="banner-sentence"
          testId="banner"
          icon={<OortLoader inline still />}
        />
      </div>
    );
    const h = await open(narrow);
    try {
      const m = await h.page.evaluate(() => {
        const root = document.querySelector<HTMLElement>("[data-testid=banner]")!;
        const loaderEl = root.querySelector("[data-oort-loader]")!;
        const loader = loaderEl.getBoundingClientRect();
        const text = document.getElementById("banner-sentence")!;
        const range = document.createRange();
        range.selectNodeContents(text);
        const rects = [...range.getClientRects()];
        return {
          pickedInsideLoader: loaderEl.contains(text),
          lines: new Set(rects.map((r) => Math.round(r.y))).size,
          loaderCenter: loader.y + loader.height / 2,
          firstLineCenter: rects[0]!.y + rects[0]!.height / 2,
        };
      });
      expect(m.pickedInsideLoader).toBe(false);
      expect(m.lines).toBeGreaterThan(1);
      expect(Math.abs(m.loaderCenter - m.firstLineCenter)).toBeLessThan(0.5);
    } finally {
      await h.close();
    }
  });
});
