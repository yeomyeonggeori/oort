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

// ADR-0218 §12 (#5442): the set definitions are a second, additive document. Its pinned block must equal the file,
// and no definition may share a name with the main document (one validator reads both).
const setSchema = JSON.parse(readFileSync(resolve(directory, "set.schema.json"), "utf8"));
const setPinned = /<!-- expression-set-5442:start -->\s*```json\n([\s\S]*?)\n```\s*<!-- expression-set-5442:end -->/.exec(adr);
assert.ok(setPinned, "ADR section 12 must contain the complete pinned set contract JSON");
assert.deepEqual(JSON.parse(setPinned[1]), setSchema, "ADR section 12 block and set.schema.json drifted");
for (const name of Object.keys(setSchema.$defs)) {
  assert.ok(name.startsWith("Set"), `set definition ${name} must start with Set`);
  assert.ok(!Object.hasOwn(schema.$defs, name), `set definition ${name} collides with the main document`);
}

// Every fenced yaml block of the ADR (appendix A and section 12) points only at definitions that exist.
const schemas = { "contracts.schema.json": schema, "set.schema.json": setSchema };
const yamls = [...adr.matchAll(/```yaml\n([\s\S]*?)\n```/g)].map((match) => match[1]);
assert.ok(yamls.length >= 2, "OpenAPI fragments missing (appendix A and section 12)");
for (const yaml of yamls) {
  for (const match of yaml.matchAll(/\$ref: '([^']+)'/g)) {
    const [target, pointer] = match[1].split("#");
    if (!target) continue;
    assert.ok(existsSync(resolve(dirname(adrPath), target)), `Missing OpenAPI ref ${target}`);
    const definition = pointer?.split("/").at(-1);
    const owner = schemas[target.split("/").at(-1)];
    assert.ok(definition && owner && Object.hasOwn(owner.$defs, definition), `Unknown schema ref ${match[1]}`);
  }
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
console.log(`PASS: ADR schema = executable schema (${Object.keys(schema.$defs).length} definitions + ${Object.keys(setSchema.$defs).length} set definitions); OpenAPI refs and owned document links resolve`);
