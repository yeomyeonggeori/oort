// @vitest-environment jsdom

import { act, createElement, forwardRef, useEffect, useImperativeHandle, type ReactElement, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@momo/core/lib/api";
import type { PendingMessage } from "@momo/core/features/timeline/model";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { Timeline } from "./Timeline";
import { hasFreshSelfSend, SELF_SEND_FRESH_MS } from "./navigation";

// =============================================================================
// 위로 올려 둔 채 내가 보내면 맨 아래로 간다 (#5603, owner 11-09).
//
// 수리 전에는 바닥이 아닐 때 새 줄을 따라가지 않는 규칙이 내 메아리에도 걸려, 위를 읽던 사람이 보낸 글이 화면 아래 밖에 섰다.
// 수리: 처음 나타난 내 메아리가 있으면 그 커밋에서 바닥 붙이기(`holdScrollPosition`)에게 `expectBottom` 을 부른다. 이 시험은 그
// **부름**을 잰다(바닥 붙이기는 가짜로 바꿔 쥔다). 남의 말에는 부르지 않고 가상 목록의 따라가기 답(`followOutput`)도 그대로다.
// 진짜 엔진의 스크롤(WebKit·Chromium, 거리·보임·1초 뒤 되돌아감)은 `gates/gate-send-follow.mjs` 가 잰다.
// =============================================================================

type Follow = () => "auto" | "smooth" | false;

const virtuoso = vi.hoisted(() => ({
  followOutput: null as Follow | null,
  atBottomStateChange: null as ((bottom: boolean) => void) | null,
}));
const hold = vi.hoisted(() => ({ expectBottom: vi.fn(), stop: vi.fn() }));
vi.mock("./scrollHold", () => ({ holdScrollPosition: () => hold, virtualListHold: () => ({}) }));

vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(function MockVirtuoso(
    props: {
      data: { kind: string; key: string }[];
      itemContent: (index: number, item: { kind: string; key: string }) => ReactElement;
      followOutput?: Follow;
      atBottomStateChange?: (bottom: boolean) => void;
      scrollerRef?: (node: HTMLElement | Window | null) => void;
    },
    ref: Ref<{ scrollToIndex: (opts: unknown) => void }>
  ) {
    virtuoso.followOutput = props.followOutput ?? null;
    virtuoso.atBottomStateChange = props.atBottomStateChange ?? null;
    useImperativeHandle(ref, () => ({ scrollToIndex: () => undefined }));
    const scrollerRef = props.scrollerRef;
    useEffect(() => {
      const node = document.querySelector("[data-testid='timeline-virtuoso']");
      scrollerRef?.(node instanceof HTMLElement ? node : null);
      return () => scrollerRef?.(null);
    }, [scrollerRef]);
    return createElement(
      "div",
      { "data-testid": "timeline-virtuoso" },
      props.data.map((item, index) => createElement("div", { key: item.key }, props.itemContent(index, item)))
    );
  }),
}));

vi.mock("./MessageRow", () => ({
  DayDivider: () => createElement("div", { "data-testid": "day-divider" }),
  RecoveryDivider: () => createElement("div"),
  UnreadDivider: () => createElement("div"),
  MessageRow: ({ message }: { message: { seq: number } }) =>
    createElement("div", { "data-testid": "timeline-message", "data-seq": message.seq }),
}));
vi.mock("./PendingRow", () => ({
  PendingRow: ({ pending }: { pending: PendingMessage }) =>
    createElement("div", { "data-testid": "pending-row", "data-client-msg-id": pending.clientMsgId }),
}));

const OTHER = "00000000-0000-7000-8000-000000000101";
const ME = "00000000-0000-7000-8000-0000000001ff";
const CHANNEL = "0199cccc-0000-7000-8000-000000000201";
const DIRECTORY = makeDirectory([]);
const BASE = Date.now() - 3_600_000;

function message(seq: number, authorMemberId: string = OTHER): Message {
  return {
    id: `0199cccc-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    channelId: CHANNEL,
    seq,
    authorMemberId,
    body: `메시지 ${seq}`,
    type: "text",
    state: "sent",
    createdAtMs: BASE + seq * 1_000,
    hlcTs: BASE + seq * 1_000,
    hlcCount: 0,
  };
}

function echo(clientMsgId: string, over: Partial<PendingMessage> = {}): PendingMessage {
  return {
    clientMsgId,
    channelId: CHANNEL,
    authorMemberId: ME,
    body: "방금 쓴 글",
    createdAtMs: Date.now(),
    sinceSeq: 8,
    status: "sending",
    ...over,
  };
}

const HISTORY = [1, 2, 3, 4, 5, 6, 7, 8].map((seq) => message(seq));

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(messages: Message[], pending: PendingMessage[]) {
  act(() => {
    root?.render(
      createElement(Timeline, {
        messages,
        directory: DIRECTORY,
        status: "ready",
        lastReadSeq: 8,
        unreadCount: 0,
        pending,
        actions: {
          myMemberId: ME,
          onToggleReaction: () => undefined,
          onTogglePin: () => undefined,
          onEditMessage: async () => undefined,
          onDeleteMessage: async () => undefined,
        },
      })
    );
  });
}

function mount(pending: PendingMessage[] = []) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  render(HISTORY, pending);
}

/** 위로 올려 읽는다: 목록이 「바닥이 아님」을 알린다. */
function scrollUp() {
  act(() => virtuoso.atBottomStateChange?.(false));
}

function follows(): "auto" | "smooth" | false {
  const ask = virtuoso.followOutput;
  if (ask === null) throw new Error("목록이 followOutput 을 받지 못했다");
  return ask();
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  virtuoso.followOutput = null;
  virtuoso.atBottomStateChange = null;
  hold.expectBottom.mockReset();
  hold.stop.mockReset();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    }
  );
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
});

describe("내가 보낸 글은 위로 올려 둔 채여도 맨 아래로 간다 (#5603)", () => {
  it("위로 올린 상태에서 보내면 바닥 붙이기에게 「이제 바닥」을 한 번 알린다", () => {
    mount();
    scrollUp();
    expect(hold.expectBottom).not.toHaveBeenCalled();
    render(HISTORY, [echo("c-1")]);
    expect(hold.expectBottom).toHaveBeenCalledTimes(1);
    // 같은 메아리가 다시 그려져도(확정 전 재렌더) 다시 부르지 않는다.
    render(HISTORY, [echo("c-1")]);
    expect(hold.expectBottom).toHaveBeenCalledTimes(1);
  });

  it("남의 말은 지금처럼 따라가지 않는다 — 부르지 않고, 가상 목록의 답도 그대로(false)", () => {
    mount();
    scrollUp();
    render([...HISTORY, message(9)], []);
    expect(hold.expectBottom).not.toHaveBeenCalled();
    expect(follows()).toBe(false);
  });

  it("되살린 오래된 메아리(실패 행)는 방금 보낸 것이 아니다", () => {
    mount();
    scrollUp();
    render(HISTORY, [echo("c-old", { status: "failed", createdAtMs: Date.now() - 60_000 })]);
    expect(hold.expectBottom).not.toHaveBeenCalled();
  });

  it("다시 보내기는 같은 키라 새 전송이 아니다(실패 줄은 이미 그 자리에 있다)", () => {
    mount([echo("c-2", { status: "failed" })]);
    scrollUp();
    render(HISTORY, [echo("c-2", { status: "sending" })]);
    expect(hold.expectBottom).not.toHaveBeenCalled();
  });

  it("목록이 통째로 바뀐 렌더(다른 대화·다시 읽기)의 메아리는 보낸 것이 아니라 바탕으로만 적는다", () => {
    mount();
    scrollUp();
    // seq 가 하나도 겹치지 않는 목록 = 흐름이 바뀌었다(epoch). 그 렌더에 이미 있던 메아리는 지금 보낸 것이 아니다.
    const other = [21, 22, 23].map((seq) => message(seq));
    render(other, [echo("c-5")]);
    render(other, [echo("c-5")]);
    expect(hold.expectBottom).not.toHaveBeenCalled();
    // 그 뒤에 보낸 글은 보낸 것이다.
    render(other, [echo("c-5"), echo("c-6")]);
    expect(hold.expectBottom).toHaveBeenCalledTimes(1);
  });
});

describe("hasFreshSelfSend", () => {
  const now = 1_800_000_000_000;
  const row = (clientMsgId: string, status: "sending" | "failed", ageMs: number) => ({
    clientMsgId,
    status,
    createdAtMs: now - ageMs,
  });

  it("처음 나타났고 보내는 중이고 보낸 지 창 안이면 참", () => {
    expect(hasFreshSelfSend(new Set(), [row("a", "sending", 10)], now)).toBe(true);
    expect(hasFreshSelfSend(new Set(), [row("a", "sending", SELF_SEND_FRESH_MS)], now)).toBe(true);
  });

  it("이미 본 키·실패 행·창 밖의 메아리는 거짓", () => {
    expect(hasFreshSelfSend(new Set(["a"]), [row("a", "sending", 10)], now)).toBe(false);
    expect(hasFreshSelfSend(new Set(), [row("a", "failed", 10)], now)).toBe(false);
    expect(hasFreshSelfSend(new Set(), [row("a", "sending", SELF_SEND_FRESH_MS + 1)], now)).toBe(false);
  });
});
