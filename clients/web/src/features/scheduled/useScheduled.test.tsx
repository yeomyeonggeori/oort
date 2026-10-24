// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Channel, type RosterMember } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import type { RealtimeHandle } from "@momo/core/lib/realtimeEvents";
import type { ScheduledMessageFrame } from "@momo/core/features/scheduled/events";
import type { ScheduledMessage } from "@momo/core/features/scheduled/types";
import { SessionProvider, type SessionContextValue } from "@/app/session";

const api = vi.hoisted(() => ({
  listAllScheduledMessages: vi.fn(),
  createScheduledMessage: vi.fn(),
  updateScheduledMessage: vi.fn(),
  sendScheduledMessageNow: vi.fn(),
  deleteScheduledMessage: vi.fn(),
}));
vi.mock("@momo/core/features/scheduled/api", () => api);

const workspaceApi = vi.hoisted(() => ({ listChannels: vi.fn(), fetchRoster: vi.fn() }));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, ...workspaceApi };
});

import {
  SCHEDULER_DISABLED_MEMORY_MS,
  applyFrameToCache,
  resetSchedulerDisabledForTest,
  scheduledQueryKey,
  useScheduled,
  useScheduledClock,
  useScheduledPlaces,
  type ScheduledPlaceInfo,
  type ScheduledState,
} from "./useScheduled";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const MATE = "00000000-0000-7000-8000-000000000102";
const CH = "00000000-0000-7000-8000-000000000201";
const DM = "00000000-0000-7000-8000-000000000202";
const ID = "00000000-0000-7000-8000-0000000004a1";
const ID2 = "00000000-0000-7000-8000-0000000004a2";
const SEND_AT = 1_800_000_000_000;

function row(overrides: Partial<ScheduledMessage> = {}): ScheduledMessage {
  return {
    id: ID,
    workspaceId: WS,
    memberId: ME,
    channelId: CH,
    body: "금요일 배포 공지",
    sendAtMs: SEND_AT,
    status: "pending",
    editableUntilMs: SEND_AT - 30_000,
    rev: 0,
    createdAtMs: SEND_AT - 86_400_000,
    updatedAtMs: SEND_AT - 86_400_000,
    ...overrides,
  };
}

function frame(overrides: Partial<ScheduledMessageFrame> = {}): ScheduledMessageFrame {
  return {
    workspaceId: WS.toUpperCase(),
    memberId: ME.toUpperCase(),
    scheduledMessageId: ID.toUpperCase(),
    channelId: CH.toUpperCase(),
    status: "failed",
    failureReason: "sessions_ended",
    sendAtMs: SEND_AT,
    rev: 1,
    ...overrides,
  };
}

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient;
beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  workspaceApi.listChannels.mockReset().mockResolvedValue([]);
  workspaceApi.fetchRoster.mockReset().mockResolvedValue([]);
  api.listAllScheduledMessages.mockResolvedValue([]);
  resetSchedulerDisabledForTest();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
});

/** 개인 채널 구독을 대신한다: 호출부가 건 핸들러를 시험이 쥔다. */
function fakeRealtime() {
  const handlers: Array<{ onEvent: (frame: ScheduledMessageFrame) => void; onResync: () => void }> = [];
  const off = vi.fn();
  const handle = {
    subscribeScheduled: vi.fn((_memberId: string, next: (typeof handlers)[number]) => {
      handlers.push(next);
      return off;
    }),
  } as unknown as RealtimeHandle;
  return { handle, handlers, off };
}

function session(realtime: RealtimeHandle | null): SessionContextValue {
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "박서연", handle: "seoyeon" },
    },
    workspaceId: WS,
    realtime,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

let latest: ScheduledState | null = null;
function Probe() {
  latest = useScheduled();
  return null;
}

async function mount(node: ReactElement = createElement(Probe), realtime: RealtimeHandle | null = null) {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  await act(async () => {
    mountedRoot?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SessionProvider, { value: session(realtime) }, node)
      )
    );
  });
  await settle();
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function state(): ScheduledState {
  if (latest === null) throw new Error("not mounted");
  return latest;
}

describe("reading the list", () => {
  it("reads the open list once and shares it: two consumers, one request", async () => {
    api.listAllScheduledMessages.mockResolvedValue([row(), row({ id: ID2, sendAtMs: SEND_AT + 60_000 })]);
    function Two() {
      useScheduled();
      return createElement(Probe);
    }
    await mount(createElement(Two));
    expect(api.listAllScheduledMessages).toHaveBeenCalledTimes(1);
    expect(api.listAllScheduledMessages).toHaveBeenCalledWith(WS, { status: "open" });
    expect(state().surface).toBe("present");
    expect(state().rows.map((entry) => entry.id)).toEqual([ID, ID2]);
    expect(state().pendingCount).toBe(2);
  });

  it("reads an empty server as present with no rows, so the entry is offered", async () => {
    await mount();
    expect(state().surface).toBe("present");
    expect(state().rows).toEqual([]);
    expect(state().isPending).toBe(false);
  });

  it("calls a server whose first list answers 404 absent, never asks again, and never subscribes", async () => {
    api.listAllScheduledMessages.mockRejectedValue(new ApiError(404, "not found"));
    const rt = fakeRealtime();
    await mount(createElement(Probe), rt.handle);
    expect(state().surface).toBe("absent");
    expect(state().rows).toEqual([]);
    expect(rt.handle.subscribeScheduled).not.toHaveBeenCalled();

    // 창으로 돌아와도 같은 세션에서는 다시 묻지 않는다.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(api.listAllScheduledMessages).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a 503", new ApiError(503, "down")],
    ["a 500", new ApiError(500, "boom")],
    ["a dropped connection", new NetworkError("unreachable", 15_000)],
  ])("calls %s on the first list an outage, not an absent surface: the entry stays", async (_name, error) => {
    api.listAllScheduledMessages.mockRejectedValue(error);
    await mount();
    expect(state().surface).toBe("unknown");
    expect(state().isError).toBe(true);
    expect(state().rows).toEqual([]);
  });

  it("keeps what it already has when a later read fails (the offline list keeps rendering)", async () => {
    api.listAllScheduledMessages.mockResolvedValueOnce([row()]);
    await mount();
    expect(state().rows).toHaveLength(1);
    api.listAllScheduledMessages.mockRejectedValueOnce(new NetworkError("unreachable", 15_000));
    await act(async () => {
      state().refetch();
    });
    await settle();
    expect(state().rows).toHaveLength(1);
    expect(state().isError).toBe(false);
    expect(state().surface).toBe("present");
  });
});

describe("the personal channel (ADR-0208 D12)", () => {
  it("changes the cache the moment a frame arrives, before any re-read, then reads again once", async () => {
    api.listAllScheduledMessages.mockResolvedValue([row()]);
    const rt = fakeRealtime();
    await mount(createElement(Probe), rt.handle);
    expect(rt.handle.subscribeScheduled).toHaveBeenCalledWith(ME, expect.any(Object));
    expect(state().rows[0]?.status).toBe("pending");
    const reads = api.listAllScheduledMessages.mock.calls.length;

    await act(async () => {
      for (const next of rt.handlers) next.onEvent(frame());
    });
    await settle();

    // 재조회가 끝나기 전에 이미 바뀌어 있다.
    expect(state().rows[0]).toMatchObject({ status: "failed", failureReason: "sessions_ended", rev: 1 });
    expect(api.listAllScheduledMessages.mock.calls.length).toBe(reads);

    await vi.waitFor(() => expect(api.listAllScheduledMessages.mock.calls.length).toBe(reads + 1), { timeout: 2000 });
  });

  it("stands up a body-less row for a frame about a row it never read", async () => {
    const rt = fakeRealtime();
    await mount(createElement(Probe), rt.handle);
    await act(async () => {
      for (const next of rt.handlers) next.onEvent(frame({ rev: 3 }));
    });
    await settle();
    expect(state().rows).toHaveLength(1);
    expect(state().rows[0]).toMatchObject({ status: "failed", failureReason: "sessions_ended", id: ID });
    expect(state().rows[0]?.body).toBeUndefined();
  });

  it("ignores a frame of another workspace, and a frame with a rev it already has", async () => {
    api.listAllScheduledMessages.mockResolvedValue([row({ rev: 2 })]);
    const rt = fakeRealtime();
    await mount(createElement(Probe), rt.handle);
    const before = client.getQueryData(scheduledQueryKey(WS));

    expect(applyFrameToCache(client, WS, frame({ workspaceId: "00000000-0000-7000-8000-0000000000ff", rev: 9 }))).toBe(false);
    expect(applyFrameToCache(client, WS, frame({ rev: 2 }))).toBe(false);
    expect(applyFrameToCache(client, WS, frame({ rev: 1 }))).toBe(false);
    // 캐시 객체는 그대로다: 구독자가 다시 그려지지 않는다.
    expect(client.getQueryData(scheduledQueryKey(WS))).toBe(before);
    expect(state().rows[0]?.status).toBe("pending");
  });

  it("asks to read again when the channel resubscribes, and lets go of the subscription on unmount", async () => {
    const rt = fakeRealtime();
    await mount(createElement(Probe), rt.handle);
    const reads = api.listAllScheduledMessages.mock.calls.length;
    await act(async () => {
      for (const next of rt.handlers) next.onResync();
    });
    await vi.waitFor(() => expect(api.listAllScheduledMessages.mock.calls.length).toBe(reads + 1), { timeout: 2000 });
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    expect(rt.off).toHaveBeenCalled();
  });

  it("works without a rail that wires the scheduled subscription (the phone's runtime does not)", async () => {
    await mount(createElement(Probe), {} as RealtimeHandle);
    expect(state().surface).toBe("present");
  });
});

describe("my own writes merge by the same rule", () => {
  it("adds the created row, merges an edit, and forgets a deleted row for good", async () => {
    await mount();
    const created = row({ rev: 0 });
    api.createScheduledMessage.mockResolvedValue(created);
    await act(async () => {
      await state().mutations.create({ channelId: CH, body: "금요일 배포 공지", sendAtMs: SEND_AT, clientRequestId: "r1" });
    });
    await settle();
    expect(state().rows.map((entry) => entry.id)).toEqual([ID]);

    api.updateScheduledMessage.mockResolvedValue(row({ rev: 1, body: "고친 글" }));
    await act(async () => {
      await state().mutations.update(ID, { body: "고친 글" });
    });
    await settle();
    expect(state().rows[0]).toMatchObject({ body: "고친 글", rev: 1 });
    expect(api.updateScheduledMessage).toHaveBeenCalledWith(WS, ID, { body: "고친 글" });

    api.deleteScheduledMessage.mockResolvedValue(undefined);
    await act(async () => {
      await state().mutations.remove(ID);
    });
    await settle();
    expect(state().rows).toEqual([]);
    // 지운 행은 어떤 이벤트도 되살리지 못한다.
    expect(applyFrameToCache(client, WS, frame({ rev: 99, status: "pending" }))).toBe(false);
    expect(state().rows).toEqual([]);
  });

  it("removes a row from the list once send-now answers sent", async () => {
    api.listAllScheduledMessages.mockResolvedValue([row()]);
    await mount();
    api.sendScheduledMessageNow.mockResolvedValue(row({ status: "sent", rev: 2, sentMessageId: "m1", sentAtMs: SEND_AT }));
    await act(async () => {
      await state().mutations.sendNow(ID);
    });
    await settle();
    expect(state().rows).toEqual([]);
  });

  it("reads the list again when send-now is refused, so the row moves to 보내지 못함", async () => {
    api.listAllScheduledMessages.mockResolvedValue([row()]);
    await mount();
    const reads = api.listAllScheduledMessages.mock.calls.length;
    api.sendScheduledMessageNow.mockRejectedValue(new ApiError(409, "refused", "not_member"));
    api.listAllScheduledMessages.mockResolvedValue([row({ status: "failed", failureReason: "not_member", rev: 1, editableUntilMs: undefined })]);
    await act(async () => {
      await state().mutations.sendNow(ID).catch(() => undefined);
    });
    await settle();
    expect(api.listAllScheduledMessages.mock.calls.length).toBeGreaterThan(reads);
    expect(state().rows[0]).toMatchObject({ status: "failed", failureReason: "not_member" });
  });

  it("remembers a disabled scheduler (503 scheduler_disabled) for the session and forgets it after a write succeeds", async () => {
    await mount();
    expect(state().schedulerDisabled).toBe(false);
    api.createScheduledMessage.mockRejectedValueOnce(new ApiError(503, "off", "scheduler_disabled"));
    await act(async () => {
      await state().mutations.create({ channelId: CH, body: "글", sendAtMs: SEND_AT, clientRequestId: "r1" }).catch(() => undefined);
    });
    expect(state().schedulerDisabled).toBe(true);

    // 다른 503(예약을 끈 것이 아니다)은 이 사실을 바꾸지 않는다.
    api.createScheduledMessage.mockRejectedValueOnce(new ApiError(503, "down"));
    await act(async () => {
      await state().mutations.create({ channelId: CH, body: "글", sendAtMs: SEND_AT, clientRequestId: "r2" }).catch(() => undefined);
    });
    expect(state().schedulerDisabled).toBe(true);

    api.createScheduledMessage.mockResolvedValueOnce(row());
    await act(async () => {
      await state().mutations.create({ channelId: CH, body: "글", sendAtMs: SEND_AT, clientRequestId: "r3" });
    });
    expect(state().schedulerDisabled).toBe(false);
  });

  /** 가짜 시계로 마운트한다(`mount()`의 `settle()`은 실제 타이머를 기다려서 가짜 시계에서는 멈춘다). */
  async function mountOnFakeClock() {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);
    host = document.createElement("div");
    document.body.append(host);
    mountedRoot = createRoot(host);
    await act(async () => {
      mountedRoot?.render(
        createElement(QueryClientProvider, { client }, createElement(SessionProvider, { value: session(null) }, createElement(Probe)))
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
  }

  async function refuseWithSchedulerOff(requestId: string) {
    api.createScheduledMessage.mockRejectedValueOnce(new ApiError(503, "off", "scheduler_disabled"));
    await act(async () => {
      await state().mutations.create({ channelId: CH, body: "글", sendAtMs: SEND_AT, clientRequestId: requestId }).catch(() => undefined);
    });
  }

  it("forgets a disabled scheduler after five minutes on its own (a timer re-renders it), so an admin turning it back on is noticed without restarting the app (design-review M4)", async () => {
    expect(SCHEDULER_DISABLED_MEMORY_MS).toBe(5 * 60_000);
    await mountOnFakeClock();
    await refuseWithSchedulerOff("r1");
    expect(state().schedulerDisabled).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCHEDULER_DISABLED_MEMORY_MS - 1_000);
    });
    expect(state().schedulerDisabled).toBe(true);

    // 아무도 이 훅을 다시 그리게 하지 않았는데도 기억이 끝나는 순간 풀린다.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(state().schedulerDisabled).toBe(false);
  });

  it("starts the five minutes again when the same refusal comes back, and a later refusal after forgetting dims it again", async () => {
    await mountOnFakeClock();
    await refuseWithSchedulerOff("a");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    });
    await refuseWithSchedulerOff("b");
    // 처음 거절로부터는 5분이 넘었지만 마지막 거절로부터는 1분 30초다.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(state().schedulerDisabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3.6 * 60_000);
    });
    expect(state().schedulerDisabled).toBe(false);

    // 풀린 뒤의 시도가 같은 503을 받으면 다시 흐려진다(영문을 모르는 막힘이 아니라 이유가 선다).
    await refuseWithSchedulerOff("c");
    expect(state().schedulerDisabled).toBe(true);
  });

  it("does not mark the scheduler disabled for any other refusal", async () => {
    await mount();
    for (const error of [new ApiError(409, "limit", "pending_limit_reached"), new ApiError(400, "bad"), new NetworkError("timeout", 15_000)]) {
      api.createScheduledMessage.mockRejectedValueOnce(error);
      await act(async () => {
        await state().mutations.create({ channelId: CH, body: "글", sendAtMs: SEND_AT, clientRequestId: "r" }).catch(() => undefined);
      });
    }
    expect(state().schedulerDisabled).toBe(false);
  });

  it("re-throws the original error so the caller can choose the sentence", async () => {
    await mount();
    const failure = new ApiError(409, "late", "scheduled_too_late");
    api.updateScheduledMessage.mockRejectedValueOnce(failure);
    await expect(state().mutations.update(ID, { body: "x" })).rejects.toBe(failure);
  });
});

describe("the clock steps at the boundaries (UI spec 0.6)", () => {
  function ClockProbe({ rows, onNow }: { rows: ScheduledMessage[]; onNow: (now: number) => void }) {
    onNow(useScheduledClock(rows));
    return null;
  }

  it("changes exactly once at the edit lock and once at the send time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);
    const sendAt = Date.now() + 90_000;
    const rows = [row({ sendAtMs: sendAt, editableUntilMs: sendAt - 30_000 })];
    const seen: number[] = [];
    host = document.createElement("div");
    document.body.append(host);
    mountedRoot = createRoot(host);
    await act(async () => {
      mountedRoot?.render(createElement(ClockProbe, { rows, onNow: (now: number) => seen.push(now) }));
    });
    const initial = seen[seen.length - 1];
    expect(initial).toBe(Date.now());

    // 잠금 경계(마감 30초 전)는 60초 걸음보다 이르다: 정확히 거기서 한 번 바뀐다.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000 - 1);
    });
    const beforeLock = seen[seen.length - 1];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    const atLock = seen[seen.length - 1] ?? 0;
    expect(atLock).toBeGreaterThanOrEqual(sendAt - 30_000);
    expect(beforeLock).toBeLessThan(sendAt - 30_000);

    // 다음 경계는 보내는 시각이다.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_001);
    });
    expect(seen[seen.length - 1] ?? 0).toBeGreaterThanOrEqual(sendAt);
  });

  it("falls back to a one-minute step when no row has a boundary left", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);
    const seen: number[] = [];
    host = document.createElement("div");
    document.body.append(host);
    mountedRoot = createRoot(host);
    await act(async () => {
      mountedRoot?.render(createElement(ClockProbe, { rows: [], onNow: (now: number) => seen.push(now) }));
    });
    const renders = seen.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000);
    });
    expect(seen.length).toBe(renders);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(seen.length).toBeGreaterThan(renders);
  });
});

describe("the name of a place", () => {
  function member(overrides: Partial<RosterMember> & Pick<RosterMember, "id" | "displayName" | "handle">): RosterMember {
    return {
      workspaceId: WS,
      kind: "human",
      status: "active",
      channelCount: 0,
      channelIds: [],
      capabilities: [],
      createdAtMs: 0,
      updatedAtMs: 0,
      ...overrides,
    };
  }

  it("names a channel by its name, a DM by 「{이름}과의 대화」, and a place it cannot read 「알 수 없는 채널」", async () => {
    const channels: Channel[] = [
      { id: CH, workspaceId: WS, kind: "public", name: "배포", muted: false },
      { id: DM, workspaceId: WS, kind: "dm", muted: false, memberIds: [ME, MATE] },
    ];
    workspaceApi.listChannels.mockResolvedValue(channels);
    workspaceApi.fetchRoster.mockResolvedValue([
      member({ id: ME, displayName: "박서연", handle: "seoyeon" }),
      member({ id: MATE, displayName: "김인턴", handle: "kim-intern", kind: "agent" }),
    ]);
    let resolve: ((channelId: string) => ScheduledPlaceInfo) | null = null;
    function Places() {
      resolve = useScheduledPlaces();
      return null;
    }
    await mount(createElement(Places));
    await settle();
    const places = resolve as unknown as (channelId: string) => ScheduledPlaceInfo;

    expect(places(CH)).toMatchObject({ label: "배포", markedLabel: "#배포", known: true, word: "채널", errorWord: "채널", isAgent: false });
    expect(places(CH.toUpperCase()).label).toBe("배포");
    expect(places(DM)).toMatchObject({
      label: "김인턴과의 대화",
      markedLabel: "김인턴과의 대화",
      known: true,
      word: "대화",
      errorWord: "대화",
      isAgent: true,
    });
    expect(places("00000000-0000-7000-8000-0000000009ff")).toMatchObject({
      label: "알 수 없는 채널",
      markedLabel: "알 수 없는 채널",
      known: false,
    });
  });
});
