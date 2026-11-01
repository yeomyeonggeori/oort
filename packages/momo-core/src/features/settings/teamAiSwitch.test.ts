import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { installCoreHost, resetCoreHost, type SessionPort } from "../../runtime/host";
import {
  classifyTeamAiProbe,
  probeTeamAiSwitch,
  readTeamAiSwitch,
  setTeamAiSwitch,
  TEAM_AI_SWITCH_DESCRIPTION,
  teamAiSaveErrorCopy,
} from "./teamAiSwitch";

function installHost(): void {
  const session: SessionPort = {
    getAccessToken: () => "access-token",
    getRefreshToken: () => null,
    getPersistedSession: () => null,
    applyLogin: () => {},
    applyRotation: () => {},
    markAuthExpired: () => {},
    clearSession: () => {},
  };
  installCoreHost({
    apiBase: () => "https://oort.test",
    absoluteApiBase: () => "https://oort.test",
    buildMode: () => "test",
    session,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetCoreHost();
});

const WS = "00000000-0000-7000-8000-000000000001";

function answer(status: number, message: string) {
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ error: { code: "bad_request", message } }), {
        status,
        headers: { "content-type": "application/json" },
      })
  );
}

describe("oort 도우미 스위치 (ADR-0201 D8)", () => {
  it("가방에 키가 있으면 서버가 안다", () => {
    expect(readTeamAiSwitch({ team_ai_fast_path: true })).toEqual({
      known: true,
      enabled: true,
      memberId: null,
    });
    expect(readTeamAiSwitch({ team_ai_fast_path: false }).known).toBe(true);
    expect(
      readTeamAiSwitch({ team_ai_agent_member_id: "m-1" })
    ).toEqual({ known: true, enabled: false, memberId: "m-1" });
  });

  it("키가 없으면 가방만으로는 모른다 (구서버와 한 번도 안 켠 서버가 같다)", () => {
    expect(readTeamAiSwitch({})).toEqual({ known: false, enabled: false, memberId: null });
    expect(readTeamAiSwitch({ team_ai_fast_path: "yes" }).known).toBe(false);
    expect(readTeamAiSwitch(null).known).toBe(false);
  });

  // 서버 문장 원문: momo-settings `WorkspaceSettingsInvalid` (#3837).
  it("물음의 대답으로 가른다", () => {
    expect(
      classifyTeamAiProbe(new ApiError(400, "team_ai_fast_path must be true or false"))
    ).toBe("ready");
    expect(
      classifyTeamAiProbe(new ApiError(400, "unknown settings key: team_ai_fast_path"))
    ).toBe("absent");
  });

  it("확인하지 못한 것은 있다고 하지 않는다", () => {
    expect(classifyTeamAiProbe(new ApiError(403, "forbidden"))).toBe("unknown");
    expect(classifyTeamAiProbe(new ApiError(400, "settings payload is too large"))).toBe("unknown");
    expect(classifyTeamAiProbe(new Error("network"))).toBe("unknown");
  });

  it("이름 충돌은 고칠 방법을 말한다", () => {
    expect(
      teamAiSaveErrorCopy(new ApiError(409, "taken", "team_ai_unavailable"))
    ).toContain("oort-helper");
    expect(teamAiSaveErrorCopy(new Error("x"))).toContain("다시 시도");
  });
});

describe("물음은 쓰기가 아니다", () => {
  // 서버는 불리언이 아닌 값을 가방에 쓰기 전에 거절한다(`merge_workspace_settings`).
  // `null`(키 삭제)·`false`(도우미 멈춤 + 감사 행)로 물으면 그것은 쓰기다.
  it("불리언이 아닌 값 하나만 보낸다", async () => {
    installHost();
    const fetchMock = answer(400, "team_ai_fast_path must be true or false");
    vi.stubGlobal("fetch", fetchMock);
    await expect(probeTeamAiSwitch(WS)).resolves.toBe("ready");
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("PATCH");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["team_ai_fast_path"]);
    expect(typeof body.team_ai_fast_path).toBe("string");
  });

  it("구서버의 대답은 없음이다", async () => {
    installHost();
    vi.stubGlobal("fetch", answer(400, "unknown settings key: team_ai_fast_path"));
    await expect(probeTeamAiSwitch(WS)).resolves.toBe("absent");
  });

  it("검증이 사라져 200 이 오면 판정하지 않는다", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))
    );
    await expect(probeTeamAiSwitch(WS)).resolves.toBe("unknown");
  });

  it("켜기는 불리언을 보낸다", async () => {
    installHost();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ team_ai_fast_path: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    await setTeamAiSwitch(WS, true);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      team_ai_fast_path: true,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://oort.test/v1/workspaces/${WS}/settings`
    );
  });
});

// 서버 PR(#4944)이 들어가면 기본은 「제한 없음」이다. 옛 문장 「하루 사용량에는 상한이 있어요」는 그 순간 거짓이다.
describe("스위치 설명은 사용량 한도가 기본으로 없다는 사실과 맞다", () => {
  it("하루 상한이 있다고 말하지 않고, 한도를 정하는 곳을 가리킨다", () => {
    expect(TEAM_AI_SWITCH_DESCRIPTION).not.toContain("상한");
    expect(TEAM_AI_SWITCH_DESCRIPTION).toContain("정하지 않으면 없");
    expect(TEAM_AI_SWITCH_DESCRIPTION).toContain("「사용 한도」");
  });
});
