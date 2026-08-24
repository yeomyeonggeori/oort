import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import {
  fetchMessageUnfurls,
  fetchUnfurlImage,
  fetchWorkspaceUnfurlSettings,
  removeMessageUnfurls,
  updateWorkspaceUnfurlSettings,
} from "./api";

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

describe("unfurl API", () => {
  it("decodes the REST projection and removes it with the author endpoint", async () => {
    installHost();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return new Response(JSON.stringify({ removed: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          unfurls: [
            {
              id: "u-1",
              messageId: "m-1",
              url: "https://example.com",
              status: "ok",
              title: "Example",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchMessageUnfurls("w-1", "m-1")).resolves.toHaveLength(1);
    await expect(removeMessageUnfurls("w-1", "m-1")).resolves.toEqual({
      removed: true,
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://oort.test/v1/workspaces/w-1/messages/m-1/unfurls",
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("round-trips workspace enablement without mixing in personal folding", async () => {
    installHost();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(
        JSON.stringify({
          enabled: init?.method === "PUT" ? false : true,
          updatedAtMs: 1_700_000_000_000,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWorkspaceUnfurlSettings("w-1")).resolves.toMatchObject({
      enabled: true,
    });
    await expect(updateWorkspaceUnfurlSettings("w-1", false)).resolves.toMatchObject({
      enabled: false,
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://oort.test/v1/workspaces/w-1/unfurl-settings",
      expect.objectContaining({ method: "PUT", body: '{"enabled":false}' })
    );
  });

  it("fetches image bytes only through the authenticated server proxy", async () => {
    installHost();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "content-type": "image/png" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchUnfurlImage("https://remote.example/image.png")
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      fetchUnfurlImage("/v1/workspaces/w-1/unfurls/u-1/image")
    ).resolves.toBeInstanceOf(Blob);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://oort.test/v1/workspaces/w-1/unfurls/u-1/image"
    );
    expect((init?.headers as Headers).get("Authorization")).toBe(
      "Bearer access-token"
    );
  });
});
