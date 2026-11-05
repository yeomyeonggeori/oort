// @vitest-environment jsdom

import { act, createElement, forwardRef, useImperativeHandle, type ReactElement, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, QuotedMessage, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { koreanLocale } from "@/testing/koLocale";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { Timeline } from "./Timeline";

// =============================================================================
// 에이전트 답의 인용 — 바로 위 메시지를 가리키면 그리지 않는다 (#5357, owner 2026-11-05).
//
// 1:1 DM처럼 답이 질문 바로 다음에 놓이면 인용 블록은 바로 위의 말을 한 번 더 보여 줄 뿐이다. 이 파일은 **진짜 `Timeline`·`MessageRow`**
// 를 그려(가상 목록과 두 대화상자만 가짜) 그 판정이 화면에 닿는지 잰다. 판정 자체(에이전트인가 · 대상이 바로 위인가 · 어느 갈래의 블록인가)
// 의 표는 코어 `quote.test.ts` 가 든다 - 여기는 그 함수가 **목록과 행에 제대로 걸렸는지**만 본다.
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

function show(messages: Message[]): void {
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
          }),
        })
      )
    )
  );
  act(() => mountedRoot?.render(node));
}

const rows = () => Array.from(host?.querySelectorAll<HTMLElement>('[data-testid="timeline-message"]') ?? []);
const rowAt = (seq: number) => host?.querySelector<HTMLElement>(`[data-testid="timeline-message"][data-seq="${seq}"]`) ?? null;
function quoted(target: Message): QuotedMessage {
  return {
    id: target.id,
    seq: target.seq,
    authorMemberId: target.authorMemberId,
    type: "text",
    ...(target.body === undefined ? {} : { body: target.body }),
    state: target.state ?? "sent",
  };
}

/** 서버가 페이지에 동봉하는 모양 그대로: `replyToId` 와 풀린 `replyTo` 가 함께 온다. */
function replyTo(seq: number, target: Message, author: string, over: Partial<Message> = {}): Message {
  return text(seq, { authorMemberId: author, body: "확인했어요.", replyToId: target.id, replyTo: quoted(target), ...over });
}

const quoteBlocks = () => Array.from(host?.querySelectorAll<HTMLElement>('[data-testid="quote-block"]') ?? []);

describe("에이전트 답의 인용: 바로 위를 가리키면 그리지 않는다", () => {
  it("질문 바로 아래 에이전트 답은 인용 블록 없이 본문만 선다", () => {
    const question = text(1, { authorMemberId: OTHER, body: "배포 되돌리기 절차부터 확인해 줘." });
    show([question, replyTo(2, question, AGENT)]);
    expect(rows().map((row) => row.dataset.seq)).toEqual(["1", "2"]);
    expect(quoteBlocks()).toHaveLength(0);
    // 답의 본문은 그대로다 - 지운 것은 인용 블록 하나뿐이다.
    expect(rowAt(2)?.textContent).toContain("확인했어요.");
    // 질문 문장은 화면에 질문 행 안에 한 번뿐이다(인용이 한 번 더 보여 주지 않는다).
    expect((host?.textContent ?? "").split("배포 되돌리기 절차부터 확인해 줘.").length - 1).toBe(1);
  });

  it("사이에 다른 말이 끼면 인용은 그대로 보인다", () => {
    const question = text(1, { authorMemberId: OTHER, body: "배포 되돌리기 절차부터 확인해 줘." });
    show([question, text(2, { body: "아 그리고 로그도요." }), replyTo(3, question, AGENT)]);
    const blocks = quoteBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.dataset.targetId).toBe(question.id.toLowerCase());
    expect(blocks[0]?.dataset.kind).toBe("ready");
  });

  it("사람이 직접 고른 인용은 바로 위여도 그대로 보인다", () => {
    const question = text(1, { authorMemberId: OTHER, body: "배포 되돌리기 절차부터 확인해 줘." });
    show([question, replyTo(2, question, ME)]);
    expect(quoteBlocks()).toHaveLength(1);
    expect(quoteBlocks()[0]?.dataset.kind).toBe("ready");
  });

  it("지워진 원본은 바로 위여도 「삭제된 메시지」로 그대로 보인다", () => {
    const gone = text(1, { authorMemberId: OTHER, state: "deleted", body: undefined });
    show([gone, replyTo(2, gone, AGENT)]);
    expect(quoteBlocks()).toHaveLength(1);
    expect(quoteBlocks()[0]?.dataset.kind).toBe("deleted");
  });

  it("실시간으로 온 답(풀린 인용 없음)도 화면의 행에서 풀어 같은 규칙을 따른다", () => {
    const question = text(1, { authorMemberId: OTHER, body: "배포 되돌리기 절차부터 확인해 줘." });
    const live = text(2, { authorMemberId: AGENT, body: "확인했어요.", replyToId: question.id });
    expect(live.replyTo).toBeUndefined();
    show([question, live]);
    expect(quoteBlocks()).toHaveLength(0);
    // 대조: 같은 프레임이어도 사이에 말이 끼면 풀려서 보인다 - 위의 0이 「못 풀어서」가 아니라는 증거.
    show([question, text(3, { body: "끼어든 말" }), { ...live, seq: 4 }]);
    expect(quoteBlocks()).toHaveLength(1);
    expect(quoteBlocks()[0]?.dataset.kind).toBe("ready");
  });
});
