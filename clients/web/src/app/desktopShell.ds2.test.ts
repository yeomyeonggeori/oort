import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BAND_ALLOWED_FOREGROUNDS } from "@momo/core/design/themes";

// =============================================================================
// DS2-6 데스크탑 셸 (#2718, ADR-0189) — 시안 A `mockups.html #a-desk`의 기하가
// 셸에 실제로 서 있는가.
//
// 시안의 값은 tokens.css의 셸 유틸들이 진다. 이 파일은 그 값이 거기 있고, 그
// 유틸을 셸 컴포넌트가 실제로 드는지를 함께 잰다. 한쪽만 있으면 초록이 거짓이다
// (유틸만 있고 아무도 안 들거나, 클래스는 있는데 유틸이 다른 값을 답한다).
// 렌더된 기하는 `gates/gate-shell-layout.mjs`가 브라우저에서 잰다.
// =============================================================================

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

const TOKENS = read("../design/tokens.css");
const APP_SHELL = read("./AppShell.tsx");
const SIDEBAR = read("../features/sidebar/Sidebar.tsx");
const SIDEBAR_ROW = read("../features/sidebar/SidebarRow.tsx");
const CHAT_SHELL = read("../features/chat/ChatShell.tsx");
const COMPOSER = read("../features/chat/Composer.tsx");

/** `@utility <name> {` 블록 전체(중첩 포함). 괄호를 세어 닫는다. */
function utility(name: string): string {
  const start = TOKENS.indexOf(`@utility ${name} {`);
  if (start < 0) throw new Error(`@utility ${name} not found`);
  let depth = 0;
  for (let i = TOKENS.indexOf("{", start); i < TOKENS.length; i++) {
    if (TOKENS[i] === "{") depth++;
    else if (TOKENS[i] === "}") {
      depth--;
      if (depth === 0) return TOKENS.slice(start, i + 1);
    }
  }
  throw new Error(`@utility ${name} is not closed`);
}

/** 평범한 CSS 규칙 하나(선택자로 시작하는 블록). */
function rule(selectorStart: string): string {
  const start = TOKENS.indexOf(selectorStart);
  if (start < 0) throw new Error(`${selectorStart} not found`);
  return TOKENS.slice(start, TOKENS.indexOf("\n}", start) + 2);
}

describe("창 바닥과 떠 있는 판 (시안 `.a-win` · `.a-main`)", () => {
  const shell = utility("app-shell");

  it("넓은 창의 셸은 160° 세 정지점 그라데이션 바닥이다(가운데 42%)", () => {
    expect(shell).toMatch(
      /linear-gradient\(\s*160deg,\s*var\(--canvas-top\) 0%,\s*var\(--canvas-mid\) 42%,\s*var\(--canvas-bottom\) 100%\s*\)/
    );
  });

  it("띠가 있는 테마는 사이드바 열 폭만큼 띠가 바닥 위에 깔리고, 접히면 0이다", () => {
    expect(shell).toMatch(/linear-gradient\(var\(--band, transparent\), var\(--band, transparent\)\)/);
    expect(shell).toMatch(/background-size:\s*var\(--w-sidebar\) 100%,/);
    expect(shell).toMatch(/\[data-sidebar-collapsed\][\s\S]*?background-size:\s*0px 100%,/);
  });

  it("본문은 첫 행부터 인셋 8(위·오른쪽·아래)로 떠 있고, 접히면 상단 줄 아래로 내려간다", () => {
    expect(shell).toMatch(/> main \{\s*grid-row: 1 \/ -1;\s*grid-column: 2;\s*margin-block: var\(--spacing-2\);\s*margin-inline: 0 var\(--spacing-2\);/);
    expect(shell).toMatch(/\[data-sidebar-collapsed\][\s\S]*?> main \{\s*grid-row: 2;\s*margin-block-start: 0;\s*margin-inline-start: var\(--spacing-2\);/);
  });

  it("판은 반경 18 · rest 그림자 + 1px 선 고리이고, 셸의 <main>이 그것을 든다", () => {
    const pane = utility("app-pane");
    expect(TOKENS).toMatch(/--radius-xl: 18px;/);
    expect(pane).toMatch(/border-radius: var\(--radius-xl\);/);
    expect(pane).toMatch(/box-shadow:\s*var\(--elevation-rest\),\s*0 0 0 1px var\(--line\);/);
    expect(APP_SHELL).toMatch(/<main ref=\{mainRef\} className="app-pane\b/);
  });

  it("사이드바 목록 열은 시안의 268이고, 레일(56)은 그 옆에 붙는다", () => {
    expect(TOKENS).toMatch(/--w-sidebar-list: 268px;/);
    expect(TOKENS).toMatch(/--w-sidebar: calc\(var\(--spacing-rail\) \+ var\(--w-sidebar-list\)\);/);
  });

  it("상단 줄은 바닥 위에 녹는다: 바탕 없음, 테두리는 투명하게 자리만(#2700 19.5 유지)", () => {
    const titlebar = utility("app-titlebar");
    expect(titlebar).toMatch(/background-color: transparent;/);
    expect(titlebar).toMatch(/border-block-end: 1px solid transparent;/);
  });

  it("사이드바 열과 레일은 자기 바탕도 경계선도 칠하지 않는다", () => {
    expect(SIDEBAR).not.toMatch(/bg-surface-sidebar/);
    expect(SIDEBAR).not.toMatch(/border-r border-line/);
    expect(read("../features/sidebar/WorkspaceRail.tsx")).not.toMatch(
      /\bbg-surface-sidebar\b|border-r border-line|\bbg-accent(?:-soft)?\b/
    );
  });
});

describe("사이드바 (시안 `.a-side`)", () => {
  it("검색 입구는 36 높이 · 반경 12 · 유리 + rest다", () => {
    const search = utility("sidebar-search");
    expect(TOKENS).toMatch(/--spacing-field: 36px;/);
    expect(search).toMatch(/min-block-size: var\(--spacing-field\);/);
    expect(search).toMatch(/border-radius: 12px;/);
    expect(search).toMatch(/box-shadow: var\(--elevation-rest\);/);
    expect(SIDEBAR).toMatch(/className="[^"]*\bglass\b[^"]*\bsidebar-search\b[^"]*"/);
  });

  it("행은 34 · 반경 10 · 아이콘 18이고, 안 읽음은 굵기 700이다", () => {
    const row = utility("sidebar-row");
    expect(row).toMatch(/min-block-size: 34px;/);
    expect(row).toMatch(/border-radius: var\(--radius-md\);/);
    expect(TOKENS).toMatch(/--radius-md: 10px;/);
    expect(row).toMatch(/\[data-row-icon\] svg \{\s*inline-size: 1\.125rem;\s*block-size: 1\.125rem;/);
    expect(row).toMatch(/&\[data-unread\] \{\s*font-weight: 700;/);
  });

  it("선택 행은 흰 면 + rest로 뜨고 호박색을 쓰지 않는다 (owner 결정 2026-09-26)", () => {
    const selected = utility("sidebar-row-selected");
    expect(selected).toMatch(/background-color: var\(--surface\);/);
    expect(selected).toMatch(/box-shadow: var\(--elevation-rest\);/);
    expect(selected).not.toMatch(/--signal|--accent/);
    const active = /const activeClass =\s*"([^"]+)"/.exec(SIDEBAR_ROW)?.[1] ?? "";
    expect(active.split(/\s+/)).toEqual(
      expect.arrayContaining(["band-surface", "sidebar-row-selected"])
    );
    expect(active).not.toMatch(/\b(?:bg-accent|bg-signal)[\w-]*/);
  });

  it("작업 중 카드와 워크스페이스 머리가 목록 위에 선다", () => {
    expect(SIDEBAR).toMatch(/<SidebarNowCard\b/);
    expect(SIDEBAR).toMatch(/className="sidebar-ws"/);
    expect(SIDEBAR).toMatch(/<KomettoMark\b/);
    expect(SIDEBAR.indexOf("<SidebarNowCard")).toBeLessThan(
      SIDEBAR.indexOf("baseChannelSection.title")
    );
  });
});

describe("띠 위 규칙 (노을띠 `band`, themes-2.0 §3)", () => {
  const scope = rule(".sidebar-drawer,\n.app-shell:not([data-sidebar-collapsed]) > .app-titlebar {");
  const allowed = new Set<string>(BAND_ALLOWED_FOREGROUNDS.map(([role]) => role));

  it("사이드바 범위의 글자 역할은 전부 띠 위에 설 수 있는 역할로 다시 묶인다", () => {
    // 띠가 없으면 뒤 값(루트에서 받아 둔 원래 역할)으로 떨어진다.
    for (const role of ["ink", "ink-muted", "icon", "agent", "warn", "primary"]) {
      const found = new RegExp(`--${role}: var\\(--([a-z-]+), var\\(--${role}-base\\)\\);`).exec(scope);
      expect(found, `--${role}`).not.toBeNull();
      expect([role, allowed.has(found![1])]).toEqual([role, true]);
    }
    expect(scope).toMatch(/color: var\(--ink\);/);
  });

  it("띠 위의 채움은 on-band를 섞고, 띠가 없으면 원래 채움이다", () => {
    expect(scope).toMatch(/--surface-hover: var\(--band-fill, var\(--surface-hover-base\)\);/);
    expect(TOKENS).toMatch(/--band-fill: color-mix\(in srgb, var\(--on-band\) 10%, transparent\);/);
  });

  it("흰 면(band-surface)은 되찾는 역할이 다시 묶는 역할과 같은 집합이다", () => {
    // `--glass`는 예외다: 유리 요소 자신이 `band-surface`를 들므로(검색·지금
    // 카드), 되찾으면 띠 위에서 반투명으로 돌아가 버린다.
    const remapped = [...scope.matchAll(/--([a-z-]+): var\(/g)]
      .map((m) => m[1])
      .filter((role) => role !== "glass")
      .sort();
    const restored = [...utility("band-surface").matchAll(/--([a-z-]+): var\(--\1-base\);/g)]
      .map((m) => m[1])
      .sort();
    expect(restored).toEqual(remapped);
  });
});

describe("본문 머리와 컴포저 (시안 `.a-mhd` · `.a-dcomp`)", () => {
  it("머리는 넓은 창에서 60 · 좌 24 우 18이고 제목은 17/800이다", () => {
    const head = utility("channel-head");
    expect(head).toMatch(/min-block-size: 60px;/);
    expect(head).toMatch(/padding-inline: var\(--spacing-6\) 18px;/);
    const title = utility("channel-head-title");
    expect(title).toMatch(/font-size: 1\.0625rem;/);
    expect(title).toMatch(/font-weight: 800;/);
    expect(CHAT_SHELL).toMatch(/className="channel-head\b/);
  });

  it("컴포저는 반경 20 · float 그림자의 흰 카드이고 좌우 24 · 아래 18에 뜬다", () => {
    const card = utility("composer-card");
    expect(card).toMatch(/border-radius: var\(--radius-2xl\);/);
    expect(TOKENS).toMatch(/--radius-2xl: 20px;/);
    expect(card).toMatch(/box-shadow: var\(--elevation-float\);/);
    expect(utility("composer-dock")).toMatch(/padding: var\(--spacing-2\) var\(--spacing-6\) 18px;/);
    expect(COMPOSER).toMatch(/className="composer-card\b/);
    expect(COMPOSER).toMatch(/"composer-dock safe-area-bottom shrink-0"/);
  });
});
