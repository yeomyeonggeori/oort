// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError, type Message, type ReadState, type RosterMember } from "@momo/core/lib/api";
import { markAt3Cursor10 } from "@momo/core/features/readState/proof";
import {
  MARK_UNREAD_ACTION_LABEL,
  markUnreadFailureMessage,
} from "@momo/core/features/readState/copy";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { useMarkUnread } from "./useMarkUnread";
import { MessageRow } from "./MessageRow";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = markAt3Cursor10().channelId;

const advertiseReadState = vi.hoisted(() => vi.fn());

vi.mock("@/features/chat/advertiseReadState", () => ({
  advertiseReadState: (
    workspaceId: string,
    channelId: string,
    lastReadSeq: number,
    reason: string,
    extra?: { markUnreadBeforeSeq?: number }
  ) =>
    advertiseReadState(
      workspaceId,
      channelId,
      lastReadSeq,
      reason,
      extra
    ) as Promise<ReadState>,
}));

vi.mock("@/features/directory/memberProfileContext", () => ({
  useOpenMemberProfile: () => () => undefined,
}));

vi.mock("@/features/reminders/RemindDialog", () => ({
  RemindDialog: () => null,
}));

vi.mock("@/features/emoji/EmojiPickerDialog", () => ({
  EmojiPickerDialog: () => null,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return this.parentElement;
    },
  });
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    };
  }
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  host?.remove();
  host = null;
  advertiseReadState.mockReset();
});

function Inner({
  onDone,
}: {
  onDone: (error: string | null) => void;
}) {
  const mark = useMarkUnread(WS);
  return createElement(
    "button",
    {
      type: "button",
      "data-testid": "run-mark",
      onClick: () => {
        void mark
          .run({
            channelId: CH,
            lastReadSeq: 10,
            seq: 3,
          })
          .then(() => onDone(null))
          .catch((error: unknown) => {
            onDone(error instanceof Error ? error.message : String(error));
          });
      },
    },
    MARK_UNREAD_ACTION_LABEL
  );
}

function HookHarness({
  client,
  onDone,
}: {
  client: QueryClient;
  onDone: (error: string | null) => void;
}) {
  return createElement(
    QueryClientProvider,
    { client },
    createElement(Inner, { onDone })
  );
}

function member(): RosterMember {
  return {
    id: ME,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "곽성재",
    handle: "seongjae",
    role: "member",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function textMessage(seq: number): Message {
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    channelId: CH,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: ME,
    type: "text",
    body: "prometheus mem_limit 붙였어요.",
    state: "sent",
    createdAtMs: seq * 1000,
  };
}

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: {
        id: ME,
        workspaceId: WS,
        kind: "human",
        displayName: "곽성재",
        handle: "seongjae",
      },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

describe("마크 낙관과 400 롤백", () => {
  it("400 이면 로컬 마크가 되돌아가고 행의 InlineBanner 가 선다 (토스트 없음)", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const unmarked: ReadState = {
      ...markAt3Cursor10(),
      markedUnreadBeforeSeq: null,
    };
    client.setQueryData(["read-state", WS], [unmarked]);
    advertiseReadState.mockRejectedValue(
      new ApiError(400, "mark_unread_before_seq must name an existing seq")
    );

    host = document.createElement("div");
    document.body.append(host);
    mountedRoot = createRoot(host);
    let banner: string | null = null;
    act(() => {
      mountedRoot?.render(
        createElement(HookHarness, {
          client,
          onDone: (message) => {
            banner = message;
          },
        })
      );
    });

    await act(async () => {
      host?.querySelector("button")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const cached = client.getQueryData<ReadState[]>(["read-state", WS]);
    expect(cached?.[0]?.markedUnreadBeforeSeq).toBeNull();
    expect(banner).toBe(markUnreadFailureMessage(new ApiError(400, "x")));
    expect(banner).not.toContain("mark_unread_before_seq");
    expect(advertiseReadState).toHaveBeenCalledWith(WS, CH, 10, "mark_unread", {
      markUnreadBeforeSeq: 3,
    });
  });

  it("MessageRow 가 실패하면 행 아래 InlineBanner 를 그린다", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(["read-state", WS], [
      { ...markAt3Cursor10(), markedUnreadBeforeSeq: null },
    ]);
    advertiseReadState.mockRejectedValue(
      new ApiError(400, "mark_unread_before_seq must name an existing seq")
    );

    host = document.createElement("div");
    document.body.append(host);
    mountedRoot = createRoot(host);

    function RowHarness() {
      return createElement(
        SessionProvider,
        { value: sessionValue() },
        createElement(
          QueryClientProvider,
          { client },
          createElement(MessageRow, {
            message: textMessage(3),
            startsGroup: true,
            directory: makeDirectory([member()]),
            actions: {
              myMemberId: ME,
              chips: [],
              onToggleReaction: () => undefined,
              pinned: false,
              onTogglePin: () => undefined,
              onEditMessage: async () => undefined,
              onDeleteMessage: async () => undefined,
            },
          })
        )
      );
    }

    act(() => {
      mountedRoot?.render(createElement(RowHarness));
    });

    const row = host.querySelector<HTMLElement>('[data-testid="timeline-message"]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute("data-actionable")).toBe("true");
    await act(async () => {
      row?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 12,
          clientY: 40,
        })
      );
      await Promise.resolve();
    });
    const item = document.querySelector<HTMLElement>(
      '[data-testid="context-mark-unread"]'
    );
    expect(item).not.toBeNull();
    await act(async () => {
      item?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const alert = document.querySelector('[data-testid="message-action-error"]');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toContain("더 이상 없습니다");
    expect(alert?.querySelector("button")?.textContent).toContain("닫기");
  });

  it("성공 응답의 marked_unread_before_seq null 은 로컬 마크를 지운다", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(["read-state", WS], [markAt3Cursor10()]);
    advertiseReadState.mockResolvedValue({
      ...markAt3Cursor10(),
      markedUnreadBeforeSeq: null,
    });

    host = document.createElement("div");
    document.body.append(host);
    mountedRoot = createRoot(host);
    act(() => {
      mountedRoot?.render(
        createElement(HookHarness, {
          client,
          onDone: () => undefined,
        })
      );
    });

    await act(async () => {
      host?.querySelector("button")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const cached = client.getQueryData<ReadState[]>(["read-state", WS]);
    expect(cached?.[0]?.markedUnreadBeforeSeq).toBeNull();
  });

  it("롤백은 그 채널 행만 되돌리고 다른 채널의 동시 갱신을 덮지 않는다", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const other: ReadState = {
      ...markAt3Cursor10(),
      channelId: "00000000-0000-7000-8000-000000000299",
      markedUnreadBeforeSeq: null,
      lastReadSeq: 4,
    };
    const target: ReadState = {
      ...markAt3Cursor10(),
      markedUnreadBeforeSeq: null,
    };
    client.setQueryData(["read-state", WS], [target, other]);
    advertiseReadState.mockImplementation(async () => {
      client.setQueryData<ReadState[]>(["read-state", WS], (current) =>
        (current ?? []).map((row) =>
          row.channelId === other.channelId
            ? { ...row, lastReadSeq: 99, latestSeq: 99 }
            : row
        )
      );
      throw new ApiError(400, "gone");
    });

    host = document.createElement("div");
    document.body.append(host);
    mountedRoot = createRoot(host);
    act(() => {
      mountedRoot?.render(
        createElement(HookHarness, {
          client,
          onDone: () => undefined,
        })
      );
    });

    await act(async () => {
      host?.querySelector("button")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const cached = client.getQueryData<ReadState[]>(["read-state", WS]);
    const restored = cached?.find((row) => row.channelId === CH);
    const kept = cached?.find((row) => row.channelId === other.channelId);
    expect(restored?.markedUnreadBeforeSeq).toBeNull();
    expect(kept?.lastReadSeq).toBe(99);
  });

  it("낙관 반영 전에 진행 중 GET 을 취소한다", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(["read-state", WS], [
      { ...markAt3Cursor10(), markedUnreadBeforeSeq: null },
    ]);
    const cancel = vi.spyOn(client, "cancelQueries");
    advertiseReadState.mockResolvedValue(markAt3Cursor10());

    host = document.createElement("div");
    document.body.append(host);
    mountedRoot = createRoot(host);
    act(() => {
      mountedRoot?.render(
        createElement(HookHarness, {
          client,
          onDone: () => undefined,
        })
      );
    });

    await act(async () => {
      host?.querySelector("button")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(cancel).toHaveBeenCalledWith({
      queryKey: ["read-state", WS],
    });
  });
});
