import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';

it('keeps mobile direct UI copy within the committed extraction ledger', () => {
  const scanner = resolve(__dirname, '../../../packages/momo-core/src/i18n/tooling/direct-copy.mjs');
  expect(() => execFileSync(process.execPath, [scanner, 'mobile'], {encoding: 'utf8'})).not.toThrow();
});
