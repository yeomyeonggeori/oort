import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  sendThreadReply: vi.fn(),
  postWorkSpawn: vi.fn(),
}));

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, ...api };
});

import { ApiError, type HumanSignatureRequest, type Message } from "../../lib/api";
import {
  CALL_MAC_OFF_LINE,
  CALL_NEEDS_APP_LINE,
  CALL_NOTHING_TO_ASK_LINE,
  callFailureLine,
  callPersonalAgent,
  labelFromPrompt,
  toolKeyForHarness,
  promptFromMessage,
  resendPersonalAgentCall,
  type CallPersonalAgentInput,
} from "./personalAgentCall";
import { SignerRefusal, type ControlToSign, type HumanControlSigner } from "./signedControl";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-00000000cc01";
const AGENT = "00000000-0000-7000-8000-000000000a02";
const HOST = "00000000-0000-7000-8000-00000000f001";
const MSG = "00000000-0000-7000-8000-00000000e002";
const ROOT = "00000000-0000-7000-8000-00000000e001";

const signature: HumanSignatureRequest = {
  deviceKeyId: "00000000-0000-7000-8000-00000000d003",
  nonce: "0193a5b8-7c1e-7d2a-9f00-000000000041",
  issuedAtMs: 1,
  expiresAtMs: 2,
  signature: "c2ln",
  agentMemberId: AGENT,
  folderId: "fld_0123456789abcdef0123",
};

function sent(extra: Partial<Message> = {}): Message {
  return { id: MSG, channelId: CH, seq: 7, authorMemberId: "owner", ...extra } as Message;
}

function recordingSigner(): { signer: HumanControlSigner; signed: ControlToSign[] } {
  const signed: ControlToSign[] = [];
  return {
    signed,
    signer: {
      async sign(control) {
        signed.push(control);
        return signature;
      },
    },
  };
}

function input(overrides: Partial<CallPersonalAgentInput> = {}): CallPersonalAgentInput {
  return {
    workspaceId: WS,
    channelId: CH,
    clientMsgId: "cmid-1",
    text: "@kwak-claude 빌드가 왜 깨지는지 봐 줘\n로그부터요",
    agent: { memberId: AGENT, handle: "kwak-claude" },
    destination: { hostId: HOST, folderId: "fld_0123456789abcdef0123", tool: "claude" },
    signer: null,
    ...overrides,
  };
}

beforeEach(() => {
  api.sendMessage.mockReset().mockResolvedValue(sent());
  api.sendThreadReply.mockReset().mockResolvedValue(sent({ rootId: ROOT }));
  api.postWorkSpawn.mockReset().mockResolvedValue({ workControl: { id: "ctl-1", status: "dispatched" }, replayed: false });
});

describe("calling a personal agent (#3592)", () => {
  it("sends the message FIRST, then signs a v4 spawn that names it", async () => {
    const { signer, signed } = recordingSigner();
    const order: string[] = [];
    api.sendMessage.mockImplementation(async () => {
      order.push("send");
      return sent();
    });
    api.postWorkSpawn.mockImplementation(async () => {
      order.push("spawn");
      return { workControl: { id: "ctl-1", status: "dispatched" }, replayed: false };
    });
    const result = await callPersonalAgent(input({ signer }));

    expect(order).toEqual(["send", "spawn"]);
    expect(result.call).toEqual({ state: "called", replayed: false, controlId: "ctl-1" });
    expect(signed).toHaveLength(1);
    expect(signed[0]!.hostId).toBe(HOST);
    expect(signed[0]!.sessionId).toBeNull();
    expect(signed[0]!.content).toEqual({
      kind: "spawn_task",
      agentMemberId: AGENT,
      folderId: "fld_0123456789abcdef0123",
      tool: "claude",
      channelId: CH,
      threadRootId: null,
      originMessageId: MSG,
      label: "빌드가 왜 깨지는지 봐 줘",
      prompt: "빌드가 왜 깨지는지 봐 줘\n로그부터요",
    });
    const body = api.postWorkSpawn.mock.calls[0]![1];
    expect(body).toMatchObject({ tool: "claude", channelId: CH, originMessageId: MSG, targetHostId: HOST });
    expect(body.threadRootId).toBeUndefined();
  });

  it("signs the tool KEY the host allowlists, not the roster's harness name (#3660)", async () => {
    // The roster says `claude_code` (agent.subscription_harness); the server's
    // work_tool_profile key is `claude`. Sending the harness name was refused
    // with spawn_tool_invalid on every phone call.
    const { signer, signed } = recordingSigner();
    await callPersonalAgent(
      input({ signer, destination: { hostId: HOST, folderId: "fld_0123456789abcdef0123", tool: "claude_code" } })
    );
    expect((signed[0]!.content as { tool: string }).tool).toBe("claude");
    expect(api.postWorkSpawn.mock.calls[0]![1].tool).toBe("claude");
    expect(toolKeyForHarness("claude_code")).toBe("claude");
    expect(toolKeyForHarness("codex")).toBe("codex");
    expect(toolKeyForHarness("opencode")).toBe("opencode");
  });

  it("in a thread it signs the thread root the server returned", async () => {
    const { signer, signed } = recordingSigner();
    const result = await callPersonalAgent(input({ signer, threadRootId: ROOT }));
    expect(api.sendThreadReply).toHaveBeenCalledOnce();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(result.call.state).toBe("called");
    expect(signed[0]!.content).toMatchObject({ kind: "spawn_task", threadRootId: ROOT, originMessageId: MSG });
    expect(api.postWorkSpawn.mock.calls[0]![1].threadRootId).toBe(ROOT);
  });

  it("without a signing key (a browser) the message stays and nothing is signed or posted", async () => {
    const result = await callPersonalAgent(input({ signer: null }));
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(api.postWorkSpawn).not.toHaveBeenCalled();
    expect(result.call).toEqual({ state: "message_only", reason: "no_signer", text: CALL_NEEDS_APP_LINE });
    expect(CALL_NEEDS_APP_LINE).toBe("데스크탑·폰에서 불러 주세요");
  });

  it("an alias with nothing after it sends the message and calls nothing", async () => {
    const { signer, signed } = recordingSigner();
    const result = await callPersonalAgent(input({ signer, text: "@kwak-claude  " }));
    expect(result.call).toEqual({ state: "message_only", reason: "nothing_to_ask", text: CALL_NOTHING_TO_ASK_LINE });
    expect(signed).toHaveLength(0);
    expect(api.postWorkSpawn).not.toHaveBeenCalled();
  });

  it("a cancelled Face ID leaves the message and says why; nothing is posted", async () => {
    const signer: HumanControlSigner = {
      async sign() {
        throw new SignerRefusal("Face ID를 취소해서 보내지 않았어요.", true);
      },
    };
    const result = await callPersonalAgent(input({ signer }));
    expect(result.message.id).toBe(MSG);
    expect(result.call).toMatchObject({ state: "not_delivered", stage: "sign", text: "Face ID를 취소해서 보내지 않았어요.", signed: null });
    expect(api.postWorkSpawn).not.toHaveBeenCalled();
  });

  it("the Mac being off is one sentence, nothing is queued, and the signed call can be resent", async () => {
    const { signer } = recordingSigner();
    api.postWorkSpawn.mockRejectedValueOnce(new ApiError(409, "offline", "work_host_offline"));
    const result = await callPersonalAgent(input({ signer }));
    expect(result.call).toMatchObject({ state: "not_delivered", stage: "server", text: CALL_MAC_OFF_LINE });
    expect(CALL_MAC_OFF_LINE).toContain("내 맥이 꺼져 있어요");
    const call = result.call;
    if (call.state !== "not_delivered" || call.signed === null) throw new Error("expected a resendable call");
    // Same nonce, same signature: the server answers a retry with `replayed`.
    api.postWorkSpawn.mockResolvedValueOnce({ workControl: { id: "ctl-1", status: "dispatched" }, replayed: true });
    const resent = await resendPersonalAgentCall(WS, call.signed);
    expect(resent).toEqual({ state: "called", replayed: true, controlId: "ctl-1" });
    expect(api.postWorkSpawn.mock.calls[1]![1].humanSignature.nonce).toBe(signature.nonce);
  });

  it("a named 4xx refusal is final: no resend, the reason in a sentence", async () => {
    const { signer } = recordingSigner();
    api.postWorkSpawn.mockRejectedValueOnce(new ApiError(403, "no", "spawn_agent_not_allowed"));
    const result = await callPersonalAgent(input({ signer }));
    expect(result.call).toMatchObject({ state: "not_delivered", stage: "server", signed: null });
  });

  it("a message that could not be sent calls nothing and throws", async () => {
    const { signer, signed } = recordingSigner();
    api.sendMessage.mockRejectedValueOnce(new ApiError(500, "boom"));
    await expect(callPersonalAgent(input({ signer }))).rejects.toThrow("boom");
    expect(signed).toHaveLength(0);
    expect(api.postWorkSpawn).not.toHaveBeenCalled();
  });
});

describe("what is signed from what was typed", () => {
  it("drops a leading @alias (and its separator) and keeps the rest as typed", () => {
    expect(promptFromMessage("@kwak-claude 빌드 봐 줘", "kwak-claude")).toBe("빌드 봐 줘");
    expect(promptFromMessage("  @Kwak-Claude: 빌드 봐 줘", "kwak-claude")).toBe("빌드 봐 줘");
    expect(promptFromMessage("<@kwak-claude> 빌드", "kwak-claude")).toBe("빌드");
    // A different handle that merely starts the same is someone else.
    expect(promptFromMessage("@kwak-claude2 빌드", "kwak-claude")).toBe("@kwak-claude2 빌드");
    // A DM has no mention: the text goes whole.
    expect(promptFromMessage("빌드 봐 줘", "kwak-claude")).toBe("빌드 봐 줘");
    expect(promptFromMessage("메일 @kwak-claude 에게", "kwak-claude")).toBe("메일 @kwak-claude 에게");
    // One line-break spelling, so every signer signs what the host reads.
    expect(promptFromMessage("@kwak-claude 첫 줄\r\n둘째 줄\r셋째", "kwak-claude")).toBe("첫 줄\n둘째 줄\n셋째");
  });

  it("makes a one-line title of at most 120 characters", () => {
    expect(labelFromPrompt("\n\n  첫 줄   입니다 \n둘째")).toBe("첫 줄 입니다");
    const long = labelFromPrompt("가".repeat(300));
    expect(Array.from(long).length).toBeLessThanOrEqual(120);
    expect(long.endsWith("…")).toBe(true);
  });

  it("names the refusal in 해요체 and never shows the code", () => {
    for (const code of [
      "work_host_offline",
      "signed_spawn_disabled",
      "spawn_host_not_found",
      "spawn_folder_not_found",
      "spawn_host_ambiguous",
      "spawn_agent_not_allowed",
      "spawn_channel_member_only",
      "spawn_origin_invalid",
      "spawn_prompt_invalid",
      "spawn_nonce_reused",
      "pool_exhausted",
      "never_heard_of_it",
    ]) {
      const line = callFailureLine(new ApiError(409, "x", code));
      expect(line, code).toMatch(/요\.$/);
      expect(line, code).not.toContain(code);
    }
  });
});

describe("a client with its own send path (#3653)", () => {
  it("uses `deliver` instead of the plain REST send and signs the message it returned", async () => {
    const { signer, signed } = recordingSigner();
    const deliver = vi.fn(async () => sent({ id: "00000000-0000-7000-8000-00000000e777" }));
    await callPersonalAgent(input({ signer, deliver }));
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.sendThreadReply).not.toHaveBeenCalled();
    expect(signed).toHaveLength(1);
    expect((signed[0]!.content as { originMessageId: string }).originMessageId).toBe(
      "00000000-0000-7000-8000-00000000e777"
    );
  });

  it("throws, signing nothing, when `deliver` cannot send", async () => {
    const { signer, signed } = recordingSigner();
    await expect(
      callPersonalAgent(input({ signer, deliver: async () => Promise.reject(new ApiError(500, "down")) }))
    ).rejects.toBeInstanceOf(ApiError);
    expect(signed).toHaveLength(0);
    expect(api.postWorkSpawn).not.toHaveBeenCalled();
  });
});

