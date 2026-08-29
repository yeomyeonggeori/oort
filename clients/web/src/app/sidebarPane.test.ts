import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isSidebarTreeInert,
  sidebarPaneToggleCopy,
  titlebarDragProps,
} from "./sidebarPane";

const tokensCss = readFileSync(
  fileURLToPath(new URL("../design/tokens.css", import.meta.url)),
  "utf8"
);
const sidebarSource = readFileSync(
  fileURLToPath(new URL("../features/sidebar/Sidebar.tsx", import.meta.url)),
  "utf8"
);
const railSource = readFileSync(
  fileURLToPath(new URL("../features/sidebar/WorkspaceRail.tsx", import.meta.url)),
  "utf8"
);
const titlebarSource = readFileSync(
  fileURLToPath(new URL("./AppTitlebar.tsx", import.meta.url)),
  "utf8"
);

describe("sidebarPaneToggleCopy", () => {
  it("펼침에서 aria-expanded 참과 접기 라벨을 준다", () => {
    expect(sidebarPaneToggleCopy(false)).toEqual({
      label: "탐색 패널 접기",
      expanded: true,
    });
  });

  it("접힘에서 aria-expanded 거짓과 열기 라벨을 준다", () => {
    expect(sidebarPaneToggleCopy(true)).toEqual({
      label: "탐색 패널 열기",
      expanded: false,
    });
  });
});

describe("isSidebarTreeInert", () => {
  it("데스크톱 접힘이면 트리가 inert다", () => {
    expect(
      isSidebarTreeInert({
        asDrawer: false,
        drawerOpen: false,
        collapsed: true,
      })
    ).toBe(true);
  });

  it("데스크톱 펼침이면 트리가 살아 있다", () => {
    expect(
      isSidebarTreeInert({
        asDrawer: false,
        drawerOpen: false,
        collapsed: false,
      })
    ).toBe(false);
  });

  it("닫힌 폰 서랍은 inert이고 열린 서랍은 아니다", () => {
    expect(
      isSidebarTreeInert({
        asDrawer: true,
        drawerOpen: false,
        collapsed: true,
      })
    ).toBe(true);
    expect(
      isSidebarTreeInert({
        asDrawer: true,
        drawerOpen: true,
        collapsed: true,
      })
    ).toBe(false);
  });
});

describe("titlebarDragProps", () => {
  it("웹에서는 드래그 속성을 붙이지 않는다", () => {
    expect(titlebarDragProps(false)).toEqual({});
  });

  it("Tauri에서만 줄에 드래그 영역을 연다", () => {
    expect(titlebarDragProps(true)).toEqual({ "data-tauri-drag-region": "" });
  });
});

describe("접힘 계약 (#1864)", () => {
  it("상단 줄 토글이 PanelLeft이고 사이드바 안 접기 입구는 없다", () => {
    expect(titlebarSource).toContain("PanelLeft");
    expect(titlebarSource).toContain('data-testid="sidebar-toggle"');
    expect(titlebarSource).toContain('data-testid="app-titlebar"');
    expect(titlebarSource).toContain("titlebarDragProps(IS_TAURI)");
    expect(sidebarSource).not.toContain("PanelLeftClose");
    expect(sidebarSource).not.toContain("sidebar-collapse");
    expect(sidebarSource).toContain('data-testid="open-quick-switcher"');
    expect(sidebarSource).toContain('testId="channel-item"');
    expect(sidebarSource).toContain("ProfileCard");
    expect(railSource).not.toContain("sidebar-expand");
    expect(railSource).not.toContain("PanelLeftOpen");
  });

  it("접힘 폭은 0이고 reduced-motion은 즉시 전환한다", () => {
    const shellBlock = tokensCss.slice(tokensCss.indexOf("@utility app-shell"));
    expect(tokensCss).toContain("--duration-sidebar: 200ms;");
    expect(shellBlock).toContain(
      "transition: grid-template-columns var(--duration-sidebar) ease-out"
    );
    expect(shellBlock).toContain("grid-template-columns: 0px 1fr;");
    expect(shellBlock).toContain(
      "@media (prefers-reduced-motion: reduce)"
    );
    expect(shellBlock).toContain("transition: none;");
  });
});
