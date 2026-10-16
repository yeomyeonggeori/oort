import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// =============================================================================
// 사이드바 행 호버·우클릭 통일 (#3963) 중 **CSS 와 소스에만 사는 것**.
//
// jsdom 은 tokens.css 를 컴파일하지 않으므로 컴퓨티드 스타일을 못 잰다. 그래서 이 파일은 규칙이
// 거기 있는가·바른 자리(레이어 밖)에 있는가를 소스에서 읽고, **실제 렌더에서 윤곽이 걷히는가**는
// `scripts/capture-3963.mjs` 가 Chromium·WebKit 둘로 잰다(C2 · D3). 이 파일이 초록인 것만으로는
// 우클릭 테두리가 사라졌다고 말하지 않는다.
// =============================================================================

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const TOKENS_CSS = read("../../design/tokens.css");
const ROW_SOURCE = read("./SidebarRow.tsx");
const MENU_SOURCE = read("./SidebarRowContextMenu.tsx");

/** 주석을 걷는다. 이 레포는 주석에 반례와 코드를 그대로 인용한다. */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}
function stripTsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
}

interface Block {
  head: string;
  body: string;
}

/** 깊이 0 의 블록들(선택자 머리 + 몸통). 중첩은 몸통 안에 그대로 남는다. */
function topLevelBlocks(css: string): Block[] {
  const source = stripCssComments(css);
  const blocks: Block[] = [];
  let depth = 0;
  let headStart = 0;
  let bodyStart = 0;
  let head = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      if (depth === 0) {
        head = source.slice(headStart, index).trim();
        bodyStart = index + 1;
      }
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        blocks.push({ head, body: source.slice(bodyStart, index) });
        headStart = index + 1;
      }
    } else if (char === ";" && depth === 0) {
      headStart = index + 1;
    }
  }
  return blocks;
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

function utilityBody(name: string): string {
  const block = topLevelBlocks(TOKENS_CSS).find((candidate) => candidate.head === `@utility ${name}`);
  if (!block) throw new Error(`@utility ${name} 을 tokens.css 에서 못 찾았다`);
  return block.body;
}

describe("우클릭 테두리: 포인터로 연 행 메뉴는 열림 윤곽이 없다", () => {
  const blocks = topLevelBlocks(TOKENS_CSS);
  const rule = blocks.find((block) => /data-row-menu-trigger/.test(block.head));

  it("깊이 0(레이어·@utility·@media 밖)에 규칙이 하나 있다", () => {
    // 윤곽을 그리는 것은 utilities 레이어의 `data-[state=open]:outline` 이다. 레이어 안의 규칙은
    // 특정도·순서와 무관하게 그것을 이기지 못한다(포커스 링을 걷는 규칙이 같은 이유로 레이어 밖이다).
    expect(rule).toBeDefined();
    expect(rule!.head.startsWith("@")).toBe(false);
    expect(blocks.filter((block) => /data-row-menu-trigger/.test(block.head))).toHaveLength(1);
  });

  it("열린 트리거 가운데 **포인터로 연** 것에만 윤곽을 없앤다", () => {
    expect(squash(rule!.head)).toBe(
      '[data-row-menu-trigger][data-state="open"][data-open-via="pointer"]'
    );
    expect(squash(rule!.body)).toBe("outline: none;");
  });

  it("전역 모달리티 스탬프를 읽지 않는다 — 열린 길은 트리거가 적는다", () => {
    // 스탬프를 읽던 첫 판은 두 곳에서 틀렸다(design-review R1 N1): 포인터로 연 메뉴 안의 첫 방향키가
    // 윤곽을 되살리고, 마우스로 행을 누른 뒤 Shift+F10 으로 연 메뉴는 표식을 잃었다.
    expect(squash(rule!.head)).not.toContain("data-focus-modality");
    expect(MENU_SOURCE).toMatch(/data-open-via=\{open \? openVia : undefined\}/);
    // 열린 길은 키보드 소환 경로(`onKeyDown`)만 `keyboard` 로 적는다.
    expect(MENU_SOURCE).toMatch(/summoning\.current = true/);
    expect(MENU_SOURCE).toMatch(/setOpenVia\(summoning\.current \? "keyboard" : "pointer"\)/);
  });

  it("키보드로 연 메뉴의 표식은 건드리지 않는다 — keyboard 값을 겨누는 규칙이 없다", () => {
    expect(stripCssComments(TOKENS_CSS)).not.toMatch(
      /data-open-via="keyboard"[^{]*\{[^}]*outline/
    );
  });

  it("컴포넌트는 열림 윤곽의 클래스를 그대로 들고 있다 — 대비 시험이 이 문자열을 읽는다", () => {
    expect(MENU_SOURCE).toMatch(/data-\[state=open\]:outline\b/);
    expect(MENU_SOURCE).toMatch(/data-\[state=open\]:-outline-offset-1/);
    expect(MENU_SOURCE).toMatch(/data-row-menu-trigger/);
  });

  it("열린 행의 틴트는 호버 채움과 같은 반경이다 (design-review R1 M3)", () => {
    // 링크는 `sidebar-row` 의 `--radius-md`. 트리거가 `rounded-sm`(6) 이면 윤곽이 걷힌 자리에서 열린 행의
    // 모서리가 호버보다 4px 좁게 보인다.
    const trigger = MENU_SOURCE.slice(MENU_SOURCE.indexOf("data-row-menu-trigger"));
    expect(trigger).toMatch(/className="block rounded-md data-\[state=open\]:bg-surface-hover/);
    expect(squash(utilityBody("sidebar-row"))).toContain("border-radius: var(--radius-md)");
  });
});

describe("행 메뉴는 창보다 길어지면 판 안에서 스크롤한다 (design-review R1 B1)", () => {
  const CONTEXT_MENU_SOURCE = read("../../design/ui/context-menu.tsx");
  const utility = topLevelBlocks(TOKENS_CSS).find(
    (block) => block.head === "@utility max-h-menu-available"
  );

  it("유틸리티가 Radix 가 실어 주는 가용 높이로 상한을 둔다", () => {
    expect(utility).toBeDefined();
    const body = squash(utility!.body);
    // 변수는 프리미티브마다 이름이 달라 한 패널에는 하나만 서므로 둘을 이어 쓴다.
    expect(body).toContain("--radix-context-menu-content-available-height");
    expect(body).toContain("--radix-dropdown-menu-content-available-height");
    expect(body).toMatch(/max-block-size: var\(/);
    expect(body).toContain("overflow-y: auto");
  });

  it("컨텍스트 메뉴 판이 그 유틸리티를 쓴다", () => {
    const panel = CONTEXT_MENU_SOURCE.slice(
      CONTEXT_MENU_SOURCE.indexOf("export const ContextMenuContent"),
      CONTEXT_MENU_SOURCE.indexOf("export const ContextMenuItem")
    );
    expect(panel).toMatch(/"layer-overlay-surface[^"]*\bmax-h-menu-available\b/);
  });
});

describe("sidebar-row 유틸리티: X 자리와 아바타 축", () => {
  const utility = topLevelBlocks(TOKENS_CSS).find((block) => block.head === "@utility sidebar-row");

  it("유틸리티가 있다", () => {
    expect(utility).toBeDefined();
  });

  it("X 가 서 있는 동안 오른쪽 36px 을 비운다(X 24 + 오른쪽 8 + 간격 4)", () => {
    const body = squash(utility!.body);
    expect(body).toMatch(/&\[data-row-close\] \{ padding-inline-end: 36px; \}/);
  });

  it("X 가 서 있는 동안 오른쪽 끝의 것들(알약·점·뒤따르는 슬롯)을 한 덩어리로 내린다", () => {
    const body = squash(utility!.body);
    expect(body).toMatch(
      /&\[data-row-close\] \[data-row-trailing\] \{ display: none; \}/
    );
  });

  it("아바타는 글리프의 축 위에 앉는다 — 양쪽 3px (18 + 6 = 24)", () => {
    const body = squash(utility!.body);
    expect(body).toMatch(
      /& \[data-row-icon\]\[data-icon-kind="avatar"\] \{ margin-inline: -3px; \}/
    );
  });
});

describe("호버는 네이티브 이벤트로 듣는다", () => {
  // 같은 파일의 `SidebarSection` 머리글은 React 의 onMouseEnter/Leave 를 쓴다(포털이 없는 자리). 행 하나만 본다.
  const whole = stripTsComments(ROW_SOURCE);
  const code = whole.slice(
    whole.indexOf("export function SidebarRow("),
    whole.indexOf("export function SidebarSection(")
  );

  it("React 의 포털 인지 mouseenter/leave 를 쓰지 않는다", () => {
    // 우클릭 메뉴는 포털이다. React 의 `onMouseLeave` 는 포털 자손으로의 이동을 행 안의 이동으로
    // 쳐서, 메뉴가 닫힌 뒤에도 X 가 남는다(`SidebarRow.dmClose.test.tsx` 가 행동으로 잰다).
    expect(code).not.toMatch(/onMouseLeave|onMouseEnter|onPointerLeave|onPointerEnter/);
    expect(code).toMatch(/addEventListener\("mouseenter"/);
    expect(code).toMatch(/addEventListener\("mouseleave"/);
  });

  it("호버하지 않은 행에는 X 의 DOM 이 없다 — opacity·visibility 로 숨기지 않는다 (SKILL §6)", () => {
    const x = code.slice(code.indexOf("const closeButton"), code.indexOf("const body"));
    expect(x).toMatch(/showClose \?/);
    expect(x).not.toMatch(/opacity-0|invisible|\bvisibility\b/);
    // 탭 순서에도 없다.
    expect(x).toMatch(/tabIndex=\{-1\}/);
  });
});
