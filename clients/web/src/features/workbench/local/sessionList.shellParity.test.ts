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
  it("레일 + 목록 = 사이드바 전체 폭이라 본문 왼쪽 가장자리가 같다", () => {
    const sidebarList = px(/--w-sidebar-list:\s*[^;]+;/.exec(TOKENS)![0]);
    const workspaceRail = 56; // --spacing-rail
    expect(WORK_TAB_RAIL_PX + WORK_TAB_SESSION_LIST_PX).toBe(workspaceRail + sidebarList);
    // CSS 폭은 숫자를 적지 않고 같은 식으로 코어 상수와 묶인다.
    expect(TOKENS).toMatch(/--session-list-width:\s*calc\(var\(--w-sidebar\) - var\(--w-work-rail\)\);/);
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
    expect(selected).toMatch(/box-shadow:\s*var\(--elevation-rest\)/);
  });

  it("떠날 때도 열 폭은 곧바로 바뀐다(미끄러지며 사이드바 트리가 다시 짜이지 않는다)", () => {
    expect(APP_SHELL).toMatch(/data-work-rail-exit=/);
    expect(TOKENS).toMatch(/&\[data-work-rail-exit\]\s*\{\s*transition:\s*none;/);
  });
});
