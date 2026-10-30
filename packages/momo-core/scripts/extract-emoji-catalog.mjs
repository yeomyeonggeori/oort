#!/usr/bin/env node
// =============================================================================
// Build-time emoji catalog extract (#1742).
//
// Reads emojibase-data compact(en) + the iamcal (Slack) shortcode preset and
// writes a same-origin JSON with only the fields the picker needs: glyph, CLDR
// name, shortcodes, keywords, category, optional skin glyphs.
//
//   node scripts/extract-emoji-catalog.mjs
//
// The generated file is committed so runtime does not import emojibase-data
// (devDependency, extract-only). Budget: gzip <= 120 kB.
// =============================================================================

import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(CORE_ROOT, "src/features/emoji/emojiCatalog.json");
const BUDGET_GZ = 120 * 1024;

/** emojibase group → picker category (emoji-mart order, minus frequent). */
const GROUP_TO_CATEGORY = {
  0: 0, // smileys-emotion → people
  1: 0, // people-body → people
  3: 1, // animals-nature → nature
  4: 2, // food-drink → foods
  6: 3, // activities → activity
  5: 4, // travel-places → places
  7: 5, // objects
  8: 6, // symbols
  9: 7, // flags
};

const pkg = require("emojibase-data/package.json");
if (pkg.version !== "18.0.0") throw new Error("Expected emojibase-data 18.0.0");
const compact = require("emojibase-data/en/compact.json");
const full = new Map(
  require("emojibase-data/en/data.json").map((row) => [row.hexcode, row])
);
const korean = new Map(
  require("emojibase-data/ko/data.json").map((row) => [row.hexcode, row])
);
const metadata = {};
// Preserve pre-#4322 inserted/stored glyph identities, including their VS16.
const fold = glyph => glyph.replaceAll("\uFE0F", "");
const presentations = new Map(require("../src/features/emoji/presentationAliases.json")
  .map(glyph => [fold(glyph), glyph]));
const iamcal = require("emojibase-data/en/shortcodes/iamcal.json");

function asList(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const next = String(value).trim().toLowerCase();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
  }
  return out;
}

function shortcodesFor(hexcode) {
  return unique(asList(iamcal[hexcode]));
}

const items = [];
const seenGlyph = new Set();

for (const row of compact) {
  const group = row.group;
  if (group === 2 || group === undefined) continue;
  const category = GROUP_TO_CATEGORY[group];
  if (category === undefined) continue;
  const glyph = presentations.get(fold(row.unicode)) ?? row.unicode;
  const name = row.label;
  if (!glyph || !name || seenGlyph.has(glyph)) continue;

  const shortcodes = shortcodesFor(row.hexcode);
  const keywords = unique(asList(row.tags)).filter(
    (tag) => !shortcodes.includes(tag) && !name.toLowerCase().includes(tag)
  );
  const detail = full.get(row.hexcode);
  const ko = korean.get(row.hexcode);
  const variants = detail?.skins ?? [];
  const uniform = variants.filter(
    (skin) => !Array.isArray(skin.tone) || new Set(skin.tone).size === 1
  );
  const skins = uniform.map((skin) => skin.emoji);
  metadata[glyph] = {
    ko: ko?.label ?? name,
    version: detail.version,
    ...(skins.length === 5
      ? { skinVersions: uniform.map((skin) => skin.version) }
      : {}),
  };

  seenGlyph.add(glyph);
  const entry = [glyph, name, shortcodes, keywords, category];
  if (skins.length === 5) entry.push(skins);
  items.push(entry);
  // Mixed-tone sequences cannot be expressed by one global tone. Keep each selectable.
  for (const skin of variants.filter(
    (skin) => Array.isArray(skin.tone) && new Set(skin.tone).size > 1
  )) {
    if (seenGlyph.has(skin.emoji)) continue;
    seenGlyph.add(skin.emoji);
    const translated = ko?.skins?.find(
      (value) => value.hexcode === skin.hexcode
    );
    items.push([
      skin.emoji,
      skin.label,
      shortcodesFor(skin.hexcode),
      unique([...(translated?.tags ?? []), ...(skin.tags ?? [])]),
      category,
    ]);
    metadata[skin.emoji] = {
      ko: translated?.label ?? skin.label,
      version: skin.version,
    };
  }
}

const catalog = {
  v: 2,
  source: `emojibase-data@${pkg.version}`,
  items,
  metadata,
};
const json = `${JSON.stringify(catalog)}\n`;
// Components and regional indicator fragments are not standalone emoji choices.
const represented = new Set(items.flatMap(row => [row[0], ...(row[5] ?? [])]).map(fold));
const missing = [...full.values()]
  .filter(row => row.group !== undefined && row.group !== 2)
  .flatMap(row => [row, ...(row.skins ?? [])])
  .filter(row => !represented.has(fold(row.emoji)));
if (missing.length) throw new Error(`Missing emoji: ${missing.map(row => row.hexcode).join(", ")}`);
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== json) throw new Error("Emoji catalog is stale; run npm run extract:emoji");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
}

const raw = Buffer.byteLength(json);
const gz = gzipSync(json).length;
const byCat = Array.from({ length: 8 }, () => 0);
for (const item of items) byCat[item[4]] += 1;

console.log(
  JSON.stringify(
    {
      out: OUT,
      count: items.length,
      bytes: raw,
      gzip: gz,
      budget: BUDGET_GZ,
      byCategory: byCat,
    },
    null,
    2
  )
);

if (gz > BUDGET_GZ) {
  console.error(`emoji catalog gzip ${gz} exceeds budget ${BUDGET_GZ}`);
  process.exit(1);
}
