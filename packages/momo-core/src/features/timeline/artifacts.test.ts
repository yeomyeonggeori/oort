import { describe, expect, it } from "vitest";
import type { Message } from "../../lib/api";
import {
  artifactKeepsBody,
  isTruncated,
  omittedFileCount,
  resolveArtifact,
  type DiffArtifact,
  type LinkArtifact,
  type OversizedArtifact,
} from "./artifacts";
import { rowPresentation } from "./rowModel";

// =============================================================================
// The web half of the ADR-0126 D2 artifact contract (MOMO-620). Every case here
// is the mirror of a MomoCoreTests case for MessageArtifactPresentation, so the
// two clients cannot drift apart silently: same props, same detection order,
// same 500 line render cap, same honest counts.
// =============================================================================

function msg(overrides: Partial<Message> = {}): Message {
  return {
    id: "019f9b10-0000-7000-8000-0000000000aa",
    channelId: "00000000-0000-7000-8000-000000000201",
    seq: 12,
    hlcTs: 1_753_000_000_000,
    hlcCount: 0,
    authorMemberId: "00000000-0000-7000-8000-000000000103",
    type: "text",
    createdAtMs: 1_753_000_000_000,
    ...overrides,
  };
}

const PATCH = [
  "diff --git a/relay/Sources/Relay/OutboxDrain.swift b/relay/Sources/Relay/OutboxDrain.swift",
  "index 1a2b3c4..5d6e7f8 100644",
  "--- a/relay/Sources/Relay/OutboxDrain.swift",
  "+++ b/relay/Sources/Relay/OutboxDrain.swift",
  "@@ -18,7 +18,8 @@ struct OutboxDrain {",
  "     let batchSize: Int",
  "-    let pollInterval: Duration = .milliseconds(200)",
  "+    let pollInterval: Duration = .milliseconds(50)",
  "+    let shardCount: Int",
  " ",
  "     func drain() async throws {",
].join("\n");

function asDiff(message: Message): DiffArtifact {
  const artifact = resolveArtifact(message);
  expect(artifact?.kind).toBe("diff");
  return artifact as DiffArtifact;
}

function asLink(message: Message): LinkArtifact {
  const artifact = resolveArtifact(message);
  expect(artifact?.kind === "commit" || artifact?.kind === "pr").toBe(true);
  return artifact as LinkArtifact;
}

describe("artifact detection order", () => {
  it("reads an explicit artifact_kind=diff with the patch prop", () => {
    const diff = asDiff(
      msg({
        type: "text",
        body: "outbox drain 샤딩 반영했습니다.",
        props: { artifact_kind: "diff", patch: PATCH, title: "outbox 샤딩" },
      })
    );
    expect(diff.title).toBe("outbox 샤딩");
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0].path).toBe("relay/Sources/Relay/OutboxDrain.swift");
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(1);
  });

  it("accepts ARTIFACT_KIND in any case (the mac lowercases too)", () => {
    expect(
      resolveArtifact(msg({ props: { artifact_kind: "PR", title: "웹 diff 카드" } }))
        ?.kind
    ).toBe("pr");
  });

  it("reads the legacy `kind` prop only on a type=artifact row", () => {
    expect(
      resolveArtifact(msg({ type: "artifact", props: { kind: "commit" } }))?.kind
    ).toBe("commit");
    // Same prop on a text row is somebody else's vocabulary, not an artifact.
    expect(resolveArtifact(msg({ type: "text", props: { kind: "commit" } }))).toBeNull();
  });

  it("treats a type=diff message body as the patch", () => {
    const diff = asDiff(msg({ type: "diff", body: PATCH }));
    expect(diff.title).toBe("코드 변경");
    expect(diff.totalLineCount).toBe(diff.displayedLineCount);
  });

  it("promotes an unmarked body that is a real unified diff", () => {
    const diff = asDiff(msg({ type: "text", body: PATCH }));
    expect(diff.files[0].additions).toBe(2);
  });

  it("promotes a ```diff fenced body and strips exactly one fence", () => {
    const fenced = ["```diff", PATCH, "```"].join("\n");
    const diff = asDiff(msg({ type: "text", body: fenced }));
    expect(diff.rawPatch.startsWith("diff --git ")).toBe(true);
    expect(diff.rawPatch.includes("```")).toBe(false);
  });

  it("never promotes a deleted row: the tombstone is the whole story", () => {
    expect(
      resolveArtifact(msg({ type: "diff", body: PATCH, state: "deleted" }))
    ).toBeNull();
  });
});

describe("artifact detection declines", () => {
  it("leaves prose that merely mentions + and - alone", () => {
    const body = [
      "리뷰 결과 정리합니다.",
      "+ 샤딩은 좋습니다",
      "- pollInterval 50ms는 너무 짧습니다",
      "@@ 여기 논의 필요",
    ].join("\n");
    expect(resolveArtifact(msg({ body }))).toBeNull();
  });

  it("leaves a plain code block alone (no diff header, no hunk)", () => {
    const body = ["```swift", "let shardCount = 8", "```"].join("\n");
    expect(resolveArtifact(msg({ body }))).toBeNull();
  });

  it("declines a --- header with no hunk and no +++ pair", () => {
    const body = ["--- a/README.md", "본문만 있고 hunk가 없습니다."].join("\n");
    expect(resolveArtifact(msg({ body }))).toBeNull();
  });

  it("declines an explicit diff whose source is unparseable", () => {
    expect(
      resolveArtifact(msg({ props: { artifact_kind: "diff", patch: "그냥 문장" } }))
    ).toBeNull();
  });

  it("declines an explicit diff with no source at all", () => {
    expect(resolveArtifact(msg({ props: { artifact_kind: "diff" } }))).toBeNull();
  });

  it("declines an unknown artifact_kind rather than inventing a fourth card", () => {
    expect(resolveArtifact(msg({ props: { artifact_kind: "issue" } }))).toBeNull();
  });
});

describe("a patch past the 200,000 byte ceiling", () => {
  const HUGE = [
    "diff --git a/big.txt b/big.txt",
    "--- a/big.txt",
    "+++ b/big.txt",
    "@@ -1,1 +1,1 @@",
    ...Array.from({ length: 12_000 }, (_, i) => `+${"가".repeat(20)}${i}`),
  ].join("\n");

  function asOversized(message: Message): OversizedArtifact {
    const artifact = resolveArtifact(message);
    expect(artifact?.kind).toBe("oversized");
    return artifact as OversizedArtifact;
  }

  it("is contained rather than parsed, so the row still has a ceiling", () => {
    expect(new TextEncoder().encode(HUGE).byteLength).toBeGreaterThan(200_000);
    const oversized = asOversized(msg({ type: "diff", body: HUGE }));
    expect(oversized.totalLineCount).toBe(12_004);
    expect(oversized.byteCount).toBeGreaterThan(200_000);
    expect(oversized.rawPatch).toBe(HUGE);
  });

  it("claims nothing it did not parse: no files, no +/- counts", () => {
    const oversized = asOversized(msg({ type: "diff", body: HUGE }));
    expect(oversized).not.toHaveProperty("files");
    expect(oversized).not.toHaveProperty("additions");
    expect(oversized).not.toHaveProperty("deletions");
  });

  it("takes the sniffed path too, not only an explicit artifact_kind", () => {
    expect(resolveArtifact(msg({ type: "text", body: HUGE }))?.kind).toBe(
      "oversized"
    );
    expect(
      resolveArtifact(msg({ props: { artifact_kind: "diff", patch: HUGE } }))?.kind
    ).toBe("oversized");
  });

  it("still declines prose, however long: the ceiling is not a promotion", () => {
    const prose = Array.from({ length: 12_000 }, (_, i) =>
      `${"가".repeat(20)}${i}`
    ).join("\n");
    expect(resolveArtifact(msg({ type: "text", body: prose }))).toBeNull();
  });

  it("drops the body it swallowed, and keeps a separate sentence", () => {
    const sniffed = msg({ type: "text", body: HUGE });
    expect(artifactKeepsBody(sniffed, asOversized(sniffed))).toBe(false);
    const withProp = msg({
      body: "패치가 너무 커서 첨부만 올립니다.",
      props: { artifact_kind: "diff", patch: HUGE },
    });
    expect(artifactKeepsBody(withProp, asOversized(withProp))).toBe(true);
  });
});

describe("honest truncation", () => {
  function bigDiff(lines: number): string {
    return [
      "diff --git a/clients/web/src/features/timeline/Timeline.tsx b/clients/web/src/features/timeline/Timeline.tsx",
      "--- a/clients/web/src/features/timeline/Timeline.tsx",
      "+++ b/clients/web/src/features/timeline/Timeline.tsx",
      "@@ -1,0 +1,%d @@".replace("%d", String(lines)),
      ...Array.from({ length: lines }, (_, i) => `+  const row${i} = items[${i}];`),
    ].join("\n");
  }

  it("renders at most 500 lines and counts the rest", () => {
    const diff = asDiff(msg({ type: "diff", body: bigDiff(1_200) }));
    expect(diff.totalLineCount).toBe(1_204); // 3 headers + 1 hunk + 1200 adds
    expect(diff.displayedLineCount).toBe(500);
    expect(isTruncated(diff)).toBe(true);
    const rendered = diff.files.reduce((sum, f) => sum + f.lines.length, 0);
    expect(rendered).toBe(500);
  });

  it("keeps the +/- summary on the FULL source, not the rendered slice", () => {
    const diff = asDiff(msg({ type: "diff", body: bigDiff(1_200) }));
    expect(diff.additions).toBe(1_200);
    expect(diff.files[0].additions).toBe(1_200);
    expect(diff.deletions).toBe(0);
  });

  it("keeps the whole source in rawPatch so nothing is unreachable", () => {
    const source = bigDiff(1_200);
    const diff = asDiff(msg({ type: "diff", body: source }));
    expect(diff.rawPatch).toBe(source);
    expect(diff.rawPatch.split("\n")).toHaveLength(1_204);
  });

  it("does not truncate a diff that fits", () => {
    const diff = asDiff(msg({ type: "diff", body: bigDiff(100) }));
    expect(isTruncated(diff)).toBe(false);
    expect(diff.displayedLineCount).toBe(diff.totalLineCount);
  });

  it("spends the 500 line budget across files in source order", () => {
    const source = [bigDiff(300), bigDiff(300).replace(/Timeline/g, "MessageRow")].join(
      "\n"
    );
    const diff = asDiff(msg({ type: "diff", body: source }));
    expect(diff.files).toHaveLength(2);
    expect(diff.files[0].lines).toHaveLength(304);
    expect(diff.files[1].lines).toHaveLength(196);
    // The second file is cut, but its own counts still describe the whole file.
    expect(diff.files[1].additions).toBe(300);
    expect(diff.files[1].lineCount).toBe(304);
  });

  it("keeps EVERY file, so `파일 N개` counts the change and not the slice", () => {
    // 12 files of 54 lines: the 500 line budget dies inside the tenth.
    const source = Array.from({ length: 12 }, (_, i) =>
      bigDiff(50).replace(/Timeline/g, `Batch${i}`)
    ).join("\n");
    const diff = asDiff(msg({ type: "diff", body: source }));
    expect(diff.files).toHaveLength(12);
    expect(diff.displayedLineCount).toBe(500);
    // Nine whole files fit, the tenth is cut, the last two are path-only.
    expect(omittedFileCount(diff)).toBe(2);
    expect(diff.files[9].lines.length).toBeGreaterThan(0);
    expect(diff.files[9].lines.length).toBeLessThan(diff.files[9].lineCount);
    for (const file of diff.files.slice(10)) {
      expect(file.lines).toHaveLength(0);
      expect(file.lineCount).toBe(54);
      // A file nobody can see still reports its path and what it changed.
      expect(file.additions).toBe(50);
      expect(file.path).toMatch(
        /^clients\/web\/src\/features\/timeline\/Batch\d+\.tsx$/
      );
    }
  });

  it("reports no omitted files when the whole diff fits", () => {
    const diff = asDiff(msg({ type: "diff", body: bigDiff(100) }));
    expect(omittedFileCount(diff)).toBe(0);
    expect(diff.files[0].lineCount).toBe(diff.files[0].lines.length);
  });
});

describe("diff paths and line kinds", () => {
  it("strips a/ and b/ prefixes and prefers the new path", () => {
    const diff = asDiff(msg({ type: "diff", body: PATCH }));
    expect(diff.files[0].path).toBe("relay/Sources/Relay/OutboxDrain.swift");
  });

  it("falls back to the old path when the file was deleted", () => {
    const removal = [
      "diff --git a/docs/old.md /dev/null",
      "--- a/docs/old.md",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-첫 줄",
      "-둘째 줄",
    ].join("\n");
    const diff = asDiff(msg({ type: "diff", body: removal }));
    expect(diff.files[0].path).toBe("docs/old.md");
    expect(diff.files[0].deletions).toBe(2);
  });

  it("keeps a path containing a space whole (mac maxSplits: 1)", () => {
    const spaced = [
      "diff --git a/docs/설계 노트.md b/docs/설계 노트.md",
      "--- a/docs/설계 노트.md",
      "+++ b/docs/설계 노트.md",
      "@@ -1,1 +1,1 @@",
      "+한 줄",
    ].join("\n");
    expect(asDiff(msg({ type: "diff", body: spaced })).files[0].path).toBe(
      "docs/설계 노트.md"
    );
  });

  it("classifies every line kind", () => {
    const diff = asDiff(msg({ type: "diff", body: PATCH }));
    const kinds = diff.files[0].lines.map((line) => line.kind);
    expect(kinds).toContain("metadata");
    expect(kinds).toContain("hunk");
    expect(kinds).toContain("context");
    expect(kinds).toContain("addition");
    expect(kinds).toContain("deletion");
  });

  it("gives every rendered line a key unique within its file", () => {
    const diff = asDiff(msg({ type: "diff", body: PATCH }));
    const ids = diff.files[0].lines.map((line) => line.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("commit and pull request link cards", () => {
  it("reads the public metadata props", () => {
    const link = asLink(
      msg({
        props: {
          artifact_kind: "pr",
          title: "웹 diff 카드 (MOMO-620)",
          repository: "Dawn-kim-official/momo",
          branch: "feat/803-momo-620",
          status: "open",
          url: "https://github.com/Dawn-kim-official/momo/pull/803",
        },
      })
    );
    expect(link.kind).toBe("pr");
    expect(link.title).toBe("웹 diff 카드 (MOMO-620)");
    expect(link.repository).toBe("Dawn-kim-official/momo");
    expect(link.branch).toBe("feat/803-momo-620");
    expect(link.status).toBe("open");
    expect(link.url).toBe("https://github.com/Dawn-kim-official/momo/pull/803");
    expect(link.urlRejected).toBe(false);
  });

  it("falls back to `uri` and drops the fragment", () => {
    const link = asLink(
      msg({
        props: {
          artifact_kind: "commit",
          uri: "https://github.com/Dawn-kim-official/momo/commit/416fd9f#diff-1",
        },
      })
    );
    expect(link.url).toBe(
      "https://github.com/Dawn-kim-official/momo/commit/416fd9f"
    );
  });

  it("names the kind when the sender gave no title", () => {
    expect(asLink(msg({ props: { artifact_kind: "commit" } })).title).toBe("커밋");
    expect(asLink(msg({ props: { artifact_kind: "pr" } })).title).toBe(
      "풀 리퀘스트"
    );
  });

  it("refuses a non-https url and says it refused", () => {
    const link = asLink(
      msg({ props: { artifact_kind: "pr", url: "http://github.com/x/y/pull/1" } })
    );
    expect(link.url).toBeUndefined();
    expect(link.urlRejected).toBe(true);
  });

  it("refuses a url carrying a credential-shaped query key", () => {
    for (const raw of [
      "https://example.com/pr/1?token=abc",
      "https://example.com/pr/1?X-Amz-Signature=abc",
      "https://example.com/pr/1?api_key=abc",
      "https://user:pw@example.com/pr/1",
    ]) {
      const link = asLink(msg({ props: { artifact_kind: "pr", url: raw } }));
      expect(link.url, raw).toBeUndefined();
      expect(link.urlRejected, raw).toBe(true);
    }
  });

  it("does not claim a refusal when no url was sent at all", () => {
    const link = asLink(msg({ props: { artifact_kind: "pr" } }));
    expect(link.urlRejected).toBe(false);
    expect(link.rejectedHost).toBeUndefined();
  });

  it("names the host of a refused address, never its query string", () => {
    const link = asLink(
      msg({
        props: {
          artifact_kind: "pr",
          url: "https://ghe.example.com/x/y/pull/1?token=super-secret",
        },
      })
    );
    expect(link.url).toBeUndefined();
    expect(link.rejectedHost).toBe("ghe.example.com");
  });

  it("leaves the host absent when the address does not parse at all", () => {
    const link = asLink(
      msg({ props: { artifact_kind: "pr", url: "그냥 문장입니다" } })
    );
    expect(link.urlRejected).toBe(true);
    expect(link.rejectedHost).toBeUndefined();
  });

  it("[R2-M6] cuts an over-long metadata value instead of hiding the row", () => {
    const link = asLink(
      msg({
        props: {
          artifact_kind: "pr",
          branch: "b".repeat(121),
          status: "s".repeat(81),
          repository: "r".repeat(161),
          title: "t".repeat(201),
        },
      })
    );
    // The value is cut AT its ceiling, ellipsis included, and the cut is
    // visible: dropping it removed the whole 저장소/브랜치 row from the card
    // with nothing saying a row had gone missing.
    expect(link.branch).toBe(`${"b".repeat(119)}…`);
    expect(link.status).toBe(`${"s".repeat(79)}…`);
    expect(link.repository).toBe(`${"r".repeat(159)}…`);
    expect(link.title).toBe(`${"t".repeat(199)}…`);
  });

  it("never cuts a value that fits", () => {
    const link = asLink(
      msg({ props: { artifact_kind: "pr", branch: "b".repeat(120) } })
    );
    expect(link.branch).toBe("b".repeat(120));
  });

  it("cuts on code points, so an emoji is never split in half", () => {
    const link = asLink(
      msg({ props: { artifact_kind: "commit", status: "🚀".repeat(81) } })
    );
    expect(link.status).toBe(`${"🚀".repeat(79)}…`);
    expect(link.status?.includes("�")).toBe(false);
  });
});

describe("[R2-M1] the tool's verb and object survive the artifact swap", () => {
  it("titles a patch with the tool that produced it", () => {
    const diff = asDiff(
      msg({
        type: "tool_result",
        body: PATCH,
        props: {
          tool_name: "apply_patch",
          label: "relay/Sources/Relay/OutboxDrain.swift",
          is_error: true,
        },
      })
    );
    expect(diff.title).toBe(
      "apply_patch 실행, relay/Sources/Relay/OutboxDrain.swift"
    );
  });

  it("reads the legacy `tool` key too, and needs no label", () => {
    expect(
      asDiff(msg({ type: "diff", body: PATCH, props: { tool: "git apply" } }))
        .title
    ).toBe("git apply 실행");
  });

  it("still prefers a title the sender wrote", () => {
    expect(
      asDiff(
        msg({
          type: "diff",
          body: PATCH,
          props: { tool_name: "apply_patch", title: "outbox 샤딩" },
        })
      ).title
    ).toBe("outbox 샤딩");
  });

  it("keeps the generic name when the message names no tool", () => {
    expect(asDiff(msg({ type: "diff", body: PATCH })).title).toBe("코드 변경");
  });

  it("composes a title that fits the 200 character ceiling", () => {
    const diff = asDiff(
      msg({
        type: "tool_result",
        body: PATCH,
        props: { tool_name: "t".repeat(90), label: "l".repeat(120) },
      })
    );
    expect([...diff.title].length).toBeLessThanOrEqual(200);
    expect(diff.title.startsWith(`${"t".repeat(79)}… 실행, `)).toBe(true);
  });
});

describe("body retention", () => {
  it("drops the body when the card IS the body (sniffed diff)", () => {
    const message = msg({ type: "diff", body: PATCH });
    expect(artifactKeepsBody(message, asDiff(message))).toBe(false);
  });

  it("keeps the author's sentence when the patch came from props", () => {
    const message = msg({
      body: "outbox drain 샤딩 반영했습니다.",
      props: { artifact_kind: "diff", patch: PATCH },
    });
    expect(artifactKeepsBody(message, asDiff(message))).toBe(true);
  });

  it("keeps the sentence beside a commit or PR card", () => {
    const message = msg({
      body: "PR 올렸습니다. 리뷰 부탁드립니다.",
      props: { artifact_kind: "pr", title: "웹 diff 카드" },
    });
    expect(artifactKeepsBody(message, asLink(message))).toBe(true);
  });
});

// =============================================================================
// #1476 — the body that arrives as a runtime `null`.
//
// `Message.body` is declared `string | undefined`, so TypeScript never asked
// this file about `null`. The WIRE asks: a realtime frame carries
// `"body": null` and the single line normalizing it away lives in
// `payloadToMessage`, one module over. Every case below is a row that the type
// system says cannot exist and the transport says can.
//
// The stake is not a missing card. `resolveArtifact` runs inside
// `rowPresentation`, which runs inside `MessageRow`'s render on web AND phone,
// so a throw here is not a row that fails to draw — it is the whole timeline
// going blank (#1465 worker: `cards=0`, `Cannot read properties of null
// (reading 'trim')`).
// =============================================================================

/** A row exactly as a realtime frame can deliver it: `"body": null`. */
function nullBodyMsg(overrides: Partial<Message> = {}): Message {
  return { ...msg(overrides), body: null } as unknown as Message;
}

/** The three ways this function is asked about a body, in detection order. */
const BODY_READING_PATHS: ReadonlyArray<[string, Partial<Message>]> = [
  [
    "explicit artifact_kind=diff, no patch prop",
    { props: { artifact_kind: "diff" } },
  ],
  ["type=diff", { type: "diff" }],
  ["the unmarked body sniff", {}],
];

describe("#1476 a runtime null body", () => {
  for (const [name, path] of BODY_READING_PATHS) {
    it(`declines instead of throwing: ${name}`, () => {
      expect(() => resolveArtifact(nullBodyMsg(path))).not.toThrow();
      expect(resolveArtifact(nullBodyMsg(path))).toBeNull();
    });

    it(`answers the same for null, undefined and '': ${name}`, () => {
      // The three states the acceptance names, plus the whitespace-only body
      // that `propString` has always treated as an absent patch prop.
      expect(resolveArtifact(nullBodyMsg(path))).toBeNull();
      expect(resolveArtifact(msg(path))).toBeNull();
      expect(resolveArtifact(msg({ ...path, body: "" }))).toBeNull();
      expect(resolveArtifact(msg({ ...path, body: "   \n\t " }))).toBeNull();
    });
  }

  it("keeps the timeline standing: the throw blanked the screen from rowPresentation", () => {
    expect(() => rowPresentation(nullBodyMsg())).not.toThrow();
    const row = rowPresentation(nullBodyMsg());
    expect(row.artifact).toBeNull();
  });

  it("still reads the patch prop when the body beside it is null", () => {
    const message = nullBodyMsg({
      props: { artifact_kind: "diff", patch: PATCH },
    });
    expect(asDiff(message).files).toHaveLength(1);
  });

  it("still names a commit or PR card, a path that never read the body", () => {
    const message = nullBodyMsg({
      props: { artifact_kind: "pr", title: "웹 diff 카드" },
    });
    expect(asLink(message).title).toBe("웹 diff 카드");
  });

  it("still promotes a real diff body: the guard reads the body, it does not drop it", () => {
    expect(asDiff(msg({ body: PATCH })).files).toHaveLength(1);
    expect(asDiff(msg({ type: "diff", body: PATCH })).files).toHaveLength(1);
  });
});
