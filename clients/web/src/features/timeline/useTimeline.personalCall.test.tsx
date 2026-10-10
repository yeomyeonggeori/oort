// @vitest-environment jsdom
// #3653: the real useTimeline sends the message first (with its optimistic echo),
// then signs the id the server returned and posts the spawn. A teammate's send has
// no call at all.

import { act, createElement, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type HumanSignatureRequest, type Message } from "@momo/core/lib/api";
import type { ControlToSign, HumanControlSigner } from "@momo/core/features/auth/signedControl";
import { useTimeline, type TimelineSendOptions } from "./useTimeline";
import type { RealtimeHandle } from "@/lib/realtime";
import type { PersonalAgentCallResult } from "@momo/core/features/auth/personalAgentCall";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";
const MSG = "00000000-0000-7000-8000-00000000e002";
const HOST = "00000000-0000-7000-8000-00000000f001";

const api = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  postWorkSpawn: vi.fn(),
}));

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
  pending: number;
} = { send: null, resend: null, pending: 0 };

function Probe(): ReactElement {
  const t = useTimeline(realtime, WS, CH, ME);
  useEffect(() => {
    out.send = t.send;
    out.resend = t.resend;
    out.pending = t.pending.length;
  });
  return createElement("div");
}

const signature: HumanSignatureRequest = {
  deviceKeyId: "00000000-0000-7000-8000-00000000d003",
  nonce: "0193a5b8-7c1e-7d2a-9f00-000000000041",
  issuedAtMs: 1,
  expiresAtMs: 2,
  signature: "c2ln",
  agentMemberId: "agent-1",
  folderId: "fld_0123456789abcdef0123",
};

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
  api.sendMessage.mockReset().mockResolvedValue({ id: MSG, channelId: CH, seq: 1, authorMemberId: ME, body: "x" } as Message);
  api.postWorkSpawn.mockReset().mockResolvedValue({ workControl: { id: "ctl-1", status: "dispatched" }, replayed: false });
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

function call(over: { signer?: HumanControlSigner | null; onResult?: (r: PersonalAgentCallResult) => void } = {}) {
  const signed: ControlToSign[] = [];
  const signer: HumanControlSigner = {
    async sign(control) {
      signed.push(control);
      return signature;
    },
  };
  const onResult = over.onResult ?? vi.fn();
  return {
    signed,
    onResult,
    options: {
      personalCall: {
        agent: { memberId: "agent-1", handle: "my-claude", label: "내 Claude Code", harness: "claude" },
        host: { hostId: HOST, hostName: "맥", folderId: "fld_0123456789abcdef0123", online: true },
        signer: over.signer === undefined ? signer : over.signer,
        audience: "channel" as const,
        onResult,
      },
    } satisfies TimelineSendOptions,
  };
}

describe("useTimeline.send with a personal call", () => {
  it("sends once through the echo path, signs the returned message id, posts the spawn, reports the result", async () => {
    const { options, signed, onResult } = call();
    await act(async () => {
      await out.send!("@my-claude 빌드를 봐 줘", options);
    });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(signed).toHaveLength(1);
    expect((signed[0]!.content as { originMessageId: string }).originMessageId).toBe(MSG);
    expect(api.postWorkSpawn).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect((onResult as ReturnType<typeof vi.fn>).mock.calls[0]![0].call).toMatchObject({ state: "called" });
    expect(out.pending).toBe(0);
  });

  it("an ordinary send never signs or posts a spawn", async () => {
    await act(async () => {
      await out.send!("@their-claude 빌드를 봐 줘");
    });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.postWorkSpawn).not.toHaveBeenCalled();
  });

  it("a message that fails keeps its echo with a retry, signs nothing, and the retry then makes the call exactly once", async () => {
    api.sendMessage.mockRejectedValueOnce(new ApiError(500, "down"));
    const { options, signed, onResult } = call();
    await act(async () => {
      await out.send!("@my-claude 빌드를 봐 줘", options);
    });
    expect(signed).toHaveLength(0);
    expect(api.postWorkSpawn).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
    expect(out.pending).toBe(1);
    const clientMsgId = (api.sendMessage.mock.calls[0] as unknown[])[2] as string;
    await act(async () => {
      await out.resend!(clientMsgId);
    });
    // the same idempotency key, and now the call
    expect((api.sendMessage.mock.calls[1] as unknown[])[2]).toBe(clientMsgId);
    expect(signed).toHaveLength(1);
    expect(api.postWorkSpawn).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it("Mac off: the message stays sent, the result carries the signed body for a same-signature retry", async () => {
    api.postWorkSpawn.mockRejectedValueOnce(new ApiError(409, "off", "work_host_offline"));
    const { options, onResult } = call();
    await act(async () => {
      await out.send!("@my-claude 빌드를 봐 줘", options);
    });
    const result = (onResult as ReturnType<typeof vi.fn>).mock.calls[0]![0] as PersonalAgentCallResult;
    expect(result.call).toMatchObject({ state: "not_delivered", text: "내 맥이 꺼져 있어요. 맥을 켠 뒤 다시 불러 주세요." });
    expect(out.pending).toBe(0);
  });
});
