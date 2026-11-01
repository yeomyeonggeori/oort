// ADR-0201 증보 v3 B3 (#4945): 도우미 역할 묶음의 읽기·쓰기·고지 규칙. 서버(#4964)와 같은 규칙으로 읽는다.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";

const settingsRequest = vi.hoisted(() => vi.fn());
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, settingsRequest: (...args: unknown[]) => settingsRequest(...args) as Promise<unknown> };
});

import {
  defaultTeamAiRoles,
  patchTeamAiRoles,
  readTeamAiRoles,
  teamAiNoticeKind,
  teamAiRolesChange,
  teamAiRolesErrorKind,
  TEAM_AI_BUNDLES,
  TEAM_AI_SWITCHABLE_BUNDLES,
} from "./teamAiRoles";

beforeEach(() => settingsRequest.mockReset());

describe("읽기: 기본은 모두 켬, 닫는 쪽은 서버와 같다", () => {
  it("설정이 없거나 칸이 없거나 null이면 일곱 묶음이 모두 켜진다", () => {
    expect(TEAM_AI_BUNDLES).toHaveLength(7);
    for (const bag of [undefined, null, {}, { team_ai_roles: null }, { team_ai_roles: {} }, { team_ai_roles: { files: null } }]) {
      expect(readTeamAiRoles(bag), JSON.stringify(bag)).toEqual(defaultTeamAiRoles());
    }
    expect(Object.values(defaultTeamAiRoles()).every((on) => on === true)).toBe(true);
  });

  it("false만 끈다. 칸이 있는데 불리언이 아니면 끄고, 객체가 아니면 여섯 칸 모두 끄며, chat_read는 늘 켠다", () => {
    expect(readTeamAiRoles({ team_ai_roles: { files: false, memory: true, code: "off", chat_read: false } })).toEqual({
      chat_read: true,
      workspace_admin: true,
      invite_access: true,
      long_research: true,
      files: false,
      memory: true,
      code: false,
    });
    const unreadable = readTeamAiRoles({ team_ai_roles: "all" });
    expect(unreadable.chat_read).toBe(true);
    expect(TEAM_AI_SWITCHABLE_BUNDLES.every((id) => unreadable[id] === false)).toBe(true);
  });
});

describe("쓰기: 바뀐 칸만, 한 단계 아래로", () => {
  it("변경은 다른 칸만 담고 같으면 비어 있다", () => {
    const base = defaultTeamAiRoles();
    expect(teamAiRolesChange(base, base)).toEqual({});
    expect(teamAiRolesChange(base, { ...base, files: false, code: false })).toEqual({ files: false, code: false });
    expect(teamAiRolesChange({ ...base, files: false }, base)).toEqual({ files: true });
  });

  it("PATCH 본문은 team_ai_roles 아래 바뀐 칸뿐이다", async () => {
    settingsRequest.mockResolvedValue({ team_ai_roles: { files: false } });
    await patchTeamAiRoles("00000000-0000-7000-8000-000000000001", { files: false });
    expect(settingsRequest).toHaveBeenCalledTimes(1);
    const [path, init] = settingsRequest.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe("/v1/workspaces/00000000-0000-7000-8000-000000000001/settings");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ team_ai_roles: { files: false } });
  });
});

describe("고지와 오류 종류", () => {
  it("켜진 파일·기억만 고지한다. 둘 다 꺼지면 줄이 없다", () => {
    const base = defaultTeamAiRoles();
    expect(teamAiNoticeKind(base)).toBe("both");
    expect(teamAiNoticeKind({ ...base, memory: false })).toBe("files");
    expect(teamAiNoticeKind({ ...base, files: false })).toBe("memory");
    expect(teamAiNoticeKind({ ...base, files: false, memory: false })).toBeNull();
  });

  it("저장 실패를 코드와 상태로 가른다", () => {
    expect(teamAiRolesErrorKind(new ApiError(409, "team memory is off", "team_memory_off"))).toBe("team_memory_off");
    expect(teamAiRolesErrorKind(new ApiError(403, "forbidden"))).toBe("forbidden");
    expect(teamAiRolesErrorKind(new ApiError(500, "boom"))).toBe("other");
    expect(teamAiRolesErrorKind(new Error("offline"))).toBe("other");
  });
});
