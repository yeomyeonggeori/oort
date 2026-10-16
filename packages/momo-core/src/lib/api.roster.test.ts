// ADR-0201 증보 v2 H2 (#3893): 로스터의 `aliases` 칸 — 읽을 수 없으면 칸만 버리고 멤버는 남긴다.
import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import { fetchRoster } from "./api";

const WS = "00000000-0000-7000-8000-000000000001";

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

function row(id: string, over: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    workspaceId: WS,
    kind: "agent",
    status: "active",
    displayName: "oort 도우미",
    handle: `h-${id}`,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

describe("fetchRoster aliases", () => {
  it("문법 안의 별칭만 정규화해 싣고, 못 읽는 칸은 버리되 멤버는 남긴다", async () => {
    installHost();
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          members: [
            row("a", { aliases: ["OORT", "오르트".normalize("NFD"), "<script>", 7] }),
            row("b", { aliases: "oort" }),
            row("c", { aliases: [] }),
            row("d", {}),
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const roster = await fetchRoster(WS);
    expect(roster.map((member) => member.id)).toEqual(["a", "b", "c", "d"]);
    expect(roster[0]?.aliases).toEqual(["oort", "오르트"]);
    expect("aliases" in (roster[1] ?? {})).toBe(false);
    expect("aliases" in (roster[2] ?? {})).toBe(false);
    expect("aliases" in (roster[3] ?? {})).toBe(false);
  });
});
