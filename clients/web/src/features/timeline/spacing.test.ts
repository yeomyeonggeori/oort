import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROOT_ATTRIBUTES } from "@momo/core/design/appearance";
import { DENSITY, DENSITY_IDS, type DensityId } from "@momo/core/design/density";
import {
  DAY_DIVIDER_PAD_CLASS,
  DIVIDER_GAP_CLASS,
  DIVIDER_RULE_CLASS,
  MARKER_DIVIDER_PAD_CLASS,
  ROW_CONTINUATION_PAD_CLASS,
  ROW_GROUP_START_PAD_CLASS,
  SPACING_BRIDGE,
  SPACING_SCALE_PX,
  spacingPx,
} from "./spacing";

// =============================================================================
// 코어의 간격 판정과 화면의 Tailwind 클래스가 갈라지지 않게 하는 단정들.
//
// CSP가 인라인 스타일을 막으므로 값은 두 벌로 존재할 수밖에 없다(`spacing.ts` 머리
// 주석). 두 벌인 것을 못 막으면 **갈라지는 것을 막는다**: 코어의 숫자를 고치고
// 클래스를 안 고치면 이 파일이 붉다.
//
// 폰이 같은 코어 값을 자기 단위로 소비하므로, 이 단정이 지키는 것은 웹 한쪽이 아니라
// 「두 클라가 같은 얼굴을 갖는다」는 M-2의 약속 전체다.
//
// ## 이 파일이 한 번 틀린 표를 봤다 (U4-4R W-2)
//
// 1차는 `spacing.ts`가 들고 있던 **Tailwind 기본 스케일**로 검산했다. 거기에는 `1.5`가
// 있으므로 `py-1.5`(6px)는 산수를 통과했고 — 이 레포의 `tokens.css`에는 그 단계가
// 없어서 브라우저에는 규칙이 만들어지지 않았다. 8건이 초록인 채로 화면의 묶음 안
// 간격은 0px이었다.
//
// 그래서 이제 검산에 쓰는 표를 **`tokens.css`에서 읽는다.** 사본(`SPACING_SCALE_PX`)은
// 런타임용으로 남기되, 그 사본이 진짜인지를 이 파일이 매번 대조한다. 클래스가 실제로
// 컴파일되는지를 묻는 유일한 방법은 그 파일을 읽는 것이다.
// =============================================================================

const TOKENS_CSS_PATH = fileURLToPath(
  new URL("../../design/tokens.css", import.meta.url)
);
const TOKENS_CSS = readFileSync(TOKENS_CSS_PATH, "utf8");

/**
 * `tokens.css`가 실제로 선언한 `--spacing-*` 단계들.
 *
 * 이 표에 없는 이름은 유틸리티가 만들어지지 않는다 — `--spacing: initial`로 동적
 * 배수가 꺼져 있어서 Tailwind가 기본으로 주던 `p-<숫자>` 계산 경로가 통째로 없다.
 */
function declaredSpacingSteps(): Record<string, number> {
  const steps: Record<string, number> = {};
  const pattern = /^\s*--spacing-([a-z0-9-]+):\s*(-?[\d.]+)px;/gm;
  for (const match of TOKENS_CSS.matchAll(pattern)) {
    steps[match[1]] = Number(match[2]);
  }
  return steps;
}

const CSS_STEPS = declaredSpacingSteps();

/** `tokens.css`의 표로만 클래스를 푼다 — 사본이 아니라 CSS가 답한다. */
function cssPx(className: string): number {
  const suffix = className.slice(className.indexOf("-") + 1);
  const value = CSS_STEPS[suffix];
  if (value === undefined) {
    throw new Error(
      `tokens.css에 "--spacing-${suffix}"가 없다: "${className}"는 클래스 이름만 있고 ` +
        "CSS 규칙이 없다 — 화면에서는 그 여백이 0px이 된다 (U4-4R W-1)"
    );
  }
  return value;
}

/** `"pt-3 pb-row"` -> `{ top: 12, bottom: 6 }`. 값의 출처는 `tokens.css`다. */
function padOf(classes: string): { top: number; bottom: number } {
  const parts = classes.split(" ");
  const find = (prefixes: string[]) => {
    for (const part of parts) {
      const prefix = part.slice(0, part.indexOf("-"));
      if (prefixes.includes(prefix)) return cssPx(part);
    }
    throw new Error(`${prefixes.join("/")}에 해당하는 클래스가 없다: "${classes}"`);
  };
  return { top: find(["pt", "py"]), bottom: find(["pb", "py"]) };
}

describe("검산에 쓰는 표가 이 레포의 표다 (U4-4R W-2)", () => {
  it("동적 배수가 꺼져 있다 — 그래서 격자 밖 단계는 아예 컴파일되지 않는다", () => {
    // 이 한 줄이 없으면 `py-1.5`가 조용히 살아나고, 아래 단정들은 다시 아무것도
    // 지키지 못한다. 표를 읽기 전에 표의 성질부터 확인한다.
    expect(TOKENS_CSS).toMatch(/^\s*--spacing:\s*initial;/m);
  });

  it("사본이 tokens.css와 한 글자도 다르지 않다", () => {
    expect(Object.keys(SPACING_SCALE_PX).length).toBeGreaterThan(0);
    for (const [step, px] of Object.entries(SPACING_SCALE_PX)) {
      // 사본에만 있는 단계 = 컴파일되지 않는 단계. 1차가 정확히 그 상태였다.
      expect(CSS_STEPS, `--spacing-${step}가 tokens.css에 없다`).toHaveProperty(
        step
      );
      expect(CSS_STEPS[step], `--spacing-${step}`).toBe(px);
    }
  });

  it("1차가 적었던 py-1.5는 이 표에 없다 — 그것이 W-1의 자리였다", () => {
    // 되돌아오는 것을 막는 단정이다. `tokens.css`는 이 클래스를 「컴파일되지 않는
    // 예」로 이름 대어 적어 두었고, 그 예가 실제로 화면에 나갔다.
    expect(CSS_STEPS).not.toHaveProperty("1.5");
    expect(SPACING_SCALE_PX).not.toHaveProperty("1.5");
    expect(() => cssPx("py-1.5")).toThrow(/tokens.css에/);
  });
});

describe("행 간격이 코어 판정을 따른다 (H-7)", () => {
  /**
   * 코어가 말하는 것은 **행 사이의 거리**이지 한쪽 패딩이 아니다. 웹에서 그 거리는
   * 위 행의 아래 패딩 + 아래 행의 위 패딩이므로, 검산도 그 합으로 한다.
   */
  it("두 연속 행 사이가 withinGroup이다", () => {
    const cont = padOf(ROW_CONTINUATION_PAD_CLASS);
    expect(cont.bottom + cont.top).toBe(SPACING_BRIDGE.withinGroup);
  });

  it("묶음이 바뀌는 자리가 betweenGroups다", () => {
    // 앞 행은 이어지는 행(또는 묶음의 마지막 행)이므로 그 아래 패딩을 쓴다.
    const previous = padOf(ROW_CONTINUATION_PAD_CLASS);
    const head = padOf(ROW_GROUP_START_PAD_CLASS);
    expect(previous.bottom + head.top).toBe(SPACING_BRIDGE.betweenGroups);
  });

  it("묶음 머리 행이 이어지는 행보다 위로 더 열린다", () => {
    expect(padOf(ROW_GROUP_START_PAD_CLASS).top).toBeGreaterThan(
      padOf(ROW_CONTINUATION_PAD_CLASS).top
    );
  });

  it("이어지는 행의 위아래가 대칭이다 — hover 띠가 글자 밑으로 처지지 않게", () => {
    const cont = padOf(ROW_CONTINUATION_PAD_CLASS);
    expect(cont.top).toBe(cont.bottom);
  });
});

// -----------------------------------------------------------------------------
// 대화 밀도 세 단계 (AP-2a #4189). 위의 두 단정은 「편하게」(기본) 단계가 코어의 `ROW_SPACE`와 맞다고
// 말한다. 같은 클래스가 「촘촘하게」·「여유롭게」에서도 코어 `DENSITY`의 그 단계 값을 만드는지가
// 여기서 잰다. 값의 출처는 단계마다 `density.css`의 루트 속성 규칙이 `tokens.css`의 같은 변수를
// 덮는 것이라, 이 시험은 그 두 파일을 **직접 읽어** 클래스를 푼다 — 밀도 변수를 끊으면(규칙을 지우거나
// 변수 이름을 바꾸면) 그 단계의 합이 기본 값으로 돌아가 빨개진다.
// -----------------------------------------------------------------------------
describe("행 간격이 대화 밀도 세 단계에서도 코어 판정을 따른다 (AP-2a)", () => {
  const DENSITY_CSS = readFileSync(
    fileURLToPath(new URL("../../design/appearance/density.css", import.meta.url)),
    "utf8"
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  /** 그 단계의 `:root[data-density="<id>"]` 블록이 덮는 `--spacing-*` 값. 기본 단계는 블록이 없다. */
  function overridesOf(tier: DensityId): Record<string, number> {
    const block = new RegExp(`:root\\[${ROOT_ATTRIBUTES.density}="${tier}"\\]\\s*\\{([^}]*)\\}`).exec(DENSITY_CSS);
    const out: Record<string, number> = {};
    if (!block) return out;
    for (const decl of block[1]!.matchAll(/--spacing-([a-z0-9-]+):\s*(-?[\d.]+)px;/g)) {
      out[decl[1]!] = Number(decl[2]);
    }
    return out;
  }

  /** 단계 안에서 클래스를 푼다: 그 단계의 덮어쓰기가 먼저, 없으면 `@theme` 기본. */
  function padAt(tier: DensityId, classes: string): { top: number; bottom: number } {
    const overrides = overridesOf(tier);
    const px = (part: string) => {
      const name = part.slice(part.indexOf("-") + 1);
      const value = overrides[name] ?? CSS_STEPS[name];
      if (value === undefined) throw new Error(`"${part}"를 풀 수 없다: --spacing-${name}가 없다`);
      return value;
    };
    const parts = classes.split(" ");
    const find = (prefixes: string[]) => {
      for (const part of parts) {
        if (prefixes.includes(part.slice(0, part.indexOf("-")))) return px(part);
      }
      throw new Error(`${prefixes.join("/")}에 해당하는 클래스가 없다: "${classes}"`);
    };
    return { top: find(["pt", "py"]), bottom: find(["pb", "py"]) };
  }

  it.each(DENSITY_IDS)("%s: 두 연속 행 사이가 그 단계의 messageGap이다", (tier) => {
    const cont = padAt(tier, ROW_CONTINUATION_PAD_CLASS);
    expect(cont.bottom + cont.top).toBe(DENSITY[tier].messageGap);
  });

  it.each(DENSITY_IDS)("%s: 묶음이 바뀌는 자리가 그 단계의 messageGroupGap이다", (tier) => {
    const previous = padAt(tier, ROW_CONTINUATION_PAD_CLASS);
    const head = padAt(tier, ROW_GROUP_START_PAD_CLASS);
    expect(previous.bottom + head.top).toBe(DENSITY[tier].messageGroupGap);
  });

  it.each(DENSITY_IDS)("%s: 묶음 머리 행이 이어지는 행보다 위로 더 열리고, 이어지는 행은 위아래가 대칭이다", (tier) => {
    const head = padAt(tier, ROW_GROUP_START_PAD_CLASS);
    const cont = padAt(tier, ROW_CONTINUATION_PAD_CLASS);
    expect(head.top).toBeGreaterThan(cont.top);
    expect(cont.top).toBe(cont.bottom);
  });

  it("기본 단계의 합이 위쪽 「코어 ROW_SPACE」 단정과 같은 숫자다 — 두 갈래가 한 표를 본다", () => {
    expect(DENSITY.comfortable.messageGap).toBe(SPACING_BRIDGE.withinGroup);
    expect(DENSITY.comfortable.messageGroupGap).toBe(SPACING_BRIDGE.betweenGroups);
  });

  it("모든 단계에서 행 사이 거리가 늘수록 묶음 사이 거리도 늘어난다 — 단계가 거꾸로 서지 않는다", () => {
    const order: DensityId[] = ["compact", "comfortable", "spacious"];
    const within = order.map((tier) => padAt(tier, ROW_CONTINUATION_PAD_CLASS).top * 2);
    const between = order.map((tier) => padAt(tier, ROW_CONTINUATION_PAD_CLASS).bottom + padAt(tier, ROW_GROUP_START_PAD_CLASS).top);
    expect([...within].sort((a, b) => a - b)).toEqual(within);
    expect([...between].sort((a, b) => a - b)).toEqual(between);
    expect(new Set(within).size).toBe(3);
    expect(new Set(between).size).toBe(3);
  });
});

describe("구분선 간격이 코어 판정을 따른다 (M-2)", () => {
  it("날짜 구분선의 위아래가 코어 값이다", () => {
    const pad = padOf(DAY_DIVIDER_PAD_CLASS);
    expect(pad.top).toBe(SPACING_BRIDGE.dayDividerBlock.blockStart);
    expect(pad.bottom).toBe(SPACING_BRIDGE.dayDividerBlock.blockEnd);
  });

  it("안읽음·복구 표지의 위아래가 코어 값이다", () => {
    const pad = padOf(MARKER_DIVIDER_PAD_CLASS);
    expect(pad.top).toBe(SPACING_BRIDGE.markerDividerBlock.blockStart);
    expect(pad.bottom).toBe(SPACING_BRIDGE.markerDividerBlock.blockEnd);
  });

  it("라벨과 rule 사이, 그리고 rule 두께가 코어 값이다", () => {
    expect(cssPx(DIVIDER_GAP_CLASS)).toBe(SPACING_BRIDGE.labelGap);
    expect(cssPx(DIVIDER_RULE_CLASS)).toBe(SPACING_BRIDGE.ruleThickness);
  });

  it("날짜가 같은 날 안의 표지보다 더 연다", () => {
    expect(cssPx(DAY_DIVIDER_PAD_CLASS)).toBeGreaterThan(
      cssPx(MARKER_DIVIDER_PAD_CLASS)
    );
  });
});

// -----------------------------------------------------------------------------
// U4-6 리뷰 M-1 — 다리를 놓아도 **건너지 않는 행**이 있으면 소용이 없다.
//
// 리뷰가 실측한 것: `PendingRow.tsx`가 `pt-3 pb-1`/`py-1`을 손으로 들고 있었다.
// 위 단정들은 전부 초록이었다 — 이 파일은 상수를 검산할 뿐 **누가 그 상수를 쓰는
// 지**는 묻지 않았기 때문이다. 그 사이 echo 행의 묶음 안 간격은 8px(4+4)이었고
// 코어가 말하는 값은 12다.
//
// 그리고 그 4px은 눈에 보이는 자리에서 움직인다: echo 행은 서버 echo가 도착하면
// `MessageRow`로 **교체된다.** 패딩이 다르면 방금 보낸 글이 도착 순간 4px 내려
// 앉는다 — `PendingRow` 머리말이 「같은 그리드를 빌려 쓰는 이유는 행이 제자리로
// 튀지 않게 하려는 것」이라고 적은 그 성질의 반대다.
//
// 소스를 읽는 단정인 이유는 U4-4R W-2와 같다: 물어야 하는 것이 「값이 맞는가」가
// 아니라 「그 값이 화면에 닿는가」다. 이 레포에 웹 컴포넌트 렌더 테스트는 없고,
// 있어도 jsdom은 Tailwind를 컴파일하지 않으므로 클래스 이름까지가 관측의 끝이다.
// -----------------------------------------------------------------------------
describe("행을 그리는 파일이 전부 이 다리를 건넌다 (M-1)", () => {
  /** 타임라인에서 **메시지 한 줄**을 그리는 파일들. 구분선은 자기 축이 있다. */
  const ROW_FILES = ["MessageRow.tsx", "PendingRow.tsx"] as const;

  const sourceOf = (file: string) =>
    readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it.each(ROW_FILES)("%s가 행 패딩을 이름으로 든다", (file) => {
    const code = sourceOf(file);
    expect(code).toContain("ROW_GROUP_START_PAD_CLASS");
    expect(code).toContain("ROW_CONTINUATION_PAD_CLASS");
  });

  it.each(ROW_FILES)("%s에 손으로 적은 행 패딩이 없다", (file) => {
    // `startsGroup ? "pt-3 pb-1" : "py-1"`이 정확히 이 모양이었다. 되돌아오면
    // 여기서 빨강이다 — 산수가 맞는 값을 적어 넣어도 마찬가지다: 정본은 코어이고
    // 두 번째 사본은 갈라질 자리이지 다른 무엇도 아니다.
    const code = sourceOf(file);
    const handWritten = code.match(/\bp[tby]-(?:row(?:-head)?(?![-\w])|\d)/g);
    expect(handWritten, `${file}: ${handWritten?.join(" · ")}`).toBeNull();
  });
});

describe("임의값을 클래스에 적어 넣지 못한다", () => {
  it("이 레포의 표 밖은 거부한다", () => {
    expect(() => spacingPx("pt-[13px]")).toThrow(/간격 표에 없는/);
    expect(() => spacingPx("py-7")).toThrow(/간격 표에 없는/);
    // 리듬 축이 아닌 이름도 간격으로는 못 쓴다: `py-pane`은 320px짜리 여백이 된다.
    expect(() => spacingPx("py-pane")).toThrow(/간격 표에 없는/);
  });
});
