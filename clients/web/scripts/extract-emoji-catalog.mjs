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
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(WEB_ROOT, "src/features/emoji/emojiCatalog.json");
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

const compact = require("emojibase-data/en/compact.json");
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
  const glyph = row.unicode;
  const name = row.label;
  if (!glyph || !name || seenGlyph.has(glyph)) continue;

  const shortcodes = shortcodesFor(row.hexcode);
  const keywords = unique(asList(row.tags)).filter(
    (tag) => !shortcodes.includes(tag) && !name.toLowerCase().includes(tag)
  );
  const skins = Array.isArray(row.skins)
    ? row.skins.map((skin) => skin.unicode).filter(Boolean)
    : [];

  seenGlyph.add(glyph);
  const entry = [glyph, name, shortcodes, keywords, category];
  if (skins.length === 5) entry.push(skins);
  items.push(entry);
}

const catalog = { v: 1, items };
const json = `${JSON.stringify(catalog)}\n`;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, json);

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
