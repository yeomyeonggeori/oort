import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { installCoreHost, resetCoreHost, type SessionPort } from "../../runtime/host";
import { WireShapeError } from "../../lib/wire";
import {
  getMemoryDigest,
  getMemorySettings,
  getRunMemoryReceipt,
  listMemoryDigests,
  patchChannelMemorySettings,
  patchMyMemorySettings,
  patchWorkspaceMemorySettings,
} from "./api";
import { memoryIsCaughtUp } from "./model";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const MSG = "00000000-0000-7000-8000-000000000301";
const DIGEST = "00000000-0000-7000-8000-000000000401";
const RUN = "00000000-0000-7000-8000-000000000501";

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

function digestWire(overrides: Record<string, unknown> = {}) {
  return {
    id: DIGEST,
    channelId: CH,
    level: "window",
    fromSeq: 4,
    toSeq: 9,
    body: "배포 일정이 정해졌어요",
    sourceCount: 1,
    createdAtMs: 1_800_000_000_000,
    evidence: [{ messageId: MSG, channelId: CH, seq: 7 }],
    ...overrides,
  };
}

describe("memory reads", () => {
  it("lists digests with the missed-conversation anchor and evidence links", async () => {
    installHost();
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        digests: [digestWire()],
        afterSeq: 3,
        summarizedThroughSeq: 9,
        nextCursor: "9.x",
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const page = await listMemoryDigests(WS, CH, { sinceLastRead: true, level: "window", limit: 5 });
    expect(page.afterSeq).toBe(3);
    expect(page.nextCursor).toBe("9.x");
    expect(page.digests[0].evidence).toEqual([{ messageId: MSG, channelId: CH, seq: 7 }]);
    expect(memoryIsCaughtUp(page, 9)).toBe(true);
    expect(memoryIsCaughtUp(page, 10)).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://oort.test/v1/workspaces/${WS}/channels/${CH}/memory/digests?level=window&sinceLastRead=true&limit=5`,
      expect.anything()
    );
  });

  it("treats an empty page as empty, not as an error", async () => {
    installHost();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { digests: [], afterSeq: 0 })));
    const page = await listMemoryDigests(WS, CH);
    expect(page).toEqual({ digests: [], afterSeq: 0 });
    expect(memoryIsCaughtUp(page, 0)).toBe(false);
  });

  it("rejects a malformed digest instead of rendering a partial one", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { digests: [digestWire({ level: "year" })], afterSeq: 0 }))
    );
    await expect(listMemoryDigests(WS, CH)).rejects.toBeInstanceOf(WireShapeError);
  });

  it("surfaces a hidden digest as a 404 ApiError", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(404, { error: { message: "digest not found" } }))
    );
    await expect(getMemoryDigest(WS, DIGEST)).rejects.toMatchObject({
      status: 404,
    });
    await expect(getMemoryDigest(WS, DIGEST)).rejects.toBeInstanceOf(ApiError);
  });

  it("reads a receipt; withheldCount is only there for the requester", async () => {
    installHost();
    const receipt = {
      runId: RUN,
      channelId: CH,
      servedCount: 2,
      digestIds: [DIGEST],
      digests: [digestWire()],
      budgetChars: 6000,
      usedChars: 900,
      createdAtMs: 1_800_000_001_000,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { receipt: { ...receipt, withheldCount: 3 } }))
      .mockResolvedValueOnce(jsonResponse(200, { receipt }));
    vi.stubGlobal("fetch", fetchMock);
    const mine = await getRunMemoryReceipt(WS, RUN);
    expect(mine.withheldCount).toBe(3);
    expect(mine.servedCount).toBe(2);
    const others = await getRunMemoryReceipt(WS, RUN);
    expect(others.withheldCount).toBeUndefined();
  });
});

describe("memory settings", () => {
  it("reads settings and sends only the fields set", async () => {
    installHost();
    const fetchMock = vi.fn(async (input: RequestInit | URL | string, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PATCH" && url.endsWith("/memory/settings/me")) {
        expect(JSON.parse(String(init.body))).toEqual({ paused: true });
        return jsonResponse(200, { paused: true });
      }
      if (init?.method === "PATCH" && url.endsWith(`/channels/${CH}/memory/settings`)) {
        expect(JSON.parse(String(init.body))).toEqual({ excluded: true });
        return jsonResponse(200, { channelId: CH, excluded: true, paused: false });
      }
      if (init?.method === "PATCH") {
        expect(JSON.parse(String(init.body))).toEqual({ enabled: false });
        return jsonResponse(200, { enabled: false, paused: false, resetEpoch: 0 });
      }
      return jsonResponse(200, {
        workspace: { enabled: true, paused: false, resetEpoch: 0 },
        channels: [{ channelId: CH, excluded: false, paused: true }],
        me: { paused: false },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const settings = await getMemorySettings(WS);
    expect(settings.channels[0]).toEqual({ channelId: CH, excluded: false, paused: true });
    expect(await patchWorkspaceMemorySettings(WS, { enabled: false })).toEqual({
      enabled: false,
      paused: false,
      resetEpoch: 0,
    });
    expect((await patchChannelMemorySettings(WS, CH, { excluded: true })).excluded).toBe(true);
    expect(await patchMyMemorySettings(WS, true)).toEqual({ paused: true });
  });

  it("surfaces a permission denial as a 403 ApiError", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(403, { error: { message: "not allowed" } }))
    );
    await expect(patchWorkspaceMemorySettings(WS, { enabled: false })).rejects.toMatchObject({
      status: 403,
    });
  });
});
