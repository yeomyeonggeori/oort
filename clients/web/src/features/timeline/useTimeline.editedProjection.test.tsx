// @vitest-environment jsdom
// #4450 — 편집이 thread 롤업·인용을 지우지 않고, 안 든 줄의 편집은 끼어들지 않는다.
//
// 진짜 `useTimeline` 을 가짜 RealtimeHandle 과 가짜 fetch 위에서 돌린다. 코어 시험
// (`packages/momo-core/.../editedProjection.test.ts`)이 접기 함수와 「든 줄만 갱신」
// 문 하나를 재는 것이라면, 이 시험이 재는 것은 **이 훅의 두 입구가 그 문을 지난다**는
// 사실이다: 실시간 `message.edited` 프레임, 그리고 고친 사람 자신의 PATCH 응답.
// 서버는 둘 다에서 롤업과 풀린 인용을 뺀다(`interaction.rs` `build_message_edited_payload`,
// `routes/messages.rs` `edit` 의 `thread: None`·`reply_to: None`) — 프레임·응답은 그 키
// 그대로 쓴다.
//
// 「안 든 줄」 시험이 재는 피해는 눈에 보이는 한 줄이 아니라 **페이지 커서**다: 끼어든
// 줄이 `oldestSeq` 를 내리면 「위로 더 읽기」(`before: state.oldestSeq`)가 그 사이 기록을
// 건너뛰고, 새로운 줄이 `newestSeqRef` 를 올리면 꼬리 되읽기(`after`)가 그 줄 앞을
// 건너뛴다. 그래서 단정은 `fetchMessages` 에 실제로 나간 인자에 건다.
//
// 가짜 서버(`rest.server`)는 실제 서버처럼 `?after=N` 에 **커서 값으로** 답한다(seq 가 N 보다
// 큰 줄, 편집이 반영된 현재 상태). 커서가 틀리면 줄이 오지 않으므로, 「버린 편집이 꼬리
// 되읽기를 막지 않는다」가 줄이 도착했다는 양성 단정으로 선다.

import { createElement, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fetchMessages,
  threadRollup,
  type Message,
  type MessageAttachment,
  type QuotedMessage,
} from "@momo/core/lib/api";
import type { RecoveryMarker } from "@momo/core/features/timeline/model";
import { useTimeline } from "./useTimeline";
import type { RealtimeHandle } from "@/lib/realtime";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-000000000101";

const ROOT_ID = "0199ffff-0000-7000-8000-000000000051"; // seq 7, 답글이 달린 루트
const QUOTING_ID = "0199ffff-0000-7000-8000-000000000052"; // seq 9, 원본을 인용한 줄
const QUOTED_ID = "0199ffff-0000-7000-8000-000000000031"; // seq 3, 창 밖의 원본

const ROLLUP = {
  reply_count: 3,
  last_reply_seq: 12,
  last_reply_at: 1_700_000_500_000,
};
const QUOTE: QuotedMessage = {
  id: QUOTED_ID,
  seq: 3,
  authorMemberId: OTHER,
  type: "text",
  body: "금요일 배포 일정 확인 부탁드려요",
  state: "sent",
};
const PHOTO: MessageAttachment = {
  id: "0199ffff-0000-7000-8000-0000000000f1",
  name: "IMG_0412.jpg",
  mime: "image/jpeg",
  sizeBytes: 183_204,
};
const ROOT_EDITED = "배포 일정 공유드려요 (금요일 오전으로 확정)";
const QUOTING_EDITED = "네, 금요일 오전 열 시로 잡을게요";

const rest = vi.hoisted(() => ({
  head: [] as unknown[],
  nextBefore: undefined as number | undefined,
  /** 서버가 지금 들고 있는 줄들(편집 반영). `?after=N` 은 seq > N 인 줄을 오름차순으로 돌려준다. */
  server: [] as Array<{ seq: number }>,
}));
const patch = vi.hoisted(() => ({
  respond: null as null | ((messageId: string, body: string) => unknown),
}));

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    // 머리 읽기는 `rest.head`, 꼬리(`after`) 읽기는 가짜 서버의 현재 상태(`rest.server`, 기본은 비어
    // 있다), 위로(`before`) 읽기는 비어 있다 — 호출 인자가 시험의 증거이고, 되읽기가 옛 본문으로
    // 편집을 덮어 시험을 흔들지 않게 한다.
    fetchMessages: vi.fn(
      async (
        _ws: string,
        _ch: string,
        query: { after?: number; before?: number } = {}
      ) => {
        if (query.after !== undefined) {
          const after = query.after;
          return {
            messages: rest.server
              .filter((m) => m.seq > after)
              .sort((a, b) => a.seq - b.seq),
            nextBefore: undefined,
          };
        }
        if (query.before !== undefined) {
          return { messages: [], nextBefore: undefined };
        }
        return { messages: rest.head, nextBefore: rest.nextBefore };
      }
    ),
    fetchReactionSnapshot: vi.fn(async () => ({ reactions: [] })),
    fetchChannelPins: vi.fn(async () => ({ pins: [] })),
    fetchMessageUnfurls: vi.fn(async () => ({ unfurls: [] })),
    editMessage: vi.fn(async (_ws: string, messageId: string, body: string) => {
      if (patch.respond === null) throw new Error("patch.respond not set");
      return patch.respond(messageId, body);
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
  oldestSeq: number | null;
  newestSeq: number | null;
  markers: RecoveryMarker[];
  editMessage: ((message: Message, body: string) => Promise<void>) | null;
  loadOlder: (() => Promise<void>) | null;
} = {
  messages: [],
  oldestSeq: null,
  newestSeq: null,
  markers: [],
  editMessage: null,
  loadOlder: null,
};

function Probe(): ReactElement {
  const t = useTimeline(realtime, WS, CH, ME);
  useEffect(() => {
    out.messages = t.state.messages;
    out.oldestSeq = t.state.oldestSeq;
    out.newestSeq = t.state.newestSeq;
    out.markers = t.recoveryMarkers;
    out.editMessage = t.editMessage;
    out.loadOlder = t.loadOlder;
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
  rest.head = [];
  rest.nextBefore = undefined;
  rest.server = [];
  patch.respond = null;
  vi.mocked(fetchMessages).mockClear();
  out.messages = [];
  out.oldestSeq = null;
  out.newestSeq = null;
  out.markers = [];
  out.editMessage = null;
  out.loadOlder = null;
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

/** 기록 페이지가 싣는, 답글이 달린 루트. */
function rootRow(over: Partial<Message> = {}): Message {
  return {
    id: ROOT_ID,
    channelId: CH,
    seq: 7,
    hlcTs: 1_700_000_007_000,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: "text",
    body: "배포 일정 공유드려요",
    state: "sent",
    createdAtMs: 1_700_000_007_000,
    thread: ROLLUP,
    ...over,
  };
}

/** 기록 페이지가 싣는, 원본(창 밖)을 인용한 줄 — 풀린 인용은 페이지에만 있다. */
function quotingRow(over: Partial<Message> = {}): Message {
  return {
    id: QUOTING_ID,
    channelId: CH,
    seq: 9,
    hlcTs: 1_700_000_009_000,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: "text",
    body: "네, 금요일 오전으로 잡을게요",
    state: "sent",
    createdAtMs: 1_700_000_009_000,
    replyToId: QUOTED_ID,
    replyTo: QUOTE,
    ...over,
  };
}

/** 최근 꼬리: seq 10·11 만 든 창. */
function tailRow(seq: number): Message {
  return {
    id: `0199ffff-0000-7000-8000-0000000000${seq.toString().padStart(2, "0")}`,
    channelId: CH,
    seq,
    hlcTs: 1_700_000_000_000 + seq * 1000,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: "text",
    body: `메시지 ${seq}`,
    state: "sent",
    createdAtMs: 1_700_000_000_000 + seq * 1000,
  };
}

type Frame = Parameters<NonNullable<Handlers["onMessage"]>>[0];

/**
 * `build_message_edited_payload` 의 키 전부. **`attachments`·`thread`·`reply_to`·
 * `run_ended` 가 없다.**
 */
function editedFrame(
  row: Message,
  body: string,
  over: Record<string, unknown> = {}
): Frame {
  return {
    type: "message.edited",
    v: 1,
    ts: 1_700_000_099_000,
    seq: row.seq,
    payload: {
      id: row.id,
      channel_id: CH,
      seq: row.seq,
      hlc_ts: row.hlcTs,
      hlc_count: 0,
      author_member_id: row.authorMemberId,
      type: "text",
      state: "edited",
      body,
      props: {},
      root_id: row.rootId ?? null,
      reply_to_id: row.replyToId ?? null,
      run_id: null,
      client_msg_id: "0199ffff-0000-7000-8000-0000000000c1",
      created_at_ms: row.createdAtMs,
      edited_at_ms: 1_700_000_099_000,
      deleted_at_ms: null,
      ...over,
    },
  } as unknown as Frame;
}

/** 서버 `edit` 라우트의 응답: 갱신된 행이고 **롤업·풀린 인용·첨부 키가 없다**. */
function patchResponseOf(row: Message, body: string): Message {
  const {
    attachments: _a,
    thread: _t,
    replyTo: _q,
    runEnded: _r,
    ...rest
  } = row;
  return {
    ...rest,
    body,
    state: "edited",
    editedAtMs: 1_700_000_099_000,
  };
}

/** `fetchMessages` 가 받은 질의들. */
function queries(): { after?: number; before?: number; limit?: number }[] {
  return vi
    .mocked(fetchMessages)
    .mock.calls.map(
      (call) => (call[2] ?? {}) as { after?: number; before?: number; limit?: number }
    );
}

const tick = () =>
  act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

/** 첫 구독 — 끊겼던 구간이 없다. 이후의 `recovered: true` 가 「재연결 뒤 되쏘기」다. */
async function subscribeFirst(): Promise<void> {
  await act(async () => {
    rail.handlers?.onSubscribed({ recovered: false });
  });
  await tick();
}

/**
 * 레일이 끊겼다 붙고 끊긴 구간을 되쏜다. centrifuge-js 는 되쏜 publication 을 `subscribed`
 * 직후 **같은 호출 스택**에서 흘리므로 둘은 한 `act` 몸통 안에서 동기로 부른다.
 */
async function replay(frames: Frame[]): Promise<void> {
  await act(async () => {
    rail.handlers?.onSubscribed({ recovered: true });
    for (const frame of frames) rail.handlers?.onMessage(frame);
  });
  await tick();
}

/** `message.new` 프레임 — 대조군(남의 새 줄은 표지를 세운다)에 쓴다. */
function newFrame(row: Message): Frame {
  return {
    type: "message.new",
    v: 1,
    ts: row.createdAtMs,
    seq: row.seq,
    payload: {
      id: row.id,
      channel_id: CH,
      seq: row.seq,
      hlc_ts: row.hlcTs,
      hlc_count: 0,
      author_member_id: row.authorMemberId,
      type: "text",
      body: row.body,
      state: "sent",
      created_at_ms: row.createdAtMs,
    },
  } as unknown as Frame;
}

/** `message.deleted` 프레임 — 서버는 id 만 싣는다(지운 본문을 다시 퍼뜨리지 않으려고). */
function deletedFrame(row: Message) {
  return {
    type: "message.deleted",
    v: 1,
    ts: 1_700_000_300_000,
    seq: row.seq,
    payload: { message_id: row.id },
  } as unknown as Parameters<NonNullable<Handlers["onMessageDeleted"]>>[0];
}

describe("useTimeline — 고쳐도 답글 롤업과 인용은 남는다 (#4450)", () => {
  it("기록으로 읽은 루트를 다른 사람이 고치면(실시간 프레임), 답글 롤업이 남는다", async () => {
    rest.head = [rootRow()];
    await mount();
    expect(threadRollup(out.messages[0])?.replyCount).toBe(3);

    await act(async () => {
      rail.handlers?.onMessage(editedFrame(rootRow(), ROOT_EDITED));
    });

    expect(out.messages).toHaveLength(1);
    expect(threadRollup(out.messages[0])?.replyCount).toBe(3);
    // 편집이 실제로 적용됐다 — 롤업이 남은 것이 편집이 먹지 않아서가 아님을 같은 시험이 보인다.
    expect(out.messages[0].body).toBe(ROOT_EDITED);
    expect(out.messages[0].state).toBe("edited");
  });

  it("고친 사람 자신의 화면도 같다 — PATCH 응답에는 롤업이 없다", async () => {
    rest.head = [rootRow({ authorMemberId: ME })];
    patch.respond = (_id, body) => patchResponseOf(rootRow({ authorMemberId: ME }), body);
    await mount();

    await act(async () => {
      await out.editMessage?.(out.messages[0], ROOT_EDITED);
    });

    expect(out.messages).toHaveLength(1);
    expect(threadRollup(out.messages[0])?.replyCount).toBe(3);
    expect(out.messages[0].body).toBe(ROOT_EDITED);
    expect(out.messages[0].state).toBe("edited");
  });

  it("인용한 줄을 다른 사람이 고치면(실시간 프레임), 원본이 창 밖이어도 풀린 인용이 남는다", async () => {
    rest.head = [quotingRow()];
    await mount();
    expect(out.messages[0].replyTo).toEqual(QUOTE);

    await act(async () => {
      rail.handlers?.onMessage(editedFrame(quotingRow(), QUOTING_EDITED));
    });

    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].replyTo).toEqual(QUOTE);
    expect(out.messages[0].body).toBe(QUOTING_EDITED);
    expect(out.messages[0].state).toBe("edited");
  });

  it("고친 사람 자신의 화면도 같다 — PATCH 응답에는 풀린 인용이 없다", async () => {
    rest.head = [quotingRow({ authorMemberId: ME })];
    patch.respond = (_id, body) =>
      patchResponseOf(quotingRow({ authorMemberId: ME }), body);
    await mount();

    await act(async () => {
      await out.editMessage?.(out.messages[0], QUOTING_EDITED);
    });

    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].replyTo).toEqual(QUOTE);
    expect(out.messages[0].body).toBe(QUOTING_EDITED);
  });
});

describe("useTimeline — 편집은 안 든 줄을 만들지 않는다 (#4450)", () => {
  it("든 창보다 오래된 줄의 편집 프레임은 맨 위에 끼지 않고, 위로 더 읽기는 든 가장 오래된 줄 앞에서 읽는다", async () => {
    rest.head = [tailRow(10), tailRow(11)];
    rest.nextBefore = 10;
    await mount();
    expect(out.messages.map((m) => m.seq)).toEqual([10, 11]);

    // 서버가 오래된 카드·옛 글(seq 3)을 알린다 — 이 클라는 그 줄을 들지 않았다.
    await act(async () => {
      rail.handlers?.onMessage(editedFrame(tailRow(3), "오래된 글을 고쳤어요"));
    });

    expect(out.messages.map((m) => m.seq)).toEqual([10, 11]);
    expect(out.oldestSeq).toBe(10);

    await act(async () => {
      await out.loadOlder?.();
    });

    // 끼어든 줄이 `oldestSeq` 를 3 으로 내렸다면 여기가 `before: 3` 이 되어 4~9 가 영영 안 읽힌다.
    const older = queries().filter((q) => q.before !== undefined);
    expect(older).toEqual([{ before: 10, limit: 50 }]);
  });

  it("든 창보다 새로운 줄의 편집 프레임도 끼지 않고, 꼬리 되읽기 커서(after)를 앞세우지 않는다", async () => {
    rest.head = [tailRow(10), tailRow(11)];
    await mount();
    await act(async () => {
      rail.handlers?.onSubscribed({ recovered: false });
    });

    await act(async () => {
      rail.handlers?.onMessage(editedFrame(tailRow(20), "이 클라가 모르는 새 줄의 편집"));
    });
    expect(out.messages.map((m) => m.seq)).toEqual([10, 11]);

    // 끊겼다 다시 이어졌다 — 꼬리를 메운다. 커서가 20 으로 올라가 있으면 그 사이(12~19)와
    // 20 자체를 영영 건너뛴다.
    await act(async () => {
      rail.handlers?.onSubscribed({ recovered: false });
    });

    const tails = queries().filter((q) => q.after !== undefined);
    expect(tails.map((q) => q.after)).toEqual([11, 11]);
    expect(out.newestSeq).toBe(11);
  });

  it("응답한 줄이 이 창에 없으면(방을 옮긴 뒤 도착한 PATCH 응답) 타임라인에 끼지 않는다", async () => {
    rest.head = [tailRow(10), tailRow(11)];
    // 응답은 이 방의 창에 없는 줄(다른 방의 seq 3)이다.
    patch.respond = (_id, body) => ({
      ...patchResponseOf(tailRow(3), body),
      id: "0199ffff-0000-7000-8000-0000000000aa",
      channelId: "00000000-0000-7000-8000-0000000000bb",
    });
    await mount();

    await act(async () => {
      await out.editMessage?.(out.messages[0], "고친 글");
    });

    expect(out.messages.map((m) => m.seq)).toEqual([10, 11]);
    expect(out.oldestSeq).toBe(10);
  });

  it("응답한 줄이 다른 방의 같은 seq 줄이어도(두 방의 seq 는 각자 센다) 든 줄을 덮지 않는다", async () => {
    rest.head = [tailRow(10), tailRow(11)];
    // 방 A 에서 보낸 PATCH 가 방 B 를 보고 있을 때 돌아왔다. 방 B 에도 seq 10 이 있다.
    patch.respond = (_id, body) => ({
      ...patchResponseOf(tailRow(10), body),
      id: "0199ffff-0000-7000-8000-0000000000bb",
      channelId: "00000000-0000-7000-8000-0000000000bb",
    });
    await mount();

    await act(async () => {
      await out.editMessage?.(out.messages[0], "다른 방의 글을 고쳤어요");
    });

    expect(out.messages.map((m) => m.seq)).toEqual([10, 11]);
    // 이 방의 seq 10 은 그대로다 — id 를 보지 않으면 다른 방의 글이 이 줄을 덮는다.
    expect(out.messages[0].id).toBe(tailRow(10).id);
    expect(out.messages[0].body).toBe("메시지 10");
  });
});

describe("useTimeline — 든 묘비 위의 늦은 편집은 무시한다 (#4450 planner 결정 5)", () => {
  it("지운 줄에 늦게 온 message.edited 프레임(지우기 전에 보낸 것)은 본문을 되살리지 않는다", async () => {
    rest.head = [rootRow()];
    await mount();
    await subscribeFirst();

    // 다른 기기가 그 줄을 지웠다. 줄은 제자리에 묘비로 남는다.
    await act(async () => {
      rail.handlers?.onMessageDeleted?.(deletedFrame(rootRow()));
    });
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].state).toBe("deleted");
    expect(out.messages[0].body).toBeUndefined();

    // 지우기 전에 보낸 편집 프레임이 되쏘기로 늦게 닿았다. 서버는 지운 뒤의 편집을 받지 않으므로
    // 묘비가 이긴다 — 지운 글이 화면에 다시 서면 안 된다.
    await act(async () => {
      rail.handlers?.onMessage(editedFrame(rootRow(), ROOT_EDITED));
    });

    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].state).toBe("deleted");
    expect(out.messages[0].body).toBeUndefined();
  });

  it("내 편집 요청이 도는 사이 다른 기기가 지웠다 — PATCH 응답이 늦게 와도 묘비가 남는다", async () => {
    rest.head = [rootRow({ authorMemberId: ME })];
    let resolvePatch: (message: Message) => void = () => undefined;
    const response = new Promise<Message>((resolve) => {
      resolvePatch = resolve;
    });
    patch.respond = () => response;
    await mount();
    await subscribeFirst();

    let editing: Promise<void> | undefined;
    await act(async () => {
      editing = out.editMessage?.(out.messages[0], ROOT_EDITED);
    });
    await act(async () => {
      rail.handlers?.onMessageDeleted?.(deletedFrame(rootRow({ authorMemberId: ME })));
    });
    expect(out.messages[0].state).toBe("deleted");

    await act(async () => {
      resolvePatch(patchResponseOf(rootRow({ authorMemberId: ME }), ROOT_EDITED));
      await editing;
    });

    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].state).toBe("deleted");
    expect(out.messages[0].body).toBeUndefined();
  });
});

describe("useTimeline — 버린 편집은 꼬리 되읽기가 완전한 투영으로 메운다 (#4450 planner 결정 2)", () => {
  /** 서버가 지금 들고 있는 seq 12 — 누군가 고친 뒤의 현재 상태. 페이지 읽기는 장식을 싣는다. */
  function serverRow12(): Message {
    return {
      ...tailRow(12),
      state: "edited",
      body: "고친 뒤의 글",
      editedAtMs: 1_700_000_099_000,
      replyToId: QUOTED_ID,
      replyTo: QUOTE,
      thread: ROLLUP,
      attachments: [PHOTO],
    };
  }

  it("못 본 새 줄(seq 12)의 편집 프레임은 버려지고, 다음 꼬리 되읽기가 편집본을 롤업·인용·첨부와 함께 들인다", async () => {
    rest.head = [tailRow(10), tailRow(11)];
    await mount();
    await subscribeFirst();
    expect(out.messages.map((m) => m.seq)).toEqual([10, 11]);

    // 끊긴 사이 남이 쓴 줄(seq 12)을 또 남이 고쳤다. 이 클라는 message.new 를 못 받았고 편집
    // 프레임만 닿는다.
    await act(async () => {
      rail.handlers?.onMessage(
        editedFrame(tailRow(12), "고친 뒤의 글", { reply_to_id: QUOTED_ID })
      );
    });
    // 버려졌다 — 반쪽 행이 끼지 않았고, 꼬리 커서(`newestSeq`)도 그대로다.
    expect(out.messages.map((m) => m.seq)).toEqual([10, 11]);
    expect(out.newestSeq).toBe(11);

    // 복구: 서버의 현재 상태(편집이 반영된 줄)를 읽는다. 서버는 커서 값에 답하므로 커서가 12 로
    // 올라가 있었다면 이 줄은 영영 오지 않는다.
    rest.server = [serverRow12()];
    await act(async () => {
      rail.handlers?.onSubscribed({ recovered: false });
    });
    await tick();

    const tails = queries()
      .filter((q) => q.after !== undefined)
      .map((q) => q.after);
    expect(tails).toEqual([11, 11]);
    expect(out.messages.map((m) => m.seq)).toEqual([10, 11, 12]);
    const row = out.messages[2];
    expect(row.body).toBe("고친 뒤의 글");
    expect(row.state).toBe("edited");
    expect(threadRollup(row)?.replyCount).toBe(3);
    expect(row.replyTo).toEqual(QUOTE);
    expect(row.attachments).toEqual([PHOTO]);
    // 버린 편집은 도착 장부에도 흔적을 남기지 않았다 — 이 줄은 이 타임라인에 **처음** 든 남의
    // 줄이라 복구 표지가 선다. (편집 프레임이 줄 id 를 「이미 든 줄」로 등록했다면 여기서 표지가
    // 사라진다.)
    expect(out.markers).toHaveLength(1);
    expect(out.markers[0]).toMatchObject({ source: "backfill", seq: 12 });
  });
});

describe("useTimeline — 복구 재생 구간의 편집은 복구 표지를 올리지 않는다 (#4450 planner 결정 7)", () => {
  it.each([
    { seq: 20, label: "이 클라보다 새 줄 — message.new 를 놓쳤다" },
    { seq: 5, label: "이 클라의 창보다 오래된 줄 — 어제 글" },
  ])(
    "안 본 줄($label)의 message.edited 가 되쏘기로 와도 표지가 서지 않는다 — 편집은 남이 새로 보낸 줄이 아니다",
    async ({ seq }) => {
      rest.head = [tailRow(10), tailRow(11)];
      await mount();
      await subscribeFirst();

      await replay([editedFrame(tailRow(seq), "고쳐 썼어요")]);

      // 줄도 끼지 않았고 표지도 서지 않았다. (수리 전에는 이 프레임이 「남이 새로 보낸 줄」로
      // 세어져 반쪽 행과 함께 표지를 올렸다.)
      expect(out.messages.map((m) => m.seq)).toEqual([10, 11]);
      expect(out.markers).toEqual([]);

      // 대조군: 같은 배선이 남의 새 줄에는 표지를 **세운다.** 위의 「없다」가 배선이 죽어서
      // 없는 것이 아님을 보인다.
      await replay([newFrame(tailRow(30))]);
      expect(out.markers).toHaveLength(1);
      expect(out.markers[0]).toMatchObject({ source: "replay", seq: 30 });
    }
  );
});
