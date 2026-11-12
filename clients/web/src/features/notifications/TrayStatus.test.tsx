// @vitest-environment jsdom

import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { onEntryDismiss } from "@momo/core/features/notifications/entryDismiss";
import type { AdeItem } from "@momo/core/features/work/adeControl";
import type { ReadState } from "@momo/core/lib/api";
import { holdGlobalShortcuts } from "@/app/globalShortcutHold";
import type { TrayStatusWire } from "@/lib/tauri";
import { CLOSE_NOTICE_STORAGE_KEY } from "./closeNotice";
import { DockBadge } from "./DockBadge";
import {
  reloadDesktopNotificationKindsForTest,
  setDesktopNotificationKind,
} from "./preference";
import { TrayStatus } from "./TrayStatus";

const hoisted = vi.hoisted(() => ({
  needsMe: 4,
  approvals: 0,
  panes: 0,
  readRows: [] as unknown[],
  refetchable: false,
  threadAnswers: [] as { status: number; body: unknown; delayMs?: number; after?: () => void }[],
  showNotification: vi.fn(async (_text: string, _body?: string, _options?: { ask?: boolean }) => true),
  items: [] as unknown[],
  adeProvided: true,
  adeArgs: [] as unknown[][],
  setDockBadge: vi.fn(async (_count: number) => true),
  setTrayStatus: vi.fn(async (_status: unknown) => true),
  trayHandler: null as ((payload: unknown) => void) | null,
  unlistened: 0,
  navigate: vi.fn(),
  openNewDm: vi.fn(),
  openWorkPanel: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  isDesktop: () => true,
  setDockBadge: (n: number) => hoisted.setDockBadge(n),
  setTrayStatus: (s: unknown) => hoisted.setTrayStatus(s),
  showNotification: (text: string, body?: string, options?: { ask?: boolean }) =>
    hoisted.showNotification(text, body, options),
  onTrayAction: (handler: (payload: unknown) => void) => {
    hoisted.trayHandler = handler;
    return Promise.resolve(() => {
      hoisted.unlistened += 1;
    });
  },
}));
vi.mock("@/app/session", () => ({ useSession: () => ({ workspaceId: "w" }) }));
vi.mock("@/features/inbox/useNeedsMe", () => ({
  useNeedsMeCount: () => hoisted.needsMe,
  useNeedsMe: () => ({
    approvals: hoisted.approvals,
    panes: hoisted.panes,
    mentions: 0,
    total: hoisted.needsMe,
  }),
}));
// 읽음 투영은 실제 캐시(`["read-state", "w"]`)에 얹는다: 응답 줄을 캐시에 끼우는 길과 끝의 다시 읽기를 합계로 잴 수 있다.
// 다시 읽기가 가짜 서버의 현재 줄(`hoisted.readRows`)을 돌려줄지는 시험이 정한다(`refetchable`).
vi.mock("@/features/workspace/useWorkspace", async () => {
  const actual = await vi.importActual<typeof import("@/features/workspace/useWorkspace")>("@/features/workspace/useWorkspace");
  const { useQuery } = await import("@tanstack/react-query");
  return {
    applyReadStateToCache: actual.applyReadStateToCache,
    applyFollowedThreadShareToCache: actual.applyFollowedThreadShareToCache,
    useChannels: () => ({
      groups: {
        channels: [{ id: "0a1b2c3d-0000-4000-8000-0000000000c1" }, { id: "0a1b2c3d-0000-4000-8000-0000000000c3" }],
        dms: [{ id: "dm1" }, { id: "dm2" }],
      },
    }),
    useReadStates: () => {
      const query = useQuery<ReadState[]>({
        queryKey: ["read-state", "w"],
        queryFn: async () => hoisted.readRows as ReadState[],
        enabled: hoisted.refetchable,
        initialData: hoisted.readRows as ReadState[],
        staleTime: Infinity,
      });
      const data = query.data ?? [];
      return {
        byChannel: new Map<string, unknown>([
          ["dm1", { unreadCount: 2 }],
          ["dm2", { unreadCount: 3 }],
          ...data.map((row) => [row.channelId, row] as [string, unknown]),
        ]),
        data,
      };
    },
  };
});
vi.mock("@momo/core/features/workspace/directory", async (importActual) => ({
  ...(await importActual<typeof import("@momo/core/features/workspace/directory")>()),
  unreadFor: (m: Map<string, { unreadCount: number }>, id: string) => m.get(id) ?? null,
}));
vi.mock("@/features/ade/useAdeControl", () => ({
  useAdeControl: (...args: unknown[]) => {
    hoisted.adeArgs.push(args);
    return { items: hoisted.items };
  },
}));
vi.mock("@/features/capabilities/useSurfaceProvided", () => ({
  useSurfaceProvidedWhileOpen: (id: string) => id === "ade" && hoisted.adeProvided,
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => hoisted.navigate, useLocation: () => ({ pathname: "/" }) }));
vi.mock("@/features/directory/useNewDm", () => ({ useOpenNewDm: () => hoisted.openNewDm }));
vi.mock("@/features/agents/workLogStore", () => ({
  openWorkPanel: (...args: unknown[]) => hoisted.openWorkPanel(...args),
}));

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

const UUID = "0a1b2c3d-0000-4000-8000-";
const run: AdeItem = {
  key: "run|r1|c1",
  kind: "run",
  state: "blocked",
  durability: "unknown",
  channelId: `${UUID}0000000000c1`,
  title: "김인턴",
  detail: "",
  runId: `${UUID}000000000001`,
  memberId: `${UUID}0000000000a1`,
};
const session: AdeItem = {
  key: "session|s1",
  kind: "session",
  state: "working",
  durability: "unknown",
  channelId: `${UUID}0000000000c2`,
  title: "codex",
  detail: "",
  sessionId: `${UUID}0000000000e1`,
};

beforeAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
});
function readRow(channelId: string, over: Partial<ReadState> = {}): ReadState {
  return {
    channelId,
    lastReadSeq: 10,
    latestSeq: 10,
    unreadCount: 0,
    mentionCount: 0,
    markedUnreadBeforeSeq: null,
    ...over,
  };
}
let fetchMock: ReturnType<typeof vi.fn>;
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  hoisted.needsMe = 4;
  hoisted.approvals = 0;
  hoisted.panes = 0;
  hoisted.readRows = [];
  hoisted.refetchable = false;
  queryClient.clear();
  hoisted.threadAnswers = [];
  hoisted.showNotification.mockClear();
  hoisted.showNotification.mockImplementation(async () => true);
  // 모의 `/v1`: 읽음 위치를 올리는 요청(PUT read-state)에 그 채널의 새 상태로 답한다.
  fetchMock = vi.fn(async (url: unknown, init?: { body?: string }) => {
    // 스레드 읽음 길(#5689): 시험이 `hoisted.threadAnswers`에 답을 줄줄이 넣는다. 비어 있으면 「더 없음」.
    if (String(url).endsWith("/threads/read-all")) {
      const answer = hoisted.threadAnswers.shift() ?? { status: 200, body: { read_states: [], marked_thread_count: 0, has_more: false } };
      if (answer.delayMs) await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
      if (answer.status === 200) answer.after?.();
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
    }
    const channel = decodeURIComponent(String(url).split("/channels/")[1]?.split("/")[0] ?? "");
    const body = JSON.parse(init?.body ?? "{}") as { last_read_seq: number };
    return new Response(
      JSON.stringify({
        channel_id: channel,
        last_read_seq: body.last_read_seq,
        latest_seq: body.last_read_seq,
        unread_count: 0,
        mention_count: 0,
        marked_unread_before_seq: null,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  hoisted.items = [];
  hoisted.adeProvided = true;
  hoisted.adeArgs = [];
  hoisted.trayHandler = null;
  hoisted.unlistened = 0;
  for (const spy of [
    hoisted.setDockBadge,
    hoisted.setTrayStatus,
    hoisted.navigate,
    hoisted.openNewDm,
    hoisted.openWorkPanel,
  ]) {
    spy.mockClear();
  }
  localStorage.clear();
  // 이 파일의 다른 장면은 메뉴·줄을 잰다: DM 몫(#5660, 기본 켬)은 첫 장면만 따로 재고 여기서는 꺼 둔다.
  localStorage.setItem("momo.web.notifications.v1", JSON.stringify({ dockDms: false }));
  reloadDesktopNotificationKindsForTest(localStorage);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
  reloadDesktopNotificationKindsForTest(null);
});

/** 독 배지와 메뉴 막대를 함께 올린다: 둘이 같은 수를 보는지 보려면 같은 트리에 있어야 한다. */
function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  render();
}
function render() {
  // 시험이 `hoisted.readRows`를 바꾼 뒤 다시 그리면 그 줄이 캐시의 현재 값이 된다(누른 뒤에는 다시 그리지 않는다).
  queryClient.setQueryData(["read-state", "w"], hoisted.readRows);
  act(() =>
    root?.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Fragment, null, createElement(DockBadge), createElement(TrayStatus))
      )
    )
  );
}
const lastStatus = () => hoisted.setTrayStatus.mock.lastCall?.[0] as TrayStatusWire;
const pick = (payload: unknown) => act(() => hoisted.trayHandler?.(payload));

describe("TrayStatus: 셸로 보내기 (#5193)", () => {
  it("메뉴 막대의 수는 독 배지가 그리는 수와 늘 같다 — 기본(안 읽은 DM 포함, #5660), DM 끔, 배지 끔", () => {
    act(() => setDesktopNotificationKind("dockDms", true, localStorage));
    mount();
    const both = () => [
      hoisted.setDockBadge.mock.lastCall?.[0],
      lastStatus().unread,
    ];
    // 기본은 DM 몫을 더한다(4 + 5): 안 읽은 DM이 있으면 메뉴 막대 점도 켜진다.
    expect(both()).toEqual([9, 9]);
    hoisted.needsMe = 7;
    render();
    expect(both()).toEqual([12, 12]);
    // DM 스위치를 끄면 둘 다 needsMe 그대로, 독 배지를 끄면 둘 다 0이다.
    act(() => setDesktopNotificationKind("dockDms", false, localStorage));
    expect(both()).toEqual([7, 7]);
    act(() => setDesktopNotificationKind("dockBadge", false, localStorage));
    expect(both()).toEqual([0, 0]);
  });

  it("상태가 바뀔 때만 보낸다: 같은 내용으로 다시 그려도 부르지 않는다", () => {
    mount();
    expect(hoisted.setTrayStatus).toHaveBeenCalledTimes(1);
    render();
    render();
    expect(hoisted.setTrayStatus).toHaveBeenCalledTimes(1);
    hoisted.needsMe = 5;
    render();
    expect(hoisted.setTrayStatus).toHaveBeenCalledTimes(2);
    expect(lastStatus().unread).toBe(5);
    // 실행 중인 작업이 생겨도 한 번만 더 간다.
    hoisted.items = [run, session];
    render();
    render();
    expect(hoisted.setTrayStatus).toHaveBeenCalledTimes(3);
    expect(lastStatus().running.map((r) => r.title)).toEqual(["김인턴", "codex"]);
  });

  it("앱 셸이 내려가면 수 0·줄 없음·「새 메시지」 꺼짐으로 보낸다(낱말은 그대로)", () => {
    hoisted.items = [run];
    mount();
    expect(lastStatus()).toMatchObject({ unread: 4, compose: true });
    const labels = lastStatus().labels;
    act(() => root?.unmount());
    root = null;
    expect(lastStatus()).toEqual({
      unread: 0,
      compose: false,
      readAll: false,
      labels,
      running: [],
      more: null,
      remaining: null,
    });
  });

  it("「모두 읽음 처리」는 읽을 채널이 있을 때만 켜지고, 남은 일 줄은 승인·응답 필요 칸이 있을 때만 붙는다 (#5195)", () => {
    mount();
    // 읽을 것도 남는 것도 없다: 항목은 꺼지고 줄이 없다.
    expect(lastStatus()).toMatchObject({ readAll: false, remaining: null });
    hoisted.readRows = [readRow("dm1", { latestSeq: 3, lastReadSeq: 1, unreadCount: 2 })];
    render();
    expect(lastStatus().readAll).toBe(true);
    // 승인이 남아 있다: 눌러도 점이 남는 까닭을 한 줄로 말한다(항목이 꺼져 있어도 그 줄은 있다).
    hoisted.readRows = [];
    hoisted.approvals = 2;
    render();
    expect(lastStatus()).toMatchObject({
      readAll: false,
      remaining: "2 approvals are still waiting for you",
    });
    hoisted.approvals = 0;
    hoisted.panes = 1;
    render();
    expect(lastStatus().remaining).toBe("1 pane is still waiting for you");
    hoisted.approvals = 1;
    render();
    expect(lastStatus().remaining).toBe("1 approval and 1 pane are still waiting for you");
  });
});

describe("TrayStatus: 메뉴에서 고른 것 (#5193)", () => {
  it("「새 메시지」는 겹친 표면을 걷고 새 DM 모달을 연다", async () => {
    mount();
    await act(async () => {});
    const order: string[] = [];
    const off = onEntryDismiss(() => order.push("dismiss"));
    hoisted.openNewDm.mockImplementation(() => order.push("open"));
    pick({ action: "new-message" });
    off();
    expect(order).toEqual(["dismiss", "open"]);
  });

  it("작업 줄은 마지막으로 보낸 줄의 작업으로 간다: 턴은 작업 패널, 세션은 ?work= 주소", async () => {
    hoisted.items = [run, session];
    mount();
    await act(async () => {});
    const [first, second] = lastStatus().running;
    // 메뉴 막대도 알림 배너처럼 새 입구다: 이동 직전에 겹친 임시 표면을 걷는다(줄마다 한 번).
    const dismissed: string[] = [];
    const off = onEntryDismiss(() => dismissed.push("dismiss"));
    pick({ action: "run", id: first?.id });
    expect(hoisted.openWorkPanel).toHaveBeenCalledWith(
      {
        runId: run.runId,
        memberId: run.memberId,
        channelId: run.channelId,
        origin: "ade",
      },
      null
    );
    expect(hoisted.navigate).not.toHaveBeenCalled();
    expect(dismissed).toEqual(["dismiss"]);
    pick({ action: "run", id: second?.id });
    off();
    expect(dismissed).toEqual(["dismiss", "dismiss"]);
    expect(hoisted.navigate).toHaveBeenCalledTimes(1);
    expect(hoisted.navigate.mock.calls[0]?.[0]).toBe(
      `/c/${encodeURIComponent(session.channelId)}?work=${session.sessionId}`
    );
  });

  it("보낸 적 없는 id·끝난 작업·깨진 페이로드는 아무 데도 보내지 않는다", async () => {
    hoisted.items = [run, session];
    mount();
    await act(async () => {});
    const firstId = lastStatus().running[0]?.id;
    const dismissed: string[] = [];
    const off = onEntryDismiss(() => dismissed.push("dismiss"));
    for (const bad of [
      { action: "run", id: "r99" },
      { action: "run", id: "../../settings" },
      { action: "run" },
      { action: "nope" },
      null,
      "new-message",
    ]) {
      pick(bad);
    }
    // 작업이 끝나 줄에서 빠진 뒤에 메뉴에 남아 있던 옛 줄을 누른다.
    hoisted.items = [session];
    render();
    pick({ action: "run", id: firstId });
    off();
    // 아무 데도 가지 않았으니 겹친 표면도 걷지 않는다(보이는 것을 이유 없이 닫지 않는다).
    expect(dismissed).toEqual([]);
    expect(hoisted.openWorkPanel).not.toHaveBeenCalled();
    expect(hoisted.navigate).not.toHaveBeenCalled();
    expect(hoisted.openNewDm).not.toHaveBeenCalled();
  });

  it("한 번만 보이는 값을 쥔 화면이 있으면 전역 단축키처럼 물러선다", async () => {
    hoisted.items = [session];
    mount();
    await act(async () => {});
    const id = lastStatus().running[0]?.id;
    const release = holdGlobalShortcuts();
    pick({ action: "new-message" });
    pick({ action: "run", id });
    expect(hoisted.openNewDm).not.toHaveBeenCalled();
    expect(hoisted.navigate).not.toHaveBeenCalled();
    release();
    pick({ action: "new-message" });
    expect(hoisted.openNewDm).toHaveBeenCalledTimes(1);
  });

  it("내려가면 구독을 푼다", async () => {
    mount();
    await act(async () => {});
    expect(hoisted.unlistened).toBe(0);
    act(() => root?.unmount());
    root = null;
    expect(hoisted.unlistened).toBe(1);
  });
});

describe("TrayStatus: 모두 읽음 처리 (#5195)", () => {
  const MENTION_CH = "0a1b2c3d-0000-4000-8000-0000000000c1";
  const PLAIN_CH = "0a1b2c3d-0000-4000-8000-0000000000c2";
  const putCalls = () =>
    fetchMock.mock.calls
      .filter((call) => (call[1] as { method?: string } | undefined)?.method === "PUT")
      .map((call) => ({
        url: decodeURIComponent(String(call[0])),
        body: JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>,
      }));

  it("멘션이 있는 채널과 안 읽은 DM의 읽음 위치만 최신으로 올린다 — 승인·칸·그냥 안 읽은 채널은 건드리지 않는다", async () => {
    hoisted.readRows = [
      readRow(MENTION_CH, { latestSeq: 40, lastReadSeq: 30, unreadCount: 10, mentionCount: 2 }),
      readRow(PLAIN_CH, { latestSeq: 50, lastReadSeq: 20, unreadCount: 30 }),
      readRow("dm1", { latestSeq: 7, lastReadSeq: 5, unreadCount: 2 }),
      readRow("dm2"),
    ];
    hoisted.approvals = 3;
    hoisted.panes = 1;
    mount();
    await act(async () => {});
    pick({ action: "read-all" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    // 「읽음 처리」 메뉴와 같은 명시 행동(`explicit_open`)으로, 채널마다 PUT 하나다.
    const puts = putCalls();
    expect(puts.map((p) => p.url.split("/channels/")[1])).toEqual([
      `${MENTION_CH}/read-state`,
      "dm1/read-state",
    ]);
    expect(puts.map((p) => p.body)).toEqual([
      { last_read_seq: 40, read_intent: "explicit_open" },
      { last_read_seq: 7, read_intent: "explicit_open" },
    ]);
    // 승인과 칸에는 읽음이 없다: 결정 요청이나 작업 이동이 아무것도 가지 않았다. 창도 이 쪽에서 부르지 않는다.
    expect(hoisted.navigate).not.toHaveBeenCalled();
    expect(hoisted.openNewDm).not.toHaveBeenCalled();
    expect(hoisted.openWorkPanel).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.every((call) => String(call[0]).includes("/read-state"))).toBe(true);
  });

  it("읽을 채널이 없으면 아무것도 보내지 않는다", async () => {
    hoisted.readRows = [readRow(PLAIN_CH, { unreadCount: 30, latestSeq: 50 }), readRow("dm2")];
    mount();
    await act(async () => {});
    pick({ action: "read-all" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// 스레드 답글 몫(#5690, 서버 #5689). 채널 읽음 위치로는 끄지 않는다(받은함 「스레드」 줄까지 읽음이 되므로): 스레드 읽음 길만 부른다.
describe("TrayStatus: 모두 읽음 처리의 스레드 몫 (#5690)", () => {
  const MENTION_CH = "0a1b2c3d-0000-4000-8000-0000000000c1";
  const THREAD_CH = "0a1b2c3d-0000-4000-8000-0000000000c3";
  const settle = async () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  const calls = () =>
    fetchMock.mock.calls.map((call) => ({
      method: (call[1] as { method?: string } | undefined)?.method ?? "GET",
      url: decodeURIComponent(String(call[0])),
      // 본문이 없으면 null: 본문을 안 보내는 쪽으로 깨져도 `{}`로 읽혀 초록이 되지 않게 한다.
      body: (() => {
        const raw = (call[1] as { body?: string } | undefined)?.body;
        return raw === undefined ? null : (JSON.parse(raw) as Record<string, unknown>);
      })(),
    }));
  const wireRow = (channelId: string, over: object) => ({
    channel_id: channelId,
    last_read_seq: 10,
    latest_seq: 10,
    unread_count: 0,
    mention_count: 0,
    marked_unread_before_seq: null,
    ...over,
  });
  const ok = (over: object) => ({ status: 200, body: { read_states: [], marked_thread_count: 0, has_more: false, ...over } });

  it("답글 몫만 있어도 항목이 켜지고, 누르면 채널 읽음 위치는 올리지 않고 스레드 길만 {}로 부르며 hasMore가 거짓이 될 때까지 되부른다", async () => {
    hoisted.readRows = [readRow(THREAD_CH, { followedUnreadReplyCount: 3 })];
    hoisted.threadAnswers = [ok({ marked_thread_count: 100, has_more: true }), ok({ marked_thread_count: 5 })];
    mount();
    expect(lastStatus().readAll).toBe(true);
    pick({ action: "read-all" });
    await settle();
    expect(calls().map((c) => [c.method, c.url.replace(/^.*\/v1/, ""), c.body])).toEqual([
      ["POST", "/workspaces/w/threads/read-all", {}],
      ["POST", "/workspaces/w/threads/read-all", {}],
    ]);
  });

  it("멘션 채널과 답글 몫이 같이 있으면 채널 위치와 스레드 길을 둘 다 부른다(서로 기다리지 않는다)", async () => {
    hoisted.readRows = [
      readRow(MENTION_CH, { latestSeq: 40, lastReadSeq: 30, unreadCount: 10, mentionCount: 2 }),
      readRow(THREAD_CH, { followedUnreadReplyCount: 1 }),
    ];
    mount();
    pick({ action: "read-all" });
    await settle();
    expect(calls().map((c) => c.method).sort()).toEqual(["POST", "PUT"]);
    expect(calls().filter((c) => c.method === "PUT").map((c) => c.url.split("/channels/")[1])).toEqual([`${MENTION_CH}/read-state`]);
  });

  it("답글 몫이 없으면 스레드 길을 부르지 않는다", async () => {
    hoisted.readRows = [readRow(MENTION_CH, { latestSeq: 40, lastReadSeq: 30, mentionCount: 1, followedUnreadReplyCount: 0 })];
    mount();
    pick({ action: "read-all" });
    await settle();
    expect(calls().map((c) => c.method)).toEqual(["PUT"]);
  });

  it("서버가 이 길을 모르는 판(404)과 실패(500)에서도 던지지 않고, 다시 누를 수 있다", async () => {
    hoisted.readRows = [readRow(THREAD_CH, { followedUnreadReplyCount: 2 })];
    hoisted.threadAnswers = [
      { status: 404, body: { error: { message: "nf" } } },
      { status: 500, body: { error: { message: "boom" } } },
      ok({ marked_thread_count: 2 }),
    ];
    mount();
    for (let press = 0; press < 3; press += 1) {
      pick({ action: "read-all" });
      await settle();
    }
    expect(calls().filter((c) => c.method === "POST")).toHaveLength(3);
    expect(lastStatus().readAll).toBe(true); // 응답을 못 받은 동안 남은 수는 그대로라 단추도 그대로다
    expect(lastStatus().unread).toBe(6); // 합계(응답 필요 4 + 답글 몫 2)도 그대로
  });

  // 「누른 뒤 합계 0」(#5690 검수 M2). 읽음 투영 캐시를 실제로 얹었다. 아래 둘은 한 곳씩만 0으로 만들 수 있게 짠다:
  // 앞은 다시 읽기를 끄고(응답 줄 끼우기만), 뒤는 응답 줄을 비우고(다시 읽기만) 본다.
  const serverReads = (rows: ReadState[]) => () => {
    hoisted.readRows = rows;
  };

  it("누르면 응답 줄의 답글 몫이 캐시에 끼워져 합계가 줄고 「모두 읽음」 항목이 꺼진다(다시 읽기 없이도)", async () => {
    hoisted.readRows = [readRow(THREAD_CH, { followedUnreadReplyCount: 3 })];
    hoisted.threadAnswers = [ok({ marked_thread_count: 3, read_states: [wireRow(THREAD_CH, { followed_unread_reply_count: 0 })] })];
    mount();
    expect(lastStatus()).toMatchObject({ unread: 7, readAll: true });
    pick({ action: "read-all" });
    await settle();
    expect(lastStatus()).toMatchObject({ unread: 4, readAll: false });
  });

  it("누르면 끝의 읽음 투영 다시 읽기가 서버의 현재 줄로 맞춘다(응답 줄이 비어도)", async () => {
    hoisted.refetchable = true;
    hoisted.readRows = [readRow(THREAD_CH, { followedUnreadReplyCount: 3 })];
    hoisted.threadAnswers = [{ ...ok({ marked_thread_count: 3 }), after: serverReads([readRow(THREAD_CH, { followedUnreadReplyCount: 0 })]) }];
    mount();
    expect(lastStatus()).toMatchObject({ unread: 7, readAll: true });
    pick({ action: "read-all" });
    await settle();
    expect(lastStatus()).toMatchObject({ unread: 4, readAll: false });
  });

  it("서버가 500이면 합계와 항목이 그대로다", async () => {
    hoisted.readRows = [readRow(THREAD_CH, { followedUnreadReplyCount: 3 })];
    hoisted.threadAnswers = [{ status: 500, body: { error: { message: "boom" } } }];
    mount();
    pick({ action: "read-all" });
    await settle();
    expect(lastStatus()).toMatchObject({ unread: 7, readAll: true });
  });

  it("채널 읽음 응답 뒤에 옛 위치·멘션 수를 실은 스레드 응답 줄이 늦게 와도 멘션 수가 되살아나지 않는다(답글 몫만 끼운다)", async () => {
    hoisted.readRows = [readRow(MENTION_CH, { latestSeq: 40, lastReadSeq: 30, unreadCount: 10, mentionCount: 2, followedUnreadReplyCount: 3 })];
    hoisted.threadAnswers = [
      {
        ...ok({
          marked_thread_count: 3,
          read_states: [wireRow(MENTION_CH, { last_read_seq: 30, latest_seq: 40, unread_count: 10, mention_count: 2, followed_unread_reply_count: 0 })],
        }),
        delayMs: 30,
      },
    ];
    mount();
    pick({ action: "read-all" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    const row = (queryClient.getQueryData(["read-state", "w"]) as ReadState[])[0];
    expect(row).toMatchObject({ lastReadSeq: 40, unreadCount: 0, mentionCount: 0, followedUnreadReplyCount: 0 });
    expect(lastStatus().readAll).toBe(false);
  });
});

describe("TrayStatus: 창을 치웠다는 안내 (#5196)", () => {
  const settle = async () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

  it("처음 한 번만 OS 알림으로 말하고, 보인 뒤에는 다시 말하지 않는다", async () => {
    mount();
    await act(async () => {});
    pick({ action: "window-hidden" });
    await settle();
    expect(hoisted.showNotification).toHaveBeenCalledTimes(1);
    // 권한을 묻지 않는 호출이다(`ask: false`): 창이 막 사라진 순간에 OS 권한 창이 뜨지 않는다.
    expect(hoisted.showNotification).toHaveBeenCalledWith(
      "Closing the window keeps oort in the menu bar, so you still get notifications",
      undefined,
      { ask: false }
    );
    expect(localStorage.getItem(CLOSE_NOTICE_STORAGE_KEY)).not.toBeNull();
    pick({ action: "window-hidden" });
    await settle();
    expect(hoisted.showNotification).toHaveBeenCalledTimes(1);
  });

  it("배너가 안 떴으면(알림이 꺼져 있다) 쓰지 않는다: 나중에 켜면 그때가 처음이다", async () => {
    hoisted.showNotification.mockImplementation(async () => false);
    mount();
    await act(async () => {});
    pick({ action: "window-hidden" });
    await settle();
    expect(hoisted.showNotification).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(CLOSE_NOTICE_STORAGE_KEY)).toBeNull();
    hoisted.showNotification.mockImplementation(async () => true);
    pick({ action: "window-hidden" });
    await settle();
    expect(hoisted.showNotification).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(CLOSE_NOTICE_STORAGE_KEY)).not.toBeNull();
  });
});

describe("TrayStatus: 관제 표면 판정 (#5193)", () => {
  const lastAdeArgs = () => hoisted.adeArgs[hoisted.adeArgs.length - 1];

  // 관제 줄과 서랍은 `SurfaceGate` 뒤라 호스트가 없는 곳에서는 마운트되지 않는다. 셸에 늘 마운트된 이 컴포넌트는 같은 판정으로
  // 세션 읽기를 직접 꺼야 한다(안 그러면 호스트가 없는 워크스페이스에서도 원장을 20초마다 묻는다).
  it("관제 표면이 서 있을 때만 세션 읽기를 켠다", () => {
    hoisted.adeProvided = false;
    mount();
    expect(lastAdeArgs()).toEqual([false, false]);
    hoisted.adeProvided = true;
    render();
    expect(lastAdeArgs()).toEqual([false, true]);
  });
});
