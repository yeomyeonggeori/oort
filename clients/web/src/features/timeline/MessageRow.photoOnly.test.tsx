// @vitest-environment jsdom
// #4294: 글 없이 사진만 보낸 메시지가 받는 쪽에서 빈 메시지로 보였다는 베타 피드백.
// 웹 행은 본문이 비면 본문 칸을 건너뛰고 첨부 목록만 그린다 - 이 파일은 그것을 **그려진 DOM에서**
// 못 박는다(지금까지 사진만 있는 행을 그려 본 시험이 없었다). 「없다」 단정은 항상 「그려졌다」와 한 쌍이다.
// 실시간 프레임은 `payloadToMessage` → `reconcileMessages` 를 지나 같은 행에 닿는다.

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message, RosterMember } from "@momo/core/lib/api";
import { payloadToMessage, type MessageNewEvent } from "@momo/core/lib/realtimeEvents";
import { reconcileMessages } from "@momo/core/features/timeline/model";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { MessageRow } from "./MessageRow";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-000000000101";

// 행이 액션 시트와 리마인더 대화상자에 **실제로 넘기는** 한 줄을 붙잡는다. 두 컴포넌트는 안 열려 있어도
// 행이 늘 마운트해 두므로 props 만 읽으면 되고, 리마인더는 확정 때 이 줄을 저장한다(`messagePreview`).
const handed = vi.hoisted(() => ({
  sheetPreview: null as string | null,
  remindPreview: null as string | null,
  commit: null as null | ((dueAtMs: number, note: string) => void),
  mutate: vi.fn(),
}));

vi.mock("@/features/reminders/RemindDialog", () => ({
  RemindDialog: (props: { preview: string; onCommit: (dueAtMs: number, note: string) => void }) => {
    handed.remindPreview = props.preview;
    handed.commit = props.onCommit;
    return null;
  },
}));
vi.mock("@/features/reminders/useReminders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/reminders/useReminders")>();
  return {
    ...actual,
    useReminderMutations: () => ({ create: { isPending: false, mutate: handed.mutate } }),
  };
});
vi.mock("./MessageActions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./MessageActions")>();
  return {
    ...actual,
    MessageActionSheet: (props: { preview: string }) => {
      handed.sheetPreview = props.preview;
      return null;
    },
  };
});
vi.mock("@/features/emoji/EmojiPickerDialog", () => ({ EmojiPickerDialog: () => null }));
vi.mock("@/features/attachments/content", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/attachments/content")>();
  return {
    ...actual,
    useAttachmentPreview: () => ({
      status: "ready",
      dataUrl: "data:image/png;base64,AAAA",
      retry: () => {},
    }),
  };
});

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

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
});

function sender(): RosterMember {
  return {
    id: OTHER,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "이도현",
    handle: "dohyeon",
    role: "member",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "박서연", handle: "seoyeon" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function wrap(node: ReactElement, client: QueryClient): ReactElement {
  return createElement(
    SessionProvider,
    { value: sessionValue() },
    createElement(
      OpenMemberProfileContext.Provider,
      { value: () => undefined },
      createElement(QueryClientProvider, { client }, node)
    )
  );
}

const rowActions = {
  myMemberId: ME,
  chips: [],
  pinned: false,
  onToggleReaction: async () => undefined,
  onTogglePin: async () => undefined,
  onEditMessage: async () => undefined,
  onDeleteMessage: async () => undefined,
};

function mountRow(message: Message, withActions = false): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    mountedRoot?.render(
      createElement(
        MemoryRouter,
        null,
        wrap(
          createElement(MessageRow, {
            message,
            startsGroup: true,
            directory: makeDirectory([sender()]),
            ...(withActions ? { actions: rowActions } : {}),
          }),
          client
        )
      )
    );
  });
  return host;
}

const png = (id: string) => ({ id, name: "현장.png", mime: "image/png", sizeBytes: 4096 });

function message(over: Partial<Message> = {}): Message {
  return {
    id: "0199eeee-0000-7000-8000-000000000501",
    channelId: CH,
    seq: 7,
    hlcTs: 7,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: "text",
    state: "sent",
    createdAtMs: 7000,
    ...over,
  };
}

/** 글자 하나 없는 문단·칸: 사진 위에 빈 줄로 서는 것. */
const emptyParagraphs = (root: HTMLElement) =>
  Array.from(root.querySelectorAll("p")).filter((p) => (p.textContent ?? "").trim() === "");

describe("#4294 웹 대화 행: 사진만 보낸 메시지", () => {
  it.each([
    ["빈 문자열", ""],
    ["공백만", "  \n "],
    ["키 자체가 없음", undefined],
  ])("본문이 %s 이어도 사진을 그리고, 빈 메시지 문구도 빈 문단도 없다", (_name, body) => {
    const root = mountRow(
      message(body === undefined ? { attachments: [png("a1")] } : { body, attachments: [png("a1")] })
    );
    // 짝 1: 행이 비지 않았다 - 사진이 그려졌고 보낸 사람 이름이 선다.
    expect(root.querySelectorAll('[data-testid="attachment-image"]')).toHaveLength(1);
    expect(root.textContent).toContain("이도현");
    // 짝 2: 빈 메시지라는 말도, 글자 없는 문단도 없다.
    expect(root.textContent).not.toContain("내용 없는 메시지");
    expect(emptyParagraphs(root)).toEqual([]);
  });

  it("사진 여러 장과 파일이 섞여도 목록이 모두 그려진다", () => {
    const root = mountRow(
      message({
        body: "",
        attachments: [
          png("a1"),
          png("a2"),
          { id: "f1", name: "견적.pdf", mime: "application/pdf", sizeBytes: 9000 },
        ],
      })
    );
    expect(root.querySelector('[data-testid="attachment-list"]')).not.toBeNull();
    expect(root.querySelectorAll('[data-testid="attachment-image"]').length).toBe(2);
    expect(root.querySelectorAll('[data-testid="attachment-card"]').length).toBe(1);
    expect(root.textContent).not.toContain("내용 없는 메시지");
  });

  it("글과 사진이 함께 있으면 둘 다 그린다 (대조)", () => {
    const root = mountRow(message({ body: "현장 사진이에요", attachments: [png("a1")] }));
    expect(root.textContent).toContain("현장 사진이에요");
    expect(root.querySelectorAll('[data-testid="attachment-image"]')).toHaveLength(1);
  });

  it("지워진 행은 첨부가 남아 있어도 사진을 그리지 않는다 (삭제가 첨부를 이긴다)", () => {
    const root = mountRow(message({ body: undefined, state: "deleted", attachments: [png("a1")] }));
    expect(root.querySelector('[data-testid="tombstone"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="attachment-image"]')).toBeNull();
  });
});

describe("#4294 웹: 실시간 프레임으로 온 사진만 있는 메시지는 새로고침 없이 사진으로 선다", () => {
  // 서버는 첨부를 메시지와 같은 트랜잭션에서 묶고 complete 인 것만 묶는다. 그 트랜잭션의 `message.new`
  // 프레임이 attachments 를 싣는다 - 「메시지가 먼저, 첨부가 나중」 경로는 계약에 없다. 이 시험은 받는 쪽
  // 절반을 화면까지 잇는다: 프레임 → payloadToMessage → reconcileMessages → 행.
  const frame = (over: Partial<MessageNewEvent["payload"]> = {}): MessageNewEvent => ({
    type: "message.new",
    v: 1,
    ts: 8000,
    seq: 8,
    payload: {
      id: "0199eeee-0000-7000-8000-000000000502",
      channel_id: CH,
      seq: 8,
      type: "text",
      body: null,
      author_member_id: OTHER,
      hlc_ts: 8000,
      hlc_count: 0,
      attachments: [png("live-1")],
      ...over,
    },
  });

  it("프레임 하나가 곧 사진이다", () => {
    const state = reconcileMessages(
      { messages: [], oldestSeq: null, newestSeq: null },
      [payloadToMessage(frame().payload)]
    );
    expect(state.messages).toHaveLength(1);
    const root = mountRow(state.messages[0]);
    expect(root.querySelectorAll('[data-testid="attachment-image"]')).toHaveLength(1);
    expect(root.textContent).not.toContain("내용 없는 메시지");
  });

  it("첨부 키가 없는 프레임은 사진을 지어내지 않는다 (대조)", () => {
    const state = reconcileMessages(
      { messages: [], oldestSeq: null, newestSeq: null },
      [payloadToMessage(frame({ attachments: undefined }).payload)]
    );
    const root = mountRow(state.messages[0]);
    expect(root.querySelector('[data-testid="attachment-image"]')).toBeNull();
  });
});

describe("#4294 웹: 액션 시트와 리마인더가 사진만 보낸 메시지를 가리키는 한 줄", () => {
  const photos = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `현장${i}.png`, mime: "image/png", sizeBytes: 4096 }));

  it("시트와 리마인더 미리보기가 「내용 없는 메시지」가 아니라 「사진 2장」이다", () => {
    handed.sheetPreview = null;
    handed.remindPreview = null;
    mountRow(message({ body: "", attachments: photos(2) }), true);
    // 짝: 두 컴포넌트가 실제로 마운트돼 props 를 받았다 (null 이면 아래 단정은 헛돈다).
    expect(handed.sheetPreview).not.toBeNull();
    expect(handed.remindPreview).not.toBeNull();
    expect(handed.sheetPreview).toBe("사진 2장");
    expect(handed.remindPreview).toBe("사진 2장");
  });

  it("리마인더는 확정할 때 그 줄을 저장한다 (목록에서 다시 보이는 값이다)", () => {
    handed.mutate.mockClear();
    mountRow(message({ body: undefined, attachments: [{ id: "f1", name: "견적.pdf", mime: "application/pdf", sizeBytes: 9000 }] }), true);
    expect(handed.commit).not.toBeNull();
    handed.commit?.(1_900_000_000_000, "");
    expect(handed.mutate).toHaveBeenCalledTimes(1);
    expect(handed.mutate.mock.calls[0][0]).toMatchObject({ messagePreview: "파일 1개" });
  });

  it("글이 있으면 글이 이긴다 (대조)", () => {
    mountRow(message({ body: "  현장 사진이에요  ", attachments: photos(1) }), true);
    expect(handed.sheetPreview).toBe("현장 사진이에요");
    expect(handed.remindPreview).toBe("현장 사진이에요");
  });

  it("글도 첨부도 없으면 예전 문장이다 (대조)", () => {
    mountRow(message({ body: "", attachments: [] }), true);
    expect(handed.sheetPreview).toBe("내용 없는 메시지");
    expect(handed.remindPreview).toBe("내용 없는 메시지");
  });
});
