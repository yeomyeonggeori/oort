import { describe, expect, it } from "vitest";
import type { WorkHost } from "./api";
import {
  asWorkHostNotice,
  thisMacErrorMessage,
  thisMacState,
  workHostNoticeChannelName,
  workHostNoticeText,
  type LocalWorkHostStatus,
} from "./thisMacHost";

const WS = "0f8fad5b-d9cb-469f-a165-70867728950e";
const HOST = "019a0000-0000-7000-8000-00000000abcd";
const ORIGIN = "https://oort-team.example";

function local(over: Partial<LocalWorkHostStatus> = {}): LocalWorkHostStatus {
  return {
    sidecar: true,
    registered: {
      hostId: HOST,
      workspaceId: WS,
      ownerMemberId: "m1",
      serverUrl: ORIGIN,
    },
    running: true,
    heartbeat: { lastOkAtMs: 1_000, failing: false },
    adapters: [{ key: "claude", executable: "/opt/bin/claude-agent-acp", found: true }],
    workFolder: "/Users/sj/oort-work",
    displayNameSuggestion: "sj-mac",
    ...over,
  };
}

function row(over: Partial<WorkHost> = {}): WorkHost {
  return {
    id: HOST.toUpperCase(),
    workspaceId: WS,
    scope: "member",
    ownerMemberId: "m1",
    type: "workd",
    displayName: "성재 맥북",
    publicKey: "PK",
    capabilities: {},
    createdAtMs: 1,
    online: true,
    lastSeenAtMs: 900,
    ...over,
  };
}

describe("thisMacState — 등록됐지만 오프라인 vs 아직 없음 (#2778)", () => {
  it("never registered is not_registered, and says whether it can be", () => {
    expect(thisMacState(local({ registered: null }), [], WS, ORIGIN)).toEqual({
      kind: "not_registered",
      ready: true,
    });
    expect(
      thisMacState(
        local({ registered: null, adapters: [{ key: "claude", executable: "claude-agent-acp", found: false }] }),
        [],
        WS,
        ORIGIN
      )
    ).toEqual({ kind: "not_registered", ready: false });
  });

  it("registered but stopped is offline, never not_registered", () => {
    const state = thisMacState(local({ running: false, heartbeat: null }), [row({ online: false })], WS, ORIGIN);
    expect(state).toEqual({ kind: "offline", reason: "stopped", lastSeenAtMs: 900 });
  });

  it("running but not reaching the server is offline with its reason", () => {
    const state = thisMacState(
      local({ heartbeat: { lastOkAtMs: null, failing: true } }),
      [row({ online: false })],
      WS,
      ORIGIN
    );
    expect(state).toEqual({ kind: "offline", reason: "not_reaching_server", lastSeenAtMs: 900 });
  });

  it("online is the server's word, or the local heartbeat before the list answers", () => {
    expect(thisMacState(local(), [row()], WS, ORIGIN)).toEqual({ kind: "online" });
    expect(thisMacState(local(), undefined, WS, ORIGIN)).toEqual({ kind: "online" });
    expect(
      thisMacState(local({ heartbeat: null }), undefined, WS, ORIGIN).kind
    ).toBe("offline");
  });

  it("a revoked or vanished row is revoked, whatever the local process says", () => {
    expect(thisMacState(local(), [row({ revokedAtMs: 5 })], WS, ORIGIN)).toEqual({ kind: "revoked" });
    expect(thisMacState(local(), [], WS, ORIGIN)).toEqual({ kind: "revoked" });
  });

  it("another workspace or server is elsewhere", () => {
    expect(thisMacState(local(), [row()], "11111111-1111-1111-1111-111111111111", ORIGIN).kind).toBe("elsewhere");
    expect(thisMacState(local(), [row()], WS, "https://other.example").kind).toBe("elsewhere");
  });

  it("no sidecar wins over everything", () => {
    expect(thisMacState(local({ sidecar: false }), [row()], WS, ORIGIN)).toEqual({ kind: "no_sidecar" });
  });
});

describe("owner notices (ADR-0188 D2)", () => {
  it("channel is the owner's user-limited channel, uppercase like the token sub", () => {
    expect(workHostNoticeChannelName("ab-cd")).toBe("user:work-host#AB-CD");
  });

  it("parses the server frame and nothing else", () => {
    const frame = {
      type: "work_host.registered",
      v: 1,
      ts: 1,
      payload: {
        workspace_id: WS,
        host_id: HOST,
        display_name: "성재 맥북",
        host_type: "workd",
        scope: "member",
        actor_member_id: "m1",
      },
    };
    expect(asWorkHostNotice(frame)).toEqual({
      type: "work_host.registered",
      hostId: HOST,
      workspaceId: WS,
      displayName: "성재 맥북",
      actorMemberId: "m1",
    });
    expect(asWorkHostNotice({ ...frame, type: "message.new" })).toBeNull();
    expect(asWorkHostNotice({ ...frame, payload: { host_id: HOST } })).toBeNull();
    expect(asWorkHostNotice(null)).toBeNull();
  });

  it("a registration always tells the owner how to undo one they did not make", () => {
    const text = workHostNoticeText(
      { type: "work_host.registered", hostId: HOST, workspaceId: WS, displayName: "누군가의 박스", actorMemberId: "m1" },
      "m1"
    );
    expect(text.title).toBe("작업 호스트가 등록되었습니다");
    expect(text.body).toContain("누군가의 박스");
    expect(text.body).toContain("해지하세요");
    const revoked = workHostNoticeText(
      { type: "work_host.revoked", hostId: HOST, workspaceId: WS, displayName: "박스", actorMemberId: "admin" },
      "m1"
    );
    expect(revoked.body).toContain("관리자가 해지했습니다");
  });

  it("every shell error code has its own sentence", () => {
    const codes = [
      "no_acp_adapter",
      "already_registered",
      "not_signed_in",
      "server_url_invalid",
      "display_name_invalid",
      "sidecar_missing",
      "timeout",
      "register_failed: momo-workd: registration failed: 401",
      "forget_failed",
      "unsupported_platform",
    ];
    const fallback = thisMacErrorMessage("something_else");
    const sentences = new Set(codes.map(thisMacErrorMessage));
    expect(sentences.size).toBe(codes.length);
    for (const code of codes) expect(thisMacErrorMessage(code)).not.toBe(fallback);
    for (const s of sentences) expect(s).not.toMatch(/[—–]/);
  });
});
