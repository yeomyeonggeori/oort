import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isUnfurlIconPath,
  isUnfurlImagePath,
  isUnfurlPreviewIconPath,
  isUnfurlPreviewImagePath,
  isUnfurlProxyPath,
  messageUnfurlFromWire,
  unfurlPreviewFromWire,
} from "../features/timeline/unfurl";
import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import {
  fetchUnfurlImage,
  fetchUnfurlPreview,
  sendMessage,
  sendThreadReply,
} from "./api";

// ADR-0170 증보 2026-11-01 (#4884): the card of a link that is still in the composer, and
// 「미리보기 없이 보내기」.

const WS = "11111111-1111-4111-8111-111111111111";
const CH = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";
const IMAGE = `/v1/workspaces/${WS}/unfurl-previews/${ID}/image`;
const ICON = `/v1/workspaces/${WS}/unfurl-previews/${ID}/icon`;

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("unfurl preview decoder", () => {
  const ok = {
    url: "https://news.example/story",
    status: "ok",
    id: ID,
    title: "Story",
    description: "A story.",
    domain: "news.example",
    siteName: "News Example",
    imageUrl: IMAGE,
    iconUrl: ICON,
    imageWidth: 1200,
    imageHeight: 630,
    isVideo: true,
  };

  it("decodes an ok preview into the keys of a stored card without a message", () => {
    expect(unfurlPreviewFromWire(ok)).toEqual({
      id: ID,
      url: "https://news.example/story",
      status: "ok",
      title: "Story",
      description: "A story.",
      domain: "news.example",
      siteName: "News Example",
      imageUrl: IMAGE,
      iconUrl: ICON,
      imageWidth: 1200,
      imageHeight: 630,
      isVideo: true,
    });
    expect(unfurlPreviewFromWire(ok)).not.toHaveProperty("messageId");
  });

  it("reads failed as one bare shape and drops anything the server never sends", () => {
    expect(
      unfurlPreviewFromWire({ url: "https://news.example/story", status: "failed" })
    ).toEqual({ status: "failed", url: "https://news.example/story" });
    // Fields that ride along a failure are not read.
    expect(
      unfurlPreviewFromWire({
        url: "https://news.example/story",
        status: "failed",
        title: "leaked",
      })
    ).toEqual({ status: "failed", url: "https://news.example/story" });
    // A preview has two states. `blocked` and `pending` are a stored card's, and a server that
    // sent one here is not the server this decoder was written for.
    for (const status of ["blocked", "pending", "", "OK", undefined]) {
      expect(
        unfurlPreviewFromWire({ url: "https://news.example/story", status })
      ).toBeNull();
    }
    // An ok that names nothing to fetch the picture by, a bad address and non-objects.
    expect(unfurlPreviewFromWire({ ...ok, id: undefined })).toBeNull();
    expect(unfurlPreviewFromWire({ ...ok, id: "" })).toBeNull();
    expect(unfurlPreviewFromWire({ ...ok, url: "javascript:alert(1)" })).toBeNull();
    expect(unfurlPreviewFromWire({ ...ok, url: undefined })).toBeNull();
    for (const bad of [null, undefined, 3, "ok", []]) {
      expect(unfurlPreviewFromWire(bad)).toBeNull();
    }
  });

  it("lets a picture or icon name a preview path and nothing else", () => {
    const remote = "https://remote.example/hero.png";
    const storedCard = `/v1/workspaces/${WS}/unfurls/${ID}/image`;
    for (const imageUrl of [remote, storedCard, `${IMAGE}?x=1`, `${IMAGE}/extra`, ICON]) {
      const decoded = unfurlPreviewFromWire({ ...ok, imageUrl });
      expect(decoded).not.toBeNull();
      expect(decoded).not.toHaveProperty("imageUrl");
    }
    for (const iconUrl of [
      "https://remote.example/favicon.ico",
      `/v1/workspaces/${WS}/unfurls/${ID}/icon`,
      `${ICON}.svg`,
      IMAGE,
    ]) {
      expect(unfurlPreviewFromWire({ ...ok, iconUrl })).not.toHaveProperty("iconUrl");
    }
    // The other way round too: a stored card does not take a preview path.
    expect(
      messageUnfurlFromWire({
        id: "u-1",
        messageId: "m-1",
        url: "https://news.example/story",
        status: "ok",
        imageUrl: IMAGE,
        iconUrl: ICON,
      })
    ).toEqual({
      id: "u-1",
      messageId: "m-1",
      url: "https://news.example/story",
      status: "ok",
    });
  });

  it("keeps the size a pair and a video a yes", () => {
    expect(unfurlPreviewFromWire({ ...ok, imageHeight: undefined })).not.toHaveProperty(
      "imageWidth"
    );
    expect(unfurlPreviewFromWire({ ...ok, imageWidth: 0 })).not.toHaveProperty("imageHeight");
    expect(unfurlPreviewFromWire({ ...ok, imageWidth: 16385 })).not.toHaveProperty(
      "imageWidth"
    );
    expect(unfurlPreviewFromWire({ ...ok, isVideo: false })).not.toHaveProperty("isVideo");
    expect(unfurlPreviewFromWire({ ...ok, isVideo: "true" })).not.toHaveProperty("isVideo");
  });
});

describe("unfurl proxy paths", () => {
  it("knows the four paths a link card's remote image may have and no other", () => {
    expect(isUnfurlPreviewImagePath(IMAGE)).toBe(true);
    expect(isUnfurlPreviewIconPath(ICON)).toBe(true);
    expect(isUnfurlPreviewImagePath(ICON)).toBe(false);
    expect(isUnfurlPreviewIconPath(IMAGE)).toBe(false);
    // The two families do not shadow each other.
    expect(isUnfurlImagePath(IMAGE)).toBe(false);
    expect(isUnfurlIconPath(ICON)).toBe(false);
    for (const path of [
      IMAGE,
      ICON,
      `/v1/workspaces/${WS}/unfurls/${ID}/image`,
      `/v1/workspaces/${WS}/unfurls/${ID}/icon`,
    ]) {
      expect(isUnfurlProxyPath(path)).toBe(true);
    }
    for (const path of [
      "https://remote.example/hero.png",
      `//remote.example${IMAGE}`,
      `${IMAGE}?x=1`,
      `${IMAGE}#frag`,
      `${IMAGE}/extra`,
      `/v1/workspaces/${WS}/unfurl-previews/${ID}/other`,
      `/v1/workspaces/${WS}/unfurl-previews//image`,
      `/v2/workspaces/${WS}/unfurl-previews/${ID}/image`,
      "",
    ]) {
      expect(isUnfurlProxyPath(path), path).toBe(false);
    }
  });

  it("attaches the bearer to a preview picture and still refuses a remote host", async () => {
    installHost();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { "content-type": "image/png" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchUnfurlImage("https://remote.example/hero.png")).rejects.toMatchObject({
      status: 400,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(fetchUnfurlImage(IMAGE)).resolves.toBeInstanceOf(Blob);
    await expect(fetchUnfurlImage(ICON)).resolves.toBeInstanceOf(Blob);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `https://oort.test${IMAGE}`,
      `https://oort.test${ICON}`,
    ]);
    for (const call of fetchMock.mock.calls) {
      expect((call[1]?.headers as Headers).get("Authorization")).toBe("Bearer access-token");
    }
  });
});

describe("unfurl preview request", () => {
  it("posts one address, in a body, to the channel's route", async () => {
    installHost();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      json({
        url: "https://news.example/story?t=secret",
        status: "ok",
        id: ID,
        title: "Story",
        imageUrl: IMAGE,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchUnfurlPreview(WS, CH, "https://news.example/story?t=secret")
    ).resolves.toMatchObject({ status: "ok", id: ID, imageUrl: IMAGE });

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    // The address rides in the body: never in the path or the query, where a log would keep it.
    expect(input).toBe(
      `https://oort.test/v1/workspaces/${WS}/channels/${CH}/unfurl-previews`
    );
    expect(String(input)).not.toContain("secret");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe('{"url":"https://news.example/story?t=secret"}');
  });

  it("drops the ask when the composer moves on", async () => {
    installHost();
    // A request that is still in flight when the caller aborts: the transport relays the abort
    // to what `fetch` was given, and the caller's own abort comes back untouched.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError"))
            );
          })
      )
    );
    const controller = new AbortController();
    const pending = fetchUnfurlPreview(
      WS,
      CH,
      "https://news.example/story",
      controller.signal
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("answers failed as failed and refuses a shape it does not know", async () => {
    installHost();
    const answers: Response[] = [
      json({ url: "https://news.example/story", status: "failed" }),
      json({ url: "https://news.example/story", status: "blocked" }),
      json({ status: "ok" }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answers.shift() as Response)
    );
    await expect(fetchUnfurlPreview(WS, CH, "https://news.example/story")).resolves.toEqual({
      status: "failed",
      url: "https://news.example/story",
    });
    await expect(fetchUnfurlPreview(WS, CH, "https://news.example/story")).rejects.toThrow();
    await expect(fetchUnfurlPreview(WS, CH, "https://news.example/story")).rejects.toThrow();
  });

  it("lets a 429 through with its status, for the caller to wait out", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "rate limited" }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "1" },
          })
      )
    );
    await expect(fetchUnfurlPreview(WS, CH, "https://news.example/story")).rejects.toMatchObject({
      status: 429,
    });
  });
});

describe("sending without a preview", () => {
  function captureBody(): { bodies: () => Record<string, unknown>[] } {
    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ id: "m-1" }, 201);
      })
    );
    return { bodies: () => sent };
  }

  it("sends the key only when it is true, so every other send is byte for byte the old one", async () => {
    installHost();
    const { bodies } = captureBody();
    await sendMessage(WS, CH, "c-1", "https://news.example/story");
    await sendMessage(WS, CH, "c-2", "https://news.example/story", {});
    await sendMessage(WS, CH, "c-3", "https://news.example/story", { suppressUnfurl: false });
    await sendMessage(WS, CH, "c-4", "https://news.example/story", { suppressUnfurl: true });
    const [plain, empty, off, on] = bodies();
    for (const body of [plain, empty, off]) {
      expect(body).not.toHaveProperty("suppressUnfurl");
      expect(Object.keys(body).sort()).toEqual(["body", "clientMsgId", "type"]);
    }
    expect(on).toEqual({
      clientMsgId: "c-4",
      type: "text",
      body: "https://news.example/story",
      suppressUnfurl: true,
    });
  });

  it("is available on a thread reply with the same rule", async () => {
    installHost();
    const { bodies } = captureBody();
    await sendThreadReply(WS, CH, "root-1", "c-1", "https://news.example/story");
    await sendThreadReply(WS, CH, "root-1", "c-2", "https://news.example/story", {
      suppressUnfurl: false,
    });
    await sendThreadReply(WS, CH, "root-1", "c-3", "https://news.example/story", {
      suppressUnfurl: true,
      alsoInChannel: true,
    });
    const [plain, off, on] = bodies();
    expect(plain).not.toHaveProperty("suppressUnfurl");
    expect(off).not.toHaveProperty("suppressUnfurl");
    expect(on).toMatchObject({ suppressUnfurl: true, alsoInChannel: true, rootId: "root-1" });
  });
});
