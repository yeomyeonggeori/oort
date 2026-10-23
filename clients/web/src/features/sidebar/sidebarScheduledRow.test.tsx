// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import type { RealtimeHandle } from "@momo/core/lib/realtimeEvents";
import type { ScheduledMessageFrame } from "@momo/core/features/scheduled/events";
import type { NeedsMe } from "@momo/core/features/inbox/needsMe";
import type { ScheduledMessage } from "@momo/core/features/scheduled/types";
import { SessionProvider, type SessionContextValue } from "@/app/session";

// =============================================================================
// ADR-0208 부록 B(#4215): 사이드바 「예약됨」 줄. 보낼 예정 또는 보내지 못함이 있을 때만 서고, 잉크 알약은 **보내지
// 못한 예약의 수**다(대기는 세지 않는다). 이 서버에 예약이 없으면(첫 목록 404) 줄이 서지 않는다.
// =============================================================================

const scheduledApi = vi.hoisted(() => ({
  listAllScheduledMessages: vi.fn(),
  createScheduledMessage: vi.fn(),
  updateScheduledMessage: vi.fn(),
  sendScheduledMessageNow: vi.fn(),
  deleteScheduledMessage: vi.fn(),
}));
vi.mock("@momo/core/features/scheduled/api", () => scheduledApi);

const api = vi.hoisted(() => ({ listChannels: vi.fn(), fetchRoster: vi.fn() }));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, ...api };
});

import { resetSchedulerDisabledForTest } from "@/features/scheduled/useScheduled";
import { SidebarDestinations } from "./SidebarDestinations";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const SEND_AT = 1_800_000_000_000;

const NEEDS_ME: NeedsMe = { total: 0, panes: 0 } as unknown as NeedsMe;
const ACTIVE = { inbox: false, directory: false, ai: false, agents: false, work: false } as never;

let serial = 0;
function row(over: Partial<ScheduledMessage> = {}): ScheduledMessage {
  serial += 1;
  return {
    id: `00000000-0000-7000-8000-0000000004${String(serial).padStart(2, "0")}`,
    workspaceId: WS,
    memberId: ME,
    channelId: CH,
    body: "글",
    sendAtMs: SEND_AT,
    status: "pending",
    editableUntilMs: SEND_AT - 30_000,
    rev: 0,
    createdAtMs: SEND_AT - 1000,
    updatedAtMs: SEND_AT - 1000,
    ...over,
  };
}
const failed = (reason: ScheduledMessage["failureReason"] = "missed") =>
  row({ status: "failed", failureReason: reason, editableUntilMs: undefined, rev: 2 });

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  serial = 0;
  for (const fn of Object.values(scheduledApi)) fn.mockReset();
  for (const fn of Object.values(api)) fn.mockReset();
  api.listChannels.mockResolvedValue([]);
  api.fetchRoster.mockResolvedValue([]);
  scheduledApi.listAllScheduledMessages.mockResolvedValue([]);
  resetSchedulerDisabledForTest();
});
afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

function session(realtime: RealtimeHandle | null = null): SessionContextValue {
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

/** 개인 채널 구독을 대신한다: 호출부가 건 핸들러를 시험이 쥔다. */
function fakeRealtime() {
  const handlers: Array<{ onEvent: (frame: ScheduledMessageFrame) => void; onResync: () => void }> = [];
  const handle = {
    subscribeScheduled: vi.fn((_member: string, next: (typeof handlers)[number]) => {
      handlers.push(next);
      return () => undefined;
    }),
  } as unknown as RealtimeHandle;
  return { handle, handlers };
}

async function mount(realtime: RealtimeHandle | null = null) {
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
          { initialEntries: ["/"] },
          createElement(SessionProvider, { value: session(realtime) }, createElement(SidebarDestinations, { active: ACTIVE, needsMe: NEEDS_ME }))
        )
      )
    );
  });
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const nav = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-testid="nav-scheduled"]');
const pill = (): string | null => nav()?.querySelector('[data-testid="mention-badge"]')?.textContent ?? null;

describe("사이드바 「예약됨」 줄", () => {
  it("예약이 하나도 없으면 줄이 서지 않는다", async () => {
    await mount();
    expect(nav()).toBeNull();
  });

  it("이 서버에 예약이 없으면(첫 목록 404) 줄이 서지 않는다", async () => {
    scheduledApi.listAllScheduledMessages.mockRejectedValue(new ApiError(404, "not found"));
    await mount();
    expect(nav()).toBeNull();
  });

  it("목록이 5xx로 실패하면 보여 줄 행이 없어 줄이 서지 않는다(없는 서버로 굳히지는 않는다: 다음 읽기가 성공하면 선다)", async () => {
    scheduledApi.listAllScheduledMessages.mockRejectedValue(new ApiError(503, "down"));
    await mount();
    expect(nav()).toBeNull();
  });

  it("보낼 예정만 있으면 줄이 서고 알약은 없다(대기는 세지 않는다)", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue([row(), row()]);
    await mount();
    expect(nav()).not.toBeNull();
    expect(nav()?.textContent).toContain("예약됨");
    expect(nav()?.getAttribute("href")).toBe("/scheduled");
    expect(pill()).toBeNull();
  });

  it("보내지 못한 예약이 있으면 잉크 알약이 그 수를 말하고, 낭독 이름이 이어 읽는다", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue([row(), failed(), failed("sessions_ended")]);
    await mount();
    expect(pill()).toBe("2");
    expect(nav()?.getAttribute("aria-label")).toContain("보내지 못한 예약 2개");
  });

  it("보내지 못한 예약만 있어도 줄이 선다", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue([failed()]);
    await mount();
    expect(nav()).not.toBeNull();
    expect(pill()).toBe("1");
  });

  it("목적지 구획(인박스·멤버·초안 옆)에 서고 라우트는 /scheduled다", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue([row()]);
    await mount();
    const links = [...document.querySelectorAll<HTMLAnchorElement>('nav[aria-label="워크스페이스 탐색"] a')].map((a) => a.getAttribute("data-testid"));
    expect(links.slice(0, 2)).toEqual(["nav-inbox", "nav-directory"]);
    expect(links).toContain("nav-scheduled");
  });
});

function frame(over: Partial<ScheduledMessageFrame> = {}): ScheduledMessageFrame {
  return {
    workspaceId: WS.toUpperCase(),
    memberId: ME.toUpperCase(),
    scheduledMessageId: "00000000-0000-7000-8000-0000000004a9".toUpperCase(),
    channelId: CH.toUpperCase(),
    status: "failed",
    failureReason: "sessions_ended",
    sendAtMs: SEND_AT,
    rev: 1,
    ...over,
  };
}

async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("이벤트가 오면 즉시 바뀐다 (owner 결정 6)", () => {
  it("대기 행이 sessions_ended로 멈추면 이벤트 도착 즉시 잉크 알약이 서고 낭독 이름이 따라온다", async () => {
    const waiting = row();
    scheduledApi.listAllScheduledMessages.mockResolvedValue([waiting]);
    const rt = fakeRealtime();
    await mount(rt.handle);
    expect(nav()).not.toBeNull();
    expect(pill()).toBeNull();
    await act(async () => {
      rt.handlers[0]!.onEvent(frame({ scheduledMessageId: waiting.id.toUpperCase() }));
    });
    await settle();
    expect(pill()).toBe("1");
    expect(nav()?.getAttribute("aria-label")).toContain("보내지 못한 예약 1개");
  });

  it("예약이 하나도 없던 사이드바도 모르는 행의 이벤트로 줄과 알약이 선다(본문은 뒤따르는 읽기가 채운다)", async () => {
    const rt = fakeRealtime();
    await mount(rt.handle);
    expect(nav()).toBeNull();
    await act(async () => {
      rt.handlers[0]!.onEvent(frame());
    });
    await settle();
    expect(nav()).not.toBeNull();
    expect(pill()).toBe("1");
  });

  it("마지막 행이 나가면(sent) 줄이 걷힌다", async () => {
    const only = row();
    scheduledApi.listAllScheduledMessages.mockResolvedValue([only]);
    const rt = fakeRealtime();
    await mount(rt.handle);
    expect(nav()).not.toBeNull();
    await act(async () => {
      rt.handlers[0]!.onEvent(frame({ scheduledMessageId: only.id.toUpperCase(), status: "sent", failureReason: undefined, sentMessageId: "M1" }));
    });
    await settle();
    expect(nav()).toBeNull();
  });
});
