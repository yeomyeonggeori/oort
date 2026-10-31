import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expect, it} from 'vitest';

it('keeps web direct UI copy within the committed extraction ledger', () => {
  const scanner = fileURLToPath(new URL('../../../../packages/momo-core/src/i18n/tooling/direct-copy.mjs', import.meta.url));
  expect(() => execFileSync(process.execPath, [scanner, 'web'], {encoding: 'utf8'})).not.toThrow();
});
