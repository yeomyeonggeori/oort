import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { WireShapeError } from "../../lib/wire";
import { canRenameChannel, channelRenameFailure, renameChannel } from "./rename";

// 채널 이름 바꾸기의 코어 계약 (ADR-0225 D10 · D13, 서버 계약: #5839 인계 0절).

describe("renameChannel on the wire", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("PATCHes only the name field and hands the answered channel through", async () => {
    const seen: { url: string; method: string; body: unknown }[] = [];
    const answered = { id: "c1", workspaceId: "w1", kind: "public", name: "디자인-리뷰", memberIds: [], browseListed: true, isDefault: false, muted: false };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), method: init?.method ?? "GET", body: JSON.parse(String(init?.body ?? "null")) });
      return new Response(JSON.stringify({ channel: answered }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const channel = await renameChannel("w1", "c1", "디자인-리뷰");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "PATCH", body: { name: "디자인-리뷰" } });
    expect(Object.keys(seen[0].body as object)).toEqual(["name"]);
    expect(seen[0].url).toMatch(/\/v1\/workspaces\/w1\/channels\/c1$/);
    expect(channel).toEqual(answered);
  });

  it("refuses an answer that is not a channel row", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ channel: { name: "x" } }), { status: 200, headers: { "Content-Type": "application/json" } })));
    await expect(renameChannel("w1", "c1", "x")).rejects.toThrow(WireShapeError);
  });
});

// 권한 · 대상 판정의 표. 문은 소유자 · 관리자에게만, general · DM · 보관 채널에는 서지 않는다.
describe("canRenameChannel", () => {
  const live = { kind: "public", name: "design-review" } as const;
  it.each([
    ["owner", live, true],
    ["admin", live, true],
    ["admin", { kind: "private", name: "leads" }, true],
    // 멤버 · 게스트 · 역할 모름에게는 문이 서지 않는다.
    ["member", live, false],
    ["guest", live, false],
    [undefined, live, false],
    // general 은 이름이 잠겼다(D10, 409 general_channel_locked).
    ["owner", { kind: "public", name: "general" }, false],
    ["admin", { kind: "public", name: "general" }, false],
    // DM · 보관 채널은 이 길로 바꾸지 않는다.
    ["owner", { kind: "dm" }, false],
    ["owner", { kind: "public", name: "old", archivedAtMs: 1 }, false],
  ] as const)("%s, %o -> %s", (role, channel, expected) => {
    expect(canRenameChannel(channel, role)).toBe(expected);
  });
});

describe("channelRenameFailure", () => {
  it.each([
    [new ApiError(409, "general channel name is locked", "general_channel_locked"), "generalLocked", "channels.rename.generalLocked"],
    // 다른 409 는 이름 겹침이고 만들기와 같은 문장 키를 쓴다.
    [new ApiError(409, "channel name already exists"), "duplicate", "channels.createFailure.duplicate"],
    [new ApiError(404, "channel not found"), "notFound", "channels.rename.notFound"],
    [new ApiError(403, "workspace owner or admin role required"), "forbidden", "channels.rename.forbidden"],
    [new ApiError(400, "channel name must use letters"), "rejected", "channels.nameRule.serverRejected"],
    [new ApiError(429, "rate limited", undefined, 30), "rateLimited", "channels.createFailure.rateLimited"],
    [new ApiError(500, "boom"), "generic", "channels.rename.generic"],
  ] as const)("%o -> %s", (error, kind, key) => {
    expect(channelRenameFailure(error)).toEqual({ kind, key });
  });

  it("carries the transport's own sentence for a network failure", () => {
    const failure = channelRenameFailure(new NetworkError("timeout", 15_000));
    expect(failure.kind).toBe("network");
    expect(failure.key).toBe("channels.rename.network");
    expect(failure.values?.reason).toContain("15초");
  });
});
