// Same checkout/config, full product entries, controlled i18n import. No product file edits.
// node packages/momo-core/src/i18n/tooling/measure-bundles.mjs web|mobile
// Optional mobile prerequisites: --include-workspace-node-modules --transform-class-static-block
import {mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const output = mkdtempSync(join(tmpdir(), 'oort-4830-bundles-'));
const api = join(repo, 'packages/momo-core/src/i18n/index.ts');
const probe = `
import {createMessageService, loadMessageCatalog} from ${JSON.stringify(api)};
globalThis.__oortI18nSizeProbe = Promise.all(['en-US', 'ko-KR'].map(async locale => {
  const catalog = await loadMessageCatalog(locale);
  const service = createMessageService({messageLocale: locale, catalog});
  return [service.formatMessage('settings.profile.languageLabel'), service.formatMessage('common.members.count', {count: 2})];
}));
`;
const report = {head: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repo, encoding: 'utf8'}).trim(), output};

function files(root) {
  return readdirSync(root).flatMap(name => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

if (process.argv[2] === 'web') {
  const web = join(repo, 'clients/web');
  const {build} = await import(pathToFileURL(join(web, 'node_modules/vite/dist/node/index.js')));
  report.platform = 'Vite production; full app; per-file gzip level 9; JS + CSS';
  for (const phase of ['before', 'after']) {
    const modules = new Set();
    await build({
      root: web, configFile: join(web, 'vite.config.ts'), mode: 'production',
      logLevel: 'warn',
      plugins: [{
        name: 'oort-i18n-size-probe',
        transform(code, id) { return phase === 'after' && id === join(web, 'src/main.tsx') ? code + probe : null; },
        generateBundle(_opts, bundle) {
          for (const item of Object.values(bundle)) {
            if (item.type === 'chunk') for (const id of Object.keys(item.modules)) modules.add(id);
          }
        },
      }],
      build: {outDir: join(output, phase), emptyOutDir: true},
    });
    const assets = files(join(output, phase)).filter(f => /\.(js|css)$/.test(f));
    report[phase] = {
      raw: assets.reduce((sum, f) => sum + statSync(f).size, 0),
      gzip: assets.reduce((sum, f) => sum + gzipSync(readFileSync(f), {level: 9}).length, 0),
      parserIncluded: [...modules].some(id => id.includes('@formatjs/icu-messageformat-parser')),
      buildToolsIncluded: [...modules].some(id => /i18n\/tooling\/|node_modules\/typescript\//.test(id)),
      formatjsModules: [...modules].filter(id => /@formatjs\/|intl-messageformat/.test(id)).map(id => id.replace(repo + '/', '')),
    };
  }
} else if (process.argv[2] === 'mobile') {
  const mobile = join(repo, 'clients/mobile');
  const require = createRequire(join(mobile, 'package.json'));
  const metro = require('metro');
  const base = await metro.loadConfig({cwd: mobile, config: join(mobile, 'metro.config.js')});
  const includeWorkspace = process.argv.includes('--include-workspace-node-modules');
  const transformStaticBlock = process.argv.includes('--transform-class-static-block');
  const transformer = join(output, 'static-block-transformer.cjs');
  if (transformStaticBlock) {
    const delegate = require.resolve('@react-native/metro-babel-transformer');
    const plugin = require.resolve('@babel/plugin-transform-class-static-block');
    writeFileSync(transformer, `const delegate = require(${JSON.stringify(delegate)});
module.exports = {...delegate,
  getCacheKey() { return delegate.getCacheKey() + '-4830-class-static-block-v1'; },
  transform(args) { return delegate.transform({...args, plugins: [...(args.plugins || []), ${JSON.stringify(plugin)}]}); }
};\n`);
  }
  let modules = new Set();
  // The temp entry must be visible to Metro in BOTH phases. No shipping config is changed.
  const config = metro.mergeConfig(base, {
    watchFolders: [...base.watchFolders, output, ...(includeWorkspace ? [join(repo, 'node_modules')] : [])], maxWorkers: 2,
    useWatchman: false,
    ...(transformStaticBlock ? {transformer: {babelTransformerPath: transformer}} : {}),
    serializer: {processModuleFilter(module) {
      modules.add(module.path);
      return base.serializer.processModuleFilter(module);
    }},
  });
  report.platform = 'Metro iOS release JS; dev=false; minify=true; shipping resolver + temp-entry watchFolder'
    + (includeWorkspace ? ' + workspace node_modules watchFolder (integration prerequisite)' : '')
    + (transformStaticBlock ? ' + existing static-block Babel plugin (integration prerequisite)' : '');
  for (const phase of ['before', 'after']) {
    modules = new Set();
    const entry = join(output, `${phase}.js`);
    writeFileSync(entry, `import ${JSON.stringify(join(mobile, 'index.js'))};\n` + (phase === 'after' ? probe : ''));
    try {
      const result = await metro.runBuild(config, {entry, dev: false, minify: true, platform: 'ios'});
      const formatjsModules = [...modules].filter(id => /@formatjs\/|intl-messageformat/.test(id));
      if (phase === 'after' && !formatjsModules.some(id => id.includes('@formatjs/intl/'))) {
        throw new Error('runtime-unverified: FormatJS missing from serialized Metro graph (null dependency slot). P0-4 must include workspace node_modules in watchFolders. This is not a valid size measurement.');
      }
      const bundle = join(output, `${phase}.bundle`);
      writeFileSync(bundle, result.code);
      report[phase] = {
        raw: Buffer.byteLength(result.code), gzip: gzipSync(result.code, {level: 9}).length,
        formatjsModules: formatjsModules.map(id => id.replace(repo + '/', '')),
        buildToolsIncluded: [...modules].some(id => /i18n\/tooling\/|node_modules\/typescript\//.test(id)),
      };
      const hermesc = join(mobile, 'node_modules/hermes-compiler/hermesc/osx-bin/hermesc');
      try {
        const hbc = join(output, `${phase}.hbc`);
        execFileSync(hermesc, ['-O', '-emit-binary', '-out', hbc, bundle], {stdio: 'pipe'});
        report[phase].hermes = statSync(hbc).size;
      } catch (error) { report[phase].hermesError = String(error.message).slice(0, 1000); }
    } catch (error) {
      report[phase] = {error: String(error.message).slice(0, 1800)};
    }
  }
} else throw new Error('Choose web or mobile');

if (report.before?.raw !== undefined && report.after?.raw !== undefined) {
  report.delta = {raw: report.after.raw - report.before.raw, gzip: report.after.gzip - report.before.gzip};
  if (report.after.hermes !== undefined && report.before.hermes !== undefined) report.delta.hermes = report.after.hermes - report.before.hermes;
}
writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
