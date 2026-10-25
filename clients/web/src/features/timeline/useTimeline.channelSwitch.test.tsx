// @vitest-environment jsdom
// #4438 — 채널을 옮긴 직후 늦게 돌아온 꼬리 읽기(`?after=`)는 새 채널에 섞이지 않는다.
//
// 재연결(복구 없이 다시 붙은 구독) 뒤의 꼬리 읽기는 한 번에 끝나지 않고 페이지를 이어 읽는다. 그 답이 오는 동안 사람이 다른 채널로
// 옮기면 훅은 옛 구독을 놓지만(효과 정리), 이미 떠난 요청의 답은 그래도 돌아온다. 같은 훅 인스턴스가 채널을 바꿔 가며 쓰이므로
// (`c/:channelId` 라우트는 `ChatShell` 을 다시 만들지 않는다) 그 답이 새 채널의 병합 문(`applyBatch`)에 닿으면
//   (a) 옛 채널의 줄이 새 채널 목록에 서고,
//   (b) 새 채널의 「가장 새 seq」 기준이 옛 채널의 값으로 올라가, 새 채널의 다음 꼬리 읽기가 그 아래 행을 영영 건너뛴다.
// 폰은 같은 자리에 `stillCurrent` 가드가 있다(`pushTap.test.tsx` O-2). 웹엔 없었다.
//
// 서버는 채널마다 행 목록을 쥔 작은 모형이다. 꼬리 읽기(`after`)의 답은 요청 시각의 행으로 정해지고, 붙들어 둔 채널은 시험이 풀 때까지
// 돌아오지 않는다 — 「느린 응답」이다.

import { createElement, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@momo/core/lib/api";
import { useTimeline } from "./useTimeline";
import type { RealtimeHandle } from "@/lib/realtime";

const WS = "00000000-0000-7000-8000-000000000001";
/** 읽는 도중 떠나는 채널(A)과 옮겨 가는 채널(B). */
const CH_A = "00000000-0000-7000-8000-0000000000a1";
const CH_B = "00000000-0000-7000-8000-0000000000b2";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-000000000101";

const PAGE_LIMIT = 50;

const net = vi.hoisted(() => ({
  /** 채널별로 서버가 쥔 행(커밋된 순서와 무관, 읽을 때 seq 로 가른다). */
  rows: new Map<string, { seq: number }[]>(),
  /** 꼬리 읽기의 답을 붙들어 둘 채널. */
  hold: new Set<string>(),
  /** 붙들린 꼬리 읽기들, 나간 순서대로. `release()` 가 답을 돌려보낸다. */
  held: [] as { channel: string; after: number; release: () => void }[],
  /** 나간 모든 꼬리 읽기(붙들렸든 아니든). */
  tailReads: [] as { channel: string; after: number }[],
}));

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchMessages: vi.fn(
      async (
        _workspaceId: string,
        channel: string,
        opts?: { after?: number; before?: number; limit?: number }
      ) => {
        const all = [...(net.rows.get(channel) ?? [])].sort(
          (a, b) => a.seq - b.seq
        );
        if (opts?.after != null) {
          const after = opts.after;
          net.tailReads.push({ channel, after });
          const answer = {
            messages: all
              .filter((m) => m.seq > after)
              .slice(0, opts.limit ?? PAGE_LIMIT),
            nextBefore: undefined,
          };
          if (!net.hold.has(channel)) return answer;
          return new Promise((resolve) => {
            net.held.push({ channel, after, release: () => resolve(answer) });
          });
        }
        // 머리: 그 시각에 서버에 있는 가장 새 한 페이지.
        return { messages: all.slice(-PAGE_LIMIT), nextBefore: undefined };
      }
    ),
    fetchReactionSnapshot: vi.fn(async () => ({ reactions: [] })),
    fetchChannelPins: vi.fn(async () => ({ pins: [] })),
    fetchMessageUnfurls: vi.fn(async () => ({ unfurls: [] })),
  };
});

type Handlers = Parameters<RealtimeHandle["subscribeChannel"]>[2];
/** 채널마다 지금 붙어 있는 구독의 핸들러. 구독을 놓으면 지워진다. */
const rail: { handlers: Map<string, Handlers> } = { handlers: new Map() };

const realtime = {
  subscribeChannel: (_ws: string, channel: string, handlers: Handlers) => {
    rail.handlers.set(channel, handlers);
    return () => {
      if (rail.handlers.get(channel) === handlers) rail.handlers.delete(channel);
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

const out: { messages: Message[] } = { messages: [] };

function Probe({ channelId }: { channelId: string }): ReactElement {
  const t = useTimeline(realtime, WS, channelId, ME);
  useEffect(() => {
    out.messages = t.state.messages;
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

beforeEach(() => {
  net.rows.clear();
  net.hold.clear();
  net.held.length = 0;
  net.tailReads.length = 0;
  rail.handlers.clear();
  out.messages = [];
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function row(channelId: string, seq: number): Message {
  return {
    id: `0199${channelId === CH_A ? "aaaa" : "bbbb"}-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    channelId,
    seq,
    hlcTs: 1_000 + seq,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: "text",
    body: `본문 ${seq}`,
    state: "sent",
    createdAtMs: 1_000 + seq,
  };
}

/** 한 채널의 seq `from`..`to` 행. */
function span(channelId: string, from: number, to: number): Message[] {
  return Array.from({ length: to - from + 1 }, (_, i) => row(channelId, from + i));
}

/** 서버에 행이 커밋됐다. 이후에 나가는 읽기부터 그 행을 본다. */
function commit(channelId: string, rows: Message[]): void {
  net.rows.set(channelId, [...(net.rows.get(channelId) ?? []), ...rows]);
}

/** 화면 목록을 `A100`·`B5` 꼴(채널 글자 + seq)로. 어느 채널의 줄이 섰는지 한눈에 읽힌다. */
function shown(): string[] {
  return out.messages.map((m) => `${m.channelId === CH_A ? "A" : "B"}${m.seq}`);
}

const labels = (channel: "A" | "B", from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `${channel}${from + i}`);

/** 마이크로태스크와 한 바퀴의 매크로태스크까지 흘려보낸다(읽기 한 번의 사슬이 끝난다). */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

/** 훅이 보여 줄 채널을 바꾼다. 처음 부르면 마운트한다. 같은 훅 인스턴스가 채널만 바꾼다(실제 앱과 같다). */
async function show(channelId: string): Promise<void> {
  if (host === null) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => {
    root?.render(createElement(Probe, { channelId }));
  });
  await settle();
}

/** 그 채널의 레일이 (복구 없이) 다시 붙었다 — 훅은 꼬리를 읽으러 간다. */
async function railResubscribed(channelId: string): Promise<void> {
  await act(async () => {
    rail.handlers.get(channelId)?.onSubscribed({ recovered: false });
  });
  await settle();
}

/** 붙들어 둔 읽기 하나의 답이 돌아온다. */
async function answer(index: number): Promise<void> {
  await act(async () => {
    net.held[index]?.release();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

describe("useTimeline · 채널을 옮긴 직후 늦게 돌아온 꼬리 읽기 (#4438)", () => {
  it("대조군: 옮기지 않으면 느린 꼬리 읽기도 제자리(그 채널)에 든다", async () => {
    commit(CH_A, span(CH_A, 98, 99));
    await show(CH_A);
    expect(shown()).toEqual(["A98", "A99"]);

    commit(CH_A, span(CH_A, 100, 101));
    net.hold.add(CH_A);
    await railResubscribed(CH_A);
    expect(net.held.map((h) => h.after)).toEqual([99]); // 꼬리 읽기가 떠났다 — 답은 아직이다
    expect(shown()).toEqual(["A98", "A99"]);

    await answer(0);
    expect(shown()).toEqual(["A98", "A99", "A100", "A101"]);
  });

  it("읽는 동안 채널을 옮기면, 늦게 온 옛 채널의 줄은 새 채널 목록에 서지 않는다", async () => {
    commit(CH_A, span(CH_A, 98, 99));
    commit(CH_B, span(CH_B, 1, 5));
    await show(CH_A);

    commit(CH_A, span(CH_A, 100, 101));
    net.hold.add(CH_A);
    await railResubscribed(CH_A);
    expect(net.held.map((h) => h.channel)).toEqual([CH_A]);

    await show(CH_B); // 사람이 다른 채널로 갔다 — 그 채널의 머리가 선다
    expect(shown()).toEqual(labels("B", 1, 5));

    await answer(0); // 옛 채널의 답이 이제 돌아온다
    expect(shown()).toEqual(labels("B", 1, 5));
  });

  it("seq 가 겹쳐도 — 늦게 온 옛 채널의 줄이 같은 seq 의 새 채널 줄을 갈아 끼우지 않는다", async () => {
    // seq 는 채널마다 1 부터 센다. 병합은 seq 로만 맞추고 같은 seq 는 나중 것이 이긴다 — 길이는 그대로인데 내용이 다른 채널의 것으로 바뀐다.
    commit(CH_A, span(CH_A, 1, 3));
    commit(CH_B, span(CH_B, 1, 5));
    await show(CH_A);

    commit(CH_A, span(CH_A, 4, 5));
    net.hold.add(CH_A);
    await railResubscribed(CH_A);
    await show(CH_B);
    expect(shown()).toEqual(labels("B", 1, 5));

    await answer(0);
    expect(shown()).toEqual(labels("B", 1, 5));
  });

  it("그 늦은 답은 새 채널의 따라잡기 기준도 올려 놓지 않는다 — 새 채널의 새 메시지를 여전히 가져온다", async () => {
    commit(CH_A, span(CH_A, 98, 99));
    commit(CH_B, span(CH_B, 1, 5));
    await show(CH_A);

    commit(CH_A, span(CH_A, 100, 101));
    net.hold.add(CH_A);
    await railResubscribed(CH_A);
    await show(CH_B);
    await answer(0); // 옛 채널의 seq 101 이 돌아온다

    // 새 채널에 그 사이 새 메시지(seq 6)가 하나 커밋됐고, 그 채널의 레일이 붙는다.
    commit(CH_B, [row(CH_B, 6)]);
    await railResubscribed(CH_B);

    // 새 채널의 읽기는 새 채널의 가장 새 줄(5) 뒤에서 시작한다 — 옛 채널의 101 이 아니다.
    expect(
      net.tailReads.filter((r) => r.channel === CH_B).map((r) => r.after)
    ).toEqual([5]);
    // 그래서 새 메시지가 도착한다. (옛 채널 줄이 섞였는지는 위 시험이 지킨다 — 여기는 새 채널 줄만 본다.)
    expect(shown().filter((label) => label.startsWith("B"))).toEqual(
      labels("B", 1, 6)
    );
  });

  it("페이지를 이어 읽는 도중에 옮기면 — 다음 페이지도 섞이지 않고, 옛 채널을 더 읽지도 않는다", async () => {
    commit(CH_A, span(CH_A, 98, 99));
    commit(CH_B, span(CH_B, 1, 5));
    await show(CH_A);

    // 꼬리가 두 페이지(100..149, 150..199)보다 길다 — 가득 찬 페이지는 다음 페이지를 부른다.
    commit(CH_A, span(CH_A, 100, 199));
    net.hold.add(CH_A);
    await railResubscribed(CH_A);
    expect(net.held.map((h) => h.after)).toEqual([99]);

    await answer(0); // 첫 페이지는 아직 이 채널에 있는 동안 돌아와 든다 → 두 번째 페이지를 읽으러 간다
    expect(net.held.map((h) => h.after)).toEqual([99, 149]);
    expect(shown()).toContain("A149");

    await show(CH_B); // 두 번째 페이지가 오기 전에 옮긴다
    expect(shown()).toEqual(labels("B", 1, 5));

    await answer(1); // 가득 찬(50줄) 두 번째 페이지가 옮긴 뒤에 돌아온다
    expect(shown()).toEqual(labels("B", 1, 5));
    // 옛 채널의 세 번째 페이지는 부르지 않는다.
    expect(
      net.tailReads.filter((r) => r.channel === CH_A).map((r) => r.after)
    ).toEqual([99, 149]);
  });
});
