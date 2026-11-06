// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkHost, WorkSession } from "@momo/core/lib/api";
import type { AgentWorkingSignal } from "@momo/core/features/agents/workingSignal";
import { useAdeControl, type AdeControl } from "./useAdeControl";

// =============================================================================
// #5193 — `useAdeControl(clockAlways, sessionsEnabled)`. 새 인자 하나의 계약만 잰다: 꺼져 있으면 세션 반쪽(원장과 호스트
// 목록)을 읽지 않고, 캐시에 남은 옛 세션도 쓰지 않으며, 열린 턴은 그대로 흐른다. 켜져 있으면(기본, 서랍과 요약 줄이
// 쓰는 모양) 지금까지와 같다. 규칙(집계·정렬)은 코어 `adeControl.test.ts`가 잰다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const CHANNEL = "00000000-0000-7000-8000-000000000201";
const OWNER = "00000000-0000-7000-8000-000000000101";

const hoisted = vi.hoisted(() => ({
  sessions: [] as unknown[],
  hosts: [] as unknown[],
  sessionsError: false,
  /** 읽기가 던진 오류 객체(`useQuery().error`). 실패가 아니면 null. */
  sessionsFailure: null as unknown,
  signals: new Map<string, unknown>(),
  useWorkSessions: vi.fn(),
  useWorkHosts: vi.fn(),
}));

vi.mock("@/app/session", () => ({ useSession: () => ({ workspaceId: "w" }) }));
vi.mock("@/features/workspace/useWorkspace", () => ({
  useDirectory: () => ({ directory: {} }),
  memberNameParts: () => ({ name: "김인턴" }),
}));
vi.mock("@/features/work/useWorkSessions", () => ({
  // 쿼리 훅은 인자를 기록하고 늘 데이터를 돌려준다 — 켜지 않았어도 캐시에 옛 데이터가 남아 있는 상황을 흉내 낸다.
  useWorkSessions: (...args: unknown[]) => {
    hoisted.useWorkSessions(...args);
    return { data: hoisted.sessions, isError: hoisted.sessionsError, error: hoisted.sessionsFailure, refetch: vi.fn() };
  },
  useWorkHosts: (...args: unknown[]) => {
    hoisted.useWorkHosts(...args);
    return { data: hoisted.hosts };
  },
}));
vi.mock("@/features/agents/agentWorkingSignal", () => ({
  useAgentWorkingSignals: () => hoisted.signals,
  useTickingNow: () => 1_700_000_100_000,
  isStaleSignal: () => false,
  // 대기 승인이 없으면 신호를 그대로 돌려준다(진짜 함수의 빈 목록 갈래와 같다).
  withApprovalWaits: (all: ReadonlyMap<string, unknown>) => all,
}));
// 승인 대기(#5125, uxui에서 합쳐 옴)는 이 인자와 무관하다 — 진짜 쿼리 경로는 `AdeSummaryLine.approval.test.tsx`가 잰다.
vi.mock("@/features/inbox/useInbox", () => ({ useApprovalWaits: () => [] }));

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let latest: AdeControl | null = null;

const session: WorkSession = {
  id: "00000000-0000-7000-8000-0000000000e1",
  workspaceId: WS,
  channelId: CHANNEL,
  memberId: OWNER,
  hostId: "h1",
  rootMessageId: "root-1",
  tool: "codex",
  label: "작업 하나",
  status: "running",
  observation: "open",
  observerGrantCount: 0,
  remoteAttachAvailable: false,
  remoteDisplayAvailable: false,
  startedAtMs: 1_700_000_000_000,
};
const workHost: WorkHost = {
  id: "h1",
  workspaceId: WS,
  scope: "member",
  ownerMemberId: OWNER,
  type: "workd",
  displayName: "host",
  capabilities: {},
  createdAtMs: 0,
  online: true,
};
const turn: AgentWorkingSignal = {
  memberId: "00000000-0000-7000-8000-0000000000a1",
  channelId: CHANNEL,
  state: "working",
  source: "run",
  runId: "00000000-0000-7000-8000-000000000001",
  headlines: [],
  lastActivityAtMs: 1_700_000_090_000,
};

// 인자를 아예 주지 않는 모양이 기본값(켜짐)을 재는 모양이다. 훅 규칙 때문에 호출마다 컴포넌트를 따로 둔다.
function ProbeDefault() {
  latest = useAdeControl(false);
  return null;
}

function ProbeFlag({ enabled }: { enabled: boolean }) {
  latest = useAdeControl(false, enabled);
  return null;
}

function mount(enabled?: boolean) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(enabled === undefined ? createElement(ProbeDefault) : createElement(ProbeFlag, { enabled }))
  );
}

beforeAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  hoisted.sessions = [session];
  hoisted.hosts = [workHost];
  hoisted.sessionsError = false;
  hoisted.sessionsFailure = null;
  hoisted.signals = new Map([["k", turn]]);
  hoisted.useWorkSessions.mockClear();
  hoisted.useWorkHosts.mockClear();
  latest = null;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
});

const kinds = () => latest?.items.map((item) => item.kind);

describe("useAdeControl: 세션 읽기를 끄는 인자 (#5193)", () => {
  it("기본은 켜져 있다: 원장과 호스트 목록을 읽고 세션과 턴이 한 목록에 선다(서랍과 요약 줄의 모양)", () => {
    mount();
    expect(hoisted.useWorkSessions).toHaveBeenLastCalledWith("w", 20_000, true);
    expect(hoisted.useWorkHosts).toHaveBeenLastCalledWith("w", undefined, true);
    expect(kinds()?.slice().sort()).toEqual(["run", "session"]);
    expect(latest?.counts.working).toBe(2);
  });

  it("꺼 두면 두 쿼리에 꺼졌다고 말한다", () => {
    mount(false);
    expect(hoisted.useWorkSessions).toHaveBeenLastCalledWith("w", 20_000, false);
    expect(hoisted.useWorkHosts).toHaveBeenLastCalledWith("w", undefined, false);
  });

  it("꺼 두면 캐시에 남은 옛 세션을 쓰지 않는다. 열린 턴은 그대로 흐른다", () => {
    mount(false);
    expect(kinds()).toEqual(["run"]);
    expect(latest?.counts).toMatchObject({ working: 1, blocked: 0, total: 1 });
  });

  it("꺼 두면 읽기 실패도 말하지 않는다(읽지 않았으므로 못 읽은 것이 아니다). 오류 객체도 새지 않는다", () => {
    hoisted.sessionsError = true;
    hoisted.sessionsFailure = new Error("old cache failure");
    mount(false);
    expect(latest?.sessionsFailed).toBe(false);
    expect(latest?.sessionsError).toBeNull();
  });

  it("켜 두면 읽기 실패를 그대로 말하고, 그 읽기가 던진 오류 객체를 서랍에 건넨다(원인 분류의 재료, #5279 B)", () => {
    const failure = new Error("sessions read failed");
    hoisted.sessionsError = true;
    hoisted.sessionsFailure = failure;
    mount(true);
    expect(latest?.sessionsFailed).toBe(true);
    expect(latest?.sessionsError).toBe(failure);
  });

  it("읽기가 실패하지 않았으면 오류 객체는 null이다", () => {
    mount(true);
    expect(latest?.sessionsFailed).toBe(false);
    expect(latest?.sessionsError).toBeNull();
  });
});
