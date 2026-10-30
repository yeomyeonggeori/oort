// Test tooling only. Node stays outside the platform-independent TS modules.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../../../../..");
const adrPath = resolve(root, "docs/adr/0218-workspace-expressions.md");
const adr = readFileSync(adrPath, "utf8");
const schema = JSON.parse(readFileSync(resolve(directory, "contracts.schema.json"), "utf8"));
const pinned = /<!-- expression-contracts-v1:start -->\s*```json\n([\s\S]*?)\n```\s*<!-- expression-contracts-v1:end -->/.exec(adr);
assert.ok(pinned, "ADR must contain the complete pinned contract JSON");
assert.deepEqual(JSON.parse(pinned[1]), schema, "ADR appendix and executable fixture schema drifted");

const yaml = /```yaml\n([\s\S]*?)\n```/.exec(adr)?.[1];
assert.ok(yaml, "OpenAPI fragment missing");
for (const match of yaml.matchAll(/\$ref: '([^']+)'/g)) {
  const [target, pointer] = match[1].split("#");
  if (!target) continue;
  assert.ok(existsSync(resolve(dirname(adrPath), target)), `Missing OpenAPI ref ${target}`);
  const definition = pointer?.split("/").at(-1);
  assert.ok(definition && Object.hasOwn(schema.$defs, definition), `Unknown schema ref ${match[1]}`);
}
for (const path of [adrPath, resolve(root, "docs/adr/0186-agent-workspace-actions.md")]) {
  let content = readFileSync(path, "utf8");
  if (path !== adrPath) content = content.slice(content.indexOf("## 증보 2026-10-30 — 팀 표현"));
  for (const match of content.matchAll(/\]\(([^\s)]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (!target || /^https?:/.test(target)) continue;
    assert.ok(existsSync(resolve(dirname(path), target)), `Missing local link ${target}`);
  }
}
console.log(`PASS: ADR schema = executable schema (${Object.keys(schema.$defs).length} definitions); OpenAPI refs and owned document links resolve`);
