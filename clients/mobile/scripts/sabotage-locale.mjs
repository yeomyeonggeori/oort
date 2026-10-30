/* eslint-env node, es2022 */
// Isolated source copies only. Each mutant must fail an assertion in the real suite.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(mobile, 'package.json'));
const base = require('./jest.config.js');
const temporary = mkdtempSync(join(mobile, 'src/i18n/.4833-sabotage-'));
const evidence = mkdtempSync(join(tmpdir(), 'oort-4833-sabotage-'));
const mutants = [
  {file: 'intl', from: "if (!supportsPluralRules()) load('pluralRules');", to: "load('pluralRules');", test: 'loads no polyfill'},
  {file: 'device', from: "if (next === 'active') onChange();", to: "if (next === 'active') { /* isolated mutation: refresh removed */ }", test: 'reevaluates system language on app resume'},
  // The removed #4833 guard: a Hermes global must not turn the RTF polyfill into a boot failure.
  {file: 'intl', from: "if (!supportsRelativeTimeFormat()) load('relativeTimeFormat');", to: "if (!supportsRelativeTimeFormat()) { if ('HermesInternal' in globalThis) throw new Error('intl-numberformat-prerequisite-unavailable'); load('relativeTimeFormat'); }", test: 'Apple-Hermes-shaped engine'},
  // A native RTF that merely exists and returns some text must not be accepted.
  {file: 'intl', from: "format(value, 'day') === text", to: "format(value, 'day').length > 0", test: 'replaces a native RelativeTimeFormat'},
  // Post-load verification must exercise the RTF (and a registered NumberFormat.formatToParts) too.
  {file: 'intl', from: '|| !supportsRelativeTimeFormat()) {', to: ') {', test: 'fails closed when an engine registers'},
];
function runJest(config, test) {
  const result = spawnSync(process.execPath, [join(mobile, 'node_modules/jest/bin/jest.js'),
    '--config', JSON.stringify(config), '--watchman=false', '--runInBand',
    '__tests__/mobileLocale.test.tsx', '-t', test,
  ], {cwd: mobile, encoding: 'utf8', maxBuffer: 2_000_000});
  return {status: result.status, log: result.stdout + result.stderr};
}
try {
  for (const [index, mutant] of mutants.entries()) {
    // Control first: the filtered test passes on the real source, so RED below comes from the mutation.
    const control = runJest({...base, rootDir: mobile}, mutant.test);
    assert.equal(control.status, 0, `Unmutated control must pass: ${mutant.test}`);
    assert.match(control.log, /Tests:.*\b1 passed\b/);
    const original = readFileSync(join(mobile, `src/i18n/${mutant.file}.ts`), 'utf8');
    assert.equal(original.split(mutant.from).length, 2, 'Mutation must match once');
    const path = join(temporary, `${mutant.file}.ts`);
    writeFileSync(path, original.replace(mutant.from, mutant.to));
    const {status, log} = runJest({...base, rootDir: mobile, moduleNameMapper: {
      ...base.moduleNameMapper, [`^\\.\\./src/i18n/${mutant.file}$`]: path,
    }}, mutant.test);
    writeFileSync(join(evidence, `${index}-${mutant.file}.log`), log);
    assert.equal(status, 1, 'Mutant must fail');
    assert.match(log, /Expected(?: substring| number of calls)?:|expect\(received\)\.(?:not\.)?to/);
    assert.match(log, /1 failed/);
    assert.doesNotMatch(log, /Test suite failed to run|SyntaxError|Cannot find module/);
    console.log(`${mutant.file}: control PASS, mutant RED by assertion: ${log.match(/^\s+● (.+)$/m)?.[1]}`);
  }
} finally {
  for (const mutant of mutants) {
    try { unlinkSync(join(temporary, `${mutant.file}.ts`)); } catch { /* A failed write leaves no file. */ }
  }
  rmdirSync(temporary);
}
console.log(`Evidence: ${evidence}`);
