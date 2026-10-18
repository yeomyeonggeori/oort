// `/앱` (#3950 U-S2): 앱 화면으로 가는 client 슬래시 한 줄. 앱 표면을 싣지 않는 서버에서는
// 슬래시 목록과 팔레트 모두에서 숨는다.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandContext, CommandEnv } from "./registry";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../capabilities/serverSurfaces");
});

async function load(plugins: boolean) {
  vi.resetModules();
  vi.doMock("../capabilities/serverSurfaces", async (importOriginal) => {
    const real = await importOriginal<typeof import("../capabilities/serverSurfaces")>();
    return {
      ...real,
      isSurfaceProvided: (id: Parameters<typeof real.isSurfaceProvided>[0]) =>
        id === "plugins" ? plugins : real.isSurfaceProvided(id),
    };
  });
  const registry = await import("./registry");
  const slash = await import("./slash");
  return { registry, slash };
}

const env = (isSurfaceProvided: (id: string) => boolean): CommandEnv =>
  ({
    showDrafts: true,
    canCreateChannel: true,
    isSurfaceProvided,
    agents: [],
    canOpenLocalCard: () => false,
  }) as CommandEnv;

describe("/앱 (#3950)", () => {
  it("앱 표면이 있는 서버: 슬래시 목록에 서고, 치면 앱 화면으로 간다", async () => {
    const { registry, slash } = await load(true);
    expect(registry.slashCommands().map((c) => c.id)).toContain("ai.apps");
    expect(slash.slashCandidates("앱", undefined, undefined, { cardAvailable: true })
      .map((row) => row.label)).toEqual(["/앱"]);
    const parsed = slash.parseSlashCommand("/앱");
    expect(parsed?.command.id).toBe("ai.apps");

    const navigate = vi.fn();
    const ctx = { navigate, session: { memberId: "m" }, workspaceId: "w" } as unknown as CommandContext;
    const result = parsed?.command.run(ctx, {});
    expect(navigate).toHaveBeenCalledWith("/ai/external/apps");
    // 메시지로 나가지 않고 입구를 닫는다.
    expect(result?.closesSurface).toBe(true);
  });

  it("앱 표면이 없는 서버(serverSurfaces 숨김): 슬래시 목록·파싱·팔레트 어디에도 없다", async () => {
    const { registry, slash } = await load(false);
    expect(registry.slashCommands().map((c) => c.id)).not.toContain("ai.apps");
    expect(slash.slashCandidates("앱", undefined, undefined, { cardAvailable: true })).toEqual([]);
    // 숨긴 명령은 평문이다: `/앱`이 메시지로 나갈 뿐 명령으로 먹히지 않는다.
    expect(slash.parseSlashCommand("/앱")).toBeNull();
    const ids = registry
      .visibleCommands(env((id) => id !== "plugins"))
      .map((command) => command.id);
    expect(ids).not.toContain("ai.apps");
  });

  it("폰의 슬래시 목록에는 서지 않는다(갈 화면이 아직 없다)", async () => {
    const { registry, slash } = await load(true);
    const phone = registry.slashCommands({ platform: "phone" });
    expect(phone.map((c) => c.id)).not.toContain("ai.apps");
    expect(phone.map((c) => c.id)).toContain("ai.connect");
    expect(slash.parseSlashCommand("/앱", phone)).toBeNull();
  });
});
