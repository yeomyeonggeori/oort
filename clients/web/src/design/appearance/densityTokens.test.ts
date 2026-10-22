import { readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
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
const VARIABLES = ["spacing-row", "spacing-row-head", "spacing-message-avatar", "spacing-prose", "spacing-list-item"] as const;
type VariableName = (typeof VARIABLES)[number];

/** 코어의 한 단계가 말하는 CSS 값. 행 사이 거리는 위 행·아래 행이 반씩 문다. */
function expectedFromCore(id: DensityId): Record<VariableName, number> {
  const v = DENSITY[id];
  return {
    "spacing-row": v.messageGap / 2,
    // 묶음 머리 행의 위 여백 = 묶음이 바뀌는 거리 − 위 행이 이미 무는 `--spacing-row`.
    "spacing-row-head": v.messageGroupGap - v.messageGap / 2,
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
    for (const name of ["spacing-row", "spacing-row-head", "spacing-message-avatar", "spacing-prose"] as const) {
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

// -----------------------------------------------------------------------------
// 밀도 변수를 읽는 곳은 닫힌 목록이다 (AP-2a #4189 — 실측으로 찾은 결합의 재발 방지).
//
// `--spacing-row`는 원래 타임라인 행의 값이었고, 같은 6px이 필요한 다른 자리(폰 폭 채널 머리 57px, 컴포저
// 슬래시 명령 목록의 행·머리글·발치)가 이름을 빌려 썼다. 값이 늘 6일 때는 문제가 없었고, 밀도가 그 값을 4/6/8로
// 움직이자 명령 목록 행이 48/52/56px로, 폰 폭 채널 머리가 53/57/61px로 변했다. 밀도는 「메시지 사이와 메시지 안 문단·목록 사이의
// 간격」이라서 그 둘에 닿으면 안 된다. 그래서 그 자리들은 밀도를 따르지 않는 쌍둥이 `--spacing-row-fixed`를 읽고,
// 이 시험이 **밀도 변수를 읽는 파일 전부를 열거**해서 다음 빌려 쓰기를 시험에서 잡는다.
// -----------------------------------------------------------------------------
describe("밀도 변수를 읽는 곳은 닫힌 목록이다", () => {
  const SRC_DIR = fileURLToPath(new URL("../..", import.meta.url));

  /** 주석을 벗긴 소스. 이 저장소의 주석은 클래스 이름과 값을 그대로 인용한다. */
  const codeOnly = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) out.push(...sourceFiles(full));
      else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
    }
    return out;
  }

  const FAMILY = "row|row-head|message-avatar|prose|list-item";
  /**
   * 간격·크기 유틸리티가 밀도 이름을 읽는 모양(`py-row`). `py-row-fixed`는 뒤따르는 `-`가 걸러 낸다. 맨 앞 `-`는 음수
   * 값(마진 유틸리티 앞에 `-`가 붙은 모양)이라 같은 이름을 읽는 것으로 센다(design-review 2차 N-11: 앞 `-`를 거절하는
   * 뒤돌아보기가 그것을 놓쳤다). 합성어 속은 앞 글자 검사가 여전히 걸러 낸다.
   */
  const UTILITY = new RegExp(
    `(?<![\\w-])-?(?:p[xytblrse]?|m[xytblrse]?|gap(?:-[xy])?|space-[xy]|size|w|h|min-[wh]|max-[wh]|top|bottom|inset(?:-[xy])?|translate-[xy])-(?:${FAMILY})(?![\\w-])`,
    "g"
  );
  const VAR = new RegExp(`var\\(--spacing-(?:${FAMILY})\\)`, "g");

  /**
   * Tailwind가 **내장 키워드**로 먼저 푸는 이름. `max-w-prose`는 `65ch`이고 `--spacing-prose`를 읽지 않는다(번들에서
   * `.max-w-prose{max-width:65ch}`로 컴파일되는 것을 변경 전·후 모두 확인했다). 이름만 닮은 다른 뜻이라 읽는 곳으로
   * 세지 않는다. 툴체인이 이 우선순위를 바꾸면 `densityTokens.browser.test.ts`의 컴파일 단정이 빨개진다.
   */
  const TAILWIND_BUILTIN_KEYWORDS = new Set(["max-w-prose"]);

  function readers(): Record<string, string[]> {
    const found: Record<string, string[]> = {};
    for (const file of sourceFiles(SRC_DIR)) {
      const text = codeOnly(readFileSync(file, "utf8"));
      const hits = [...text.matchAll(UTILITY)]
        .map((m) => m[0])
        .filter((hit) => !TAILWIND_BUILTIN_KEYWORDS.has(hit))
        .concat([...text.matchAll(VAR)].map((m) => m[0]));
      if (hits.length > 0) found[relative(SRC_DIR, file)] = [...new Set(hits)].sort();
    }
    return found;
  }

  it("클래스·var()로 밀도 변수를 읽는 파일은 타임라인 상수 파일과 tokens.css의 호버 툴바 둘뿐이다", () => {
    expect(readers()).toEqual({
      // 대화 행·본문이 읽는 클래스 상수(MessageRow·PendingRow·MessageBody·ConversationPreview·AiConnectCard는 이 상수를 가져다 쓴다).
      "features/timeline/spacing.ts": [
        "gap-prose",
        "mt-list-item",
        "pb-row",
        "pt-row-head",
        "py-row",
        "size-message-avatar",
        "w-message-avatar",
      ],
      // 호버 툴바가 행 상단 패딩에 걸치는 두 규칙(행의 패딩이 밀도를 따르므로 같이 따라가야 맞다).
      "design/tokens.css": ["var(--spacing-row)"],
    });
  });

  it("읽는 모양 정규식은 음수 마진·변형 접두사를 잡고 쌍둥이·합성어는 거른다 — 가드가 빈손이 되지 않는다", () => {
    const hits = (text: string) => [...text.matchAll(UTILITY)].map((m) => m[0]);
    // Tailwind는 시험 파일까지 훑어 클래스 후보를 만든다. 견본 클래스를 한 덩어리로 적으면 어디서도 안 쓰는 유틸리티가
    // 번들 CSS에 실리므로(처음 이 시험을 쓸 때 실제로 세 개가 실렸다) 조각으로 적어 이어 붙인다.
    const cls = (...parts: string[]) => parts.join("");
    expect(hits(`className="${cls("-m", "t-row")}"`)).toEqual([cls("-m", "t-row")]);
    expect(hits(`className="${cls("md:p", "y-row")} ${cls("hover:p", "t-row-head")}"`)).toEqual([
      cls("p", "y-row"),
      cls("p", "t-row-head"),
    ]);
    expect(hits('className="py-row-fixed foo-py-row"')).toEqual([]);
  });

  it("행 패딩·문단·목록 간격 상수를 가져다 쓰는 파일도 닫힌 목록이다 (아바타 상수는 avatarSize.test.ts가 같은 틀로 센다)", () => {
    // 클래스 글자만 세면 상수를 import해서 쓰는 쪽(사이드바 같은 파일)이 밀도를 따라가도 모든 시험이 초록이다
    // (design-review 2차 N-12). 상수를 유일한 관문으로 삼았으니 그 관문을 지나는 파일도 센다.
    const NAMES = ["MESSAGE_LIST_ITEM_GAP_CLASS", "MESSAGE_PROSE_GAP_CLASS", "ROW_CONTINUATION_PAD_CLASS", "ROW_GROUP_START_PAD_CLASS"];
    const found: Record<string, string[]> = {};
    for (const file of sourceFiles(SRC_DIR)) {
      const text = codeOnly(readFileSync(file, "utf8"));
      const names = NAMES.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
      if (names.length > 0) found[relative(SRC_DIR, file)] = names;
    }
    expect(found).toEqual({
      "features/settings/shell/ConversationPreview.tsx": ["ROW_CONTINUATION_PAD_CLASS", "ROW_GROUP_START_PAD_CLASS"],
      "features/timeline/MessageBody.tsx": ["MESSAGE_LIST_ITEM_GAP_CLASS", "MESSAGE_PROSE_GAP_CLASS"],
      "features/timeline/MessageRow.tsx": ["ROW_CONTINUATION_PAD_CLASS", "ROW_GROUP_START_PAD_CLASS"],
      "features/timeline/PendingRow.tsx": ["ROW_CONTINUATION_PAD_CLASS", "ROW_GROUP_START_PAD_CLASS"],
      "features/timeline/spacing.ts": [
        "MESSAGE_LIST_ITEM_GAP_CLASS",
        "MESSAGE_PROSE_GAP_CLASS",
        "ROW_CONTINUATION_PAD_CLASS",
        "ROW_GROUP_START_PAD_CLASS",
      ],
    });
  });

  it("tokens.css에서 --spacing-row를 var()로 읽는 곳은 정확히 호버 툴바 두 규칙이다", () => {
    const toolbar = codeOnly(TOKENS_CSS).match(/var\(--spacing-row\)/g) ?? [];
    expect(toolbar).toHaveLength(2);
    expect(codeOnly(TOKENS_CSS)).toMatch(/@utility hover-toolbar-straddle \{[^}]*var\(--spacing-row\)/);
    expect(codeOnly(TOKENS_CSS)).toMatch(/@utility hover-toolbar-straddle-below \{[^}]*var\(--spacing-row\)/);
  });

  it("밀도를 따르지 않는 쌍둥이 --spacing-row-fixed는 6px 하나이고 density.css가 건드리지 않는다", () => {
    expect(codeOnly(TOKENS_CSS)).toMatch(/^\s*--spacing-row-fixed:\s*6px;/m);
    expect(codeOnly(DENSITY_CSS)).not.toContain("row-fixed");
    // 쌍둥이의 쓰임새: 폰 폭 채널 머리와 컴포저 명령 목록. 이 자리들이 밀도 이름으로 돌아가면 위 시험이 먼저 빨개진다.
    const users = sourceFiles(SRC_DIR)
      .filter((file) => /-row-fixed\b/.test(codeOnly(readFileSync(file, "utf8"))))
      .map((file) => relative(SRC_DIR, file))
      .sort();
    expect(users).toEqual(["design/tokens.css", "features/chat/ChatShell.tsx", "features/chat/ComposerAutocompleteList.tsx"]);
  });
});

// -----------------------------------------------------------------------------
// 조각이 번들에 실린다 (design-review H-1). 위 시험들은 `density.css`를 **파일로 읽어서** 값을 대조한다. 그 파일을
// `tokens.css`가 `@import`하지 않으면 값은 코어와 한 칸씩 맞는데 번들에는 한 글자도 실리지 않고 모든 시험이 초록이다
// (병렬 워커 넷이 인접해 만지는 import 블록의 충돌 해소 한 줄이 밀도를 통째로 죽일 수 있다). 계산된 값을 재는
// `densityTokens.browser.test.ts`가 같은 구멍을 엔진에서 막지만, 엔진이 없는 레인에서는 그 시험이 비므로 이 정적 핀이
// 그때 도는 유일한 장치다(`motion.test.ts`의 `@import "./motion.css"` 핀과 같은 전례).
// -----------------------------------------------------------------------------
describe("밀도 조각이 tokens.css에 실린다", () => {
  const css = code(TOKENS_CSS);

  it("tokens.css가 density.css를 @import한다", () => {
    expect(css).toMatch(/^@import\s+"\.\/appearance\/density\.css";\s*$/m);
  });

  it("그 @import가 tailwindcss 뒤, 모든 규칙보다 앞에 선다 — @import는 다른 규칙 뒤에서는 무시된다", () => {
    const lines = css.split("\n");
    const at = lines.findIndex((line) => /^@import\s+"\.\/appearance\/density\.css";/.test(line));
    expect(at).toBeGreaterThan(-1);
    const firstRule = lines.findIndex((line) => line.trim() !== "" && !/^@import\b/.test(line));
    expect(at).toBeLessThan(firstRule);
  });

  it("density.css가 비어 있지 않다 — import만 있고 규칙이 없는 조각은 값을 못 싣는다", () => {
    expect(code(DENSITY_CSS)).toMatch(/:root\[data-density="compact"\]\s*\{/);
    expect(code(DENSITY_CSS)).toMatch(/:root\[data-density="spacious"\]\s*\{/);
  });
});
