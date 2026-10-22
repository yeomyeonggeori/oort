import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_DENSITY_ID, DENSITY, DENSITY_IDS, type DensityId } from "@momo/core/design/density";
import { ROOT_ATTRIBUTES } from "@momo/core/design/appearance";

// =============================================================================
// 대화 밀도 세 단계의 CSS가 코어 표와 갈라지지 않는가 (AP-2a #4189, ADR-0189 증보 1 D1).
//
// CSP가 인라인 스타일을 막아서 간격 숫자는 코어 `DENSITY`(정본)와 이 CSS 두 벌로 있을 수밖에 없다
// (`features/timeline/spacing.ts` 머리 주석과 같은 사정). 피할 수 있는 것은 그 두 벌이 조용히 갈라지는
// 일이고, 이 파일이 그것을 막는다: 코어의 숫자를 고치고 CSS를 안 고치면 — 또는 반대로 — 빨갛다.
//
// 읽는 파일은 둘이다. 「편하게」(기본) 단계는 `tokens.css`의 `@theme`이, 「촘촘하게」·「여유롭게」는
// `appearance/density.css`의 루트 속성 규칙이 든다. 이 시험은 손으로 옮긴 사본이 아니라 그 파일들을
// 직접 파싱한다 — U4-4R W-2가 보여 준 대로, 사본을 대조하는 가드는 사본이 틀려도 초록이다.
// =============================================================================

const DOC = readFileSync(fileURLToPath(new URL("../../../../../docs/design-system/themes-2.0.md", import.meta.url)), "utf8");
const TOKENS_CSS = readFileSync(fileURLToPath(new URL("../tokens.css", import.meta.url)), "utf8");
const DENSITY_CSS = readFileSync(fileURLToPath(new URL("./density.css", import.meta.url)), "utf8");

/** 주석을 벗긴 CSS. 이 저장소의 주석은 옛 값과 표를 그대로 인용한다. */
const code = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** 대화 밀도가 읽는 변수 다섯과, 코어 필드로부터 그 값을 만드는 식. */
const VARIABLES = ["spacing-row", "spacing-rowhead", "spacing-message-avatar", "spacing-prose", "spacing-list-item"] as const;
type VariableName = (typeof VARIABLES)[number];

/** 코어의 한 단계가 말하는 CSS 값. 행 사이 거리는 위 행·아래 행이 반씩 문다. */
function expectedFromCore(id: DensityId): Record<VariableName, number> {
  const v = DENSITY[id];
  return {
    "spacing-row": v.messageGap / 2,
    // 묶음 머리 행의 위 여백 = 묶음이 바뀌는 거리 − 위 행이 이미 무는 `--spacing-row`.
    "spacing-rowhead": v.messageGroupGap - v.messageGap / 2,
    "spacing-message-avatar": v.messageAvatar,
    "spacing-prose": v.proseGap,
    "spacing-list-item": v.listItemGap,
  };
}

/** `tokens.css` `@theme`이 가진 기본 단계의 값. */
function themeDefaults(): Partial<Record<VariableName, number>> {
  const out: Partial<Record<VariableName, number>> = {};
  for (const name of VARIABLES) {
    const found = new RegExp(`^\\s*--${name}:\\s*(-?[\\d.]+)px;`, "m").exec(code(TOKENS_CSS));
    if (found) out[name] = Number(found[1]);
  }
  return out;
}

/** `density.css`의 `:root[data-density="<id>"] { … }` 블록이 덮는 변수와 값. 블록이 없으면 `null`. */
function tierOverrides(id: string): Record<string, number> | null {
  const block = new RegExp(`:root\\[${ROOT_ATTRIBUTES.density}="${id}"\\]\\s*\\{([^}]*)\\}`).exec(code(DENSITY_CSS));
  if (!block) return null;
  const out: Record<string, number> = {};
  for (const decl of block[1]!.matchAll(/--([a-z0-9-]+):\s*(-?[\d.]+)px;/g)) out[decl[1]!] = Number(decl[2]);
  return out;
}

const OVERRIDDEN_TIERS = DENSITY_IDS.filter((id) => id !== DEFAULT_DENSITY_ID);

describe("대화 밀도 CSS가 코어 DENSITY를 따른다", () => {
  it("「편하게」(기본)는 tokens.css의 @theme이 들고, 그 값이 코어의 comfortable과 한 칸씩 같다", () => {
    expect(themeDefaults()).toEqual(expectedFromCore(DEFAULT_DENSITY_ID));
  });

  it("density.css에는 기본 단계의 규칙이 없다 — 기본은 @theme 하나가 말한다", () => {
    expect(tierOverrides(DEFAULT_DENSITY_ID)).toBeNull();
  });

  it.each(OVERRIDDEN_TIERS)("「%s」 규칙이 같은 다섯 변수를 전부, 코어의 값으로 덮는다", (id) => {
    // 한 변수라도 빠지면 그 단계에서 그 간격만 기본에 남는다. 값이 코어와 다르면 설정 미리보기와
    // 실제 대화가 코어와 갈라진다.
    expect(tierOverrides(id), `:root[${ROOT_ATTRIBUTES.density}="${id}"] 규칙`).toEqual(expectedFromCore(id));
  });

  it("density.css가 가진 밀도 선택자는 코어 목록의 값뿐이고, 같은 선택자가 둘 있지 않다", () => {
    const selectors = [...code(DENSITY_CSS).matchAll(new RegExp(`\\[${ROOT_ATTRIBUTES.density}="([^"]*)"\\]`, "g"))].map(
      (m) => m[1]
    );
    expect([...selectors].sort()).toEqual([...OVERRIDDEN_TIERS].sort());
  });

  it("density.css는 간격 변수 다섯 밖을 건드리지 않는다 — 터치 타깃·타입 스케일·반경·카드 여백은 그대로다", () => {
    // 「밀도가 바꾸지 않는 것」(ADR-0189 증보 1 D1): 터치 하한 44, 컨트롤 높이, 타입 스케일.
    const declared = new Set([...code(DENSITY_CSS).matchAll(/^\s*--([a-z0-9-]+):/gm)].map((m) => m[1]));
    expect([...declared].sort()).toEqual([...VARIABLES].sort());
    for (const forbidden of ["tap-target", "touch-target", "text-", "type-", "radius", "spacing-card", "spacing-control"]) {
      expect([...declared].filter((name) => name!.includes(forbidden))).toEqual([]);
    }
  });

  it("세 단계가 서로 다른 모습을 만든다 — 같은 값으로 접힌 단계가 없다", () => {
    for (const name of ["spacing-row", "spacing-rowhead", "spacing-message-avatar", "spacing-prose"] as const) {
      const values = DENSITY_IDS.map((id) => expectedFromCore(id)[name]);
      expect([name, new Set(values).size]).toEqual([name, 3]);
    }
  });

  it("틀과 그 안의 글자는 서로 다른 축이다: 밀도는 글자 크기를, 글자 크기는 간격을 건드리지 않는다", () => {
    const scale = readFileSync(fileURLToPath(new URL("./typography-scale.css", import.meta.url)), "utf8");
    const declaredInScale = new Set([...code(scale).matchAll(/^\s*--([a-z0-9-]+):/gm)].map((m) => m[1]));
    expect([...declaredInScale].sort()).toEqual(["type-rem", "type-scale"]);
  });
});

describe("테마 토큰 표 §5의 밀도 표가 코어 DENSITY와 같다", () => {
  /** 행 이름 → 코어 필드(한 칸에 두 값이 `A / B`로 들면 둘). */
  const ROWS: ReadonlyArray<readonly [string, ReadonlyArray<keyof (typeof DENSITY)["comfortable"]>]> = [
    ["같은 사람이 연달아 쓴 두 행 사이", ["messageGap"]],
    ["사람이 바뀌는 자리(묶음 사이)", ["messageGroupGap"]],
    ["메시지 아바타(와 거터) 한 변", ["messageAvatar"]],
    ["마크다운 블록(문단·목록·코드) 사이", ["proseGap"]],
    ["목록 항목 사이", ["listItemGap"]],
    ["폰 목록 행", ["phoneListRow"]],
    ["폰 섹션 머리", ["phoneSectionHeader"]],
    ["데스크탑 사이드바 행", ["desktopSidebarRow"]],
    ["카드 안 여백", ["cardPadding"]],
    ["카드 반경 / 행 선택 반경 — 폰", ["phoneCardRadius", "phoneRowRadius"]],
    ["카드 반경 / 행 반경 — 웹", ["webCardRadius", "webRowRadius"]],
  ];

  function section5(): string {
    const start = DOC.indexOf("## 5. 플랫폼층과 밀도");
    const end = DOC.indexOf("## 6. DS2 시리즈");
    expect(start, "§5가 있다").toBeGreaterThan(-1);
    expect(end, "§6이 있다").toBeGreaterThan(start);
    return DOC.slice(start, end);
  }

  /** `| 이름 | compact | comfortable | spacious | … |` 행의 세 칸에서 숫자들을 꺼낸다. */
  function cells(label: string): number[][] {
    const line = section5()
      .split("\n")
      .find((row) => row.startsWith(`| ${label} |`));
    if (!line) throw new Error(`§5 밀도 표에 「${label}」 행이 없다`);
    return line
      .split("|")
      .slice(2, 5)
      .map((cell) => [...cell.matchAll(/\d+(?:\.\d+)?/g)].map((n) => Number(n[0])).slice(0, label.includes(" / ") ? 2 : 1));
  }

  it.each(ROWS)("「%s」 행이 세 단계 모두 코어 값과 같다", (label, keys) => {
    const [compact, comfortable, spacious] = cells(label);
    const want = (id: DensityId) => keys.map((key) => DENSITY[id][key]);
    expect(compact, "compact").toEqual(want("compact"));
    expect(comfortable, "comfortable").toEqual(want("comfortable"));
    expect(spacious, "spacious").toEqual(want("spacious"));
  });

  it("표가 코어 필드를 빠짐없이 다룬다 — 필드가 늘면 이 표에도 행을 더해야 한다", () => {
    const covered = ROWS.flatMap(([, keys]) => keys).sort();
    expect(covered).toEqual(Object.keys(DENSITY.comfortable).sort());
  });
});
