import { describe, expect, it } from "vitest";
import { resolveArtifact } from "./artifacts";
import type { TimelineMessage } from "./model";

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

function message(
  type: string,
  body?: string,
  props?: Record<string, unknown>
): TimelineMessage {
  return {
    id: "m1",
    seq: 1,
    type,
    ...(body !== undefined ? { body } : {}),
    ...(props !== undefined ? { props } : {}),
    authorMemberId: "member",
    createdAtMs: 1,
  };
}

describe("artifact detection parity", () => {
  it("prefers explicit artifact_kind diff and patch props", () => {
    const result = resolveArtifact(
      message("text", "ordinary", { artifact_kind: "diff", patch })
    );
    expect(result?.kind).toBe("diff");
    if (result?.kind === "diff") {
      expect(result.files[0]?.path).toBe("src/a.ts");
      expect([result.additions, result.deletions]).toEqual([1, 1]);
    }
  });

  it("supports the typed diff message fallback", () => {
    expect(resolveArtifact(message("diff", patch))?.kind).toBe("diff");
  });

  it("supports the legacy closed artifact kind", () => {
    expect(
      resolveArtifact(message("artifact", undefined, { kind: "commit" }))?.kind
    ).toBe("commit");
  });

  it("conservatively detects an unfenced unified diff", () => {
    expect(resolveArtifact(message("text", patch))?.kind).toBe("diff");
  });

  it("detects a fenced patch", () => {
    expect(
      resolveArtifact(message("text", `\`\`\`patch\n${patch}\n\`\`\``))?.kind
    ).toBe("diff");
  });

  it("does not promote prose with plus and minus lines", () => {
    expect(resolveArtifact(message("text", "notes\n-old\n+new"))).toBeNull();
  });

  it("builds a commit link card from bounded props", () => {
    const result = resolveArtifact(
      message("text", undefined, {
        artifact_kind: "commit",
        title: "Ship observer",
        repository: "momo",
        branch: "feat/605",
        url: "https://github.com/example/momo/commit/abc#diff",
      })
    );
    expect(result).toMatchObject({
      kind: "commit",
      title: "Ship observer",
      repository: "momo",
      branch: "feat/605",
      url: "https://github.com/example/momo/commit/abc",
    });
  });

  it("builds a PR card with the canonical fallback title", () => {
    expect(
      resolveArtifact(message("text", undefined, { artifact_kind: "pr" }))
    ).toEqual({ kind: "pr", title: "Pull request" });
  });

  it("drops non-HTTPS links", () => {
    expect(
      resolveArtifact(
        message("artifact", undefined, {
          artifact_kind: "commit",
          url: "http://example.test/commit/abc",
        })
      )
    ).not.toHaveProperty("url");
  });

  it("drops links containing credential-like query keys", () => {
    expect(
      resolveArtifact(
        message("artifact", undefined, {
          artifact_kind: "pr",
          url: "https://example.test/pr/1?capability_token=secret",
        })
      )
    ).not.toHaveProperty("url");
  });

  it("rejects malformed explicit diff cards instead of falling through", () => {
    expect(
      resolveArtifact(
        message("text", patch, { artifact_kind: "diff", patch: "not a diff" })
      )
    ).toBeNull();
  });
});
