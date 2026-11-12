// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalWorkHostStatus } from "@momo/core/features/settings/thisMacHost";
import type { WorkSession } from "@momo/core/lib/api";

// 다시 시작이 기다릴 사실을 모으는 곳(#5661): 이 맥 호스트의 세션만 세고, 다른 워크스페이스에 등록된 데몬·오래된 원장은 모름이다.

const bridge = vi.hoisted(() => ({ status: vi.fn() }));
const ledger = vi.hoisted(() => ({ sessions: [] as unknown[] }));

vi.mock("@/lib/tauri", () => ({
  isDesktop: () => true,
  desktopWorkHost: { status: bridge.status },
}));
vi.mock("@/features/workbench/local/localSessions", () => ({
  localSessions: () => ({
    getSnapshot: () =>
      new Map([
        ["p1", { phase: "exited", exit: { code: 0, signal: null }, signal: null }],
        ["p2", { phase: "running", exit: null, signal: "ready" }],
      ]),
  }),
}));
vi.mock("@/app/session", () => ({ useSession: () => ({ workspaceId: WS }) }));
vi.mock("@/features/work/useWorkSessions", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    useWorkSessions: (workspaceId: string, _ms: number, enabled: boolean) =>
      useQuery({ queryKey: ["ws", workspaceId], queryFn: async () => ledger.sessions, enabled }),
  };
});

import { localWorkVerdict } from "@momo/core/features/workbench/localWork";
import { LEDGER_FRESH_MS, RestartWorkWatch, localWorkSource, resetLocalWorkSourceForTest } from "./localWorkSource";
import { resetUpdateStoreForTest, seedUpdateStateForTest } from "./store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WS = "00000000-0000-7000-8000-000000000001";
const MINE = "00000000-0000-7000-8000-0000000000a1";
const OTHER = "00000000-0000-7000-8000-0000000000b2";

const status = (over: Partial<LocalWorkHostStatus> = {}): LocalWorkHostStatus => ({
  sidecar: true,
  registered: { hostId: MINE.toUpperCase(), workspaceId: WS, ownerMemberId: "m", serverUrl: "https://oort.invalid" },
  running: true,
  heartbeat: null,
  adapters: [],
  workFolder: "/tmp/w",
  displayNameSuggestion: "도현 맥북",
  ...over,
});
const session = (hostId: string, s: WorkSession["status"]) => ({ hostId, status: s }) as unknown as WorkSession;

let root: Root | null = null;

async function watchLedger(): Promise<void> {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => seedUpdateStateForTest({ kind: "installing", update: { version: "0.1.46", currentVersion: "0.1.45", notes: null, publishedAt: null }, downloaded: 0, total: null }));
  await act(async () => {
    root?.render(createElement(QueryClientProvider, { client }, createElement(RestartWorkWatch)));
  });
  // 원장 읽기가 끝나고 그 결과가 효과로 저장소에 건네질 때까지(질의 알림은 다음 칸에 온다) 작은 칸을 넘긴다.
  await localWorkSource.refresh();
  for (let i = 0; i < 40 && localWorkSource.read().hostSessions === null; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

beforeEach(() => {
  resetLocalWorkSourceForTest();
  resetUpdateStoreForTest();
  bridge.status.mockReset();
  ledger.sessions = [];
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
});

describe("다시 시작이 기다릴 이 맥의 작업", () => {
  it("이 맥 호스트에서 도는 세션만 센다(대소문자 무관). 다른 맥의 세션·일시 중지한 세션은 끊기지 않는다", async () => {
    ledger.sessions = [session(MINE, "running"), session(MINE, "idle"), session(OTHER, "running")];
    bridge.status.mockResolvedValue(status());
    await watchLedger();
    await localWorkSource.refresh();
    expect(localWorkVerdict(localWorkSource.read())).toEqual({ kind: "busy", panes: 0, sessions: 1, unknown: false });
    // 데몬이 꺼져 있으면 원장에 남은 세션은 끊길 것이 아니다.
    bridge.status.mockResolvedValue(status({ running: false }));
    await localWorkSource.refresh();
    expect(localWorkVerdict(localWorkSource.read())).toEqual({ kind: "clear" });
  });

  it("모름: 데몬 상태를 못 읽음, 다른 워크스페이스에 등록된 데몬, 원장을 1분 넘게 새로 못 읽음", async () => {
    bridge.status.mockRejectedValue("socket_unavailable");
    await localWorkSource.refresh();
    expect(localWorkVerdict(localWorkSource.read()).kind).toBe("busy");

    bridge.status.mockResolvedValue(status());
    await watchLedger();
    await localWorkSource.refresh();
    expect(localWorkVerdict(localWorkSource.read())).toEqual({ kind: "clear" });

    bridge.status.mockResolvedValue(
      status({ registered: { hostId: MINE, workspaceId: OTHER, ownerMemberId: "m", serverUrl: "https://oort.invalid" } })
    );
    await localWorkSource.refresh();
    expect(localWorkVerdict(localWorkSource.read())).toEqual({ kind: "busy", panes: 0, sessions: 0, unknown: true });

    bridge.status.mockResolvedValue(status());
    await localWorkSource.refresh();
    vi.useFakeTimers({ now: Date.now() + LEDGER_FRESH_MS + 1 });
    expect(localWorkVerdict(localWorkSource.read())).toEqual({ kind: "busy", panes: 0, sessions: 0, unknown: true });
  });
});
