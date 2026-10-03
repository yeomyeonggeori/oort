import { describe, expect, it, vi } from "vitest";
import { parseSlashCommand, slashCandidates, slashCommandById } from "./slash";
import type { CommandContext } from "./registry";

const WITH_CARD = { cardAvailable: true } as const;
const labels = (query: string) =>
  slashCandidates(query, undefined, undefined, WITH_CARD).map((row) => row.label);

describe("슬래시 후보 (#2942 GC-1)", () => {
  it("`/`만 치면 레지스트리의 client 명령과 그 인자가 선다", () => {
    expect(labels("")).toEqual(["/연결", "/연결 claude", "/연결 codex", "/연결 팀키"]);
  });

  it("앞머리로 고르고, 친 글자 수를 강조 길이로 준다(시안 `/연`)", () => {
    const rows = slashCandidates("연", undefined, undefined, WITH_CARD);
    expect(rows.map((row) => row.label)).toEqual([
      "/연결",
      "/연결 claude",
      "/연결 codex",
      "/연결 팀키",
    ]);
    expect(rows[0]).toMatchObject({
      commandId: "ai.connect",
      hint: "AI 연결 카드 열기 · 나에게만 보여요",
      icon: "ai-connect",
      args: {},
      matched: 2,
    });
    expect(rows[3]).toMatchObject({ icon: "credentials", args: { line: "team" } });
  });

  it("별칭으로 맞으면 줄 이름도 그 별칭이다", () => {
    expect(labels("con")[0]).toBe("/connect");
    expect(labels("AI")[0]).toBe("/ai");
  });

  it("이름 뒤 공백 하나 다음은 인자의 앞머리다", () => {
    expect(labels("연결 c")).toEqual(["/연결 claude", "/연결 codex"]);
    expect(labels("연결 팀")).toEqual(["/연결 팀키"]);
    expect(labels("connect team")).toEqual(["/connect 팀키"]);
    expect(labels("연결 ")).toEqual(["/연결", "/연결 claude", "/연결 codex", "/연결 팀키"]);
  });

  it("알 수 없는 /는 후보가 없다(평문)", () => {
    expect(labels("tmp/foo")).toEqual([]);
    expect(labels("shrug")).toEqual([]);
    expect(labels("연결 해 주세요")).toEqual([]);
    expect(labels("연결 gpt")).toEqual([]);
    expect(labels("연결\n다음 줄")).toEqual([]);
  });
});

describe("카드 자리가 없으면 폴백을 말한다 (design-review H-1)", () => {
  it("인자 줄을 명령당 한 줄로 접고 설정 이동을 말한다", () => {
    const rows = slashCandidates("연");
    expect(rows.map((row) => row.label)).toEqual(["/연결"]);
    expect(rows[0].hint).toBe("AI로 이동 · 메시지로 보내지 않아요");
    expect(rows[0].hint).not.toContain("나에게만");
    expect(rows[0].matched).toBe(2);
  });

  it("인자까지 친 질의도 명령 한 줄로 받는다", () => {
    expect(slashCandidates("연결 c").map((row) => row.label)).toEqual(["/연결"]);
    expect(slashCandidates("connect 팀").map((row) => row.label)).toEqual(["/connect"]);
    expect(slashCandidates("연결 gpt")).toEqual([]);
  });
});

describe("전송 직전 해석", () => {
  it("정확한 명령과 알려진 인자만 명령이다", () => {
    expect(parseSlashCommand("/연결")?.command.id).toBe("ai.connect");
    expect(parseSlashCommand("  /connect  ")?.args).toEqual({});
    expect(parseSlashCommand("/ai codex")?.args).toEqual({ line: "codex" });
    expect(parseSlashCommand("/연결 팀키")?.args).toEqual({ line: "team" });
    expect(parseSlashCommand("/연결 TEAM")?.args).toEqual({ line: "team" });
  });

  it("그 밖은 평문으로 보낸다", () => {
    for (const body of [
      "/연결 해 주세요",
      "/연결 gpt",
      "/연",
      "/tmp/foo 봐 주세요",
      "/",
      "연결",
      "hello /ai",
      "/연결\n두 줄",
    ]) {
      expect(parseSlashCommand(body)).toBeNull();
    }
  });

  it("해석한 명령을 실행하면 전송 대신 카드(없으면 설정)로 간다", () => {
    const parsed = parseSlashCommand("/연결 claude")!;
    const ctx = {
      navigate: vi.fn(),
      openCreateChannel: vi.fn(),
      openAgentProfile: vi.fn(),
      openLocalCard: vi.fn(() => false),
      session: { memberId: "m" },
      workspaceId: "w",
    } satisfies CommandContext;
    parsed.command.run(ctx, parsed.args);
    expect(ctx.openLocalCard).toHaveBeenCalledWith("ai.connect", { line: "claude" });
    expect(ctx.navigate).toHaveBeenCalledWith("/ai/accounts");
    expect(slashCommandById("ai.connect")?.id).toBe("ai.connect");
    expect(slashCommandById("nav.inbox")).toBeNull();
  });
});
