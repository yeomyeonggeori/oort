// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// `/work` 한 라우트를 「내 작업」·「팀 작업」·작업 콘솔이 나눠 쓴다(#2854). 이 시험은
// 어느 주소가 어느 화면에 떨어지는지만 잰다. 격자·콘솔의 몸은 각자의 시험이 잰다.

const shell = { desktop: false };
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  isDesktop: () => shell.desktop,
}));
vi.mock("@/features/workbench/agent/ConnectedTerminalDock", () => ({
  ConnectedTerminalDock: ({ presentation }: { presentation?: string }) =>
    createElement("div", { "data-testid": "dock-stub", "data-presentation": presentation ?? "dock" }),
}));
vi.mock("@/features/capabilities/SurfaceGate", () => ({
  SurfaceRoute: ({ surface, children }: { surface: string; children: unknown }) =>
    createElement("div", { "data-testid": "surface-route-stub", "data-surface": surface }, children as never),
}));
vi.mock("@/features/workConsole/WorkConsoleRoute", () => ({
  WorkConsoleRoute: () => createElement("div", { "data-testid": "work-console-stub" }),
}));
vi.mock("@/app/SidebarDrawerToggle", () => ({ SidebarDrawerToggle: () => null }));

const { WorkRoute } = await import("./WorkRoute");

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
const seen: { search: string } = { search: "" };

function LocationProbe() {
  seen.search = useLocation().search;
  return null;
}

async function mount(entry: string): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      createElement(
        MemoryRouter,
        { initialEntries: [entry] },
        createElement(LocationProbe),
        createElement(Routes, null, createElement(Route, { path: "/work", element: createElement(WorkRoute) }), createElement(Route, { path: "/", element: createElement("div", { "data-testid": "home" }) }))
      )
    );
  });
  return host;
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  shell.desktop = false;
});

describe("/work 보기 (#2854)", () => {
  it("데스크탑 /work는 「내 작업」 격자(도크를 탭으로 그린다)", async () => {
    shell.desktop = true;
    const el = await mount("/work");
    expect(el.querySelector('[data-testid="dock-stub"]')?.getAttribute("data-presentation")).toBe("tab");
    expect(el.querySelector('[data-testid="work-console-stub"]')).toBeNull();
  });

  it.each(["/work/", "/Work"])("데스크탑 %s도 격자이고 셸 판정과 같다(검수 #2927 M2)", async (entry) => {
    shell.desktop = true;
    const el = await mount(entry);
    expect(el.querySelector('[data-testid="dock-stub"]')?.getAttribute("data-presentation")).toBe("tab");
    const { isMyWorkTab } = await import("@momo/core/features/workbench/workTab");
    expect(isMyWorkTab(entry, "", true)).toBe(true);
  });

  it("웹 /work는 호스트 판정 뒤의 작업 콘솔 그대로다(로컬 격자가 없다)", async () => {
    const el = await mount("/work");
    expect(el.querySelector('[data-testid="dock-stub"]')).toBeNull();
    expect(el.querySelector('[data-testid="surface-route-stub"]')?.getAttribute("data-surface")).toBe("workConsole");
    expect(el.querySelector('[data-testid="work-console-stub"]')).not.toBeNull();
  });

  it.each([false, true])("?view=team은 어디서나 「팀 작업」 빈 상태다 (desktop=%s)", async (desktop) => {
    shell.desktop = desktop;
    const el = await mount("/work?view=team");
    expect(el.querySelector("h1")?.textContent).toBe("팀 작업");
    expect(el.querySelector('[data-testid="team-work-empty"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="dock-stub"]')).toBeNull();
    // 한 문장 + 한 행동: 채널로 간다.
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="team-work-empty-action"]')!.click();
    });
    expect(el.querySelector('[data-testid="home"]')).not.toBeNull();
  });

  it("데스크탑 세션 링크는 콘솔로 가고 주소에 view=console을 붙인다(목록으로 돌아가도 격자로 새지 않는다)", async () => {
    shell.desktop = true;
    const el = await mount("/work?session=abc");
    expect(el.querySelector('[data-testid="work-console-stub"]')).not.toBeNull();
    expect(new URLSearchParams(seen.search).get("view")).toBe("console");
    expect(new URLSearchParams(seen.search).get("session")).toBe("abc");
  });

  it("웹 세션 링크는 주소를 건드리지 않는다", async () => {
    await mount("/work?session=abc");
    expect(seen.search).toBe("?session=abc");
  });
});
