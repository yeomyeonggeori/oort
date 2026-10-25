// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type AgentLiveness,
  type AgentRunProgress,
  type Channel,
  type RosterMember,
} from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { signalFromProgress } from "@momo/core/features/agents/runPhase";
import { SessionProvider, type SessionContextValue } from "@/app/session";

// =============================================================================
// 진짜 `Composer`의 배선 (#4285, ADR-0200 증보 3 E6). 활동 줄 자체의 문구는 `composerUncollectedLine.test`가
// 재고, 여기서는 **컴포저가 생존 판정을 읽어 그 줄에 넘기는가**를 잰다 — 이 배선이 빠지면 줄은 낱말만 바뀌고
// 서버의 경고(「깨웠지만 아직 안 가져감」)도 이유도 영영 서지 않는다. 가짜인 것은 REST 응답뿐이고(생존 판정·
// 채널·명부·예약) 그 밖은 진짜다: 진짜 `Composer`, 진짜 신호 스토어, 진짜 쿼리 훅.
// =============================================================================

const scheduledApi = vi.hoisted(() => ({
  listAllScheduledMessages: vi.fn(),
  createScheduledMessage: vi.fn(),
  updateScheduledMessage: vi.fn(),
  sendScheduledMessageNow: vi.fn(),
  deleteScheduledMessage: vi.fn(),
}));
vi.mock("@momo/core/features/scheduled/api", () => scheduledApi);

const api = vi.hoisted(() => ({
  listChannels: vi.fn(),
  fetchRoster: vi.fn(),
  fetchWorkHosts: vi.fn(),
  fetchAgentLiveness: vi.fn(),
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, ...api };
});

import { OpenAgentProfileContext } from "@/features/routing/useAgentProfile";
import { markAgentWorking, resetAgentWorking } from "@/features/agents/agentWorkingSignal";
import { resetSchedulerDisabledForTest } from "@/features/scheduled/useScheduled";
import { clearDraft } from "@/features/chat/draftStore";
import { Composer } from "./Composer";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const AGENT = "00000000-0000-7000-8000-000000000301";
const RUN = "0199aa11-2222-7000-8000-0000000000b1";
const MIN = 60_000;
const HOUR = 60 * MIN;

const CHANNELS: Channel[] = [{ id: CH, workspaceId: WS, kind: "public", name: "일반", muted: false } as Channel];
const BOT = {
  id: AGENT,
  workspaceId: WS,
  kind: "agent",
  status: "active",
  displayName: "달무리봇",
  handle: "dalmuri-bot",
  channelCount: 1,
  channelIds: [CH],
  capabilities: [],
  createdAtMs: 0,
  updatedAtMs: 0,
} as unknown as RosterMember;

function waitingRun(over: Partial<AgentRunProgress> = {}) {
  const now = Date.now();
  const signal = signalFromProgress({
    id: RUN,
    channelId: CH,
    agentMemberId: AGENT,
    triggerMessageId: "0199aa11-2222-7000-8000-0000000000c1",
    status: "queued",
    phase: "queued",
    leaseState: "none",
    stepCount: 0,
    ahead: [],
    queuePosition: 1,
    createdAtMs: now - 17 * HOUR,
    updatedAtMs: now - 17 * HOUR,
    ...over,
  });
  if (signal === null) throw new Error("signal");
  return signal;
}

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  for (const fn of Object.values(scheduledApi)) fn.mockReset();
  for (const fn of Object.values(api)) fn.mockReset();
  api.listChannels.mockResolvedValue(CHANNELS);
  api.fetchRoster.mockResolvedValue([]);
  api.fetchWorkHosts.mockResolvedValue([]);
  scheduledApi.listAllScheduledMessages.mockResolvedValue([]);
  resetSchedulerDisabledForTest();
  clearDraft(WS, CH);
  resetAgentWorking();
});
afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  resetAgentWorking();
});

function session(): SessionContextValue {
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "정하윤", handle: "hayun" },
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await act(async () => {
    mountedRoot?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          { initialEntries: [`/c/${CH}`] },
          createElement(
            OpenAgentProfileContext.Provider,
            { value: () => undefined },
            createElement(
              SessionProvider,
              { value: session() },
              createElement(Composer, {
                workspaceId: WS,
                channelId: CH,
                directory: makeDirectory([BOT]),
                channels: CHANNELS,
                channelLabel: "일반",
                recipient: "place",
                dmAgent: null,
                quote: null,
                onCancelQuote: () => undefined,
                onSend: () => undefined,
              })
            )
          )
        )
      )
    );
  });
  await settle();
}

const byId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("컴포저가 생존 판정을 읽어 활동 줄에 넘긴다", () => {
  it("아무도 가져가지 않은 요청: 낱말과 경고 문구·이유가 서고, 그 에이전트의 판정을 읽었다", async () => {
    api.fetchAgentLiveness.mockResolvedValue({
      agentMemberId: AGENT,
      state: "woken_not_collected",
      lastSignalAtMs: Date.now() - 3 * HOUR,
    } satisfies AgentLiveness);
    await mount();
    act(() => markAgentWorking(waitingRun()));
    await settle();
    expect(byId("composer-working")?.textContent).toContain("달무리봇: 아직 받지 않았어요");
    expect(byId("composer-working-detail")?.textContent).toBe(
      "깨웠지만 아직 안 가져감 · 17시간째 기다려요 · 연결이 꺼져 있을 수 있어요"
    );
    expect(api.fetchAgentLiveness).toHaveBeenCalledWith(WS, AGENT);
  });

  it("호스티드가 아닌 에이전트(404)는 판정이 없다 — 낱말만 바뀌고 경고 문구·이유는 지어내지 않는다", async () => {
    api.fetchAgentLiveness.mockRejectedValue(new ApiError(404, "not found"));
    await mount();
    act(() => markAgentWorking(waitingRun()));
    await settle();
    expect(byId("composer-working")?.textContent).toContain("달무리봇: 아직 받지 않았어요");
    expect(byId("composer-working-detail")?.textContent).toBe("17시간째 기다려요");
  });

  it("가져간 run과 일하는 run에는 생존 판정을 읽지 않는다 (쿼리를 세우지 않는다)", async () => {
    await mount();
    act(() =>
      markAgentWorking(
        waitingRun({
          phase: "running",
          status: "running",
          leaseState: "live",
          startedAtMs: Date.now() - MIN,
          queuePosition: undefined,
        })
      )
    );
    await settle();
    expect(byId("composer-working")).not.toBeNull();
    expect(api.fetchAgentLiveness).not.toHaveBeenCalled();
  });

  it("시스템 작업(환영)의 에이전트도 읽지 않는다 — 줄은 기존 말이다", async () => {
    await mount();
    act(() => markAgentWorking(waitingRun({ triggerMessageId: undefined, system: true })));
    await settle();
    expect(byId("composer-working")?.textContent).toContain("달무리봇: 대기 1번째");
    expect(api.fetchAgentLiveness).not.toHaveBeenCalled();
  });
});
