// Node-only test fixtures; not part of the public/runtime exports.
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'oort-i18n-4830-'));
  const write = (locale, source) => {
    mkdirSync(join(root, locale), {recursive: true});
    writeFileSync(join(root, locale, 'sample.json'), typeof source === 'string' ? source : JSON.stringify(source));
  };
  write('en-US', {'sample.surface.label': 'Sample'});
  write('ko-KR', {'sample.surface.label': '예시'});
  try { run(root, write); }
  finally { rmSync(root, {recursive: true, force: true}); }
}

export function tamperGenerated(outputRoot) {
  const file = join(outputRoot, 'en-US.ts');
  writeFileSync(file, readFileSync(file, 'utf8').replace('Sample', 'Tampered'));
}
