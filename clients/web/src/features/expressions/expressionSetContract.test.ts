import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ADR-0218 §12 (#5461 security review 1, M1). Two files that the core owns have a second copy somewhere else, and until this
// test nothing that runs kept the copy honest (`verify-contract.mjs` checks both, but no test, gate or CI job calls it):
//
//  - The server's Rust test (`set_vectors.rs`) reads the decision vectors from `docs/api/expression-set.vectors.json`, a copy of
//    the core's `set.vectors.json` (a Rust test may only read files the PR CI rust filter covers, and that filter does not see the
//    core package). A3 and L6.2 say the core and the server answer ONE table; this is the door that keeps the copy that table.
//  - The ADR's L11.1 block is the same JSON as the core's `set.schema.json` (A20).
//
// The core package cannot read outside itself (purity gate), so — like `ExpressionKind.test.tsx`, which reads
// `docs/api/expression-kind.vectors.json` — the test that holds both ends together is in the web.

const CORE = "packages/momo-core/src/features/expressions";
const repoFile = (relative: string) => fileURLToPath(new URL(`../../../../../${relative}`, import.meta.url));
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("the set decision vectors the server reads are the core's table (A3, L6.2)", () => {
  it("keeps docs/api/expression-set.vectors.json byte-equal to the core's set.vectors.json", () => {
    const core = readFileSync(repoFile(`${CORE}/set.vectors.json`));
    const copy = readFileSync(repoFile("docs/api/expression-set.vectors.json"));
    // Two empty files are byte-equal too: the table must really be there.
    const table = JSON.parse(core.toString("utf8")) as { cases?: unknown[] };
    expect(Array.isArray(table.cases) ? table.cases.length : 0).toBeGreaterThan(0);
    expect(sha256(copy), "docs/api/expression-set.vectors.json must be byte-equal to set.vectors.json (cp it after a change)").toBe(sha256(core));
  });
});

describe("the ADR's pinned set schema is the core's schema (A20)", () => {
  it("keeps the L11.1 JSON block of ADR-0218 equal to set.schema.json", () => {
    const adr = readFileSync(repoFile("docs/adr/0218-workspace-expressions.md"), "utf8");
    const pinned = /<!-- expression-set-5442:start -->\s*```json\n([\s\S]*?)\n```\s*<!-- expression-set-5442:end -->/.exec(adr);
    const block = pinned?.[1];
    expect(block, "ADR section 12 must contain the complete pinned set contract JSON").toBeDefined();
    const schema: unknown = JSON.parse(readFileSync(repoFile(`${CORE}/set.schema.json`), "utf8"));
    expect(JSON.parse(block ?? "null"), "ADR section 12 block and set.schema.json drifted").toEqual(schema);
  });
});
