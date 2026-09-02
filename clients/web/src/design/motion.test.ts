import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";
import {
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
const MOTION_TS = readFileSync(new URL("./motion.ts", import.meta.url), "utf8");
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
});

describe("ADR-0179 D4 모달 상수", () => {
  it("열림 200·닫힘 150 은 motion.ts 한 곳에만 산다", () => {
    expect(MODAL_OVERLAY_MOTION).toMatch(/\bduration-200\b/);
    expect(MODAL_OVERLAY_MOTION).toMatch(/\bduration-150\b/);
    expect(MODAL_CONTENT_MOTION).toMatch(/\bduration-200\b/);
    expect(MODAL_CONTENT_MOTION).toMatch(/\bduration-150\b/);
    expect(MODAL_OVERLAY_MOTION).toMatch(/motion-reduce:animate-none/);
    expect(MODAL_CONTENT_MOTION).toMatch(/motion-reduce:animate-none/);
    expect(POPOVER_MOTION).toMatch(/\bmotion-standard\b/);
    expect(POPOVER_MOTION).toMatch(/\bmotion-fast\b/);
    expect(MOTION_TS).toMatch(/duration-200/);
    expect(MOTION_TS).toMatch(/duration-150/);
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

  it("motion.css 의 ms 리터럴은 사다리와 reduced-motion 0 뿐이다", () => {
    const allowed = new Set(["0ms", "120ms", "180ms", "240ms", "500ms"]);
    const found = msLiterals(codeOnly(MOTION_CSS));
    for (const value of found) {
      expect(allowed.has(value), `motion.css off-ladder ${value}`).toBe(true);
    }
  });

  it("tokens.css 의 ms 리터럴은 온보딩 예외 블록 밖 0건이다", () => {
    const found = msLiterals(codeOnly(stripOnboardingException(TOKENS_CSS)));
    expect(found).toEqual([]);
  });
});
