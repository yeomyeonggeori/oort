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
// 「작업」 화면의 몸(읽기·필터·서랍·키보드)은 jobs/ 시험이 잰다. 여기서는 주소가 그 화면으로
// 가는지와 어느 필터를 들고 가는지만 잰다.
vi.mock("@/features/workTab/jobs/WorkJobsRoute", async () => {
  const { useLocation } = await import("react-router-dom");
  const { currentWorkFilter } = await import("@/features/workTab/jobs/useWorkJobs");
  return {
    WorkJobsRoute: () =>
      createElement("div", {
        "data-testid": "work-jobs-stub",
        "data-filter": currentWorkFilter(useLocation().search),
      }),
  };
});

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

describe("/work 보기 (#2854 → ADR-0202 D6)", () => {
  it.each([false, true])("/work는 어디서나 결과 중심 「작업」 화면이고 기본 필터는 「내 것」 (desktop=%s)", async (desktop) => {
    shell.desktop = desktop;
    try {
      window.localStorage.removeItem("oort.work.filter");
    } catch {
      // jsdom 저장소가 없으면 기억도 없다.
    }
    const el = await mount("/work");
    const jobs = el.querySelector('[data-testid="work-jobs-stub"]');
    expect(jobs).not.toBeNull();
    expect(jobs?.getAttribute("data-filter")).toBe("mine");
    expect(el.querySelector('[data-testid="dock-stub"]')).toBeNull();
    expect(el.querySelector('[data-testid="work-console-stub"]')).toBeNull();
    const { isMyWorkTab } = await import("@momo/core/features/workbench/workTab");
    expect(isMyWorkTab("/work", "", desktop)).toBe(false);
  });

  it.each([false, true])("옛 팀 링크 ?view=team은 「작업」 + 「팀 전체」로 연다 (desktop=%s)", async (desktop) => {
    shell.desktop = desktop;
    const el = await mount("/work?view=team");
    expect(el.querySelector('[data-testid="work-jobs-stub"]')?.getAttribute("data-filter")).toBe("team");
    expect(el.querySelector('[data-testid="dock-stub"]')).toBeNull();
    expect(el.querySelector('[data-testid="work-console-stub"]')).toBeNull();
  });

  it("옛 ?view=team&card=…(보드 카드 링크)도 「팀 전체」 화면이고 card는 그대로다", async () => {
    const el = await mount("/work?view=team&card=abc");
    expect(el.querySelector('[data-testid="work-jobs-stub"]')?.getAttribute("data-filter")).toBe("team");
    expect(new URLSearchParams(seen.search).get("card")).toBe("abc");
  });

  it("데스크탑 ?view=terminals는 이 기기의 터미널 격자(도크를 탭으로 그린다)", async () => {
    shell.desktop = true;
    const el = await mount("/work?view=terminals");
    expect(el.querySelector('[data-testid="dock-stub"]')?.getAttribute("data-presentation")).toBe("tab");
    expect(el.querySelector('[data-testid="work-jobs-stub"]')).toBeNull();
  });

  it.each(["/work/", "/Work"])("데스크탑 %s?view=terminals도 격자이고 셸 판정과 같다(검수 #2927 M2)", async (entry) => {
    shell.desktop = true;
    const el = await mount(`${entry}?view=terminals`);
    expect(el.querySelector('[data-testid="dock-stub"]')?.getAttribute("data-presentation")).toBe("tab");
    const { isMyWorkTab } = await import("@momo/core/features/workbench/workTab");
    expect(isMyWorkTab(entry, "?view=terminals", true)).toBe(true);
  });

  it("웹 ?view=terminals는 설명 상태: 이유 + 「작업」 링크 (#3334)", async () => {
    const el = await mount("/work?view=terminals");
    expect(el.querySelector('[data-testid="dock-stub"]')).toBeNull();
    const notice = el.querySelector('[data-testid="my-work-web-notice"]');
    expect(notice?.textContent).toContain("이 기기에는 터미널 레인이 없어요");
    expect(
      el.querySelector('[data-testid="my-work-web-notice-team-link"]')?.getAttribute("href")
    ).toBe("/work");
  });

  it("웹 ?view=console은 호스트 판정 뒤의 작업 콘솔이다 (#3334: 콘솔의 새 주소)", async () => {
    const el = await mount("/work?view=console");
    expect(el.querySelector('[data-testid="surface-route-stub"]')?.getAttribute("data-surface")).toBe("workConsole");
    expect(el.querySelector('[data-testid="work-console-stub"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="my-work-web-notice"]')).toBeNull();
  });

  it("데스크탑 세션 링크는 콘솔로 가고 주소에 view=console을 붙인다(목록으로 돌아가도 격자로 새지 않는다)", async () => {
    shell.desktop = true;
    const el = await mount("/work?session=abc");
    expect(el.querySelector('[data-testid="work-console-stub"]')).not.toBeNull();
    expect(new URLSearchParams(seen.search).get("view")).toBe("console");
    expect(new URLSearchParams(seen.search).get("session")).toBe("abc");
  });

  it("웹 세션 링크도 콘솔로 가고 view=console을 붙인다(목록으로 돌아가도 설명 상태로 새지 않는다)", async () => {
    const el = await mount("/work?session=abc");
    expect(el.querySelector('[data-testid="work-console-stub"]')).not.toBeNull();
    expect(new URLSearchParams(seen.search).get("view")).toBe("console");
    expect(new URLSearchParams(seen.search).get("session")).toBe("abc");
  });
});
