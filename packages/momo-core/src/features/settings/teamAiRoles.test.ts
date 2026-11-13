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
  teamAiRolesNotice,
  teamAiSettingsToggleNotice,
  TEAM_AI_ALL_BUNDLES,
  TEAM_AI_BUNDLES,
  TEAM_AI_HERMES_BUNDLE,
  TEAM_AI_RECORDED_NOTICE_BUNDLES,
  TEAM_AI_NOTICE_VERSION,
  TEAM_AI_SWITCHABLE_BUNDLES,
} from "./teamAiRoles";
import { TEAM_AI_ROLE_COPY, teamAiRoleNoticeKey } from "./teamAiCopyKeys";
import { messageKeys } from "../../i18n/generated/messages";
import koTeamAi from "../../i18n/catalogs/ko-KR/teamAi.json";

beforeEach(() => settingsRequest.mockReset());

describe("읽기: 기본은 모두 켬, 닫는 쪽은 서버와 같다", () => {
  it("설정이 없거나 칸이 없거나 null이면 여덟 묶음이 모두 켜진다", () => {
    expect(TEAM_AI_ALL_BUNDLES).toHaveLength(8);
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
      hermes: true,
    });
    const unreadable = readTeamAiRoles({ team_ai_roles: "all" });
    expect(unreadable.chat_read).toBe(true);
    expect(TEAM_AI_SWITCHABLE_BUNDLES.every((id) => unreadable[id] === false)).toBe(true);
  });
});

// ADR-0201 증보 v4 P10 (#5374): 일곱째 스위치 `hermes`(「Hermes 도움」). 서버 `SWITCHABLE_BUNDLES`와 같은 순서·같은
// 읽기 규칙이고 기본은 켬이다. 역할 목록 화면의 행(`TEAM_AI_BUNDLES`)에는 아직 없다 — 그 행은 고지·이유를 함께
// 보이는 화면(S7·S8)이 더한다.
describe("hermes 묶음 (증보 v4 P10)", () => {
  it("서버 SWITCHABLE_BUNDLES와 같은 일곱이고 hermes가 마지막이다", () => {
    expect(TEAM_AI_SWITCHABLE_BUNDLES).toEqual([
      "workspace_admin",
      "invite_access",
      "long_research",
      "files",
      "memory",
      "code",
      "hermes",
    ]);
    expect(TEAM_AI_HERMES_BUNDLE).toBe("hermes");
    expect(defaultTeamAiRoles().hermes).toBe(true);
  });

  it("없거나 null이면 켬, false만 끄고, 불리언이 아니거나 객체가 아니면 끔이다", () => {
    expect(readTeamAiRoles({ team_ai_roles: {} }).hermes).toBe(true);
    expect(readTeamAiRoles({ team_ai_roles: { hermes: null } }).hermes).toBe(true);
    expect(readTeamAiRoles({ team_ai_roles: { hermes: true } }).hermes).toBe(true);
    expect(readTeamAiRoles({ team_ai_roles: { hermes: false } }).hermes).toBe(false);
    expect(readTeamAiRoles({ team_ai_roles: { hermes: "on" } }).hermes).toBe(false);
    expect(readTeamAiRoles({ team_ai_roles: "all" }).hermes).toBe(false);
    // hermes를 꺼도 다른 칸은 움직이지 않는다
    expect(readTeamAiRoles({ team_ai_roles: { hermes: false } })).toEqual({
      ...defaultTeamAiRoles(),
      hermes: false,
    });
  });

  it("변경은 hermes 칸도 담고, PATCH 본문은 그 칸 하나다", async () => {
    const base = defaultTeamAiRoles();
    expect(teamAiRolesChange(base, { ...base, hermes: false })).toEqual({ hermes: false });
    expect(teamAiRolesChange({ ...base, hermes: false }, base)).toEqual({ hermes: true });
    settingsRequest.mockResolvedValue({});
    await patchTeamAiRoles("00000000-0000-7000-8000-000000000001", { hermes: false });
    const [, init] = settingsRequest.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({ team_ai_roles: { hermes: false } });
  });

  it("목록 화면의 행은 그대로 일곱이고 hermes 행은 없다 — 고지 없는 hermes 행이 생기지 않는다", () => {
    expect(TEAM_AI_BUNDLES).toEqual([
      "chat_read",
      "workspace_admin",
      "invite_access",
      "long_research",
      "files",
      "memory",
      "code",
    ]);
    expect((TEAM_AI_BUNDLES as readonly string[]).includes("hermes")).toBe(false);
  });

  it("이름·설명·고지 키가 사전에 있고, 고지는 서버 카드(v2)의 두 사실을 한 문구에 모두 말한다", () => {
    const keys = new Set<string>(messageKeys);
    expect(keys.has(TEAM_AI_ROLE_COPY.hermes.name)).toBe(true);
    expect(keys.has(TEAM_AI_ROLE_COPY.hermes.hint)).toBe(true);
    const notice = teamAiRoleNoticeKey("hermes");
    expect(notice).toBe("teamAi.roles.noticeHermes");
    expect((koTeamAi as Record<string, string>)["teamAi.roles.hermesName"]).toBe("Hermes 도움");
    // 서버 `momo_agent::team_ai_roles::NOTICE_HERMES`(NOTICE_VERSION 2026-11-06.v2)의 두 문장: ① 요청 문장이 Hermes가
    // 쓰는 AI 회사로 간다 ② Hermes가 자기 기록(state.db)에 남기고 그 보관은 oort가 아닌 운영자 몫이다. 화면 문구는
    // 디자인 규칙(옛 용어 「운영자 설정」 금지)에 맞춰 ②의 끝만 「서버 운영자가 정해요」로 말한다 — 뜻은 같다.
    const text = (koTeamAi as Record<string, string>)[notice as string] ?? "";
    expect(text.startsWith("Hermes 도움을 켜면 도우미가 맡기는 요청 문장이 Hermes가 쓰는 AI 회사(OpenAI 등)로 전달돼요. ")).toBe(true);
    expect(text).toContain("Hermes는 맡긴 요청 문장과 결과를 자기 기록(state.db)에 남겨요.");
    expect(text).toContain("oort가 아니라 서버 운영자가 정해요.");
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

// ADR-0201 증보 v3 B3 (#5040): 화면이 「고지 줄을 보였다」고 서버에 남기는 기록.
describe("고지 기록: 화면이 보였다고 남기는 것", () => {
  it("고지가 있는 묶음만 표 순서로 중복 없이 담고, 판은 사전의 판이다. 보인 줄이 없으면 기록도 없다", () => {
    expect(teamAiRolesNotice("settings", ["memory", "files", "files", "code"])).toEqual({
      bundles: ["files", "memory"],
      noticeVersion: TEAM_AI_NOTICE_VERSION,
      via: "settings",
    });
    expect(teamAiRolesNotice("onboarding", ["code", "invite_access", "chat_read"])).toBeNull();
    expect(teamAiRolesNotice("onboarding", [])).toBeNull();
    // hermes의 고지(v2)도 기록할 수 있다 — 표 순서(파일·기억·hermes)로
    expect(teamAiRolesNotice("settings", ["hermes", "files"])).toEqual({
      bundles: ["files", "hermes"],
      noticeVersion: TEAM_AI_NOTICE_VERSION,
      via: "settings",
    });
    expect(TEAM_AI_RECORDED_NOTICE_BUNDLES).toEqual(["files", "memory", "hermes"]);
    // 서버 `NOTICE_VERSIONS`에 있어야 기록된다(모르는 판은 400). 이 값을 올리면 서버 목록에도 더한다.
    // v2 = hermes 고지를 더한 판(서버 #5369가 먼저 올렸다). 파일·기억 줄은 v1과 같은 글자다.
    expect(TEAM_AI_NOTICE_VERSION).toBe("2026-11-06.v2");
  });

  it("설정의 스위치는 고지가 있는 묶음(파일·기억·hermes)을 켤 때만 기록을 싣는다: 끄거나 다른 묶음이면 싣지 않는다", () => {
    for (const bundle of TEAM_AI_SWITCHABLE_BUNDLES) {
      const noticed = (TEAM_AI_RECORDED_NOTICE_BUNDLES as readonly string[]).includes(bundle);
      expect(teamAiSettingsToggleNotice(bundle, true), `${bundle} on`).toEqual(
        noticed ? { bundles: [bundle], noticeVersion: TEAM_AI_NOTICE_VERSION, via: "settings" } : null
      );
      expect(teamAiSettingsToggleNotice(bundle, false), `${bundle} off`).toBeNull();
    }
  });

  it("PATCH 본문: 기록이 있으면 team_ai_roles_notice가 같은 본문에 실리고, 없으면 예전 본문 그대로다", async () => {
    settingsRequest.mockResolvedValue({});
    const notice = teamAiSettingsToggleNotice("files", true);
    await patchTeamAiRoles("00000000-0000-7000-8000-000000000001", { files: true }, notice);
    const [, init] = settingsRequest.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({
      team_ai_roles: { files: true },
      team_ai_roles_notice: { bundles: ["files"], noticeVersion: TEAM_AI_NOTICE_VERSION, via: "settings" },
    });
    settingsRequest.mockClear();
    for (const none of [undefined, null]) {
      await patchTeamAiRoles("00000000-0000-7000-8000-000000000001", { files: false }, none);
      const [, plain] = settingsRequest.mock.calls.at(-1) as [string, { body: string }];
      expect(JSON.parse(plain.body)).toEqual({ team_ai_roles: { files: false } });
    }
  });
});
