#!/usr/bin/env node
// =============================================================================
// npm dependency license gate (MOMO-391, re-aimed by #1225).
//
// Walks EVERY package recorded in each package-lock.json (production and dev,
// i.e. the full transitive closure npm installed), reads its license, and fails
// (exit 1) unless the license is on the permissive allowlist below.
//
// #1225 — WHAT MOVED AND WHY
//   This gate used to live at clients/web-legacy/scripts/check-licenses.mjs and
//   inspected that one tree. clients/web-legacy is the retired v0 client
//   (ADR-0133 / MOMO-596); the canonical trees are clients/web,
//   clients/mobile and the npm workspace root that owns packages/momo-core.
//   Audit research/2026-08-10-buzz-audit-A.md measured the consequence: the
//   1,258 packages of the live trees were checked by nothing, while the gate
//   reported green over a tree that ships to no one. So the script now takes
//   its roots as arguments and defaults to the canonical three.
//   clients/web-legacy is still gated — the `web` gate profile builds and
//   serves it — but explicitly, as one root among others.
//
// Companion gate: deny.toml + scripts/check_cargo_licenses.sh do the same job
// for the two cargo workspaces. The allowlists are the same policy written
// twice; change both or neither.
//
// Usage:
//   node scripts/check_npm_licenses.mjs [--root <dir>]... [--report <path>]
//
//   --root <dir>    Directory holding a package-lock.json, relative to the repo
//                   root. Repeatable. Default: the canonical three.
//   --report <path> Write the Markdown inventory here instead of stdout.
//                   (NPM_LICENSE_REPORT / WEB_LICENSE_REPORT also work.)
// =============================================================================

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The canonical npm trees. `.` is the workspace root whose lockfile covers
// packages/momo-core (ADR-0137 D3) — momo-core has no lockfile of its own.
const DEFAULT_ROOTS = [".", "clients/web", "clients/mobile"];

// -----------------------------------------------------------------------------
// Policy. Mirrors deny.toml; every entry outside the MIT/Apache/ISC/BSD families
// names the packages that forced the decision, so the next reader can re-derive
// it instead of trusting it.
// -----------------------------------------------------------------------------
const ALLOWED = new Map([
  ["MIT", "base permissive family"],
  ["MIT-0", "base permissive family (MIT without the attribution clause)"],
  ["Apache-2.0", "base permissive family; the project's own license"],
  ["ISC", "base permissive family"],
  ["BSD-2-Clause", "base permissive family"],
  ["BSD-3-Clause", "base permissive family"],
  ["0BSD", "base permissive family — tslib (web), jsc-safe-url (mobile)"],
  [
    "Unlicense",
    "public-domain dedication, weaker obligations than MIT — big-integer, stream-buffers (mobile, prod)",
  ],
  [
    "CC0-1.0",
    "public-domain dedication — reached only as an OR branch (type-fest: MIT OR CC0-1.0)",
  ],
  [
    "BlueOak-1.0.0",
    "Blue Oak Model License 1.0.0: permissive, explicit patent grant, no copyleft. minimatch/minipass/path-scurry/sax/glob — the isaacs tree under expo (mobile, PRODUCTION) and typescript-eslint (dev)",
  ],
  [
    "Python-2.0",
    "PSF License 2.0: OSI-approved permissive, GPL-compatible. argparse, transitive of js-yaml under eslint/@expo/xcpretty/cosmiconfig",
  ],
  [
    "CC-BY-4.0",
    "caniuse-lite — a browser-support DATA table, not code; attribution only, no copyleft, no share-alike. Ships in every JS toolchain (browserslist)",
  ],
  [
    "MPL-2.0",
    "REVIEWED POLICY DECISION (2026-08-10 plan §방침): file-scope weak copyleft, so linking it does not affect redistributing oort under Apache-2.0 (MPL-2.0 §3.3). 24 packages = lightningcss + its 11 platform binaries in clients/web (dev) and clients/mobile (PRODUCTION, via expo -> @expo/metro-config). Same call as block/buzz's deny.toml. Reverse by deleting this entry and deny.toml's",
  ],
]);

// The npm equivalent of deny.toml's [[licenses.clarify]]: packages whose lock
// entry carries no SPDX `license` string, resolved by hand with the evidence
// that settled it. Keep this list at the length of the evidence — an entry
// without a verifiable source does not belong here.
const CLARIFY = new Map([
  [
    "exit@0.1.2",
    {
      license: "MIT",
      reason:
        "pre-SPDX manifest: declares the legacy `licenses: [{ type: MIT, url: .../LICENSE-MIT }]` array, which npm does not copy into lockfileVersion 3 entries. Verified against registry.npmjs.org/exit/0.1.2. Dev-only (jest -> jest-cli).",
    },
  ],
]);

const COPYLEFT_PATTERN =
  /\b(?:A?GPL|LGPL|EPL|CDDL|SSPL|EUPL|OSL|CPAL|CC-BY-SA|CC-BY-NC|BUSL|Elastic)/i;

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------
const roots = [];
let reportPath =
  process.env.NPM_LICENSE_REPORT ?? process.env.WEB_LICENSE_REPORT ?? "";

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--root") {
    const value = process.argv[i + 1];
    if (!value) {
      console.error("LICENSE GATE FAIL: --root needs a directory");
      process.exit(2);
    }
    roots.push(value);
    i += 1;
  } else if (arg === "--report") {
    const value = process.argv[i + 1];
    if (!value) {
      console.error("LICENSE GATE FAIL: --report needs a path");
      process.exit(2);
    }
    reportPath = value;
    i += 1;
  } else if (arg === "-h" || arg === "--help") {
    console.log(
      "Usage: node scripts/check_npm_licenses.mjs [--root <dir>]... [--report <path>]"
    );
    process.exit(0);
  } else {
    console.error(`LICENSE GATE FAIL: unknown argument: ${arg}`);
    process.exit(2);
  }
}

const targets = roots.length > 0 ? roots : DEFAULT_ROOTS;

// -----------------------------------------------------------------------------
// License resolution
// -----------------------------------------------------------------------------
function licenseFromManifest(manifestPath) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof manifest.license === "string" && manifest.license.trim() !== "") {
      return manifest.license.trim();
    }
    if (typeof manifest.license?.type === "string") return manifest.license.type;
    if (Array.isArray(manifest.licenses) && manifest.licenses.length > 0) {
      return `(${manifest.licenses
        .map((entry) => entry.type ?? String(entry))
        .join(" OR ")})`;
    }
  } catch {
    // Not installed / unreadable: fall through to the clarify list.
  }
  return "";
}

function licenseOf(rootDir, pkgPath, info, name, version) {
  if (typeof info.license === "string" && info.license.trim() !== "") {
    return { license: info.license.trim(), source: "lockfile" };
  }
  // The lockfile is the only input that always exists (node_modules may not be
  // installed), but when it IS installed the on-disk manifest answers legacy
  // `licenses` arrays that lockfileVersion 3 drops.
  const onDisk = licenseFromManifest(join(rootDir, pkgPath, "package.json"));
  if (onDisk) return { license: onDisk, source: "installed manifest" };

  const clarified = CLARIFY.get(`${name}@${version}`);
  if (clarified) return { license: clarified.license, source: "clarify list" };

  return { license: "UNKNOWN", source: "unresolved" };
}

// SPDX evaluation: OR passes when ANY branch is allowed, AND requires ALL.
// Evaluating the expression BEFORE pattern-matching names is the point — a
// package licensed `MIT OR Apache-2.0 OR LGPL-2.1-or-later` is freely usable
// under MIT, and a gate that greps for "LGPL" first would reject it.
function expressionAllowed(expression) {
  const normalized = expression.replace(/^\(|\)$/g, "").trim();
  const isAllowedSingle = (id) => ALLOWED.has(id.trim());
  if (normalized.includes(" OR ")) {
    return normalized.split(" OR ").some(isAllowedSingle);
  }
  if (normalized.includes(" AND ")) {
    return normalized.split(" AND ").every(isAllowedSingle);
  }
  return isAllowedSingle(normalized);
}

// A copyleft token still fails even inside an allowed expression, unless the
// expression is an OR that an allowed branch already satisfies.
function violates(expression) {
  if (!expressionAllowed(expression)) return true;
  const normalized = expression.replace(/^\(|\)$/g, "").trim();
  if (!COPYLEFT_PATTERN.test(normalized)) return false;
  if (!normalized.includes(" OR ")) return true;
  // OR: safe only if some branch is both allowed and copyleft-free.
  return !normalized
    .split(" OR ")
    .some((branch) => ALLOWED.has(branch.trim()) && !COPYLEFT_PATTERN.test(branch));
}

// -----------------------------------------------------------------------------
// Walk
// -----------------------------------------------------------------------------
const rows = [];
const violations = [];
const licenseCounts = new Map();
const perRoot = [];

for (const root of targets) {
  const rootDir = resolve(repoRoot, root);
  const lockPath = join(rootDir, "package-lock.json");
  if (!existsSync(lockPath)) {
    console.error(`LICENSE GATE FAIL: no package-lock.json under ${root}`);
    process.exit(1);
  }
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const entries = Object.entries(lock.packages ?? {});
  let counted = 0;

  for (const [pkgPath, info] of entries) {
    if (pkgPath === "") continue; // the root package itself
    // A `link: true` entry is a node_modules symlink to a workspace member; the
    // member is walked under its real path, so counting it twice would inflate
    // the inventory and report the same package as two licenses.
    if (info.link === true) continue;

    const firstParty = !pkgPath.includes("node_modules/");
    const name = pkgPath.replace(/^.*node_modules\//, "");
    const version = info.version ?? "?";
    const { license, source } = licenseOf(rootDir, pkgPath, info, name, version);

    counted += 1;
    rows.push({
      root,
      name: firstParty ? `${name} (first-party)` : name,
      version,
      license,
      scope: info.dev === true ? "dev" : "prod",
      source,
    });
    licenseCounts.set(license, (licenseCounts.get(license) ?? 0) + 1);

    if (license === "UNKNOWN" || violates(license)) {
      violations.push({
        root,
        name,
        version,
        license,
        firstParty,
        scope: info.dev === true ? "dev" : "PRODUCTION",
      });
    }
  }
  perRoot.push({ root, counted, lockfileVersion: lock.lockfileVersion });
}

rows.sort((a, b) =>
  a.root === b.root ? a.name.localeCompare(b.name) : a.root.localeCompare(b.root)
);

// -----------------------------------------------------------------------------
// Report
// -----------------------------------------------------------------------------
const lines = [];
lines.push("### npm dependency licenses");
lines.push("");
lines.push(`Roots: ${targets.join(", ")}`);
lines.push("");
lines.push("| Root | Packages | lockfileVersion |");
lines.push("|---|---|---|");
for (const entry of perRoot) {
  lines.push(`| ${entry.root} | ${entry.counted} | ${entry.lockfileVersion} |`);
}
lines.push("");
lines.push(
  `Total packages: ${rows.length} ` +
    `(production: ${rows.filter((row) => row.scope === "prod").length}, ` +
    `dev: ${rows.filter((row) => row.scope === "dev").length})`
);
lines.push("");
lines.push("| License | Count |");
lines.push("|---|---|");
for (const [license, count] of [...licenseCounts.entries()].sort(
  (a, b) => b[1] - a[1]
)) {
  lines.push(`| ${license} | ${count} |`);
}
lines.push("");
lines.push("<details><summary>Full package list</summary>");
lines.push("");
lines.push("| Root | Package | Version | License | Scope | License source |");
lines.push("|---|---|---|---|---|---|");
for (const row of rows) {
  lines.push(
    `| ${row.root} | ${row.name} | ${row.version} | ${row.license} | ${row.scope} | ${row.source} |`
  );
}
lines.push("");
lines.push("</details>");
lines.push("");

const report = lines.join("\n");
if (reportPath) {
  writeFileSync(reportPath, report);
  console.log(`license report written: ${reportPath}`);
} else {
  console.log(report);
}

if (violations.length > 0) {
  console.error("LICENSE GATE FAIL: non-permissive or unresolved licenses:");
  for (const violation of violations) {
    console.error(
      `  - [${violation.root}] ${violation.name}@${violation.version}: ` +
        `${violation.license} (${violation.scope}` +
        `${violation.firstParty ? ", first-party" : ""})`
    );
  }
  console.error("");
  console.error(
    "Add the SPDX id to ALLOWED in scripts/check_npm_licenses.mjs (and to " +
      "deny.toml) with a reason naming the package, or replace the dependency. " +
      "A first-party violation usually means a package.json lost its `license` " +
      "field."
  );
  process.exit(1);
}

console.log(
  `LICENSE GATE PASS: ${rows.length} packages across ${targets.length} root(s), ` +
    `all permissive per the shared policy (deny.toml / ALLOWED).`
);
