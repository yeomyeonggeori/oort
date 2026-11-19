// @vitest-environment jsdom
// #5825 수리 1회차(검수 r1 M6 V3·V4, M3): 읽기 하한(ADR-0177 증보 2026-11-14 D18·D22) 아래의 실시간 발행물은 그리지 않는다.
//
// 진짜 `useTimeline` 을 가짜 RealtimeHandle 위에서 돌리고 다섯 입구(새 글·고침 / 지움 / 반응 / 고정 / 링크 카드)에 프레임을 밀어,
// 하한 아래 seq 면 **화면에 닿는 값이 그대로**이고 하한 위 seq 면 **바뀐다**는 것을 쌍으로 잰다(위쪽 쌍이 없으면 「아무것도 안 바뀜」이 입구가 죽은
// 것인지 판정이 막은 것인지 가를 수 없다). 입구마다 대상 글(seq)은 그 프레임이 싣는 seq 이다(반응·고정·링크 카드·지움은 대상 글의 seq 를 쓴다).
//
// 또 하나(M3): 나갈 때 날아가던 글이 늦게 성공해도 하한 아래 seq 면 나간 뒤의 화면에 되살아나지 않는다.

import { act, createElement, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message } from "@momo/core/lib/api";
import type { MessageUnfurl } from "@momo/core/features/timeline/unfurl";
import type { PinMap } from "@momo/core/features/timeline/pins";
import type { ReactionMap } from "@momo/core/features/timeline/reactions";
import { useTimeline } from "./useTimeline";
import type { RealtimeHandle } from "@/lib/realtime";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-000000000101";
/** 하한: seq 10 이상만 이 기기의 화면에 선다. */
const FLOOR = 10;
const BELOW_ID = "0199ffff-0000-7000-8000-000000000005";
const ABOVE_ID = "0199ffff-0000-7000-8000-00000000000c";

const rest = vi.hoisted(() => ({ head: [] as unknown[] }));
const send = vi.hoisted(() => ({ sendMessage: vi.fn() }));

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchMessages: vi.fn(async () => ({ messages: rest.head, nextBefore: undefined })),
    fetchReactionSnapshot: vi.fn(async () => ({ reactions: [] })),
    fetchChannelPins: vi.fn(async () => ({ pins: [] })),
    fetchMessageUnfurls: vi.fn(async () => ({ unfurls: [] })),
    sendMessage: send.sendMessage,
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
  reactions: ReactionMap;
  pins: PinMap;
  unfurls: Record<string, readonly MessageUnfurl[]>;
  send: ((body: string) => Promise<void>) | null;
} = { messages: [], reactions: {}, pins: {}, unfurls: {}, send: null };

const floor = { value: FLOOR as number | null };

function Probe(): ReactElement {
  const t = useTimeline(realtime, WS, CH, ME, { historyFloorOf: () => floor.value });
  useEffect(() => {
    out.messages = t.state.messages;
    out.reactions = t.reactions;
    out.pins = t.pins;
    out.unfurls = t.unfurls;
    out.send = t.send;
  });
  return createElement("div");
}

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (q: string) => ({ matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined }),
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
  floor.value = FLOOR;
  out.messages = [];
  out.reactions = {};
  out.pins = {};
  out.unfurls = {};
  out.send = null;
  send.sendMessage.mockReset();
  localStorage.clear();
});

function row(seq: number, id: string, body: string): Message {
  return {
    id,
    channelId: CH,
    seq,
    hlcTs: 1_700_000_000_000 + seq * 1000,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: "text",
    body,
    state: "sent",
    createdAtMs: 1_700_000_000_000 + seq * 1000,
  };
}

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

const frame = async (fn: (h: Handlers) => void) => {
  await act(async () => {
    fn(rail.handlers!);
    await Promise.resolve();
  });
};

const messageFrame = (type: "message.new" | "message.edited", seq: number, id: string, body: string): Parameters<NonNullable<Handlers["onMessage"]>>[0] => ({
  type,
  v: 1,
  ts: 1_700_000_099_000,
  seq,
  payload: {
    id,
    channel_id: CH,
    seq,
    type: "text",
    body,
    author_member_id: OTHER,
    hlc_ts: 1_700_000_000_000 + seq * 1000,
    hlc_count: 0,
    created_at_ms: 1_700_000_000_000 + seq * 1000,
    state: "sent",
  },
});

describe("useTimeline · 읽기 하한 아래 실시간 발행물 (D18·D22, #5825)", () => {
  const seed = () => {
    rest.head = [row(12, ABOVE_ID, "하한 위 글"), row(5, BELOW_ID, "하한 아래 글")];
  };
  const bodyOf = (id: string) => out.messages.find((m) => m.id === id)?.body;

  it("새 글: 하한 아래 seq 는 그려지지 않고, 하한 위 seq 는 그려진다", async () => {
    seed();
    await mount();
    await frame((h) => h.onMessage?.(messageFrame("message.new", 6, "0199ffff-0000-7000-8000-000000000006", "하한 아래 새 글")));
    expect(out.messages.map((m) => m.seq)).not.toContain(6);
    await frame((h) => h.onMessage?.(messageFrame("message.new", 13, "0199ffff-0000-7000-8000-00000000000d", "하한 위 새 글")));
    expect(out.messages.map((m) => m.seq)).toContain(13);
  });

  it("고침: 하한 아래 글의 고침은 본문을 바꾸지 않고, 하한 위 글의 고침은 바꾼다", async () => {
    seed();
    await mount();
    expect(bodyOf(BELOW_ID)).toBe("하한 아래 글");
    await frame((h) => h.onMessage?.(messageFrame("message.edited", 5, BELOW_ID, "하한 아래 글 (고침)")));
    expect(bodyOf(BELOW_ID)).toBe("하한 아래 글");
    await frame((h) => h.onMessage?.(messageFrame("message.edited", 12, ABOVE_ID, "하한 위 글 (고침)")));
    expect(bodyOf(ABOVE_ID)).toBe("하한 위 글 (고침)");
  });

  it("지움: 하한 아래 글의 지움은 줄을 그대로 두고, 하한 위 글의 지움은 줄을 지운 표시로 바꾼다", async () => {
    seed();
    await mount();
    await frame((h) => h.onMessageDeleted?.({ type: "message.deleted", v: 1, ts: 1_700_000_099_000, seq: 5, payload: { message_id: BELOW_ID } }));
    expect(out.messages.find((m) => m.id === BELOW_ID)?.state).toBe("sent");
    await frame((h) => h.onMessageDeleted?.({ type: "message.deleted", v: 1, ts: 1_700_000_099_000, seq: 12, payload: { message_id: ABOVE_ID } }));
    expect(out.messages.find((m) => m.id === ABOVE_ID)?.state).toBe("deleted");
  });

  it("반응: 하한 아래 글의 반응은 칩을 만들지 않고, 하한 위 글의 반응은 만든다", async () => {
    seed();
    await mount();
    const reaction = (seq: number, id: string) => ({
      type: "reaction.added" as const, v: 1, ts: 1_700_000_099_000, seq,
      payload: { action: "added" as const, message_id: id, member_id: OTHER, emoji: "👍" },
    });
    await frame((h) => h.onReaction?.(reaction(5, BELOW_ID)));
    expect(Object.keys(out.reactions)).toEqual([]);
    await frame((h) => h.onReaction?.(reaction(12, ABOVE_ID)));
    expect(Object.keys(out.reactions).map((k) => k.toLowerCase())).toEqual([ABOVE_ID]);
  });

  it("고정: 하한 아래 글의 고정은 목록에 서지 않고, 하한 위 글의 고정은 선다", async () => {
    seed();
    await mount();
    const pinned = (seq: number, id: string) => ({
      type: "message.pinned" as const, v: 1, ts: 1_700_000_099_000, seq,
      payload: {
        message_id: id, channel_id: CH, seq, author_member_id: OTHER, type: "text", state: "sent",
        body: "고정 글", created_at_ms: 1_700_000_000_000, pinned_by: OTHER, pinned_at_ms: 1_700_000_050_000,
      },
    });
    await frame((h) => h.onPin?.(pinned(5, BELOW_ID)));
    expect(Object.keys(out.pins)).toEqual([]);
    await frame((h) => h.onPin?.(pinned(12, ABOVE_ID)));
    expect(Object.keys(out.pins)).toEqual([ABOVE_ID]);
  });

  it("링크 카드: 하한 아래 글의 카드는 붙지 않고, 하한 위 글의 카드는 붙는다", async () => {
    seed();
    await mount();
    const unfurl = (seq: number, id: string) => ({
      type: "message.unfurl" as const, v: 1 as const, ts: 1_700_000_099_000, seq,
      payload: {
        message_id: id, channel_id: CH,
        unfurls: [{ id: `u-${seq}`, messageId: id, url: "https://example.test/a", status: "ok" as const, title: "예시" }],
      },
    });
    await frame((h) => h.onUnfurl?.(unfurl(5, BELOW_ID)));
    expect(Object.keys(out.unfurls)).toEqual([]);
    await frame((h) => h.onUnfurl?.(unfurl(12, ABOVE_ID)));
    expect(Object.keys(out.unfurls)).toEqual([ABOVE_ID]);
  });

  it("하한이 없는 대화(나간 적 없음)는 같은 프레임을 모두 그린다 - 하한 판정이 다른 대화를 깎지 않는다", async () => {
    floor.value = null;
    seed();
    await mount();
    await frame((h) => h.onMessage?.(messageFrame("message.edited", 5, BELOW_ID, "하한 없는 대화의 고침")));
    expect(bodyOf(BELOW_ID)).toBe("하한 없는 대화의 고침");
  });

  it("보내기가 늦게 성공해도 응답의 seq 가 하한 아래면 나간 뒤의 화면에 되살리지 않는다 (M3)", async () => {
    await mount();
    // 보내는 중에 나가기가 끝나 하한이 올랐다(이 글의 seq 는 하한 아래다) - 응답이 그 뒤에 온다.
    let respond!: (message: Message) => void;
    send.sendMessage.mockImplementation(() => new Promise<Message>((resolve) => { respond = resolve; }));
    await act(async () => {
      void out.send!("나가기 직전에 보낸 글");
      await Promise.resolve();
    });
    expect(send.sendMessage).toHaveBeenCalledTimes(1);
    await act(async () => {
      respond(row(7, "0199ffff-0000-7000-8000-000000000007", "나가기 직전에 보낸 글"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(out.messages.map((m) => m.body)).not.toContain("나가기 직전에 보낸 글");
  });

  it("같은 경우의 짝: 응답의 seq 가 하한 위면(나간 뒤에 보낸 글) 평소처럼 그려진다", async () => {
    await mount();
    let respond!: (message: Message) => void;
    send.sendMessage.mockImplementation(() => new Promise<Message>((resolve) => { respond = resolve; }));
    await act(async () => {
      void out.send!("나간 뒤에 보낸 글");
      await Promise.resolve();
    });
    await act(async () => {
      respond(row(FLOOR + 3, "0199ffff-0000-7000-8000-000000000013", "나간 뒤에 보낸 글"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(out.messages.map((m) => m.body)).toContain("나간 뒤에 보낸 글");
  });
});
