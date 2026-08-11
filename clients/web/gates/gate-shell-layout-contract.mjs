import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Build inside the gate executable, then verify that the build produced its
 * entry point. Awaiting this before preview is the load-bearing part: a failed
 * build must never fall through to an existing dist from another source tree.
 */
async function runNpmBuild(webRoot) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(npm, ["run", "build"], {
      cwd: webRoot,
      stdio: "inherit",
    });
    child.once("error", (error) => {
      rejectBuild(new Error(`gate:shell exact-source build could not start: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveBuild();
        return;
      }
      const outcome = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
      rejectBuild(new Error(`gate:shell exact-source build failed (${outcome})`));
    });
  });
}

export async function buildExactSourceBeforePreview({
  webRoot,
  runBuild = runNpmBuild,
}) {
  await runBuild(webRoot);
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/index.html is missing after gate:shell exact-source build");
  }
}

/**
 * Read the focus contract from the CSS source of truth instead of copying its
 * value into the Playwright gate. The visual rule is relational: the outline
 * is inset by exactly its own width. A positive/outset offset is therefore a
 * contract error even if a fixture and a stale bundle happen to agree on it.
 */
export function parseInsetFocusRingContract(css) {
  const block = css.match(/@utility\s+focus-ring\s*\{(?<body>[^}]*)\}/s)?.groups?.body;
  if (!block) throw new Error("focus-ring utility is missing from tokens.css");

  const width = Number(block.match(/outline:\s*(?<value>\d+(?:\.\d+)?)px\s+solid\b/)?.groups?.value);
  const offset = Number(block.match(/outline-offset:\s*(?<value>-?\d+(?:\.\d+)?)px\s*;/)?.groups?.value);
  if (!Number.isFinite(width) || !Number.isFinite(offset) || width <= 0) {
    throw new Error("focus-ring utility must declare a positive px outline and px offset");
  }
  if (offset !== -width) {
    throw new Error(
      `focus-ring must be inset by its width (outline ${width}px, offset ${offset}px)`
    );
  }

  return {
    outlineWidth: `${width}px`,
    outlineOffset: `${offset}px`,
  };
}

export function matchesInsetFocusRing(measurement, contract) {
  return (
    measurement?.outlineWidth === contract.outlineWidth &&
    measurement?.outlineOffset === contract.outlineOffset
  );
}
