// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import type { RealtimeHandle } from "@momo/core/lib/realtimeEvents";
import type { ScheduledMessageFrame } from "@momo/core/features/scheduled/events";
import type { ScheduledMessage } from "@momo/core/features/scheduled/types";
import { SessionProvider, type SessionContextValue } from "@/app/session";

// =============================================================================
// ADR-0208 부록 B 1.6(#4215): 입력창 위의 예약 배너. 세 모양(대기·스레드·실패)과 「보기」, 그리고 이벤트가 도착하는
// 즉시 바뀌는 것. 라우터가 없는 호스트에서는 갈 곳이 없어 「보기」 단추를 세우지 않는다.
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

import { resetSchedulerDisabledForTest } from "./useScheduled";
import { ScheduledBanner } from "./ScheduledBanner";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const OTHER = "00000000-0000-7000-8000-000000000202";
const ROOT = "00000000-0000-7000-8000-000000000301";
const SEND_AT = 1_800_000_000_000;

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
const failed = (over: Partial<ScheduledMessage> = {}) =>
  row({ status: "failed", failureReason: "missed", editableUntilMs: undefined, rev: 2, ...over });

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
let here = "";

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

function Probe() {
  const location = useLocation();
  here = `${location.pathname}${location.search}`;
  return null;
}

async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(props: { place: { channelId: string; rootId?: string }; word?: "채널" | "대화" | "스레드"; className?: string }, options: { router?: boolean; realtime?: RealtimeHandle | null } = {}) {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const banner = createElement(ScheduledBanner, {
    place: props.place,
    word: props.word ?? "채널",
    testId: "banner",
    ...(props.className === undefined ? {} : { className: props.className }),
  });
  const inside = createElement(SessionProvider, { value: session(options.realtime ?? null) }, banner);
  await act(async () => {
    mountedRoot?.render(
      createElement(
        QueryClientProvider,
        { client },
        options.router === false
          ? inside
          : createElement(MemoryRouter, { initialEntries: ["/c/x"] }, inside, createElement(Probe))
      )
    );
  });
  await settle();
}

const banner = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-testid="banner"]');
const text = (): string => (banner()?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("세 모양", () => {
  it("(a) 대기: 「이 채널에 예약된 메시지 N개」 neutral status와 시계 아이콘, 「보기」", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue([row(), row()]);
    await mount({ place: { channelId: CH } });
    expect(text()).toContain("이 채널에 예약된 메시지 2개");
    expect(banner()?.getAttribute("role")).toBe("status");
    expect(banner()?.querySelector("svg")).not.toBeNull();
    expect(banner()?.querySelector("button")?.textContent).toBe("보기");
  });

  it("대화방이면 「이 대화에」, 스레드 패널이면 「이 스레드에」", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue([row({ rootId: ROOT })]);
    await mount({ place: { channelId: CH }, word: "대화" });
    expect(text()).toContain("이 대화에 예약된 메시지 1개");
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    host?.remove();
    await mount({ place: { channelId: CH, rootId: ROOT }, word: "스레드" });
    expect(text()).toContain("이 스레드에 예약된 메시지 1개");
  });

  it("(c) 실패가 하나라도 있으면 「예약한 메시지 N개를 보내지 못했어요」 한 줄이 대기 줄 대신 서고 role=alert다", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue([row(), failed(), failed()]);
    await mount({ place: { channelId: CH } });
    expect(text()).toContain("예약한 메시지 2개를 보내지 못했어요");
    expect(text()).not.toContain("예약된 메시지");
    expect(banner()?.getAttribute("role")).toBe("alert");
  });

  it("다른 채널의 예약은 세지 않고 0개면 배너가 없다", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue([row({ channelId: OTHER })]);
    await mount({ place: { channelId: CH } });
    expect(banner()).toBeNull();
  });

  it("스레드 패널은 그 스레드의 예약만 센다", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue([row({ rootId: ROOT }), row(), row({ rootId: "00000000-0000-7000-8000-000000000302" })]);
    await mount({ place: { channelId: CH, rootId: ROOT }, word: "스레드" });
    expect(text()).toContain("이 스레드에 예약된 메시지 1개");
  });

  it("이 서버에 예약이 없으면(첫 목록 404) 배너가 서지 않는다", async () => {
    scheduledApi.listAllScheduledMessages.mockRejectedValue(new ApiError(404, "not found"));
    await mount({ place: { channelId: CH } });
    expect(banner()).toBeNull();
  });
});

describe("좁은 칸에서의 모양 (design-review #4215 M3)", () => {
  it("문장은 두 줄이 비슷한 길이로 접히도록 균형을 잡는다(「1개」·「못했어요」가 홀로 남지 않는다)", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue([row({ rootId: ROOT })]);
    await mount({ place: { channelId: CH, rootId: ROOT }, word: "스레드" });
    const sentence = banner()?.querySelector("span.text-balance");
    expect(sentence?.textContent).toBe("이 스레드에 예약된 메시지 1개");
    expect(sentence?.className).toContain("block");
  });

  it("호스트가 바깥 여백을 정한다(스레드 입력창은 배너가 입력 틀에 닿지 않게 아래 여백을 준다)", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue([row()]);
    await mount({ place: { channelId: CH }, className: "mb-2" });
    expect(banner()?.className).toContain("mb-2");
  });

  it("여백을 주지 않으면 배너는 제 클래스만 갖는다", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue([row()]);
    await mount({ place: { channelId: CH } });
    expect(banner()?.className).not.toContain("mb-2");
  });
});

describe("「보기」", () => {
  it("채널이면 ?channel=<id>로 거른 목록을 연다", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue([row()]);
    await mount({ place: { channelId: CH } });
    await act(async () => {
      banner()?.querySelector("button")?.click();
    });
    expect(here).toBe(`/scheduled?channel=${CH}`);
  });

  it("스레드면 &thread=<rootId>가 더해진다", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue([row({ rootId: ROOT })]);
    await mount({ place: { channelId: CH, rootId: ROOT }, word: "스레드" });
    await act(async () => {
      banner()?.querySelector("button")?.click();
    });
    expect(here).toBe(`/scheduled?channel=${CH}&thread=${ROOT}`);
  });

  it("라우터가 없는 호스트에서는 갈 곳이 없어 「보기」 단추를 세우지 않는다", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue([row()]);
    await mount({ place: { channelId: CH } }, { router: false });
    expect(text()).toContain("이 채널에 예약된 메시지 1개");
    expect(banner()?.querySelector("button")).toBeNull();
  });
});

describe("이벤트가 오면 즉시 바뀐다 (owner 결정 6)", () => {
  it("대기 배너가 sessions_ended 이벤트 도착 즉시 실패 어조 한 줄로 바뀐다", async () => {
    const r = row();
    scheduledApi.listAllScheduledMessages.mockResolvedValue([r]);
    const handlers: Array<{ onEvent: (frame: ScheduledMessageFrame) => void; onResync: () => void }> = [];
    const handle = {
      subscribeScheduled: vi.fn((_member: string, next: (typeof handlers)[number]) => {
        handlers.push(next);
        return () => undefined;
      }),
    } as unknown as RealtimeHandle;
    await mount({ place: { channelId: CH } }, { realtime: handle });
    expect(banner()?.getAttribute("role")).toBe("status");
    await act(async () => {
      handlers[0]!.onEvent({
        workspaceId: WS.toUpperCase(),
        memberId: ME.toUpperCase(),
        scheduledMessageId: r.id.toUpperCase(),
        channelId: CH.toUpperCase(),
        status: "failed",
        failureReason: "sessions_ended",
        sendAtMs: SEND_AT,
        rev: 1,
      });
    });
    await settle();
    expect(text()).toContain("예약한 메시지 1개를 보내지 못했어요");
    expect(banner()?.getAttribute("role")).toBe("alert");
  });
});
