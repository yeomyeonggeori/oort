// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import type { MessageNewEvent } from "@momo/core/lib/realtimeEvents";
import type { WorkSession } from "@momo/core/lib/api";
import { resetViewedAgentSessionsForTest, viewAgentSession } from "./viewedAgentSession";
import type { NotificationRules } from "@momo/core/features/settings/notificationRules";
import type { RealtimeHandle } from "@/lib/realtime";
import { DesktopNotifications } from "./DesktopNotifications";
import { resetBannerClicksForTest } from "./bannerClicks";
import { osNotifier } from "./osNotifier";
import { reloadDesktopNotificationKindsForTest } from "./preference";

// =============================================================================
// #5595 (ADR-0188 D5·D8): 맥 작업 세션의 권한 요청이 데스크탑 OS 배너가 된다 — 그 세션의 주인에게만. 누르면 승인 카드가
// 있는 그 세션의 A 칸이 열리는 주소로 간다(`/work?view=terminals&agent=<id>`).
//
// 셸 다리(`@/lib/tauri`)와 세션 원장 읽기(`fetchWorkSessions`)만 가짜다. 판정·알림 묶음·장부·이동은 진짜다. 실제 macOS 배너가
// 뜨고 눌리는지는 이 시험이 증명하지 못한다(`runtime-unverified`, 인계의 owner 확인 두 줄).
// =============================================================================

const IDS = vi.hoisted(() => ({
  ws: "00000000-0000-7000-8000-000000000001",
  self: "00000000-0000-7000-8000-000000000101",
  other: "00000000-0000-7000-8000-0000000005d1",
  agent: "00000000-0000-7000-8000-000000000103",
  channel: "00000000-0000-7000-8000-00000000020a",
  root: "00000000-0000-7000-8000-000000000311",
  session: "019F9A10-0000-7000-8000-0000000000A1",
  teammateSession: "019F9A10-0000-7000-8000-0000000000A2",
}));
const fetchWorkSessions = vi.hoisted(() => vi.fn());

interface ClickPayload {
  id: string;
  target: string;
}

const shell = vi.hoisted(() => ({
  /** 셸이 클릭을 알려 주는가에 대한 답. 시험이 늦게 풀 수 있게 약속으로 둔다. */
  supported: Promise.resolve(true) as Promise<boolean>,
  outcome: "clickable" as "clickable" | "plain" | "refused",
  /** 페이지가 듣고 있는 클릭 처리기. 해제하면 비워진다. */
  deliver: null as ((payload: unknown) => void) | null,
}));
const showNotification = vi.hoisted(() => vi.fn());
const showClickable = vi.hoisted(() => vi.fn());
const fetchNotificationRules = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({
  isDesktop: () => true,
  showNotification: (...args: unknown[]) => showNotification(...args),
  notificationClickSupported: () => shell.supported,
  showClickableNotification: (...args: unknown[]) => showClickable(...args),
  onNotificationClick: (handler: (payload: unknown) => void) => {
    shell.deliver = handler;
    return Promise.resolve(() => {
      shell.deliver = null;
    });
  },
}));

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, fetchWorkSessions: (workspaceId: string) => fetchWorkSessions(workspaceId) as Promise<unknown> };
});

vi.mock("@momo/core/features/settings/notificationRules", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/notificationRules")>();
  return {
    ...actual,
    fetchNotificationRules: (workspaceId: string) => fetchNotificationRules(workspaceId) as Promise<NotificationRules>,
  };
});

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => ({
      groups: {
        channels: [{ id: IDS.channel, workspaceId: IDS.ws, kind: "public" as const, name: "ops", muted: false }],
        dms: [],
      },
    }),
    useDirectory: () => ({
      directory: actual.makeDirectory([
        {
          id: IDS.other,
          workspaceId: IDS.ws,
          kind: "human",
          status: "active",
          displayName: "이도현",
          handle: "dohyun",
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

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;
let onMessage: ((event: MessageNewEvent) => void) | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  showNotification.mockReset();
  showNotification.mockResolvedValue(true);
  showClickable.mockReset();
  showClickable.mockImplementation(() => Promise.resolve(shell.outcome));
  fetchNotificationRules.mockReset();
  fetchNotificationRules.mockResolvedValue({ dnd: false, mentionOverridesMute: false });
  fetchWorkSessions.mockReset();
  fetchWorkSessions.mockResolvedValue([]);
  ledger = [workSession()];
  resetViewedAgentSessionsForTest();
  shell.supported = Promise.resolve(true);
  shell.outcome = "clickable";
  shell.deliver = null;
  onMessage = null;
  resetBannerClicksForTest();
  localStorage.clear();
  reloadDesktopNotificationKindsForTest(localStorage);
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
});

afterEach(() => {
  osNotifier().flush();
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  reloadDesktopNotificationKindsForTest(null);
  resetBannerClicksForTest();
  vi.restoreAllMocks();
});

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
      { client: seededClient() },
      createElement(
        SessionProvider,
        { value: sessionValue() },
        createElement(() => {
          const location = useLocation();
          return createElement(
            "div",
            null,
            createElement(DesktopNotifications),
            // 이동 횟수까지 읽으려고 location.key 도 싣는다(같은 주소로 다시 가도 키는 새로 난다).
            createElement(
              "output",
              { "data-testid": "notification-route", "data-key": location.key },
              location.pathname + location.search
            )
          );
        })
      )
    )
  );
  act(() => mountedRoot?.render(tree));
  return host;
}

const routeOf = (host: HTMLElement) => host.querySelector('[data-testid="notification-route"]')?.textContent;

/** 약속이 풀리는 만큼의 미세 작업 차례를 흘려보낸다(배너 보내기는 약속 사슬이다). */
async function drain(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

/** 마운트하고 셸의 「클릭을 알려 주는가」 답이 페이지에 닿을 때까지 흘려보낸다. */
async function mountSettled(path = "/"): Promise<HTMLElement> {
  const host = mountRail(path);
  await act(async () => {
    await drain();
  });
  return host;
}

/** 이벤트 하나(또는 여럿)를 알림 레일에 넣고 묶음을 지금 보낸다. */
async function fire(...events: MessageNewEvent[]): Promise<void> {
  await act(async () => {
    for (const event of events) onMessage?.(event);
    osNotifier().flush();
    await drain();
  });
}

/** 셸이 보낸 클릭 이벤트가 페이지에 닿는다. */
function click(payload: unknown): void {
  act(() => shell.deliver?.(payload));
}

/** 셸에 실제로 보낸 클릭 가능한 배너의 `{ id, target }`. */
function sentClick(index = 0): ClickPayload {
  const call = showClickable.mock.calls[index] as [string, string | undefined, ClickPayload] | undefined;
  if (call === undefined) throw new Error(`클릭 가능한 배너 ${index + 1}번째가 셸에 나가지 않았다`);
  return call[2];
}

function focusWindow(): void {
  act(() => window.dispatchEvent(new Event("focus")));
}

let ledger: WorkSession[] = [];

function workSession(overrides: Partial<WorkSession> = {}): WorkSession {
  return {
    id: IDS.session,
    workspaceId: IDS.ws,
    channelId: IDS.channel,
    memberId: IDS.self,
    hostId: "00000000-0000-7000-8000-000000000302",
    rootMessageId: IDS.root,
    tool: "claude",
    label: "UI 검수",
    status: "running",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    remoteDisplayAvailable: false,
    startedAtMs: 1_800_000_000_000,
    origin: "host",
    ...overrides,
  };
}

/** 세션 원장이 캐시에 있는 질의 클라이언트(앱에서는 A 칸 원천이 이 열쇠를 늘 읽고 있다). */
function seededClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (ledger.length > 0) client.setQueryData(["work-sessions", IDS.ws], ledger);
  return client;
}

/** 서버가 세션 스레드에 남기는 권한 요청 줄 그대로(`validated_acp_event`, 미리보기는 빠진다). */
function permissionEvent(overrides: { id?: string; session?: string; author?: string } = {}): MessageNewEvent {
  const now = Date.now();
  const session = overrides.session ?? IDS.session;
  return {
    type: "message.new",
    v: 1,
    ts: now,
    seq: 50,
    payload: {
      id: overrides.id ?? "019F9A10-0000-7000-8000-0000000000D1",
      channel_id: IDS.channel,
      seq: 50,
      type: "system",
      body: "Approval requested",
      author_member_id: overrides.author ?? IDS.self,
      hlc_ts: now,
      hlc_count: 0,
      root_id: IDS.root,
      props: {
        kind: "work_session_event",
        schema: "momo.work_session.acp_event.v1",
        source: "acp",
        event_id: "019F9A10-0000-7000-8000-0000000000C1",
        event_type: "approval.requested",
        event_ts: now,
        event: {
          run_id: session,
          work_session_id: session,
          channel_id: IDS.channel,
          action: "requested",
          action_type: "tool_call",
          status: "pending",
          options: [
            { option_id: "allow", name: "Allow once", kind: "allow_once" },
            { option_id: "reject", name: "Reject", kind: "reject_once" },
          ],
          preview_sha256: "a".repeat(64),
        },
      },
    },
  };
}

/** 원장 읽기(약속) 뒤의 다시 판정과 묶음 보내기까지 흘려보낸다. */
async function settleRefetch(): Promise<void> {
  await act(async () => {
    await drain();
    osNotifier().flush();
    await drain();
  });
}

const CARD_ROUTE = `/work?view=terminals&agent=${IDS.session.toLowerCase()}`;

describe("작업 권한 요청 → 데스크탑 OS 배너 (#5595)", () => {
  it("세션 주인에게 배너 한 장: 제목은 세션 이름, 본문은 사전 문장. 서버의 영어 본문·선택지 이름은 싣지 않는다", async () => {
    await mountSettled();
    await fire(permissionEvent());

    expect(showClickable).toHaveBeenCalledTimes(1);
    const [title, body] = showClickable.mock.calls[0] as [string, string | undefined, ClickPayload];
    expect(title).toBe("UI 검수");
    // 본문은 사전 문장을 지금 언어로 읽는다(이 시험의 화면은 언어 공급자 없이 기본 en-US다. 한국어 화면은 「맥의 작업이 권한 확인을 기다려요.」).
    expect(body).toBe("A task on your Mac is waiting for your permission.");
    expect(JSON.stringify(showClickable.mock.calls[0])).not.toMatch(/Approval requested|Allow once|Reject/);
    expect(sentClick().target).toBe(CARD_ROUTE);
  });

  it("누르면 그 세션의 승인 카드(A 칸)를 여는 주소로 간다 — 채널·스레드가 아니다", async () => {
    const host = await mountSettled();
    await fire(permissionEvent());
    expect(routeOf(host)).toBe("/");

    click(sentClick());

    expect(routeOf(host)).toBe(CARD_ROUTE);
  });

  it("남의 세션 요청은 같은 채널에 있어도 뜨지 않는다(ADR-0188 D3·D5) — 작성자가 누구든", async () => {
    ledger = [workSession({ id: IDS.teammateSession, memberId: IDS.other, label: "남의 작업" })];
    await mountSettled();
    await fire(
      permissionEvent({ session: IDS.teammateSession, author: IDS.other, id: "019F9A10-0000-7000-8000-0000000000D2" }),
      permissionEvent({ session: IDS.teammateSession, author: IDS.self, id: "019F9A10-0000-7000-8000-0000000000D3" })
    );
    expect(showClickable).not.toHaveBeenCalled();
    expect(showNotification).not.toHaveBeenCalled();
    expect(fetchWorkSessions).not.toHaveBeenCalled();
  });

  it("이 기기가 모르는 세션이면 원장을 한 번 읽고 다시 판정한다: 내 세션이면 그때 뜬다", async () => {
    ledger = [];
    fetchWorkSessions.mockResolvedValue([workSession()]);
    await mountSettled();
    await fire(permissionEvent());
    await settleRefetch();
    expect(fetchWorkSessions).toHaveBeenCalledTimes(1);
    expect(fetchWorkSessions).toHaveBeenCalledWith(IDS.ws);
    expect(showClickable).toHaveBeenCalledTimes(1);
    expect(sentClick().target).toBe(CARD_ROUTE);
  });

  it("읽은 원장에도 없으면 추측하지 않는다: 배너 없음, 다시 묻지도 않는다", async () => {
    ledger = [];
    fetchWorkSessions.mockResolvedValue([]);
    await mountSettled();
    await fire(permissionEvent());
    await settleRefetch();
    expect(fetchWorkSessions).toHaveBeenCalledTimes(1);
    expect(showClickable).not.toHaveBeenCalled();
  });

  it("같은 요청이 두 번 와도(재연결·두 구독) 한 번만 뜬다", async () => {
    await mountSettled();
    await fire(permissionEvent());
    await fire(permissionEvent());
    expect(showClickable).toHaveBeenCalledTimes(1);
  });

  it("이 기기에서 승인 알림을 꺼 두었으면 뜨지 않는다(기존 설정 그대로)", async () => {
    localStorage.setItem("momo.web.notifications.v1", JSON.stringify({ approval: false }));
    reloadDesktopNotificationKindsForTest(localStorage);
    await mountSettled();
    await fire(permissionEvent());
    expect(showClickable).not.toHaveBeenCalled();
  });

  it("창이 앞이고 그 세션의 칸이 열려 있으면 조용하다. 칸이 닫혀 있으면 창이 앞이어도 뜬다", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await mountSettled();
    focusWindow();
    const release = viewAgentSession(IDS.session.toLowerCase());
    await fire(permissionEvent());
    expect(showClickable).not.toHaveBeenCalled();
    release();
    await fire(permissionEvent({ id: "019F9A10-0000-7000-8000-0000000000D4" }));
    expect(showClickable).toHaveBeenCalledTimes(1);
  });

  it("클릭을 못 알리는 셸에서는 어림으로 옮기지 않는다: 카드가 없는 채널·스레드로 데려가지 않는다", async () => {
    shell.supported = Promise.resolve(false);
    const host = await mountSettled();
    await fire(permissionEvent());
    expect(showNotification).toHaveBeenCalledTimes(1);
    focusWindow();
    expect(routeOf(host)).toBe("/");
  });
});
