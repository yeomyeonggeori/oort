import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildExactSourceBeforePreview,
  matchesInsetFocusRing,
  parseInsetFocusRingContract,
} from "./gate-shell-layout-contract.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(WEB_ROOT, "package.json"), "utf8"));
const tokensCss = readFileSync(resolve(WEB_ROOT, "src/design/tokens.css"), "utf8");

describe("shell layout gate contract", () => {
  it("keeps the named package entrypoint wired to the exact-source executable", () => {
    expect(packageJson.scripts["gate:shell"]).toBe(
      "node gates/gate-shell-layout.mjs"
    );
  });

  it("fails closed instead of consuming an existing stale dist", async () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), "momo-shell-gate-"));
    try {
      mkdirSync(resolve(fixtureRoot, "dist"));
      writeFileSync(resolve(fixtureRoot, "dist/index.html"), "stale fixture");

      await expect(
        buildExactSourceBeforePreview({
          webRoot: fixtureRoot,
          runBuild: async () => {
            throw new Error("fixture build failed");
          },
        })
      ).rejects.toThrow(/fixture build failed/);
      expect(readFileSync(resolve(fixtureRoot, "dist/index.html"), "utf8")).toBe(
        "stale fixture"
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("the executable awaits its own build and stops before preview on failure", () => {
    if (process.platform === "win32") return;
    const fixtureBin = mkdtempSync(resolve(tmpdir(), "momo-shell-gate-bin-"));
    try {
      writeFileSync(resolve(fixtureBin, "npm"), "#!/bin/sh\nexit 23\n", {
        mode: 0o755,
      });
      const result = spawnSync(
        process.execPath,
        ["gates/gate-shell-layout.mjs"],
        {
          cwd: WEB_ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${fixtureBin}${delimiter}${process.env.PATH ?? ""}`,
          },
        }
      );
      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toMatch(
        /exact-source build failed \(exit 23\)/
      );
      expect(`${result.stdout}${result.stderr}`).not.toMatch(/preview server/);
    } finally {
      rmSync(fixtureBin, { recursive: true, force: true });
    }
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
