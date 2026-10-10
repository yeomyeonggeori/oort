// @vitest-environment jsdom
// #3676: 실시간 레일이 아직 없거나 끝내 안 올 때도 타임라인은 스켈레톤에 머물지 않는다.
// 기록(REST 머리)은 레일과 무관하게 읽을 수 있고, 읽기에 실패하면 오류 상태로 끝나야 한다.

import { act, createElement, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@momo/core/lib/api";
import { useTimeline, type UseTimelineResult } from "./useTimeline";
import type { RealtimeHandle } from "@/lib/realtime";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";
const GONE = "00000000-0000-7000-8000-0000000009ff";

const rest = vi.hoisted(() => ({ fail: false, messages: [] as unknown[] }));

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchMessages: vi.fn(async () => {
      if (rest.fail) throw new Error("boom");
      return { messages: rest.messages, nextBefore: undefined };
    }),
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

const seen: { statuses: UseTimelineResult["status"][]; count: number[] } = {
  statuses: [],
  count: [],
};

function Probe({ rt }: { rt: RealtimeHandle | null }): ReactElement {
  const t = useTimeline(rt, WS, CH, ME);
  useEffect(() => {
    seen.statuses.push(t.status);
    seen.count.push(t.state.messages.length);
  });
  return createElement("div");
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function message(seq: number, author: string): Message {
  return {
    id: `00000000-0000-7000-8000-00000000a0${seq}`,
    channelId: CH,
    seq,
    hlcTs: 1_000 + seq,
    hlcCount: 0,
    authorMemberId: author,
    type: "text",
    body: `본문 ${seq}`,
    createdAtMs: 1_000 + seq,
  } as Message;
}

async function mount(rt: RealtimeHandle | null) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(Probe, { rt }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

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

beforeEach(() => {
  rest.fail = false;
  rest.messages = [message(1, ME), message(2, GONE)];
  seen.statuses = [];
  seen.count = [];
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("useTimeline · 실시간 레일 없이", () => {
  it("레일이 없어도 기록을 읽어 ready 로 끝난다(스켈레톤에 머물지 않는다)", async () => {
    await mount(null);
    expect(seen.statuses[seen.statuses.length - 1]).toBe("ready");
    expect(seen.count[seen.count.length - 1]).toBe(2);
  });

  it("레일이 없고 읽기가 실패하면 오류 상태로 끝난다", async () => {
    rest.fail = true;
    await mount(null);
    expect(seen.statuses[seen.statuses.length - 1]).toBe("error");
  });

  it("레일이 나중에 와도 이미 보이는 기록을 스켈레톤으로 되돌리지 않는다", async () => {
    await mount(null);
    const before = seen.statuses.length;
    await act(async () => {
      root?.render(createElement(Probe, { rt: realtime }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const after = seen.statuses.slice(before);
    expect(after).not.toContain("loading");
    expect(seen.count[seen.count.length - 1]).toBe(2);
  });
});
