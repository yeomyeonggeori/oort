// @vitest-environment jsdom
// #5221: 머리 읽기가 실패했을 때 그 실패가 말하는 원인을 훅이 알려 주고, 받아 둔 글이 있으면 다시 읽기가 그 글을 비우지 않는다.
// 판정은 코어(`causeOfFailure`)이고 여기서는 훅이 그 판정을 **그대로 따르는지**를 잰다.

import { act, createElement, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Message } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import type { ConnectionCause } from "@momo/core/features/connection/model";
import { useTimeline, type UseTimelineResult } from "./useTimeline";
import type { RealtimeHandle } from "@/lib/realtime";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
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

// 구독이 붙자마자 「복구되지 않음」으로 알려 REST 꼬리 읽기(after)가 돈다: 머리 읽기가 실패해도 글이 들어올 수 있는 길이다.
const realtime = {
  subscribeChannel: (_ws: string, _ch: string, handlers: { onSubscribed?: (ctx: unknown) => void }) => {
    handlers.onSubscribed?.({ recovered: false });
    return () => undefined;
  },
  subscribeAgent: () => () => undefined,
  subscribeTyping: () => () => undefined,
  subscribeWorkSession: () => () => undefined,
  subscribeCascade: () => () => undefined,
  subscribeHuddle: () => () => undefined,
  reconnect: () => undefined,
  dispose: () => undefined,
} as unknown as RealtimeHandle;

const out: { t: UseTimelineResult | null } = { t: null };

function Probe(): ReactElement {
  const t = useTimeline(realtime, WS, CH, ME);
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
      value: (q: string) => ({
        matches: false,
        media: q,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  out.t = null;
});
beforeEach(() => {
  api.fetchMessages.mockReset();
});

async function mount(): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(Probe));
  });
}

function incoming(seq: number, body: string): Message {
  return {
    id: `00000000-0000-7000-8000-00000000e${String(seq).padStart(3, "0")}`,
    channelId: CH,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: "text",
    body,
    state: "sent",
    createdAtMs: seq,
  };
}

/** 머리 읽기(after 없음)는 주어진 것으로, 꼬리 읽기(after)는 빈 목록으로 답한다. */
function headReturns(head: () => Promise<unknown>): void {
  api.fetchMessages.mockImplementation((_ws: string, _ch: string, opts: { after?: number }) =>
    opts.after === undefined ? head() : Promise.resolve({ messages: [], nextBefore: undefined })
  );
}

describe("useTimeline.loadCause: 머리 읽기 실패의 원인", () => {
  // 지키는 것: 원인이 실제 실패를 따라간다. 상태 코드가 아니라 닫힌 분류다.
  it("응답 없음은 기기 상태로 오프라인·서버에 닿지 못함, 서버가 직접 거절한 응답은 원인 없음", async () => {
    const cases: [unknown, boolean, ConnectionCause | null][] = [
      [new NetworkError("unreachable", 15_000), false, "deviceOffline"],
      [new NetworkError("timeout", 15_000), true, "serverUnreachable"],
      [new ApiError(502, "bad gateway"), true, "serverUnreachable"],
      [new ApiError(403, "forbidden"), true, null],
    ];
    for (const [failure, onLine, expected] of cases) {
      vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(onLine);
      headReturns(() => Promise.reject(failure));
      await mount();
      expect(out.t?.status).toBe("error");
      expect(out.t?.loadCause).toBe(expected);
      await act(async () => root?.unmount());
      host?.remove();
      vi.restoreAllMocks();
    }
  });

  // 지키는 것: 읽기에 성공하면 원인은 비워진다(다음 실패가 이전 원인을 물려받지 않는다).
  it("다시 읽기에 성공하면 원인이 비워지고 준비 상태가 된다", async () => {
    headReturns(() => Promise.reject(new NetworkError("unreachable", 15_000)));
    await mount();
    expect(out.t?.loadCause).toBe("serverUnreachable");
    headReturns(() => Promise.resolve({ messages: [incoming(1, "다시 읽은 글")], nextBefore: undefined }));
    await act(async () => out.t?.reload());
    expect(out.t?.status).toBe("ready");
    expect(out.t?.loadCause).toBeNull();
    expect(out.t?.state.messages.map((m) => m.body)).toEqual(["다시 읽은 글"]);
  });

  // 지키는 것: 받아 둔 글이 있으면 「다시 시도」가 그 글을 비우지 않는다(비우면 목록이 깜빡 사라졌다 돌아온다).
  it("받아 둔 글이 있는 채로 다시 읽기를 누르면 그 글이 읽는 동안에도 남는다", async () => {
    // 꼬리 읽기는 글을 주고 머리 읽기는 실패한다: 글이 있는 채로 error 다.
    api.fetchMessages.mockImplementation((_ws: string, _ch: string, opts: { after?: number }) =>
      opts.after === undefined
        ? Promise.reject(new NetworkError("unreachable", 15_000))
        : Promise.resolve({ messages: [incoming(1, "받아 둔 글")], nextBefore: undefined })
    );
    await mount();
    expect(out.t?.status).toBe("error");
    expect(out.t?.state.messages.map((m) => m.body)).toEqual(["받아 둔 글"]);

    // 다시 읽는 동안 꼬리 읽기는 빈손이다: 글이 남아 있다면 비워지지 않았기 때문이지 꼬리가 되돌려 줘서가 아니다.
    let finish: (page: unknown) => void = () => undefined;
    api.fetchMessages.mockImplementation((_ws: string, _ch: string, opts: { after?: number }) =>
      opts.after === undefined
        ? new Promise((resolve) => (finish = resolve))
        : Promise.resolve({ messages: [], nextBefore: undefined })
    );
    await act(async () => out.t?.reload());
    // 읽는 동안에도 글은 그대로다.
    expect(out.t?.state.messages.map((m) => m.body)).toEqual(["받아 둔 글"]);
    await act(async () => finish({ messages: [incoming(1, "받아 둔 글"), incoming(2, "새 글")], nextBefore: undefined }));
    expect(out.t?.status).toBe("ready");
    expect(out.t?.state.messages.map((m) => m.body)).toEqual(["받아 둔 글", "새 글"]);
  });

  // 지키는 것: 받아 둔 글이 없을 때는 지금까지처럼 비우고 다시 읽는다(다른 채널의 글을 끌고 오지 않는다).
  it("받아 둔 글이 없으면 다시 읽기는 비우고 처음부터 읽는다", async () => {
    headReturns(() => Promise.reject(new NetworkError("unreachable", 15_000)));
    await mount();
    expect(out.t?.state.messages).toEqual([]);
    let finish: (page: unknown) => void = () => undefined;
    headReturns(() => new Promise((resolve) => (finish = resolve)));
    await act(async () => out.t?.reload());
    expect(out.t?.status).toBe("loading");
    await act(async () => finish({ messages: [], nextBefore: undefined }));
    expect(out.t?.status).toBe("ready");
  });
});
