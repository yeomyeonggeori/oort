// @vitest-environment jsdom
// #5210: 보내지 못한 메시지 지우기. 판정은 코어 `discardPending` 이고(코어 시험이 갈래마다 잠근다) 여기서는 훅이
// 그 판정을 **그대로 따르는지**를 잰다: 지우면 서버 호출이 없고, 보내는 중에는 못 지우고, 지운 뒤의 다시 보내기는
// 아무 요청도 내지 않고, 다시 보내는 중에 지우기가 막힌 채 응답이 오면 같은 키로 한 메시지가 된다.

import { act, createElement, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@momo/core/lib/api";
import type { PendingMessage } from "@momo/core/features/timeline/model";
import { useTimeline } from "./useTimeline";
import type { RealtimeHandle } from "@/lib/realtime";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";
const MSG = "00000000-0000-7000-8000-00000000e002";

const api = vi.hoisted(() => ({ sendMessage: vi.fn() }));

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    ...api,
    fetchMessages: vi.fn(async () => ({ messages: [], nextBefore: undefined })),
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

type Out = {
  send: ((body: string) => Promise<void>) | null;
  resend: ((id: string) => Promise<void>) | null;
  discard: ((id: string) => PendingMessage | null) | null;
  pending: PendingMessage[];
  messages: Message[];
};
const out: Out = { send: null, resend: null, discard: null, pending: [], messages: [] };

function Probe(): ReactElement {
  const t = useTimeline(realtime, WS, CH, ME);
  useEffect(() => {
    out.send = t.send;
    out.resend = t.resend;
    out.discard = t.discard;
    out.pending = t.pending;
    out.messages = t.state.messages;
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
beforeEach(async () => {
  api.sendMessage.mockReset();
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
});

function confirmedMessage(body: string): Message {
  return {
    id: MSG,
    channelId: CH,
    seq: 1,
    hlcTs: 1,
    hlcCount: 0,
    authorMemberId: ME,
    type: "text",
    body,
    state: "sent",
    createdAtMs: 1,
  };
}

/** 응답을 우리가 정하는 sendMessage 호출 하나. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("useTimeline.discard: 보내지 못한 메시지를 이 기기에서만 지운다", () => {
  it("실패한 행을 지우면 줄이 사라지고 서버 호출은 늘지 않는다. 지운 뒤 다시 보내기는 요청을 내지 않는다", async () => {
    api.sendMessage.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await out.send!("금요일 공지");
    });
    expect(out.pending).toHaveLength(1);
    expect(out.pending[0]?.status).toBe("failed");
    const id = out.pending[0]!.clientMsgId;
    expect(api.sendMessage).toHaveBeenCalledTimes(1);

    let removed: PendingMessage | null = null;
    act(() => {
      removed = out.discard!(id);
    });
    expect(removed).toMatchObject({ clientMsgId: id, body: "금요일 공지", status: "failed" });
    expect(out.pending).toEqual([]);
    // 지우기에는 서버로 가는 길이 없다.
    expect(api.sendMessage).toHaveBeenCalledTimes(1);

    await act(async () => {
      await out.resend!(id);
    });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(out.pending).toEqual([]);

    // 같은 키로 한 번 더 지우려 해도 아무 일도 없다.
    let again: PendingMessage | null = removed;
    act(() => {
      again = out.discard!(id);
    });
    expect(again).toBeNull();
  });

  it("보내는 중인 행은 지우지 않는다. 응답이 오면 확정 메시지 하나로 모인다", async () => {
    const first = deferred<Message>();
    api.sendMessage.mockReturnValueOnce(first.promise);
    await act(async () => {
      void out.send!("보내는 중");
    });
    expect(out.pending).toHaveLength(1);
    expect(out.pending[0]?.status).toBe("sending");
    const id = out.pending[0]!.clientMsgId;

    let removed: PendingMessage | null = out.pending[0]!;
    act(() => {
      removed = out.discard!(id);
    });
    expect(removed).toBeNull();
    expect(out.pending).toHaveLength(1);
    expect(out.pending[0]?.status).toBe("sending");

    await act(async () => {
      first.resolve(confirmedMessage("보내는 중"));
    });
    expect(out.pending).toEqual([]);
    expect(out.messages.map((m) => m.body)).toEqual(["보내는 중"]);
  });

  it("다시 보내는 중에는 지우기가 막히고, 응답이 오면 같은 키로 나간 요청 하나가 메시지 하나가 된다", async () => {
    api.sendMessage.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await out.send!("두 번째에 닿는 글");
    });
    const id = out.pending[0]!.clientMsgId;
    expect(out.pending[0]?.status).toBe("failed");

    const second = deferred<Message>();
    api.sendMessage.mockReturnValueOnce(second.promise);
    await act(async () => {
      void out.resend!(id);
    });
    expect(out.pending[0]?.status).toBe("sending");

    let removed: PendingMessage | null = out.pending[0]!;
    act(() => {
      removed = out.discard!(id);
    });
    expect(removed).toBeNull();
    expect(out.pending).toHaveLength(1);

    await act(async () => {
      second.resolve(confirmedMessage("두 번째에 닿는 글"));
    });
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    // 멱등키(세 번째 인자)가 두 시도에서 같다: 서버가 이미 받은 요청이었어도 중복 메시지가 생기지 않는다.
    expect(api.sendMessage.mock.calls[1]?.[2]).toBe(api.sendMessage.mock.calls[0]?.[2]);
    expect(api.sendMessage.mock.calls[0]?.[2]).toBe(id);
    expect(out.pending).toEqual([]);
    expect(out.messages).toHaveLength(1);
  });

  it("두 실패 행 중 하나를 지워도 다른 행은 그대로이고 그 행의 다시 보내기는 여전히 된다", async () => {
    api.sendMessage.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await out.send!("네");
    });
    api.sendMessage.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await out.send!("네");
    });
    expect(out.pending.map((p) => p.status)).toEqual(["failed", "failed"]);
    const [keep, drop] = out.pending.map((p) => p.clientMsgId) as [string, string];

    act(() => {
      out.discard!(drop);
    });
    expect(out.pending.map((p) => p.clientMsgId)).toEqual([keep]);

    api.sendMessage.mockResolvedValueOnce(confirmedMessage("네"));
    await act(async () => {
      await out.resend!(keep);
    });
    expect(api.sendMessage.mock.calls[2]?.[2]).toBe(keep);
    expect(out.pending).toEqual([]);
    expect(out.messages).toHaveLength(1);
  });
});
