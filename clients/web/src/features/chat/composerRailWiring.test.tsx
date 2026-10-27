// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentRunProgress,
  type Channel,
  type RosterMember,
} from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { signalFromProgress } from "@momo/core/features/agents/runPhase";
import { SessionProvider, type SessionContextValue } from "@/app/session";

// =============================================================================
// 진짜 `Composer`의 레일 배선 (#4619 A). 레일 줄 자체의 글자는 `ActivityRail.test`가 재고, 여기서는 **컴포저가**
// (1) 에이전트가 있는 채널에 레일 칸을 입력창 카드 위에 미리 잡고 폼 윗 여백을 그 칸이 대신하게 하는가,
// (2) 에이전트가 없는 채널에는 칸도 없는가, (3) 신호 스토어의 열린 턴을 줄로 올리는가, (4) 서버 생존 판정을
// 읽지 않는가(그것은 예외 줄의 몫이다)를 잰다. 가짜인 것은 REST 응답뿐이고 그 밖은 진짜다: 진짜 `Composer`,
// 진짜 신호 스토어, 진짜 쿼리 훅.
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
  fetchApprovals: vi.fn(),
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

function openTurn(over: Partial<AgentRunProgress> = {}) {
  const now = Date.now();
  const signal = signalFromProgress({
    id: RUN,
    channelId: CH,
    agentMemberId: AGENT,
    triggerMessageId: "0199aa11-2222-7000-8000-0000000000c1",
    status: "running",
    phase: "running",
    leaseState: "live",
    stepCount: 0,
    ahead: [],
    startedAtMs: now - 3 * MIN,
    latestStage: "설계 문서 읽는 중",
    createdAtMs: now - 3 * MIN,
    updatedAtMs: now - 3 * MIN,
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
  api.fetchApprovals.mockResolvedValue([]);
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

async function mount(options: { members?: RosterMember[]; dmAgent?: RosterMember | null } = {}): Promise<void> {
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
                directory: makeDirectory(options.members ?? [BOT]),
                channels: CHANNELS,
                channelLabel: "일반",
                recipient: "place",
                dmAgent: options.dmAgent ?? null,
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
const formOf = () => byId("composer-frame")?.closest("form") ?? null;

describe("컴포저의 레일 칸", () => {
  it("에이전트가 있는 채널: 입력창 카드 **위**에 칸이 미리 서고, 폼의 윗 여백은 그 칸이 대신한다", async () => {
    await mount();
    const rail = byId("composer-working");
    expect(rail).not.toBeNull();
    expect(rail?.getAttribute("data-state")).toBe("idle");
    // 카드 바깥, 위: 칸은 카드(`composer-frame`) 안이 아니고 문서 순서에서 앞선다.
    const frame = byId("composer-frame");
    expect(frame?.contains(rail)).toBe(false);
    expect(rail!.compareDocumentPosition(frame!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 칸이 윗 여백을 대신하니 폼은 윗 여백이 없다(칸 24 + 여백 12가 겹쳐 쌓이지 않는다).
    expect(formOf()?.hasAttribute("data-rail")).toBe(true);
    expect(formOf()?.className).toContain("data-rail:pt-0");
  });

  it("에이전트가 없는 채널: 칸도 없고 폼은 예전 그대로다", async () => {
    await mount({ members: [] });
    expect(byId("composer-working")).toBeNull();
    expect(formOf()?.hasAttribute("data-rail")).toBe(false);
  });

  it("에이전트 DM(명부에 채널 소속이 없어도 `dmAgent`가 있으면)은 칸을 미리 잡는다", async () => {
    await mount({ members: [], dmAgent: BOT });
    expect(byId("composer-working")?.getAttribute("data-state")).toBe("idle");
    expect(formOf()?.hasAttribute("data-rail")).toBe(true);
  });

  it("열린 턴이 줄로 오른다: 가져가 쓰는 동안 이름·낱말·최근 단계, 끝나면 줄만 사라지고 칸은 남는다", async () => {
    await mount();
    act(() => markAgentWorking(openTurn()));
    await settle();
    expect(byId("composer-working-text")?.textContent).toBe("달무리봇 · 작업 중 · 설계 문서 읽는 중");
    expect(byId("composer-working")?.getAttribute("data-state")).toBe("active");
    // 줄의 글에는 초 단위 숫자가 없다.
    expect(byId("composer-working")?.textContent).not.toMatch(/\d+\s*초/);

    const { clearAgentWorking } = await import("@/features/agents/agentWorkingSignal");
    act(() => clearAgentWorking(CH, AGENT));
    await settle();
    expect(byId("composer-working-text")).toBeNull();
    expect(byId("composer-working")?.getAttribute("data-state")).toBe("idle");
  });

  it("컴포저는 서버 생존 판정을 읽지 않는다 — 그것은 예외 줄이 유예를 넘긴 run에서만 읽는다", async () => {
    await mount();
    // 유예를 넘은 대기 run: 레일에서는 빠지고, 컴포저는 그 에이전트의 생존을 묻지 않는다.
    act(() =>
      markAgentWorking(
        openTurn({
          status: "queued",
          phase: "queued",
          leaseState: "none",
          startedAtMs: undefined,
          latestStage: undefined,
          queuePosition: 1,
          createdAtMs: Date.now() - 17 * 60 * MIN,
          updatedAtMs: Date.now() - 17 * 60 * MIN,
        })
      )
    );
    await settle();
    expect(byId("composer-working-text")).toBeNull();
    expect(byId("composer-working")?.getAttribute("data-state")).toBe("idle");
    expect(api.fetchAgentLiveness).not.toHaveBeenCalled();
  });
});
