import { describe, expect, it } from "vitest";
import githubManifest from "../../../../server/Fixtures/plugin-manifests/github.json";
// ADR-0113 증보 P-S1 (#3859): bytes the Rust server answered, pinned by
// server-rust/bins/momo-server/tests/plugin_registry_read_conformance_pg.rs.
import rustCatalog from "../../../../server/Fixtures/plugin-wire/catalog.json";
import rustGithubDetail from "../../../../server/Fixtures/plugin-wire/detail-github.json";
import { pluginCatalogFromWire, pluginDetailFromWire } from "@momo/core/lib/api";
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
    expect(catalog.toolsByPlugin.get("com.momo.plugins.github")?.map((tool) => tool.risk))
      .toEqual(["read", "read"]);
  });

  it("reads publisher, provenance, tools and scopes from the original manifest", () => {
    const detail = pluginDetailFromWire(detailFixture);
    expect(detail.publisherName).toBe("GitHub");
    expect(detail.publisherVerified).toBe(true);
    expect(detail.license).toBe("MIT");
    expect(detail.tools[0]).toMatchObject({
      name: "github.list_repositories",
      scopes: ["github:read"],
      risk: "read",
      approvalTier: "read_only",
    });
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
      "com.momo.plugins.linear",
      "com.momo.plugins.notion",
    ]);
    const github = catalog.plugins.find((plugin) => plugin.pluginId === "com.momo.plugins.github");
    expect(github).toMatchObject({ installed: true, enabled: true, official: true, recommended: true });
    expect(catalog.toolsByPlugin.get("com.momo.plugins.github")).toEqual([
      { name: "github.list_repositories", risk: "read", approvalTier: "read_only" },
      { name: "github.search_issues", risk: "read", approvalTier: "read_only" },
    ]);
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
    expect(detail.tools.map((tool) => [tool.name, tool.scopes, tool.approvalTier])).toEqual([
      ["github.list_repositories", ["github:read"], "read_only"],
      ["github.search_issues", ["github:read"], "read_only"],
    ]);
  });
});
