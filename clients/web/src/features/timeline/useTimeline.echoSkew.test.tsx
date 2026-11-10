// @vitest-environment jsdom
// #5624: 보낸 직후 내 글의 머리가 섰다 사라지며 대화가 28px 출렁이던 흔들림. 에코(보내자마자 서는 줄)는 기기 시계를, 확정본은 서버
// 시계를 쓰고, 같은 분 묶음 규칙(#5603)에서는 두 시각의 분이 다르면 묶음이 갈렸다. 이 시험은 실제 훅(`useTimeline`)으로 보내고, 매
// 렌더마다 화면이 그릴 묶음(머리/이어짐)을 적어서, **한 글의 머리/이어짐이 보내는 동안 한 번도 바뀌지 않는지**를 잰다.
//
// 세 장면(이슈 수용 기준): 확정본이 ±90초 어긋남 · 시계가 맞아도 왕복 사이에 분이 바뀜 · 연달아 두 번 보내기.

import { act, createElement, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Message } from "@momo/core/lib/api";
import { buildTimelineItems, type BuildItemsOptions } from "@momo/core/features/timeline/model";
import { resetServerClockForTests } from "@momo/core/features/timeline/serverClock";
import { useTimeline, type TimelineSendOptions } from "./useTimeline";
import type { RealtimeHandle } from "@/lib/realtime";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";

const api = vi.hoisted(() => ({ sendMessage: vi.fn(), fetchMessages: vi.fn() }));

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    ...api,
    fetchReactionSnapshot: vi.fn(async () => ({ reactions: [] })),
    fetchChannelPins: vi.fn(async () => ({ pins: [] })),
    fetchMessageUnfurls: vi.fn(async () => ({ unfurls: [] })),
  };
});

const realtime = {
  subscribeChannel: () => () => undefined,
  subscribeAgent: () => () => undefined,
  subscribeTyping: () => () => undefined,
  subscribeWorkSession: () => () => undefined,
  subscribeCascade: () => () => undefined,
  subscribeHuddle: () => () => undefined,
  reconnect: () => undefined,
  dispose: () => undefined,
} as unknown as RealtimeHandle;

/** 한 렌더가 그린 내 글들: 본문 → 머리인가. */
type Layout = Record<string, boolean>;

const out: {
  send: ((body: string, options?: TimelineSendOptions) => Promise<void>) | null;
  layouts: Layout[];
} = { send: null, layouts: [] };

function Probe(): ReactElement {
  const t = useTimeline(realtime, WS, CH, ME);
  // 화면(`Timeline.tsx`)이 묶음을 짓는 것과 같은 호출이다. 장부와 시계 차이는 훅이 내놓는 그대로 넘긴다(고치기 전 훅에는 없으므로
  // 느슨하게 읽는다 — 같은 파일이 고치기 전 코드에서 RED를 보이게).
  const loose = t as unknown as Partial<Pick<BuildItemsOptions, "echoPins" | "serverOffsetMs">>;
  const items = buildTimelineItems(t.state.messages, {
    pending: t.pending,
    echoPins: loose.echoPins,
    serverOffsetMs: loose.serverOffsetMs,
  });
  useEffect(() => {
    out.send = t.send;
    const layout: Layout = {};
    for (const item of items) {
      if (item.kind === "message") layout[item.message.body ?? ""] = item.startsGroup;
      if (item.kind === "pending") layout[item.pending.body] = item.startsGroup;
    }
    out.layouts.push(layout);
  });
  return createElement("div");
}

/** 손으로 푸는 보내기 응답 하나. */
function deferred(): { promise: Promise<Message>; resolve: (m: Message) => void } {
  let resolve!: (m: Message) => void;
  const promise = new Promise<Message>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let seq = 0;
function confirmed(body: string, serverAtMs: number): Message {
  seq += 1;
  return {
    id: `00000000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    channelId: CH,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: ME,
    type: "text",
    body,
    state: "sent",
    createdAtMs: serverAtMs,
  } as Message;
}

/** 한 글이 그려진 모든 렌더에서 머리/이어짐이 하나였는가. 바뀌었으면 그 차례를 돌려준다. */
function headHistory(body: string): boolean[] {
  const seen: boolean[] = [];
  for (const layout of out.layouts) {
    if (!(body in layout)) continue;
    const head = layout[body]!;
    if (seen.length === 0 || seen[seen.length - 1] !== head) seen.push(head);
  }
  return seen;
}

/** 기기 시계(로컬 시각). 서버 시계는 시험마다 이 값에서 어긋나게 찍는다. */
const at = (h: number, m: number, s: number, ms = 0) => new Date(2026, 10, 9, h, m, s, ms).getTime();

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (q: string) => ({
        matches: false,
        media: q,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
  }
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(10, 47, 5));
  resetServerClockForTests();
  api.sendMessage.mockReset();
  api.fetchMessages.mockReset().mockResolvedValue({ messages: [], nextBefore: undefined });
  out.layouts = [];
  seq = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(Probe));
  });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.useRealTimers();
});

/** 글 하나를 보내고, 응답은 돌려준 손잡이로 푼다(그 사이의 에코 렌더가 적힌다). */
async function sendHeld(body: string): Promise<{ answer: (serverAtMs: number) => Promise<void> }> {
  const reply = deferred();
  api.sendMessage.mockReturnValueOnce(reply.promise);
  let done: Promise<void> = Promise.resolve();
  await act(async () => {
    done = out.send!(body);
  });
  return {
    answer: async (serverAtMs: number) => {
      await act(async () => {
        reply.resolve(confirmed(body, serverAtMs));
        await done;
      });
    },
  };
}

describe("#5624 내 글의 머리/이어짐은 에코에서 확정본으로 바뀌어도 그대로다", () => {
  for (const skewSeconds of [90, -90]) {
    it(`서버 시계가 ${skewSeconds > 0 ? "+" : ""}${skewSeconds}초 어긋나도, 이어 보낸 글이 이어진 줄로 서고 그대로 남는다`, async () => {
      const skew = skewSeconds * 1000;
      // 첫 글: 보내기 응답이 서버 시계를 알려 준다.
      const first = await sendHeld("첫 글");
      await first.answer(Date.now() + skew);
      // 같은 분에 이어 보낸 둘째 글.
      vi.setSystemTime(at(10, 47, 15));
      const second = await sendHeld("이어 보낸 글");
      await second.answer(Date.now() + skew);

      expect(headHistory("이어 보낸 글")).toEqual([false]);
      expect(headHistory("첫 글")).toEqual([true]);
    });
  }

  it("시계가 맞아도 보내는 동안 분이 바뀌면(10:47:59.8 → 서버 10:48:00.1) 이어진 줄이 머리로 바뀌지 않는다", async () => {
    vi.setSystemTime(at(10, 47, 30));
    const first = await sendHeld("47분의 글");
    await first.answer(Date.now());
    vi.setSystemTime(at(10, 47, 59, 800));
    const second = await sendHeld("경계의 글");
    vi.setSystemTime(at(10, 48, 0, 100));
    await second.answer(Date.now());

    expect(headHistory("경계의 글")).toEqual([false]);
  });

  it("연달아 두 번 보내면(첫 응답이 둘째 에코보다 먼저 옴, 서버 +90초) 둘째 글의 이어진 줄이 한 번도 머리가 되지 않는다", async () => {
    const skew = 90_000;
    const a = await sendHeld("하나");
    vi.setSystemTime(at(10, 47, 6));
    const b = await sendHeld("둘");
    await a.answer(Date.now() + skew);
    vi.setSystemTime(at(10, 47, 7));
    await b.answer(Date.now() + skew);

    expect(headHistory("하나")).toEqual([true]);
    expect(headHistory("둘")).toEqual([false]);
  });

  it("세션의 첫 보내기(아직 잰 차이가 없음)는 에코 때 정한 머리를 확정본이 그대로 지킨다 — 응답이 알려 준 차이로 다시 묶지 않는다", async () => {
    const skew = 90_000;
    // 화면을 처음 열 때 이미 있는 내 글(서버 시각 10:48:15, 같은 분). 이 기기는 아직 서버 시계를 모른다.
    api.fetchMessages.mockResolvedValue({ messages: [confirmed("앞서 쓴 글", at(10, 48, 15))], nextBefore: undefined });
    await act(async () => {
      root?.unmount();
    });
    root = createRoot(host!);
    await act(async () => {
      root?.render(createElement(Probe));
    });
    expect(out.layouts.at(-1)).toEqual({ "앞서 쓴 글": true });
    vi.setSystemTime(at(10, 47, 0));
    const first = await sendHeld("첫 보내기");
    await first.answer(Date.now() + skew);

    // 에코는 기기 시계로 90초 떨어져 머리였다. 확정본도 머리다(응답이 알려 준 차이로 고쳐 묶으면 이어진 줄로 접히며 출렁인다).
    expect(headHistory("첫 보내기")).toEqual([true]);
  });
});
