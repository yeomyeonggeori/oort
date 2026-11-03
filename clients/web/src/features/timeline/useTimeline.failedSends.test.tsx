// @vitest-environment jsdom
// #5221: 보내지 못한 글. (1) 결정 ⑤ 자동 재전송: 네트워크로 못 보낸 글(NetworkError)만, 같은 멱등 키로, 한 글 3회·5분 안에서,
// 서버가 거절한 글은 손으로. (2) 실패한 글을 채널 이동·새로고침으로 잃지 않는다: 이 기기에 남겼다가 채널을 다시 열면
// 같은 키의 실패 행으로 돌려놓는다. 판정은 코어(`pickAutoResends`·`recordSendFailure`)이고 여기서는 훅이 그 판정을
// **그대로 따르는지**를 잰다.

import { act, createElement, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Message } from "@momo/core/lib/api";
import { NetworkError, type RestOutcome } from "@momo/core/lib/http";
import type { PendingMessage } from "@momo/core/features/timeline/model";
import type { SendFailureKind } from "@momo/core/features/connection/sendFailure";
import { AUTO_RESEND_MAX_ATTEMPTS, AUTO_RESEND_WINDOW_MS } from "@momo/core/features/connection/thresholds";
import { clearAllDrafts, readFailedSends } from "@/features/chat/draftStore";
import { useTimeline } from "./useTimeline";
import type { RealtimeHandle } from "@/lib/realtime";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const CH_B = "00000000-0000-7000-8000-000000000003";
const ME = "00000000-0000-7000-8000-0000000001ff";
const MSG = "00000000-0000-7000-8000-00000000e002";

const api = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  fetchMessages: vi.fn(),
  observers: new Set<(outcome: unknown) => void>(),
}));

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    sendMessage: api.sendMessage,
    fetchMessages: api.fetchMessages,
    fetchReactionSnapshot: vi.fn(async () => ({ reactions: [] })),
    fetchChannelPins: vi.fn(async () => ({ pins: [] })),
    fetchMessageUnfurls: vi.fn(async () => ({ unfurls: [] })),
  };
});

// 서버에 닿았다는 신호(REST 결과 관찰기)를 시험이 직접 낸다.
vi.mock("@momo/core/lib/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/http")>();
  return {
    ...actual,
    subscribeRestOutcome: (observer: (outcome: unknown) => void) => {
      api.observers.add(observer);
      return () => api.observers.delete(observer);
    },
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
  resendAll: (() => Promise<void>) | null;
  discard: ((id: string) => PendingMessage | null) | null;
  pending: PendingMessage[];
  messages: Message[];
  failureKinds: ReadonlyMap<string, SendFailureKind>;
};
const out: Out = {
  send: null,
  resend: null,
  resendAll: null,
  discard: null,
  pending: [],
  messages: [],
  failureKinds: new Map(),
};

function Probe({ channelId, rt = realtime }: { channelId: string; rt?: RealtimeHandle }): ReactElement {
  const t = useTimeline(rt, WS, channelId, ME);
  useEffect(() => {
    out.send = t.send;
    out.resend = t.resend;
    out.resendAll = (t as { resendAll?: () => Promise<void> }).resendAll ?? null;
    out.discard = t.discard;
    out.pending = t.pending;
    out.messages = t.state.messages;
    out.failureKinds =
      (t as { failureKinds?: ReadonlyMap<string, SendFailureKind> }).failureKinds ?? new Map();
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

async function mount(channelId: string = CH): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(Probe, { channelId }));
  });
}
async function show(channelId: string, rt?: RealtimeHandle): Promise<void> {
  await act(async () => {
    root?.render(createElement(Probe, { channelId, ...(rt ? { rt } : {}) }));
  });
}
async function unmount(): Promise<void> {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

beforeEach(async () => {
  api.sendMessage.mockReset();
  api.fetchMessages.mockReset();
  api.fetchMessages.mockResolvedValue({ messages: [], nextBefore: undefined });
  api.observers.clear();
  localStorage.clear();
  await mount();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await unmount();
  clearAllDrafts();
});

function confirmedMessage(body: string, seq = 1): Message {
  return {
    id: MSG,
    channelId: CH,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: ME,
    type: "text",
    body,
    state: "sent",
    createdAtMs: seq,
  };
}

const network = () => new NetworkError("unreachable", 15_000);

/** 연결이 돌아왔다는 신호(브라우저 online). 훅이 자동 재전송 한 번을 돌릴 시간을 준다. */
async function backOnline(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event("online"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function sendFailing(body: string, error: unknown = network()): Promise<string> {
  api.sendMessage.mockRejectedValueOnce(error);
  await act(async () => {
    await out.send!(body);
  });
  return out.pending[out.pending.length - 1]!.clientMsgId;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("자동 재전송 (결정 ⑤)", () => {
  // 지키는 것: 네트워크로 못 보낸 글은 연결이 돌아오면 같은 멱등 키로 다시 나가고, 서버가 이미 받았어도 한 메시지가 된다.
  it("네트워크로 못 보낸 글은 연결이 돌아오면(online) 같은 멱등 키로 저절로 다시 나가 한 메시지가 된다", async () => {
    const id = await sendFailing("월요일 공지");
    expect(out.pending[0]?.status).toBe("failed");
    expect(api.sendMessage).toHaveBeenCalledTimes(1);

    api.sendMessage.mockResolvedValueOnce(confirmedMessage("월요일 공지"));
    await backOnline();

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage.mock.calls[1]?.[2]).toBe(id);
    expect(out.pending).toEqual([]);
    expect(out.messages.map((m) => m.body)).toEqual(["월요일 공지"]);
  });

  // 지키는 것: 서버가 거절한 글(ApiError)·알 수 없는 오류는 몰래 다시 보내지 않는다. 손으로 보낸다.
  it("서버가 거절한 글과 알 수 없는 오류는 연결이 돌아와도 저절로 나가지 않는다", async () => {
    await sendFailing("너무 긴 글", new ApiError(413, "message too large"));
    await sendFailing("알 수 없는 실패", new Error("boom"));
    expect(out.pending.map((p) => p.status)).toEqual(["failed", "failed"]);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);

    await backOnline();

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(out.pending.map((p) => p.status)).toEqual(["failed", "failed"]);
  });

  // 지키는 것: 한 글 3회 상한. 첫 전송은 세지 않고 자동으로 다시 보낸 횟수만 센다.
  it("자동 재전송이 세 번 모두 네트워크로 실패하면 그 뒤 신호에는 더 보내지 않는다", async () => {
    await sendFailing("안 닿는 글");
    for (let i = 0; i < AUTO_RESEND_MAX_ATTEMPTS; i++) {
      api.sendMessage.mockRejectedValueOnce(network());
      await backOnline();
    }
    expect(api.sendMessage).toHaveBeenCalledTimes(1 + AUTO_RESEND_MAX_ATTEMPTS);
    expect(out.pending[0]?.status).toBe("failed");

    api.sendMessage.mockResolvedValueOnce(confirmedMessage("안 닿는 글"));
    await backOnline();
    expect(api.sendMessage).toHaveBeenCalledTimes(1 + AUTO_RESEND_MAX_ATTEMPTS);
    expect(out.pending[0]?.status).toBe("failed");
  });

  // 지키는 것: 5분 상한. 첫 실패로부터 5분이 지나면 저절로는 보내지 않는다(그 뒤는 사람이 정한다).
  it("첫 실패로부터 5분이 지난 글은 연결이 돌아와도 저절로 나가지 않는다", async () => {
    const t0 = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    await sendFailing("늦게 닿은 연결");
    now.mockReturnValue(t0 + AUTO_RESEND_WINDOW_MS);
    api.sendMessage.mockResolvedValueOnce(confirmedMessage("늦게 닿은 연결"));
    await backOnline();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(out.pending[0]?.status).toBe("failed");

    // 손으로 누르면 5분 뒤에도 나간다.
    await act(async () => {
      await out.resend!(out.pending[0]!.clientMsgId);
    });
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(out.pending).toEqual([]);
  });

  // 지키는 것: 서버가 답했다(REST 응답)는 사실도 「연결이 돌아왔다」의 신호다. 5xx 응답은 아니다.
  it("서버가 답하면(응답 < 500) 다시 보내고, 5xx 응답이나 응답 없음은 신호가 아니다", async () => {
    await sendFailing("서버가 돌아오면 가는 글");
    const emit = (outcome: RestOutcome) => {
      act(() => {
        for (const observer of [...api.observers]) observer(outcome);
      });
    };
    const base = { at: 1, method: "GET", target: "/v1/x" } as const;
    emit({ ...base, kind: "response", status: 502 });
    emit({ ...base, kind: "network", failure: "unreachable" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);

    api.sendMessage.mockResolvedValueOnce(confirmedMessage("서버가 돌아오면 가는 글"));
    emit({ ...base, kind: "response", status: 200 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(out.pending).toEqual([]);
  });

  // 지키는 것: 보내는 중인 행은 건드리지 않는다(같은 키로 요청이 날아가는 중이다).
  it("보내는 중인 행은 자동 재전송이 건드리지 않는다", async () => {
    const inflight = deferred<Message>();
    api.sendMessage.mockReturnValueOnce(inflight.promise);
    await act(async () => {
      void out.send!("가는 중");
    });
    expect(out.pending[0]?.status).toBe("sending");
    await backOnline();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    await act(async () => {
      inflight.resolve(confirmedMessage("가는 중"));
    });
    expect(out.pending).toEqual([]);
  });

  // 지키는 것: 기기가 꺼져 있다고 알면 서버가 답했다는 신호가 와도 기다린다(online 이 오면 그때 보낸다).
  it("기기가 꺼져 있다고 알면 서버가 답했다는 신호에도 보내지 않고, online 이 오면 보낸다", async () => {
    await sendFailing("꺼진 동안의 글");
    const onLine = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    act(() => {
      for (const observer of [...api.observers]) {
        observer({ kind: "response", status: 200, at: 1, method: "GET", target: "/v1/x" });
      }
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);

    onLine.mockReturnValue(true);
    api.sendMessage.mockResolvedValueOnce(confirmedMessage("꺼진 동안의 글"));
    await backOnline();
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(out.pending).toEqual([]);
  });

  // 지키는 것: 3회는 자동에 대한 상한이다. 손으로 다시 보낸 실패는 세지 않고 되돌리지도 않는다.
  it("손으로 다시 보낸 실패는 자동 횟수에 세지 않는다", async () => {
    const id = await sendFailing("손으로도 안 닿는 글");
    for (let i = 0; i < 2; i++) {
      api.sendMessage.mockRejectedValueOnce(network());
      await act(async () => {
        await out.resend!(id);
      });
    }
    expect(api.sendMessage).toHaveBeenCalledTimes(3);
    // 자동은 아직 0회 썼으므로 3회가 그대로 남아 있다.
    for (let i = 0; i < AUTO_RESEND_MAX_ATTEMPTS; i++) {
      api.sendMessage.mockRejectedValueOnce(network());
      await backOnline();
    }
    expect(api.sendMessage).toHaveBeenCalledTimes(3 + AUTO_RESEND_MAX_ATTEMPTS);
  });
});

describe("원인 한 줄과 모두 다시 보내기", () => {
  // 지키는 것: 실패 행마다 원인 종류가 실제 실패를 따라간다.
  it("실패한 행마다 원인 종류를 알린다: 오프라인 · 서버에 닿지 못함 · 서버 거절 · 알 수 없음은 없음", async () => {
    const offline = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    const a = await sendFailing("꺼진 채로", network());
    offline.mockReturnValue(true);
    const b = await sendFailing("서버가 안 닿음", network());
    const c = await sendFailing("서버가 거절", new ApiError(403, "forbidden"));
    const d = await sendFailing("알 수 없음", new Error("boom"));
    expect(out.failureKinds.get(a)).toBe("offline");
    expect(out.failureKinds.get(b)).toBe("server");
    expect(out.failureKinds.get(c)).toBe("rejected");
    expect(out.failureKinds.has(d)).toBe(false);
  });

  // 지키는 것: 모두 다시 보내기는 보낸 순서대로, 같은 키로, 손으로 누른 것이므로 서버가 거절했던 글도 포함한다.
  it("모두 다시 보내기는 실패한 모든 행(거절된 글 포함)을 보낸 순서대로 같은 키로 다시 보낸다", async () => {
    const a = await sendFailing("첫째", network());
    const b = await sendFailing("둘째", new ApiError(429, "slow down"));
    const c = await sendFailing("셋째", network());
    api.sendMessage.mockImplementation(async (_w: string, _c: string, _id: string, body: string) =>
      confirmedMessage(body)
    );
    await act(async () => {
      await out.resendAll!();
    });
    expect(api.sendMessage.mock.calls.slice(3).map((call) => call[2])).toEqual([a, b, c]);
    expect(out.pending).toEqual([]);
  });

  // 지키는 것: 앞의 글이 네트워크로 또 실패하면 멈춘다(뒤의 글이 앞의 글을 앞지르지 않게). 서버가 거절한 글은 건너뛴다.
  it("모두 다시 보내기는 네트워크로 또 실패하면 멈추고, 서버가 거절한 글은 건너뛰고 이어 간다", async () => {
    const a = await sendFailing("첫째", network());
    const b = await sendFailing("둘째", network());
    api.sendMessage.mockRejectedValueOnce(network());
    await act(async () => {
      await out.resendAll!();
    });
    expect(api.sendMessage).toHaveBeenCalledTimes(3);
    expect(api.sendMessage.mock.calls[2]?.[2]).toBe(a);
    expect(out.pending.map((p) => p.status)).toEqual(["failed", "failed"]);

    api.sendMessage.mockRejectedValueOnce(new ApiError(400, "bad"));
    api.sendMessage.mockImplementationOnce(async (_w: string, _c: string, _id: string, body: string) =>
      confirmedMessage(body)
    );
    await act(async () => {
      await out.resendAll!();
    });
    expect(api.sendMessage.mock.calls.slice(3).map((call) => call[2])).toEqual([a, b]);
    expect(out.pending.map((p) => p.clientMsgId)).toEqual([a]);
  });
});

describe("실패한 글 지키기 (채널 이동·새로고침)", () => {
  // 지키는 것: 같은 채널에서 효과만 다시 도는 경우(레일이 늦게 와 구독을 붙인다)에도 실패한 행과 보내는 중인 행을 잃지 않는다.
  it("같은 채널에서 레일이 바뀌어도 실패 행과 보내는 중인 행이 남는다", async () => {
    const failedId = await sendFailing("레일이 바뀌어도 남는 글");
    api.sendMessage.mockReturnValueOnce(deferred<Message>().promise);
    await act(async () => {
      void out.send!("가는 중인 글");
    });
    const sendingId = out.pending[1]!.clientMsgId;
    await show(CH, { ...realtime } as RealtimeHandle);
    expect(out.pending.map((p) => [p.clientMsgId, p.status])).toEqual([
      [failedId, "failed"],
      [sendingId, "sending"],
    ]);
  });

  // 지키는 것: 채널을 옮겼다가 돌아와도 실패한 글이 같은 키·같은 본문의 실패 행으로 남아 있다.
  it("채널을 옮겼다 돌아와도 실패한 글이 같은 키의 실패 행으로 남는다. 다른 채널에는 보이지 않는다", async () => {
    const id = await sendFailing("잃으면 안 되는 글");
    await show(CH_B);
    expect(out.pending).toEqual([]);
    await show(CH);
    expect(out.pending).toHaveLength(1);
    expect(out.pending[0]).toMatchObject({
      clientMsgId: id,
      channelId: CH,
      body: "잃으면 안 되는 글",
      status: "failed",
    });
    // 되살린 행을 다시 보내면 같은 키로 나가 한 메시지가 된다.
    api.sendMessage.mockResolvedValueOnce(confirmedMessage("잃으면 안 되는 글"));
    await act(async () => {
      await out.resend!(id);
    });
    expect(api.sendMessage.mock.calls[1]?.[2]).toBe(id);
    expect(out.pending).toEqual([]);
  });

  // 지키는 것: 새로고침(훅을 새로 만든다)에도 남는다. 원인 한 줄도 같이 돌아온다.
  it("새로고침해도 실패한 글이 남고 원인 한 줄도 돌아온다", async () => {
    const id = await sendFailing("새로고침 전의 글", new ApiError(403, "forbidden"));
    await unmount();
    await mount();
    expect(out.pending).toHaveLength(1);
    expect(out.pending[0]).toMatchObject({ clientMsgId: id, body: "새로고침 전의 글", status: "failed" });
    expect(out.failureKinds.get(id)).toBe("rejected");
  });

  // 지키는 것: 되살린 행은 자동 대상이 아니다(처음 실패한 때를 몰라 5분을 셀 수 없다). 손으로 보낸다.
  it("되살린 행은 연결이 돌아와도 저절로 나가지 않고 손으로 보낸다", async () => {
    await sendFailing("되살린 글");
    await unmount();
    await mount();
    await backOnline();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(out.pending[0]?.status).toBe("failed");
  });

  // 지키는 것: 떠난 뒤에 끝난 요청도 잃지 않는다. 실패로 끝나면 돌아왔을 때 실패 행이고, 성공으로 끝나면 흔적이 없다.
  it("보내는 중에 채널을 떠났다가 요청이 실패하면 돌아왔을 때 실패 행이고, 성공하면 남지 않는다", async () => {
    const failing = deferred<Message>();
    api.sendMessage.mockReturnValueOnce(failing.promise);
    await act(async () => {
      void out.send!("떠난 뒤에 실패");
    });
    const failedId = out.pending[0]!.clientMsgId;
    await show(CH_B);
    await act(async () => {
      failing.reject(network());
    });
    await show(CH);
    expect(out.pending.map((p) => [p.clientMsgId, p.status])).toEqual([[failedId, "failed"]]);
    // 떠난 뒤에 끝난 실패도 원인(서버에 닿지 못함)을 같이 남긴다: 떠날 때 남긴 「모름」이 아니다.
    expect(out.failureKinds.get(failedId)).toBe("server");
    await act(async () => {
      await out.discard!(failedId);
    });

    const ok = deferred<Message>();
    api.sendMessage.mockReturnValueOnce(ok.promise);
    await act(async () => {
      void out.send!("떠난 뒤에 성공");
    });
    await show(CH_B);
    await act(async () => {
      ok.resolve(confirmedMessage("떠난 뒤에 성공"));
    });
    await show(CH);
    expect(out.pending).toEqual([]);
  });

  // 지키는 것: 보내는 중에 새로고침하면 결과를 모르므로 실패 행으로 돌아온다(같은 키로 다시 보내면 서버가 중복을 막는다).
  it("보내는 중에 새로고침하면 그 글이 실패 행으로 돌아온다", async () => {
    api.sendMessage.mockReturnValueOnce(deferred<Message>().promise);
    await act(async () => {
      void out.send!("보내다 새로고침");
    });
    const id = out.pending[0]!.clientMsgId;
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    // 실제 새로고침은 React 를 언마운트하지 않는다: 페이지를 떠나는 그 순간(pagehide)에 이미 남아 있어야 한다.
    expect(readFailedSends(WS, CH, ME).map((entry) => [entry.row.clientMsgId, entry.row.status])).toEqual([
      [id, "failed"],
    ]);
    await unmount();
    await mount();
    expect(out.pending.map((p) => [p.clientMsgId, p.status])).toEqual([[id, "failed"]]);
  });

  // 지키는 것: 지우면(X) 이 기기에서 완전히 지워진다. 다시 열어도 되살아나지 않는다.
  it("지운 글은 채널을 다시 열어도 되살아나지 않는다", async () => {
    const id = await sendFailing("지울 글");
    act(() => {
      out.discard!(id);
    });
    await show(CH_B);
    await show(CH);
    expect(out.pending).toEqual([]);
    await unmount();
    await mount();
    expect(out.pending).toEqual([]);
  });

  // 지키는 것: 사실은 서버가 받았던 글(응답만 유실)은 되살아나지 않고 확정 메시지 하나로만 남는다.
  it("서버가 이미 받았던 글은 되살아난 행이 확정 메시지와 만나 정리되고 남지 않는다", async () => {
    await sendFailing("사실은 갔던 글");
    await unmount();
    api.fetchMessages.mockResolvedValue({ messages: [confirmedMessage("사실은 갔던 글", 5)], nextBefore: undefined });
    await mount();
    expect(out.pending).toEqual([]);
    expect(out.messages.map((m) => m.body)).toEqual(["사실은 갔던 글"]);
    // 정리된 행은 저장소에서도 사라져 다음에 다시 열어도 없다.
    await unmount();
    api.fetchMessages.mockResolvedValue({ messages: [], nextBefore: undefined });
    await mount();
    expect(out.pending).toEqual([]);
  });

  // 지키는 것: 로그아웃(clearAllDrafts)이 이 기기의 실패한 글도 함께 지운다(초안과 같은 저장소 규칙).
  it("로그아웃이 남겨 둔 실패한 글도 함께 지운다", async () => {
    await sendFailing("로그아웃 전의 글");
    clearAllDrafts();
    await unmount();
    await mount();
    expect(out.pending).toEqual([]);
  });

  // 지키는 것: 키 모양이 든 글은 이 기기에 남기지 않는다(초안과 같은 규칙, #2942).
  it("API 키 모양이 든 글은 저장소에 남기지 않는다", async () => {
    const key = `sk-ant-${"a1".repeat(12)}`;
    await sendFailing(`이 키로 해 주세요 ${key}`);
    await unmount();
    await mount();
    expect(out.pending).toEqual([]);
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain(key);
  });
});
