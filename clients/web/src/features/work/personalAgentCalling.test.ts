import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  sendThreadReply: vi.fn(),
  postWorkSpawn: vi.fn(),
}));

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, ...api };
});

import { ApiError, type HumanSignatureRequest, type Message, type RosterMember, type WorkHost } from "@momo/core/lib/api";
import {
  CALL_MAC_OFF_LINE,
  CALL_NEEDS_APP_LINE,
  resendPersonalAgentCall,
} from "@momo/core/features/auth/personalAgentCall";
import type { ControlToSign, HumanControlSigner } from "@momo/core/features/auth/signedControl";
import {
  callTargetFor,
  FLAG_OFF_LINE,
  flagOffSigner,
  harnessName,
  myPersonalAgent,
  NO_MAC_LINE,
  pickCallHost,
  previewFor,
  runPersonalAgentCall,
  type PersonalCallSpec,
} from "./personalAgentCalling";

const ME = "00000000-0000-7000-8000-00000000000a";
const OTHER = "00000000-0000-7000-8000-00000000000b";
const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-00000000cc01";
const HOST = "00000000-0000-7000-8000-00000000f001";
const MSG = "00000000-0000-7000-8000-00000000e002";
const FOLDER = "fld_0123456789abcdef0123";

function agent(handle: string, personal: Record<string, unknown> | null, over: Partial<RosterMember> = {}): RosterMember {
  return {
    id: `agent-${handle}`,
    workspaceId: WS,
    kind: "agent",
    status: "active",
    displayName: handle,
    handle,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...(personal === null ? {} : { personalAgent: personal }),
    ...over,
  } as RosterMember;
}

const mine = (over: Record<string, unknown> = {}) => ({
  label: "내 Claude Code",
  ownerId: ME,
  ownerDisplayName: "곽성재",
  harness: "claude",
  enabled: true,
  mentionable: true,
  ...over,
});

const MEMBERS: RosterMember[] = [
  agent("my-claude", mine()),
  agent("their-claude", mine({ ownerId: OTHER })),
  agent("intern", null),
];

function host(over: Partial<WorkHost> = {}): WorkHost {
  return {
    id: HOST,
    workspaceId: WS,
    scope: "member",
    ownerMemberId: ME,
    type: "app",
    displayName: "성재의 MacBook",
    capabilities: {},
    createdAtMs: 0,
    online: true,
    defaultFolderId: FOLDER,
    folders: [{ id: FOLDER, displayName: "질문", kind: "question" }],
    ...over,
  };
}

const signature: HumanSignatureRequest = {
  deviceKeyId: "00000000-0000-7000-8000-00000000d003",
  nonce: "0193a5b8-7c1e-7d2a-9f00-000000000041",
  issuedAtMs: 1,
  expiresAtMs: 2,
  signature: "c2ln",
  agentMemberId: "agent-my-claude",
  folderId: FOLDER,
};

function recordingSigner() {
  const signed: ControlToSign[] = [];
  const signer: HumanControlSigner = {
    async sign(control) {
      signed.push(control);
      return signature;
    },
  };
  return { signer, signed };
}

function spec(over: Partial<PersonalCallSpec> = {}): PersonalCallSpec {
  const agentRow = myPersonalAgent(MEMBERS[0]!, ME)!;
  return {
    agent: agentRow,
    host: pickCallHost([host()], ME),
    signer: recordingSigner().signer,
    audience: "channel",
    onResult: () => undefined,
    ...over,
  };
}

function committed(): Message {
  return { id: MSG, channelId: CH, seq: 7, authorMemberId: ME } as Message;
}

beforeEach(() => {
  api.sendMessage.mockReset().mockResolvedValue(committed());
  api.sendThreadReply.mockReset();
  api.postWorkSpawn.mockReset().mockResolvedValue({ workControl: { id: "ctl-1", status: "dispatched" }, replayed: false });
});

describe("who can call (the roster, read narrowly)", () => {
  it("accepts only MY enabled, mentionable personal agent", () => {
    expect(myPersonalAgent(MEMBERS[0]!, ME)).toMatchObject({ memberId: "agent-my-claude", handle: "my-claude", harness: "claude" });
    // a teammate's personal agent is not mine: no plan, the server answers NonOwner
    expect(myPersonalAgent(MEMBERS[1]!, ME)).toBeNull();
    expect(myPersonalAgent(MEMBERS[2]!, ME)).toBeNull();
    expect(myPersonalAgent(agent("x", mine({ enabled: false })), ME)).toBeNull();
    expect(myPersonalAgent(agent("x", mine({ mentionable: false })), ME)).toBeNull();
    expect(myPersonalAgent(agent("x", mine({ harness: 3 })), ME)).toBeNull();
    expect(myPersonalAgent(agent("x", mine(), { status: "suspended" }), ME)).toBeNull();
    expect(myPersonalAgent(agent("x", mine(), { kind: "human" }), ME)).toBeNull();
  });

  it("plans a call for my mention only; a teammate's mention plans nothing", () => {
    const base = { members: MEMBERS, selfId: ME, dmAgent: null };
    expect(callTargetFor({ ...base, text: "@my-claude 빌드를 봐 줘" })?.handle).toBe("my-claude");
    expect(callTargetFor({ ...base, text: "먼저 @my-claude 에게 로그를 물어봐" })?.handle).toBe("my-claude");
    expect(callTargetFor({ ...base, text: "@their-claude 빌드를 봐 줘" })).toBeNull();
    expect(callTargetFor({ ...base, text: "@intern 안녕" })).toBeNull();
    expect(callTargetFor({ ...base, text: "그냥 대화" })).toBeNull();
    expect(callTargetFor({ ...base, text: "@nobody 안녕" })).toBeNull();
  });

  it("plans a call for a DM with my alias without a mention, and not for a teammate's alias DM", () => {
    const base = { members: MEMBERS, selfId: ME };
    expect(callTargetFor({ ...base, text: "빌드를 봐 줘", dmAgent: MEMBERS[0]! })?.handle).toBe("my-claude");
    expect(callTargetFor({ ...base, text: "빌드를 봐 줘", dmAgent: MEMBERS[1]! })).toBeNull();
  });
});

describe("where it goes", () => {
  it("takes my own live member host with its question folder, preferring one that is online", () => {
    const off = host({ id: "h-off", online: false, displayName: "꺼진 맥" });
    expect(pickCallHost([off, host()], ME)).toMatchObject({ hostId: HOST, hostName: "성재의 MacBook", folderId: FOLDER });
    expect(pickCallHost([off], ME)).toMatchObject({ hostId: "h-off", online: false });
  });

  it("never takes a teammate's host, a workspace host, a revoked host or one without a default folder", () => {
    expect(pickCallHost([host({ ownerMemberId: OTHER })], ME)).toBeNull();
    expect(pickCallHost([host({ scope: "workspace" })], ME)).toBeNull();
    expect(pickCallHost([host({ revokedAtMs: 5 })], ME)).toBeNull();
    expect(pickCallHost([host({ defaultFolderId: undefined })], ME)).toBeNull();
    expect(pickCallHost(undefined, ME)).toBeNull();
  });

  it("shows 「내 맥 · <기기> · Claude Code」 before sending, and says why when it cannot", () => {
    expect(previewFor(spec())).toMatchObject({ destination: "내 맥 · 성재의 MacBook · Claude Code", blocked: null, audience: "channel" });
    expect(previewFor(spec({ audience: "dm" })).audience).toBe("dm");
    expect(previewFor(spec({ host: null })).blocked).toBe(NO_MAC_LINE);
    const web = previewFor(spec({ signer: null }));
    expect(web.destination).toBeNull();
    expect(web.blocked).toContain(CALL_NEEDS_APP_LINE);
    expect(harnessName("codex")).toBe("Codex");
    expect(harnessName("some-new-tool")).toBe("some-new-tool");
  });
});

describe("the call, as the composer runs it", () => {
  const run = (s: PersonalCallSpec, text = "@my-claude 빌드가 왜 깨지는지 봐 줘") =>
    runPersonalAgentCall({
      workspaceId: WS,
      channelId: CH,
      clientMsgId: "cmid-1",
      text,
      spec: s,
      deliver: () => api.sendMessage(WS, CH, "cmid-1", text),
    });

  it("sends the message, then signs the RETURNED message id, then posts the spawn — in that order", async () => {
    const order: string[] = [];
    api.sendMessage.mockImplementation(async () => {
      order.push("send");
      return committed();
    });
    const { signed } = recordingSigner();
    const signer: HumanControlSigner = {
      async sign(control) {
        order.push("sign");
        signed.push(control);
        return signature;
      },
    };
    api.postWorkSpawn.mockImplementation(async () => {
      order.push("spawn");
      return { workControl: { id: "ctl-1", status: "dispatched" }, replayed: false };
    });
    const result = await run(spec({ signer }));
    expect(order).toEqual(["send", "sign", "spawn"]);
    expect(signed).toHaveLength(1);
    const content = signed[0]!.content as Record<string, unknown>;
    expect(content).toMatchObject({
      kind: "spawn_task",
      originMessageId: MSG,
      agentMemberId: "agent-my-claude",
      folderId: FOLDER,
      tool: "claude",
      channelId: CH,
    });
    expect(signed[0]!.hostId).toBe(HOST);
    expect(content.prompt).toBe("빌드가 왜 깨지는지 봐 줘");
    expect(api.postWorkSpawn).toHaveBeenCalledTimes(1);
    expect(result.call).toMatchObject({ state: "called", replayed: false, controlId: "ctl-1" });
  });

  it("a browser has no signing key: the message goes, nothing is signed or posted, and it says where to call from", async () => {
    const result = await run(spec({ signer: null, host: null }));
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.postWorkSpawn).not.toHaveBeenCalled();
    expect(result.call).toMatchObject({ state: "message_only", reason: "no_signer", text: CALL_NEEDS_APP_LINE });
  });

  it("no Mac registered: the message goes and the sentence says so; nothing is signed", async () => {
    const { signer, signed } = recordingSigner();
    const result = await run(spec({ signer, host: null }));
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(signed).toHaveLength(0);
    expect(api.postWorkSpawn).not.toHaveBeenCalled();
    expect(result.call).toMatchObject({ state: "not_delivered", text: NO_MAC_LINE, signed: null });
  });

  it("the Mac is off: 「내 맥이 꺼져 있어요」, and the SAME signed body is resent — no second sign, no second message", async () => {
    api.postWorkSpawn.mockRejectedValueOnce(new ApiError(409, "offline", "work_host_offline"));
    const { signer, signed } = recordingSigner();
    const result = await run(spec({ signer }));
    expect(result.call.state).toBe("not_delivered");
    if (result.call.state !== "not_delivered") throw new Error("unreachable");
    expect(result.call.text).toBe(CALL_MAC_OFF_LINE);
    expect(result.call.signed).not.toBeNull();
    const firstBody = api.postWorkSpawn.mock.calls[0]![1];
    const again = await resendPersonalAgentCall(WS, result.call.signed!);
    expect(again).toMatchObject({ state: "called" });
    expect(api.postWorkSpawn).toHaveBeenCalledTimes(2);
    expect(api.postWorkSpawn.mock.calls[1]![1]).toEqual(firstBody);
    expect(signed).toHaveLength(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("the server has signed spawns off: the flag line, no retry (the same body would be refused again)", async () => {
    api.postWorkSpawn.mockRejectedValueOnce(new ApiError(403, "off", "signed_spawn_disabled"));
    const result = await run(spec());
    expect(result.call).toMatchObject({ state: "not_delivered", text: FLAG_OFF_LINE, signed: null });
  });

  it("a flag known to be off skips the Touch ID prompt but the message still goes", async () => {
    const result = await run(spec({ signer: flagOffSigner() }));
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.postWorkSpawn).not.toHaveBeenCalled();
    expect(result.call).toMatchObject({ state: "not_delivered", stage: "sign", text: FLAG_OFF_LINE, signed: null });
  });

  it("a message that cannot be sent throws before anything is signed", async () => {
    api.sendMessage.mockRejectedValueOnce(new ApiError(500, "down"));
    const { signer, signed } = recordingSigner();
    await expect(run(spec({ signer }))).rejects.toBeInstanceOf(ApiError);
    expect(signed).toHaveLength(0);
    expect(api.postWorkSpawn).not.toHaveBeenCalled();
  });
});
