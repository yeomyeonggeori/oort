// @vitest-environment jsdom

import { act, createElement, forwardRef, useImperativeHandle, type ReactElement, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { emptyTimeline, reconcileMessages, type TimelineState } from "@momo/core/features/timeline/model";
import { createThreadReadSender } from "@momo/core/features/timeline/threadRead";
import { applyThreadReadState, readSignalSeq } from "@momo/core/features/timeline/threadSummary";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { koreanLocale } from "@/testing/koLocale";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { Timeline } from "./Timeline";

// =============================================================================
// 채널 타임라인의 루트 요약 줄이 **실시간 답글 프레임**으로 올라간다 (#5008, #4878 후속).
//
// 서버 요약(`message.thread`)은 페이지를 읽은 때의 스냅샷이라 그 뒤 온 답글은 다시 불러와야 줄에 닿았다. 이제 목록이 든 답글(답글
// 프레임도 `messages`에 들어온다)을 코어 `liveThreadRollup`이 스냅샷 위에 얹고, 줄은 그 값을 그리기만 한다. 규칙 자체(수 산수·내
// 답글 제외·옛 서버)의 단위 시험은 코어 `threadSummary.test.ts`에 있고, 여기서는 **실제 Timeline·MessageRow가 그 값을 줄에
// 그리는지**를 잰다: 화면에 서는 수·칩·얼굴이 증거다. 서버는 쓰지 않는다(읽음 신호의 응답은 가짜).
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
const A = "00000000-0000-7000-8000-0000000000a1";
const B = "00000000-0000-7000-8000-0000000000a2";
const C = "00000000-0000-7000-8000-0000000000a3";
const ROOT = "0199eeee-0000-7000-8000-000000000501";

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

function member(id: string, name: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: "human",
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
const directory = makeDirectory([member(ME, "정하윤"), member(A, "가영"), member(B, "나래"), member(C, "다온")]);

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

// 서버가 페이지를 읽을 때의 스냅샷: 답글 3(머리 seq 13), 얼굴 가영·나래, 내가 따라가고 안 읽은 것 1.
const root: Message = {
  id: ROOT,
  channelId: CH,
  seq: 10,
  hlcTs: 10,
  hlcCount: 0,
  authorMemberId: ME,
  type: "text",
  body: "배포는 금요일에 합니다.",
  state: "sent",
  createdAtMs: 1_700_000_000_000,
  thread: {
    reply_count: 3,
    last_reply_seq: 13,
    last_reply_at: 1_700_000_100_000,
    participant_ids: [A, B],
    participant_count: 2,
    unread_reply_count: 1,
  },
};
const reply = (seq: number, authorMemberId: string): Message => ({
  ...root,
  id: `0199eeee-0000-7000-8000-${String(seq).padStart(12, "0")}`,
  rootId: ROOT,
  seq,
  hlcTs: seq,
  authorMemberId,
  body: `답글 ${seq}`,
  createdAtMs: 1_700_000_000_000 + seq * 1_000,
  thread: undefined,
});

const actions = {
  myMemberId: ME,
  onToggleReaction: vi.fn(),
  onTogglePin: vi.fn(),
  onEditMessage: vi.fn(),
  onDeleteMessage: vi.fn(),
};

/** 채널 목록에 든 메시지(답글 프레임 포함)가 바뀔 때마다 같은 마운트를 다시 그린다 — 실시간 프레임이 오는 것과 같다. */
function show(messages: Message[], extra: { viewingThreadId?: string | null } = {}): void {
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
            messages,
            directory,
            status: "ready",
            reachedStart: true,
            actions,
            onOpenThread: () => undefined,
            ...extra,
          }),
        })
      )
    )
  );
  act(() => mountedRoot?.render(node));
}

const q = (id: string) => host?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
const faces = () => host?.querySelectorAll('[data-testid="thread-face"]').length ?? 0;
const line = () => ({
  count: q("thread-count")?.textContent ?? null,
  chip: q("thread-unread-chip")?.textContent ?? null,
  faces: faces(),
});

describe("루트 요약 줄이 실시간 답글로 오른다 (#5008)", () => {
  it("남의 답글 프레임이 오면 수·안 읽은 수·얼굴이 다시 불러오지 않아도 오른다", () => {
    show([root]);
    expect(line()).toEqual({ count: "답글 3개", chip: "새 답글 1", faces: 2 });
    show([root, reply(14, C)]);
    expect(line()).toEqual({ count: "답글 4개", chip: "새 답글 2", faces: 3 });
    // 줄 전체가 하나의 버튼이고 그 이름도 새 값을 따라간다.
    expect(q("thread-anchor")?.getAttribute("aria-label")).toBe("스레드 열기, 답글 4개, 새 답글 2개");
  });

  it("내 답글은 수·얼굴만 올리고 안 읽은 수는 올리지 않는다", () => {
    show([root, reply(14, C)]);
    expect(line().chip).toBe("새 답글 2");
    show([root, reply(14, C), reply(15, ME)]);
    expect(line()).toEqual({ count: "답글 5개", chip: "새 답글 2", faces: 3 });
    // 내 답글만 온 스레드는 칩이 그대로다(새 답글 1).
    show([root, reply(15, ME)]);
    expect(line()).toEqual({ count: "답글 4개", chip: "새 답글 1", faces: 3 });
  });

  it("스레드 패널이 열려 읽음 신호의 응답이 오면 안 읽은 수가 0이 되고 올랐던 수·얼굴은 그대로다", async () => {
    // 호스트(`useTimeline`)의 상태와 패널의 보내는 이(`createThreadReadSender`)를 실제 코어 코드로 이었다. 패널이 이 신호를
    // 보내고 응답을 호스트로 넘기는 배선은 `ThreadPanel.read.test.tsx`·`threadSurface.test.ts`가 재고, 여기서는 그 응답이 줄에
    // 닿는지 잰다.
    let state: TimelineState = reconcileMessages(emptyTimeline(), [root, reply(14, C), reply(15, A)]);
    show(state.messages);
    expect(line()).toEqual({ count: "답글 5개", chip: "새 답글 3", faces: 3 });

    const send = vi.fn(async () => ({ following: true, lastReadReplySeq: 15, unreadReplyCount: 0 }));
    const sender = createThreadReadSender({
      send,
      onState: (rootId, read) => {
        state = applyThreadReadState(state, rootId, read);
        show(state.messages);
      },
    });
    const held = state.messages.filter((message) => message.rootId !== undefined);
    sender.note(ROOT, readSignalSeq(held));
    // 응답이 호스트 상태로 닿고 다시 그려질 때까지 마이크로태스크를 다 비운다(매크로태스크 한 칸).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(send).toHaveBeenCalledWith(ROOT, 15);
    expect(line()).toEqual({ count: "답글 5개", chip: null, faces: 3 });

    // 그 뒤에 온 남의 답글은 다시 올린다.
    state = reconcileMessages(state, [reply(16, B)]);
    show(state.messages);
    expect(line()).toEqual({ count: "답글 6개", chip: "새 답글 1", faces: 3 });
  });

  it("내 글에 남이 첫 답글을 달면 「답글 1개」와 얼굴이 바로 서고 칩은 아직 없다 — 칩은 서버가 따라가는 스레드라고 말해야 서므로 엔진 몫이다 (#5032)", () => {
    // 서버 요약이 없는 루트: 따라가는지 클라이언트가 알 길이 없다(서버가 내 글의 작성자를 자동으로 따라가게 하지만 그 사실을 실시간으로
    // 알려 주는 신호가 없다). 「말하지 않음」은 0도 칩도 아니다 — 지어내면 옛 서버·이전에 그만 따라간 스레드에 거짓 칩이 선다.
    const bare: Message = { ...root, thread: undefined };
    show([bare]);
    expect(line()).toEqual({ count: null, chip: null, faces: 0 });
    show([bare, reply(14, B)]);
    expect(line()).toEqual({ count: "답글 1개", chip: null, faces: 1 });
  });

  it("스레드 패널이 열려 있고 창이 앞이면 남의 새 답글에도 칩이 +1 되지 않는다 — 읽음 신호의 응답을 기다리지 않고, 닫은 뒤에도 되살아나지 않는다 (#5032)", async () => {
    let state: TimelineState = reconcileMessages(emptyTimeline(), [root]);
    // 열린 루트: 서버가 준 안 읽은 1도 열자마자 읽는 중이라 칩이 없다.
    show(state.messages, { viewingThreadId: ROOT });
    expect(line().chip).toBeNull();
    // 남의 답글 프레임이 닿은 **바로 그 렌더**: 읽음 신호는 아직 나가지도 않았다. 수·얼굴은 오르고 칩은 0이다.
    state = reconcileMessages(state, [reply(14, C)]);
    show(state.messages, { viewingThreadId: ROOT });
    expect(line()).toEqual({ count: "답글 4개", chip: null, faces: 3 });
    // 대조: 같은 프레임이 패널이 닫혀 있거나 다른 스레드가 열려 있을 때는 칩을 세운다.
    show(state.messages, { viewingThreadId: null });
    expect(line().chip).toBe("새 답글 2");
    show(state.messages, { viewingThreadId: A });
    expect(line().chip).toBe("새 답글 2");
    // 읽음 신호의 응답(서버가 준 0)이 접으면 패널을 닫은 뒤에도 칩이 되살아나지 않는다.
    show(state.messages, { viewingThreadId: ROOT });
    const sender = createThreadReadSender({
      send: async () => ({ following: true, lastReadReplySeq: 14, unreadReplyCount: 0 }),
      onState: (rootId, read) => {
        state = applyThreadReadState(state, rootId, read);
        show(state.messages, { viewingThreadId: ROOT });
      },
    });
    sender.note(ROOT, readSignalSeq(state.messages.filter((message) => message.rootId !== undefined)));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    show(state.messages, { viewingThreadId: null });
    expect(line()).toEqual({ count: "답글 4개", chip: null, faces: 3 });
  });
});
