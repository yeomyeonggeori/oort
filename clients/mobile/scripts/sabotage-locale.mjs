/* eslint-env node, es2022 */
// Each mutant must fail an assertion in the real suite, after its unmutated control passed.
//   source mutants  isolated copies of one src/i18n file, mapped over the original by jest;
//                   the file on disk is never edited.
//   config mutants  the jest config is passed as an object; package.json / metro.config.js have no
//                   seam, so they are edited IN PLACE, restored in `finally` (and on exit/signal),
//                   and the restored bytes are compared with the originals.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
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

const LOCALE = '__tests__/mobileLocale.test.tsx';
const SHIPPED = '__tests__/shippedCoreDependencies.test.ts';
const sourceMutants = [
  {name: 'PluralRules: always load', file: 'intl', ext: 'ts', from: "if (!supportsPluralRules()) load('pluralRules');", to: "load('pluralRules');", suite: LOCALE, test: 'loads no polyfill'},
  {name: 'device: app resume refresh removed', file: 'device', ext: 'ts', from: "if (next === 'active') onChange();", to: "if (next === 'active') { /* isolated mutation: refresh removed */ }", suite: LOCALE, test: 'reevaluates system language on app resume'},
  // The removed #4833 guard: a Hermes global must not turn the RTF polyfill into a boot failure.
  {name: 'RTF: Hermes global blocks boot again', file: 'intl', ext: 'ts', from: "if (!supportsRelativeTimeFormat()) load('relativeTimeFormat');", to: "if (!supportsRelativeTimeFormat()) { if ('HermesInternal' in globalThis) throw new Error('intl-numberformat-prerequisite-unavailable'); load('relativeTimeFormat'); }", suite: LOCALE, test: 'Apple-Hermes-shaped engine'},
  // A native RTF that merely exists and returns some text must not be accepted.
  {name: 'RTF: any non-empty text accepted', file: 'intl', ext: 'ts', from: "format(value, 'day') === text", to: "format(value, 'day').length > 0", suite: LOCALE, test: 'replaces a native RelativeTimeFormat'},
  // Post-load verification must exercise the RTF (and a registered NumberFormat.formatToParts) too.
  {name: 'recheck: RTF removed', file: 'intl', ext: 'ts', from: '|| !supportsRelativeTimeFormat()) {', to: ') {', suite: LOCALE, test: 'fails closed when an engine registers'},
  // #4833 review, item 2: the six measurements the Intl tests must hold.
  {name: 'R1 recheck: Locale removed', file: 'intl', ext: 'ts', from: 'if (!supportsLocale() || !supportsPluralRules() || !supportsRelativeTimeFormat()) {', to: 'if (!supportsPluralRules() || !supportsRelativeTimeFormat()) {', suite: LOCALE, test: 'fails closed when the loader leaves a Locale'},
  {name: 'R2 PluralRules: supportedLocalesOf only', file: 'intl', ext: 'ts', from: "      && COUNTS.every(count => new Intl.PluralRules(locale).select(count) === (locale === 'en-US' && count === 1 ? 'one' : 'other')));", to: '      );', suite: LOCALE, test: 'PluralRules'},
  {name: 'R3 native DateTimeFormat/NumberFormat/Collator checks removed', file: 'intl', ext: 'ts', from: 'for (const locale of CATALOG_LOCALES) {', to: 'for (const locale of CATALOG_LOCALES.slice(0, 0)) {', suite: LOCALE, test: 'when the native'},
  {name: 'R4 bootFailed removed', file: 'controller', ext: 'ts', from: "    if (bootFailed) throw new Error('mobile-locale-initialization-failed');\n", to: '', suite: LOCALE, test: 'device language cannot be read'},
  {name: 'R5 Locale: typeof only', file: 'intl', ext: 'ts', from: "    return new Intl.Locale('ko-KR').baseName === 'ko-KR'\n      && new Intl.Locale('en-US').maximize().toString() === 'en-Latn-US';", to: "    return typeof Intl.Locale === 'function';", suite: LOCALE, test: 'replaces a Locale'},
  {name: 'R6 getCanonicalLocales check removed', file: 'intl', ext: 'ts', from: "  if (typeof Intl.getCanonicalLocales !== 'function'\n    || Intl.getCanonicalLocales('ko-kr')[0] !== 'ko-KR') throw new Error('intl-canonical-locales-unavailable');\n", to: '', suite: LOCALE, test: 'getCanonicalLocales'},
  {name: 'R7 recheck: PluralRules removed', file: 'intl', ext: 'ts', from: 'if (!supportsLocale() || !supportsPluralRules() || !supportsRelativeTimeFormat()) {', to: 'if (!supportsLocale() || !supportsRelativeTimeFormat()) {', suite: LOCALE, test: 'fails closed when the loader leaves a PluralRules'},
  // #4833 review, Medium 2 and 3.
  {name: 'M2 unreadable stored preference blocks boot again', file: 'controller', ext: 'ts', from: "if (entry.code === 'device-read-failed') bootFailed = true;", to: "if (entry.code === 'preference-read-failed' || entry.code === 'device-read-failed') bootFailed = true;", suite: LOCALE, test: 'stored preference'},
  {name: 'M3 language row label without the beta tag', file: 'LanguageSettings', ext: 'tsx', from: "                    accessibilityLabel={`${localeAutonyms[id]}, ${beta}`}\n", to: '', suite: LOCALE, test: 'switches the whole mounted context'},
];

const NODE_MODULES_CORE_MAPPERS = new Set(['^@momo/core/(.*)$', '^@babel/runtime/(.*)$']);
const configMutants = [
  // Guard 1: the phone declares what the core ships.
  {name: 'G1 phone no longer declares @formatjs/intl', inPlace: 'package.json', from: '    "@formatjs/intl": "6.1.4",\n', to: '', suite: SHIPPED, test: 'lists every core runtime dependency'},
  {name: 'G1 phone declares a range instead of the exact pin', inPlace: 'package.json', from: '"@formatjs/intl": "6.1.4"', to: '"@formatjs/intl": "^6.1.4"', suite: SHIPPED, test: 'lists every core runtime dependency'},
  // Guard 2: Metro watches nothing outside the project but the core source.
  {name: 'G2 repo-root node_modules is a watch folder again', inPlace: 'metro.config.js', from: '  watchFolders: [CORE_SRC],', to: "  watchFolders: [CORE_SRC, path.resolve(__dirname, '../../node_modules')],", suite: SHIPPED, test: 'watches no folder outside this project'},
  // Guard 3: a bare import made by core source resolves into this project's node_modules.
  {name: 'G3 core bare imports use Metro default lookup (repo root wins)', inPlace: 'metro.config.js', from: 'if (isCoreSource(context.originModulePath) && isBareModule(moduleName)) {', to: 'if (false) {', suite: SHIPPED, test: 'imported by core source'},
  {name: 'G3 core bare imports may fall back to the repo root', inPlace: 'metro.config.js', from: '            disableHierarchicalLookup: true,', to: '            disableHierarchicalLookup: false,', suite: SHIPPED, test: 'does not let a repo-root install'},
  // jest.config.js: the core's bare imports resolve into this project's node_modules.
  {name: 'J jest resolves core runtime dependencies by walking up (repo root wins)', suite: SHIPPED, test: 'hands the core the same',
    config: () => ({...base, rootDir: mobile, moduleNameMapper: Object.fromEntries(Object.entries(base.moduleNameMapper).filter(([key]) => NODE_MODULES_CORE_MAPPERS.has(key)))})},
];

const originals = new Map();
const created = [];
function restoreAll() {
  for (const [path, bytes] of originals) writeFileSync(path, bytes);
}
process.on('exit', restoreAll);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));

function runJest(config, suite, test) {
  const result = spawnSync(process.execPath, [join(mobile, 'node_modules/jest/bin/jest.js'),
    '--config', JSON.stringify(config), '--watchman=false', '--runInBand',
    suite, '-t', test,
  ], {cwd: mobile, encoding: 'utf8', maxBuffer: 8_000_000});
  return {status: result.status, log: result.stdout + result.stderr};
}
const count = (log, word) => Number(log.match(new RegExp(`Tests:.*?\\b(\\d+) ${word}\\b`))?.[1] ?? 0);
const controls = new Map();
function control(suite, test) {
  const key = `${suite} :: ${test}`;
  if (!controls.has(key)) {
    // Control first: the filtered tests pass on the real source, so RED below comes from the mutation.
    const result = runJest({...base, rootDir: mobile}, suite, test);
    assert.equal(result.status, 0, `Unmutated control must pass: ${key}\n${result.log.slice(-1500)}`);
    assert.equal(count(result.log, 'failed'), 0);
    assert(count(result.log, 'passed') >= 1, `Control ran no test: ${key}`);
    controls.set(key, count(result.log, 'passed'));
  }
  return controls.get(key);
}
function assertRed(index, mutant, {status, log}, controlPassed) {
  writeFileSync(join(evidence, `${String(index).padStart(2, '0')}-${mutant.name.replace(/[^A-Za-z0-9]+/g, '-')}.log`), log);
  assert.equal(status, 1, `Mutant must fail: ${mutant.name}`);
  // A failing ASSERTION (jest prints `expect(...)`), not a suite that could not run.
  // (jest prints `expect(…)`; React Native Testing Library's query failures read `Unable to find an element`.)
  assert.match(log, /expect\((?:received|jest\.fn\(\)|[^)]*)\)\.|Expected(?: substring| number of calls)?:|Received (?:promise (?:resolved|rejected)|function did not throw)|Unable to find an element/, `Not an assertion failure: ${mutant.name}`);
  assert(count(log, 'failed') >= 1, `No failing test: ${mutant.name}`);
  assert.doesNotMatch(log, /Test suite failed to run|SyntaxError|Cannot find module/, `Mutant did not run: ${mutant.name}`);
  const failing = [...log.matchAll(/^\s+● (.+)$/gm)].map(match => match[1]).filter((name, i, all) => all.indexOf(name) === i);
  console.log(`${mutant.name}: control PASS (${controlPassed}), mutant RED (${count(log, 'failed')} failed) by assertion: ${failing[0]}`);
}
/** Relative imports of an isolated copy would resolve against the temporary directory. */
function absolutizeImports(source, realFile) {
  return source.replace(/(\bfrom\s+|\bimport\(\s*|\brequire\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g,
    (_all, lead, quote, specifier) => `${lead}${quote}${resolve(dirname(realFile), specifier)}${quote}`);
}

let index = 0;
try {
  for (const mutant of sourceMutants) {
    index += 1;
    const controlPassed = control(mutant.suite, mutant.test);
    const real = join(mobile, `src/i18n/${mutant.file}.${mutant.ext}`);
    const original = readFileSync(real, 'utf8');
    assert.equal(original.split(mutant.from).length, 2, `Mutation must match once: ${mutant.name}`);
    const path = join(temporary, `${mutant.file}.${mutant.ext}`);
    created.push(path);
    writeFileSync(path, absolutizeImports(original.replace(mutant.from, mutant.to), real));
    assertRed(index, mutant, runJest({...base, rootDir: mobile, moduleNameMapper: {
      ...base.moduleNameMapper, [`^\\.\\./src/i18n/${mutant.file}$`]: path,
    }}, mutant.suite, mutant.test), controlPassed);
  }
  for (const mutant of configMutants) {
    index += 1;
    const controlPassed = control(mutant.suite, mutant.test);
    if (mutant.config) {
      assertRed(index, mutant, runJest(mutant.config(), mutant.suite, mutant.test), controlPassed);
      continue;
    }
    const real = join(mobile, mutant.inPlace);
    const original = readFileSync(real);
    const digest = createHash('sha256').update(original).digest('hex');
    assert.equal(original.toString('utf8').split(mutant.from).length, 2, `Mutation must match once: ${mutant.name}`);
    originals.set(real, original);
    try {
      writeFileSync(real, original.toString('utf8').replace(mutant.from, mutant.to));
      assertRed(index, mutant, runJest({...base, rootDir: mobile}, mutant.suite, mutant.test), controlPassed);
    } finally {
      writeFileSync(real, original);
      originals.delete(real);
      assert.equal(createHash('sha256').update(readFileSync(real)).digest('hex'), digest, `Original not restored: ${mutant.inPlace}`);
    }
  }
} finally {
  for (const path of created) {
    try { unlinkSync(path); } catch { /* A failed write leaves no file. */ }
  }
  rmdirSync(temporary);
}
console.log(`${index} mutants, every control passed and every mutant failed an assertion. Evidence: ${evidence}`);
