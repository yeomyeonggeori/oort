// @vitest-environment jsdom
// #4441 — 사진 달린 메시지의 글을 고쳐도 사진 카드가 남는다.
//
// 진짜 `useTimeline` 을 가짜 RealtimeHandle 과 가짜 fetch 위에서 돌린다. 코어 시험
// (`packages/momo-core/.../editedAttachments.test.ts`)이 접기 함수 하나를 재는
// 것이라면, 이 시험이 재는 것은 **이 훅의 세 입구가 그 접기를 지난다**는 사실이다:
// 기록 페이지, 실시간 `message.edited`, 그리고 고친 사람 자신의 PATCH 응답.
// 서버는 뒤의 둘에서 첨부를 뺀다(`routes/messages.rs` `edit`, `interaction.rs`
// `build_message_edited_payload`) — 프레임·응답은 그 키 그대로 쓴다.

import { createElement, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message, MessageAttachment } from "@momo/core/lib/api";
import { useTimeline } from "./useTimeline";
import type { RealtimeHandle } from "@/lib/realtime";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-000000000101";
const ID = "0199eeee-0000-7000-8000-000000000041";

const PHOTO: MessageAttachment = {
  id: "0199eeee-0000-7000-8000-0000000000f1",
  name: "IMG_0412.jpg",
  mime: "image/jpeg",
  sizeBytes: 183_204,
};
const EDITED_BODY = "점심 먹은 곳 사진이에요 (가게 이름 추가)";

const restPage = vi.hoisted(() => ({ messages: [] as unknown[] }));
const patch = vi.hoisted(() => ({
  calls: [] as { messageId: string; body: string }[],
}));

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchMessages: vi.fn(async () => ({
      messages: restPage.messages,
      nextBefore: undefined,
    })),
    fetchReactionSnapshot: vi.fn(async () => ({ reactions: [] })),
    fetchChannelPins: vi.fn(async () => ({ pins: [] })),
    fetchMessageUnfurls: vi.fn(async () => ({ unfurls: [] })),
    // 서버 `edit` 라우트의 응답 모양: 갱신된 행이고 **`attachments` 키가 없다**.
    editMessage: vi.fn(async (_ws: string, messageId: string, body: string) => {
      patch.calls.push({ messageId, body });
      return {
        id: messageId,
        channelId: CH,
        seq: 7,
        hlcTs: 1_700_000_007_000,
        hlcCount: 0,
        authorMemberId: ME,
        type: "text",
        body,
        state: "edited",
        createdAtMs: 1_700_000_007_000,
        editedAtMs: 1_700_000_099_000,
      } satisfies Message;
    }),
  };
});

type Handlers = Parameters<RealtimeHandle["subscribeChannel"]>[2];
const rail: { handlers: Handlers | null } = { handlers: null };

const realtime = {
  subscribeChannel: (_ws: string, _ch: string, handlers: Handlers) => {
    rail.handlers = handlers;
    return () => {
      rail.handlers = null;
    };
  },
  subscribeAgent: () => () => undefined,
  subscribeTyping: () => () => undefined,
  subscribeWorkSession: () => () => undefined,
  subscribeCascade: () => () => undefined,
  subscribeHuddle: () => () => undefined,
  reconnect: () => undefined,
  dispose: () => undefined,
} as unknown as RealtimeHandle;

const out: {
  messages: Message[];
  editMessage: ((message: Message, body: string) => Promise<void>) | null;
} = { messages: [], editMessage: null };

function Probe(): ReactElement {
  const t = useTimeline(realtime, WS, CH, ME);
  useEffect(() => {
    out.messages = t.state.messages;
    out.editMessage = t.editMessage;
  });
  return createElement("div");
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function defaultMatchMedia(q: string) {
  return {
    matches: false,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: defaultMatchMedia,
    });
  }
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  rail.handlers = null;
  restPage.messages = [];
  patch.calls = [];
  out.messages = [];
  out.editMessage = null;
});

async function mount(): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(Probe));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** 기록 페이지가 싣는 사진 행 — 서버는 기록에는 첨부를 싣는다. */
function photoRow(over: Partial<Message> = {}): Message {
  return {
    id: ID,
    channelId: CH,
    seq: 7,
    hlcTs: 1_700_000_007_000,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: "text",
    body: "점심 먹은 곳 사진이에요",
    state: "sent",
    createdAtMs: 1_700_000_007_000,
    attachments: [PHOTO],
    ...over,
  };
}

type Frame = Parameters<NonNullable<Handlers["onMessage"]>>[0];

/** 센트리퓨고가 싣는 `message.new` — 첨부는 있을 때만 실린다. */
function newFrame(author = OTHER): Frame {
  return {
    type: "message.new",
    v: 1,
    ts: 1_700_000_007_000,
    seq: 7,
    payload: {
      id: ID,
      channel_id: CH,
      seq: 7,
      type: "text",
      body: "점심 먹은 곳 사진이에요",
      author_member_id: author,
      hlc_ts: 1_700_000_007_000,
      hlc_count: 0,
      root_id: null,
      reply_to_id: null,
      attachments: [PHOTO],
    },
  } as unknown as Frame;
}

/** `build_message_edited_payload` 의 키 전부. **`attachments` 가 없다.** */
function editedFrame(author = OTHER): Frame {
  return {
    type: "message.edited",
    v: 1,
    ts: 1_700_000_099_000,
    seq: 7,
    payload: {
      id: ID,
      channel_id: CH,
      seq: 7,
      hlc_ts: 1_700_000_007_000,
      hlc_count: 0,
      author_member_id: author,
      type: "text",
      state: "edited",
      body: EDITED_BODY,
      props: {},
      root_id: null,
      reply_to_id: null,
      run_id: null,
      client_msg_id: "0199eeee-0000-7000-8000-0000000000c1",
      created_at_ms: 1_700_000_007_000,
      edited_at_ms: 1_700_000_099_000,
      deleted_at_ms: null,
    },
  } as unknown as Frame;
}

describe("useTimeline — 고쳐도 사진 카드는 남는다 (#4441)", () => {
  it("기록으로 읽은 사진 메시지를 다른 사람이 고치면, 실시간 편집 프레임 뒤에도 사진이 남는다", async () => {
    restPage.messages = [photoRow()];
    await mount();
    expect(out.messages[0].attachments).toEqual([PHOTO]);

    await act(async () => {
      rail.handlers?.onMessage(editedFrame());
    });

    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].attachments).toEqual([PHOTO]);
    // 편집이 실제로 적용됐다 — 사진이 남은 것이 편집이 먹지 않아서가 아님을 같은 시험이 보인다.
    expect(out.messages[0].body).toBe(EDITED_BODY);
    expect(out.messages[0].state).toBe("edited");
    expect(out.messages[0].editedAtMs).toBe(1_700_000_099_000);
  });

  it("실시간으로 받은 사진 메시지도 마찬가지다 (message.new → message.edited)", async () => {
    await mount();

    await act(async () => {
      rail.handlers?.onMessage(newFrame());
    });
    expect(out.messages[0].attachments).toEqual([PHOTO]);

    await act(async () => {
      rail.handlers?.onMessage(editedFrame());
    });

    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].attachments).toEqual([PHOTO]);
    expect(out.messages[0].body).toBe(EDITED_BODY);
  });

  it("고친 사람 자신의 화면도 같다 — PATCH 응답에는 첨부가 없다", async () => {
    restPage.messages = [photoRow({ authorMemberId: ME })];
    await mount();
    const mine = out.messages[0];
    expect(mine.attachments).toEqual([PHOTO]);

    await act(async () => {
      await out.editMessage?.(mine, EDITED_BODY);
    });

    expect(patch.calls).toEqual([{ messageId: ID, body: EDITED_BODY }]);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].attachments).toEqual([PHOTO]);
    expect(out.messages[0].body).toBe(EDITED_BODY);
    expect(out.messages[0].state).toBe("edited");
  });

  it("응답과 에코 프레임이 겹쳐 와도(고친 사람 화면) 사진이 남는다", async () => {
    restPage.messages = [photoRow({ authorMemberId: ME })];
    await mount();

    await act(async () => {
      await out.editMessage?.(out.messages[0], EDITED_BODY);
      rail.handlers?.onMessage(editedFrame(ME));
    });

    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].attachments).toEqual([PHOTO]);
    expect(out.messages[0].body).toBe(EDITED_BODY);
  });
});
