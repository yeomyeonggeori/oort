// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import type { ScheduledMessage } from "@momo/core/features/scheduled/types";
import { SessionProvider, type SessionContextValue } from "@/app/session";

// =============================================================================
// ADR-0208 D16(#4215): 입력창의 「예약해서 보내기」 흐름 한 벌(훅)을 호스트 없이 잰다. 채널 입력창과 스레드 입력창이
// 같은 훅을 부르므로, 호스트가 달라도 같아야 하는 것(판정·잠금·스냅샷·멱등)을 여기서 고정한다.
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

import { resetAttachmentDraftsForTest } from "@/features/attachments/draftStore";
import { resetSchedulerDisabledForTest } from "./useScheduled";
import { useComposerSchedule, type ComposerSchedule, type ComposerScheduleOptions } from "./useComposerSchedule";

const NOW = new Date("2026-10-22T14:30:00+09:00").getTime();
const TOMORROW_9 = new Date("2026-10-23T09:00:00+09:00").getTime();
const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const ROOT = "00000000-0000-7000-8000-000000000301";

function row(over: Partial<ScheduledMessage> = {}): ScheduledMessage {
  return {
    id: "00000000-0000-7000-8000-0000000004a1",
    workspaceId: WS,
    memberId: ME,
    channelId: CH,
    body: "글",
    sendAtMs: TOMORROW_9,
    status: "pending",
    editableUntilMs: TOMORROW_9 - 30_000,
    rev: 0,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...over,
  };
}

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
let latest: ComposerSchedule | null = null;
let text = "글";
let scheduledCalls: Array<{ textUnchanged: boolean }> = [];
let secretCalls = 0;
let focusCalls = 0;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const fn of Object.values(scheduledApi)) fn.mockReset();
  for (const fn of Object.values(api)) fn.mockReset();
  api.listChannels.mockResolvedValue([]);
  api.fetchRoster.mockResolvedValue([]);
  scheduledApi.listAllScheduledMessages.mockResolvedValue([]);
  resetSchedulerDisabledForTest();
  resetAttachmentDraftsForTest();
  text = "글";
  scheduledCalls = [];
  secretCalls = 0;
  focusCalls = 0;
});
afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host?.remove();
  host = null;
  latest = null;
  vi.useRealTimers();
});

function session(): SessionContextValue {
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "박서연", handle: "seoyeon" },
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

function optionsOf(over: Partial<ComposerScheduleOptions> = {}): ComposerScheduleOptions {
  return {
    surface: "channel",
    workspaceId: WS,
    channelId: CH,
    text,
    readText: () => text,
    trayKey: `${WS}|${CH}|`,
    drafts: [],
    offline: false,
    commandDraft: false,
    personalCall: false,
    quoting: false,
    routingSet: false,
    focusInput: () => {
      focusCalls += 1;
    },
    onScheduled: (info) => {
      scheduledCalls.push(info);
    },
    onSecretKey: () => {
      secretCalls += 1;
    },
    ...over,
  };
}

function Probe({ options }: { options: ComposerScheduleOptions }) {
  latest = useComposerSchedule(options);
  return null;
}

async function mount(options: ComposerScheduleOptions) {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await act(async () => {
    mountedRoot?.render(
      createElement(QueryClientProvider, { client }, createElement(SessionProvider, { value: session() }, createElement(Probe, { options })))
    );
  });
  await settle();
}

async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const hook = (): ComposerSchedule => {
  if (latest === null) throw new Error("not mounted");
  return latest;
};

describe("호스트가 달라도 같은 것", () => {
  it("채널 입력창: 배너가 세는 곳은 채널이고 시험 접두사는 composer다", async () => {
    await mount(optionsOf());
    expect(hook().place).toEqual({ channelId: CH });
    expect(hook().menuProps.testIdPrefix).toBe("composer");
    expect(hook().bannerWord).toBe("채널");
  });

  it("스레드 입력창: 배너가 세는 곳은 채널과 rootId이고 낱말은 「스레드」, 접두사는 thread-composer다", async () => {
    await mount(optionsOf({ surface: "thread", rootId: ROOT }));
    expect(hook().place).toEqual({ channelId: CH, rootId: ROOT });
    expect(hook().menuProps.testIdPrefix).toBe("thread-composer");
    expect(hook().bannerWord).toBe("스레드");
  });

  it("모델 지정이 켜져 있으면 메뉴와 직접 고르기가 같은 안내를 올린다", async () => {
    await mount(optionsOf({ routingSet: true }));
    expect(hook().gate.routingNote).toBe(true);
    expect(hook().menuProps.gate.routingNote).toBe(true);
    expect(hook().dialogProps.routingNote).toBe(true);
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    host?.remove();
    await mount(optionsOf({ routingSet: false }));
    expect(hook().dialogProps.routingNote).toBe(false);
  });

  it("호스트가 이미 요청을 날리는 중이면 메뉴가 잠긴다(스레드의 답글 전송)", async () => {
    await mount(optionsOf({ surface: "thread", rootId: ROOT, hostBusy: true }));
    expect(hook().busy).toBe(false);
    expect(hook().menuProps.busy).toBe(true);
  });

  it("막힌 ▾를 누르면 이유 줄을 3초 줄에 올린다", async () => {
    text = "";
    await mount(optionsOf({ text: "" }));
    expect(hook().gate.block).toBe("empty");
    expect(hook().statusText).toBeNull();
    await act(async () => {
      hook().menuProps.onBlockedPress();
    });
    expect(hook().statusText).toBe("보낼 내용을 쓰면 예약할 수 있어요");
  });
});

describe("요청 한 번의 규칙", () => {
  it("프리셋 성공: 스냅샷이 같으면 textUnchanged, 응답의 시각으로 말하고 입력창에 초점을 돌려 준다", async () => {
    scheduledApi.createScheduledMessage.mockResolvedValue(row());
    await mount(optionsOf());
    await act(async () => {
      hook().menuProps.onOpen(null);
    });
    await act(async () => {
      hook().menuProps.onPickPreset(hook().menuProps.presets[0]!);
    });
    await settle();
    expect(scheduledCalls).toEqual([{ textUnchanged: true }]);
    expect(hook().statusText).toBe("내일 오전 9:00에 보낼게요");
    expect(focusCalls).toBe(1);
    expect(hook().busy).toBe(false);
  });

  it("요청 중에 글이 바뀌면 textUnchanged가 false다", async () => {
    let finish!: (value: ScheduledMessage) => void;
    scheduledApi.createScheduledMessage.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await mount(optionsOf());
    await act(async () => {
      hook().menuProps.onOpen(null);
    });
    await act(async () => {
      hook().menuProps.onPickPreset(hook().menuProps.presets[0]!);
    });
    expect(hook().busy).toBe(true);
    text = "글에 덧붙인 말";
    await act(async () => {
      finish(row());
    });
    await settle();
    expect(scheduledCalls).toEqual([{ textUnchanged: false }]);
  });

  it("요청 중에 입력창이 다른 채널로 옮겨 갔으면 그 입력창에 확인을 말하거나 초점을 가져오지 않는다", async () => {
    let finish!: (value: ScheduledMessage) => void;
    scheduledApi.createScheduledMessage.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const original = optionsOf();
    await mount(original);
    await act(async () => {
      hook().menuProps.onOpen(null);
    });
    await act(async () => {
      hook().menuProps.onPickPreset(hook().menuProps.presets[0]!);
    });
    // 같은 훅이 다른 채널 값으로 다시 그려진다.
    await act(async () => {
      mountedRoot?.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
          createElement(SessionProvider, { value: session() }, createElement(Probe, { options: optionsOf({ channelId: "00000000-0000-7000-8000-000000000299" }) }))
        )
      );
    });
    await act(async () => {
      finish(row());
    });
    await settle();
    expect(hook().statusText).toBeNull();
    expect(focusCalls).toBe(0);
  });

  it("중복 요청은 막는다: 요청이 나는 동안의 두 번째 고르기는 서버를 부르지 않는다", async () => {
    scheduledApi.createScheduledMessage.mockImplementation(() => new Promise(() => {}));
    await mount(optionsOf());
    await act(async () => {
      hook().menuProps.onOpen(null);
    });
    await act(async () => {
      hook().menuProps.onPickPreset(hook().menuProps.presets[0]!);
      hook().menuProps.onPickPreset(hook().menuProps.presets[0]!);
    });
    expect(scheduledApi.createScheduledMessage).toHaveBeenCalledTimes(1);
  });

  it("지난 시각(메뉴를 열어 둔 사이)은 서버를 부르기 전에 직접 고르기를 연다", async () => {
    await mount(optionsOf());
    await act(async () => {
      hook().menuProps.onOpen(null);
    });
    const preset = hook().menuProps.presets[0]!;
    vi.setSystemTime(preset.atMs + 1);
    await act(async () => {
      hook().menuProps.onPickPreset(preset);
    });
    expect(scheduledApi.createScheduledMessage).not.toHaveBeenCalled();
    expect(hook().dialogProps.open).toBe(true);
    expect(hook().dialogProps.error?.text).toBe("1분 뒤부터 예약할 수 있어요");
  });

  it("키 모양 글은 고르는 순간 막고 호출부가 키 차단 줄을 세우게 한다", async () => {
    text = "sk-ant-api03-Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90";
    await mount(optionsOf({ text }));
    await act(async () => {
      hook().menuProps.onOpen(null);
    });
    await act(async () => {
      hook().menuProps.onPickPreset(hook().menuProps.presets[0]!);
    });
    expect(secretCalls).toBe(1);
    expect(scheduledApi.createScheduledMessage).not.toHaveBeenCalled();
    await act(async () => {
      hook().menuProps.onPickCustom(null);
    });
    expect(secretCalls).toBe(2);
    expect(hook().dialogProps.open).toBe(false);
  });

  it("서버가 503 scheduler_disabled로 거절하면 그 사실이 세션에 남아 ▾가 흐려진다", async () => {
    scheduledApi.createScheduledMessage.mockRejectedValue(new ApiError(503, "off", "scheduler_disabled"));
    await mount(optionsOf());
    expect(hook().gate.block).toBeNull();
    await act(async () => {
      hook().menuProps.onOpen(null);
    });
    await act(async () => {
      hook().menuProps.onPickPreset(hook().menuProps.presets[0]!);
    });
    await settle();
    expect(hook().gate.block).toBe("unavailable");
    expect(hook().dialogProps.error?.text).toBe("이 서버에서는 예약을 쓸 수 없어요");
    // 직접 고르기의 「예약하기」도 흐리다(명세 0.5 ③).
    expect(hook().dialogProps.unavailable).toBe(true);
  });

  it("프리셋 요청이 나는 동안 「예약 중」을 말하고(직접 고르기가 열려 있으면 그 단추가 말한다), 끝나면 거둔다", async () => {
    let finish!: (value: ScheduledMessage) => void;
    scheduledApi.createScheduledMessage.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await mount(optionsOf());
    expect(hook().statusText).toBeNull();
    await act(async () => {
      hook().menuProps.onOpen(null);
    });
    await act(async () => {
      hook().menuProps.onPickPreset(hook().menuProps.presets[0]!);
    });
    expect(hook().busy).toBe(true);
    expect(hook().statusText).toBe("예약 중");
    await act(async () => {
      finish(row());
    });
    await settle();
    expect(hook().statusText).toBe("내일 오전 9:00에 보낼게요");
  });

  it("직접 고르기에서 건 요청 중에는 입력창 줄이 「예약 중」을 말하지 않는다(대화상자의 단추가 말한다)", async () => {
    scheduledApi.createScheduledMessage.mockImplementation(() => new Promise(() => {}));
    await mount(optionsOf());
    await act(async () => {
      hook().menuProps.onOpen(null);
    });
    await act(async () => {
      hook().menuProps.onPickCustom(null);
    });
    expect(hook().dialogProps.open).toBe(true);
    await act(async () => {
      hook().dialogProps.onCommit(hook().dialogProps.initialAtMs);
    });
    expect(hook().busy).toBe(true);
    expect(hook().dialogProps.pending).toBe(true);
    expect(hook().statusText).toBeNull();
  });
});
