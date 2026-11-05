// @vitest-environment jsdom

import { act, createElement, forwardRef, useImperativeHandle, type ReactElement, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { koreanLocale } from "@/testing/koLocale";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import type { PendingMessage } from "@momo/core/features/timeline/model";
import type { SendFailureKind } from "@momo/core/features/connection/sendFailure";
import type { ConnectionCause } from "@momo/core/features/connection/model";
import { Timeline } from "./Timeline";

// =============================================================================
// #5221: 타임라인의 실패 곳. 진짜 `Timeline`·`PendingRow`를 그려(가상 목록과 두 대화상자만 가짜) 배선을 잰다.
//   - 보내지 못한 행이 둘 이상이면 「모두 다시 보내기」가 **마지막** 실패 행 아래에 한 번만 서고 개수를 말한다.
//   - 실패 행마다 원인 한 줄이 그 행의 종류를 따라간다.
//   - 불러오기가 실패했을 때: 받아 둔 글이 없으면 제목 + 이유 한 줄 + 다시 시도 상자, 있으면 목록은 그대로 두고 위 한 줄만.
//     이유는 원인의 닫힌 분류 문장이고 상태 코드·서버 원문은 없다.
// =============================================================================

const virtuoso = vi.hoisted(() => ({ data: [] as { kind: string; key: string }[] }));
vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(function MockVirtuoso(
    props: {
      data: { kind: string; key: string }[];
      itemContent: (index: number, item: { kind: string; key: string }) => ReactElement;
    },
    ref: Ref<{ scrollToIndex: (opts: unknown) => void }>
  ) {
    virtuoso.data = props.data;
    useImperativeHandle(ref, () => ({ scrollToIndex: () => undefined }));
    return createElement(
      "div",
      { "data-testid": "timeline-virtuoso" },
      props.data.map((item, index) => createElement("div", { key: item.key }, props.itemContent(index, item)))
    );
  }),
}));
vi.mock("@/features/reminders/RemindDialog", () => ({ RemindDialog: () => null }));
vi.mock("@/features/emoji/EmojiPickerDialog", () => ({ EmojiPickerDialog: () => null }));

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "0199cccc-0000-7000-8000-000000000201";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-0000000000a1";
const AGENT = "00000000-0000-7000-8000-0000000000b1";
const BASE_MS = 1_700_000_000_000;

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
let ko: AppLocale;

beforeAll(async () => {
  ko = await koreanLocale();
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
});
beforeEach(() => {
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
  vi.unstubAllGlobals();
});

function member(id: string, name: string, kind: "human" | "agent" = "human"): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind,
    status: "active",
    displayName: name,
    handle: name,
    role: "member",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}
const directory = makeDirectory([member(ME, "정하윤"), member(OTHER, "가영"), member(AGENT, "김인턴", "agent")]);

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "정하윤", handle: "hayun" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

const actions = {
  myMemberId: ME,
  onToggleReaction: vi.fn(),
  onTogglePin: vi.fn(),
  onEditMessage: vi.fn(),
  onDeleteMessage: vi.fn(),
};

function text(seq: number, over: Partial<Message> = {}): Message {
  return {
    id: `0199eeee-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    channelId: CH,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: ME,
    type: "text",
    body: `메시지 ${seq}`,
    state: "sent",
    createdAtMs: BASE_MS + seq * 1_000,
    ...over,
  };
}


function pendingRow(id: string, status: "failed" | "sending", body: string, at: number): PendingMessage {
  return {
    clientMsgId: id,
    channelId: CH,
    authorMemberId: ME,
    body,
    createdAtMs: BASE_MS + at,
    sinceSeq: 1,
    status,
  };
}

function show(props: {
  messages?: Message[];
  pending?: PendingMessage[];
  failureKinds?: ReadonlyMap<string, SendFailureKind>;
  onResendAllPending?: () => Promise<void> | void;
  status?: "loading" | "ready" | "error";
  loadCause?: ConnectionCause | null;
  onRetry?: () => void;
}): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (host === null) {
    host = document.createElement("div");
    document.body.append(host);
    mountedRoot = createRoot(host);
  }
  const node = createElement(
    SessionProvider,
    { value: sessionValue() },
    createElement(
      OpenMemberProfileContext.Provider,
      { value: () => undefined },
      createElement(
        QueryClientProvider,
        { client },
        createElement(LocaleProvider, {
          locale: ko,
          children: createElement(Timeline, {
            messages: props.messages ?? [text(1)],
            directory,
            status: props.status ?? "ready",
            loadCause: props.loadCause ?? null,
            onRetry: props.onRetry,
            reachedStart: true,
            actions,
            onOpenThread: () => undefined,
            pending: props.pending,
            onResendPending: () => undefined,
            onDiscardPending: () => undefined,
            failureKinds: props.failureKinds,
            onResendAllPending: props.onResendAllPending,
          }),
        })
      )
    )
  );
  act(() => mountedRoot?.render(node));
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-testid="timeline-pending"]')];
}

describe("Timeline: 보내지 못한 행", () => {
  // 지키는 것: 모두 다시 보내기는 실패가 둘 이상일 때 마지막 실패 행 아래에 한 번만 선다(보내는 중인 행은 세지 않는다).
  it("실패 행이 셋이면 마지막 실패 행 아래에만 「3개 모두 다시 보내기」가 서고, 누르면 핸들러가 한 번 불린다", async () => {
    const onResendAllPending = vi.fn();
    show({
      pending: [
        pendingRow("a", "failed", "첫째", 10),
        pendingRow("b", "failed", "둘째", 20),
        pendingRow("c", "failed", "셋째", 30),
        pendingRow("d", "sending", "넷째", 40),
      ],
      failureKinds: new Map<string, SendFailureKind>([
        ["a", "server"],
        ["b", "rejected"],
      ]),
      onResendAllPending,
    });
    const all = rows();
    expect(all.map((row) => row.getAttribute("data-client-msg-id"))).toEqual(["a", "b", "c", "d"]);
    const buttons = [...document.querySelectorAll<HTMLElement>('[data-testid="pending-resend-all"]')];
    expect(buttons).toHaveLength(1);
    expect(all[2]?.contains(buttons[0] ?? null)).toBe(true);
    expect(buttons[0]?.textContent).toBe("3개 모두 다시 보내기");
    await act(async () => {
      buttons[0]?.click();
    });
    expect(onResendAllPending).toHaveBeenCalledTimes(1);
  });

  it("실패 행이 하나이거나 실패가 없으면 모두 다시 보내기는 서지 않는다", () => {
    show({
      pending: [pendingRow("a", "failed", "첫째", 10), pendingRow("d", "sending", "넷째", 40)],
      onResendAllPending: vi.fn(),
    });
    expect(document.querySelector('[data-testid="pending-resend-all"]')).toBeNull();
  });

  // 지키는 것: 원인 한 줄이 행마다 그 행의 종류를 따라간다(다른 행의 종류를 빌리지 않는다).
  it("행마다 자기 원인 한 줄을 말하고, 종류가 없는 행은 「전송 실패」다", () => {
    show({
      pending: [
        pendingRow("a", "failed", "첫째", 10),
        pendingRow("b", "failed", "둘째", 20),
        pendingRow("c", "failed", "셋째", 30),
      ],
      failureKinds: new Map<string, SendFailureKind>([
        ["a", "offline"],
        ["b", "rejected"],
      ]),
    });
    const reasons = [...document.querySelectorAll('[data-testid="pending-failed-reason"]')].map((el) => el.textContent);
    expect(reasons).toEqual(["오프라인이라 보내지 못했어요", "서버가 받지 못했어요", "전송 실패"]);
  });
});

describe("Timeline: 불러오기 실패", () => {
  // 지키는 것: 받아 둔 글이 없으면 상자(제목 + 이유 + 다시 시도), 이유는 원인을 따라간다.
  it("받아 둔 글이 없으면 상자가 서고 이유 한 줄이 원인을 따라간다. 다시 시도가 부른다", async () => {
    const reasons: [ConnectionCause | null, string][] = [
      ["deviceOffline", "오프라인이에요. 연결되면 다시 불러올 수 있어요."],
      ["serverUnreachable", "서버에 닿지 못했어요."],
      [null, "문제가 생겼어요."],
    ];
    for (const [cause, reason] of reasons) {
      const onRetry = vi.fn();
      show({ messages: [], status: "error", loadCause: cause, onRetry });
      const box = document.querySelector<HTMLElement>('[data-testid="timeline-error"]');
      expect(box).not.toBeNull();
      expect(box?.textContent).toContain("대화를 불러오지 못했어요");
      expect(box?.querySelector('[data-testid="load-failure-reason"]')?.textContent).toBe(reason);
      expect(box?.textContent).not.toMatch(/\d{3}/);
      await act(async () => {
        box?.querySelector("button")?.click();
      });
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(box?.querySelector("button")?.textContent).toBe("다시 시도");
      expect(document.querySelector('[data-testid="timeline-error-line"]')).toBeNull();
      act(() => mountedRoot?.unmount());
      host?.remove();
      host = null;
      mountedRoot = null;
    }
  });

  // 지키는 것: 받아 둔 글이 있으면 상자로 덮지 않는다. 글은 그대로 서 있고 위에 한 줄만 있다.
  it("받아 둔 글이 있으면 상자 없이 글은 그대로 두고 위에 한 줄만 선다", async () => {
    const onRetry = vi.fn();
    show({ messages: [text(1), text(2)], status: "error", loadCause: "serverUnreachable", onRetry });
    expect(document.querySelector('[data-testid="timeline-error"]')).toBeNull();
    const line = document.querySelector<HTMLElement>('[data-testid="timeline-error-line"]');
    expect(line?.textContent).toContain("새 글을 불러오지 못했어요");
    expect(document.body.textContent).toContain("메시지 1");
    expect(document.body.textContent).toContain("메시지 2");
    await act(async () => {
      line?.querySelector("button")?.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("읽기에 실패하지 않았으면 상자도 한 줄도 없다", () => {
    show({ messages: [text(1)], status: "ready" });
    expect(document.querySelector('[data-testid="timeline-error"]')).toBeNull();
    expect(document.querySelector('[data-testid="timeline-error-line"]')).toBeNull();
    expect(document.body.textContent).toContain("메시지 1");
  });
});
