import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import { setAttachmentMedia } from "./api";
import { WireShapeError } from "./wire";

// ADR-0151 증보 9 (#5469): 올린 사진·GIF 의 가로세로를 서버에 선언하는 호출의 와이어. 서버 쪽 규칙(업로더·미묶임·범위·종류·매직)은
// server-rust 의 attachment_media_conformance_pg 가 증명하고, 여기서는 **무엇을 어디로 보내는가**와 응답을 어떻게 읽는가만 고정한다.

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
const CH = "00000000-0000-7000-8000-000000000201";
const ATT = "00000000-0000-7000-8000-0000000000aa";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("setAttachmentMedia", () => {
  it("PUTs the picture's request to …/attachments/{id}/media with the bearer, and reads the stored summary", async () => {
    installHost();
    const fetchMock = vi.fn(async () => json({ kind: "image", width: 4032, height: 3024 }));
    vi.stubGlobal("fetch", fetchMock);

    const stored = await setAttachmentMedia(WS, CH, ATT, { kind: "image", width: 4032, height: 3024 });

    expect(stored).toEqual({ kind: "image", width: 4032, height: 3024 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://oort.test/v1/workspaces/${WS}/channels/${CH}/attachments/${ATT}/media`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ kind: "image", width: 4032, height: 3024 });
    expect(Object.keys(JSON.parse(String(init.body))).sort()).toEqual(["height", "kind", "width"]);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer access-token");
  });

  it("encodes ids into the path (nothing a caller passes can add a path segment)", async () => {
    installHost();
    const fetchMock = vi.fn(async () => json({ kind: "image", width: 1, height: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    await setAttachmentMedia("w/s", "c?h", "a#t", { kind: "image", width: 1, height: 1 });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://oort.test/v1/workspaces/w%2Fs/channels/c%3Fh/attachments/a%23t/media");
  });

  it("fails loudly on a stored summary of a shape it cannot use (the caller treats any failure as 'no summary')", async () => {
    installHost();
    vi.stubGlobal("fetch", vi.fn(async () => json({ kind: "image", width: 0, height: 10 })));
    await expect(setAttachmentMedia(WS, CH, ATT, { kind: "image", width: 1, height: 1 })).rejects.toBeInstanceOf(
      WireShapeError,
    );
  });

  it("rejects when the server refuses (a sent file's 404, a range's 400, a rate limit's 429)", async () => {
    installHost();
    for (const status of [400, 403, 404, 422, 429, 500]) {
      vi.stubGlobal("fetch", vi.fn(async () => json({ error: { message: "no" } }, status)));
      await expect(setAttachmentMedia(WS, CH, ATT, { kind: "image", width: 1, height: 1 })).rejects.toBeTruthy();
    }
  });
});
