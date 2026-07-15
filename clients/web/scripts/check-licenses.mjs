#!/usr/bin/env node
// =============================================================================
// clients/web license gate (MOMO-391, hard rule: permissive-only).
//
// Walks EVERY installed package recorded in package-lock.json (production and
// dev, i.e. the full transitive closure npm installed), reads its license,
// and fails (exit 1) unless the license is on the permissive allowlist.
// Copyleft families (GPL/AGPL/LGPL/MPL/EPL/CDDL/SSPL/EUPL/CC-BY-SA/
// CC-BY-NC...) are named explicitly so a violation reads as what it is.
//
// Output: a Markdown license inventory on stdout (attach to the PR), or to
// the file given by WEB_LICENSE_REPORT=<path>.
//
// Allowlist policy:
//   - Base families per the acceptance criteria: MIT / Apache / ISC / BSD.
//   - Two REVIEWED permissive additions, restricted to dev-only packages
//     (never shipped in the browser bundle); each appearance outside
//     devDependencies fails the gate:
//       * BlueOak-1.0.0 (minimatch >= 10, transitive of typescript-eslint)
//       * Python-2.0    (argparse, transitive of js-yaml < eslint /
//                        openapi-typescript)
//     Both are OSI-recognized permissive licenses; they are outside the four
//     named families, so they are called out in the PR instead of silently
//     widening the rule.
//   - SPDX OR expressions pass when ANY branch is allowed; AND expressions
//     require ALL branches allowed.
// =============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const ALLOWED_ANY = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
]);

// Reviewed permissive exceptions — dev-only (see header).
const ALLOWED_DEV_ONLY = new Set(["BlueOak-1.0.0", "Python-2.0"]);

const COPYLEFT_PATTERN =
  /\b(?:A?GPL|LGPL|MPL|EPL|CDDL|SSPL|EUPL|OSL|CPAL|CC-BY-SA|CC-BY-NC|BUSL|Elastic)/i;

function licenseOf(pkgPath, info) {
  if (typeof info.license === "string" && info.license.trim() !== "") {
    return info.license.trim();
  }
  // Fallback: read the installed package.json (legacy `licenses` arrays etc.)
  try {
    const manifest = JSON.parse(
      readFileSync(join(webRoot, pkgPath, "package.json"), "utf8")
    );
    if (typeof manifest.license === "string") return manifest.license;
    if (manifest.license?.type) return manifest.license.type;
    if (Array.isArray(manifest.licenses)) {
      return `(${manifest.licenses
        .map((entry) => entry.type ?? String(entry))
        .join(" OR ")})`;
    }
  } catch {
    // fallthrough
  }
  return "UNKNOWN";
}

function expressionAllowed(expression, { dev }) {
  const normalized = expression.replace(/^\(|\)$/g, "").trim();
  const isAllowedSingle = (id) => {
    const clean = id.trim();
    if (ALLOWED_ANY.has(clean)) return true;
    if (dev && ALLOWED_DEV_ONLY.has(clean)) return true;
    return false;
  };
  if (normalized.includes(" OR ")) {
    return normalized.split(" OR ").some(isAllowedSingle);
  }
  if (normalized.includes(" AND ")) {
    return normalized.split(" AND ").every(isAllowedSingle);
  }
  return isAllowedSingle(normalized);
}

const lock = JSON.parse(
  readFileSync(join(webRoot, "package-lock.json"), "utf8")
);

const rows = [];
const violations = [];
const licenseCounts = new Map();

for (const [pkgPath, info] of Object.entries(lock.packages ?? {})) {
  if (pkgPath === "") continue; // the workspace itself
  const name = pkgPath.replace(/^.*node_modules\//, "");
  const dev = info.dev === true;
  const license = licenseOf(pkgPath, info);
  rows.push({ name, version: info.version ?? "?", license, dev });
  licenseCounts.set(license, (licenseCounts.get(license) ?? 0) + 1);

  const allowed = expressionAllowed(license, { dev });
  if (!allowed || COPYLEFT_PATTERN.test(license)) {
    violations.push({ name, version: info.version, license, dev });
  }
}

rows.sort((a, b) => a.name.localeCompare(b.name));

const lines = [];
lines.push("### clients/web dependency licenses");
lines.push("");
lines.push(
  `Total installed packages: ${rows.length} ` +
    `(production: ${rows.filter((row) => !row.dev).length}, ` +
    `dev: ${rows.filter((row) => row.dev).length})`
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
lines.push("| Package | Version | License | Scope |");
lines.push("|---|---|---|---|");
for (const row of rows) {
  lines.push(
    `| ${row.name} | ${row.version} | ${row.license} | ${row.dev ? "dev" : "prod"} |`
  );
}
lines.push("");
lines.push("</details>");
lines.push("");

const report = lines.join("\n");
const target = process.env.WEB_LICENSE_REPORT;
if (target) {
  writeFileSync(target, report);
  console.log(`license report written: ${target}`);
} else {
  console.log(report);
}

if (violations.length > 0) {
  console.error("LICENSE GATE FAIL: non-permissive or unreviewed licenses:");
  for (const violation of violations) {
    console.error(
      `  - ${violation.name}@${violation.version}: ${violation.license}` +
        ` (${violation.dev ? "dev" : "PRODUCTION"})`
    );
  }
  process.exit(1);
}

console.log(
  `LICENSE GATE PASS: ${rows.length} packages, all permissive ` +
    `(MIT/Apache-2.0/ISC/BSD family; dev-only reviewed: BlueOak-1.0.0, Python-2.0).`
);
