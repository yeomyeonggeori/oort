// @vitest-environment jsdom
// #5005: 입력칸의 ✕로 끈 채 보낸 메시지는 `suppressUnfurl: true`를 싣고 나가고, 실패한 뒤의 재시도도 같은
// 요청이다(서버는 이미 저장된 메시지의 재시도에서 이 필드를 다시 판단하지 않는다). 켜지 않은 전송은
// 이 필드가 생기기 전과 바이트 단위로 같다(키 자체가 없다).

import { act, createElement, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Message } from "@momo/core/lib/api";
import { useTimeline, type TimelineSendOptions } from "./useTimeline";
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

const out: {
  send: ((body: string, options?: TimelineSendOptions) => Promise<void>) | null;
  resend: ((id: string) => Promise<void>) | null;
  failedIds: string[];
} = { send: null, resend: null, failedIds: [] };

function Probe(): ReactElement {
  const t = useTimeline(realtime, WS, CH, ME);
  useEffect(() => {
    out.send = t.send;
    out.resend = t.resend;
    out.failedIds = t.pending.filter((row) => row.status === "failed").map((row) => row.clientMsgId);
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
  api.sendMessage
    .mockReset()
    .mockResolvedValue({ id: MSG, channelId: CH, seq: 1, authorMemberId: ME, body: "x" } as Message);
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

/** The options object `sendMessage` was given on call `index` (the fifth argument). */
function sentOptions(index: number): Record<string, unknown> {
  return (api.sendMessage.mock.calls[index]?.[4] ?? {}) as Record<string, unknown>;
}

describe("useTimeline.send without a link preview", () => {
  it("sends the flag when the composer turned the preview off, and no key when it did not", async () => {
    await act(async () => {
      await out.send!("https://news.example/story", { suppressUnfurl: true });
    });
    expect(sentOptions(0)).toMatchObject({ suppressUnfurl: true });

    await act(async () => {
      await out.send!("https://news.example/story");
    });
    await act(async () => {
      await out.send!("https://news.example/story", { suppressUnfurl: false });
    });
    // The server's send request is closed-world: an unset flag is no key at all.
    expect(sentOptions(1)).not.toHaveProperty("suppressUnfurl");
    expect(sentOptions(2)).not.toHaveProperty("suppressUnfurl");
  });

  it("replays the same request, flag included, when a failed send is retried", async () => {
    api.sendMessage.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await out.send!("https://news.example/story", { suppressUnfurl: true });
    });
    expect(out.failedIds).toHaveLength(1);
    const failedId = out.failedIds[0]!;

    await act(async () => {
      await out.resend!(failedId);
    });
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    // Same idempotency key, same body, and the preview is still off.
    expect(api.sendMessage.mock.calls[1]?.[2]).toBe(api.sendMessage.mock.calls[0]?.[2]);
    expect(sentOptions(1)).toMatchObject({ suppressUnfurl: true });
  });
});
