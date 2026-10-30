import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// =============================================================================
// 오르트 구름 — 비색(非色) 축의 정본 자기 검사 (#1211 D2·D3)
//
// `tokens.contrast.test.ts` 는 **색**을 잰다: 토큰 쌍의 대비·채도 위계·스크림 방향.
// 이 파일은 그 옆의 나머지를 잰다 — 간격·타이포·반경·그림자, 그리고 「어느 테두리가
// 컨트롤의 것인가」.
//
// ## 왜 정본이 자기를 재야 하나
//
// 폰의 `__tests__/designSystem.test.ts` 와 `features/timeline/spacing.test.ts` 가
// 이 파일(`tokens.css`)을 **읽어서** 자기가 맞는지 묻는다. 그 두 소비자는 정본이
// 어떤 모양이라는 것을 전제하고 읽는다: 리듬 스케일이 닫혀 있다는 것, 텍스트 롤마다
// 줄 높이가 있다는 것, 이름 축의 값마다 근거가 적혀 있다는 것. 그 전제가 조용히
// 무너지면 소비자들은 **없는 값과 같다**로 통과한다 — U4-4R W-2 가 정확히 그
// 실패였다(가드가 틀린 표를 보고 8/8 초록, 화면은 0px).
//
// 그래서 여기서 재는 것은 값이 아니라 **정본의 성질**이다. 값이 바뀌는 것은 결정이고
// (그 결정은 소비자 쪽 대조가 잡는다), 성질이 바뀌는 것은 사고다.
// =============================================================================

const TOKENS_CSS_PATH = fileURLToPath(new URL("./tokens.css", import.meta.url));
const CSS = readFileSync(TOKENS_CSS_PATH, "utf8");
const MOTION_CSS = readFileSync(
  fileURLToPath(new URL("./motion.css", import.meta.url)),
  "utf8"
);

const UI_DIR = fileURLToPath(new URL("./ui", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

/** 주석을 벗긴 소스. 이 저장소의 주석은 옛 값과 반례를 그대로 인용한다. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");
}

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** `.ts` 까지 — 프리플라이트가 `.tsx` 만 훑는 자리를 이 파일이 받는다. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

// -----------------------------------------------------------------------------
// 1. 축이 닫혀 있다 — 「격자 밖은 아예 컴파일되지 않는다」의 전제
// -----------------------------------------------------------------------------

describe("네 축의 기본 스케일이 꺼져 있다", () => {
  // Tailwind 는 네 축에 자기 기본값을 준다. 그 기본값이 살아 있으면 `p-5`·
  // `rounded-2xl`·`text-3xl`·`bg-indigo-500` 이 전부 컴파일되고, 이 레포의 스케일은
  // 「권고」가 된다. `*: initial` 한 줄이 그 축을 통째로 지우는 것이 강제의 뿌리다.
  it.each([
    ["spacing", /^\s*--spacing:\s*initial;/m],
    ["radius", /^\s*--radius-\*:\s*initial;/m],
    ["text", /^\s*--text-\*:\s*initial;/m],
    ["color", /^\s*--color-\*:\s*initial;/m],
  ])("%s 축의 Tailwind 기본 스케일이 지워져 있다", (_axis, pattern) => {
    expect(CSS).toMatch(pattern);
  });
});

// -----------------------------------------------------------------------------
// 2. 리듬 스케일은 고정이고, 이름 축은 근거를 진다
// -----------------------------------------------------------------------------

/** `--spacing-<name>: <n>px;` 전부. 이름은 리듬 단계이거나 측정값이다. */
function spacingDeclarations(): Array<{ name: string; px: number; line: number }> {
  const out: Array<{ name: string; px: number; line: number }> = [];
  CSS.split("\n").forEach((text, index) => {
    const found = /^\s*--spacing-([a-z0-9-]+):\s*(-?[\d.]+)px;/.exec(text);
    if (found) out.push({ name: found[1], px: Number(found[2]), line: index + 1 });
  });
  return out;
}

const SPACING = spacingDeclarations();

/** 리듬 단계: 숫자 이름과 두 특수 단계(`0`·`px`). 나머지는 전부 측정값이다. */
const isRhythm = (name: string) => /^(?:0|px|\d+)$/.test(name);

describe("간격 축", () => {
  it("리듬 스케일이 정확히 여덟 단계다 — 「고정 스케일」이 문장이 아니라 사실이다", () => {
    // `tokens.css` 의 주석이 *"Allowed steps are {4, 8, 12, 16, 24, 32}px plus 0 and
    // the 1px hairline"* 이라고 선언한다. 그 문장을 지키는 것이 지금까지 아무것도
    // 없었다 — `--spacing-5: 20px` 한 줄이면 `p-5` 가 조용히 살아난다.
    //
    // 단계를 더하는 것은 결정이다. 그래서 이 표를 고쳐야 컴파일된다.
    const rhythm = SPACING.filter((step) => isRhythm(step.name));
    expect(Object.fromEntries(rhythm.map((s) => [s.name, s.px]))).toEqual({
      "0": 0,
      px: 1,
      "1": 4,
      "2": 8,
      "3": 12,
      "4": 16,
      "6": 24,
      "8": 32,
    });
  });

  it("헤어라인을 뺀 모든 리듬 단계가 4의 배수다", () => {
    // 폰의 `space` 가 이 성질 위에 서 있다(`__tests__/designSystem.test.ts`).
    for (const step of SPACING.filter((s) => isRhythm(s.name) && s.name !== "px")) {
      expect([step.name, step.px % 4]).toEqual([step.name, 0]);
    }
  });

  it("이름 축의 값은 전부 근거를 이고 있다 (감사 §B-4 ⑦)", () => {
    // 격자 밖 측정값이 **숫자가 아니라 이름**으로 들어오게 한 설계는 옳다. 그런데
    // 그 이름들이 자라는 속도를 재는 것이 없었고, 한 번은 축이 섞였다 —
    // `--spacing-preview-frame` 의 앞 판이 `--spacing-action`(버튼 최소 **폭**)을
    // **높이**로 빌려 썼다.
    //
    // 상한을 두지 않는다(그건 결정이고 여기 없다). 대신 **값마다 왜 격자 밖인지가
    // 적혀 있을 것**을 강제한다: 지금 그 주석들은 이 레포에서 가장 잘 쓰인 문서이고,
    // 이 단정은 그 관례를 규칙으로 바꾼다. 근거를 못 쓰겠으면 그 값은 리듬 단계로
    // 표현될 수 있다는 뜻이다.
    const lines = CSS.split("\n");
    const measures = SPACING.filter((step) => !isRhythm(step.name));
    expect(measures.length).toBeGreaterThan(0);

    const undocumented: string[] = [];
    for (const measure of measures) {
      // 한 주석이 연달아 선언된 한 묶음을 함께 진다(`--spacing-control{,-sm,-lg}`).
      // 그래서 바로 위가 **같은 축의 다른 측정값**이면 그 묶음의 머리를 계속 찾는다.
      let cursor = measure.line - 2; // 0-based, 바로 위 줄
      while (cursor >= 0 && lines[cursor].trim() === "") cursor -= 1;
      while (
        cursor >= 0 &&
        /^\s*--spacing-[a-z0-9-]+:/.test(lines[cursor]) &&
        !isRhythm(/^\s*--spacing-([a-z0-9-]+):/.exec(lines[cursor])![1])
      ) {
        cursor -= 1;
        while (cursor >= 0 && lines[cursor].trim() === "") cursor -= 1;
      }
      const above = cursor >= 0 ? lines[cursor].trim() : "";
      if (!(above.endsWith("*/") || above.startsWith("*") || above.startsWith("/*"))) {
        undocumented.push(`--spacing-${measure.name} (tokens.css:${measure.line})`);
      }
    }
    expect(undocumented).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// 3. 타이포 축 — 크기 하나에 줄 높이 하나
// -----------------------------------------------------------------------------

/**
 * `--text-<role>: calc(var(--type-rem) * <n>)` — `--line-height` 짝은 이름에서 걸러 낸다.
 *
 * 역할의 크기는 가상 rem의 배수다(AP-2a #4189, ADR-0179 D7). 곱수 × 16이 「기본」 글자 크기
 * 단계의 px이고, 단계가 바뀌면 `--type-rem`이 같은 비율로 움직인다. 이 정규식은 `rem`
 * 리터럴이 아니라 **그 곱셈 식**을 읽는다 — 리터럴 역할이 하나 생기면 읽히지 않아 아래
 * 「여덟 역할이 전부 읽혔다」가 빨개진다(조용히 빈손이 되지 않게).
 */
function textRoles(): Record<string, number> {
  const roles: Record<string, number> = {};
  for (const found of CSS.matchAll(
    /^\s*--text-([a-z][a-z0-9-]*?):\s*calc\(var\(--type-rem\)\s*\*\s*([\d.]+)\);/gm
  )) {
    if (found[1].endsWith("--line-height")) continue;
    roles[found[1]] = Number(found[2]) * 16;
  }
  return roles;
}

function textLineHeights(): Record<string, number> {
  const heights: Record<string, number> = {};
  for (const found of CSS.matchAll(
    /^\s*--text-([a-z][a-z0-9-]*?)--line-height:\s*calc\(var\(--type-rem\)\s*\*\s*([\d.]+)\);/gm
  )) {
    heights[found[1]] = Number(found[2]) * 16;
  }
  return heights;
}

const TEXT_ROLES = textRoles();
const TEXT_LINE_HEIGHTS = textLineHeights();

/** 닫힌 역할 집합. 하나를 더하는 것은 결정이라 이 표를 고쳐야 한다. */
const ROLE_NAMES = ["body", "code", "display", "heading", "label", "meta", "timestamp", "title"];

describe("타이포 축", () => {
  it("여덟 역할이 전부 읽혔고 이름이 닫힌 집합이다 — 정규식이 조용히 빈손이 되지 않는다", () => {
    // 읽는 길이 식 모양을 바꾸는 날(리터럴 `rem`으로 돌아가거나 곱수 없이 `var(--type-rem)`만 쓰는 날)
    // 아래 모든 단정은 빈 객체 위에서 초록이 된다. 개수와 이름을 먼저 잡는다.
    expect(Object.keys(TEXT_ROLES).sort()).toEqual(ROLE_NAMES);
    expect(Object.keys(TEXT_LINE_HEIGHTS).sort()).toEqual(ROLE_NAMES);
  });

  it("어떤 역할도 rem 리터럴이 아니다 — 전부 가상 rem 배율을 곱한다", () => {
    // `--text-body: 0.9375rem;` 같은 줄이 하나라도 있으면 그 역할은 글자 크기 설정을 비껴간다
    // (설정 > 모양 > 글자 크기가 앱 전체에 닿는다는 약속의 구멍).
    const literal = [...CSS.matchAll(/^\s*--text-[a-z][a-z0-9-]*:\s*[\d.]+rem;/gm)].map((m) => m[0].trim());
    expect(literal).toEqual([]);
  });

  it("텍스트 롤마다 줄 높이가 있다", () => {
    // 크기만 있고 줄 높이가 없는 롤은 Tailwind 기본 `line-height` 를 받는다 —
    // `--text-*: initial` 로 축을 지웠으므로 그 기본이 무엇인지는 롤마다 다르고,
    // 결국 「이 표면의 줄 간격은 아무도 안 정했다」가 된다. 폰이 이 정본을 읽을 때
    // 짝을 못 찾는 자리이기도 하다.
    expect(Object.keys(TEXT_ROLES).length).toBeGreaterThan(0);
    expect(Object.keys(TEXT_ROLES).sort()).toEqual(
      Object.keys(TEXT_LINE_HEIGHTS).sort()
    );
  });

  it("줄 높이는 언제나 글자보다 크다", () => {
    for (const [role, size] of Object.entries(TEXT_ROLES)) {
      expect([role, TEXT_LINE_HEIGHTS[role] > size]).toEqual([role, true]);
    }
  });

  it("롤이 크기 순으로 한 줄씩 갈라진다 — 같은 값이 두 이름에 앉지 않는다", () => {
    // 같은 크기의 두 롤은 화면에서 한 단이다. 그러면 위계가 이름에만 있고 눈에는
    // 없다. 리뷰 5위(시각 위계 역전 11건)가 사는 자리다.
    const sizes = Object.values(TEXT_ROLES);
    expect(new Set(sizes).size).toBe(sizes.length);
  });
});

// -----------------------------------------------------------------------------
// 3b. 토큰 밖 글자 크기 금지 (#3774 회귀 가드)
//
// 드리프트는 `text-[..px]`(프리플라이트 `arbitrary_tw`가 막는다)가 아니라 CSS 안의
// `font-size: 13.5px` 같은 리터럴에서 자랐다. 같은 역할이 표면마다 13·13.5·12.5로
// 갈라졌고 이름이 없어 아무도 못 봤다. 그래서 `@theme` 밖 모든 `font-size` 선언은
// `var(--text-*)`(또는 아래 허용 목록)만 읽는다.
// -----------------------------------------------------------------------------

/** 근거 없이 늘리지 않는다. 키는 선언을 잡는 정규식 조각(선택자 아닌 값 전체). */
const FONT_SIZE_ALLOW: Array<{ decl: RegExp; why: string }> = [
  { decl: /^font-size:\s*40px;/, why: "S0 환영 화면 워드마크(스케일 밖 의도된 예외, ADR-0193)" },
  { decl: /^font-size:\s*calc\(var\(--spacing-avatar-hero\)/, why: "히어로 아바타 이니셜은 아바타 크기의 비율" },
  { decl: /^font-size:\s*calc\(var\(--text-title\) \* 20 \/ 17\);/, why: "줄 도구 막대의 빠른 반응 이모지 20px(#4324): 역할을 늘리지 않고 --text-title의 20/17배" },
  { decl: /^font-size:\s*clamp\(/, why: "S0 워드마크 유동 크기(--font-onboarding-wordmark)" },
  { decl: /^font-size:\s*var\(--field-text-floor\);/, why: "입력 칸 16px 바닥(플랫폼 문턱, 롤 아님)" },
  { decl: /^font-size:\s*var\(--session-text-/, why: "세션 목록 지역 별칭, 값은 --text-*에 묶인다(아래 별도 시험)" },
];

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...cssFiles(full));
    else if (entry.name.endsWith(".css")) out.push(full);
  }
  return out;
}

/** 토큰 밖 `font-size:` 선언 중 `var(--text-*)`도 허용 목록도 아닌 것. */
function strayFontSizes(css: string): string[] {
  const stray: string[] = [];
  for (const found of codeOnly(css).matchAll(/font-size:[^;]*;/g)) {
    const decl = found[0];
    if (/^font-size:\s*var\(--text-[a-z]+\);/.test(decl)) continue;
    if (FONT_SIZE_ALLOW.some((rule) => rule.decl.test(decl))) continue;
    stray.push(decl);
  }
  return stray;
}

describe("토큰 밖 글자 크기 금지", () => {
  it("CSS의 모든 font-size는 --text-* 역할을 읽는다", () => {
    const found = cssFiles(SRC_DIR).flatMap((file) =>
      strayFontSizes(readFileSync(file, "utf8")).map(
        (decl) => `${file.slice(SRC_DIR.length)}: ${decl}`
      )
    );
    expect(found).toEqual([]);
  });

  it("가드가 실제로 리터럴을 잡는다(사보타주)", () => {
    expect(strayFontSizes(".x { font-size: 13.5px; }")).toEqual(["font-size: 13.5px;"]);
    expect(strayFontSizes(".x { font-size: 0.84375rem; }")).toHaveLength(1);
    expect(strayFontSizes(".x { font-size: var(--text-body); }")).toEqual([]);
  });

  it("세션 목록 별칭은 --text-* 역할에 묶인다", () => {
    for (const found of CSS.matchAll(/--session-text-[a-z]+:\s*([^;]+);/g)) {
      expect(found[1]).toMatch(/^var\(--text-[a-z]+\)$/);
    }
  });

  it("굵기 800은 CSS에 남지 않는다(S0 워드마크 한 곳만)", () => {
    const heavy = [...codeOnly(CSS).matchAll(/font-weight:\s*(800|900);/g)];
    expect(heavy).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// 4. 반경 축
// -----------------------------------------------------------------------------

function radiusSteps(): Record<string, number> {
  const steps: Record<string, number> = {};
  for (const found of CSS.matchAll(/^\s*--radius-([a-z0-9]+):\s*([\d.]+)px;/gm)) {
    steps[found[1]] = Number(found[2]);
  }
  return steps;
}

const RADIUS = radiusSteps();

describe("반경 축", () => {
  it("웹 플랫폼 사다리 6·10·14·18·20 다섯 값 + pill 이다 (ADR-0189 D6)", () => {
    // 3단(6·10·14)이 플랫폼층 사다리로 바뀌었다. 여섯째 칸 pill 은 Tailwind 정적
    // 유틸 `rounded-full` 이라 토큰이 없다. 사다리 밖 값이 생기면 이 표를 고쳐야
    // 컴파일된다 — 「반경은 사다리의 값뿐」이 문장이 아니라 사실이다.
    expect(RADIUS).toEqual({ sm: 6, md: 10, lg: 14, xl: 18, "2xl": 20 });
  });

  it("작은 것부터 큰 것으로 — 코드 칩 < 배지 < 행·입력 < 본문 판 < 카드", () => {
    const order = ["sm", "md", "lg", "xl", "2xl"] as const;
    for (let i = 1; i < order.length; i += 1) {
      expect(RADIUS[order[i - 1]]).toBeLessThan(RADIUS[order[i]]);
    }
  });

  it("프리미티브가 사다리의 자기 자리에 선다", () => {
    const read = (file: string) => codeOnly(readFileSync(`${UI_DIR}/${file}`, "utf8"));
    expect(read("button.tsx")).toMatch(/\brounded-full\b/);
    expect(read("input.tsx")).toMatch(/\brounded-lg\b/);
    expect(read("select.tsx")).toMatch(/\brounded-lg\b/);
    expect(read("card.tsx")).toMatch(/\brounded-2xl\b/);
    expect(read("dialog.tsx")).toMatch(/\brounded-2xl\b/);
  });
});

// -----------------------------------------------------------------------------
// 5. 컨트롤 경계 — 「이 선이 컨트롤의 것인가」를 기계가 답한다 (D3 · 감사 §B-4 ①)
// -----------------------------------------------------------------------------

/**
 * 컨트롤 프리미티브 — 사람이 **직접 조작하는** 상자. 경계가 어포던스를 진다.
 *
 * `tokens.css:33` 이 이미 규칙을 선언한다: `--line` 은 나누고, `--line-strong` 은
 * 컨트롤을 그린다(3:1). 감사가 지적한 것은 그 규칙이 **문장으로만** 있다는 것이었다 —
 * `border-line` 은 이 레포에 198 회 나오고 그중 어느 것이 컨트롤인지는 아무도 안 본다.
 *
 * 그리고 그 판정이 「grep 으로 못 잡는 의미 질문」인 이유는 **한 번도 이름을 안
 * 붙였기 때문**이다. 어느 파일이 컨트롤 프리미티브인지를 한 자리에 적으면, 남는 것은
 * 문법 질문이 된다. 아래 두 목록이 그 이름이다.
 */
const CONTROL_PRIMITIVES = [
  "button.tsx",
  "input.tsx",
  "listbox-select.tsx",
  "segmented-control.tsx",
  "select.tsx",
  "slider.tsx",
  "switch.tsx",
] as const;

/**
 * 컨테이너 프리미티브 — 담는 상자. 경계는 나누는 선이므로 `--line` 이 옳다.
 * (감사: *"card.tsx·dialog.tsx·dropdown-menu.tsx 도 border-line 이지만 그것들은
 * 컨테이너라 정당하다"*.)
 */
const CONTAINER_PRIMITIVES = [
  "card.tsx",
  "context-menu.tsx",
  "dialog.tsx",
  "dropdown-menu.tsx",
  "popover.tsx",
  "tooltip.tsx",
] as const;

/**
 * 아직 `--line` 을 든 컨트롤 경계의 **남은 수**. 목록이 아니라 상한이다.
 *
 * 마지막 하나였던 `button.tsx` 의 `secondary` 변형(#1210)은 DS2-1(#2713, ADR-0189
 * D6)에서 테두리 없는 채움 알약이 되며 닫혔다. 상한은 0 이다 — 새로 하나가
 * 들어오면 빨개진다.
 */
const WEAK_CONTROL_BORDERS: Readonly<Record<string, number>> = {};

/** 클래스 리스트에 나타난 `border-line`(강한 선이 아닌 것)의 수. */
function weakLineCount(source: string): number {
  const code = codeOnly(source);
  const all = code.match(/\bborder-line\b/g)?.length ?? 0;
  const strong = code.match(/\bborder-line-strong\b/g)?.length ?? 0;
  return all - strong;
}

describe("컨트롤 경계 3:1 (tokens.css:33 이 선언한 규칙)", () => {
  it("프리미티브 분류표가 닫혀 있다 — 새 프리미티브는 반드시 한쪽에 든다", () => {
    // `tokens.contrast.test.ts` 의 표면 분류표와 같은 종류의 단정이다. 열린 표는
    // 「목록에 없어서 안 재짐」을 만들고, 그것이 감사가 센 게이트 맹점 17건의 모양이다.
    const declared = [...CONTROL_PRIMITIVES, ...CONTAINER_PRIMITIVES].sort();
    const actual = readdirSync(UI_DIR)
      .filter((name) => name.endsWith(".tsx"))
      .sort();
    expect(actual).toEqual(declared);
  });

  it("컨트롤 프리미티브는 나누는 선을 경계로 쓰지 않는다", () => {
    for (const file of CONTROL_PRIMITIVES) {
      const count = weakLineCount(readFileSync(`${UI_DIR}/${file}`, "utf8"));
      const allowed = WEAK_CONTROL_BORDERS[file] ?? 0;
      expect([file, count <= allowed]).toEqual([file, true]);
    }
  });

  it("상한 목록에 컨트롤 프리미티브 아닌 이름이 없다", () => {
    // 목록이 컨테이너로 새면 이 단정은 아무것도 지키지 않게 된다.
    for (const file of Object.keys(WEAK_CONTROL_BORDERS)) {
      expect(CONTROL_PRIMITIVES as readonly string[]).toContain(file);
    }
  });
});

// -----------------------------------------------------------------------------
// 6. 그림자 — 대조할 수 없는 축이므로 **어휘를 좁힌다**
// -----------------------------------------------------------------------------

describe("그림자 축", () => {
  // 그림자는 이 시스템에서 유일하게 두 클라를 가로질러 대조할 수 없는 축이다: RN 은
  // 그림자에 iOS 전용(`shadow*`)·Android 전용(`elevation`)·New Architecture 전용
  // (`boxShadow`) 세 API 를 갖고, 한 CSS 문자열이 그 셋으로 번역되지 않는다(감사
  // §A-1-7 · Skyscanner 가 파이프라인을 제대로 만들고도 안드로이드 그림자가 전부
  // `undefined` 였다).
  //
  // ADR-0179 D6 이 그 두 단에 이름을 준다: rest = 카드(`shadow-sm`), float =
  // 떠 있는 표면(`shadow-lg`). 클래스는 그대로 sm/lg 이고, 이름은 motion.css 의
  // `--elevation-rest` / `--elevation-float` 가 Tailwind `--shadow-sm` /
  // `--shadow-lg` 를 가리킨다. 3단은 들이지 않는다.
  const ALLOWED_ELEVATIONS = ["sm", "lg"] as const;

  it("고도는 rest·float 두 이름이고, 클래스는 sm/lg 가 그 이름을 쓴다", () => {
    expect(MOTION_CSS).toMatch(/--elevation-rest:\s*var\(--shadow-sm\)/);
    expect(MOTION_CSS).toMatch(/--elevation-float:\s*var\(--shadow-lg\)/);

    const used = new Set<string>();
    for (const file of tsxFiles(SRC_DIR)) {
      for (const found of codeOnly(readFileSync(file, "utf8")).matchAll(
        /\bshadow-([a-z0-9]+)\b/g
      )) {
        used.add(found[1]);
      }
    }
    expect([...used].sort()).toEqual([...ALLOWED_ELEVATIONS].sort());
  });
});

// -----------------------------------------------------------------------------
// 런타임에 스타일을 쓰는 자리 — **잔량** (#1422 design-review M1)
// -----------------------------------------------------------------------------

describe("컴포넌트는 스타일을 짓지 않는다 — 런타임 몫", () => {
  /**
   * `element.style.x = …` 로 스타일을 쓰는 파일. **0 이 아니라 잔량이다.**
   *
   * 모두 「스타일시트가 미리 알 수 없는 값」을 쓴다:
   *
   *   `useAutoGrow`      내용에서 잰 높이. 값이 사람이 친 글에서 나온다.
   *   `placeholderFit`   계산된 글자꼴의 사본. 값이 `getComputedStyle` 에서 나온다.
   *   `States` (Skeleton) `ready=false`일 때 막대 높이를 저장하고, 뒤집히는
   *                      레이아웃 이펙트에서 그 값→콘텐츠 높이로 호스트를
   *                      옮긴다. 기간·이징은 `.skel.is-sizing`의
   *                      `--motion-standard` 사다리다. JSX `style=` 은 프리플라이트가
   *                      막으므로 `host.style.height` 만 쓴다.
   *
   *   `wallpaper/runtime`  사람이 고른 사진 한 장의 `data:` URL(약 2MB)과 단색·기본 제공의 바탕. 상속되는
   *                      커스텀 프로퍼티에 큰 문자열을 싣지 않으려고 **전용 요소(`[data-wallpaper-layer]`) 한 개**의
   *                      `backgroundColor`·`backgroundImage`에만 그림이 바뀔 때 한 번 쓴다(AP-4 #4191, 청사진 §5.5-d).
   *                      JSX `style=`이 아니고, 어떤 컴포넌트도 지나지 않는다.
   *
   * 지어낸 값(자리·가시성·줄바꿈)은 스타일시트에 있다 — `placeholderFit`
   * 의 것은 `tokens.css` 의 `text-probe` 다. 그래서 이 목록은 「인라인 스타일이
   * 허용된 곳」이 아니라 **「아직 안 닫힌 곳의 수」**이고, 줄어드는 것은 통과하고
   * 늘어나면 빨갛다.
   *
   * 이 단정이 여기 있는 이유: `scripts/design_preflight_web.sh` 의 `inline_style`
   * 은 `style={` / `style="` 를 `.tsx` 에서만 찾는다. `.style.x =` 도, `.ts` 파일
   * 도 그 그렙 밖이라, 이 축은 **아무도 안 보고 있었다**(§5.3 이 세는 그 종류의
   * 구멍). 셸 프리플라이트의 계약을 바꾸는 것은 §6 절차라 여기서 하지 않고,
   * 대신 이 스위트가 전수로 센다 — 병합 트리 게이트가 돌리는 레인이다.
   */
  const REMAINING_RUNTIME_STYLE_WRITERS = [
    "features/timeline/useAutoGrow.ts",
    "features/chat/placeholderFit.ts",
    "features/common/States.tsx",
    "design/wallpaper/runtime.ts",
    // #4775: thumbnail/photo computed border radius is measured at runtime; the crop's WAAPI
    // frames likewise interpolate getBoundingClientRect geometry. Fixed visibility/transform live in CSS.
    "features/attachments/useStageHero.ts",
  ];

  it("런타임 스타일 작성자가 잔량 목록보다 늘지 않는다", () => {
    const writers = new Set<string>();
    for (const file of sourceFiles(SRC_DIR)) {
      const code = codeOnly(readFileSync(file, "utf8"));
      // 점과 대괄호 **둘 다**. 계산된 값을 옮기는 쪽은 반드시 대괄호를 쓰므로
      // (`probe.style[property]`), 점만 찾는 정규식은 정확히 이 축에서 가장
      // 위험한 모양을 놓친다.
      if (/\.style(\.[A-Za-z]+|\[[^\]]+\])\s*=[^=]/.test(code)) {
        writers.add(file.slice(SRC_DIR.length + 1));
      }
    }
    for (const writer of writers) {
      expect(
        REMAINING_RUNTIME_STYLE_WRITERS,
        `${writer} 가 런타임에 스타일을 쓴다. 지어낸 값이면 tokens.css 의 이름 있는 유틸리티로, 잴 수밖에 없는 값이면 이 목록에 근거와 함께 올린다.`
      ).toContain(writer);
    }
    // 그리고 이 스윕이 **정말 무엇인가를 찾고 있는가**. 위 반복문은 아무것도 못
    // 찾아도 초록이라, 정규식이 조용히 죽으면 이 축은 다시 무검사가 된다.
    expect(writers).toContain("features/chat/placeholderFit.ts");
  });

  it("지어낸 값은 이미 스타일시트에 있다 — 프로브의 옷", () => {
    // 목록에 오른 파일이 「잴 수밖에 없는 값만」 쓰는지를 한 자리에서 확인한다.
    // `placeholderFit` 의 자리·가시성·줄바꿈은 `text-probe` 가 든다.
    expect(CSS).toContain("@utility text-probe");
    const fit = codeOnly(
      readFileSync(`${SRC_DIR}/features/chat/placeholderFit.ts`, "utf8")
    );
    expect(fit).toContain('probe.className = "text-probe"');
    for (const authored of ["position", "visibility", "whiteSpace", "pointerEvents"]) {
      expect(fit).not.toContain(`probe.style.${authored}`);
    }
  });
});
