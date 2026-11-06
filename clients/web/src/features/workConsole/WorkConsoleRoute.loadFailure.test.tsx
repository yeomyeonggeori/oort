// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocale } from "@/testing/koLocale";

// =============================================================================
// #5279 B: 작업 콘솔이 세션 목록·호스트 목록을 **처음부터** 못 읽었을 때. 옛 「작업 세션을 불러오지 못했습니다.」 /
// 「실행 위치를 불러오지 못했습니다.」 / 「선택한 작업 세션을 불러오지 못했습니다.」는 이유가 없었다. 이제 같은 자리가 원인(오프라인 / 서버에 닿지 못함 / 그 밖)을
// 말한다. 목록 칸은 상자(다시 시도), 상세 칸은 단추가 「목록으로」라 다시 시도가 아니므로 이유가 다음 행동까지 말한다.
// 읽기 훅만 대역으로 바꾸고 화면은 진짜 `WorkConsoleRoute`다. 실제 브라우저의 같은 장면은 `gates/gate-work-console.mjs`가 잰다.
// =============================================================================

type QueryState = { data: unknown; error: unknown; isPending: boolean; refetch: () => unknown };
const q = vi.hoisted(() => ({
  sessions: {} as QueryState,
  hosts: {} as QueryState,
}));

vi.mock("@/features/work/useWorkSessions", () => ({
  useWorkSessions: () => q.sessions,
  useWorkHosts: () => q.hosts,
  useWorkSessionRail: () => ({ uncovered: [], liveEvents: [], controlFrames: [] }),
}));
vi.mock("@/features/work/WorkSessionDetail", () => ({ WorkSessionDetail: () => null }));
vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => ({ groups: { channels: [], dms: [] }, data: [], error: null }),
    useDirectory: () => ({ directory: makeDirectory([]), data: [], error: null }),
  };
});
vi.mock("@/features/common/useOffline", () => ({ useOffline: () => false }));
vi.mock("@/app/SidebarDrawerToggle", () => ({ SidebarDrawerToggle: () => null }));

import { WorkConsoleRoute } from "./WorkConsoleRoute";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const SESSION = "00000000-0000-7000-8000-0000000000a1";
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let ko: AppLocale;
let onLine: MockInstance<() => boolean>;
const sessionsRefetch = vi.fn();
const hostsRefetch = vi.fn();

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  ko = await koreanLocale();
});
beforeEach(() => {
  sessionsRefetch.mockReset();
  hostsRefetch.mockReset();
  onLine = vi.spyOn(globalThis.navigator, "onLine", "get");
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  onLine.mockRestore();
});

const failed = (error: unknown, refetch: () => unknown): QueryState => ({ data: undefined, error, isPending: false, refetch });
const ready = (refetch: () => unknown): QueryState => ({ data: [], error: null, isPending: false, refetch });

function Where() {
  const location = useLocation();
  return createElement("span", { "data-testid": "where" }, `${location.pathname}${location.search}`);
}

function mount(entry = "/work"): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const session = {
    workspaceId: WS,
    connStatus: "connected",
    session: { member: { id: ME } },
  } as unknown as SessionContextValue;
  act(() => {
    root?.render(
      createElement(
        MemoryRouter,
        { initialEntries: [entry] },
        createElement(
          SessionProvider,
          { value: session },
          createElement(LocaleProvider, { locale: ko, children: [createElement(WorkConsoleRoute, { key: "route" }), createElement(Where, { key: "where" })] })
        )
      )
    );
  });
  return host;
}
const byId = (el: ParentNode, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const causes: [string, () => unknown, boolean, string][] = [
  ["오프라인", () => new NetworkError("unreachable", 15_000), false, "오프라인이에요. 연결되면 다시 불러올 수 있어요."],
  ["서버에 닿지 못함", () => new NetworkError("unreachable", 15_000), true, "서버에 닿지 못했어요."],
  ["그 밖", () => new ApiError(500, "boom", "internal"), true, "문제가 생겼어요."],
];

describe("작업 콘솔: 목록 읽기 실패의 이유 (#5279 B)", () => {
  it("세션 목록을 못 읽으면 원인마다 다른 이유를 말한다. 상태 코드는 없고 다시 시도는 실패한 쪽을 다시 읽는다", () => {
    for (const [name, failure, online, reason] of causes) {
      onLine.mockReturnValue(online);
      q.sessions = failed(failure(), sessionsRefetch);
      q.hosts = ready(hostsRefetch);
      const el = mount();
      const box = byId(el, "work-console-error");
      expect(box?.getAttribute("role"), name).toBe("alert");
      expect(box?.textContent, name).toContain("작업 세션을 불러오지 못했어요");
      expect(byId(box as HTMLElement, "load-failure-reason")?.textContent, name).toBe(reason);
      expect(box?.textContent, name).not.toMatch(/\d{3}/);
      act(() => box?.querySelector("button")?.click());
      expect(sessionsRefetch, name).toHaveBeenCalledTimes(1);
      expect(hostsRefetch, name).not.toHaveBeenCalled();
      sessionsRefetch.mockReset();
      act(() => root?.unmount());
      host?.remove();
    }
  });

  it("호스트 목록만 못 읽으면 제목이 「실행 위치」를 말한다", () => {
    onLine.mockReturnValue(true);
    q.sessions = ready(sessionsRefetch);
    q.hosts = failed(new NetworkError("unreachable", 15_000), hostsRefetch);
    const box = byId(mount(), "work-console-error");
    expect(box?.textContent).toContain("실행 위치를 불러오지 못했어요");
    expect(box?.textContent).not.toContain("작업 세션을 불러오지 못했어요");
    act(() => box?.querySelector("button")?.click());
    expect(hostsRefetch).toHaveBeenCalledTimes(1);
  });

  it("고른 세션 상세 칸은 단추가 「목록으로」이므로 이유가 다음 행동까지 말하고, 누르면 선택이 풀린다", () => {
    for (const [name, failure, online, reason] of [
      ["서버에 닿지 못함", () => new NetworkError("unreachable", 15_000), true, "서버에 닿지 못했어요. 잠시 뒤 다시 시도해 주세요."],
      ["오프라인", () => new NetworkError("unreachable", 15_000), false, "오프라인이에요. 연결되면 다시 불러올 수 있어요."],
    ] as [string, () => unknown, boolean, string][]) {
      onLine.mockReturnValue(online);
      q.sessions = failed(failure(), sessionsRefetch);
      q.hosts = ready(hostsRefetch);
      const el = mount(`/work?session=${SESSION}`);
      const line = byId(el, "work-console-detail-error");
      expect(line?.textContent, name).toContain(`선택한 작업 세션을 불러오지 못했어요. ${reason}`);
      const button = line?.querySelector("button");
      expect(button?.textContent, name).toBe("목록으로");
      expect(byId(el, "where")?.textContent, name).toBe(`/work?session=${SESSION}`);
      act(() => button?.click());
      expect(byId(el, "where")?.textContent, name).toBe("/work");
      act(() => root?.unmount());
      host?.remove();
    }
  });
});
