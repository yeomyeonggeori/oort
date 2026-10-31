/* eslint-env node, es2022 */
// Shipping Metro configuration, no transformer/resolver replacements.
// Confirms the emitted dependency closure instead of accepting a smaller null graph, and that every
// FormatJS module comes from clients/mobile/node_modules (what the phone declares), never from a
// repo-root install: the build hosts `npm ci` only this project (#4833 review). Runs on a source-only
// copy too (git archive of clients/mobile + packages/momo-core, no root node_modules, no .git).
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, statSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(mobile, 'package.json'));
const metro = require('metro');
const config = await metro.loadConfig({cwd: mobile, config: join(mobile, 'metro.config.js')});
const baselineRef = process.argv[process.argv.indexOf('--baseline-ref') + 1];
const baseline = process.argv.includes('--baseline-ref');
if (baseline) assert.match(baselineRef, /^[a-f0-9]{40}$/, 'Use the exact pre-change HEAD');
const emitted = new Map();
const relevant = path => /node_modules\/(?:@formatjs\/|intl-messageformat\/)/.test(path);
const output = mkdtempSync(join(tmpdir(), 'oort-4833-shipping-'));
const probe = process.argv.includes('--probe');
assert(!(probe && baseline), 'Choose a product baseline or a probe');
const entry = join(mobile, probe ? 'scripts/hermes-intl-probe.js' : 'index.js');
// Same shipping resolver/Babel config/dependencies. Only the three changed product
// sources use their pre-change bytes in the baseline; files on disk are never edited.
const transformer = join(output, 'baseline-transformer.cjs');
if (baseline) {
  const snapshots = {};
  for (const relative of ['App.tsx', 'src/features/profile/SettingsPage.tsx', 'src/design/sheetParts.tsx']) {
    const source = execFileSync('git', ['show', `${baselineRef}:clients/mobile/${relative}`], {cwd: mobile, encoding: 'utf8'});
    snapshots[relative] = source;
    snapshots[join(mobile, relative)] = source;
  }
  const hash = createHash('sha256').update(JSON.stringify(snapshots)).digest('hex');
  writeFileSync(transformer, `const delegate = require(${JSON.stringify(require.resolve('@react-native/metro-babel-transformer'))});\nconst sources = ${JSON.stringify(snapshots)};\nmodule.exports = {...delegate, getCacheKey() { return delegate.getCacheKey() + ${JSON.stringify(hash)}; }, transform(args) { return delegate.transform({...args, src: sources[args.filename] ?? args.src}); }};\n`);
}
const result = await metro.runBuild(metro.mergeConfig(config, {
  maxWorkers: 2, useWatchman: false,
  ...(baseline ? {transformer: {babelTransformerPath: transformer}} : {}),
  serializer: {
    ...(probe ? {getModulesRunBeforeMainModule: () => []} : {}),
    processModuleFilter(module) {
      const include = config.serializer.processModuleFilter(module);
      if (include) emitted.set(module.path, module);
      return include;
    },
  },
}), {entry, dev: false, minify: true, platform: 'ios'});
for (const pkg of baseline ? [] : ['@formatjs/intl', 'intl-messageformat', '@formatjs/intl-locale', '@formatjs/intl-pluralrules', '@formatjs/intl-relativetimeformat']) {
  assert([...emitted.keys()].some(path => path.includes(`/node_modules/${pkg}/`)), `Missing serialized package: ${pkg}`);
}
const projectModules = join(mobile, 'node_modules') + sep;
for (const [path, module] of emitted) {
  if (!relevant(path)) continue;
  assert(path.startsWith(projectModules), `FormatJS module outside clients/mobile/node_modules: ${path}`);
  const code = module.output.find(item => item.type.startsWith('js/'))?.data.code;
  assert(code && !/^\s*(?:null|undefined)\s*;?\s*$/.test(code), `Null FormatJS module: ${path}`);
  for (const dependency of module.dependencies.values()) {
    if (relevant(dependency.absolutePath)) assert(emitted.has(dependency.absolutePath), `Null FormatJS dependency: ${path} → ${dependency.absolutePath}`);
  }
}
const data = [...emitted.keys()].filter(path => /@formatjs\/.*\/locale-data\//.test(path));
assert.equal(data.length, baseline ? 0 : 4, 'Only the two shipped languages for PR/RTF are permitted');
assert(data.every(path => /\/locale-data\/(?:en|ko)\.js$/.test(path)), 'Unshipped locale-data pack');
assert(![...emitted.keys()].some(path => /i18n\/tooling\/|node_modules\/typescript\//.test(path)), 'Build-only tooling in release graph');
const bundle = join(output, 'shipping.bundle');
const hbc = join(output, 'shipping.hbc');
writeFileSync(bundle, result.code);
const compiler = join(mobile, 'node_modules/hermes-compiler/hermesc/osx-bin/hermesc');
const version = execFileSync(compiler, ['-version'], {encoding: 'utf8'});
assert(version.includes('250829098.0.16'), 'Hermes compiler version drift');
execFileSync(compiler, ['-O', '-emit-binary', '-out', hbc, bundle]);
const head = (() => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], {cwd: mobile, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim(); }
  catch { return 'no git checkout (source-only copy)'; }
})();
const report = {
  head,
  ...(baseline ? {baselineRef, baselineSources: ['App.tsx', 'src/features/profile/SettingsPage.tsx', 'src/design/sheetParts.tsx']} : {}),
  entry, output, shippingConfig: true, nullFormatjsDependencies: 0, formatjsOutsideProjectNodeModules: 0,
  raw: Buffer.byteLength(result.code), gzip: gzipSync(result.code, {level: 9}).length, hermes: statSync(hbc).size,
  formatjsModules: [...emitted.keys()].filter(relevant).map(path => path.replace(resolve(mobile, '../..') + '/', '')),
  localeData: data.map(path => path.slice(path.lastIndexOf('@formatjs/'))),
  runtime: 'compile only, not a VM run: evaluate shipping.bundle/.hbc in the locked Hermes (src/i18n/README.md records the executed probe)',
};
writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
