// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { isSidebarRoveKey, roveSidebarRows } from "./sidebarRoving";

// =============================================================================
// design-review #1937 B-1. 이 파일이 재는 것은 **경계**다: 행이 연 컨텍스트
// 메뉴는 `document.body` 로 포털되지만 React 트리로는 사이드바의 자손이라, 그
// 안에서 누른 ↓ 가 이 순회까지 올라왔다. 규칙 자체(감기·방향)도 함께 잠근다.
// =============================================================================

let host: HTMLElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
});

function mountRows(count: number): { root: HTMLElement; rows: HTMLElement[] } {
  host = document.createElement("div");
  document.body.append(host);
  const root = document.createElement("div");
  host.append(root);
  const rows: HTMLElement[] = [];
  for (let index = 0; index < count; index += 1) {
    const row = document.createElement("a");
    row.setAttribute("data-sidebar-row", "");
    row.setAttribute("href", `/c/${index}`);
    row.tabIndex = 0;
    root.append(row);
    rows.push(row);
  }
  return { root, rows };
}

function press(
  root: HTMLElement,
  key: string,
  target: EventTarget | null
): { handled: boolean; prevented: boolean } {
  let prevented = false;
  const handled = roveSidebarRows(root, {
    key,
    target,
    preventDefault: () => {
      prevented = true;
    },
  });
  return { handled, prevented };
}

describe("isSidebarRoveKey", () => {
  it("↑/↓ 만 이 순회의 것이다", () => {
    expect(isSidebarRoveKey("ArrowDown")).toBe(true);
    expect(isSidebarRoveKey("ArrowUp")).toBe(true);
    expect(isSidebarRoveKey("Enter")).toBe(false);
    expect(isSidebarRoveKey("ArrowRight")).toBe(false);
    expect(isSidebarRoveKey("Tab")).toBe(false);
  });
});

describe("roveSidebarRows — 목록 안에서", () => {
  it("↓ 는 다음 행, ↑ 는 이전 행으로 캐럿을 옮긴다", () => {
    const { root, rows } = mountRows(3);
    rows[0].focus();
    expect(press(root, "ArrowDown", rows[0])).toEqual({
      handled: true,
      prevented: true,
    });
    expect(document.activeElement).toBe(rows[1]);
    press(root, "ArrowUp", rows[1]);
    expect(document.activeElement).toBe(rows[0]);
  });

  it("끝에서 감긴다", () => {
    const { root, rows } = mountRows(3);
    rows[2].focus();
    press(root, "ArrowDown", rows[2]);
    expect(document.activeElement).toBe(rows[0]);
  });

  it("행이 없으면 아무것도 하지 않는다", () => {
    const { root } = mountRows(0);
    expect(press(root, "ArrowDown", root)).toEqual({
      handled: false,
      prevented: false,
    });
  });
});

describe("roveSidebarRows — 경계 (B-1)", () => {
  it("DOM 으로 목록 밖에서 온 키는 이 순회의 것이 아니다", () => {
    // 포털된 메뉴가 바로 이 형상이다: `document.body` 아래에 있고, 캐럿은 그
    // 안의 항목에 있다. 예전 핸들러는 `indexOf(activeElement) === -1` 을
    // 「첫 행」으로 읽어 rows[1] 로 캐럿을 옮겼고, 그 한 번에 메뉴가 닫혔다.
    const { root, rows } = mountRows(3);
    const portal = document.createElement("div");
    portal.setAttribute("role", "menu");
    const item = document.createElement("div");
    item.setAttribute("role", "menuitem");
    item.tabIndex = -1;
    portal.append(item);
    document.body.append(portal);
    try {
      item.focus();
      const result = press(root, "ArrowDown", item);
      expect(result).toEqual({ handled: false, prevented: false });
      // 캐럿이 메뉴 안에 그대로 남는다 — 남의 행으로 튀지 않는다.
      expect(document.activeElement).toBe(item);
      expect(document.activeElement).not.toBe(rows[1]);
    } finally {
      portal.remove();
    }
  });

  it("root 가 없으면 아무것도 하지 않는다", () => {
    expect(
      roveSidebarRows(null, {
        key: "ArrowDown",
        target: document.body,
        preventDefault: () => {
          throw new Error("preventDefault 가 불렸다");
        },
      })
    ).toBe(false);
  });
});
