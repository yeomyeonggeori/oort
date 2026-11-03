// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import {
  markAgentWorking,
  resetAgentWorking,
  type AgentWorkingSignal,
} from "@/features/agents/agentWorkingSignal";
import { AdeSummaryLine } from "./AdeSummaryLine";

// =============================================================================
// ADE 요약 줄도 승인 원장 덮어쓰기를 지난다 (#5125, #3738 후속).
//
// 서버는 승인에 걸린 run 을 레일 프레임으로 알리지 않는다(중간 프레임은 늘 `running`). 사이드바 채널 알약과 컴포저 활동 줄은 승인 원장으로
// 그것을 「승인 필요」로 덮지만(#3738), 요약 줄은 스토어의 원본 신호를 읽어서 사람의 결정을 기다리는 에이전트도 「실행 중」으로 세었다.
// 이 시험은 **화면에 그려진 숫자**(`data-working`·`data-blocked`·접근 이름)를 잰다: 덮어쓰기 줄이 지워지면 둘 다 붉어진다.
// 원장은 진짜 쿼리 경로(`useApprovalWaits` → `fetchApprovals`)로 들어오고, 목은 그 fetch 하나와 이 줄과 상관없는 작업 세션·명부 읽기뿐이다.
// =============================================================================

const api = vi.hoisted(() => ({ fetchApprovals: vi.fn() }));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, fetchApprovals: api.fetchApprovals };
});

// 이 줄의 세션 반쪽은 이 시험의 관심이 아니다: 세션 원장은 비어 있다.
vi.mock("@/features/work/useWorkSessions", () => ({
  useWorkSessions: () => ({ data: [], isError: false, refetch: () => undefined }),
  useWorkHosts: () => ({ data: [], isError: false }),
}));

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CHANNEL = "00000000-0000-7000-8000-000000000201";
const AGENT = "00000000-0000-7000-8000-000000000301";
const OTHER_AGENT = "00000000-0000-7000-8000-000000000302";

const agentMember = (id: string, name: string): RosterMember =>
  ({
    id,
    workspaceId: WS,
    kind: "agent",
    status: "active",
    displayName: name,
    handle: name,
    channelCount: 1,
    channelIds: [CHANNEL],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  }) as RosterMember;

const directory = makeDirectory([agentMember(AGENT, "달무리봇"), agentMember(OTHER_AGENT, "모래시계봇")]);

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return { ...actual, useDirectory: () => ({ directory, isPending: false, isLoading: false }) };
});

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  resetAgentWorking();
  api.fetchApprovals.mockReset();
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  resetAgentWorking();
});

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "나", handle: "me" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

/** 레일이 말하는 열린 턴: 서버 프레임이 `running` 이라고 한 에이전트. */
function railTurn(memberId: string, over: Partial<AgentWorkingSignal> = {}): AgentWorkingSignal {
  return {
    memberId,
    channelId: CHANNEL,
    state: "working",
    source: "run",
    runId: `run-${memberId.slice(-3)}`,
    startedAtMs: Date.now() - 30_000,
    headlines: ["설계 문서 읽는 중"],
    lastActivityAtMs: Date.now(),
    ...over,
  };
}

function waitingApproval(requestedBy: string, over: Partial<Approval> = {}): Approval {
  return {
    id: `ap-${requestedBy.slice(-3)}`,
    workspaceId: WS,
    runId: `run-${requestedBy.slice(-3)}`,
    channelId: CHANNEL,
    requestedBy,
    actionType: "tool_call",
    status: "pending",
    expiresAtMs: Date.now() + 3_600_000,
    createdAtMs: Date.now(),
    ...over,
  } as Approval;
}

async function mountLine(ledger: Approval[]): Promise<HTMLElement> {
  // 서버처럼 답한다: `status=pending` 쪽은 결정 대기인 행만 돌려준다(결정된 행은 다른 페이지로 간다).
  api.fetchApprovals.mockImplementation(async (_workspaceId: string, status: string) =>
    ledger.filter((approval) => approval.status === status)
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SessionProvider, { value: sessionValue() }, createElement(AdeSummaryLine))
      )
    );
    await Promise.resolve();
  });
  return host;
}

const line = (h: HTMLElement) => h.querySelector<HTMLElement>('[data-testid="ade-summary"]');

/** 원장 응답이 도착해 화면이 다시 그려질 때까지, 한 번에 act 하나씩 흘려 보내며 기다린다(act 밖 갱신 경고 없이). */
const eventually = (check: () => void) =>
  vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    check();
  });

describe("ADE 요약 줄이 승인 원장을 따른다 (#5125)", () => {
  it("사람의 결정을 기다리는 에이전트는 「실행 중」이 아니라 「대기」로 센다 — 승인이 없는 에이전트는 그대로 센다", async () => {
    // 레일은 두 에이전트 모두 일하는 중이라고 말한다. 원장에는 달무리봇의 대기 승인 하나뿐이다.
    markAgentWorking(railTurn(AGENT));
    markAgentWorking(railTurn(OTHER_AGENT));
    const h = await mountLine([waitingApproval(AGENT)]);

    // 원장이 읽혀 덮어쓰기가 서기를 기다린다. 덮이면 달무리봇이 대기가 되어 「실행 1 · 대기 1」이다.
    await eventually(() => {
      expect(line(h)?.getAttribute("data-blocked")).toBe("1");
    });
    expect(line(h)?.getAttribute("data-working")).toBe("1");
    expect(h.querySelector('[data-testid="ade-summary-label"]')?.textContent).toBe(
      "실행 중인 작업 1개 · 대기 1. 작업 목록 열기"
    );
  });

  it("레일이 아무 턴도 모르는데 사람을 기다리는 승인이 있으면 승인이 줄을 세운다 — 기한이 지난 승인은 세우지 않는다", async () => {
    // 모래시계봇의 승인은 기한이 지났다(서버가 정리하기 전의 몇 초): 서버는 아직 `pending` 이라고 답하지만 기다림이 아니다.
    const h = await mountLine([
      waitingApproval(AGENT),
      waitingApproval(OTHER_AGENT, { expiresAtMs: Date.now() - 60_000 }),
    ]);

    await eventually(() => {
      expect(line(h)?.getAttribute("data-blocked")).toBe("1");
    });
    expect(line(h)?.getAttribute("data-working")).toBe("0");
    expect(h.querySelector('[data-testid="ade-summary-label"]')?.textContent).toBe(
      "대기 중인 작업 1개. 작업 목록 열기"
    );
  });
});
