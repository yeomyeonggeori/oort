// @vitest-environment jsdom
// #5662: 옛 쪽 읽기가 실패해도 그 대화에서 다시 읽을 수 있다. 실패는 `olderFailed` 로 알리고(거부로 사라지지 않음), 같은 틱의 두
// 부름은 읽기 하나, 이어진 실패 뒤의 맨 위 닿음은 간격을 두고, 「다시 시도」는 간격을 넘는다. 대화를 바꾸면 실패 표시가 내려간다.

import { act, createElement, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { olderRetryGapMs, useTimeline, type UseTimelineResult } from "./useTimeline";
import type { RealtimeHandle } from "@/lib/realtime";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const CH2 = "00000000-0000-7000-8000-000000000003";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-0000000001aa";

const api = vi.hoisted(() => ({ fetchMessages: vi.fn() }));

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchMessages: api.fetchMessages,
    fetchReactionSnapshot: vi.fn(async () => ({ reactions: [] })),
    fetchChannelPins: vi.fn(async () => ({ pins: [] })),
    fetchMessageUnfurls: vi.fn(async () => ({ unfurls: [] })),
  };
});

const out: { t: UseTimelineResult | null } = { t: null };

function Probe({ channel }: { channel: string }): ReactElement {
  const t = useTimeline(null as unknown as RealtimeHandle, WS, channel, ME);
  useEffect(() => {
    out.t = t;
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
afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  out.t = null;
});
beforeEach(() => {
  api.fetchMessages.mockReset();
});

function row(channel: string, seq: number): Message {
  return {
    id: `00000000-0000-7000-8000-0000${channel.slice(-2)}00${String(seq).padStart(4, "0")}`,
    channelId: channel,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: "text",
    body: `줄 ${seq}`,
    state: "sent",
    createdAtMs: seq,
  };
}

const rows = (channel: string, from: number, to: number) => {
  const list: Message[] = [];
  for (let seq = to; seq >= from; seq -= 1) list.push(row(channel, seq));
  return list;
};

/** 머리 읽기는 91~100(더 옛 글 있음). 옛 쪽 읽기(`before`)는 `older` 가 정한다. */
function serve(older: (before: number) => Promise<unknown>): void {
  api.fetchMessages.mockImplementation((_ws: string, channel: string, opts: { before?: number; after?: number }) => {
    if (opts.after !== undefined) return Promise.resolve({ messages: [] });
    if (opts.before === undefined) return Promise.resolve({ messages: rows(channel, 91, 100), nextBefore: 91 });
    return older(opts.before);
  });
}

const olderCalls = () =>
  api.fetchMessages.mock.calls.filter((call) => (call[2] as { before?: number } | undefined)?.before !== undefined).length;

async function mount(channel = CH): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(Probe, { channel }));
  });
  await act(async () => undefined);
  expect(out.t?.status).toBe("ready");
}

const t = () => {
  if (!out.t) throw new Error("hook not mounted");
  return out.t;
};

describe("olderRetryGapMs: 이어진 실패 뒤 다시 읽기 간격", () => {
  it("1초에서 두 배씩, 30초에서 멈춘다", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(olderRetryGapMs)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });
});

describe("useTimeline.loadOlder: 실패 뒤에도 다시 읽는다 (#5662)", () => {
  // 지키는 것: 실패가 거부로 사라지지 않고 `olderFailed` 로 서며, 간격 뒤 다시 닿으면 읽고, 성공하면 내려간다. 망 오류 · 시간 초과 둘 다.
  it.each([
    ["망 오류", () => new TypeError("Failed to fetch")],
    ["시간 초과", () => new NetworkError("unreachable", 15_000)],
  ])("%s 뒤 다시 닿으면 다시 읽고, 성공하면 실패 표시가 내려간다", async (_name, failure) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    let fail = true;
    serve(async (before) => {
      if (fail) throw failure();
      return { messages: rows(CH, before - 10, before - 1), nextBefore: before - 10 };
    });
    await mount();
    await act(async () => {
      await expect(t().loadOlder()).resolves.toBeUndefined();
    });
    expect(olderCalls()).toBe(1);
    expect(t().olderFailed).toBe(true);
    expect(t().loadingOlder).toBe(false);
    expect(t().reachedStart).toBe(false);

    fail = false;
    vi.setSystemTime(1_000_000 + olderRetryGapMs(1));
    await act(async () => {
      await t().loadOlder();
    });
    expect(olderCalls()).toBe(2);
    expect(t().olderFailed).toBe(false);
    expect(t().state.oldestSeq).toBe(81);
  });

  // 지키는 것: 같은 틱의 두 부름(맨 위 닿음 두 길 · 다시 시도)은 읽기 하나다.
  it("같은 틱의 두 부름은 읽기 하나", async () => {
    let release: (() => void) | null = null;
    serve(
      (before) =>
        new Promise((resolve) => {
          release = () => resolve({ messages: rows(CH, before - 10, before - 1), nextBefore: before - 10 });
        })
    );
    await mount();
    await act(async () => {
      void t().loadOlder();
      void t().loadOlder();
      t().retryOlder();
    });
    expect(olderCalls()).toBe(1);
    await act(async () => {
      release?.();
    });
    expect(t().state.oldestSeq).toBe(81);
    expect(olderCalls()).toBe(1);
  });

  // 지키는 것: 이어진 실패 뒤 간격 안의 맨 위 닿음은 읽지 않고(쏟아내지 않음), 간격은 실패마다 늘고, 「다시 시도」는 간격을 넘는다.
  it("이어진 실패에는 간격, 「다시 시도」는 바로", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(5_000_000);
    serve(async () => {
      throw new TypeError("Failed to fetch");
    });
    await mount();
    await act(async () => {
      await t().loadOlder();
    });
    expect(olderCalls()).toBe(1);
    // 첫 실패 뒤 1초 안: 닿아도 읽지 않는다.
    vi.setSystemTime(5_000_000 + olderRetryGapMs(1) - 1);
    await act(async () => {
      await t().loadOlder();
    });
    expect(olderCalls()).toBe(1);
    // 1초가 지나면 읽는다(그리고 또 실패 — 이제 2초).
    vi.setSystemTime(5_000_000 + olderRetryGapMs(1));
    await act(async () => {
      await t().loadOlder();
    });
    expect(olderCalls()).toBe(2);
    const second = 5_000_000 + olderRetryGapMs(1);
    vi.setSystemTime(second + olderRetryGapMs(2) - 1);
    await act(async () => {
      await t().loadOlder();
    });
    expect(olderCalls()).toBe(2);
    // 「다시 시도」는 간격 안에서도 바로 읽는다.
    await act(async () => {
      t().retryOlder();
    });
    await act(async () => undefined);
    expect(olderCalls()).toBe(3);
    expect(t().olderFailed).toBe(true);
  });

  // 지키는 것: 실패 표시는 그 대화의 것이다 — 대화를 바꾸면 내려가고, 새 대화의 첫 닿음은 간격 없이 읽는다.
  it("대화를 바꾸면 실패 표시가 내려가고 간격도 새로 센다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(9_000_000);
    serve(async () => {
      throw new TypeError("Failed to fetch");
    });
    await mount(CH);
    await act(async () => {
      await t().loadOlder();
    });
    expect(t().olderFailed).toBe(true);
    await act(async () => {
      root?.render(createElement(Probe, { channel: CH2 }));
    });
    await act(async () => undefined);
    expect(t().status).toBe("ready");
    expect(t().olderFailed).toBe(false);
    await act(async () => {
      await t().loadOlder();
    });
    expect(olderCalls()).toBe(2);
  });
});
