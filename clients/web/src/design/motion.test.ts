import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";
import {
  ENTER_CONVERSATION_ANIMATION_NAME,
  ENTER_CONVERSATION_CLASS,
  MODAL_CONTENT_MOTION,
  MODAL_OVERLAY_MOTION,
  POPOVER_MOTION,
  PRESS_CLASS,
} from "./motion";
import { buttonVariants } from "./ui/button";

/**
 * ADR-0179 D1·D2·D3(값)·D4·D5·D6·D9·D10 — 토큰·상수·눌림 단일점·강제 기제.
 *
 * red proof (이 파일이 지키는 것):
 *   - motion.css 에서 토큰 하나 삭제 → 아래 사다리/엘리베이션 단정이 붉다
 *   - tokens.css 에 사다리 밖 `\d+ms` 한 줄 → D10 단정이 붉다
 *   - button variant 에서 `press` 제거 → D5 단정이 붉다
 *   - reduced-motion 블록 제거 → D9 단정이 붉다
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const MOTION_CSS = readFileSync(new URL("./motion.css", import.meta.url), "utf8");
const TOKENS_CSS = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const BUTTON_TSX = readFileSync(new URL("./ui/button.tsx", import.meta.url), "utf8");

const LADDER = {
  instant: "120ms",
  fast: "180ms",
  standard: "240ms",
  arrival: "500ms",
} as const;

const BUTTON_VARIANTS = [
  "default",
  "secondary",
  "ghost",
  "destructive",
  "outline",
] as const;

/**
 * H-1 runtime probe needs a Playwright Chromium binary. Local gates and the
 * design-review lane have it; GitHub Actions `vitest` does not run
 * `playwright install`, and `.github/**` is out of this ticket. Missing
 * package or missing executable → skip (never a silent green: warn + skipIf).
 */
function detectChromium(): { ok: true } | { ok: false; path: string } {
  try {
    const { chromium } = require_("playwright") as typeof import("playwright");
    const exe = chromium.executablePath();
    if (!existsSync(exe)) return { ok: false, path: exe };
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      path: err instanceof Error ? err.message : String(err),
    };
  }
}

const chromiumAvailability = detectChromium();
const chromiumAvailable = chromiumAvailability.ok;
if (!chromiumAvailable) {
  console.warn(
    `H-1 runtime probe skipped: Playwright Chromium executable missing (${chromiumAvailability.path})`
  );
}

/** 주석을 벗긴 소스. 주석은 옛 값과 반례를 그대로 인용한다. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");
}

/** ADR-0159 온보딩 예외 블록 (650/760·300ms). 마커가 없으면 면제하지 않는다. */
function stripOnboardingException(css: string): string {
  const start = css.indexOf("Onboarding S0 motion");
  if (start < 0) return css;
  const after = css.slice(start);
  const endRel = after.search(/\n@layer base/);
  if (endRel < 0) return css;
  return css.slice(0, start) + css.slice(start + endRel);
}

function msLiterals(source: string): string[] {
  return [...source.matchAll(/(\d+)ms/g)].map((match) => match[1] + "ms");
}

async function loadStylesheet(id: string, base: string) {
  if (id === "tailwindcss" || id.endsWith("tailwindcss/index.css")) {
    const path = require_.resolve("tailwindcss/index.css");
    return { path, base: dirname(path), content: readFileSync(path, "utf8") };
  }
  const path = id.startsWith(".") || id.startsWith("/") ? `${base}/${id}` : id;
  return { path, base: dirname(path), content: readFileSync(path, "utf8") };
}

async function buildCss(candidates: string[]): Promise<string> {
  const compiler = await compile(TOKENS_CSS, { base: HERE, loadStylesheet });
  return compiler.build(candidates);
}

function classTokens(className: string): string[] {
  return className.split(/\s+/).filter(Boolean);
}

/** Tailwind v4 가 셀렉터에 쓰는 이스케이프. compile-probe 와 같은 자. */
function escapedClassSelector(candidate: string): string {
  return "." + candidate.replace(/[:[\]=.]/g, (ch) => "\\" + ch);
}

function lastPressOrColorsTransition(css: string): {
  selector: string;
  body: string;
} {
  const rules = [
    ...css.matchAll(/(\.press|\.transition-colors)\s*\{([^}]*)\}/g),
  ].filter((match) => /transition-property:/.test(match[2]));
  if (rules.length === 0) {
    throw new Error(".press / .transition-colors 에 transition-property 가 없다");
  }
  const last = rules[rules.length - 1];
  return { selector: last[1], body: last[2] };
}

describe("ADR-0179 D1 duration 사다리", () => {
  it.each(Object.entries(LADDER))("--motion-%s 는 %s", (name, value) => {
    expect(MOTION_CSS).toMatch(new RegExp(`--motion-${name}:\\s*${value}`));
  });
});

describe("ADR-0179 D2 easing", () => {
  it("standard·arrival 두 곡선이 있다", () => {
    expect(MOTION_CSS).toMatch(
      /--motion-ease-standard:\s*cubic-bezier\(\s*0\.25\s*,\s*1\s*,\s*0\.5\s*,\s*1\s*\)/
    );
    expect(MOTION_CSS).toMatch(
      /--motion-ease-arrival:\s*cubic-bezier\(\s*0\.16\s*,\s*1\s*,\s*0\.3\s*,\s*1\s*\)/
    );
  });
});

describe("ADR-0179 D3 도착 값", () => {
  it("distance·blur 토큰이 있다 (키프레임 이관은 UX-R1)", () => {
    expect(MOTION_CSS).toMatch(/--motion-distance-arrival:\s*0\.75rem/);
    expect(MOTION_CSS).toMatch(/--motion-blur-arrival:\s*2px/);
  });

  it("키프레임 motion-enter-conversation 이 arrival 사다리로 blur·opacity·translateY 를 한 번에 쓴다", () => {
    expect(ENTER_CONVERSATION_ANIMATION_NAME).toBe("motion-enter-conversation");
    expect(ENTER_CONVERSATION_CLASS).toBe("enter-conversation");
    expect(MOTION_CSS).toMatch(/@keyframes\s+motion-enter-conversation/);
    const start = MOTION_CSS.indexOf("@keyframes motion-enter-conversation");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = MOTION_CSS.slice(start, start + 900);
    expect(block).toMatch(/blur\(\s*var\(--motion-blur-arrival\)\s*\)/);
    expect(block).toMatch(/opacity:\s*0/);
    expect(block).toMatch(/translateY\(\s*var\(--motion-distance-arrival\)\s*\)/);
  });

  it("enter-conversation 유틸이 키프레임을 arrival·arrival-ease 로 조립하고 규칙을 낸다", async () => {
    expect(MOTION_CSS).toMatch(
      /animation:\s*motion-enter-conversation\s+var\(--motion-arrival\)\s+var\(--motion-ease-arrival\)/
    );
    const css = await buildCss([ENTER_CONVERSATION_CLASS]);
    const selector = escapedClassSelector(ENTER_CONVERSATION_CLASS);
    expect(css.includes(selector), "enter-conversation 이 규칙을 내지 않는다").toBe(
      true
    );
    const from = css.indexOf(selector);
    const snippet = css.slice(from, from + 400);
    expect(snippet).toMatch(/motion-enter-conversation/);
    expect(snippet).toMatch(/var\(--motion-arrival\)/);
    expect(snippet).toMatch(/var\(--motion-ease-arrival\)/);
  });
});

describe("ADR-0179 D4 모달 상수", () => {
  it("열림 200·닫힘 150 은 motion.css 한 곳에 산다 (사다리 밖 예외 2호)", () => {
    expect(MOTION_CSS).toMatch(/--motion-modal-open:\s*200ms/);
    expect(MOTION_CSS).toMatch(/--motion-modal-close:\s*150ms/);
  });

  it.each([
    ["MODAL_OVERLAY_MOTION", MODAL_OVERLAY_MOTION],
    ["MODAL_CONTENT_MOTION", MODAL_CONTENT_MOTION],
    ["POPOVER_MOTION", POPOVER_MOTION],
  ] as const)("%s 의 모든 클래스가 규칙을 낸다", async (name, className) => {
    const tokens = classTokens(className);
    expect(tokens.length, name).toBeGreaterThan(0);
    expect(tokens, `${name} 은 ease-out/ease-in 을 들지 않는다`).not.toContain(
      "ease-out"
    );
    expect(tokens).not.toContain("ease-in");

    for (const token of tokens) {
      const css = await buildCss([token]);
      const selector = escapedClassSelector(token);
      expect(
        css.includes(selector),
        `${name}: ${token} 이 규칙을 내지 않는다 (no rule emitted)`
      ).toBe(true);
      const from = css.indexOf(selector);
      const snippet = css.slice(from, from + 280);
      expect(
        snippet,
        `${name}: ${token} 규칙에 Tailwind ease-out/in 금지`
      ).not.toMatch(/--ease-out\b|--ease-in\b/);
    }
  });
});

describe("ADR-0179 D5 눌림 단일점", () => {
  it("PRESS_CLASS 는 press 유틸이다", () => {
    expect(PRESS_CLASS).toBe("press");
  });

  it("button 의 모든 variant 가 press 를 든다", () => {
    const variantBlock = BUTTON_TSX.match(/variant:\s*\{([\s\S]*?)\n\s*\},/);
    expect(variantBlock, "buttonVariants.variant 블록").toBeTruthy();
    const declared = [
      ...variantBlock![1].matchAll(/^\s*([A-Za-z]+):/gm),
    ].map((match) => match[1]);
    expect(declared.sort()).toEqual([...BUTTON_VARIANTS].sort());

    for (const variant of BUTTON_VARIANTS) {
      expect(
        buttonVariants({ variant }),
        `${variant} variant 에 press`
      ).toContain("press");
    }
  });

  it("press 유틸은 :active 에서 scale(0.98) 을 instant 로 전이한다", async () => {
    const css = await buildCss(["press"]);
    expect(css).toMatch(/scale\(\s*0\.98\s*\)/);
    expect(css).toMatch(/--motion-instant/);
  });

  // (a) static H-1 proof — compile the real Button class list. Always runs.
  // (a) static H-1 proof — always runs (CI included). Compiles the real
  // buttonVariants base list through Tailwind; last transition-property
  // owner is .press, contains transform, excludes outline-color.
  it("Button 은 press 만 들고, 마지막 transition-property 에 transform 이 있고 outline-color 는 없다", async () => {
    const className = buttonVariants({ variant: "default" });
    expect(className).toContain("press");
    expect(className.split(/\s+/)).not.toContain("transition-colors");

    const css = await buildCss(classTokens(className));
    const last = lastPressOrColorsTransition(css);
    expect(last.selector, "캐스케이드 마지막 소유자는 press").toBe(".press");
    expect(last.body).toMatch(/transform/);
    expect(last.body).not.toMatch(/outline-color/);
  });

  it("press 와 transition-colors 가 함께여도 press 가 이긴다", async () => {
    const css = await buildCss(["transition-colors", "press"]);
    const last = lastPressOrColorsTransition(css);
    expect(last.selector).toBe(".press");
    expect(last.body).toMatch(/transform/);
    expect(last.body).not.toMatch(/outline-color/);
  });

  it("press 목록에 outline-color 가 들어가면 붉다 (M-1 / #1210 D3)", async () => {
    const css = await buildCss(["press"]);
    const pressRules = [...css.matchAll(/\.press\s*\{([^}]*)\}/g)].filter(
      (match) => /transition-property:/.test(match[1])
    );
    expect(pressRules.length).toBeGreaterThan(0);
    for (const rule of pressRules) {
      expect(rule[1]).not.toMatch(/outline-color/);
    }
  });

  // (b) runtime H-1 probe. Runs in local gates (developer machines and the
  // design-review lane have the browser). CI unit-test lane does not
  // `playwright install`; this skip is the recorded gap — DS-3 3짝 캡처가
  // 런타임 모션 측정을 인수한다.
  it.skipIf(!chromiumAvailable)(
    "mousedown 에서 transform 전이가 돈다 (H-1 runtime)",
    async () => {
      const className = buttonVariants({ variant: "secondary" });
      const css = await buildCss(classTokens(className));
      let chromium: typeof import("playwright").chromium;
      try {
        ({ chromium } = await import("playwright"));
      } catch (err) {
        throw new Error(
          `playwright import failed after skipIf: ${err instanceof Error ? err.message : err}`
        );
      }
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<!doctype html><html><head><style>${css}</style></head><body><button id="b" class="${className}">변경 저장</button></body></html>`
        );
        const el = page.locator("#b");
        await el.evaluate((node) => {
          const target = node as HTMLElement & { __ev: string[] };
          target.__ev = [];
          for (const type of ["transitionrun", "transitionend"] as const) {
            node.addEventListener(type, (event) => {
              target.__ev.push(
                `${type}:${(event as TransitionEvent).propertyName}`
              );
            });
          }
        });
        const box = await el.boundingBox();
        if (!box) throw new Error("button box missing");
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(180);
        const events = await el.evaluate(
          (node) => (node as HTMLElement & { __ev: string[] }).__ev
        );
        expect(
          events.some((entry) => entry.startsWith("transitionrun:transform")),
          `events=${events.join(" ")}`
        ).toBe(true);
        await page.mouse.up();
      } finally {
        await browser.close();
      }
    },
    20_000
  );
});

describe("ADR-0179 D6 엘리베이션 이름", () => {
  it("rest·float 이 기존 두 단의 이름이다", () => {
    expect(MOTION_CSS).toMatch(/--elevation-rest:/);
    expect(MOTION_CSS).toMatch(/--elevation-float:/);
  });
});

describe("ADR-0179 D9 reduced-motion", () => {
  it("사다리 소비자는 duration 0 이다 (모션을 끄는 것이 아니라 0으로 만든다)", () => {
    const reduceAt = MOTION_CSS.search(
      /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/
    );
    expect(reduceAt).toBeGreaterThanOrEqual(0);
    const reduce = MOTION_CSS.slice(reduceAt);
    for (const name of Object.keys(LADDER)) {
      expect(reduce).toMatch(new RegExp(`--motion-${name}:\\s*0ms`));
    }
  });
});

describe("ADR-0179 D10 사다리 밖 ms 리터럴", () => {
  it("tokens.css 가 motion.css 를 import 한다", () => {
    expect(TOKENS_CSS).toMatch(/@import\s+"\.\/motion\.css"/);
  });

  it("motion.css 의 ms 리터럴은 사다리·reduced-motion 0·모달 200/150 뿐이다", () => {
    const allowed = new Set([
      "0ms",
      "120ms",
      "180ms",
      "240ms",
      "500ms",
      "200ms",
      "150ms",
    ]);
    const found = msLiterals(codeOnly(MOTION_CSS));
    for (const value of found) {
      expect(allowed.has(value), `motion.css off-ladder ${value}`).toBe(true);
    }
  });

  it("Tailwind 기본 transition 이 사다리 instant/standard ease 를 따른다", async () => {
    expect(TOKENS_CSS).toMatch(
      /--default-transition-duration:\s*var\(--motion-instant\)/
    );
    expect(TOKENS_CSS).toMatch(
      /--default-transition-timing-function:\s*var\(--motion-ease-standard\)/
    );
    const css = await buildCss(["transition"]);
    const rule = css.match(/\.transition\s*\{([^}]+)\}/);
    expect(rule, ".transition 규칙").toBeTruthy();
    expect(rule![1]).toMatch(/var\(--motion-instant\)/);
    expect(rule![1]).toMatch(/var\(--motion-ease-standard\)/);
  });

  it("tokens.css 의 ms 리터럴은 온보딩 예외 블록 밖 0건이다", () => {
    const found = msLiterals(codeOnly(stripOnboardingException(TOKENS_CSS)));
    expect(found).toEqual([]);
  });
});
