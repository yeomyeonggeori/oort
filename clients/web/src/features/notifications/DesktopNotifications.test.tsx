// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import type { MessageNewEvent } from "@momo/core/lib/realtimeEvents";
import { createMessageService } from "@momo/core/i18n";
import type { NotificationRules } from "@momo/core/features/settings/notificationRules";
import type { RealtimeHandle } from "@/lib/realtime";
import { DesktopNotifications } from "./DesktopNotifications";
import { messageAnchorPath } from "@/features/inbox/anchor";
import { armOpen, openTarget } from "@momo/core/features/notifications/model";
import { paneAttention, type PaneObservation } from "@/features/workbench/local/paneAttention";
import { osNotifier } from "./osNotifier";
import {
  reloadDesktopNotificationKindsForTest,
  setDesktopNotificationKind,
} from "./preference";
import { serverPauseActive } from "./serverPause";
import { SERVER_PAUSE_POLL_MS } from "./useServerPause";

const IDS = vi.hoisted(() => ({
  ws: "00000000-0000-7000-8000-000000000001",
  self: "00000000-0000-7000-8000-000000000101",
  other: "00000000-0000-7000-8000-0000000005d1",
  agent: "00000000-0000-7000-8000-000000000103",
  channel: "00000000-0000-7000-8000-00000000020a",
  dm: "00000000-0000-7000-8000-00000000020b",
}));

const showNotification = vi.hoisted(() => vi.fn());
const fetchNotificationRules = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({
  isDesktop: () => true,
  showNotification: (...args: unknown[]) => showNotification(...args),
}));

// 서버 규칙 읽기만 모듈 경계에서 가짜다(`PauseBanner.test.tsx` 와 같은 방식). 훅·판정·알림 묶음은 진짜다.
vi.mock("@momo/core/features/settings/notificationRules", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/settings/notificationRules")>();
  return {
    ...actual,
    fetchNotificationRules: (workspaceId: string) =>
      fetchNotificationRules(workspaceId) as Promise<NotificationRules>,
  };
});

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => ({
      groups: {
        channels: [
          {
            id: IDS.channel,
            workspaceId: IDS.ws,
            kind: "public" as const,
            name: "ops",
            muted: false,
          },
        ],
        dms: [
          {
            id: IDS.dm,
            workspaceId: IDS.ws,
            kind: "dm" as const,
            name: "dm",
            muted: false,
          },
        ],
      },
    }),
    useDirectory: () => ({
      directory: actual.makeDirectory([
        {
          id: IDS.other,
          workspaceId: IDS.ws,
          kind: "human",
          status: "active",
          displayName: "곽성재",
          handle: "seongjae",
          channelCount: 1,
          channelIds: [IDS.channel],
          capabilities: [],
          createdAtMs: 0,
          updatedAtMs: 0,
        },
      ]),
    }),
  };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;
let onMessage: ((event: MessageNewEvent) => void) | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  showNotification.mockReset();
  showNotification.mockResolvedValue(true);
  fetchNotificationRules.mockReset();
  fetchNotificationRules.mockResolvedValue(rules());
  onMessage = null;
  localStorage.clear();
  reloadDesktopNotificationKindsForTest(localStorage);
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  reloadDesktopNotificationKindsForTest(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const rules = (over: Partial<NotificationRules> = {}): NotificationRules => ({
  dnd: false,
  mentionOverridesMute: false,
  ...over,
});

function mentionEvent(id = "019F96A4-E717-7F82-9750-58B2D7D28225"): MessageNewEvent {
  const now = Date.now();
  return {
    type: "message.new",
    v: 1,
    ts: now,
    seq: 42,
    payload: {
      id,
      channel_id: IDS.channel,
      seq: 42,
      type: "text",
      body: "@데모 사용자 배포 확인 부탁드립니다",
      author_member_id: IDS.other,
      hlc_ts: now,
      hlc_count: 0,
      props: { mention_member_ids: [IDS.self] },
    },
  };
}

function approvalEvent(): MessageNewEvent {
  const now = Date.now();
  return {
    type: "message.new",
    v: 1,
    ts: now,
    seq: 43,
    payload: {
      id: "019F96A4-E717-7F82-9750-58B2D7D28226",
      channel_id: IDS.channel,
      seq: 43,
      type: "approval_request",
      body: "승인 요청",
      author_member_id: IDS.agent,
      hlc_ts: now,
      hlc_count: 0,
      props: { approval_id: "019F8338-025E-7873-93A3-C1FBA9149185" },
    },
  };
}

function sessionValue(): SessionContextValue {
  const realtime = {
    subscribeChannel: (
      _workspaceId: string,
      _channelId: string,
      handlers: { onMessage: (event: MessageNewEvent) => void }
    ) => {
      onMessage = handlers.onMessage;
      return () => {
        onMessage = null;
      };
    },
  } as unknown as RealtimeHandle;
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: {
        id: IDS.self,
        workspaceId: IDS.ws,
        kind: "human",
        displayName: "데모 사용자",
        handle: "demo",
      },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: IDS.ws,
    realtime,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function mountRail(path = "/"): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(
    MemoryRouter,
    { initialEntries: [path] },
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }) },
      createElement(
        SessionProvider,
        { value: sessionValue() },
        createElement(() => {
          const location = useLocation();
          return createElement("div", null, createElement(DesktopNotifications), createElement("output", { "data-testid": "notification-route" }, location.pathname + location.search));
        })
      )
    )
  );
  act(() => mountedRoot?.render(tree));
  return host;
}

/**
 * 조건이 설 때까지 기다린다. 질의의 상태 알림(`notifyManager`)은 약속이 풀린 **뒤** 매크로태스크에 나가므로
 * 고정된 한 틱으로는 부하에서 어긋난다(전체 시험에서만 붉던 시험이 그 증거다). 타이머는 진짜다 — 아래
 * 시험이 가짜로 두는 것은 시계와 간격 타이머뿐이다.
 */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 2));
    });
  }
  expect(condition(), what).toBe(true);
}

/** 이 마운트의 규칙 읽기가 한 번 끝나 다음 판정에 닿을 때까지(첫 답은 항상 빈 값이 아니다). */
const rulesRead = (calls: number) => () => fetchNotificationRules.mock.calls.length >= calls;

/** 마운트하고 서버 규칙의 첫 읽기를 시작시킨다. 값이 훅에 닿는 것은 시험이 `until` 로 기다린다. */
async function mountSettled(path = "/"): Promise<HTMLElement> {
  const host = mountRail(path);
  await until(rulesRead(1), "규칙 읽기가 시작됐다");
  return host;
}

describe("DesktopNotifications", () => {
  it("shows a mention through the shell bridge", async () => {
    mountRail();
    expect(onMessage).not.toBeNull();
    await act(async () => {
      onMessage?.(mentionEvent());
      osNotifier().flush();
      await Promise.resolve();
    });
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0]?.[0]).toBe("곽성재");
  });

  it("honours this-device kind toggles on the live rail", async () => {
    mountRail();
    setDesktopNotificationKind("mention", false, localStorage);
    await act(async () => {
      onMessage?.(mentionEvent());
      osNotifier().flush();
      await Promise.resolve();
    });
    expect(showNotification).not.toHaveBeenCalled();

    await act(async () => {
      onMessage?.(approvalEvent());
      osNotifier().flush();
      await Promise.resolve();
    });
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it("승인 둘이 연달아 오면 「승인 필요 2건」 한 묶음으로 나간다 (#3339)", async () => {
    mountRail();
    const other = { ...approvalEvent() };
    await act(async () => {
      onMessage?.(approvalEvent());
      onMessage?.({
        ...other,
        payload: { ...other.payload, id: "019F96A4-E717-7F82-9750-58B2D7D28299" },
      } as MessageNewEvent);
      osNotifier().flush();
      await Promise.resolve();
    });
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0]?.[0]).toBe("승인 필요 2건");
  });

  it("경로 id의 대소문자가 이벤트와 달라도 같은 채널로 본다 (#3339)", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    mountRail("/c/" + IDS.channel.toUpperCase());
    await act(async () => {
      onMessage?.(mentionEvent());
      osNotifier().flush();
      await Promise.resolve();
    });
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("창이 앞이고 그 채널이 열려 있으면 알리지 않고, 다른 화면이면 알린다 (#3339)", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    mountRail("/c/" + IDS.channel);
    await act(async () => {
      onMessage?.(mentionEvent());
      osNotifier().flush();
      await Promise.resolve();
    });
    expect(showNotification).not.toHaveBeenCalled();
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    mountedHost?.remove();
    mountRail("/inbox");
    await act(async () => {
      onMessage?.(mentionEvent());
      osNotifier().flush();
      await Promise.resolve();
    });
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it("행동 승인 알림은 에이전트 이름과 구 서버 카드 제목을 읽는다", async () => {
    mountRail();
    const base = approvalEvent();
    const actionApproval = {
      ...base,
      payload: {
        ...base.payload,
        props: {
          approval_id: "019F8338-025E-7873-93A3-C1FBA9149185",
          action_type: "workspace_action",
          status: "pending",
          title: "채널 만들기",
          summary: "그록봇이 제안했습니다.",
          action: {
            id: "channel.create",
            rows: [{ label: "채널", value: "#계획" }],
            required_role: "admin",
          },
        },
      },
    } as MessageNewEvent;
    await act(async () => {
      onMessage?.(actionApproval);
      osNotifier().flush();
      await Promise.resolve();
    });
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(String(showNotification.mock.calls[0]?.[0])).toBe("나간 멤버");
    expect(String(showNotification.mock.calls[0]?.[1])).toBe("채널 만들기");
  });

  it("#3738: 알림을 눌러 앞에 온 창은 채널이 아니라 그 카드로 간다", () => {
    // 데스크탑은 무장한 목적지로 창이 앞에 오는 순간 이동한다. 승인 알림이면 그 목적지가
    // 카드여야 하고, 주소는 인박스 행·카드 링크가 쓰는 `?msg=` 와 한 글자도 다르지 않다.
    const card = "019F96A4-E717-7F82-9750-58B2D7D28226";
    const armed = armOpen(null, IDS.channel, 1_000, undefined, card);
    expect(openTarget(armed, 1_001)).toBe(messageAnchorPath(IDS.channel, card));
  });
  it("요청 스레드의 알림은 질문을 말하고 창이 앞에 오면 root와 카드 둘 다 가진 주소로 간다", async () => {
    const host = mountRail();
    const event = approvalEvent();
    event.payload.root_id = "00000000-0000-7000-8000-000000000311";
    event.payload.body = "소개를 바꿔도 될까요?";
    await act(async () => { onMessage?.(event); osNotifier().flush(); });
    expect(showNotification.mock.calls[0]?.[1]).toBe("소개를 바꿔도 될까요?");
    act(() => window.dispatchEvent(new Event("focus")));
    expect(host.querySelector('[data-testid="notification-route"]')?.textContent).toBe(`${messageAnchorPath(IDS.channel, event.payload.id)}&thread=${event.payload.root_id}`);
  });
});

// =============================================================================
// #4197 — 알림 일시 중지(서버 규칙)가 OS 배너를 멈춘다.
//
// 폰 푸시는 서버가 `notification_rule.dnd` 로 멈춘다. 데스크탑·웹 배너는 서버를 거치지 않고 이 기기가
// 판정해 왔고 그 입력에 일시 중지가 없었다(리서치 r7 §3.5 진단, 전 판 번들 실측 3건 —
// `clients/web/captures/4197/before/report.json`). 규칙 읽기만 가짜이고(위 vi.mock) 판정·훅·칸
// 저장소·알림 묶음·셸 다리까지는 진짜다 — `showNotification` 이 불리는 횟수가 증거다.
// =============================================================================

describe("알림 일시 중지(서버 규칙)를 따른다 (#4197)", () => {
  const PANE = "pane-4197";
  const pane = (status: PaneObservation["status"]): PaneObservation => ({
    paneId: PANE,
    index: 2,
    name: "claude",
    status,
    signal: status === "waiting" ? "waiting-permission" : null,
  });
  const dmEvent = (): MessageNewEvent => {
    const base = mentionEvent("019F96A4-E717-7F82-9750-58B2D7D28301");
    return {
      ...base,
      payload: { ...base.payload, channel_id: IDS.dm, props: {}, body: "점심 먹었어요?" },
    } as MessageNewEvent;
  };

  /** 멘션·승인·DM·칸 알림을 한 번씩 낸다. DM 은 기본 끔이라 켜 둔다(꺼서 안 뜬 것과 구분되게). */
  async function fireEveryKind(): Promise<void> {
    setDesktopNotificationKind("dm", true, localStorage);
    await act(async () => {
      onMessage?.(mentionEvent());
      onMessage?.(approvalEvent());
      onMessage?.(dmEvent());
      paneAttention().observe([pane("running")], null);
      paneAttention().observe([pane("waiting")], null);
      osNotifier().flush();
      await Promise.resolve();
    });
  }

  async function deliver(event: MessageNewEvent): Promise<void> {
    await act(async () => {
      onMessage?.(event);
      osNotifier().flush();
      await Promise.resolve();
    });
  }

  /** 질의 간격을 한 번 넘긴다. 시계만 가짜이고 약속은 진짜다(`PauseBanner.test.tsx` 와 같다). */
  async function pollOnce(): Promise<void> {
    const before = fetchNotificationRules.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(SERVER_PAUSE_POLL_MS);
    });
    await until(rulesRead(before + 1), "간격 재조회가 나갔다");
  }

  const fakeClock = () =>
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });

  afterEach(() => {
    // 칸 저장소는 앱에 하나다: 다음 시험이 이 칸을 이어 받지 않게 비운다.
    act(() => paneAttention().observe([], null));
  });

  it("① 일시 중지 중에는 멘션·승인·DM·칸 알림 어느 것도 OS 배너가 되지 않는다", async () => {
    fetchNotificationRules.mockResolvedValue(
      rules({ dnd: true, dndUntilMs: Date.now() + 3_600_000 })
    );
    await mountSettled();
    await until(serverPauseActive, "서버의 일시 중지가 이 기기에 닿았다");
    await fireEveryKind();
    expect(showNotification).not.toHaveBeenCalled();
    // ④ 배지·인박스의 원장은 별개다: 칸 줄은 일시 중지에도 그대로 선다(배지는 이 줄을 센다).
    expect(paneAttention().entries().map((entry) => entry.paneId)).toEqual([PANE]);
  });

  it("대조: 같은 입력에서 일시 중지가 꺼져 있으면 네 종류가 모두 뜬다 — 위 단정이 헛돌지 않는다", async () => {
    await mountSettled();
    await fireEveryKind();
    expect(serverPauseActive()).toBe(false);
    expect(showNotification).toHaveBeenCalledTimes(4);
    expect(paneAttention().entries().map((entry) => entry.paneId)).toEqual([PANE]);
  });

  it("기한 없는 일시 중지(옛 판이 만든 행)도 막는다", async () => {
    fetchNotificationRules.mockResolvedValue(rules({ dnd: true }));
    await mountSettled();
    await until(serverPauseActive, "서버의 일시 중지가 이 기기에 닿았다");
    await fireEveryKind();
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("② 기한이 지나도 서버가 풀었다고 답하기 전에는 풀지 않고, 풀었다고 답하면 다시 뜬다", async () => {
    // 이 기기 시계로는 기한이 이미 지났다. 서버의 두 번째 답은 약속이 풀릴 때까지 오지 않는다.
    fetchNotificationRules.mockResolvedValueOnce(
      rules({ dnd: true, dndUntilMs: Date.now() - 60_000 })
    );
    let release: (value: NotificationRules) => void = () => undefined;
    fetchNotificationRules.mockImplementationOnce(
      () => new Promise<NotificationRules>((resolve) => (release = resolve))
    );
    await mountSettled();
    // 지난 것을 알면 서버에 다시 묻는다(스스로 풀지 않는다).
    await until(rulesRead(2), "기한이 지난 것을 알고 서버에 다시 물었다");
    expect(fetchNotificationRules).toHaveBeenCalledTimes(2);
    expect(serverPauseActive()).toBe(true);
    await deliver(mentionEvent());
    expect(showNotification).not.toHaveBeenCalled();

    await act(async () => release(rules()));
    await until(() => !serverPauseActive(), "서버가 풀었다는 답이 이 기기에 닿았다");
    await deliver(mentionEvent("019F96A4-E717-7F82-9750-58B2D7D28310"));
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it("서버가 아직 켜져 있다고 답하면(시계 차이) 기한이 지났어도 계속 막는다", async () => {
    fetchNotificationRules.mockResolvedValue(
      rules({ dnd: true, dndUntilMs: Date.now() - 60_000 })
    );
    await mountSettled();
    await until(rulesRead(2), "기한이 지난 것을 알고 서버에 다시 물었다");
    // 서버가 두 번 다 켜져 있다고 답했다: 이 기기 시계로 지났다는 이유만으로는 풀지 않는다.
    await until(serverPauseActive, "서버의 일시 중지가 이 기기에 닿았다");
    await deliver(mentionEvent());
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("다른 기기에서 건 일시 중지도 다음 재조회부터 따른다", async () => {
    fakeClock();
    await mountSettled();
    await deliver(mentionEvent());
    expect(showNotification).toHaveBeenCalledTimes(1);

    // 폰에서 일시 중지를 걸었다. 창은 뒤에 있고 이 기기에는 이벤트가 없다 — 간격 재조회만이 닿는 길이다.
    fetchNotificationRules.mockResolvedValue(
      rules({ dnd: true, dndUntilMs: Date.now() + 3_600_000 })
    );
    await pollOnce();
    await until(serverPauseActive, "폰에서 건 일시 중지가 이 기기에 닿았다");
    await deliver(mentionEvent("019F96A4-E717-7F82-9750-58B2D7D28311"));
    expect(showNotification).toHaveBeenCalledTimes(1);

    // 폰에서 풀었다: 다음 재조회부터 다시 뜬다.
    fetchNotificationRules.mockResolvedValue(rules());
    await pollOnce();
    await until(() => !serverPauseActive(), "폰에서 푼 일시 중지가 이 기기에 닿았다");
    await deliver(mentionEvent("019F96A4-E717-7F82-9750-58B2D7D28312"));
    expect(showNotification).toHaveBeenCalledTimes(2);
  });

  it("③ 규칙 조회가 실패하면 마지막 값을 유지하고 로그를 남긴다", async () => {
    fakeClock();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchNotificationRules.mockResolvedValueOnce(rules({ dnd: true }));
    fetchNotificationRules.mockRejectedValue(new Error("down"));
    await mountSettled();
    await until(serverPauseActive, "서버의 일시 중지가 이 기기에 닿았다");

    await pollOnce();
    const logged = () =>
      warn.mock.calls.filter(([message]) =>
        String(message).startsWith("[momo] notification rules unavailable")
      );
    await until(() => logged().length >= 1, "실패가 로그로 남았다");
    expect(fetchNotificationRules).toHaveBeenCalledTimes(2);
    // 마지막으로 읽은 값(켜짐)이 그대로다: 서버가 대답하지 못한다고 일시 중지가 풀리지 않는다.
    expect(serverPauseActive()).toBe(true);
    await deliver(mentionEvent());
    expect(showNotification).not.toHaveBeenCalled();
    expect(logged()).toHaveLength(1);
    expect(logged()[0]?.[1]).toBeInstanceOf(Error);
  });

  it("③ 한 번도 읽지 못했으면 막지 않고(읽지 못한 규칙으로 배너를 죽이지 않는다) 로그는 남긴다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchNotificationRules.mockRejectedValue(new Error("down"));
    await mountSettled();
    await until(
      () =>
        warn.mock.calls.some(([message]) =>
          String(message).startsWith("[momo] notification rules unavailable")
        ),
      "실패가 로그로 남았다"
    );
    expect(serverPauseActive()).toBe(false);
    await deliver(mentionEvent());
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it("마운트를 떠나면 일시 중지 값을 남기지 않는다(로그아웃 뒤 다른 사람에게 새지 않는다)", async () => {
    fetchNotificationRules.mockResolvedValue(rules({ dnd: true }));
    await mountSettled();
    await until(serverPauseActive, "서버의 일시 중지가 이 기기에 닿았다");
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    expect(serverPauseActive()).toBe(false);
  });
});

// =============================================================================
// #5025 — 도우미 초대 링크 메시지(ADR-0201 증보 v3 B4-2)의 배너. 서버 본문은 「문장 + 링크」이고, 배너는
// 본문 어디도 읽지 않는다: 표지가 있으면 서버가 링크 없이 써 준 `props.preview`, 못 쓰면 사전의 고정 문장.
// =============================================================================

describe("도우미 초대 링크 DM의 배너에는 링크가 없다 (#5025)", () => {
  const LINK = "https://oort.test/join?code=Ab3-_xQ7zK9";
  // 링크가 **첫 줄에 오는** 본문: 표지 분기가 빠지면 이 줄이 그대로 배너가 된다.
  const linkEvent = (props: Record<string, unknown>): MessageNewEvent => {
    const base = mentionEvent("019F96A4-E717-7F82-9750-58B2D7D28320");
    return {
      ...base,
      payload: { ...base.payload, channel_id: IDS.dm, props, body: `${LINK}\n초대 링크를 올렸어요` },
    } as MessageNewEvent;
  };
  async function deliver(event: MessageNewEvent): Promise<void> {
    setDesktopNotificationKind("dm", true, localStorage);
    mountRail();
    await act(async () => {
      onMessage?.(event);
      osNotifier().flush();
      await Promise.resolve();
    });
  }

  it("서버 preview가 배너 본문이고, 링크는 제목에도 본문에도 없다", async () => {
    await deliver(linkEvent({ kind: "team_ai_invite_link", preview: "초대 링크를 올렸어요" }));
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0]).toEqual(["곽성재", "초대 링크를 올렸어요"]);
    expect(JSON.stringify(showNotification.mock.calls)).not.toContain("join?code");
  });

  it("preview가 없으면 사전의 고정 문장으로 말하고, 링크는 여전히 없다", async () => {
    // 이 시험은 언어 provider 없이 마운트한다: 앱의 사전 읽기는 번들된 영어 사전이다(`useMessages`).
    const dictionary = createMessageService({ messageLocale: "en-US" }).formatMessage(
      "notifications.inviteLink.fallback"
    );
    expect(dictionary.trim()).not.toBe("");
    await deliver(linkEvent({ kind: "team_ai_invite_link" }));
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0]).toEqual(["곽성재", dictionary]);
    expect(JSON.stringify(showNotification.mock.calls)).not.toContain("join?code");
  });
});
