import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import decisionGolden from "../../../../../../docs/api/work-permission-decision.golden.json";
import instructionGolden from "../../../../../../docs/api/work-instruction.golden.json";
import { ApiError, type HumanSignatureRequest } from "@momo/core/lib/api";
import { installCoreHost, resetCoreHost } from "@momo/core/runtime/host";
import { permissionFailure, permissionSentLine, rejectWithInstructionLine } from "@momo/core/features/workbench/agentPane";
import {
  DEFAULT_FOLDER_ID,
  NOT_DELIVERED,
  rejectWithInstruction,
  SCOPE_UNSUPPORTED_LINE,
  signedAllow,
  signedInstruction,
  signedResume,
  SignerRefusal,
  type ControlToSign,
  type HumanControlSigner,
} from "@momo/core/features/auth/signedControl";

// #3028 R2-E8. The envelopes the apps send, held against the server's goldens
// (`docs/api/work-instruction.golden.json`, `work-permission-decision.golden.json`,
// #3027) — the server's `HumanSignatureRequest` is `deny_unknown_fields`, so an
// extra key from a signer is a 400 on every signed request.

type Golden = {
  cases: Array<{ name: string; body: Record<string, unknown>; status: number; code?: string }>;
};
const INSTRUCTION = instructionGolden as unknown as Golden;
const DECISION = decisionGolden as unknown as Golden;
const caseOf = (g: typeof INSTRUCTION, name: string) => g.cases.find((c) => c.name === name)!;

const WS = "00000000-0000-7000-8000-000000000001";
const SESSION = {
  id: "00000000-0000-7000-8000-00000000c001",
  hostId: "00000000-0000-7000-8000-00000000f001",
  label: "flaky 시험 고치기",
  tool: "codex",
  channelId: "00000000-0000-7000-8000-00000000cc01",
};

/** A signer that records what it was asked and answers with a phone-shaped
 * envelope carrying the extra keys real signers carry (`schema`,
 * `devicePublicKey`, `payloadSha256`). */
function recordingSigner(fail?: Error) {
  const asked: ControlToSign[] = [];
  const signer: HumanControlSigner = {
    async sign(control) {
      asked.push(control);
      if (fail) throw fail;
      const envelope = {
        schema: "momo.human.control.v2",
        devicePublicKey: "A2sX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKW",
        payloadSha256: "ab".repeat(32),
        deviceKeyId: "00000000-0000-7000-8000-00000000d001",
        nonce: control.nonce,
        issuedAtMs: 1_790_550_000_000,
        expiresAtMs: 1_790_550_120_000,
        signature: "sig",
        ...(control.content.kind === "input" ? { mode: control.content.mode } : {}),
        ...(control.content.kind === "permission" ? { scope: control.content.scope } : {}),
        ...(control.content.kind === "spawn"
          ? { agentMemberId: control.content.agentMemberId, folderId: control.content.folderId }
          : {}),
      };
      return envelope as unknown as HumanSignatureRequest;
    },
  };
  return { signer, asked };
}

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

let calls: Call[] = [];
let answers: Array<(call: Call) => Response> = [];

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function refuse(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code, message: "server words" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
  answers = [];
  installCoreHost({
    apiBase: () => "https://oort.test",
    absoluteApiBase: () => "https://oort.test",
    buildMode: () => "test",
    session: {
      getAccessToken: () => "access-token",
      getRefreshToken: () => null,
      getPersistedSession: () => null,
      applyLogin: () => {},
      applyRotation: () => {},
      markAuthExpired: () => {},
      clearSession: () => {},
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const call = {
        method: init.method ?? "GET",
        path: new URL(url).pathname,
        body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      };
      calls.push(call);
      const answer = answers.shift();
      return answer ? answer(call) : ok({});
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetCoreHost();
});

const keys = (value: unknown) => Object.keys(value as object).sort();
const PERMISSION_PATH = `/v1/workspaces/${WS}/work-sessions/${SESSION.id}/permission-decisions`;
const INSTRUCTION_PATH = `/v1/workspaces/${WS}/work-sessions/${SESSION.id}/instructions`;

describe("signed instruction (golden work-instruction `queue`)", () => {
  it("sends exactly the golden body: clientMsgId = nonce, signed mode, NFC text", async () => {
    const { signer, asked } = recordingSigner();
    answers.push(() => ok({ workControl: { id: "c", status: "dispatched" }, message: {}, replayed: false }, 201));
    const decomposed = "café 리팩터";
    const out = await signedInstruction({ workspaceId: WS, session: SESSION, text: decomposed, mode: "interrupt", signer });
    expect(out).toEqual({ state: "sent" });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.method).toBe("POST");
    expect(call!.path).toBe(INSTRUCTION_PATH);
    const expected = caseOf(INSTRUCTION, "queue").body;
    expect(keys(call!.body)).toEqual(keys(expected));
    expect(keys(call!.body.humanSignature)).toEqual(keys(expected.humanSignature));
    const sig = call!.body.humanSignature as Record<string, unknown>;
    expect(call!.body.clientMsgId).toBe(sig.nonce);
    expect(sig.nonce).toBe(asked[0]!.nonce);
    expect(call!.body.mode).toBe("interrupt");
    expect(sig.mode).toBe("interrupt");
    expect(call!.body.text).toBe(decomposed.normalize("NFC"));
    // What was signed is what was sent, on this session and its host.
    expect(asked[0]).toMatchObject({
      hostId: SESSION.hostId,
      sessionId: SESSION.id,
      content: { kind: "input", mode: "interrupt", text: decomposed.normalize("NFC") },
    });
  });

  it("a cancelled signature is 「전달 안 됨」 and nothing is sent — not even as chat", async () => {
    const { signer } = recordingSigner(new SignerRefusal("서명을 취소해서 보내지 않았어요.", true));
    const out = await signedInstruction({ workspaceId: WS, session: SESSION, text: "테스트", mode: "queue", signer });
    expect(out).toMatchObject({ state: "not_delivered", stage: "sign", text: "서명을 취소해서 보내지 않았어요." });
    expect(calls).toEqual([]);
  });

  it.each([
    [409, "work_host_offline", "호스트"],
    [403, "signed_instructions_disabled", "서버"],
    [403, "device_key_not_endorsed", "승인"],
    [409, "device_nonce_replayed", "같은 서명"],
  ])("a server refusal %s %s is 「전달 안 됨」 with its own sentence", async (status, code, word) => {
    const { signer } = recordingSigner();
    answers.push(() => refuse(status, code));
    const out = await signedInstruction({ workspaceId: WS, session: SESSION, text: "테스트", mode: "queue", signer });
    expect(out.state).toBe("not_delivered");
    if (out.state !== "not_delivered") return;
    expect(out.stage).toBe("server");
    expect(out.text).toContain(word);
    expect(out.text).not.toContain(code);
    // Exactly one request: never re-sent unsigned, never posted as a message.
    expect(calls.map((c) => c.path)).toEqual([INSTRUCTION_PATH]);
  });

  it("names the state 「전달 안 됨」", () => {
    expect(NOT_DELIVERED).toBe("전달 안 됨");
    expect(rejectWithInstructionLine(false, "x")).toContain(NOT_DELIVERED);
  });
});

describe("signed allow (golden work-permission-decision `session_scope_signed`)", () => {
  it.each(["once", "session"] as const)("scope %s: the golden keys, the stored option, the signed scope", async (scope) => {
    const { signer, asked } = recordingSigner();
    answers.push(() => ok({ permissionRequest: { id: "p", status: "approved" } }));
    await signedAllow({
      workspaceId: WS,
      session: SESSION,
      requestEventId: "00000000-0000-4000-8000-00000000e001",
      optionId: "allow-once",
      scope,
      signer,
    });
    const [call] = calls;
    expect(call!.path).toBe(PERMISSION_PATH);
    const expected = caseOf(DECISION, "session_scope_signed").body;
    expect(keys(call!.body)).toEqual(keys(expected));
    expect(keys(call!.body.humanSignature)).toEqual(keys(expected.humanSignature));
    expect(call!.body).toMatchObject({ kind: "allow_once", optionId: "allow-once" });
    expect((call!.body.humanSignature as { scope: string }).scope).toBe(scope);
    expect(asked[0]!.content).toEqual({
      kind: "permission",
      requestEventId: "00000000-0000-4000-8000-00000000e001",
      optionId: "allow-once",
      optionKind: "allow_once",
      scope,
    });
    expect(call!.body).not.toHaveProperty("instruction");
  });

  it("a cancelled signature sends no decision", async () => {
    const { signer } = recordingSigner(new SignerRefusal("취소", true));
    await expect(
      signedAllow({ workspaceId: WS, session: SESSION, requestEventId: "e", optionId: "o", scope: "once", signer })
    ).rejects.toBeInstanceOf(SignerRefusal);
    expect(calls).toEqual([]);
    expect(permissionFailure(new SignerRefusal("취소", true))).toEqual({ closed: false, text: "취소" });
  });

  it("400 permission_scope_unsupported keeps the card open and says to send 「이번 한 번」", () => {
    const golden = caseOf(DECISION, "session_scope_signed");
    const failure = permissionFailure(new ApiError(golden.status, "", golden.code));
    expect(failure).toEqual({ closed: false, text: SCOPE_UNSUPPORTED_LINE });
  });

  it("the sent line says which scope went", () => {
    expect(permissionSentLine("allow_once", "session")).toContain("이 세션 동안");
    expect(permissionSentLine("allow_once")).toContain("이번 한 번");
  });
});

describe("「거부 + 지시」 = unsigned reject + signed input (ADR-0146 개정 D-8)", () => {
  const args = (signer: HumanControlSigner) => ({
    workspaceId: WS,
    session: SESSION,
    requestEventId: "00000000-0000-4000-8000-00000000e001",
    optionId: "reject-once",
    text: "공개키 대신 key id로 해 줘",
    signer,
  });

  it("signs first, then rejects without `instruction`, then sends the signed input", async () => {
    const { signer, asked } = recordingSigner();
    answers.push(() => ok({ permissionRequest: { id: "p", status: "rejected" } }));
    answers.push(() => ok({ workControl: { id: "c", status: "dispatched" }, message: {}, replayed: false }, 201));
    const out = await rejectWithInstruction(args(signer));
    expect(out).toEqual({ state: "rejected", instruction: { state: "sent" } });
    expect(calls.map((c) => c.path)).toEqual([PERMISSION_PATH, INSTRUCTION_PATH]);
    // The route's 400 `permission_instruction_unsupported` is never provoked.
    expect(keys(calls[0]!.body)).toEqual(keys(caseOf(DECISION, "owner_allow_once").body));
    expect(calls[0]!.body).toMatchObject({ kind: "reject_once", optionId: "reject-once" });
    expect(calls[1]!.body).toMatchObject({ text: "공개키 대신 key id로 해 줘", mode: "queue" });
    expect(calls[1]!.body.clientMsgId).toBe(asked[0]!.nonce);
    expect(asked).toHaveLength(1);
  });

  it("a cancelled signature sends nothing — not even the reject", async () => {
    const { signer } = recordingSigner(new SignerRefusal("취소했어요.", true));
    const out = await rejectWithInstruction(args(signer));
    expect(out).toMatchObject({ state: "not_sent", text: "취소했어요." });
    expect(calls).toEqual([]);
  });

  it("when only the instruction fails, the reject stands and the instruction is 「전달 안 됨」", async () => {
    const { signer } = recordingSigner();
    answers.push(() => ok({ permissionRequest: { id: "p", status: "rejected" } }));
    answers.push(() => refuse(409, "work_host_offline"));
    const out = await rejectWithInstruction(args(signer));
    expect(out.state).toBe("rejected");
    if (out.state !== "rejected") return;
    expect(out.instruction.state).toBe("not_delivered");
    if (out.instruction.state !== "not_delivered") return;
    const line = rejectWithInstructionLine(false, out.instruction.text);
    expect(line).toContain("거부는 보냈어요");
    expect(line).toContain("전달 안 됨");
    expect(line).toContain("호스트");
  });

  it("a refused reject stops before the instruction", async () => {
    const { signer } = recordingSigner();
    answers.push(() => refuse(409, "permission_request_closed"));
    const out = await rejectWithInstruction(args(signer));
    expect(out.state).toBe("reject_failed");
    expect(calls.map((c) => c.path)).toEqual([PERMISSION_PATH]);
  });
});

describe("signed resume (ADR-0146 증보 E7 「서명 재개」)", () => {
  it("names the successor, signs a v2 spawn over the source's label·tool·channel, sends both together", async () => {
    const { signer, asked } = recordingSigner();
    answers.push(() => ok({ workSession: { id: "new" } }));
    await signedResume({
      workspaceId: WS,
      session: SESSION,
      targetHostId: "00000000-0000-7000-8000-00000000f002",
      agentMemberId: "00000000-0000-7000-8000-000000000a01",
      signer,
    });
    const [call] = calls;
    expect(call!.path).toBe(`/v1/workspaces/${WS}/work-sessions/${SESSION.id}/resume`);
    expect(keys(call!.body)).toEqual(["humanSignature", "sessionId", "targetHostId"]);
    expect(call!.body.sessionId).toBe(asked[0]!.sessionId);
    expect(asked[0]).toMatchObject({
      hostId: "00000000-0000-7000-8000-00000000f002",
      content: {
        kind: "spawn",
        tool: SESSION.tool,
        channelId: SESSION.channelId,
        firstPrompt: SESSION.label,
        folderId: DEFAULT_FOLDER_ID,
      },
    });
    expect(keys(call!.body.humanSignature)).toEqual(
      ["agentMemberId", "deviceKeyId", "expiresAtMs", "folderId", "issuedAtMs", "nonce", "signature"].sort()
    );
  });
});
