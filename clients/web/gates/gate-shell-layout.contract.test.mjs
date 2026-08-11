import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertExactSourceGateInvocation,
  matchesInsetFocusRing,
  parseInsetFocusRingContract,
} from "./gate-shell-layout-contract.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(WEB_ROOT, "package.json"), "utf8"));
const tokensCss = readFileSync(resolve(WEB_ROOT, "src/design/tokens.css"), "utf8");

describe("shell layout gate contract", () => {
  it("fails closed instead of consuming an existing stale dist", () => {
    expect(() =>
      assertExactSourceGateInvocation({
        script: "node gates/gate-shell-layout.mjs",
        lifecycleEvent: "gate:shell",
      })
    ).toThrow(/build the exact source/);

    expect(() =>
      assertExactSourceGateInvocation({
        script: packageJson.scripts["gate:shell"],
        lifecycleEvent: undefined,
      })
    ).toThrow(/potentially stale dist/);

    expect(() =>
      assertExactSourceGateInvocation({
        script: packageJson.scripts["gate:shell"],
        lifecycleEvent: "gate:shell",
      })
    ).not.toThrow();
  });

  it("rejects an outset offset and accepts the canonical inset ring", () => {
    const contract = parseInsetFocusRingContract(tokensCss);
    expect(contract).toEqual({ outlineWidth: "2px", outlineOffset: "-2px" });
    expect(
      matchesInsetFocusRing(
        { outlineWidth: "2px", outlineOffset: "2px" },
        contract
      )
    ).toBe(false);
    expect(
      matchesInsetFocusRing(
        { outlineWidth: "2px", outlineOffset: "-2px" },
        contract
      )
    ).toBe(true);

    const wrongOffsetFixture = tokensCss.replace(
      "outline-offset: -2px;",
      "outline-offset: 2px;"
    );
    expect(() => parseInsetFocusRingContract(wrongOffsetFixture)).toThrow(
      /must be inset by its width/
    );
  });
});
