import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost } from "../../runtime/host";
import { ApiError } from "../../lib/api";
import { findLegacyTerms } from "./aiHubModel";
import {
  PERSONAL_KEYS_COPY,
  issuePersonalKey,
  listMyPersonalKeys,
  listPersonalKeys,
  revokePersonalKey,
  createPersonalKeyAgent,
  parsePersonalKey,
  parsePersonalKeyList,
  personalAgentDefaults,
  personalAgentHandleValid,
  personalKeyErrorMessage,
} from "./personalKeys";

const ROW = {
  id: "AAAAAAAA-0000-7000-8000-000000000001",
  ownerMemberId: "00000000-0000-7000-8000-000000000101",
  format: "anthropic",
  endpointLabel: "api.anthropic.com",
  label: "리서치용",
  status: "active",
  issuedBy: "00000000-0000-7000-8000-000000000102",
  issuedAtMs: 1_790_000_000_000,
};

describe("개인 키 읽기", () => {
  it("한 줄을 읽고 키처럼 생긴 필드는 가져오지 않는다", () => {
    const key = parsePersonalKey({ ...ROW, apiKey: "sk-should-never-be-read", bearer: "x", secret: "y" });
    expect(key).toMatchObject({ format: "anthropic", status: "active", label: "리서치용", revokedAtMs: null });
    expect(key?.id).toBe(ROW.id.toLowerCase());
    expect(JSON.stringify(key)).not.toContain("sk-should-never-be-read");
    expect(Object.keys(key ?? {})).toEqual([
      "id", "ownerMemberId", "format", "endpointLabel", "label", "status", "issuedAtMs", "revokedAtMs",
    ]);
  });

  it("모르는 모양은 버리고, 회수된 키는 회수 시각을 든다", () => {
    expect(parsePersonalKey({ ...ROW, status: "weird" })).toBeNull();
    expect(parsePersonalKey("x")).toBeNull();
    const list = parsePersonalKeyList({ keys: [{ ...ROW, status: "revoked", revokedAtMs: 5 }, { nope: 1 }] });
    expect(list).toHaveLength(1);
    expect(list[0].revokedAtMs).toBe(5);
    expect(parsePersonalKeyList({})).toEqual([]);
  });
});

describe("거절 문장", () => {
  it("서버 코드를 사람 말로 옮기고 키 값은 말하지 않는다", () => {
    const own = personalKeyErrorMessage(new ApiError(409, "x", "personal_key_owner_has_active_key"), "issue");
    expect(own).toContain("먼저 그 키를 회수");
    expect(personalKeyErrorMessage(new ApiError(409, "x", "personal_agent_exists"), "agent")).toContain("이미");
    expect(personalKeyErrorMessage(new ApiError(409, "x", "personal_key_revoked"), "agent")).toContain("회수된 키");
    expect(personalKeyErrorMessage(new ApiError(403, "x"), "agent")).toContain("게스트");
    expect(personalKeyErrorMessage(new ApiError(503, "x"), "issue")).toContain("서버 운영자");
    expect(personalKeyErrorMessage(new TypeError("net"), "issue")).toContain("다시 시도");
  });
});

describe("에이전트 처음 값", () => {
  it("표시 이름은 이름-회사, 핸들은 소유자 핸들에서 만든 합법 핸들", () => {
    const d = personalAgentDefaults({ memberName: "곽성재", memberHandle: "Seongjae.K", company: "Anthropic", format: "anthropic" });
    expect(d.displayName).toBe("곽성재-Anthropic");
    expect(d.handle).toBe("seongjae-k-claude");
    expect(personalAgentHandleValid(d.handle)).toBe(true);
    const hangul = personalAgentDefaults({ memberName: "성재", memberHandle: "성재", company: "OpenAI", format: "openai" });
    expect(personalAgentHandleValid(hangul.handle)).toBe(true);
    const long = personalAgentDefaults({ memberName: "a", memberHandle: "x".repeat(60), company: "OpenAI", format: "openai" });
    expect(long.handle.length).toBeLessThanOrEqual(32);
    expect(personalAgentHandleValid(long.handle)).toBe(true);
  });
});

describe("문구", () => {
  it("옛 말이 없고 em-dash가 없다", () => {
    const strings: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") strings.push(v);
      else if (typeof v === "function") strings.push((v as (...a: string[]) => string)("가", "나"));
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(PERSONAL_KEYS_COPY);
    expect(strings.length).toBeGreaterThan(30);
    for (const s of strings) {
      expect(findLegacyTerms(s), s).toEqual([]);
      expect(s).not.toMatch(/[—–]/);
    }
  });
});

describe("실제 API 클라이언트: 키는 발급 요청 하나에만 한 번 실린다", () => {
  const SECRET = "sk-test-PERSONAL-9f3c1d7a2b4e6a8c0d";
  const WS = "00000000-0000-7000-8000-000000000001";
  const KEY_ID = "00000000-0000-7000-8000-0000000004a1";

  function installHost(): void {
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
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    resetCoreHost();
  });

  const ok = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("발급: 요청 정확히 하나, POST …/personal-keys, 본문에 키 한 번, 다른 요청에는 없다", async () => {
    installHost();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ok(ROW, 201));
    vi.stubGlobal("fetch", fetchMock);

    await issuePersonalKey(WS, {
      ownerMemberId: ROW.ownerMemberId, apiKey: SECRET, format: "anthropic", baseUrl: "https://api.anthropic.com", label: "메모",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url).endsWith(`/v1/workspaces/${WS}/personal-keys`)).toBe(true);
    expect(init?.method).toBe("POST");
    expect(String(init?.body).split(SECRET).length - 1).toBe(1);
    expect(String(url)).not.toContain(SECRET);
    expect(JSON.stringify([...new Headers(init?.headers).entries()])).not.toContain(SECRET);

    // 이어지는 다른 모든 호출에는 키가 실리지 않는다.
    fetchMock.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).endsWith("/agent") ? ok({ agent: { id: "a", handle: "h", displayName: "d" } }, 201) : ok({ keys: [ROW], ...ROW })
    );
    await listPersonalKeys(WS);
    await listMyPersonalKeys(WS);
    await revokePersonalKey(WS, KEY_ID);
    await createPersonalKeyAgent(WS, KEY_ID, { displayName: "d", handle: "hh", model: "m" });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    for (const [input, req] of fetchMock.mock.calls.slice(1)) {
      expect(String(input)).not.toContain(SECRET);
      expect(String(req?.body ?? "")).not.toContain(SECRET);
    }
  });

  it("빈 키는 요청 없이 막는다", async () => {
    installHost();
    const fetchMock = vi.fn(async () => ok(ROW, 201));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      issuePersonalKey(WS, { ownerMemberId: ROW.ownerMemberId, apiKey: "", format: "openai", baseUrl: "https://api.openai.com/v1" })
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("400 문장은 서버 메시지를 되풀이하지 않는다(키가 섞여 와도)", async () => {
    installHost();
    vi.stubGlobal("fetch", vi.fn(async () => ok({ error: { code: "invalid", message: `bad key ${SECRET}` } }, 400)));
    const error = await issuePersonalKey(WS, {
      ownerMemberId: ROW.ownerMemberId, apiKey: SECRET, format: "openai", baseUrl: "https://api.openai.com/v1",
    }).catch((e: unknown) => e);
    for (const action of ["issue", "revoke", "agent", "list"] as const) {
      expect(personalKeyErrorMessage(error, action)).not.toContain(SECRET);
    }
    expect(personalKeyErrorMessage(new ApiError(418, `echo ${SECRET}`), "issue")).not.toContain(SECRET);
  });
});
