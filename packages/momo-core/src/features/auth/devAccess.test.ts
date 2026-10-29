import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { WireShapeError } from "../../lib/wire";
import { installCoreHost, resetCoreHost, type SessionPort } from "../../runtime/host";
import {
  buildCreateDevCredentialBody,
  createDevCredential,
  devAccessError,
  getDevAccessPolicy,
  listDevCredentials,
  parseCreatedDevCredential,
  parseDevAccessPolicy,
  parseDevCredential,
  parseDevCredentialList,
  parseRevokeDevCredential,
  revokeDevCredential,
  type CreateDevCredentialInput,
} from "./devAccess";

// #4663: developer access wire (ADR-0216 D2, D3, D6, D7). The JSON below is the shape
// docs/api/openapi.yaml gives (DevAccessPolicyResponse, DevCredential,
// CreateDevCredentialResponse, RevokeDevCredentialResponse), with made-up people and
// made-up ids. The only fake is `fetch`: no server behaviour is imitated.

const WS = "019f9b10-0000-7000-8000-00000000a001";
const DOHYUN = "019f9b10-0000-7000-8000-00000000b001";
const SEOYEON = "019f9b10-0000-7000-8000-00000000b002";
const CARD_ID = "019f9b10-0000-7000-8000-00000000c001";
const SESSION_ID = "019f9b10-0000-7000-8000-00000000c002";
const CHANNEL_A = "019f9b10-0000-7000-8000-00000000d001";
const CHANNEL_B = "019f9b10-0000-7000-8000-00000000d002";

/** Same envelope and length as the real thing (43 characters), obviously not a secret. */
const FAKE_TOKEN = `momo_dev_v1.${WS}.${"EXAMPLE".repeat(6)}0`;

const READ_SCOPES = ["dev:identity", "dev:channels:read", "dev:messages:read", "dev:inbox:read"];

const POLICY = { policy: "admins", canCreate: true, canManageAll: true };

const CARD = {
  id: CARD_ID,
  memberId: DOHYUN,
  kind: "card",
  name: "이도현 노트북 Claude Code",
  tool: "claude_code",
  scopes: READ_SCOPES,
  channelRestricted: false,
  createdAtMs: 1_800_000_000_000,
  lastUsedAtMs: 1_800_000_600_000,
  expiresAtMs: 1_802_592_000_000,
};

const SESSION = {
  id: SESSION_ID,
  memberId: SEOYEON,
  kind: "session",
  name: "oort CLI · macOS",
  scopes: READ_SCOPES,
  channelRestricted: true,
  deviceName: "oort CLI · macOS",
  createdAtMs: 1_800_000_100_000,
  expiresAtMs: 1_800_100_000_000,
  lineageExpiresAtMs: 1_807_776_000_000,
};

const CREATED = {
  id: CARD_ID,
  kind: "card",
  name: "달무리 스튜디오 Codex",
  tool: "codex",
  scopes: [
    "dev:identity",
    "dev:channels:read",
    "dev:messages:read",
    "dev:messages:write",
    "dev:inbox:read",
  ],
  channelIds: [CHANNEL_A, CHANNEL_B],
  createdAtMs: 1_800_000_000_000,
  expiresAtMs: 1_802_592_000_000,
  token: FAKE_TOKEN,
};

const REVOKED = { id: CARD_ID, kind: "card", revokedNow: true };

function installHost(overrides: Partial<SessionPort> = {}): void {
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
      ...overrides,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetCoreHost();
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface Seen {
  url: string;
  method: string;
  body: unknown;
  cache: RequestCache | undefined;
}

/** Answers every request with `answer` and records what the server would have received. */
function stubFetch(answer: () => Response): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        cache: init?.cache,
      });
      return answer();
    })
  );
  return seen;
}

function omit<T extends Record<string, unknown>>(source: T, key: string): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = source;
  return rest;
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error
  );
}

describe("developer access policy wire", () => {
  it("reads the switch and what it lets the caller do", () => {
    expect(parseDevAccessPolicy(POLICY)).toEqual(POLICY);
    expect(parseDevAccessPolicy({ policy: "off", canCreate: false, canManageAll: false })).toEqual({
      policy: "off",
      canCreate: false,
      canManageAll: false,
    });
  });

  it.each([
    ["no policy", omit(POLICY, "policy")],
    ["an unknown policy", { ...POLICY, policy: "owners" }],
    ["no canCreate", omit(POLICY, "canCreate")],
    ["no canManageAll", omit(POLICY, "canManageAll")],
    ["canCreate as a string", { ...POLICY, canCreate: "true" }],
    ["not an object", "admins"],
    ["null", null],
  ])("refuses an answer with %s", (_name, body) => {
    expect(() => parseDevAccessPolicy(body)).toThrow(WireShapeError);
  });
});

describe("developer token wire", () => {
  it("reads a card and a login session, leaving out what the row did not carry", () => {
    const card = parseDevCredential(CARD);
    expect(card).toEqual(CARD);
    expect("deviceName" in card).toBe(false);
    expect("lineageExpiresAtMs" in card).toBe(false);

    const session = parseDevCredential(SESSION);
    expect(session).toEqual(SESSION);
    // A login session has no tool the maker chose. It stays absent, never "other".
    expect(session.tool).toBeUndefined();
    expect("tool" in session).toBe(false);
  });

  it("reads a token that was never used as one without lastUsedAtMs", () => {
    const row = parseDevCredential(omit(CARD, "lastUsedAtMs"));
    expect(row.lastUsedAtMs).toBeUndefined();
    expect("lastUsedAtMs" in row).toBe(false);
    expect(parseDevCredential({ ...CARD, lastUsedAtMs: null }).lastUsedAtMs).toBeUndefined();
  });

  it("reads a tool it does not know as other, and keeps the rest of the list", () => {
    const rows = parseDevCredentialList({
      credentials: [{ ...CARD, tool: "some_future_tool" }, SESSION, CARD],
    });
    expect(rows.map((row) => row.tool)).toEqual(["other", undefined, "claude_code"]);
  });

  it("keeps a scope name it does not know instead of dropping a power it cannot describe", () => {
    const row = parseDevCredential({ ...CARD, scopes: [...READ_SCOPES, "dev:future:write"] });
    expect(row.scopes).toContain("dev:future:write");
    expect(row.scopes).toHaveLength(5);
  });

  it("refuses a kind it does not know", () => {
    expect(() => parseDevCredential({ ...CARD, kind: "passkey" })).toThrow(WireShapeError);
  });

  it.each(["id", "memberId", "kind", "name", "scopes", "channelRestricted", "createdAtMs", "expiresAtMs"])(
    "refuses a row without %s",
    (field) => {
      expect(() => parseDevCredential(omit(CARD, field))).toThrow(WireShapeError);
    }
  );

  it.each([
    ["scopes that is not a list", { scopes: "dev:identity" }],
    ["a scope that is not text", { scopes: [...READ_SCOPES, 7] }],
    ["channelRestricted as text", { channelRestricted: "false" }],
    ["createdAtMs as text", { createdAtMs: "1800000000000" }],
    ["a lastUsedAtMs that is text, which must not read as never used", { lastUsedAtMs: "soon" }],
    ["a deviceName that is a number", { deviceName: 5 }],
    ["an empty id", { id: "" }],
  ])("refuses a row with %s", (_name, patch) => {
    expect(() => parseDevCredential({ ...CARD, ...patch })).toThrow(WireShapeError);
  });

  it("refuses a list that is missing credentials, and a list with one broken row", () => {
    expect(() => parseDevCredentialList({})).toThrow(WireShapeError);
    expect(() => parseDevCredentialList({ credentials: "none" })).toThrow(WireShapeError);
    expect(() => parseDevCredentialList({ credentials: [CARD, omit(SESSION, "memberId")] })).toThrow(
      WireShapeError
    );
    expect(parseDevCredentialList({ credentials: [] })).toEqual([]);
  });
});

describe("created token wire", () => {
  it("returns the secret exactly as the server sent it", () => {
    const created = parseCreatedDevCredential(CREATED);
    expect(created.token).toBe(FAKE_TOKEN);
    expect(created).toEqual(CREATED);
  });

  it("does not judge the secret's shape, so a future envelope is not lost", () => {
    expect(parseCreatedDevCredential({ ...CREATED, token: "momo_dev_v2.next-format" }).token).toBe(
      "momo_dev_v2.next-format"
    );
  });

  it("omits channelIds when the token has no restriction", () => {
    expect("channelIds" in parseCreatedDevCredential(omit(CREATED, "channelIds"))).toBe(false);
    expect("channelIds" in parseCreatedDevCredential({ ...CREATED, channelIds: [] })).toBe(false);
  });

  it("reads an unknown tool as other", () => {
    expect(parseCreatedDevCredential({ ...CREATED, tool: "someday" }).tool).toBe("other");
  });

  it.each(["id", "kind", "name", "tool", "scopes", "createdAtMs", "expiresAtMs", "token"])(
    "refuses a created token without %s",
    (field) => {
      expect(() => parseCreatedDevCredential(omit(CREATED, field))).toThrow(WireShapeError);
    }
  );

  it.each([
    ["an empty token", { token: "" }],
    ["a token that is not text", { token: 1234 }],
    ["a session kind, which a create never returns", { kind: "session" }],
    ["channelIds that is not a list", { channelIds: CHANNEL_A }],
  ])("refuses a created token with %s", (_name, patch) => {
    expect(() => parseCreatedDevCredential({ ...CREATED, ...patch })).toThrow(WireShapeError);
  });
});

describe("revoke wire", () => {
  it("reads both answers, a fresh revoke and a repeat", () => {
    expect(parseRevokeDevCredential(REVOKED)).toEqual(REVOKED);
    expect(parseRevokeDevCredential({ ...REVOKED, kind: "session", revokedNow: false })).toEqual({
      id: CARD_ID,
      kind: "session",
      revokedNow: false,
    });
  });

  it.each(["id", "kind", "revokedNow"])("refuses an answer without %s", (field) => {
    expect(() => parseRevokeDevCredential(omit(REVOKED, field))).toThrow(WireShapeError);
  });

  it("refuses an unknown kind and a revokedNow that is not a boolean", () => {
    expect(() => parseRevokeDevCredential({ ...REVOKED, kind: "other" })).toThrow(WireShapeError);
    expect(() => parseRevokeDevCredential({ ...REVOKED, revokedNow: "yes" })).toThrow(WireShapeError);
  });
});

const BASE_INPUT: CreateDevCredentialInput = {
  name: "이도현 노트북 Claude Code",
  tool: "claude_code",
  preset: "read",
  currentPassword: "fake password for tests",
};

describe("create body: a default is a missing key", () => {
  it("sends only the three required keys for the defaults", () => {
    const body = buildCreateDevCredentialBody(BASE_INPUT);
    expect(Object.keys(body).sort()).toEqual(["currentPassword", "name", "tool"]);
    expect(body).toEqual({
      name: "이도현 노트북 Claude Code",
      tool: "claude_code",
      currentPassword: "fake password for tests",
    });
  });

  it("leaves scopes out for the read-only preset, and spells all five out for read and send", () => {
    expect("scopes" in buildCreateDevCredentialBody(BASE_INPUT)).toBe(false);
    const body = buildCreateDevCredentialBody({ ...BASE_INPUT, preset: "read_write" });
    expect(body.scopes).toEqual([
      "dev:identity",
      "dev:channels:read",
      "dev:messages:read",
      "dev:inbox:read",
      "dev:messages:write",
    ]);
    expect(Object.keys(body).sort()).toEqual(["currentPassword", "name", "scopes", "tool"]);
  });

  it("leaves expiresInDays out for the default 30 days and sends any other whole number", () => {
    expect("expiresInDays" in buildCreateDevCredentialBody({ ...BASE_INPUT, expiresInDays: 30 })).toBe(false);
    expect("expiresInDays" in buildCreateDevCredentialBody({ ...BASE_INPUT })).toBe(false);
    expect(buildCreateDevCredentialBody({ ...BASE_INPUT, expiresInDays: 7 }).expiresInDays).toBe(7);
    expect(buildCreateDevCredentialBody({ ...BASE_INPUT, expiresInDays: 90 }).expiresInDays).toBe(90);
  });

  it("leaves channelIds out when no channel is chosen, and sends the chosen ones once each", () => {
    expect("channelIds" in buildCreateDevCredentialBody({ ...BASE_INPUT, channelIds: [] })).toBe(false);
    expect("channelIds" in buildCreateDevCredentialBody(BASE_INPUT)).toBe(false);
    const body = buildCreateDevCredentialBody({
      ...BASE_INPUT,
      channelIds: [CHANNEL_A, CHANNEL_B, CHANNEL_A.toUpperCase()],
    });
    expect(body.channelIds).toEqual([CHANNEL_A, CHANNEL_B]);
  });

  it("trims the name and sends the password exactly as typed", () => {
    const body = buildCreateDevCredentialBody({
      ...BASE_INPUT,
      name: "  달무리 서버 점검  ",
      currentPassword: "  spaces count  ",
    });
    expect(body.name).toBe("달무리 서버 점검");
    expect(body.currentPassword).toBe("  spaces count  ");
  });

  it("never sends null, an empty list or zero for anything, whatever the combination", () => {
    const inputs: CreateDevCredentialInput[] = [
      BASE_INPUT,
      { ...BASE_INPUT, preset: "read_write" },
      { ...BASE_INPUT, channelIds: [] },
      { ...BASE_INPUT, expiresInDays: 30 },
      { ...BASE_INPUT, channelIds: [CHANNEL_A], expiresInDays: 45, preset: "read_write" },
    ];
    for (const input of inputs) {
      for (const [key, value] of Object.entries(buildCreateDevCredentialBody(input))) {
        expect(value, key).not.toBeNull();
        expect(value, key).not.toBeUndefined();
        expect(value, key).not.toEqual([]);
        expect(value, key).not.toBe(0);
      }
    }
  });
});

describe("developer access client", () => {
  it("reads the policy", async () => {
    installHost();
    const seen = stubFetch(() => jsonResponse(POLICY));
    await expect(getDevAccessPolicy(WS)).resolves.toEqual(POLICY);
    expect(seen[0]?.url).toBe(`https://oort.test/v1/workspaces/${WS}/dev-access`);
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.cache).toBe("no-store");
  });

  it("lists the caller's own tokens without a query, and everyone's with scope=all", async () => {
    installHost();
    const seen = stubFetch(() => jsonResponse({ credentials: [CARD, SESSION] }));
    const own = await listDevCredentials(WS);
    expect(own.map((row) => row.id)).toEqual([CARD_ID, SESSION_ID]);
    expect(seen[0]?.url.endsWith(`/v1/workspaces/${WS}/dev-access/credentials`)).toBe(true);
    expect(seen[0]?.url).not.toContain("?");
    expect(seen[0]?.cache).toBe("no-store");

    await listDevCredentials(WS, { all: false });
    expect(seen[1]?.url).not.toContain("?");

    await listDevCredentials(WS, { all: true });
    expect(seen[2]?.url.endsWith(`/v1/workspaces/${WS}/dev-access/credentials?scope=all`)).toBe(true);
    expect(seen[2]?.cache).toBe("no-store");
  });

  it("makes a token with a body that leaves the defaults out, and returns the secret", async () => {
    installHost();
    const seen = stubFetch(() => jsonResponse(CREATED, 201, { "cache-control": "no-store" }));
    const created = await createDevCredential(WS, { ...BASE_INPUT, tool: "codex" });
    expect(created.token).toBe(FAKE_TOKEN);
    expect(created.id).toBe(CARD_ID);
    expect(seen[0]?.url).toBe(`https://oort.test/v1/workspaces/${WS}/dev-access/credentials`);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.cache).toBe("no-store");
    expect(Object.keys(seen[0]?.body as object).sort()).toEqual(["currentPassword", "name", "tool"]);
  });

  it("revokes one id, and reads a repeat as success", async () => {
    installHost();
    const seen = stubFetch(() => jsonResponse({ ...REVOKED, revokedNow: false }));
    await expect(revokeDevCredential(WS, CARD_ID)).resolves.toEqual({
      id: CARD_ID,
      kind: "card",
      revokedNow: false,
    });
    expect(seen[0]?.url).toBe(`https://oort.test/v1/workspaces/${WS}/dev-access/credentials/${CARD_ID}`);
    expect(seen[0]?.method).toBe("DELETE");
  });

  it("encodes the ids it puts in a path", async () => {
    installHost();
    const seen = stubFetch(() => jsonResponse(REVOKED));
    await revokeDevCredential("ws/odd id", "card/../id");
    expect(seen[0]?.url).toBe(
      "https://oort.test/v1/workspaces/ws%2Fodd%20id/dev-access/credentials/card%2F..%2Fid"
    );
  });

  it("turns an answer that is not the documented shape into a WireShapeError", async () => {
    installHost();
    stubFetch(() => jsonResponse({ credentials: [omit(CARD, "memberId")] }));
    expect(await caught(listDevCredentials(WS))).toBeInstanceOf(WireShapeError);

    stubFetch(() => new Response("<html>gateway</html>", { status: 200 }));
    expect(await caught(getDevAccessPolicy(WS))).toBeInstanceOf(WireShapeError);

    stubFetch(() => new Response(null, { status: 200 }));
    expect(await caught(revokeDevCredential(WS, CARD_ID))).toBeInstanceOf(WireShapeError);
  });
});

describe("developer access failures", () => {
  const cases: Array<[string, ApiError, ReturnType<typeof devAccessError>]> = [
    ["400 with no code", new ApiError(400, "invalid name"), { kind: "invalid" }],
    ["401", new ApiError(401, "expired"), { kind: "unauthorized" }],
    [
      "403 current_password_incorrect",
      new ApiError(403, "wrong", "current_password_incorrect"),
      { kind: "password_incorrect" },
    ],
    [
      "403 current_password_unavailable",
      new ApiError(403, "none", "current_password_unavailable"),
      { kind: "password_unavailable" },
    ],
    ["403 dev_access_denied", new ApiError(403, "no", "dev_access_denied"), { kind: "access_denied" }],
    ["403 dev_route_not_allowed", new ApiError(403, "no", "dev_route_not_allowed"), { kind: "forbidden" }],
    ["403 with no code", new ApiError(403, "forbidden"), { kind: "forbidden" }],
    ["403 with a code it does not know", new ApiError(403, "no", "something_new"), { kind: "forbidden" }],
    ["404", new ApiError(404, "not found"), { kind: "not_found" }],
    ["409 dev_credential_limit", new ApiError(409, "full", "dev_credential_limit"), { kind: "limit" }],
    ["409 with no code", new ApiError(409, "conflict"), { kind: "unknown" }],
    ["409 with another code", new ApiError(409, "conflict", "other_conflict"), { kind: "unknown" }],
    ["429 with 30 seconds", new ApiError(429, "slow", undefined, 30), { kind: "rate_limited", retryAfterSeconds: 30 }],
    ["429 with no wait given", new ApiError(429, "slow"), { kind: "rate_limited" }],
    ["503 with 5 seconds", new ApiError(503, "busy", undefined, 5), { kind: "busy", retryAfterSeconds: 5 }],
    ["503 with no wait given", new ApiError(503, "busy"), { kind: "busy" }],
    ["500", new ApiError(500, "boom"), { kind: "unknown" }],
    ["502 that carries a wait", new ApiError(502, "gateway", undefined, 9), { kind: "unknown" }],
  ];

  it.each(cases)("classifies %s", (_name, error, expected) => {
    const result = devAccessError(error);
    expect(result).toEqual(expected);
    // A wait is part of the answer only when the server gave one.
    expect("retryAfterSeconds" in result).toBe("retryAfterSeconds" in expected);
  });

  it("decides on status and code, never on the message text", () => {
    expect(devAccessError(new ApiError(403, "current_password_incorrect")).kind).toBe("forbidden");
    expect(devAccessError(new ApiError(403, "아무 말", "current_password_incorrect")).kind).toBe(
      "password_incorrect"
    );
    expect(devAccessError(new ApiError(409, "dev_credential_limit")).kind).toBe("unknown");
  });

  it("classifies an absent connection as network, and anything else as unknown", () => {
    expect(devAccessError(new NetworkError("timeout", 15_000))).toEqual({ kind: "network" });
    expect(devAccessError(new NetworkError("unreachable", 15_000))).toEqual({ kind: "network" });
    expect(devAccessError(new WireShapeError())).toEqual({ kind: "unknown" });
    expect(devAccessError(new Error("boom"))).toEqual({ kind: "unknown" });
    expect(devAccessError(undefined)).toEqual({ kind: "unknown" });
    expect(devAccessError("403")).toEqual({ kind: "unknown" });
  });

  it("carries the Retry-After seconds from a 429 all the way to the classification", async () => {
    installHost();
    stubFetch(() =>
      jsonResponse({ error: { message: "too many" } }, 429, { "Retry-After": "7" })
    );
    const error = await caught(createDevCredential(WS, BASE_INPUT));
    expect(error).toBeInstanceOf(ApiError);
    expect(devAccessError(error)).toEqual({ kind: "rate_limited", retryAfterSeconds: 7 });
  });

  it("carries the Retry-After seconds of a 503 the same way", async () => {
    installHost();
    stubFetch(() => jsonResponse({ error: { message: "busy" } }, 503, { "Retry-After": "3" }));
    const error = await caught(createDevCredential(WS, BASE_INPUT));
    expect(devAccessError(error)).toEqual({ kind: "busy", retryAfterSeconds: 3 });
  });

  it("gives no seconds when the 429 has no usable Retry-After", async () => {
    installHost();
    const unusable: Array<Record<string, string>> = [
      {},
      { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" },
      { "Retry-After": "soon" },
    ];
    for (const headers of unusable) {
      stubFetch(() => jsonResponse({ error: { message: "too many" } }, 429, headers));
      const result = devAccessError(await caught(listDevCredentials(WS)));
      expect(result.kind).toBe("rate_limited");
      expect("retryAfterSeconds" in result).toBe(false);
    }
  });

  it("reads the code of a refused create from the answer body", async () => {
    installHost();
    stubFetch(() =>
      jsonResponse({ error: { message: "x", code: "current_password_incorrect" } }, 403)
    );
    expect(devAccessError(await caught(createDevCredential(WS, BASE_INPUT))).kind).toBe(
      "password_incorrect"
    );

    stubFetch(() => jsonResponse({ error: { message: "x", code: "dev_credential_limit" } }, 409));
    expect(devAccessError(await caught(createDevCredential(WS, BASE_INPUT))).kind).toBe("limit");
  });

  it("classifies a 404 on revoke and a refused list", async () => {
    installHost();
    stubFetch(() => jsonResponse({ error: { message: "no" } }, 404));
    expect(devAccessError(await caught(revokeDevCredential(WS, CARD_ID))).kind).toBe("not_found");

    stubFetch(() => jsonResponse({ error: { message: "no", code: "dev_route_not_allowed" } }, 403));
    expect(devAccessError(await caught(listDevCredentials(WS, { all: true }))).kind).toBe("forbidden");
  });
});
