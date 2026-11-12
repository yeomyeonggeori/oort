// Node-only test fixtures; not part of the public/runtime exports.
import {existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const CATALOGS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'catalogs');

/** Feature file names of one product catalog directory, or undefined when it is missing. */
export function productFeatures(locale) {
  const dir = join(CATALOGS, locale);
  return existsSync(dir) ? readdirSync(dir).filter(file => file.endsWith('.json')).sort() : undefined;
}

/** Writes one extra feature file into a fixture catalog. */
export function writeFeature(root, locale, feature, source) {
  mkdirSync(join(root, locale), {recursive: true});
  writeFileSync(join(root, locale, feature), typeof source === 'string' ? source : JSON.stringify(source));
}

/** Deletes one language directory from a fixture catalog root. */
export function removeLocale(root, locale) {
  rmSync(join(root, locale), {recursive: true, force: true});
  return existsSync(join(root, locale));
}

export function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'oort-i18n-4830-'));
  const write = (locale, source) => {
    mkdirSync(join(root, locale), {recursive: true});
    writeFileSync(join(root, locale, 'sample.json'), typeof source === 'string' ? source : JSON.stringify(source));
  };
  write('en-US', {'sample.surface.label': 'Sample'});
  write('ko-KR', {'sample.surface.label': '예시'});
  // Draft languages mirror the feature files; an empty file means every key falls back to English.
  for (const locale of ['ja-JP', 'zh-Hans', 'zh-Hant', 'es-419', 'fr-FR']) write(locale, {});
  try { run(root, write); }
  finally { rmSync(root, {recursive: true, force: true}); }
}

export function tamperGenerated(outputRoot) {
  const file = join(outputRoot, 'en-US.ts');
  writeFileSync(file, readFileSync(file, 'utf8').replace('Sample', 'Tampered'));
}
