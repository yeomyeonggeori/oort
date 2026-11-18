import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { WireShapeError } from "../../lib/wire";
import { canSetChannelDefault, channelDefaultFailure, isOnlyVisibleDefault, setChannelDefault } from "./defaultChannel";

// 「기본 채널로 지정」의 코어 계약 (ADR-0224 D6, #5845). 서버 계약은 #5841 인계 0절: PATCH 한 칸, 답은 목록 줄과 같은 Channel.

describe("setChannelDefault on the wire", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("PATCHes only the isDefault field and hands the answered channel through", async () => {
    const seen: { url: string; method: string; body: unknown }[] = [];
    const answered = { id: "c1", workspaceId: "w1", kind: "public", name: "dump-alpha", memberIds: [], browseListed: true, isDefault: true, muted: false };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), method: init?.method ?? "GET", body: JSON.parse(String(init?.body ?? "null")) });
      return new Response(JSON.stringify({ channel: answered }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const channel = await setChannelDefault("w1", "c1", true);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("PATCH");
    expect(seen[0].body).toEqual({ isDefault: true });
    expect(seen[0].url).toMatch(/\/v1\/workspaces\/w1\/channels\/c1$/);
    expect(channel).toEqual(answered);
  });

  it("refuses an answer that is not a channel row", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ channel: { name: "x" } }), { status: 200, headers: { "Content-Type": "application/json" } })));
    await expect(setChannelDefault("w1", "c1", false)).rejects.toThrow(WireShapeError);
  });
});

describe("canSetChannelDefault", () => {
  const live = { kind: "public", isDefault: false } as const;
  it.each([
    ["owner", live, true],
    ["admin", { kind: "public", isDefault: true }, true],
    // 멤버 · 게스트 · 역할 모름에게는 문이 서지 않는다.
    ["member", live, false],
    ["guest", live, false],
    [undefined, live, false],
    // 공개가 아니면 서지 않는다(서버도 409 channel_not_defaultable).
    ["owner", { kind: "private", isDefault: false }, false],
    ["owner", { kind: "dm", isDefault: false }, false],
    ["owner", { kind: "public", isDefault: false, archivedAtMs: 1 }, false],
    // 표시를 싣지 않는 옛 서버: 문을 세우지 않는다.
    ["owner", { kind: "public" }, false],
  ] as const)("%s, %o -> %s", (role, channel, expected) => {
    expect(canSetChannelDefault(channel, role)).toBe(expected);
  });
});

describe("isOnlyVisibleDefault", () => {
  const me = { id: "A1", kind: "public", isDefault: true } as const;
  it.each([
    ["no other default in my list", [me, { id: "b", kind: "public", isDefault: false }], true],
    // 같은 채널이 대문자 · 소문자로 오가도 자기 자신은 「다른」 채널이 아니다.
    ["itself in another letter case", [{ ...me, id: "a1" }], true],
    ["another live public default", [me, { id: "b", kind: "public", isDefault: true }], false],
    // 보관된 기본 채널은 서버도 「남은 하나」로 세지 않는다(#5841 인계 1.2).
    ["an archived default does not count", [me, { id: "b", kind: "public", isDefault: true, archivedAtMs: 3 }], true],
    ["a list that is not loaded yet", undefined, false],
  ] as const)("%s -> %s", (_name, channels, expected) => {
    expect(isOnlyVisibleDefault(me, channels)).toBe(expected);
  });

  it("is false for a channel that is not a default", () => {
    expect(isOnlyVisibleDefault({ id: "a", isDefault: false }, [])).toBe(false);
    expect(isOnlyVisibleDefault({ id: "a" }, [])).toBe(false);
  });
});

describe("channelDefaultFailure", () => {
  it.each([
    [new ApiError(403, "only a human member can edit a channel"), "forbidden", "channels.browse.switchForbidden"],
    [new ApiError(404, "channel not found"), "notFound", "channels.browse.switchNotFound"],
    [new ApiError(409, "the last default channel cannot be turned off", "last_default_channel"), "lastDefault", "channels.default.lastDefault"],
    [new ApiError(409, "only a live public channel can be a default channel", "channel_not_defaultable"), "notDefaultable", "channels.default.notDefaultable"],
    // 코드 없는 409(이름 겹침 따위)는 이 줄의 말이 아니다.
    [new ApiError(409, "channel name already exists"), "generic", "channels.browse.switchGeneric"],
    [new ApiError(429, "rate limited", undefined, 30), "rateLimited", "channels.browse.rateLimited"],
    [new ApiError(500, "boom"), "generic", "channels.browse.switchGeneric"],
  ] as const)("%o -> %s", (error, kind, key) => {
    expect(channelDefaultFailure(error)).toEqual({ kind, key });
  });

  it("carries the transport's own sentence for a network failure", () => {
    const failure = channelDefaultFailure(new NetworkError("timeout", 15_000));
    expect(failure.kind).toBe("network");
    expect(failure.key).toBe("channels.browse.switchNetwork");
    expect(failure.values?.reason).toContain("15초");
  });
});
