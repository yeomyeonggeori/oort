// Generate just the #4781 usage contract; no runtime dependency or core model.
// Run from any directory: node clients/web/scripts/gen-usage-types.mjs [--check]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "oort-usage-types-"));
const fullPath = join(scratch, "full.json");
execFileSync("bash", [
  "-c", '. "$1"; momo_openapi_spec_to_json "$2" "$3" usage-types',
  "usage-types", join(root, "scripts/openapi_spec_to_json.sh"),
  join(root, "docs/api/openapi.yaml"), fullPath,
], { stdio: "inherit" });
const full = JSON.parse(readFileSync(fullPath, "utf8"));
const selected = [
  "/v1/workspaces/{workspaceId}/usage/agents",
  "/v1/workspaces/{workspaceId}/usage/summary",
  "/v1/workspaces/{workspaceId}/agents/{agentMemberId}/subscription-fee",
];
const paths = Object.fromEntries(selected.map((path) => {
  if (!full.paths[path]) throw new Error(`Missing usage path: ${path}`);
  return [path, full.paths[path]];
}));
const pending = new Set(["#/components/securitySchemes/bearerAuth"]);
function discover(value) {
  if (!value || typeof value !== "object") return;
  if (value.$ref) pending.add(value.$ref);
  for (const child of Object.values(value)) discover(child);
}
discover(paths);
const components = {};
for (const ref of pending) {
  const [, prefix, section, name] = ref.split("/");
  const value = full.components?.[section]?.[name];
  if (prefix !== "components" || !value) throw new Error(`Unresolved usage ref: ${ref}`);
  (components[section] ??= {})[name] = value;
  discover(value);
}
const input = join(scratch, "usage.json");
const output = join(scratch, "usage.generated.ts");
writeFileSync(input, JSON.stringify({ openapi: full.openapi, info: full.info, paths, components }));
execFileSync("npx", ["--yes", "openapi-typescript@7.10.1", input, "-o", output], { stdio: "inherit" });
const generated = "// Regenerate: node clients/web/scripts/gen-usage-types.mjs\n" + readFileSync(output, "utf8");
const target = join(root, "clients/web/src/lib/usage.generated.ts");
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== generated) throw new Error("Usage generated types are stale");
} else {
  writeFileSync(target, generated);
}
