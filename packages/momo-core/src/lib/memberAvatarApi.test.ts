import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import {
  MEMBER_AVATAR_MAX_BYTES,
  MEMBER_AVATAR_MIMES,
  completeMyAvatarUpload,
  createMyAvatarUpload,
  fetchMemberAvatar,
  fetchWorkspaceAvatar,
  removeMyAvatar,
} from "./api";
import { WireShapeError } from "./wire";

// ADR-0161 증보 (#3277): 멤버 아바타 클라이언트. 서버 쪽 규칙(self-only·매직 넘버·
// 허용 mime)은 server-rust 의 member_avatar_pg 가 증명하고, 여기서는 와이어 계약과
// 「베어러를 아무 주소에나 싣지 않는다」만 고정한다.

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
const ME = "00000000-0000-7000-8000-000000000101";
const MEDIA = "00000000-0000-7000-8000-0000000000aa";
const CONTENT = `/v1/workspaces/${WS}/members/${ME}/avatar/content?v=${MEDIA}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("member avatar constants", () => {
  it("mirror the server allow-list: four raster types, no SVG, 5 MiB", () => {
    expect([...MEMBER_AVATAR_MIMES]).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
    ]);
    expect(MEMBER_AVATAR_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe("createMyAvatarUpload", () => {
  it("POSTs members/me/avatar/uploads — never a path naming a member", async () => {
    installHost();
    const fetchMock = vi.fn(async () =>
      json({ id: MEDIA, status: "pending", uploadUrl: "https://drive.test/u/1" }, 201)
    );
    vi.stubGlobal("fetch", fetchMock);
    const file = { name: "me.png", mime: "image/png", size: 4 };

    await expect(createMyAvatarUpload(WS, file)).resolves.toEqual({
      id: MEDIA,
      status: "pending",
      uploadUrl: "https://drive.test/u/1",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://oort.test/v1/workspaces/${WS}/members/me/avatar/uploads`,
      expect.objectContaining({ method: "POST", body: JSON.stringify(file) })
    );
  });

  it("refuses a response without the capability URL", async () => {
    installHost();
    vi.stubGlobal("fetch", vi.fn(async () => json({ id: MEDIA, status: "pending" }, 201)));
    await expect(
      createMyAvatarUpload(WS, { name: "me.png", mime: "image/png", size: 4 })
    ).rejects.toBeInstanceOf(WireShapeError);
  });
});

describe("completeMyAvatarUpload", () => {
  it("POSTs complete and returns the versioned avatarUrl", async () => {
    installHost();
    const fetchMock = vi.fn(async () =>
      json({ id: MEDIA, memberId: ME, status: "complete", avatarUrl: CONTENT, extra: 1 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeMyAvatarUpload(WS, MEDIA)).resolves.toEqual({
      id: MEDIA,
      memberId: ME,
      status: "complete",
      avatarUrl: CONTENT,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://oort.test/v1/workspaces/${WS}/members/me/avatar/${MEDIA}/complete`,
      expect.objectContaining({ method: "POST" })
    );
  });

  it("refuses a completion that carries no avatarUrl", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ id: MEDIA, memberId: ME, status: "complete" }))
    );
    await expect(completeMyAvatarUpload(WS, MEDIA)).rejects.toBeInstanceOf(WireShapeError);
  });
});

describe("removeMyAvatar", () => {
  it("DELETEs members/me/avatar and tolerates the empty 204", async () => {
    installHost();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(removeMyAvatar(WS)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      `https://oort.test/v1/workspaces/${WS}/members/me/avatar`,
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("surfaces a refusal rather than pretending the avatar is gone", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "only a human member can change their profile picture" }, 403))
    );
    await expect(removeMyAvatar(WS)).rejects.toMatchObject({ status: 403 });
  });
});

describe("fetchMemberAvatar", () => {
  it("fetches the same-origin content path with the bearer", async () => {
    installHost();
    const fetchMock = vi.fn(
      async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const blob = await fetchMemberAvatar(CONTENT);
    expect(blob.size).toBe(3);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://oort.test${CONTENT}`);
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer access-token");
  });

  it("never sends the bearer to anything that is not a member avatar content path", async () => {
    installHost();
    const fetchMock = vi.fn(async () => new Response("x", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    for (const hostile of [
      "https://evil.test/v1/workspaces/w/members/m/avatar/content",
      "//evil.test/v1/workspaces/w/members/m/avatar/content",
      `/v1/workspaces/${WS}/avatar/content?v=${MEDIA}`, // the workspace's, not a member's
      `/v1/workspaces/${WS}/members/${ME}/avatar/content/../../secret`,
      `/v1/workspaces/${WS}/members/${ME}/messages`,
      "",
    ]) {
      await expect(fetchMemberAvatar(hostile), hostile).rejects.toMatchObject({ status: 400 });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the workspace avatar path working (shared fetch)", async () => {
    installHost();
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([9]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const blob = await fetchWorkspaceAvatar(`/v1/workspaces/${WS}/avatar/content?v=${MEDIA}`);
    expect(blob.size).toBe(1);
    await expect(fetchWorkspaceAvatar(CONTENT)).rejects.toMatchObject({ status: 400 });
  });

  it("propagates a 404 for a member with no avatar", async () => {
    installHost();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    await expect(fetchMemberAvatar(CONTENT)).rejects.toMatchObject({ status: 404 });
  });
});
