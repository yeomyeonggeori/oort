import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import vectors from "../../../../../docs/api/human-control-signing-v2.vectors.json";
import instructionGolden from "../../../../../docs/api/work-instruction.golden.json";
import { SignerRefusal, type ControlToSign } from "@momo/core/features/auth/signedControl";
import { humanSignatureRequestBody } from "@momo/core/lib/api";
import {
  desktopSigner,
  desktopSignerRefusal,
  envelopeFromShell,
  shellControlRequest,
  STATEMENT_LIFETIME_MS,
} from "./signedWork";

// #3028 R2-E8 — the desktop app's half of the cross test.
//
//   v2 vectors (docs/api, #3027)  →  ControlToSign (what the shared core flow asks)
//     →  shellControlRequest (this file, TS)  →  __fixtures__/desktop-sign-requests.json
//     →  Rust `payload::ControlRequest` + `control_bytes`  →  the vector's payload bytes
//
// This test holds the first two arrows (TS output == the committed fixture);
// `clients/desktop/src-tauri/src/device_key/payload/tests.rs`
// `the_webviews_requests_build_the_v2_vector_bytes` holds the last one. The phone
// builds the same ControlToSign into the same bytes in
// `clients/mobile/__tests__/humanControl.test.ts`.

type VectorCase = (typeof vectors.cases)[number];
type Content = Record<string, string>;

const FIXTURE = resolve(__dirname, "__fixtures__/desktop-sign-requests.json");

function controlOf(c: VectorCase): ControlToSign {
  const f = c.fields as unknown as Record<string, string | number>;
  const k = c.content as unknown as Content;
  const content: ControlToSign["content"] =
    k.kind === "input"
      ? { kind: "input", mode: k.mode as "queue" | "interrupt", text: k.text! }
      : k.kind === "permission"
        ? {
            kind: "permission",
            requestEventId: k.request_event_id!,
            optionId: k.option_id!,
            optionKind: k.option_kind!,
            scope: k.scope as "once" | "session",
          }
        : {
            kind: "spawn",
            agentMemberId: k.agent_member_id!,
            folderId: k.folder_id!,
            tool: k.tool!,
            channelId: k.channel_id!,
            firstPrompt: k.first_prompt!,
          };
  return {
    hostId: String(f.host_id),
    sessionId: typeof f.session_id === "string" ? f.session_id : null,
    nonce: String(f.nonce),
    content,
  };
}

/** The kinds a person signs from the app (bundle/host_register are not wired). */
const APP_CASES = vectors.cases.filter(
  (c) => c.schema === "momo.human.control.v2" && ["input", "permission", "spawn"].includes((c.content as unknown as Content).kind!)
);

function requests() {
  return APP_CASES.map((c) => {
    const f = c.fields as unknown as Record<string, string | number>;
    return {
      name: c.name,
      signer: { workspaceId: f.workspace_id, memberId: f.member_id, keyId: f.device_key_id },
      request: shellControlRequest(
        String(f.workspace_id),
        String(f.instance_id),
        controlOf(c),
        Number(f.issued_at_ms),
        Number(f.expires_at_ms)
      ),
      payload: c.payload,
    };
  });
}

describe("desktop sign requests ↔ v2 vectors (cross test with the Rust shell)", () => {
  it("covers input (queue, interrupt), permission (session), spawn and a resume", () => {
    expect(APP_CASES.map((c) => c.name).sort()).toEqual(
      [
        "control_v2_input_interrupt",
        "control_v2_input_queue_nfc",
        "control_v2_permission_session",
        "control_v2_spawn",
        "control_v2_spawn_resume",
      ].sort()
    );
  });

  it("the requests the page hands the shell are the committed fixture", () => {
    const now = requests();
    // Regenerate only on purpose; a missing fixture is a failure, not a rewrite.
    if (process.env.UPDATE_SIGN_FIXTURE === "1") {
      writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`);
    }
    expect(now).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
  });
});

describe("desktopSigner", () => {
  const control = controlOf(APP_CASES.find((c) => c.name === "control_v2_input_queue_nfc")!);
  const context = {
    instanceId: "inst_01J9Z6T3QK8Y2W5N7M4R0P1XAB",
    serverTimeMs: 1_790_550_000_000,
    maxLifetimeMs: 600_000,
    maxClockSkewMs: 300_000,
    humanControlSignatureRequired: true,
    hostRegisterSignatureRequired: false,
  };

  it("echoes the instance id, corrects this Mac's clock by the server's, and returns only the server's keys", async () => {
    const sign = vi.fn(async () => ({
      deviceKeyId: "00000000-0000-7000-8000-00000000d001",
      devicePublicKey: "A2sX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKW",
      signature: "sig",
      payloadSha256: "00",
    }));
    // This Mac runs 7 minutes fast: without correction the server would refuse.
    const local = context.serverTimeMs + 7 * 60_000;
    const signer = desktopSigner("00000000-0000-7000-8000-000000000001", {
      context: async () => context,
      sign,
      now: () => local,
    });
    const envelope = await signer.sign(control);
    const request = (sign.mock.calls[0] as unknown as [ReturnType<typeof shellControlRequest>])[0];
    expect(request.instanceId).toBe(context.instanceId);
    expect(request.issuedAtMs).toBe(context.serverTimeMs);
    expect(request.expiresAtMs - request.issuedAtMs).toBe(STATEMENT_LIFETIME_MS);
    const golden = instructionGolden.cases.find((c) => c.name === "queue")!.body.humanSignature!;
    expect(Object.keys(envelope).sort()).toEqual(Object.keys(golden).sort());
    expect(humanSignatureRequestBody(envelope)).toEqual(envelope);
    expect(envelope).toMatchObject({ nonce: control.nonce, mode: "queue", signature: "sig" });
  });

  it.each([
    ["device_key_declined", true],
    ["device_key_cancelled", true],
    ["device_key_not_root_here", false],
    ["device_key_unsigned_build", false],
    ["device_key_payload_rejected: text: hidden character", false],
    ["something new", false],
  ])("the shell's %s becomes a sentence (cancelled=%s), never the code", async (code, cancelled) => {
    const signer = desktopSigner("ws", {
      context: async () => context,
      sign: async () => {
        throw code;
      },
      now: () => context.serverTimeMs,
    });
    const error = await signer.sign(control).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignerRefusal);
    expect((error as SignerRefusal).cancelled).toBe(cancelled);
    expect((error as SignerRefusal).message).not.toContain("device_key");
    expect((error as SignerRefusal).message).toMatch(/요\.$/);
    expect(desktopSignerRefusal(code).message).toBe((error as SignerRefusal).message);
  });

  it("a permission envelope carries its scope, a spawn its agent and folder", () => {
    const perm = controlOf(APP_CASES.find((c) => c.name === "control_v2_permission_session")!);
    expect(envelopeFromShell(perm, { deviceKeyId: "k", signature: "s" }, 1, 2)).toEqual({
      deviceKeyId: "k",
      nonce: perm.nonce,
      issuedAtMs: 1,
      expiresAtMs: 2,
      signature: "s",
      scope: "session",
    });
    const spawn = controlOf(APP_CASES.find((c) => c.name === "control_v2_spawn_resume")!);
    expect(Object.keys(envelopeFromShell(spawn, { deviceKeyId: "k", signature: "s" }, 1, 2)).sort()).toEqual(
      ["agentMemberId", "deviceKeyId", "expiresAtMs", "folderId", "issuedAtMs", "nonce", "signature"].sort()
    );
  });
});
