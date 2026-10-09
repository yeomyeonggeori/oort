import { describe, expect, it } from "vitest";
import vectors from "./__fixtures__/human-control-signing-v4.vectors.json";
import {
  SpawnTaskInputError,
  sha256HexOfUtf8 as sha256Hex,
  spawnLabelText,
  spawnPromptText,
  spawnTaskContentText,
  spawnTaskPayloadText,
  type SpawnTaskContent,
  type SpawnTaskFields,
} from "./humanControlV4";


interface Case {
  name: string;
  fields: {
    instance_id: string;
    workspace_id: string;
    member_id: string;
    device_key_id: string;
    host_id: string;
    nonce: string;
    issued_at_ms: number;
    expires_at_ms: number;
  };
  content: {
    agent_member_id: string | null;
    folder_id: string;
    tool: string;
    channel_id: string;
    thread_root_id: string | null;
    origin_message_id: string | null;
    label: string;
    prompt: string;
  };
  content_canonical: string;
  content_sha256: string;
  payload: string;
  payload_sha256: string;
}

function fieldsOf(tc: Case): SpawnTaskFields {
  return {
    instanceId: tc.fields.instance_id,
    workspaceId: tc.fields.workspace_id,
    memberId: tc.fields.member_id,
    deviceKeyId: tc.fields.device_key_id,
    hostId: tc.fields.host_id,
    nonce: tc.fields.nonce,
    issuedAtMs: tc.fields.issued_at_ms,
    expiresAtMs: tc.fields.expires_at_ms,
  };
}

function contentOf(tc: Case): SpawnTaskContent {
  return {
    agentMemberId: tc.content.agent_member_id,
    folderId: tc.content.folder_id,
    tool: tc.content.tool,
    channelId: tc.content.channel_id,
    threadRootId: tc.content.thread_root_id,
    originMessageId: tc.content.origin_message_id,
    label: tc.content.label,
    prompt: tc.content.prompt,
  };
}

const cases = vectors.cases as unknown as Case[];

describe("momo.human.control.v4 (#3592) — the shared vectors", () => {
  it("has the four cases momo-wire rebuilds", () => {
    expect(cases.map((tc) => tc.name)).toEqual([
      "control_v4_spawn_personal_agent_in_thread",
      "control_v4_spawn_personal_agent_main_line",
      "control_v4_spawn_harness_without_agent",
      "control_v4_spawn_nfd_text_signs_as_nfc",
    ]);
  });

  for (const tc of cases) {
    it(`${tc.name}: the core builds the same bytes momo-wire does`, () => {
      expect(spawnTaskContentText(contentOf(tc))).toBe(tc.content_canonical);
      expect(sha256Hex(spawnTaskContentText(contentOf(tc)))).toBe(tc.content_sha256);
      const payload = spawnTaskPayloadText(fieldsOf(tc), contentOf(tc));
      expect(payload).toBe(tc.payload);
      expect(sha256Hex(payload)).toBe(tc.payload_sha256);
    });
  }

  it("signs the NFC form of what a person typed (decomposed text)", () => {
    const tc = cases.find((c) => c.name === "control_v4_spawn_nfd_text_signs_as_nfc")!;
    expect(tc.content.prompt).not.toBe(tc.content.prompt.normalize("NFC"));
    expect(tc.content.label).not.toBe(tc.content.label.normalize("NFC"));
    const body = spawnTaskContentText(contentOf(tc)).split("\n");
    expect(body[6]).toBe(tc.content.label.normalize("NFC"));
    expect(body[7]).toBe(tc.content.prompt.normalize("NFC"));
  });

  it("an absent agent, thread or origin is `-`, never a made-up id", () => {
    const tc = cases.find((c) => c.name === "control_v4_spawn_harness_without_agent")!;
    const lines = spawnTaskContentText(contentOf(tc)).split("\n");
    expect(lines[0]).toBe("-");
    expect(lines[4]).toBe("-");
    expect(lines[5]).toBe("-");
  });

  it("changing any one signed field changes the bytes", () => {
    const tc = cases[0]!;
    const base = spawnTaskPayloadText(fieldsOf(tc), contentOf(tc));
    const edits: Array<Partial<SpawnTaskContent>> = [
      { agentMemberId: null },
      { folderId: "fld_other" },
      { tool: "codex" },
      { channelId: "00000000-0000-7000-8000-00000000cc02" },
      { threadRootId: null },
      { originMessageId: null },
      { label: "다른 제목" },
      { prompt: "다른 프롬프트" },
    ];
    for (const edit of edits) {
      expect(spawnTaskPayloadText(fieldsOf(tc), { ...contentOf(tc), ...edit })).not.toBe(base);
    }
  });

  it("refuses what the server would refuse, before anything is signed", () => {
    const tc = cases[0]!;
    const content = contentOf(tc);
    const bad: Array<Partial<SpawnTaskContent>> = [
      { folderId: "" },
      { folderId: "fld\nx" },
      { label: " 앞뒤 공백 " },
      { label: "두\n줄" },
      { label: "" },
      { label: "가".repeat(121) },
      { prompt: "" },
      { prompt: "   " },
      { prompt: "/clear" },
      { prompt: "a\u0000b" },
      { prompt: "가".repeat(32_769) },
    ];
    for (const edit of bad) {
      expect(() => spawnTaskContentText({ ...content, ...edit }), JSON.stringify(edit).slice(0, 40)).toThrow(
        SpawnTaskInputError
      );
    }
    expect(() =>
      spawnTaskPayloadText({ ...fieldsOf(tc), expiresAtMs: fieldsOf(tc).issuedAtMs }, content)
    ).toThrow(SpawnTaskInputError);
    expect(() => spawnLabelText("정상 제목")).not.toThrow();
    expect(spawnPromptText("줄 하나\n줄 둘\t탭")).toBe("줄 하나\n줄 둘\t탭");
  });
});
