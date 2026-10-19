import { afterEach, describe, expect, it, vi } from "vitest";
import githubManifest from "../../../../server/Fixtures/plugin-manifests/github.json";
// ADR-0113 증보 P-S1 (#3859): bytes the Rust server answered, pinned by
// server-rust/bins/momo-server/tests/plugin_registry_read_conformance_pg.rs.
import rustCatalog from "../../../../server/Fixtures/plugin-wire/catalog.json";
import rustGithubDetail from "../../../../server/Fixtures/plugin-wire/detail-github.json";
// ADR-0113 P3 (#3914): the four writes' answers, pinned by
// server-rust/bins/momo-server/tests/plugin_registry_write_conformance_pg.rs
// (per-run uuids are the all-zero placeholder).
import rustGrant from "../../../../server/Fixtures/plugin-wire/mutation-grant.json";
import rustInstall from "../../../../server/Fixtures/plugin-wire/mutation-install.json";
import rustRevokeGrant from "../../../../server/Fixtures/plugin-wire/mutation-revoke-grant.json";
import rustUninstall from "../../../../server/Fixtures/plugin-wire/mutation-uninstall.json";
import {
  grantPluginScope,
  installPlugin,
  pluginCatalogFromWire,
  pluginDetailFromWire,
  revokePluginInstall,
  revokePluginScope,
} from "@momo/core/lib/api";
import { installCoreHost, resetCoreHost, type SessionPort } from "@momo/core/runtime/host";
import { WireShapeError } from "@momo/core/lib/wire";

// These responses are assembled from the registry manifest the server seeds,
// then shaped exactly as PluginCatalogResponse / PluginDetailResponse declare.
// The test must not invent a lookalike payload: the manifest is the sender's
// source for tool names, scopes, risk, egress domains, publisher and license.
const approvalTiers: Record<string, string> = githubManifest.momo.approvalTier;

const catalogFixture = {
  plugins: [{
    pluginId: githubManifest.plugin.id,
    name: githubManifest.plugin.name,
    version: githubManifest.plugin.version,
    description: githubManifest.plugin.description,
    official: true,
    recommended: true,
    egressDomains: githubManifest.momo.egressDomains,
    recommendedFor: githubManifest.momo.recommendedFor,
    installed: true,
    enabled: true,
  }],
  toolPolicy: {
    plugins: [{
      pluginId: githubManifest.plugin.id,
      mcp: { url: githubManifest.mcp.url, transport: githubManifest.mcp.transport },
      egressDomains: githubManifest.momo.egressDomains,
      tools: githubManifest.mcp.tools.map((tool) => ({
        name: tool.name,
        risk: tool.risk,
        approvalTier: approvalTiers[tool.name],
      })),
    }],
  },
};

const detailFixture = {
  plugin: {
    // PluginDetailResponse does not repeat catalog-only `recommended`.
    pluginId: catalogFixture.plugins[0].pluginId,
    name: catalogFixture.plugins[0].name,
    version: catalogFixture.plugins[0].version,
    description: catalogFixture.plugins[0].description,
    official: catalogFixture.plugins[0].official,
    egressDomains: catalogFixture.plugins[0].egressDomains,
    recommendedFor: catalogFixture.plugins[0].recommendedFor,
    installed: catalogFixture.plugins[0].installed,
    enabled: catalogFixture.plugins[0].enabled,
    manifest: githubManifest,
  },
};

describe("plugin API wire boundary", () => {
  it("reads catalog policy from the server manifest-derived fixture", () => {
    const catalog = pluginCatalogFromWire(catalogFixture);
    expect(catalog.plugins[0]?.pluginId).toBe("com.momo.plugins.github");
    // Migration 142 (#3944): the measured catalogue has read tools and grade B writes.
    expect(catalog.toolsByPlugin.get("com.momo.plugins.github")?.map((tool) => tool.risk))
      .toEqual(githubManifest.mcp.tools.map((tool) => tool.risk));
  });

  it("reads publisher, provenance, tools and scopes from the original manifest", () => {
    const detail = pluginDetailFromWire(detailFixture);
    expect(detail.publisherName).toBe("GitHub");
    expect(detail.publisherVerified).toBe(true);
    expect(detail.license).toBe("MIT");
    expect(detail.tools[0]).toMatchObject({
      name: githubManifest.mcp.tools[0].name,
      scopes: [githubManifest.mcp.tools[0].scopes[0]],
      risk: "read",
      approvalTier: "read_only",
    });
  });

  it("reads momo.hosted so the consent window can tell a server-held connection apart (#3943)", () => {
    // 서버가 연결을 들고 있는 앱(팀 공유 드라이브)만 true다. 필드가 없으면 undefined(옛 서버는 D1-A로 읽는다).
    expect(pluginDetailFromWire(detailFixture).hosted).toBeUndefined();
    const hostedManifest = { ...githubManifest, momo: { ...githubManifest.momo, hosted: true } };
    expect(pluginDetailFromWire({
      plugin: { ...detailFixture.plugin, manifest: hostedManifest },
    }).hosted).toBe(true);
  });

  it("reads momo.preview and tool approvalPolicy for the app screen v2 (#3949)", () => {
    // 필드가 없는 매니페스트(공식 네 앱의 옛 시드)는 preview가 undefined, 도구 approvalPolicy도 있는 그대로다.
    const plain = pluginDetailFromWire(detailFixture);
    expect(plain.preview).toBeUndefined();
    expect(plain.tools[0].approvalPolicy).toBe(githubManifest.mcp.tools[0].approvalPolicy);
    const previewManifest = { ...githubManifest, momo: { ...githubManifest.momo, preview: true } };
    expect(pluginDetailFromWire({
      plugin: { ...detailFixture.plugin, manifest: previewManifest },
    }).preview).toBe(true);
    // 불리언이 아닌 값은 읽지 않는다(서버 검증기가 이미 거절하지만 화면이 문자열 「yes」를 칩으로 읽지 않게).
    expect(pluginDetailFromWire({
      plugin: { ...detailFixture.plugin, manifest: { ...githubManifest, momo: { ...githubManifest.momo, preview: "yes" } } },
    }).preview).toBeUndefined();
  });

  it("keeps optional display metadata absent until the server sends it", () => {
    expect(pluginDetailFromWire(detailFixture).termsURL).toBeUndefined();
    const display = pluginDetailFromWire({
      plugin: {
        ...detailFixture.plugin,
        // Values come from the PluginManifestValidator display test vector.
        termsURL: "https://publisher.example/terms",
        privacyPolicyURL: "https://publisher.example/privacy",
        iconText: "GH",
      },
    });
    expect(display).toMatchObject({
      termsURL: "https://publisher.example/terms",
      privacyPolicyURL: "https://publisher.example/privacy",
      iconText: "GH",
    });
  });

  it.each([null, {}, { plugins: null }, { plugins: [{ pluginId: 3 }] }])(
    "rejects malformed catalog response %j into an inline error state",
    (body) => expect(() => pluginCatalogFromWire(body)).toThrow(WireShapeError)
  );

  it.each([null, {}, { plugin: null }, { plugin: { ...detailFixture.plugin, manifest: [] } }])(
    "rejects malformed detail response %j into an inline error state",
    (body) => expect(() => pluginDetailFromWire(body)).toThrow(WireShapeError)
  );

  // ⑤ of ADR-0113 증보 P-S1: the Rust read routes answer what this parser
  // already accepts. Not a lookalike — the fixture is the server's response.
  it("accepts the Rust server's catalog response", () => {
    const catalog = pluginCatalogFromWire(rustCatalog);
    expect(catalog.plugins.map((plugin) => plugin.pluginId)).toEqual([
      "com.momo.plugins.drive",
      "com.momo.plugins.github",
      "com.momo.plugins.gmail",
      "com.momo.plugins.google-calendar",
      "com.momo.plugins.google-drive",
      "com.momo.plugins.linear",
      "com.momo.plugins.notion",
    ]);
    const github = catalog.plugins.find((plugin) => plugin.pluginId === "com.momo.plugins.github");
    expect(github).toMatchObject({ installed: true, enabled: true, official: true, recommended: true });
    // The policy lists what I granted (github:read): every read tool of the manifest, no write.
    const policy = catalog.toolsByPlugin.get("com.momo.plugins.github") ?? [];
    const readTools = githubManifest.mcp.tools.filter((tool) => tool.scopes.includes("github:read"));
    expect(policy.map((tool) => tool.name).sort()).toEqual(readTools.map((tool) => tool.name).sort());
    expect(policy.every((tool) => tool.risk === "read" && tool.approvalTier === "read_only")).toBe(true);
    expect(policy.map((tool) => tool.name)).toContain("github.search_repositories");
    expect(policy.map((tool) => tool.name)).not.toContain("github.list_repositories");
  });

  it("accepts the Rust server's manifest detail response", () => {
    const detail = pluginDetailFromWire(rustGithubDetail);
    expect(detail).toMatchObject({
      pluginId: "com.momo.plugins.github",
      publisherName: "GitHub",
      publisherVerified: true,
      license: "MIT",
      provenanceURL: "https://github.com/github/github-mcp-server",
    });
    expect(detail.tools.map((tool) => [tool.name, tool.scopes, tool.approvalTier])).toEqual(
      githubManifest.mcp.tools.map((tool) => [
        tool.name,
        tool.scopes,
        approvalTiers[tool.name],
      ])
    );
  });
});

// ADR-0113 P3 (#3914): the deployed core calls, fed the Rust server's answers.
// Not a lookalike — each response body is the file the PG conformance suite
// pins byte for byte; each request is what the Rust handlers accept (the body
// is exactly the documented object, because the server refuses any other key).
describe("plugin write calls against the Rust server's answers (ADR-0113 P3)", () => {
  const GITHUB = "com.momo.plugins.github";
  const ZERO = "00000000-0000-0000-0000-000000000000";

  afterEach(() => {
    vi.unstubAllGlobals();
    resetCoreHost();
  });

  function answering(fixture: unknown, status: number) {
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
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(fixture), {
        status,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("installs with exactly the body the server accepts and parses the answer", async () => {
    const fetchMock = answering(rustInstall, 201);
    await expect(installPlugin("ws-1", GITHUB)).resolves.toEqual({
      pluginId: GITHUB,
      status: "enabled",
      enabled: true,
      capabilities: [],
      memberId: undefined,
      scope: undefined,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://oort.test/v1/workspaces/ws-1/plugins/${GITHUB}/install`,
      expect.objectContaining({ method: "POST", body: '{"enabled":true}' })
    );
  });

  it("grants one scope for the caller and parses the capabilities it projected", async () => {
    const fetchMock = answering(rustGrant, 201);
    await expect(grantPluginScope("ws-1", GITHUB, "github:read")).resolves.toEqual({
      pluginId: GITHUB,
      memberId: ZERO,
      scope: "github:read",
      status: "active",
      enabled: true,
      capabilities: rustGrant.capabilities,
    });
    expect(rustGrant.capabilities).toContain("github.search_issues");
    expect(fetchMock).toHaveBeenCalledWith(
      `https://oort.test/v1/workspaces/ws-1/plugins/${GITHUB}/grants`,
      expect.objectContaining({ method: "POST", body: '{"scope":"github:read"}' })
    );
  });

  it("revokes a scope by its encoded path and an install without a body", async () => {
    const revoke = answering(rustRevokeGrant, 200);
    await expect(revokePluginScope("ws-1", GITHUB, "github:read")).resolves.toMatchObject({
      status: "revoked",
      scope: "github:read",
      capabilities: [],
    });
    expect(revoke).toHaveBeenCalledWith(
      `https://oort.test/v1/workspaces/ws-1/plugins/${GITHUB}/grants/github%3Aread`,
      expect.objectContaining({ method: "DELETE" })
    );
    vi.unstubAllGlobals();
    resetCoreHost();

    const uninstall = answering(rustUninstall, 200);
    await expect(revokePluginInstall("ws-1", GITHUB)).resolves.toMatchObject({
      pluginId: GITHUB,
      status: "revoked",
      enabled: false,
    });
    const [, init] = uninstall.mock.calls[0] as [unknown, RequestInit];
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });

  it("carries the D5 egress receipt only where access is extended, and no credential key", () => {
    expect(rustInstall.egressDomains).toEqual(["api.githubcopilot.com"]);
    expect(rustGrant.egressDomains).toEqual(["api.githubcopilot.com"]);
    expect("egressDomains" in rustRevokeGrant).toBe(false);
    expect("egressDomains" in rustUninstall).toBe(false);
    const keys = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          keys.add(key);
          walk(child);
        }
      }
    };
    [rustInstall, rustGrant, rustRevokeGrant, rustUninstall].forEach(walk);
    expect([...keys].sort()).toEqual([
      "auditRef",
      "capabilities",
      "egressDomains",
      "enabled",
      "memberId",
      "pluginId",
      "scope",
      "status",
    ]);
    expect([...keys].some((key) => /token|secret|credential|password|authorization|api_?key/i.test(key)))
      .toBe(false);
  });
});
