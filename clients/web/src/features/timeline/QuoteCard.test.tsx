// @vitest-environment jsdom

import { forwardRef, createElement, useImperativeHandle, type ReactElement, type ReactNode, type Ref } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, QuotedMessage, RosterMember } from "@momo/core/lib/api";
import type { PendingMessage } from "@momo/core/features/timeline/model";
import { quoteBlockFrom } from "@momo/core/features/timeline/quote";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { koreanLocale } from "@/testing/koLocale";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { EditRequestContext, type EditRequestChannel } from "./editRequest";
import { PendingRow } from "./PendingRow";
import { QuoteChip } from "./QuoteBlock";
import { ThreadPanel } from "./ThreadPanel";
import { Timeline } from "./Timeline";

// =============================================================================
// 인용 = 답장 카드의 윗칸 머리 (#5381, Q4 — owner 2026-11-05).
//
// 답장 메시지는 한 덩어리 카드다: 머리(아이콘 + 「{이름}에게 답장」 + 원문 1줄) · 가는 구분선 · 본문. 세로선은 어디에도 없다. 이 파일은 **진짜
// `Timeline`·`MessageRow`·`ThreadPanel`·`PendingRow`·`QuoteChip`**을 그려(가상 목록과 두 대화상자만 가짜) 그 모양이 화면에 닿는지 잰다. 어느 인용을
// 그릴지의 판정 표는 코어 `quote.test.ts` 가 든다 — 여기는 그 판정이 **행에 걸렸는지**와 머리·카드의 구조만 본다.
//
// jsdom 은 Tailwind 를 계산하지 못하므로 「세로선 없음」은 클래스로 잰다(`border-l`·`border-r`·`rounded-l` 계열이 카드 안 어디에도 없다). 실제 픽셀은
// 전후 캡처(PR 본문)가 든다.
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
const api = vi.hoisted(() => ({ fetchReplies: vi.fn() }));
vi.mock("@momo/core/lib/api", async (original) => ({
  ...(await original<typeof import("@momo/core/lib/api")>()),
  fetchThreadReplies: api.fetchReplies,
}));
vi.mock("./ThreadComposer", () => ({ ThreadComposer: () => null }));

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "0199cccc-0000-7000-8000-000000000201";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-0000000000a1";
const AGENT = "00000000-0000-7000-8000-0000000000b1";
const BASE_MS = 1_700_000_000_000;

let ko: AppLocale;
beforeAll(async () => {
  ko = await koreanLocale();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  api.fetchReplies.mockReset();
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
  cleanup();
  vi.unstubAllGlobals();
});

function member(id: string, name: string, kind: "human" | "agent" = "human"): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind,
    status: "active",
    displayName: name,
    handle: kind === "agent" ? "kometto" : name,
    role: "member",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}
const directory = makeDirectory([member(ME, "정하윤"), member(OTHER, "하늘"), member(AGENT, "코메토", "agent")]);

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

function Providers({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return (
    <SessionProvider value={sessionValue()}>
      <OpenMemberProfileContext.Provider value={() => undefined}>
        <QueryClientProvider client={client}>
          <LocaleProvider locale={ko}>{children}</LocaleProvider>
        </QueryClientProvider>
      </OpenMemberProfileContext.Provider>
    </SessionProvider>
  );
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
  return text(seq, { authorMemberId: author, body: "세 단계예요.", replyToId: target.id, replyTo: quoted(target), ...over });
}

function showTimeline(messages: Message[], extra: { onJumpToMessage?: (id: string, seq: number | null) => void } = {}) {
  return render(
    <Providers>
      <Timeline
        messages={messages}
        directory={directory}
        status="ready"
        reachedStart
        actions={actions}
        onOpenThread={() => undefined}
        {...(extra.onJumpToMessage ? { onJumpToMessage: extra.onJumpToMessage } : {})}
      />
    </Providers>
  );
}

const cards = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="quote-card"]'));
const heads = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="quote-block"]'));
const QUESTION_BODY = "배포 되돌리기 절차 정리해 줄래요? 릴리스 태그 확인, 이전 이미지 롤백, 헬스체크까지 순서대로 알려 주면 좋겠어요.";
const QUESTION = text(1, { authorMemberId: OTHER, body: QUESTION_BODY });
const FILLER = text(2, { authorMemberId: ME, body: "아 그리고 로그도요." });

/** 세로선·막대: 어느 쪽이든 한 변만 두른 테두리나 한쪽만 둥근 모서리가 카드 안에 있으면 안 된다. */
function hasRailClass(node: Element): boolean {
  // `rounded-lg`(large)는 한쪽 모서리가 아니다: `l` 뒤가 끝이거나 `-`일 때만 한쪽 변이다.
  const side = /(^|\s)(border-(l|r|s|e)(-\S+)?|rounded-(l|r|s|e|tl|tr|bl|br|ss|se|es|ee)(-\S+)?)(\s|$)/;
  return Array.from(node.querySelectorAll("*"))
    .concat(node)
    .some((el) => side.test(el.getAttribute("class") ?? ""));
}

describe("답장 한 덩어리 카드: 머리 + 구분선 + 본문", () => {
  it("인용이 있는 메시지는 카드가 본문을 싸고 머리가 위 칸이다", () => {
    showTimeline([QUESTION, FILLER, replyTo(3, QUESTION, ME)]);
    expect(cards()).toHaveLength(1);
    const card = cards()[0]!;
    const head = within(card).getByTestId("quote-block");
    // 머리: 아이콘 + 「{이름}에게 답장」 + 원문 한 줄.
    expect(within(head).getByTestId("quote-head-label").textContent).toBe("하늘에게 답장");
    expect(head.querySelector("svg")).not.toBeNull();
    expect(head.textContent).toContain(QUESTION_BODY);
    // 카드는 본문을 안에 들고, 구분선은 머리 아래에만 선다.
    expect(card.dataset.hasBody).toBe("true");
    expect(card.textContent).toContain("세 단계예요.");
    expect(head.className).toContain("border-b");
    // 본문 칸은 머리 **다음** 형제다(머리 위·옆이 아니다).
    expect(head.nextElementSibling?.textContent).toContain("세 단계예요.");
  });

  it("세로선·막대가 카드 어디에도 없다", () => {
    showTimeline([QUESTION, FILLER, replyTo(3, QUESTION, ME)]);
    expect(hasRailClass(cards()[0]!)).toBe(false);
  });

  it("머리는 원문의 첫 줄만 보여 주고 더 있다는 사실(…)을 남긴다", () => {
    const multi = text(1, { authorMemberId: OTHER, body: "첫 줄이에요\n둘째 줄은 안 보여요\n셋째 줄도요" });
    showTimeline([multi, FILLER, replyTo(3, multi, ME)]);
    const head = heads()[0]!;
    expect(head.textContent).toContain("첫 줄이에요…");
    expect(head.textContent).not.toContain("둘째 줄은 안 보여요");
    // 한 줄 말줄임은 화면(`truncate`)이 맡고, 줄 수를 늘리는 `line-clamp` 는 없다.
    expect(head.querySelector('[class*="line-clamp"]')).toBeNull();
    expect(head.querySelector(".truncate")).not.toBeNull();
  });

  it("머리를 누르면 원문으로 간다 (지금과 같은 이동 동작)", () => {
    const jump = vi.fn();
    showTimeline([QUESTION, FILLER, replyTo(3, QUESTION, ME)], { onJumpToMessage: jump });
    const head = heads()[0]!;
    expect(head.tagName).toBe("BUTTON");
    expect(head.hasAttribute("data-row-action")).toBe(true);
    fireEvent.click(head);
    expect(jump).toHaveBeenCalledTimes(1);
    expect(jump).toHaveBeenCalledWith(QUESTION.id, QUESTION.seq);
  });

  it("갈 곳이 없는 마운트는 누를 수 없는 머리(글)다", () => {
    showTimeline([QUESTION, FILLER, replyTo(3, QUESTION, ME)]);
    const head = heads()[0]!;
    expect(head.tagName).toBe("DIV");
    expect(head.textContent).toContain("하늘에게 답장");
  });

  it("에이전트의 이름은 행 머리줄처럼 @핸들이다", () => {
    const agentLine = text(1, { authorMemberId: AGENT, body: "마지막 50줄이에요." });
    showTimeline([agentLine, FILLER, replyTo(3, agentLine, ME)]);
    expect(within(heads()[0]!).getByTestId("quote-head-label").textContent).toBe("@kometto에게 답장");
  });

  it("지워진 원본은 같은 머리 자리에서 「삭제된 메시지」라고 말한다", () => {
    const gone = text(1, { authorMemberId: OTHER, state: "deleted", body: undefined });
    showTimeline([gone, FILLER, replyTo(3, gone, ME)]);
    const head = heads()[0]!;
    expect(head.dataset.kind).toBe("deleted");
    expect(within(head).getByTestId("quote-head-label").textContent).toBe("하늘에게 답장");
    expect(within(head).getByTestId("quote-deleted").textContent).toBe("삭제된 메시지");
  });

  it("못 불러온 원문은 이름 없는 머리와 지금 문구 그대로다", () => {
    const live = text(3, { body: "세 단계예요.", replyToId: "0199eeee-0000-7000-8000-00000000zzzz" });
    showTimeline([QUESTION, FILLER, live]);
    const head = heads()[0]!;
    expect(head.dataset.kind).toBe("unresolved");
    expect(within(head).getByTestId("quote-head-label").textContent).toBe("메시지에 답장");
    expect(within(head).getByTestId("quote-unresolved").textContent).toBe("인용한 메시지가 이 화면에 없습니다");
  });

  it("지워진 답장도 머리와 묘비가 한 카드에 선다", () => {
    const deletedReply = replyTo(3, QUESTION, ME, { state: "deleted", body: undefined });
    showTimeline([QUESTION, FILLER, deletedReply]);
    const card = cards()[0]!;
    expect(within(card).getByTestId("quote-block")).toBeTruthy();
    expect(within(card).getByTestId("tombstone")).toBeTruthy();
  });

  it("본문이 없는 답장은 머리만 선 카드다 (구분선·빈 본문 칸이 없다)", () => {
    showTimeline([QUESTION, FILLER, replyTo(3, QUESTION, ME, { body: "" })]);
    const card = cards()[0]!;
    expect(card.dataset.hasBody).toBe("false");
    expect(within(card).getByTestId("quote-block").className).not.toContain("border-b");
    expect(card.children[0]?.children).toHaveLength(1);
  });

  it("인용이 없는 메시지는 카드가 없다", () => {
    showTimeline([QUESTION, FILLER]);
    expect(cards()).toHaveLength(0);
    expect(heads()).toHaveLength(0);
  });
});

describe("스레드 안에서 root를 가리키는 인용은 그리지 않는다 (요청 고리 §4.2)", () => {
  const ROOT = text(1, { authorMemberId: OTHER, body: "배포 되돌리기 절차 정리해 줄래요?" });
  function thread(replies: Message[]) {
    api.fetchReplies.mockResolvedValue({ messages: replies });
    return render(
      <Providers>
        <ThreadPanel workspaceId={WS} channelId={CH} root={ROOT} directory={directory} channels={[]} onClose={() => undefined} />
      </Providers>
    );
  }

  it("답이 root를 가리키면 인용은 그리지 않고, 다른 답을 가리키면 그린다", async () => {
    const first = text(2, { rootId: ROOT.id, authorMemberId: ME, body: "여기서 확인해 줘." });
    const rootAnswer = replyTo(3, ROOT, AGENT, { rootId: ROOT.id, body: "처음 질문에 답할게요." });
    const between = text(4, { rootId: ROOT.id, authorMemberId: ME, body: "고마워요." });
    const answerToFirst = replyTo(5, first, AGENT, { rootId: ROOT.id, body: "확인했어요." });
    thread([first, rootAnswer, between, answerToFirst]);
    await waitFor(() => expect(screen.queryByTestId("thread-loading")).toBeNull());
    await waitFor(() => expect(document.querySelector(`[data-seq="5"]`)).not.toBeNull());
    // root 를 가리키는 답에는 인용도 카드도 없고 본문은 그대로다.
    const rootAnswerRow = document.querySelector<HTMLElement>(`[data-testid="timeline-message"][data-seq="3"]`)!;
    expect(within(rootAnswerRow).queryByTestId("quote-block")).toBeNull();
    expect(within(rootAnswerRow).queryByTestId("quote-card")).toBeNull();
    expect(rootAnswerRow.textContent).toContain("처음 질문에 답할게요.");
    // 스레드의 다른 답을 가리키면(사이에 말이 끼었다) 그대로 그린다.
    const otherRow = document.querySelector<HTMLElement>(`[data-testid="timeline-message"][data-seq="5"]`)!;
    expect(within(otherRow).getByTestId("quote-block").dataset.targetId).toBe(first.id.toLowerCase());
  });

  it("실시간으로 온 새 답(풀린 인용 없음)이 root를 가리켜도 「이 화면에 없습니다」를 말하지 않는다", async () => {
    const live = text(2, { rootId: ROOT.id, authorMemberId: AGENT, body: "세 단계예요.", replyToId: ROOT.id });
    expect(live.replyTo).toBeUndefined();
    thread([live]);
    await waitFor(() => expect(document.querySelector(`[data-seq="2"]`)).not.toBeNull());
    expect(document.querySelector('[data-testid="quote-unresolved"]')).toBeNull();
    expect(document.querySelector('[data-testid="quote-block"]')).toBeNull();
  });

  it("같은 답이 본류(스레드 밖)에서 읽히면 이 규칙은 걸리지 않는다", () => {
    const answerInMain = replyTo(3, ROOT, ME, { body: "세 단계예요." });
    showTimeline([ROOT, FILLER, answerInMain]);
    expect(heads()).toHaveLength(1);
    expect(heads()[0]?.dataset.targetId).toBe(ROOT.id.toLowerCase());
  });
});

describe("편집 중인 답장: 머리만 선 카드 + 편집기", () => {
  it("편집기가 서면 구분선·본문 칸 없는 머리 카드만 남고 편집기는 카드 밖이다", () => {
    const mine = replyTo(3, QUESTION, ME);
    const channel: EditRequestChannel = { request: { messageId: mine.id, nonce: 1 }, consume: vi.fn(), finished: vi.fn() };
    render(
      <Providers>
        <EditRequestContext.Provider value={channel}>
          <Timeline
            messages={[QUESTION, FILLER, mine]}
            directory={directory}
            status="ready"
            reachedStart
            actions={actions}
            onOpenThread={() => undefined}
          />
        </EditRequestContext.Provider>
      </Providers>
    );
    const editor = document.querySelector('[data-testid="message-editor-input"]');
    expect(editor).not.toBeNull();
    const card = cards()[0]!;
    expect(card.dataset.hasBody).toBe("false");
    expect(card.contains(editor)).toBe(false);
    expect(within(card).getByTestId("quote-block").className).not.toContain("border-b");
  });
});

describe("입력창 답장 칩 (QuoteChip): 행의 머리와 같은 문법", () => {
  const block = quoteBlockFrom(quoted(QUESTION));
  function chip(onCancel = vi.fn(), attached = false) {
    render(
      <Providers>
        <QuoteChip block={block} directory={directory} onCancel={onCancel} attached={attached} />
      </Providers>
    );
    return onCancel;
  }

  it("아이콘 + 「{이름}에게 답장」 + 원문 한 줄 + 닫기이고, 세로선이 없다", () => {
    chip();
    const root = screen.getByTestId("composer-quote");
    expect(within(root).getByTestId("quote-head-label").textContent).toBe("하늘에게 답장");
    expect(root.querySelector("svg")).not.toBeNull();
    expect(root.textContent).toContain(QUESTION_BODY);
    expect(root.querySelector(".truncate")).not.toBeNull();
    expect(root.querySelector('[class*="line-clamp"]')).toBeNull();
    expect(hasRailClass(root)).toBe(false);
    expect(root.dataset.targetId).toBe(QUESTION.id.toLowerCase());
  });

  it("닫기를 누르면 인용을 떼고, 닫기에는 이름이 있다", () => {
    const onCancel = chip();
    const close = screen.getByTestId("composer-quote-cancel");
    expect(close.getAttribute("aria-label")).toBe("인용 취소");
    fireEvent.click(close);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("맥락 띠 안에 서면(attached) 자기 윗선은 없다", () => {
    chip(vi.fn(), true);
    expect(screen.getByTestId("composer-quote").className).not.toContain("border-t");
  });
});

describe("보내는 중인 echo 도 같은 카드다 (PendingRow)", () => {
  it("인용을 건 보내는 중 글은 머리와 본문이 한 카드에 선다", () => {
    const pending: PendingMessage = {
      clientMsgId: "k1",
      channelId: CH,
      authorMemberId: ME,
      body: "세 단계예요. 릴리스 태그를 확인해요.",
      createdAtMs: BASE_MS,
      sinceSeq: 10,
      status: "sending",
      replyToId: QUESTION.id,
    };
    render(
      <Providers>
        <PendingRow pending={pending} startsGroup directory={directory} quoteLookup={(id) => (id === QUESTION.id ? QUESTION : undefined)} />
      </Providers>
    );
    const card = screen.getByTestId("quote-card");
    expect(within(card).getByTestId("quote-head-label").textContent).toBe("하늘에게 답장");
    expect(card.textContent).toContain("세 단계예요. 릴리스 태그를 확인해요.");
    // 점프는 주지 않는다: 보내지지도 않은 글에서 원본으로 떠나는 길은 없다.
    expect(within(card).getByTestId("quote-block").tagName).toBe("DIV");
    expect(hasRailClass(card)).toBe(false);
  });
});
