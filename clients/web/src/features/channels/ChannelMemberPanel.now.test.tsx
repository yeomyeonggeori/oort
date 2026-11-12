// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type AgentRunProgress, type RosterMember } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";

// =============================================================================
// 채널 멤버 패널의 「지금」 (#5686) — jsdom 판. 줄의 위치·높이는 `channelMemberPanel.browser.test.ts`가 실제 엔진에서 잰다.
//
//   - 닫혀 있으면 읽지 않는다(「지금 실행 중」 0번, 생존 0번). 열면 「지금 실행 중」 1번 + 생존은 에이전트 수만큼
//   - 묶음 차례와 머리의 수, 에이전트 줄(단계 + 「에이전트 보고」, 요청 한 줄, 분 단위 경과), 사람 줄(상태 글·자리 비움)
//   - 다른 채널의 run은 글자 하나도 나오지 않는다
//   - 열려 있는 동안 run이 끝나도 묶음이 그대로(글만 바뀜), 닫고 다시 열면 옮겨 간다. 창이 가려지는 순간에도 옮긴다
//   - 레일 신호는 간격(5초) 안에서 한 번으로 모아 다시 읽는다. 「지금」 읽기 실패는 발치 한 줄, 서버에 없으면 말하지 않는다
// =============================================================================

const api = vi.hoisted(() => ({
  fetchAllActiveAgentRuns: vi.fn(),
  fetchAgentLiveness: vi.fn(),
  fetchRoster: vi.fn(),
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, ...api };
});

import { markAgentWorking, resetAgentWorking } from "@/features/agents/agentWorkingSignal";
import { signalFromProgress } from "@momo/core/features/agents/runPhase";
import { ChannelMemberPanel } from "./ChannelContextControls";
import { activeAgentRunsQueryKey, RAIL_REFETCH_GAP_MS } from "./useChannelMemberNow";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const OTHER_CH = "00000000-0000-7000-8000-000000000202";
const ME = "00000000-0000-7000-8000-000000000101";
const SEOYEON = "00000000-0000-7000-8000-000000000102";
const JUNHO = "00000000-0000-7000-8000-000000000103";
const YUNA = "00000000-0000-7000-8000-000000000104";
const DALMURI = "00000000-0000-7000-8000-000000000301";
const SAEBYEOK = "00000000-0000-7000-8000-000000000302";
const BYEOLBIT = "00000000-0000-7000-8000-000000000303";
const MIN = 60_000;

function member(id: string, kind: "human" | "agent", name: string, handle: string, over: Partial<RosterMember> = {}): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind,
    status: "active",
    displayName: name,
    handle,
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    ...over,
  } as RosterMember;
}

const MEMBERS: RosterMember[] = [
  member(ME, "human", "김도현", "dohyun", { role: "owner", online: true }),
  member(SEOYEON, "human", "박서연", "seoyeon", { online: true, statusEmoji: "📅", statusText: "회의 중" }),
  member(JUNHO, "human", "이준호", "junho", { online: true, presenceStatus: "away" }),
  member(YUNA, "human", "최유나", "yuna", { online: false }),
  member(DALMURI, "agent", "달무리봇", "dalmuri"),
  member(SAEBYEOK, "agent", "새벽봇", "saebyeok"),
  member(BYEOLBIT, "agent", "별빛봇", "byeolbit"),
];

let seq = 0;
function run(over: Partial<AgentRunProgress> = {}): AgentRunProgress {
  seq += 1;
  const now = Date.now();
  return {
    id: `0199aa11-2222-7000-8000-${String(seq).padStart(12, "0")}`,
    channelId: CH,
    agentMemberId: DALMURI,
    status: "running",
    phase: "running",
    leaseState: "live",
    stepCount: 1,
    ahead: [],
    triggerMessageId: "0199aa11-2222-7000-8000-0000000000c1",
    triggerSummary: "@달무리봇 분기 회고 정리해 줘",
    startedAtMs: now - 4 * MIN - 10_000,
    latestStage: "설계 문서 읽는 중",
    createdAtMs: now - 5 * MIN,
    updatedAtMs: now - MIN,
    ...over,
  };
}

function defaultRuns(): AgentRunProgress[] {
  return [
    run(),
    // 단계를 못 알리는 에이전트(gateway): 요청 한 줄로
    run({
      agentMemberId: SAEBYEOK,
      latestStage: undefined,
      triggerMessageId: undefined,
      triggerSummary: "배포 준비 체크리스트",
      startedAtMs: Date.now() - 2 * MIN - 5_000,
    }),
    // 다른 채널의 일: 패널 어디에도 나오면 안 된다
    run({ channelId: OTHER_CH, agentMemberId: BYEOLBIT, latestStage: "비공개 채널의 일" }),
  ];
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient;
let korean: AppLocale;

function session(): SessionContextValue {
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "김도현", handle: "dohyun" },
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function waitFor(check: () => boolean, timeoutMs = 4_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
}

async function mount(members: RosterMember[] = MEMBERS) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          LocaleProvider,
          { locale: korean, children: 
          createElement(
            SessionProvider,
            { value: session() },
            createElement(ChannelMemberPanel, {
              channelId: CH,
              channelName: "design-lab",
              members,
              status: "ready",
              offline: false,
              onRetry: () => undefined,
              onAddMember: () => undefined,
            })
          ) }
        )
      )
    );
  });
  await settle();
}

async function open() {
  const trigger = document.querySelector<HTMLButtonElement>('[data-testid="channel-member-count"]')!;
  await act(async () => {
    trigger.click();
  });
  await settle();
}

async function close() {
  const button = document.querySelector<HTMLButtonElement>('[data-testid="channel-member-close"]')!;
  await act(async () => {
    button.click();
  });
  await settle();
}

const panel = () => document.querySelector<HTMLElement>('[data-testid="channel-member-panel"]');
const rowOf = (id: string) =>
  document.querySelector<HTMLElement>(`[data-testid="channel-member-item"][data-member-id="${id}"]`);
const sections = () =>
  [...document.querySelectorAll<HTMLElement>('[data-testid="channel-member-section"]')].map((section) => ({
    group: section.dataset.group,
    heading: section.querySelector("h2")?.textContent,
    ids: [...section.querySelectorAll<HTMLElement>('[data-testid="channel-member-item"]')].map((row) => row.dataset.memberId),
  }));

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  korean = await koreanLocaleForTest();
});

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchRoster.mockResolvedValue(MEMBERS);
  api.fetchAllActiveAgentRuns.mockImplementation(async () => ({ runs: defaultRuns(), truncated: false, pages: 1 }));
  api.fetchAgentLiveness.mockImplementation(async (_ws: string, agentId: string) => {
    if (agentId.toLowerCase() === SAEBYEOK) throw new ApiError(404, "not hosted");
    return { agentMemberId: agentId, state: "alive_idle", lastSignalAtMs: Date.now() - 2 * MIN };
  });
  resetAgentWorking();
});

afterEach(() => {
  vi.useRealTimers();
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  resetAgentWorking();
});

describe("채널 멤버 패널의 「지금」 (#5686)", () => {
  it("닫혀 있으면 읽지 않고, 열면 「지금 실행 중」 한 번 + 생존은 에이전트 수만큼", async () => {
    await mount();
    expect(panel()).toBeNull();
    expect(api.fetchAllActiveAgentRuns).toHaveBeenCalledTimes(0);
    expect(api.fetchAgentLiveness).toHaveBeenCalledTimes(0);

    await open();
    expect(panel()).not.toBeNull();
    expect(api.fetchAllActiveAgentRuns).toHaveBeenCalledTimes(1);
    expect(api.fetchAgentLiveness).toHaveBeenCalledTimes(3);

    await close();
    const after = api.fetchAllActiveAgentRuns.mock.calls.length;
    await settle();
    expect(api.fetchAllActiveAgentRuns).toHaveBeenCalledTimes(after);
  });

  it("묶음 차례·머리의 수, 에이전트와 사람의 한 줄", async () => {
    await mount();
    await open();
    expect(sections()).toEqual([
      { group: "working", heading: "일하는 에이전트 2", ids: [DALMURI, SAEBYEOK] },
      { group: "agents", heading: "그 밖의 에이전트 1", ids: [BYEOLBIT] },
      { group: "online", heading: "온라인 3", ids: [ME, SEOYEON, JUNHO] },
      { group: "offline", heading: "오프라인 1", ids: [YUNA] },
    ]);

    const dalmuri = rowOf(DALMURI)!;
    expect(dalmuri.querySelector('[data-testid="channel-member-now"]')?.textContent).toBe(
      "작업 중·설계 문서 읽는 중에이전트 보고·4분째"
    );
    expect(dalmuri.querySelector('[data-testid="channel-member-agent-report"]')?.textContent).toBe("에이전트 보고");
    expect(dalmuri.querySelector(".sr-only")?.textContent).toBe(
      "달무리봇, 에이전트, 작업 중, 설계 문서 읽는 중 (에이전트 보고), 4분째"
    );

    const saebyeok = rowOf(SAEBYEOK)!;
    expect(saebyeok.querySelector('[data-testid="channel-member-request"]')?.textContent).toBe("「배포 준비 체크리스트」");
    expect(saebyeok.querySelector('[data-testid="channel-member-agent-report"]')).toBeNull();
    expect(saebyeok.querySelector(".sr-only")?.textContent).toBe(
      "새벽봇, 에이전트, 작업 중, 요청: 배포 준비 체크리스트, 2분째"
    );

    // 이 채널에 run이 없는 에이전트는 생존 낱말
    const byeolbit = rowOf(BYEOLBIT)!;
    expect(byeolbit.querySelector('[data-testid="channel-member-now"]')?.getAttribute("data-now")).toBe("liveness");

    // 사람: 상태 글, 자리 비움은 낱말로, 온라인·오프라인은 머리가 말한다(점의 낱말과 같은 「온라인」「오프라인」)
    expect(rowOf(SEOYEON)!.querySelector('[data-testid="custom-status-text"]')?.textContent).toBe("회의 중");
    expect(rowOf(JUNHO)!.querySelector('[data-testid="channel-member-now"]')?.textContent).toBe("자리 비움");
    expect(rowOf(YUNA)!.querySelector('[data-testid="channel-member-now"]')?.getAttribute("data-now")).toBe("none");
    expect(rowOf(YUNA)!.querySelector(".sr-only")?.textContent).toBe("최유나, 오프라인");
  });

  it("다른 채널의 run은 제목도 수도 나오지 않는다", async () => {
    await mount();
    await open();
    const text = panel()!.textContent ?? "";
    expect(text).not.toContain("비공개 채널의 일");
    // 별빛봇은 다른 채널에서 일하지만 이 패널에서는 일하지 않는 에이전트다
    expect(rowOf(BYEOLBIT)!.dataset.memberGroup).toBe("agents");
    expect(rowOf(BYEOLBIT)!.querySelector('[data-testid="channel-member-more"]')).toBeNull();
  });

  it("열려 있는 동안 run이 끝나도 묶음은 그대로(글만 바뀜), 닫고 다시 열면 옮겨 간다", async () => {
    await mount();
    await open();
    expect(rowOf(DALMURI)!.dataset.memberGroup).toBe("working");

    // 달무리봇의 run이 끝났다는 다음 읽기
    await act(async () => {
      client.setQueryData(activeAgentRunsQueryKey(WS), { runs: defaultRuns().slice(1) });
    });
    await settle();
    expect(rowOf(DALMURI)!.dataset.memberGroup).toBe("working");
    expect(rowOf(DALMURI)!.querySelector('[data-testid="channel-member-now"]')?.getAttribute("data-now")).toBe("liveness");
    expect(sections()[0]).toMatchObject({ group: "working", ids: [DALMURI, SAEBYEOK] });

    await close();
    api.fetchAllActiveAgentRuns.mockImplementation(async () => ({ runs: defaultRuns().slice(1), truncated: false, pages: 1 }));
    await open();
    expect(sections().map((s) => [s.group, s.ids])).toEqual([
      ["working", [SAEBYEOK]],
      ["agents", [DALMURI, BYEOLBIT]],
      ["online", [ME, SEOYEON, JUNHO]],
      ["offline", [YUNA]],
    ]);
  });

  it("열려 있는 동안 접속이 바뀌어도 사람 묶음은 그대로다", async () => {
    await mount();
    await open();
    const moved = MEMBERS.map((m) => (m.id === YUNA ? { ...m, online: true } : m.id === SEOYEON ? { ...m, online: false } : m));
    await act(async () => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            LocaleProvider,
            { locale: korean, children: 
            createElement(
              SessionProvider,
              { value: session() },
              createElement(ChannelMemberPanel, {
                channelId: CH,
                channelName: "design-lab",
                members: moved,
                status: "ready",
                offline: false,
                onRetry: () => undefined,
                onAddMember: () => undefined,
              })
            ) }
          )
        )
      );
    });
    await settle();
    expect(rowOf(YUNA)!.dataset.memberGroup).toBe("offline");
    expect(rowOf(SEOYEON)!.dataset.memberGroup).toBe("online");
    // 점은 지금 사실을 말한다(글·점은 고쳐 그리고 묶음만 얼어 있다)
    expect(rowOf(YUNA)!.querySelector('[data-testid="avatar-with-presence"]')?.getAttribute("data-presence-tone")).toBe("ok");
  });

  it("보는 사람이 없는 순간(창이 가려짐)에는 묶음을 다시 정한다", async () => {
    await mount();
    await open();
    await act(async () => {
      client.setQueryData(activeAgentRunsQueryKey(WS), { runs: defaultRuns().slice(1) });
    });
    await settle();
    expect(rowOf(DALMURI)!.dataset.memberGroup).toBe("working");
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    visibility.mockRestore();
    expect(rowOf(DALMURI)!.dataset.memberGroup).toBe("agents");
  });

  it("레일 신호는 간격 안에서 한 번으로 모아 다시 읽는다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mount();
    await open();
    expect(api.fetchAllActiveAgentRuns).toHaveBeenCalledTimes(1);
    const signal = (stage: string) =>
      signalFromProgress({ ...defaultRuns()[0]!, latestStage: stage })!;
    // 열자마자 온 신호 셋: 간격이 끝날 때 한 번
    for (const stage of ["단계 1", "단계 2", "단계 3"]) {
      await act(async () => markAgentWorking(signal(stage)));
    }
    await settle();
    expect(api.fetchAllActiveAgentRuns).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RAIL_REFETCH_GAP_MS + 100);
    });
    await settle();
    expect(api.fetchAllActiveAgentRuns).toHaveBeenCalledTimes(2);
    // 다른 채널의 신호는 읽기를 부르지 않는다
    await act(async () =>
      markAgentWorking({ ...signal("다른 채널"), channelId: OTHER_CH })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RAIL_REFETCH_GAP_MS + 100);
    });
    await settle();
    expect(api.fetchAllActiveAgentRuns).toHaveBeenCalledTimes(2);
  });

  it("「지금」 읽기가 실패하면 발치에 한 줄과 다시 불러오기, 서버에 없는 읽기면 아무 말도 없다", async () => {
    api.fetchAllActiveAgentRuns.mockRejectedValue(new ApiError(503, "unavailable"));
    await mount();
    await open();
    // 5xx는 한 번 다시 묻는다(1초 뒤). 그 뒤 실패를 말한다.
    await waitFor(() => document.querySelector('[data-testid="channel-member-now-failed"]') !== null);
    const failed = document.querySelector('[data-testid="channel-member-now-failed"]');
    expect(failed?.textContent).toContain("에이전트가 지금 하는 일을 불러오지 못했어요.");
    // 무엇을 하는지 모르면 일하는 묶음을 세우지 않는다
    expect(sections().map((s) => s.group)).toEqual(["agents", "online", "offline"]);
    expect(sections()[0]!.heading).toBe("에이전트 3");
    api.fetchAllActiveAgentRuns.mockImplementation(async () => ({ runs: defaultRuns(), truncated: false, pages: 1 }));
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="channel-member-now-retry"]')!.click();
    });
    await settle();
    expect(document.querySelector('[data-testid="channel-member-now-failed"]')).toBeNull();
    await close();

    client.clear();
    api.fetchAllActiveAgentRuns.mockRejectedValue(new ApiError(404, "no route"));
    await open();
    expect(document.querySelector('[data-testid="channel-member-now-failed"]')).toBeNull();
    expect(sections().map((s) => s.group)).toEqual(["agents", "online", "offline"]);
  });
});
