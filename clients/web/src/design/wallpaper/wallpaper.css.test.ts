import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODES } from "@momo/core/design/themes";
import { WALLPAPER_MIN_WINDOW_PX, WALLPAPER_VARS, WALLPAPER_VAR_ROLES } from "@momo/core/design/wallpaper";

// =============================================================================
// 배경화면 CSS 조각의 계약 (AP-4 #4191). 진짜 렌더에서 이 조각이 글자 대비를 지키는지는 캡처 스크립트의 단정이 재고,
// 여기서는 렌더 없이 **읽어서** 지킬 수 있는 계약을 잰다.
//   1. 모든 규칙이 JS가 실제로 깔 때만 켜는 `data-wallpaper-live`에 걸린다(선택 속성 `data-wallpaper`에 걸리지 않는다).
//   2. 셸을 쌓임 맥락으로 만들지 않는다(`isolation`·셸의 `z-index`): 층 순서가 그 전제 위에 서 있다.
//   3. JS가 싣는 변수 이름 표(core)와 CSS가 읽는 이름이 한 칸씩 같다.
//   4. 티끌 하나도 `tokens.css`를 고치지 않고 층 변수만 바꾼다(AP-1a가 나눈 `--shell-layer-*`).
// =============================================================================

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CSS = readFileSync(`${HERE}../appearance/wallpaper.css`, "utf8");
const TOKENS = readFileSync(`${HERE}../tokens.css`, "utf8");

/** 주석을 걷는다. */
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** 규칙 하나: 선택자 목록과 본문. 미디어 블록 안의 규칙도 펴서 읽는다. */
function rules(css: string): { selectors: string[]; body: string }[] {
  const out: { selectors: string[]; body: string }[] = [];
  const text = strip(css);
  let at = 0;
  const walk = (until: number): void => {
    while (at < until) {
      const open = text.indexOf("{", at);
      if (open < 0 || open >= until) return;
      const head = text.slice(at, open).trim();
      // 미디어·컨테이너 블록은 안을 편다.
      if (head.startsWith("@")) {
        const end = matching(text, open);
        at = open + 1;
        walk(end);
        at = end + 1;
        continue;
      }
      const end = text.indexOf("}", open);
      out.push({ selectors: head.split(",").map((s) => s.trim()).filter(Boolean), body: text.slice(open + 1, end) });
      at = end + 1;
    }
  };
  walk(text.length);
  return out;
}

function matching(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("unbalanced braces");
}

const ALL = rules(CSS);
/** 칩 구역(설정 화면의 선택 칩)은 켜짐과 무관한 규칙이라 따로 본다. */
const FLOOR = ALL.filter((rule) => rule.selectors.every((s) => !/wallpaper-(choice|chip)/.test(s)));
const CHIPS = ALL.filter((rule) => rule.selectors.some((s) => /wallpaper-(choice|chip)/.test(s)));

describe("1. 모든 규칙은 data-wallpaper-live에만 걸린다", () => {
  it("규칙이 읽혔다 (빈 파서의 초록이 아니다)", () => {
    // 숨기는 기본 규칙, 켜진 층 요소, 셸, 별칭 변수, 바닥 위 글자 보정: 다섯 규칙이다.
    expect(FLOOR.length).toBe(5);
    expect(CHIPS.length).toBeGreaterThanOrEqual(6);
  });

  it("바닥·층·글자 규칙의 선택자는 `:root[data-wallpaper-live]`로 시작하고, 예외는 기본으로 숨기는 층 요소 한 규칙이다", () => {
    const outside = FLOOR.flatMap((rule) => rule.selectors).filter((s) => !s.startsWith(":root[data-wallpaper-live]"));
    expect(outside).toEqual(["[data-wallpaper-layer]"]);
  });

  it("기본 규칙은 층 요소를 숨기는 것뿐이다 (켜지지 않으면 아무것도 칠하지 않는다)", () => {
    const base = FLOOR.filter((rule) => rule.selectors.includes("[data-wallpaper-layer]"));
    expect(base).toHaveLength(1);
    expect(base[0].body.replace(/\s+/g, "")).toBe("display:none;");
  });

  it("선택 속성(`data-wallpaper`, 종류)에 거는 규칙이 없다 (접근성·불가·사진 없음에서 평평한 scrim이 서는 사고)", () => {
    for (const rule of ALL) {
      for (const selector of rule.selectors) expect(selector).not.toMatch(/\[data-wallpaper(?:[=\]~|^$*])/);
    }
  });

  it("미디어 질의로 접근성을 가르지 않는다: 판단은 JS 한 곳이다", () => {
    expect(strip(CSS)).not.toMatch(/prefers-reduced-transparency|prefers-contrast/);
  });
});

describe("2. 층 순서의 전제: 셸은 쌓임 맥락이 아니다", () => {
  it("isolation을 쓰지 않는다", () => {
    expect(strip(CSS)).not.toMatch(/\bisolation\s*:/);
  });

  it("층 요소의 z-index는 이름 붙은 층 변수(--layer-wallpaper = -1)이고, 셸 규칙에는 z-index가 없다", () => {
    const layer = FLOOR.find((rule) => rule.selectors.includes(":root[data-wallpaper-live] [data-wallpaper-layer]"));
    expect(layer?.body).toMatch(/--layer-wallpaper:\s*-1\s*;/);
    expect(layer?.body).toMatch(/z-index:\s*var\(--layer-wallpaper\)\s*;/);
    const shell = FLOOR.find((rule) => rule.selectors.includes(":root[data-wallpaper-live] .app-shell"));
    expect(shell?.body).not.toMatch(/z-index|position|isolation|transform|filter|will-change|contain/);
  });

  it("셸 바탕을 비우고 scrim은 AP-1a가 나눈 층 변수(`--shell-layer-canvas`)로 얹는다", () => {
    const shell = FLOOR.find((rule) => rule.selectors.includes(":root[data-wallpaper-live] .app-shell"))!;
    expect(shell.body).toMatch(/background-color:\s*transparent\s*;/);
    expect(shell.body).toMatch(/--shell-layer-canvas:\s*linear-gradient\(/);
    // 띠 층과 배경화면 층 변수는 건드리지 않는다: 띠는 불투명하게 위에 서고 그림은 요소가 맡는다.
    expect(shell.body).not.toMatch(/--shell-layer-band|--shell-layer-wallpaper/);
    // 그 층 변수들은 tokens.css의 AP-1a 계약 그대로 있다.
    for (const name of ["--shell-layer-band", "--shell-layer-canvas", "--shell-layer-wallpaper"]) expect(TOKENS).toContain(name);
  });

  it("폰 폭(core WALLPAPER_MIN_WINDOW_PX 미만)에서는 아무것도 하지 않는다: 켜지는 규칙은 전부 같은 미디어 블록 안이다", () => {
    const text = strip(CSS);
    const query = `@media (width >= ${WALLPAPER_MIN_WINDOW_PX}px)`;
    expect(text, "설정 행이 말하는 폭과 CSS의 폭이 같다").toContain(query);
    const block = text.slice(text.indexOf(query), text.indexOf("/* ---- 설정"));
    for (const rule of FLOOR.filter((r) => r.selectors.some((s) => s.startsWith(":root[data-wallpaper-live]")))) {
      for (const selector of rule.selectors) expect(block, selector).toContain(selector);
    }
  });
});

describe("3. JS가 싣는 변수와 CSS가 읽는 변수가 한 칸씩 같다", () => {
  const text = strip(CSS);
  const read = new Set([...text.matchAll(/var\((--wallpaper-[a-z-]+)\)/g)].map((m) => m[1]));
  const emitted = new Set<string>();
  for (const mode of MODES) {
    emitted.add(WALLPAPER_VARS.scrim(mode));
    for (const role of WALLPAPER_VAR_ROLES) emitted.add(WALLPAPER_VARS.role(role, mode));
  }

  it("JS가 싣는 모든 변수를 CSS가 읽는다 (읽지 않는 변수는 죽은 코드다)", () => {
    for (const name of emitted) expect(read.has(name), name).toBe(true);
  });

  it("CSS가 읽는 `--wallpaper-*` 가운데 JS가 싣지 않는 것은 CSS가 직접 정의하는 별칭뿐이다", () => {
    const defined = new Set([...text.matchAll(/(--wallpaper-[a-z-]+):\s*light-dark\(/g)].map((m) => m[1]));
    const stray = [...read].filter((name) => !emitted.has(name) && !defined.has(name));
    expect(stray).toEqual([]);
  });

  it("별칭은 라이트·다크 한 쌍을 light-dark()로 묶는다 (스킴 전환을 JS가 따라가지 않는다)", () => {
    for (const role of WALLPAPER_VAR_ROLES) {
      const pattern = new RegExp(`--wallpaper-${role}:\\s*light-dark\\(var\\(--wallpaper-${role}-light\\),\\s*var\\(--wallpaper-${role}-dark\\)\\)`);
      expect(text, role).toMatch(pattern);
    }
  });

  it("scrim은 모드별 알파 색을 light-dark()로 고른다", () => {
    expect(text).toContain(`light-dark(var(${WALLPAPER_VARS.scrim("light")}), var(${WALLPAPER_VARS.scrim("dark")}))`);
  });
});

describe("4. 바닥 위 글자의 보정은 scrim이 호스트일 때만 선다 (design-review H-1·H-2)", () => {
  const BAND_FREE = ":root[data-wallpaper-live]:not([data-wallpaper-band])";
  /** 띠가 호스트일 수 있는 자리: 띠가 없을 때만 보정한다. 웹의 접힌 상단 줄(토글이 안쪽 여백 8px, 레일 안)도 여기다.
   *  데스크탑의 접힌 상단 줄(토글이 신호등 인셋 80px 뒤)도 여기다: 띠가 있는 테마에서는 띠의 윗줄이 전폭으로 깔려(#4591) 그 줄을 덮는다. */
  const BAND_HOSTED = [
    `${BAND_FREE} .app-shell > .sidebar-drawer`,
    `${BAND_FREE} .app-shell > .app-titlebar`,
    `${BAND_FREE} .app-shell .settings-nav`,
    `${BAND_FREE} .app-shell[data-sidebar-collapsed] > .app-titlebar[data-tauri-drag-region]`,
  ];
  /** 띠가 있어도 scrim이 호스트인 자리: 내 작업 격자 바닥(본문이 투명이라 사진이 뒤에 깔린다). */
  const SCRIM_ALWAYS = [":root[data-wallpaper-live] .app-shell[data-work-rail] > main"];
  const fit = FLOOR.find((rule) => rule.selectors.includes(BAND_HOSTED[0]));

  it("띠 위에 설 수 있는 자리(사이드바·상단 줄·설정 목록 열·데스크탑의 접힌 상단 줄)는 띠가 없을 때만 보정한다: 띠가 호스트면 보정색이 대비를 깎는다", () => {
    expect(fit?.selectors.filter((selector) => selector.includes("data-wallpaper-band"))).toEqual(BAND_HOSTED);
  });

  it("띠가 있어도 scrim 위에 서는 자리(내 작업 격자 바닥)는 늘 보정한다", () => {
    for (const selector of SCRIM_ALWAYS) {
      expect(fit?.selectors, selector).toContain(selector);
      expect(selector).not.toContain("data-wallpaper-band");
    }
    expect(fit?.selectors.length).toBe(BAND_HOSTED.length + SCRIM_ALWAYS.length);
  });

  it("웹의 접힌 상단 줄은 띠 쪽이다: 데스크탑 표지(data-tauri-drag-region) 없이 늘 보정하는 선택자가 없다 (토글은 웹에서 레일 안에 선다)", () => {
    for (const selector of fit?.selectors ?? []) {
      if (!selector.includes("app-titlebar") || selector.includes("data-wallpaper-band")) continue;
      expect(selector, "띠 조건이 없는 상단 줄 선택자는 데스크탑 표지를 요구한다").toContain("[data-tauri-drag-region]");
    }
  });

  it("데스크탑 표지가 토글을 레일 밖으로 미는 사실에 이 규칙이 기대고 있다 (tokens.css가 그 인셋을 데스크탑에서만 연다)", () => {
    expect(TOKENS).toMatch(/&\[data-tauri-drag-region\]\s*\{\s*padding-inline-start:\s*var\(--titlebar-inset\)/);
    // 인셋은 레일 폭(56px)보다 크다: 그래야 토글이 띠(레일 폭만큼 칠한다) 밖에 선다.
    const inset = Number(/--titlebar-inset:\s*(\d+)px/.exec(TOKENS)?.[1]);
    const rail = Number(/--spacing-rail:\s*(\d+)px/.exec(TOKENS)?.[1]);
    expect(inset).toBeGreaterThan(rail);
  });

  it("보정은 바닥에 맞춘 색 그대로다: 띠 역할(on-band)을 섞지 않는다 (띠 위는 이 규칙의 대상이 아니다)", () => {
    expect(fit?.body).not.toContain("on-band");
    expect(fit?.body).toMatch(/--ink-muted:\s*var\(--wallpaper-ink-muted\)/);
    expect(fit?.body).toMatch(/--ok:\s*var\(--wallpaper-ok\)/);
    expect(fit?.body).toMatch(/--signal:\s*var\(--wallpaper-signal\)/);
  });

  it("띠 표지는 이 규칙 하나에서만 읽고, 선택 속성이나 다른 규칙으로 새지 않는다", () => {
    const readers = FLOOR.filter((rule) => rule.selectors.some((selector) => selector.includes("data-wallpaper-band")));
    expect(readers).toEqual([fit]);
  });

  it("별칭(--accent·--on-accent)을 장면 안에서 다시 묶는다: 별칭은 루트에서 이미 풀려 있어 포커스 링이 보정 전 신호를 읽는다", () => {
    expect(fit?.body).toMatch(/--accent:\s*var\(--signal\)/);
    expect(fit?.body).toMatch(/--on-accent:\s*var\(--on-signal\)/);
  });

  it("본문 판·카드·시트는 건드리지 않는다: 보정 규칙의 대상은 정해진 다섯 자리뿐이다", () => {
    for (const selector of fit?.selectors ?? []) expect(selector).not.toMatch(/app-pane|settings-pane|\.card|sheet/);
    expect(fit?.selectors.length).toBe(5);
  });

  it("보정 대상 역할은 JS가 싣는 역할 전체다 (하나도 빠지지 않는다)", () => {
    for (const role of WALLPAPER_VAR_ROLES) expect(fit?.body, role).toContain(`--${role}:`);
  });
});

describe("5. 선택 칩의 체크는 흐름 밖에서 칩 한가운데에 선다 (design-review M-1)", () => {
  it("체크가 안 보일 때도 자리를 차지하지 않는다 (절대 위치, 한가운데)", () => {
    const check = CHIPS.find((rule) => rule.selectors.includes(".wallpaper-chip-check"));
    expect(check?.body).toMatch(/position:\s*absolute/);
    expect(check?.body).toMatch(/inset:\s*0/);
    expect(check?.body).toMatch(/margin:\s*auto/);
    const chip = CHIPS.find((rule) => rule.selectors.includes(".wallpaper-chip"));
    expect(chip?.body, "체크의 기준 상자").toMatch(/position:\s*relative/);
  });
});
