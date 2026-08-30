import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../../runtime/host";
import {
  fetchPresenceStatus,
  fetchRoster,
  setPresenceStatus,
  type RosterMember,
} from "../../lib/api";
import { visibleCustomStatus } from "./customStatus";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const NOW = 1_800_000_000_000;

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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rosterRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ME,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "곽성재",
    handle: "seongjae",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    presenceStatus: "auto",
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

describe("custom status PUT omit vs null round-trip", () => {
  it("sets, projects onto roster, keeps custom on a status-only PUT, then clears with nulls", async () => {
    installHost();
    const store: Record<string, unknown> = {
      status: "auto",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith(`/v1/workspaces/${WS}/presence`)) {
        if (method === "PUT") {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          expect(Object.prototype.hasOwnProperty.call(body, "status")).toBe(true);
          store.status = body.status;
          if (Object.prototype.hasOwnProperty.call(body, "statusEmoji")) {
            store.statusEmoji = body.statusEmoji;
          }
          if (Object.prototype.hasOwnProperty.call(body, "statusText")) {
            store.statusText = body.statusText;
          }
          if (Object.prototype.hasOwnProperty.call(body, "statusExpiresAtMs")) {
            store.statusExpiresAtMs = body.statusExpiresAtMs;
          }
          const response: Record<string, unknown> = { status: store.status };
          if (typeof store.statusEmoji === "string") {
            response.statusEmoji = store.statusEmoji;
          }
          if (typeof store.statusText === "string") {
            response.statusText = store.statusText;
          }
          if (typeof store.statusExpiresAtMs === "number") {
            response.statusExpiresAtMs = store.statusExpiresAtMs;
          }
          return jsonResponse(200, response);
        }
        return jsonResponse(200, { status: store.status });
      }
      if (method === "GET" && url.endsWith(`/v1/workspaces/${WS}/roster`)) {
        const member = rosterRow({ presenceStatus: store.status });
        if (typeof store.statusEmoji === "string") member.statusEmoji = store.statusEmoji;
        if (typeof store.statusText === "string") member.statusText = store.statusText;
        if (typeof store.statusExpiresAtMs === "number") {
          member.statusExpiresAtMs = store.statusExpiresAtMs;
        }
        return jsonResponse(200, { members: [member] });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const setBodies: string[] = [];
    const originalFetch = fetchMock;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PUT") {
        setBodies.push(String(init?.body));
      }
      return originalFetch(input, init);
    });

    await setPresenceStatus(WS, {
      status: "auto",
      statusEmoji: "📅",
      statusText: "회의 중",
      statusExpiresAtMs: NOW + 3_600_000,
    });
    expect(setBodies[0]).toBe(
      `{"status":"auto","statusEmoji":"📅","statusText":"회의 중","statusExpiresAtMs":${NOW + 3_600_000}}`
    );

    let roster = await fetchRoster(WS);
    expect(roster).toHaveLength(1);
    expect(roster[0]?.presenceStatus).toBe("auto");
    expect(roster[0]?.statusEmoji).toBe("📅");
    expect(roster[0]?.statusText).toBe("회의 중");
    expect(visibleCustomStatus(roster[0] as RosterMember, NOW)?.text).toBe("회의 중");

    await setPresenceStatus(WS, { status: "away" });
    expect(setBodies[1]).toBe('{"status":"away"}');
    expect(setBodies[1]).not.toContain("statusEmoji");
    expect(setBodies[1]).not.toContain("null");

    roster = await fetchRoster(WS);
    expect(roster[0]?.presenceStatus).toBe("away");
    expect(roster[0]?.statusEmoji).toBe("📅");
    expect(roster[0]?.statusText).toBe("회의 중");

    await setPresenceStatus(WS, {
      status: "away",
      statusEmoji: null,
      statusText: null,
      statusExpiresAtMs: null,
    });
    expect(setBodies[2]).toBe(
      '{"status":"away","statusEmoji":null,"statusText":null,"statusExpiresAtMs":null}'
    );

    roster = await fetchRoster(WS);
    expect(roster[0]?.presenceStatus).toBe("away");
    expect(roster[0]?.statusEmoji).toBeUndefined();
    expect(roster[0]?.statusText).toBeUndefined();
    expect(visibleCustomStatus(roster[0] as RosterMember, NOW)).toBeNull();
  });

  it("reads own GET as a snapshot without inventing custom fields", async () => {
    installHost();
    vi.stubGlobal("fetch", async () => jsonResponse(200, { status: "dnd" }));
    const snapshot = await fetchPresenceStatus(WS);
    expect(snapshot).toEqual({ status: "dnd" });
  });
});
