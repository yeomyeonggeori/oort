import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { WireShapeError } from "../../lib/wire";
import {
  browseChannelsPageFromWire,
  canBrowseChannelsNow,
  canSetBrowseListed,
  channelBrowseLoadFailure,
  channelBrowseSwitchFailure,
  hiddenPublicChannels,
  setChannelBrowseListed,
  channelJoinFailure,
  channelPreviewFailure,
  channelPreviewFromWire,
  previewInReadingOrder,
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

// 「둘러보기에 보이기」 스위치 (ADR-0224 D2, #5843). 서버 계약은 #5839 인계 0절: PATCH 한 칸, 답은 목록 줄과 같은 Channel.
describe("setChannelBrowseListed on the wire", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("PATCHes only the browseListed field and hands the answered channel through", async () => {
    const seen: { url: string; method: string; body: unknown }[] = [];
    const answered = { id: "c1", workspaceId: "w1", kind: "public", name: "dump-alpha", memberIds: [], browseListed: false, isDefault: false, muted: false };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), method: init?.method ?? "GET", body: JSON.parse(String(init?.body ?? "null")) });
      return new Response(JSON.stringify({ channel: answered }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const channel = await setChannelBrowseListed("w1", "c1", false);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "PATCH", body: { browseListed: false } });
    expect(seen[0].url).toMatch(/\/v1\/workspaces\/w1\/channels\/c1$/);
    expect(channel).toEqual(answered);
  });

  it("refuses an answer that is not a channel row", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ channel: { name: "x" } }), { status: 200, headers: { "Content-Type": "application/json" } })));
    await expect(setChannelBrowseListed("w1", "c1", true)).rejects.toThrow(WireShapeError);
  });
});

describe("canSetBrowseListed", () => {
  const live = { kind: "public", browseListed: true } as const;
  it.each([
    ["owner", live, true],
    ["admin", { kind: "public", browseListed: false }, true],
    // 멤버 · 게스트 · 역할 모름에게는 문이 서지 않는다.
    ["member", live, false],
    ["guest", live, false],
    [undefined, live, false],
    // 공개가 아니면 서지 않는다(서버도 409 channel_not_listable).
    ["owner", { kind: "private", browseListed: false }, false],
    ["owner", { kind: "dm", browseListed: false }, false],
    // 표시를 싣지 않는 옛 서버: 문을 세우지 않는다.
    ["owner", { kind: "public" }, false],
    ["owner", { kind: "public", browseListed: true, archivedAtMs: 1 }, false],
  ] as const)("%s, %o -> %s", (role, channel, expected) => {
    expect(canSetBrowseListed(channel, role)).toBe(expected);
  });
});

describe("hiddenPublicChannels", () => {
  it("keeps only live public channels that are explicitly off, in the caller's order", () => {
    const rows = [
      { id: "a", kind: "public", browseListed: false },
      { id: "b", kind: "public", browseListed: true },
      { id: "c", kind: "public" },
      { id: "d", kind: "private", browseListed: false },
      { id: "e", kind: "public", browseListed: false, archivedAtMs: 5 },
      { id: "f", kind: "public", browseListed: false },
    ] as const;
    expect(hiddenPublicChannels(rows).map((r) => r.id)).toEqual(["a", "f"]);
  });
});

describe("channelBrowseSwitchFailure", () => {
  it.each([
    [new ApiError(403, "only a human member can edit a channel"), "forbidden", "channels.browse.switchForbidden"],
    [new ApiError(404, "channel not found"), "notFound", "channels.browse.switchNotFound"],
    [new ApiError(409, "only a live public channel can be shown in channel browse", "channel_not_listable"), "notListable", "channels.browse.switchNotListable"],
    // 다른 409(이름 겹침 따위)는 이 스위치의 말이 아니다.
    [new ApiError(409, "channel name already exists"), "generic", "channels.browse.switchGeneric"],
    [new ApiError(429, "rate limited", undefined, 30), "rateLimited", "channels.browse.rateLimited"],
    [new ApiError(500, "boom"), "generic", "channels.browse.switchGeneric"],
  ] as const)("%o -> %s", (error, kind, key) => {
    expect(channelBrowseSwitchFailure(error)).toEqual({ kind, key });
  });

  it("carries the transport's own sentence for a network failure", () => {
    const failure = channelBrowseSwitchFailure(new NetworkError("timeout", 15_000));
    expect(failure.kind).toBe("network");
    expect(failure.key).toBe("channels.browse.switchNetwork");
    expect(failure.values?.reason).toContain("15초");
  });
});

// 미리 보기(E3 #5840 인계 0절의 응답 예 그대로: 지워진 글은 body 없음, 글쓴이 이름이 빠질 수 있음, 최신 먼저).
describe("channelPreviewFromWire", () => {
  const wire = {
    channel: { id: "d3b22eb3", name: "pv-lounge", topic: "pv-topic", memberCount: 3, isMember: false },
    messages: [
      { id: "m3", body: "with-file", author: { displayName: "이도현", kind: "human" }, createdAtMs: 3, edited: false, deleted: false, replyCount: 0, attachmentNames: ["회의록.pdf"] },
      { id: "m2", author: { kind: "agent" }, createdAtMs: 2, edited: false, deleted: true, replyCount: 0, attachmentNames: [] },
      { id: "m1", body: "root-text", author: { displayName: "이도현", kind: "human" }, createdAtMs: 1, edited: true, deleted: false, replyCount: 1, attachmentNames: [] },
    ],
  };

  it("keeps the dropped keys dropped and flips the server's newest-first into reading order", () => {
    const preview = channelPreviewFromWire(wire);
    expect(preview.channel).toEqual({ id: "d3b22eb3", name: "pv-lounge", topic: "pv-topic", memberCount: 3, isMember: false });
    expect(preview.messages[1]).not.toHaveProperty("body");
    expect(preview.messages[1].author).toEqual({ kind: "agent" });
    expect(previewInReadingOrder(preview.messages).map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(preview.messages.map((m) => m.id)).toEqual(["m3", "m2", "m1"]);
  });

  it("refuses a message without the always-present keys", () => {
    expect(() =>
      channelPreviewFromWire({ ...wire, messages: [{ id: "x", author: { kind: "human" }, createdAtMs: 1 }] })
    ).toThrow(WireShapeError);
  });
});

describe("channelPreviewFailure", () => {
  it.each([
    [new ApiError(403, "guests cannot browse or join public channels"), "forbidden", "channels.preview.loadForbidden"],
    [new ApiError(404, "channel not found"), "notFound", "channels.preview.notFound"],
    [new ApiError(429, "rate limited", undefined, 30), "rateLimited", "channels.browse.rateLimited"],
    [new ApiError(500, "boom"), "generic", "channels.preview.loadGeneric"],
  ] as const)("%s", (error, kind, key) => {
    expect(channelPreviewFailure(error)).toEqual({ kind, key });
  });

  it("carries the transport's reason for a network failure", () => {
    expect(channelPreviewFailure(new NetworkError("timeout", 15_000))).toMatchObject({
      kind: "network",
      key: "channels.preview.loadNetwork",
    });
  });
});