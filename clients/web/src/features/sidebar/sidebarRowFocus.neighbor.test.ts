// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { neighborSidebarChannelRowId } from "./sidebarRowFocus";

// 닫은 DM 의 행이 사라진 뒤 캐럿이 갈 이웃 (#3963). 이웃은 지우기 **전에** 잡으므로 이 함수는
// 지울 행이 아직 DOM 에 있을 때의 목록을 읽는다.

let host: HTMLElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
});

function list(rows: Array<{ id?: string; row?: boolean }>): HTMLElement {
  host = document.createElement("div");
  host.innerHTML = rows
    .map(({ id, row = true }) =>
      `<a ${row ? "data-sidebar-row" : ""} ${id ? `data-channel-id="${id}"` : ""} href="#">${id ?? "global"}</a>`
    )
    .join("");
  document.body.append(host);
  return host;
}

describe("neighborSidebarChannelRowId", () => {
  it("다음 행이 먼저다: 지운 자리로 올라오는 행", () => {
    const root = list([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(neighborSidebarChannelRowId(root, "b")).toBe("c");
    expect(neighborSidebarChannelRowId(root, "a")).toBe("b");
  });

  it("마지막 행이면 이전 행이다", () => {
    const root = list([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(neighborSidebarChannelRowId(root, "c")).toBe("b");
  });

  it("혼자면 갈 곳이 없다", () => {
    const root = list([{ id: "only" }]);
    expect(neighborSidebarChannelRowId(root, "only")).toBeNull();
  });

  it("그 행이 없으면 null 이다 — 없는 자리로 밀어 넣으면 그것이 곧 body 다", () => {
    const root = list([{ id: "a" }, { id: "b" }]);
    expect(neighborSidebarChannelRowId(root, "zzz")).toBeNull();
  });

  it("id 대소문자를 접어 같은 행으로 센다", () => {
    const root = list([{ id: "AA-1" }, { id: "BB-2" }]);
    expect(neighborSidebarChannelRowId(root, "aa-1")).toBe("BB-2");
  });

  it("채널 id 가 없는 행(인박스 같은 전역 행)과 정거장이 아닌 앵커는 이웃이 아니다", () => {
    const root = list([
      { row: true },
      { id: "a" },
      { id: "x", row: false },
      { id: "b" },
    ]);
    expect(neighborSidebarChannelRowId(root, "a")).toBe("b");
    expect(neighborSidebarChannelRowId(root, "b")).toBe("a");
  });

  it("선택자에 id 를 이어 붙이지 않는다 — 따옴표가 든 id 도 안전하다", () => {
    host = document.createElement("div");
    const a = document.createElement("a");
    a.setAttribute("data-sidebar-row", "");
    a.setAttribute("data-channel-id", 'x"] , [data-evil');
    const b = document.createElement("a");
    b.setAttribute("data-sidebar-row", "");
    b.setAttribute("data-channel-id", "ok");
    host.append(a, b);
    document.body.append(host);
    expect(neighborSidebarChannelRowId(host, 'x"] , [data-evil')).toBe("ok");
  });
});
