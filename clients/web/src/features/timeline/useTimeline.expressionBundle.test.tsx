// @vitest-environment jsdom
// #5453: 이모티콘 + 글을 보내기 한 번에. 와이어는 큰 표현 메시지 → 글 메시지 둘이고, 둘은 서로 다른 멱등 열쇠를 쓰며, 첫 메시지가 확정되기 전에는 둘째가 나가지 않는다.
// 판정은 코어(`sendBundle.ts`)이고 여기서는 훅이 그 판정을 **모든 길**(처음·다시·모두 다시)에서 그대로 따르는지를 잰다.

import { act, createElement, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Message } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { FIXTURE_EXPRESSIONS } from "@momo/core/features/expressions/fixtures";
import type { Expression } from "@momo/core/features/expressions/types";
import type { PendingMessage } from "@momo/core/features/timeline/model";
import { clearAllDrafts, readFailedSends } from "@/features/chat/draftStore";
import { useTimeline, type TimelineSendOptions } from "./useTimeline";
import type { RealtimeHandle } from "@/lib/realtime";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";
const QUOTED = "00000000-0000-7000-8000-00000000c0de";

const api = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  fetchMessages: vi.fn(),
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

const sticker: Expression = FIXTURE_EXPRESSIONS.find((entry) => entry.kind === "sticker" && entry.status === "active") ?? FIXTURE_EXPRESSIONS[0];
const TOKEN = `:${sticker.name}:`;

type Out = {
  send: ((body: string, options?: TimelineSendOptions) => Promise<void>) | null;
  resend: ((id: string) => Promise<void>) | null;
  resendAll: (() => Promise<void>) | null;
  discard: ((id: string) => PendingMessage | null) | null;
  pending: PendingMessage[];
};
const out: Out = { send: null, resend: null, resendAll: null, discard: null, pending: [] };

function Probe(): ReactElement {
  const t = useTimeline(realtime, WS, CH, ME);
  useEffect(() => {
    out.send = t.send;
    out.resend = t.resend;
    out.resendAll = t.resendAll;
    out.discard = t.discard;
    out.pending = t.pending;
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
beforeEach(async () => {
  api.sendMessage.mockReset();
  api.fetchMessages.mockReset();
  api.fetchMessages.mockResolvedValue({ messages: [], nextBefore: undefined });
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(Probe));
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  clearAllDrafts();
});

let seq = 0;
function confirmed(clientMsgId: string, body: string): Message {
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
    createdAtMs: seq,
    clientMsgId,
  } as Message;
}
/** 서버 흉내: 받은 열쇠와 본문 그대로 확정한다(실패 대본이 앞서 있으면 그 대본이 먼저 쓰인다). */
function serverConfirms() {
  api.sendMessage.mockImplementation(async (_ws: string, _ch: string, clientMsgId: string, body: string) => confirmed(clientMsgId, body));
}
const network = () => new NetworkError("unreachable", 15_000);
const callIds = () => api.sendMessage.mock.calls.map((call) => call[2] as string);
const callBodies = () => api.sendMessage.mock.calls.map((call) => call[3] as string);

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

describe("이모티콘 + 글 한 번에 (표현 메시지 → 글 메시지)", () => {
  it("서로 다른 열쇠로 표현이 먼저 확정된 뒤에 글이 나간다 — 표현 메시지는 `:이름:` 하나이고 인용은 글이 나른다", async () => {
    const first = deferred<Message>();
    api.sendMessage.mockImplementationOnce(() => first.promise);
    serverConfirms();
    let sent: Promise<void> = Promise.resolve();
    await act(async () => {
      sent = out.send!("점심 먹으러 가요", { expression: sticker, replyToId: QUOTED });
      await Promise.resolve();
    });
    // 첫 요청이 아직 답하지 않은 동안 둘째는 나가지 않고, 두 행이 보내는 중으로 서 있다.
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(out.pending.map((row) => [row.body, row.status])).toEqual([[TOKEN, "sending"], ["점심 먹으러 가요", "sending"]]);
    await act(async () => {
      first.resolve(confirmed(callIds()[0], TOKEN));
      await sent;
    });
    expect(callBodies()).toEqual([TOKEN, "점심 먹으러 가요"]);
    expect(new Set(callIds()).size).toBe(2);
    // 인용·라우팅 같은 옵션은 글 메시지가 나른다. 표현 메시지의 요청에는 없다.
    expect(api.sendMessage.mock.calls[0]?.[4]).toEqual({});
    expect(api.sendMessage.mock.calls[1]?.[4]).toMatchObject({ replyToId: QUOTED });
    expect(out.pending).toEqual([]);
  });

  it("표현만 보내면 메시지 하나이고 인용은 그 하나가 나른다 — 글만 보내면 예전과 같은 요청이다", async () => {
    serverConfirms();
    await act(async () => {
      await out.send!("", { expression: sticker, replyToId: QUOTED });
    });
    expect(callBodies()).toEqual([TOKEN]);
    expect(api.sendMessage.mock.calls[0]?.[4]).toMatchObject({ replyToId: QUOTED });
    api.sendMessage.mockClear();
    await act(async () => {
      await out.send!("그냥 글");
    });
    expect(callBodies()).toEqual(["그냥 글"]);
    expect(out.pending).toEqual([]);
  });

  it("표현이 서버에 닿지 못하면 글은 요청조차 나가지 않고, 두 행이 모두 실패로 남는다 — 글을 잃지 않는다", async () => {
    api.sendMessage.mockRejectedValueOnce(network());
    await act(async () => {
      await out.send!("회의 끝나고 봬요", { expression: sticker });
    });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(out.pending.map((row) => [row.body, row.status])).toEqual([[TOKEN, "failed"], ["회의 끝나고 봬요", "failed"]]);
    expect(out.pending[1]?.after).toBe(out.pending[0]?.clientMsgId);
    // 이 기기에도 남아 새로고침 뒤에 같은 순서 규칙으로 돌아온다.
    expect(readFailedSends(WS, CH, ME).map((stored) => [stored.row.body, stored.row.after === undefined ? "-" : "after"]).sort()).toEqual([[TOKEN, "-"], ["회의 끝나고 봬요", "after"]].sort());
  });

  it("뒤 행에서 다시 보내도 앞부터 같은 열쇠로 나가고, 이어서 글이 나간다 — 서버에는 둘이 한 번씩이다", async () => {
    api.sendMessage.mockRejectedValueOnce(network());
    await act(async () => {
      await out.send!("회의 끝나고 봬요", { expression: sticker });
    });
    const [firstRow, secondRow] = out.pending;
    serverConfirms();
    await act(async () => {
      await out.resend!(secondRow!.clientMsgId);
    });
    expect(callIds()).toEqual([firstRow!.clientMsgId, firstRow!.clientMsgId, secondRow!.clientMsgId]);
    expect(callBodies()).toEqual([TOKEN, TOKEN, "회의 끝나고 봬요"]);
    expect(out.pending).toEqual([]);
  });

  it("서버가 거절한 표현 뒤에서 모두 다시 보내기도 글을 앞지르게 두지 않는다 — 앞 행을 지우면 글이 혼자 나간다", async () => {
    api.sendMessage.mockRejectedValueOnce(new ApiError(404, "expression gone"));
    await act(async () => {
      await out.send!("그래도 글은 가요", { expression: sticker });
    });
    const [firstRow, secondRow] = out.pending;
    expect(out.pending.map((row) => row.status)).toEqual(["failed", "failed"]);
    // 모두 다시 보내기: 앞이 또 거절당해도(거절이면 다음 글로 이어 가는 규칙) 뒤는 앞이 목록에 있는 동안 나가지 않는다.
    api.sendMessage.mockRejectedValueOnce(new ApiError(404, "expression gone"));
    await act(async () => {
      await out.resendAll!();
    });
    expect(callIds()).toEqual([firstRow!.clientMsgId, firstRow!.clientMsgId]);
    expect(out.pending.map((row) => row.status)).toEqual(["failed", "failed"]);
    // 사람이 그림을 포기한다: 앞 행을 지우면 글은 앞이 없는 행이 되어 혼자 나간다.
    serverConfirms();
    await act(async () => {
      expect(out.discard!(firstRow!.clientMsgId)?.body).toBe(TOKEN);
    });
    await act(async () => {
      await out.resend!(secondRow!.clientMsgId);
    });
    expect(callIds().slice(2)).toEqual([secondRow!.clientMsgId]);
    expect(callBodies().slice(2)).toEqual(["그래도 글은 가요"]);
    expect(out.pending).toEqual([]);
  });
});
