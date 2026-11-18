import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { WireShapeError } from "../../lib/wire";
import {
  browseChannelsPageFromWire,
  canBrowseChannelsNow,
  channelBrowseLoadFailure,
  channelJoinFailure,
  joinChannelResultFromWire,
  splitBrowseRows,
  type BrowseChannel,
} from "./browse";

// 둘러보기 · 참여의 코어 계약 (ADR-0224 D3 · D4 · D8, E2 #5838 인계 0절). 응답 예는 그 인계의 JSON 그대로다.

describe("browseChannelsPageFromWire", () => {
  it("reads the E2 list shape: topic and nextCursor are dropped keys, not empty strings", () => {
    const page = browseChannelsPageFromWire({
      channels: [
        { id: "1de7ee03", name: "dump-alpha", topic: "샘플 주제", memberCount: 1, isMember: false, isDefault: true },
        { id: "8cd6c660", name: "dump-beta", memberCount: 0, isMember: false, isDefault: false },
      ],
      nextCursor: "8cd6c660.64756d702d62657461",
    });
    expect(page.nextCursor).toBe("8cd6c660.64756d702d62657461");
    expect(page.channels[0]).toEqual({ id: "1de7ee03", name: "dump-alpha", topic: "샘플 주제", memberCount: 1, isMember: false, isDefault: true });
    expect("topic" in page.channels[1]).toBe(false);
    expect("nextCursor" in browseChannelsPageFromWire({ channels: [] })).toBe(false);
  });

  it("refuses a row without the fields a screen draws from", () => {
    expect(() => browseChannelsPageFromWire({ channels: [{ id: "x", name: "y", isMember: false, isDefault: false }] })).toThrow(WireShapeError);
    expect(() => browseChannelsPageFromWire({})).toThrow(WireShapeError);
  });
});

describe("joinChannelResultFromWire", () => {
  it("hands the channel row through untouched so the sidebar can stand it up as is", () => {
    const channel = { id: "1de7ee03", workspaceId: "c022f448", kind: "public", name: "dump-alpha", memberIds: [], browseListed: true, isDefault: true, muted: false };
    const result = joinChannelResultFromWire({ channel, newlyJoined: true });
    expect(result.newlyJoined).toBe(true);
    expect(result.channel).toEqual(channel);
  });

  it("refuses an answer without newlyJoined or a channel id", () => {
    expect(() => joinChannelResultFromWire({ channel: { id: "a", workspaceId: "w", kind: "public" } })).toThrow(WireShapeError);
    expect(() => joinChannelResultFromWire({ channel: { workspaceId: "w", kind: "public" }, newlyJoined: true })).toThrow(WireShapeError);
  });
});

describe("browseChannels / joinChannel on the wire", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends q trimmed and only when it says something, and POSTs the self route", async () => {
    const seen: { url: string; method: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), method: init?.method ?? "GET" });
      const body = String(url).includes("/members/me")
        ? { channel: { id: "c1", workspaceId: "w1", kind: "public", muted: false }, newlyJoined: false }
        : { channels: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const { browseChannels, joinChannel } = await import("./browse");
    await browseChannels("w1", { q: "  디자인 ", cursor: "c.1" });
    await browseChannels("w1", { q: "   " });
    await joinChannel("w1", "c1");
    expect(seen[0].url).toMatch(/\/v1\/workspaces\/w1\/channels\/browse\?q=%EB%94%94%EC%9E%90%EC%9D%B8&cursor=c.1$/);
    expect(seen[1].url).toMatch(/\/channels\/browse$/);
    expect(seen[2]).toMatchObject({ method: "POST" });
    expect(seen[2].url).toMatch(/\/v1\/workspaces\/w1\/channels\/c1\/members\/me$/);
  });
});

describe("canBrowseChannelsNow", () => {
  it.each([
    [true, "owner", true],
    [true, "admin", true],
    [true, "member", true],
    // 게스트에게는 문이 서지 않는다(ADR-0224 D8). 역할을 모르면 세우지 않는 쪽으로 틀린다.
    [true, "guest", false],
    [true, undefined, false],
    [false, "owner", false],
  ] as const)("roster settled %s, role %s -> %s", (settled, role, expected) => {
    expect(canBrowseChannelsNow(settled, role)).toBe(expected);
  });
});

describe("splitBrowseRows", () => {
  it("puts the channels you have not joined first and keeps the server order inside each group", () => {
    const row = (id: string, isMember: boolean): BrowseChannel => ({ id, name: id, memberCount: 1, isMember, isDefault: false });
    const { notJoined, joined } = splitBrowseRows([row("a", true), row("b", false), row("c", true), row("d", false)]);
    expect(notJoined.map((r) => r.id)).toEqual(["b", "d"]);
    expect(joined.map((r) => r.id)).toEqual(["a", "c"]);
  });
});

describe("failures by status", () => {
  it.each([
    [new ApiError(403, "guests cannot browse or join public channels"), "forbidden", "channels.browse.joinForbidden"],
    [new ApiError(404, "channel not found"), "notFound", "channels.browse.joinNotFound"],
    [new ApiError(429, "rate limited", undefined, 30), "rateLimited", "channels.browse.rateLimited"],
    [new ApiError(500, "boom"), "generic", "channels.browse.joinGeneric"],
  ] as const)("join %o -> %s", (error, kind, key) => {
    expect(channelJoinFailure(error)).toEqual({ kind, key });
  });

  it("carries the transport's own sentence for a network failure", () => {
    const failure = channelJoinFailure(new NetworkError("timeout", 15_000));
    expect(failure.kind).toBe("network");
    expect(failure.key).toBe("channels.browse.joinNetwork");
    expect(failure.values?.reason).toContain("15초");
    expect(channelBrowseLoadFailure(new NetworkError("unreachable", 15_000)).key).toBe("channels.browse.loadNetwork");
  });
});
