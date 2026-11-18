// @vitest-environment jsdom
// #5885 — 재연결한 기기가 끊긴 사이의 수정 · 지움 · 반응 · 고정을 한 번 다시 읽어 맞춘다(ADR-0177 증보 2026-11-14 D17 「보관하지 않아요」 · D22 한계 5).
//
// 개인 채널로 돌려진 프레임은 실시간 서버에 보관되지 않아서, 그 순간 끊겨 있던 기기는 복구 구독(`recovered: true`)으로도 받지 못한다. 진짜
// `useTimeline` 을 가짜 RealtimeHandle 위에서 돌리고, 가짜 서버의 상태를 「끊긴 사이에 바뀐 것」으로 바꾼 뒤 다시 구독을 알려 화면에 닿는 값을 잰다.
// 다시 읽기를 빼면(`reconnected()` 를 부르지 않으면) 복구된 갈래는 아무것도 다시 받지 않고, 안 된 갈래는 꼬리만 받아 넷 다 옛 값이다.

import { act, createElement, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message, MessageQuery, PinnedMessageWire } from "@momo/core/lib/api";
import type { PinMap } from "@momo/core/features/timeline/pins";
import type { ReactionMap } from "@momo/core/features/timeline/reactions";
import type { TimelineState } from "@momo/core/features/timeline/model";
import { RESYNC_SETTLE_MS } from "@momo/core/features/timeline/reconnectResync";
import { useTimeline } from "./useTimeline";
import type { RealtimeHandle } from "@/lib/realtime";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-000000000101";
const id = (n: number) => `0199ffff-0000-7000-8000-${String(n).padStart(12, "0")}`;

const server = vi.hoisted(() => ({
  rows: [] as unknown[],
  reactions: {} as Record<string, Record<string, string[]>>,
  pins: [] as unknown[],
  calls: { messages: [] as string[], reactions: 0, pins: 0 },
}));

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchMessages: vi.fn(async (_ws: string, _ch: string, query: MessageQuery = {}) => {
      server.calls.messages.push(JSON.stringify(query));
      let rows = (server.rows as Message[]).slice().sort((a, b) => b.seq - a.seq);
      if (query.after !== undefined) rows = rows.filter((m) => m.seq > query.after!).reverse();
      if (query.before !== undefined) rows = rows.filter((m) => m.seq < query.before!);
      return { messages: rows.slice(0, query.limit ?? 50), nextBefore: undefined };
    }),
    fetchReactionSnapshot: vi.fn(async () => {
      server.calls.reactions += 1;
      return structuredClone(server.reactions);
    }),
    fetchChannelPins: vi.fn(async () => {
      server.calls.pins += 1;
      return structuredClone(server.pins);
    }),
    fetchMessageUnfurls: vi.fn(async () => []),
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
} as unknown as RealtimeHandle;

const out: { state: TimelineState | null; reactions: ReactionMap; pins: PinMap } = { state: null, reactions: {}, pins: {} };

function Probe(): ReactElement {
  const t = useTimeline(realtime, WS, CH, ME);
  useEffect(() => {
    out.state = t.state;
    out.reactions = t.reactions;
    out.pins = t.pins;
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
  out.state = null;
  localStorage.clear();
});

function row(seq: number, body: string, extra: Partial<Message> = {}): Message {
  return {
    id: id(seq),
    channelId: CH,
    seq,
    hlcTs: 1_700_000_000_000 + seq * 1000,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: "text",
    body,
    state: "sent",
    createdAtMs: 1_700_000_000_000 + seq * 1000,
    ...extra,
  };
}
function pin(seq: number, body: string): PinnedMessageWire {
  return {
    messageId: id(seq),
    channelId: CH,
    seq,
    authorMemberId: OTHER,
    type: "text",
    state: "sent",
    body,
    createdAtMs: 1_700_000_000_000 + seq * 1000,
    pinnedBy: OTHER,
    pinnedAtMs: 1_700_000_050_000 + seq,
  };
}

/** 대화를 연 때의 서버: 글 넷, 2번 글에 👍, 3번 글이 고정. */
function seed(): void {
  server.rows = [row(1, "하나"), row(2, "둘"), row(3, "셋"), row(4, "넷")];
  server.reactions = { [id(2).toUpperCase()]: { "👍": [OTHER.toUpperCase()] } };
  server.pins = [pin(3, "셋")];
  server.calls = { messages: [], reactions: 0, pins: 0 };
}
/** 끊긴 사이(개인 채널로만 간 프레임, 보관되지 않음): 2번 고침 · 4번 지움 · 2번 👍 빠지고 1번에 ❤️ · 3번 고정 풀고 1번 고정. */
function changeWhileAway(): void {
  server.rows = [row(1, "하나"), row(2, "끊긴 사이에 고친 글", { editedAtMs: 1_700_000_090_000 }), row(3, "셋"), row(4, "", { state: "deleted", body: undefined, deletedAtMs: 1_700_000_091_000 })];
  server.reactions = { [id(1).toUpperCase()]: { "❤️": [OTHER.toUpperCase()] } };
  server.pins = [pin(1, "하나")];
}

async function mount(): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(Probe));
  });
  await settle(0);
}
async function settle(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
    await Promise.resolve();
    await Promise.resolve();
  });
}
async function subscribed(recovered: boolean): Promise<void> {
  await act(async () => {
    rail.handlers?.onSubscribed({ recovered });
    await Promise.resolve();
  });
}
const AFTER_SETTLE = RESYNC_SETTLE_MS + 150;
/** 「다시 읽기」로 센 읽기: 반응 스냅샷(대화를 여는 길도 한 번 읽는다). */
const rereads = () => server.calls.reactions - 1;

describe("useTimeline · 재연결 뒤 열린 대화 다시 읽기 (#5885, D17 · D22 한계 5)", () => {
  it.each([
    ["복구됨", true],
    ["복구 안 됨", false],
  ])("%s: 끊긴 사이의 고침 · 지움 · 반응 · 고정이 한 번의 다시 읽기로 맞는다", async (_label, recovered) => {
    seed();
    await mount();
    await subscribed(false); // 첫 구독
    await settle(AFTER_SETTLE);
    expect(rereads()).toBe(0); // 첫 구독에서는 다시 읽지 않는다
    changeWhileAway();
    await subscribed(recovered);
    await settle(AFTER_SETTLE);

    expect(rereads()).toBe(1);
    expect(server.calls.pins).toBe(2);
    const byId = new Map(out.state!.messages.map((m) => [m.id, m]));
    expect(byId.get(id(2))?.body).toBe("끊긴 사이에 고친 글");
    expect(byId.get(id(4))?.state).toBe("deleted");
    expect(out.reactions).toEqual({ [id(1)]: { "❤️": [OTHER] } });
    expect(Object.keys(out.pins)).toEqual([id(1)]);
  });

  it("짧게 겹친 재연결은 한 번 읽고, 다시 읽은 결과가 같으면 화면 값이 같은 객체로 남는다", async () => {
    seed();
    await mount();
    await subscribed(false);
    await settle(AFTER_SETTLE);
    const before = { state: out.state, reactions: out.reactions, pins: out.pins };
    await subscribed(true);
    await settle(40);
    await subscribed(false);
    await subscribed(true);
    await settle(AFTER_SETTLE);
    expect(rereads()).toBe(1);
    expect(out.state?.messages).toBe(before.state?.messages);
    expect(out.reactions).toBe(before.reactions);
    expect(out.pins).toBe(before.pins);
  });
});
