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
const GLASS_CSS = read("../design/appearance/glass.css");
const WALLPAPER_CSS = read("../design/appearance/wallpaper.css");
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

  it("띠가 있는 테마는 창 바닥 전체가 띠 색이고, 「내 작업」에서만 사이드바 열 폭(접히면 레일 폭)만 칠한다 (#3280, #4591)", () => {
    expect(shell).toMatch(/linear-gradient\(var\(--band, transparent\), var\(--band, transparent\)\)/);
    // 판이 뜨는 화면의 기본: 띠 ①이 창 전체(100%)다. 사이드바와 판 바깥(위·오른쪽·아래 여백)이 한 색이다.
    expect(shell).toMatch(/--shell-band-w: 100%;/);
    expect(shell).toMatch(/background-size:\s*var\(--shell-band-w\) 100%,/);
    // 판이 없는 「내 작업」은 사이드바 열 폭, 접히면 레일 폭이다.
    const workRail = shell.slice(shell.indexOf("&[data-work-rail] {"));
    expect(workRail).toMatch(/--shell-band-w: var\(--w-sidebar\);/);
    expect(workRail).toMatch(/&\[data-sidebar-collapsed\] \{\s*--shell-band-w: var\(--spacing-rail\);/);
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

  it("상단 줄은 바닥 위에 녹는다: 바탕 없음, 아래 테두리도 없다(#4591: 토글 중심 20.0 = 띠 가운데)", () => {
    const titlebar = utility("app-titlebar");
    expect(titlebar).toMatch(/background-color: transparent;/);
    expect(titlebar).not.toMatch(/border-block-end|border-bottom/);
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

  it("행은 34 · 반경 10 · 아이콘 18이고, 안 읽음은 굵기 600이다(#3774, 800·700 위계 정리)", () => {
    const row = utility("sidebar-row");
    expect(row).toMatch(/min-block-size: 34px;/);
    expect(row).toMatch(/border-radius: var\(--radius-md\);/);
    expect(TOKENS).toMatch(/--radius-md: 10px;/);
    expect(row).toMatch(/\[data-row-icon\] svg \{\s*inline-size: 1\.125rem;\s*block-size: 1\.125rem;/);
    expect(row).toMatch(/&\[data-unread\] \{\s*font-weight: 600;/);
  });

  it("선택 행은 흰 면 + rest로 뜨고 호박색을 쓰지 않는다 (owner 결정 2026-09-26)", () => {
    const selected = utility("sidebar-row-selected");
    expect(selected).toMatch(/background-color: var\(--surface\);/);
    // 다크 대비 고리(#3280): 라이트는 투명이라 그대로이고 다크에서만 --line-strong 1px가 선다.
    expect(selected).toMatch(/box-shadow:\s*var\(--elevation-rest\),\s*inset 0 0 0 1px var\(--selected-edge\);/);
    expect(TOKENS).toMatch(/--selected-edge: light-dark\(transparent, var\(--line-strong\)\);/);
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
  const scope = rule(
    ".sidebar-drawer,\n.app-shell:not([data-sidebar-collapsed]) > .app-titlebar,\n.app-shell[data-desktop-shell] > .app-titlebar {"
  );
  const allowed = new Set<string>(BAND_ALLOWED_FOREGROUNDS.map(([role]) => role));

  it("사이드바 범위의 글자 역할은 전부 띠 위에 설 수 있는 역할로 다시 묶인다", () => {
    // 띠가 없으면 뒤 값(루트에서 받아 둔 원래 역할)으로 떨어진다.
    for (const role of ["ink", "ink-muted", "icon", "agent", "warn", "danger", "primary"]) {
      const found = new RegExp(`--${role}: var\\(--([a-z-]+), var\\(--${role}-base\\)\\);`).exec(scope);
      expect(found, `--${role}`).not.toBeNull();
      expect([role, allowed.has(found![1])]).toEqual([role, true]);
    }
    expect(scope).toMatch(/color: var\(--ink\);/);
    // 연결 막대의 두 상태(warn · danger)는 띠 위에서도 서로 다른 역할이다.
    const warn = /--warn: var\(--([a-z-]+),/.exec(scope)?.[1];
    const danger = /--danger: var\(--([a-z-]+),/.exec(scope)?.[1];
    expect(warn).not.toBe(danger);
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

  it("흰 면 채움 클래스를 든 사이드바 자식은 band-surface 없이도 같은 역할을 되찾는다", () => {
    const fills = rule(".sidebar-drawer :is(.bg-surface, .bg-surface-muted, .bg-surface-raised) {");
    const body = (text: string) =>
      [...text.matchAll(/--([a-z-]+): var\(--\1-base\);/g)].map((m) => m[1]).sort();
    expect(body(fills)).toEqual(body(utility("band-surface")));
    expect(body(fills).length).toBeGreaterThan(0);
  });
});

describe("본문 머리와 컴포저 (시안 `.a-mhd` · `.a-dcomp`)", () => {
  it("머리는 넓은 창에서 60 · 좌 24 우 18이고 제목은 heading 16/700이다", () => {
    const head = utility("channel-head");
    expect(head).toMatch(/min-block-size: 60px;/);
    expect(head).toMatch(/padding-inline: var\(--spacing-6\) 18px;/);
    const title = utility("channel-head-title");
    expect(title).toMatch(/font-size: var\(--text-heading\);/);
    expect(title).toMatch(/font-weight: 700;/);
    expect(CHAT_SHELL).toMatch(/className="channel-head\b/);
  });

  it("넓은 창의 머리는 아래 선 대신 --head-edge 그림자이고, 폰 폭은 예전 경계선이다 (#4591)", () => {
    const head = utility("channel-head");
    const wideAt = head.indexOf("@media (width >= 600px)");
    expect(wideAt).toBeGreaterThan(0);
    const phone = head.slice(0, wideAt);
    const wide = head.slice(wideAt);
    // 폰 폭(바깥 규칙)은 그대로 1px 경계선이다.
    expect(phone).toMatch(/border-block-end: 1px solid var\(--line\);/);
    // 넓은 창: 선 0 + 그림자 토큰 + 형제 위에 그려지는 이름 있는 층(손기입 z-index 금지).
    expect(wide).toMatch(/border-block-end: 0;/);
    expect(wide).toMatch(/box-shadow: var\(--head-edge\);/);
    expect(wide).toMatch(/position: relative;/);
    expect(wide).toMatch(/z-index: var\(--layer-content-float\);/);
    // 고대비에서는 그림자가 경계를 말하지 못하므로 3:1 선이 돌아온다.
    expect(wide).toMatch(
      /@media \(prefers-contrast: more\) \{\s*border-block-end: 1px solid var\(--line-strong\);\s*box-shadow: none;/
    );
  });

  it("--head-edge는 :root 역할 하나다: 두 스킴을 가르고, 고도 어휘(--elevation-*·shadow-*)를 늘리지 않는다 (#4591)", () => {
    const token = /--head-edge:\s*([^;]+);/.exec(TOKENS)?.[1] ?? "";
    expect(token).toMatch(/light-dark\(rgba\([^)]*\), rgba\([^)]*\)\)/);
    // 두 겹이다: 머리 가장자리에 붙는 것 하나, 아래로 번지는 것 하나.
    expect(token.split(/\n/).filter((line) => /light-dark/.test(line))).toHaveLength(2);
    // @theme 밖이다(`--shadow-*`는 @theme 안에서 `shadow-*` 클래스를 만든다). 이름도 고도 어휘가 아니다.
    expect(TOKENS).not.toMatch(/--elevation-head|--shadow-head/);
    const themeAt = TOKENS.indexOf("@theme {");
    expect(TOKENS.indexOf("--head-edge:")).toBeLessThan(themeAt);
    expect(CHAT_SHELL).not.toMatch(/\bshadow-head\b/);
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

describe("데스크탑 셸의 잡기 띠 (#4591)", () => {
  const shell = utility("app-shell");

  it("셸 마커가 판을 상단 줄 아래(둘째 행)로 내리고, 웹의 기본 규칙은 첫 행 그대로다", () => {
    const wideAt = shell.indexOf("@media (width >= 600px) {");
    expect(wideAt).toBeGreaterThan(0);
    const wide = shell.slice(wideAt);
    // 판은 띠(신호등 높이 40) 아래에서 시작한다. 위 여백 0: 띠가 이미 위 간격을 지고, 아래·오른쪽 인셋 8은 기본 규칙이 그대로 진다.
    expect(wide).toMatch(/&\[data-desktop-shell\] > main \{\s*grid-row: 2;\s*margin-block-start: 0;\s*\}/);
    // 웹(마커 없음)은 첫 행까지 올라가 인셋 8이다: 띠가 없다.
    expect(wide).toMatch(/> main \{\s*grid-row: 1 \/ -1;\s*grid-column: 2;\s*margin-block: var\(--spacing-2\);/);
    // 마커 규칙은 기본 규칙 **뒤**에 와야 이긴다(같은 우선순위 뒤쪽이 이긴다).
    expect(wide.indexOf("&[data-desktop-shell] > main")).toBeGreaterThan(
      wide.indexOf("grid-row: 1 / -1;")
    );
    // 마커 규칙은 폰 폭(<600)의 한 행 격자에는 닿지 않는다: 넓은 창 블록 안에만 있다.
    expect(shell.slice(0, wideAt)).not.toMatch(/data-desktop-shell/);
  });

  it("띠는 신호등과 같은 40이고 테두리 없이 토글 중심 20.0 = 띠 가운데다(#4591, 신호등 y 22)", () => {
    const titlebar = utility("app-titlebar");
    expect(titlebar).toMatch(/block-size: var\(--spacing-control-lg\);/);
    expect(TOKENS).toMatch(/--spacing-control-lg: 40px;/);
    expect(titlebar).not.toMatch(/border-block-end|border-bottom/);
    expect(titlebar).toMatch(/grid-column: 1 \/ -1;/);
  });

  it("셸은 마커를 AppShell이 `IS_TAURI`와 설정 표면 여부로 찍는다", () => {
    expect(APP_SHELL).toMatch(/\{\.\.\.desktopShellProps\(IS_TAURI, !isSettingsSurface\)\}/);
    expect(APP_SHELL).toMatch(/import \{ IS_TAURI \} from "@\/lib\/env";/);
  });

  it("오른쪽 자리는 줄의 오른쪽 끝에 서고 비면 폭이 없다(자식이 없으면 flex 항목이 내용 폭이다)", () => {
    const slot = utility("app-titlebar-trailing");
    expect(slot).toMatch(/margin-inline-start: auto;/);
    expect(slot).toMatch(/display: flex;/);
    // 칸 자체에 안쪽 여백을 두지 않는다: 끌기 영역이 아닌 죽은 자리가 생기지 않는다.
    expect(slot).not.toMatch(/padding/);
  });
});

describe("판 바깥은 사이드바와 같은 색이다 (#4591, planner 결정 5 + owner 10-26 우측 UI)", () => {
  const shell = utility("app-shell");
  const wide = shell.slice(shell.indexOf("@media (width >= 600px) {"));

  it("층은 넷이다: 띠 ① · 띠 ② · 바닥 · 배경화면, 크기·위치 목록이 층 수(넷)와 같다", () => {
    expect(wide).toMatch(
      /background-image:\s*var\(--shell-layer-band\), var\(--shell-layer-band\), var\(--shell-layer-canvas\),\s*var\(--shell-layer-wallpaper\);/
    );
    expect(wide).toMatch(
      /background-size:\s*var\(--shell-band-w\) 100%,\s*100% var\(--shell-band-strip\),\s*100% 100%,\s*cover;/
    );
    // 위치가 짧으면 순환해서 배경화면(넷째 층)이 0 0에 선다: 넷을 다 적는다.
    const position = /background-position:([^;]+);/.exec(wide)?.[1] ?? "";
    expect(position.split(",").map((part) => part.trim().replace(/\s+/g, " "))).toEqual([
      "0 0",
      "0 0",
      "0 0",
      "center",
    ]);
  });

  it("기본은 띠 ②의 높이가 0이다: 판이 뜨는 화면에서는 띠 ①이 창 전체라 윗줄이 따로 필요 없다", () => {
    expect(wide).toMatch(/--shell-band-strip: 0px;/);
  });

  it("「내 작업」의 셸에서만 띠 ②가 윗줄 높이(띠와 같은 토큰)다", () => {
    const workRail = wide.slice(wide.indexOf("&[data-work-rail] {"));
    expect(workRail).toMatch(/&\[data-desktop-shell\] \{\s*--shell-band-strip: var\(--spacing-control-lg\);/);
    expect(utility("app-titlebar")).toMatch(/block-size: var\(--spacing-control-lg\);/);
    // 다른 곳에서 윗줄 높이를 켜지 않는다.
    expect([...wide.matchAll(/--shell-band-strip: var\(--spacing-control-lg\)/g)]).toHaveLength(1);
  });

  it("고대비는 띠 두 층만 남긴다(바닥은 평면)", () => {
    expect(wide).toMatch(
      /@media \(prefers-contrast: more\) \{\s*background-image: var\(--shell-layer-band\), var\(--shell-layer-band\);/
    );
  });

  it("설정 전면은 자기 크기 목록을 두지 않는다: 기본(창 전체 띠)이라 판 바깥 여백이 사이드바 열과 같은 색이다", () => {
    const settings = rule("&[data-settings-surface] {");
    expect(settings).not.toMatch(/background-size|--shell-band-w/);
  });

  it("마커 규칙은 판을 둘째 행으로 내릴 뿐 배경을 만지지 않는다", () => {
    expect(wide).toMatch(/&\[data-desktop-shell\] > main \{\s*grid-row: 2;\s*margin-block-start: 0;\s*\}/);
    expect(wide).not.toMatch(/&\[data-desktop-shell\] \{\s*background/);
  });

  it("판 네 모서리는 같은 반경이다(--radius-xl 18): 위·아래·오른쪽 여백이 판 바깥 색 위에서 일정하다", () => {
    const pane = utility("app-pane");
    expect(pane).toMatch(/border-radius: var\(--radius-xl\);/);
    expect(pane).not.toMatch(/border-(top|bottom)-(left|right)-radius/);
    // 오른쪽·아래 인셋은 8로 같다(데스크탑 셸·웹 공통).
    expect(wide).toMatch(/margin-inline: 0 var\(--spacing-2\);/);
    expect(wide).toMatch(/margin-block: var\(--spacing-2\);/);
  });

  it("상단 줄은 셸에서 접힘과 상관없이 띠 위 글자 역할로 묶인다(웹의 접힌 줄은 아니다)", () => {
    const scope = rule(
      ".sidebar-drawer,\n.app-shell:not([data-sidebar-collapsed]) > .app-titlebar,\n.app-shell[data-desktop-shell] > .app-titlebar {"
    );
    expect(scope).toMatch(/--ink: var\(--on-band, var\(--ink-base\)\);/);
  });

  it("유리는 접힌 셸의 상단 줄을 띠 쪽 잉크로 보내고, 웹의 접힌 줄만 바닥 잉크로 둔다", () => {
    expect(GLASS_CSS).toMatch(
      /:root\[data-glass\] \.app-shell\[data-desktop-shell\] > \.app-titlebar \{\s*--ink-muted: var\(--glass-band-ink-muted\);/
    );
    expect(GLASS_CSS).toMatch(
      /:root\[data-glass\] \.app-shell\[data-sidebar-collapsed\]:not\(\[data-desktop-shell\]\) > \.app-titlebar \{\s*--ink-muted: var\(--glass-ink-muted\);/
    );
  });

  it("배경화면은 띠가 있으면 접힌 셸의 상단 줄을 보정하지 않는다(띠가 그 줄을 덮는다)", () => {
    expect(WALLPAPER_CSS).toContain(
      ":root[data-wallpaper-live]:not([data-wallpaper-band]) .app-shell[data-sidebar-collapsed] > .app-titlebar[data-tauri-drag-region]"
    );
    expect(WALLPAPER_CSS).not.toMatch(
      /:root\[data-wallpaper-live\] \.app-shell\[data-sidebar-collapsed\] > \.app-titlebar/
    );
  });

  it("오른쪽 자리는 band-surface를 들지 않는다: 띠 위에 서고, 유리·배경화면 보정을 지우지 않는다", () => {
    expect(read("./AppTitlebar.tsx")).not.toMatch(/app-titlebar-trailing[^"]*band-surface/);
  });

  it("셸 바닥은 배경색 전이를 두지 않는다: 테마가 바뀌면 판 바깥이 같은 프레임에 새 색이다", () => {
    // 셸의 전이는 열 폭(접고 펼침) 하나뿐이다. `background*`를 전이하면 바뀐 직후 옛 색이 남는다.
    const transitions = [...shell.matchAll(/transition:\s*([^;]+);/g)].map((m) => m[1]);
    for (const value of transitions) expect(value).not.toMatch(/background|all\b|--shell-/);
  });
});

describe("전체 화면에서는 신호등 자리 인셋을 접는다 (#4591, planner 결정 4)", () => {
  it("루트 표지가 `--titlebar-inset`을 12(--spacing-3)로 바꾼다", () => {
    const fold = rule(":root[data-window-fullscreen] {");
    expect(fold).toMatch(/--titlebar-inset: var\(--spacing-3\);/);
    expect(TOKENS).toMatch(/--titlebar-inset: 80px;/);
    expect(TOKENS).toMatch(/--spacing-3: 12px;/);
  });

  it("인셋을 읽는 자리는 상단 줄과 온보딩 스텝 줄이고, 둘 다 같은 한 값을 따른다", () => {
    const readers = [...TOKENS.matchAll(/padding-inline-start: var\(--titlebar-inset\);/g)];
    expect(readers).toHaveLength(2);
    expect(utility("app-titlebar")).toMatch(/padding-inline-start: var\(--titlebar-inset\);/);
    expect(utility("onboarding-step-chrome")).toMatch(/padding-inline-start: var\(--titlebar-inset\);/);
  });

  it("표지는 넓은 값(`:root` 선언)보다 우선순위가 높아 순서와 상관없이 이긴다", () => {
    // `:root[…]`(0,2,0) > `:root`(0,1,0). 표지 규칙이 `:root` 블록보다 뒤에 있어야 한다는 가정이 필요 없다.
    expect(TOKENS.indexOf(":root[data-window-fullscreen] {")).toBeGreaterThan(TOKENS.indexOf("--titlebar-inset: 80px;"));
  });
});

describe("툴팁 면은 연회색 알약이다 (#4591)", () => {
  it("중립 칩 그릇(--muted-soft) 한 면이고 선도 그림자도 없다", () => {
    const tooltip = utility("tooltip-surface");
    expect(tooltip).toMatch(/background-color: var\(--muted-soft\);/);
    expect(tooltip).toMatch(/border-radius: var\(--radius-md\);/);
    expect(tooltip).not.toMatch(/\bborder:/);
    expect(tooltip).not.toMatch(/box-shadow/);
  });
});
