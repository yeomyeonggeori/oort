// ADR-0201 증보 v3 B3·B10 (#4945): 온보딩 「도우미 켜기」의 쓰기 순서와 실패 규칙.
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { defaultTeamAiRoles } from "./teamAiRoles";
import {
  newTeamAiSetupProgress,
  runTeamAiSetup,
  teamAiNameDraft,
  teamAiRenameErrorKind,
  TeamAiSetupError,
  type TeamAiSetupDeps,
} from "./teamAiSetup";
import { TEAM_AI_DEFAULT_NAME } from "./teamAiSwitch";

const WS = "00000000-0000-7000-8000-000000000001";
const HELPER = "00000000-0000-7000-8000-0000000000a1";

function deps() {
  const calls: string[] = [];
  const spies = {
    putDefaultAi: vi.fn(async (position: number) => {
      calls.push(`default_ai:${position}`);
      return {};
    }),
    patchRoles: vi.fn(async (_ws: string, change: unknown) => {
      calls.push(`roles:${JSON.stringify(change)}`);
      return {};
    }),
    enable: vi.fn(async () => {
      calls.push("enable");
      return { team_ai_fast_path: true, team_ai_agent_member_id: HELPER };
    }),
    rename: vi.fn(async (_ws: string, member: string, name: string) => {
      calls.push(`rename:${member}:${name}`);
      return {};
    }),
    readBag: vi.fn(async () => {
      calls.push("read");
      return { team_ai_alias_status: { oort: "registered" } };
    }),
  } satisfies TeamAiSetupDeps;
  return { calls, spies };
}

describe("온보딩 도우미 켜기: 쓰는 순서가 안전이다", () => {
  it("기본 AI → 역할(바뀐 칸만) → 켜기 → 이름 순서로 쓰고, 멤버 id로 이름을 바꾼다", async () => {
    const { calls, spies } = deps();
    const result = await runTeamAiSetup(
      { workspaceId: WS, linkPosition: 0, name: "  비서봇 ", roles: { ...defaultTeamAiRoles(), files: false, code: false } },
      newTeamAiSetupProgress(),
      spies
    );
    expect(calls).toEqual([
      "default_ai:0",
      `roles:${JSON.stringify({ files: false, code: false })}`,
      "enable",
      `rename:${HELPER}:비서봇`,
      "read",
    ]);
    expect(result).toMatchObject({ memberId: HELPER, renameError: null });
    expect(result.bag).toEqual({ team_ai_alias_status: { oort: "registered" } });
  });

  it("기본값 그대로(모두 켬·기본 이름)면 역할 PATCH와 이름 바꾸기를 부르지 않는다", async () => {
    const { calls, spies } = deps();
    await runTeamAiSetup(
      { workspaceId: WS, linkPosition: 0, name: TEAM_AI_DEFAULT_NAME, roles: defaultTeamAiRoles() },
      newTeamAiSetupProgress(),
      spies
    );
    expect(calls).toEqual(["default_ai:0", "enable", "read"]);
    expect(spies.patchRoles).not.toHaveBeenCalled();
    expect(spies.rename).not.toHaveBeenCalled();
  });

  it("역할을 못 쓰면 켜지 않는다. 다시 시도하면 끝난 단계는 건너뛴다", async () => {
    const { calls, spies } = deps();
    spies.patchRoles.mockRejectedValueOnce(new ApiError(503, "down"));
    const progress = newTeamAiSetupProgress();
    const input = { workspaceId: WS, linkPosition: 0, name: "비서봇", roles: { ...defaultTeamAiRoles(), memory: false } };
    const failure = await runTeamAiSetup(input, progress, spies).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TeamAiSetupError);
    expect((failure as TeamAiSetupError).step).toBe("roles");
    expect(spies.enable).not.toHaveBeenCalled();
    await runTeamAiSetup(input, progress, spies);
    expect(calls.filter((c) => c.startsWith("default_ai"))).toHaveLength(1);
    expect(spies.patchRoles).toHaveBeenCalledTimes(2);
    expect(spies.enable).toHaveBeenCalledTimes(1);
  });

  it("켜기가 실패한 뒤 끈 묶음을 도로 켜면 그 칸만 다시 쓴다. 달라진 것이 없으면 쓰지 않는다", async () => {
    const { calls, spies } = deps();
    spies.enable.mockRejectedValueOnce(new ApiError(503, "down"));
    const progress = newTeamAiSetupProgress();
    const off = { ...defaultTeamAiRoles(), memory: false };
    const failure = await runTeamAiSetup(
      { workspaceId: WS, linkPosition: 0, name: TEAM_AI_DEFAULT_NAME, roles: off },
      progress,
      spies
    ).catch((error: unknown) => error);
    expect((failure as TeamAiSetupError).step).toBe("enable");
    // 다시 시도하되 값이 그대로면 역할은 다시 쓰지 않는다.
    await runTeamAiSetup(
      { workspaceId: WS, linkPosition: 0, name: TEAM_AI_DEFAULT_NAME, roles: off },
      progress,
      spies
    );
    expect(spies.patchRoles).toHaveBeenCalledTimes(1);
    // 켜진 뒤의 재시도는 없지만, 같은 진행 기록으로 선택을 바꿔 다시 부르면 바뀐 칸만 간다.
    await runTeamAiSetup(
      { workspaceId: WS, linkPosition: 0, name: TEAM_AI_DEFAULT_NAME, roles: defaultTeamAiRoles() },
      progress,
      spies
    );
    expect(calls.filter((c) => c.startsWith("roles:"))).toEqual([
      `roles:${JSON.stringify({ memory: false })}`,
      `roles:${JSON.stringify({ memory: true })}`,
    ]);
  });

  it("이름이 거절돼도 켜기는 끝난 채 결과에 싣는다. 켜기가 실패하면 이름은 시도하지 않는다", async () => {
    const taken = new ApiError(409, "display name is already in use");
    const first = deps();
    first.spies.rename.mockRejectedValueOnce(taken);
    const result = await runTeamAiSetup(
      { workspaceId: WS, linkPosition: 0, name: "김하늘", roles: defaultTeamAiRoles() },
      newTeamAiSetupProgress(),
      first.spies
    );
    expect(result.renameError).toBe(taken);
    expect(teamAiRenameErrorKind(result.renameError)).toBe("taken");

    const second = deps();
    second.spies.enable.mockRejectedValueOnce(new ApiError(409, "unavailable", "team_ai_unavailable"));
    const failure = await runTeamAiSetup(
      { workspaceId: WS, linkPosition: 0, name: "비서봇", roles: defaultTeamAiRoles() },
      newTeamAiSetupProgress(),
      second.spies
    ).catch((error: unknown) => error);
    expect((failure as TeamAiSetupError).step).toBe("enable");
    expect(second.spies.rename).not.toHaveBeenCalled();
  });
});

describe("이름 입력과 거절 종류", () => {
  it("공백을 걷고 비면 저장할 수 없다. 100자까지다", () => {
    expect(teamAiNameDraft("  비서봇 ")).toEqual({ name: "비서봇", valid: true });
    expect(teamAiNameDraft("   ").valid).toBe(false);
    expect(teamAiNameDraft("가".repeat(100)).valid).toBe(true);
    expect(teamAiNameDraft("가".repeat(101)).valid).toBe(false);
  });

  it("409는 겹침, 400은 예약어와 모양, 403은 권한으로 가른다", () => {
    expect(teamAiRenameErrorKind(new ApiError(409, "display name is already in use"))).toBe("taken");
    expect(teamAiRenameErrorKind(new ApiError(400, "display name is reserved"))).toBe("reserved");
    expect(teamAiRenameErrorKind(new ApiError(400, "displayName is required"))).toBe("invalid");
    expect(teamAiRenameErrorKind(new ApiError(403, "forbidden"))).toBe("forbidden");
    expect(teamAiRenameErrorKind(new Error("offline"))).toBe("other");
  });
});
