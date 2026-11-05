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
// #5324: 웹·데스크탑 본류에는 root 없는 메시지만 선다(ADR-0148 증보 2026-11-05). 「대화에도 보내기」는 화면에서 빠졌고, 옛날에 켜고 보낸 답글
// (서버 필드 `alsoInChannel: true` 는 그대로 온다)도 **스레드에만** 보인다 — 본류의 행도 「↳ ○○님 스레드에 답글」 한 줄 요약도 없다.
// 실제 Timeline·MessageRow를 올려 화면에 서는 것을 잰다(서버·소켓 없음).
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

describe("본류에 서는 행 (#5324)", () => {
  const summary = { reply_count: 1, last_reply_seq: 11, last_reply_at: 1, participant_ids: [B], participant_count: 1 };

  it("스레드 답글은 본류에 서지 않는다 — 요약 줄만 남는다", () => {
    show([{ ...root, thread: summary }, reply(11)]);
    expect(text()).toContain("배포는 금요일에 합니다.");
    expect(text()).not.toContain("답글 11");
    expect(q("thread-count")?.textContent).toBe("답글 1개");
  });

  it("옛 서버(요약에 참여자 키 없음, 켠 값 없음)의 화면도 같다: 답글은 본류에 서지 않는다", () => {
    show([{ ...root, thread: { reply_count: 1, last_reply_seq: 11, last_reply_at: 1 } }, reply(11)]);
    expect(text()).not.toContain("답글 11");
    expect(q("reply-home")).toBeNull();
  });

  // 사보타주: `Timeline` 이 코어 `mainFlowMessages` 를 거치지 않거나 코어 `isMainFlowRow` 가 `alsoInChannel` 을 되살리면 이 시험이 RED 여야 한다.
  it("옛날에 「대화에도 보내기」로 보낸 답글도 본류에 서지 않는다 — 행도 한 줄 요약도 없다", () => {
    show([{ ...root, thread: summary }, reply(11, { alsoInChannel: true })]);
    expect(text()).toContain("배포는 금요일에 합니다.");
    expect(text()).not.toContain("답글 11");
    expect(q("reply-home")).toBeNull();
    expect(q("reply-home-header")).toBeNull();
    expect(host?.querySelectorAll('[data-testid="timeline-message"]').length).toBe(1);
  });

  it("루트가 불러온 범위 위에 있는 옛 켠 답글도 본류에 서지 않는다(루트를 몰라도 스레드의 것이다)", () => {
    show([reply(11, { alsoInChannel: true })]);
    expect(text()).not.toContain("답글 11");
    expect(q("reply-home")).toBeNull();
  });

  it("루트 없는 메시지는 본류에 선다 — 위 단정이 「아무것도 안 그린다」가 아님을 못 박는다", () => {
    show([{ ...root, thread: summary }, reply(11, { alsoInChannel: true }), { ...root, id: "0199eeee-0000-7000-8000-000000000999", seq: 12, body: "본류 글" }]);
    expect(text()).toContain("본류 글");
    expect(text()).not.toContain("답글 11");
  });
});
