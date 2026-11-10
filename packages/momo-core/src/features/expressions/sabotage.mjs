// Focused mutation evidence for #4301. Only owned files are changed, sequentially,
// and every mutation is restored in finally. No Git/index or other workers.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(directory, "../../..");
const require = createRequire(import.meta.url);
const vitest = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const evidence = mkdtempSync(join(tmpdir(), "oort-4301-sabotage-"));
const run = () => spawnSync(process.execPath, [vitest, "run", "src/features/expressions", "--maxWorkers=1", "--minWorkers=1"], {
  cwd: packageRoot, encoding: "utf8", timeout: 60000,
});
const baseline = run();
assert.equal(baseline.status, 0, `Baseline failed\n${baseline.stdout}\n${baseline.stderr}`);

const mutations = [
  ["search.ts", 'if (initialQuery && [...names, ...tags].some((text) => koreanInitials(text).includes(q))) return 3;', 'if (false) return 3;', "initials"],
  ["search.ts", 'if (names.some((name) => name === q)) return 0;', 'if (names.some((name) => name === q)) return 4;', "search-rank"],
  ["message.ts", 'if (char === "`") {', 'if (false) {', "inline-code"],
  ["message.ts", 'if (marker) {', 'if (false) {', "fenced-code"],
  ["message.ts", 'count === 1 ? "large"', 'count === 1 ? "inline"', "one-large"],
  ["message.ts", 'count >= 2 && count <= 6', 'count >= 2 && count <= 5', "six-medium"],
  ["message.ts", 'return body;', 'return body.trim();', "fallback-body"],
  ["message.ts", 'const match = /^:([a-z0-9_-]{2,30}):$/.exec(value);', 'const match = /:([a-z0-9_-]{2,30}):/.exec(value);', "reaction-entire-value"],
  ["usage.ts", 'b.count - a.count || recentOrder(a, b)', 'recentOrder(a, b)', "frequency-before-recency"],
  ["usage.ts", 'data.memberId !== memberId || ', '', "usage-account-boundary"],
  ["cards.ts", 'canApprove: open && draft.state === "ready"', 'canApprove: open', "manual-cannot-approve"],
  ["cards.ts", 'const expired = nowMs >= draft.expiresAtMs;', 'const expired = false;', "expiry-boundary"],
  ["cards.ts", 'current.revision === choice.revision', 'true', "replacement-revision"],
  ["cards.ts", 'current.sha256 === choice.sha256', 'true', "preview-sha"],
  ["cache.ts", 'list.workspaceId !== cache.workspaceId', 'false', "cache-workspace"],
  ["cache.ts", 'compareExpressionVersions(list.version, cache.version) < 0', 'false', "cache-late-response"],
  ["cache.ts", 'if (item.status === "active") next.set(item.id, item);', 'if (true) next.set(item.id, item);', "cache-hide-removal"],
  ["contracts.ts", 'schema.additionalProperties !== false', 'true', "closed-properties"],
  ["contracts.schema.json", '"maxItems": 4', '"maxItems": 5', "four-candidate-ceiling"],
  ["fixtures.ts", 'small: { ...FIXTURE_MEDIA.gif.image },', 'small: { ...FIXTURE_MEDIA.gif.image, width: 129 },', "fixture-schema-assertion"],
  ["contracts.schema.json", '"attachmentId",\n        "channelId"', '"attachmentId"', "attachment-channel-required"],
  ["message.ts", 'content = content.slice(container[0].length);', 'break;', "nested-code-containers"],
  ["fixtureServer.ts", 'if (receipt) return', 'if (receipt && false) return', "same-choice-receipt"],
  // #4961 (ADR-0218 증보 4 §10): 종류 값. 추천 규칙·칸 나누기·계약·보내기 한 줄씩.
  ["kind.ts", "export const EXPRESSION_EMOJI_MAX_EDGE = 128;", "export const EXPRESSION_EMOJI_MAX_EDGE = 127;", "kind-threshold"],
  ["kind.ts", "large.frameCount > 1 || ", "", "kind-motion-term"],
  ["kind.ts", 'return isAnimatedExpression(item) ? "gif" : "emoticon";', 'return "emoticon";', "shelf-motion-split"],
  ["kind.ts", '  if (expressionKindOf(item) === "emoji") return "team";', '  if (isAnimatedExpression(item)) return "gif";\n  if (expressionKindOf(item) === "emoji") return "team";', "shelf-moving-emoji-stays-team"],
  ["kind.ts", 'if (tab === "emoji") return [];', 'if (tab === "emoji") return [...items];', "emoji-tab-holds-no-registration"],
  ["kind.ts", 'return item.kind === "emoji" || item.kind === "sticker" ? item.kind : LEGACY_EXPRESSION_KIND;', "return item.kind ?? LEGACY_EXPRESSION_KIND;", "kind-closed-read"],
  ["kind.ts", 'export const LEGACY_EXPRESSION_KIND: ExpressionKind = "sticker";', 'export const LEGACY_EXPRESSION_KIND: ExpressionKind = "emoji";', "kind-legacy-default"],
  ["kind.ts", 'return OPENING_ORDER.find((shelf) => expressionsForTab(active, shelf).length > 0) ?? "team";', 'return "team";', "opening-shelf-first-filled"],
  ["kind.ts", 'const active = items.filter((item) => item.status === "active");', "const active = items;", "opening-shelf-skips-hidden"],
  ["cards.ts", "...(kind ? { kind } : {})", "", "choice-carries-kind"],
  ["fixtureServer.ts", "kind: choice.kind ?? recommendExpressionKind(draft.media.large),", "kind: recommendExpressionKind(draft.media.large),", "fixture-server-kind-word"],
  ["contracts.schema.json", '"pattern": "^[a-f0-9]{64}$"\n        },\n        "kind": {\n          "enum": [\n            "emoji",\n            "sticker"\n          ]', '"pattern": "^[a-f0-9]{64}$"\n        },\n        "kind": {\n          "enum": [\n            "emoji",\n            "sticker",\n            "huge"\n          ]', "choice-kind-closed"],
  // #5588: 추천을 누를 때(낱말뿐이면 바꾸기·문구면 더하기)와 여러 낱말 줄(나온 차례·낱말마다 1~2개·줄 5개·꺼 둔 낱말·같은 그림 한 번·✕ 가 끄는 낱말).
  ["suggest.ts", "const whole = canonicalKeyword(input);\n  return whole", "const whole = input.trim();\n  return whole", "suggest-pick-no-normalize"],
  ["suggest.ts", "return whole !== \"\" && matchKeys(item).has(whole);", "return whole !== \"\" && suggestionKeywords(input).some((keyword) => matchKeys(item).has(keyword));", "suggest-pick-any-keyword-replaces"],
  ["suggest.ts", "for (const word of input.split(/\\s+/u)) {", "for (const word of input.split(/\\s+/u).filter((part) => canonicalKeyword(part) !== \"\").slice(-1)) {", "suggest-keywords-last-word-only"],
  ["suggest.ts", "const matchedKeywords = keywords.filter((keyword) => hitsByKeyword.has(keyword));", "const matchedKeywords = keywords.filter((keyword) => hitsByKeyword.has(keyword)).reverse();", "suggest-row-order-reversed"],
  ["suggest.ts", "for (let round = 0; round < EXPRESSION_SUGGEST_PER_KEYWORD; round += 1) {", "for (let round = 0; round < limit; round += 1) {", "suggest-no-per-keyword-cap"],
  ["suggest.ts", "for (let round = 0; round < EXPRESSION_SUGGEST_PER_KEYWORD; round += 1) {\n    for (let group = 0; group < ranked.length && total < limit; group += 1) takeNext(group);\n  }", "for (let group = 0; group < ranked.length; group += 1) {\n    for (let round = 0; round < EXPRESSION_SUGGEST_PER_KEYWORD && total < limit; round += 1) takeNext(group);\n  }", "suggest-sequential-not-round-robin"],
  ["suggest.ts", "for (let group = 0; group < ranked.length && total < limit; group += 1) takeNext(group);", "for (let group = 0; group < ranked.length; group += 1) takeNext(group);", "suggest-no-total-cap"],
  ["suggest.ts", "if (contributing.length === 1) while", "if (false) while", "suggest-no-single-keyword-fill"],
  ["suggest.ts", "const keywords = suggestionKeywords(input).filter((keyword) => !muted.has(keyword));", "const keywords = suggestionKeywords(input);", "suggest-mute-ignored"],
  ["suggest.ts", "const keywords = suggestionKeywords(input).filter((keyword) => !muted.has(keyword));", "const keywords = suggestionKeywords(input).some((keyword) => muted.has(keyword)) ? [] : suggestionKeywords(input);", "suggest-mute-any-empties-row"],
  ["suggest.ts", "while (cursor[group] < list.length && taken.has(list[cursor[group]].id)) cursor[group] += 1;", "while (false) cursor[group] += 1;", "suggest-dedupe-off"],
  ["suggest.ts", "while (cursor[group] < list.length && taken.has(list[cursor[group]].id)) cursor[group] += 1;", "if (cursor[group] < list.length && taken.has(list[cursor[group]].id)) {\n      cursor[group] += 1;\n      return true;\n    }", "suggest-dedupe-eats-quota"],
  ["suggest.ts", "return { items: pickRow(ranked, limit), keywords: matchedKeywords };", "return { items: pickRow(ranked, limit), keywords };", "suggest-mute-keywords-all-words"],
  // #5602 M1: 방금 친 낱말이 키워드일 때만(캐럿·띄어쓰기·빈 조각·글 전체·끈 낱말) + Esc·이번만 닫기의 닫힘(자리·글 전체·풀림).
  ["suggest.ts", "if (trigger === null) return { items: [], trigger: null, dismissal: held };", "if (trigger === null && row.items.length === 0) return { items: [], trigger: null, dismissal: held };", "plan-any-word-opens-row"],
  ["suggest.ts", "const at = typeof caret === \"number\" && Number.isFinite(caret) ? Math.min(Math.max(Math.floor(caret), 0), input.length) : input.length;", "const at = input.length;", "plan-caret-ignored"],
  ["suggest.ts", "if (start >= at) return null;", "if (start > at) return null;", "plan-word-after-space-attached"],
  ["suggest.ts", "if (keyword !== \"\") wordIndex += 1;", "wordIndex += 1;", "plan-empty-token-counted"],
  ["suggest.ts", ": whole !== null && matched.has(whole)\n          ? { keyword: whole, wordIndex: null }", ": false\n          ? { keyword: String(whole), wordIndex: null }", "plan-whole-text-off"],
  ["suggest.ts", "typed !== null && muted.has(typed.keyword)\n      ? null\n      : typed", "false\n      ? null\n      : typed", "plan-muted-word-falls-back-to-whole"],
  ["suggest.ts", ": typed !== null && matched.has(typed.keyword)\n        ? typed\n        : whole !== null && matched.has(whole)\n          ? { keyword: whole, wordIndex: null }", ": whole !== null && matched.has(whole)\n        ? { keyword: whole, wordIndex: null }\n        : typed !== null && matched.has(typed.keyword)\n          ? typed", "plan-whole-before-typed"],
  ["suggest.ts", "if (held !== null && sameTrigger(trigger, held)) return", "if (false) return", "plan-dismissal-ignored"],
  ["suggest.ts", "(a.wordIndex === null || b.wordIndex === null || a.wordIndex === b.wordIndex)", "true", "plan-dismissal-position-ignored"],
  ["suggest.ts", "(a.wordIndex === null || b.wordIndex === null || a.wordIndex === b.wordIndex)", "(a.wordIndex === b.wordIndex)", "plan-dismissal-whole-differs"],
  ["suggest.ts", "if (state.text.trim() === \"\") return { items: [], trigger: null, dismissal: null };", "if (state.text.trim() === \"\") return { items: [], trigger: null, dismissal: held };", "plan-blank-keeps-dismissal"],
  ["suggest.ts", "if (trigger === null) return { items: [], trigger: null, dismissal: held };", "if (trigger === null) return { items: [], trigger: null, dismissal: null };", "plan-any-word-releases-dismissal"],
  ["suggest.ts", "return { items: row.items, trigger, dismissal: null };", "return { items: row.items, trigger, dismissal: held };", "plan-new-keyword-keeps-dismissal"],
];
for (const [file, needle, _replacement, name] of mutations) {
  assert.ok(readFileSync(join(directory, file), "utf8").includes(needle), `Mutation no longer applies: ${name}`);
}
const results = [];
for (const [file, needle, replacement, name] of mutations) {
  const path = join(directory, file);
  const original = readFileSync(path, "utf8");
  assert.ok(original.includes(needle), `Mutation no longer applies: ${name}`);
  try {
    writeFileSync(path, original.replace(needle, replacement));
    const result = run();
    const output = `${result.stdout}\n${result.stderr}`;
    writeFileSync(join(evidence, `${name}.log`), output);
    const red = result.status !== 0 && result.status !== null && !/Transform failed|SyntaxError|Failed to load url/.test(output);
    results.push({ name, red, exitCode: result.status });
    console.log(`${red ? "RED" : "SURVIVED"}: ${name}`);
  } finally {
    writeFileSync(path, original);
  }
}
const restored = run();
writeFileSync(join(evidence, "restored.log"), `${restored.stdout}\n${restored.stderr}`);
writeFileSync(join(evidence, "summary.json"), JSON.stringify({ results, restoredExitCode: restored.status }, null, 2));
assert.ok(results.every((result) => result.red), "A mutation survived; inspect evidence");
assert.equal(restored.status, 0, "Restored suite must be GREEN");
console.log(`PASS: ${results.length}/${results.length} RED; restored GREEN. Evidence: ${evidence}`);
