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
import { Timeline } from "./Timeline";

// =============================================================================
// #4888: 본류에는 root 없는 메시지와 「대화에도 보낸」 답글만 선다(ADR-0148 증보 결정 4). 켜지 않은 답글은 스레드로만 간다. 서 있는
// 답글은 「↳ ○○님 스레드에 답글」 + 원문 한 줄로 어느 스레드의 것인지 말하고, 누르면 그 스레드(루트)가 열린다. 실제 Timeline·MessageRow를
// 올려 화면에 서는 것을 잰다(서버·소켓 없음).
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

const root: Message = {
  id: ROOT,
  channelId: CH,
  seq: 10,
  hlcTs: 10,
  hlcCount: 0,
  authorMemberId: A,
  type: "text",
  body: "배포는 금요일에 합니다.",
  state: "sent",
  createdAtMs: 1_700_000_000_000,
};
const reply = (seq: number, over: Partial<Message> = {}): Message => ({
  ...root,
  id: `0199eeee-0000-7000-8000-${String(seq).padStart(12, "0")}`,
  rootId: ROOT,
  seq,
  hlcTs: seq,
  authorMemberId: B,
  body: `답글 ${seq}`,
  createdAtMs: 1_700_000_000_000 + seq * 1_000,
  ...over,
});

const actions = {
  myMemberId: ME,
  onToggleReaction: vi.fn(),
  onTogglePin: vi.fn(),
  onEditMessage: vi.fn(),
  onDeleteMessage: vi.fn(),
};

function show(messages: Message[], onOpenThread: (message: Message) => void = () => undefined): void {
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
          children: createElement(Timeline, { messages, directory, status: "ready", reachedStart: true, actions, onOpenThread }),
        })
      )
    )
  );
  act(() => mountedRoot?.render(node));
}

const q = (id: string) => host?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
const text = () => host?.textContent ?? "";

describe("본류에 서는 행 (#4888)", () => {
  it("스레드로만 보낸 답글은 본류에 서지 않는다 — 요약 줄만 남는다", () => {
    show([{ ...root, thread: { reply_count: 1, last_reply_seq: 11, last_reply_at: 1, participant_ids: [B], participant_count: 1 } }, reply(11)]);
    expect(text()).toContain("배포는 금요일에 합니다.");
    expect(text()).not.toContain("답글 11");
    expect(q("reply-home")).toBeNull();
    expect(q("thread-count")?.textContent).toBe("답글 1개");
  });

  it("옛 서버(요약에 참여자 키 없음, 켠 값 없음)의 화면은 오늘 웹과 같다: 답글은 본류에 서지 않는다", () => {
    show([{ ...root, thread: { reply_count: 1, last_reply_seq: 11, last_reply_at: 1 } }, reply(11)]);
    expect(text()).not.toContain("답글 11");
    expect(q("reply-home")).toBeNull();
  });

  it("대화에도 보낸 답글은 본류에 서고, 어느 스레드의 답글인지 말한다", () => {
    show([root, reply(11, { alsoInChannel: true })]);
    expect(text()).toContain("답글 11");
    expect(q("reply-home-header")?.textContent).toBe("↳ 가영님 스레드에 답글");
    expect(q("reply-home-excerpt")?.textContent).toBe("배포는 금요일에 합니다.");
  });

  it("내 글에 단 답글은 이름 대신 「내 글」이라 말한다", () => {
    show([{ ...root, authorMemberId: ME }, reply(11, { alsoInChannel: true })]);
    expect(q("reply-home-header")?.textContent).toBe("↳ 내 글 스레드에 답글");
  });

  it("줄을 누르면 그 스레드(루트)가 열린다", () => {
    const opened: Message[] = [];
    show([root, reply(11, { alsoInChannel: true })], (message) => opened.push(message));
    const button = q("reply-home");
    expect(button?.tagName).toBe("BUTTON");
    act(() => button?.click());
    expect(opened.map((message) => message.id)).toEqual([ROOT]);
    // 이름은 보이는 글이고(화살표는 낭독에서 빠진다), 열린다는 말은 title 이 진다.
    expect(button?.title).toBe("이 답글이 달린 스레드 열기");
    expect(button?.querySelector('[aria-hidden="true"]')?.textContent).toBe("↳ ");
  });

  it("루트가 불러온 범위 위에 있으면 모른다고 말하고 누를 수 없다", () => {
    show([reply(11, { alsoInChannel: true })]);
    expect(q("reply-home-header")?.textContent).toBe("↳ 스레드에 답글");
    expect(q("reply-home-excerpt")).toBeNull();
    expect(q("reply-home")?.tagName).toBe("P");
  });

  it("지워진 루트는 「삭제된 메시지」라 말하지만 스레드는 열린다", () => {
    const opened: Message[] = [];
    show([{ ...root, state: "deleted", body: undefined }, reply(11, { alsoInChannel: true })], (message) => opened.push(message));
    expect(q("reply-home-excerpt")?.textContent).toBe("삭제된 메시지");
    act(() => q("reply-home")?.click());
    expect(opened).toHaveLength(1);
  });

  it("답글이 아닌 행에는 줄이 없다", () => {
    show([root]);
    expect(q("reply-home")).toBeNull();
  });
});
