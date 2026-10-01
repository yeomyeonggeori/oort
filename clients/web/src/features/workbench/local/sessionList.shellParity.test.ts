import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WORK_TAB_RAIL_PX,
  WORK_TAB_SESSION_LIST_PX,
} from "@momo/core/features/workbench/workTab";

// #3275: 「내 작업」의 좌측 패널은 앱 셸 사이드바의 말(면 · 반경 · 안쪽 여백 · 머리 높이 ·
// 경계)을 쓰고, 탭을 오가도 본문의 왼쪽 가장자리가 움직이지 않는다. 실제 상자는
// scripts/capture-shell-switch.mjs(Chromium)가 프레임마다 재고, 여기서는 그 값이 되돌아가지
// 못하게 정의를 고정한다(jsdom은 CSS를 계산하지 않는다: 계산값이 아니라 정의 계약이다).
const read = (p: string) => readFileSync(resolve(__dirname, p), "utf8");
const LIST_CSS = read("./sessionList.css");
const TOKENS = read("../../../design/tokens.css");
const SESSION_LIST_TSX = read("./SessionList.tsx");
const APP_SHELL = read("../../../app/AppShell.tsx");

/** `selector { ... }` 한 블록의 본문(첫 일치). */
function block(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} 블록`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
}
const px = (decl: string): number => Number(/(\d+(?:\.\d+)?)px/.exec(decl)?.[1]);

describe("작업 탭 좌측 패널은 사이드바와 같은 말을 쓴다 (#3275)", () => {
  it("레일 + 목록 = 사이드바 전체 폭이라 본문 왼쪽 가장자리가 같다 (#3280: 260 타협 해소)", () => {
    const sidebarList = px(/--w-sidebar-list:\s*[^;]+;/.exec(TOKENS)![0]);
    const rail = px(/--spacing-rail:\s*[^;]+;/.exec(TOKENS)![0]);
    expect(rail).toBe(56);
    expect(sidebarList).toBe(268);
    // 코어 상수는 CSS와 같은 값이다: 레일은 모든 탭에서 한 벌(56), 목록은 사이드바 목록 열(268).
    expect(WORK_TAB_RAIL_PX).toBe(rail);
    expect(WORK_TAB_SESSION_LIST_PX).toBe(sidebarList);
    expect(TOKENS).toMatch(/--session-list-width:\s*var\(--w-sidebar-list\);/);
  });

  it("목록 자신은 면·유리·테두리를 갖지 않는다(사이드바는 창 바닥 위에 녹아 있다)", () => {
    const sl = block(LIST_CSS, ".sl");
    expect(sl).not.toMatch(/background(?:-color)?\s*:/);
    expect(sl).not.toMatch(/backdrop-filter/);
    expect(sl).not.toMatch(/border/);
    expect(LIST_CSS).not.toMatch(/prefers-reduced-transparency/);
  });

  it("안쪽 여백은 사이드바 열의 `sidebar-list` 유틸이 진다", () => {
    expect(SESSION_LIST_TSX).toMatch(/className="sl sidebar-list /);
    // 자식은 좌우 바깥 여백을 또 두지 않는다(두 번 들여쓰면 사이드바와 가장자리가 어긋난다).
    expect(LIST_CSS).not.toMatch(/margin:\s*[^;]*var\(--session-inset\)/);
    expect(LIST_CSS).not.toMatch(/padding:\s*0 var\(--session-inset\)/);
  });

  it("머리 높이는 사이드바 워크스페이스 머리와 같다(위 4 + 34 + 아래 10)", () => {
    const ws = block(TOKENS, "@utility sidebar-ws");
    expect(ws).toMatch(/padding:\s*var\(--spacing-1\) 6px 10px/);
    const logo = px(/inline-size:\s*\d+px/.exec(block(TOKENS, "@utility sidebar-ws-logo"))![0]);
    const hd = block(LIST_CSS, ".sl-hd");
    expect(hd).toMatch(/padding:\s*var\(--spacing-1\) 6px 10px/);
    expect(px(/min-block-size:\s*\d+px/.exec(hd)![0])).toBe(4 + logo + 10);
  });

  it("줄·선택은 사이드바 행의 반경과 선택 문법(흰 면 + rest 그림자)이다", () => {
    expect(TOKENS).toMatch(/--session-radius-row:\s*var\(--radius-md\);/);
    const selected = block(LIST_CSS, '.sl-row[aria-current="true"]');
    expect(selected).toMatch(/background-color:\s*var\(--surface\)/);
    // 다크 선택 줄 대비(#3282 Medium): 사이드바 선택 행과 같은 안쪽 고리 토큰을 읽는다.
    expect(selected).toMatch(/var\(--elevation-rest\),\s*inset 0 0 0 1px var\(--selected-edge\)/);
  });

  it("레일은 탭마다 바뀌지 않는다: 작업 레일 토큰·이탈 전이가 없고, 「내 작업」 열 폭은 접힌 모양과 같다 (#3280)", () => {
    expect(APP_SHELL).not.toMatch(/data-work-rail-exit/);
    expect(TOKENS).not.toMatch(/--w-work-rail|--spacing-work-rail|data-work-rail-exit/);
    const shell = TOKENS.slice(TOKENS.indexOf("@utility app-shell"));
    const collapsed = block(shell, "&[data-sidebar-collapsed]");
    const workTab = block(shell, "&[data-work-rail]");
    expect(collapsed).toMatch(/grid-template-columns:\s*var\(--spacing-rail\) 1fr;/);
    expect(workTab).toMatch(/grid-template-columns:\s*var\(--spacing-rail\) 1fr;/);
  });
});
