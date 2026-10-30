/**
 * What the phone ships, the phone declares (#4833 review, Blocker).
 *
 * `packages/momo-core` declares one runtime dependency (FormatJS, ADR-0213) and ships raw
 * TypeScript that Metro compiles into THIS app's bundle. Xcode Cloud and the archive/sim/lane
 * scripts run `npm ci` in `clients/mobile` only. A bundle that took FormatJS from a repo-root
 * install built on a developer machine and could not even start Metro on the build host — and
 * PR CI installs the root too, so nothing there noticed. These tests hold the three halves of
 * the fix; each assertion measures a real value (the files on disk, the real Metro config run
 * through the real `metro-resolver`, the real jest resolution), not a list of names.
 */
import fs from 'node:fs';
import path from 'node:path';

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '../..');
const CORE_ROOT = path.join(REPO_ROOT, 'packages/momo-core');
const CORE_SRC = path.join(CORE_ROOT, 'src');
const APP_NODE_MODULES = path.join(APP_ROOT, 'node_modules');

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

interface PackageLock {
  packages: Record<string, {version?: string; dependencies?: Record<string, string>; dependenciesMeta?: unknown}>;
}

describe('the phone declares what the core ships (package.json + lock)', () => {
  const core = readJson(path.join(CORE_ROOT, 'package.json'));
  const phone = readJson(path.join(APP_ROOT, 'package.json'));
  const lock: PackageLock = readJson(path.join(APP_ROOT, 'package-lock.json'));
  const coreDependencies: Array<[string, string]> = Object.entries(core.dependencies ?? {});

  it('lists every core runtime dependency in dependencies at the core\'s exact version, locked here', () => {
    // A loop over an empty list proves nothing: the core really has a runtime dependency.
    expect(coreDependencies.length).toBeGreaterThan(0);
    const drift: string[] = [];
    for (const [name, version] of coreDependencies) {
      if (!/^\d+\.\d+\.\d+$/.test(version)) drift.push(`${name}: the core must pin an exact version, found "${version}"`);
      if (phone.dependencies?.[name] !== version) {
        drift.push(`${name}: core ${version}, phone dependencies ${phone.dependencies?.[name] ?? '<missing>'}`);
      }
      const rootEntry = lock.packages['']?.dependencies?.[name];
      if (rootEntry !== version) drift.push(`${name}: phone lock root entry ${rootEntry ?? '<missing>'}, want ${version}`);
      const locked = lock.packages[`node_modules/${name}`]?.version;
      if (locked !== version) drift.push(`${name}: phone lock installs ${locked ?? '<missing>'}, want ${version}`);
    }
    expect(drift).toEqual([]);
  });

  it('locks the whole transitive closure of the core dependencies in this lock', () => {
    const missing: string[] = [];
    const seen = new Set<string>();
    const visit = (name: string) => {
      if (seen.has(name)) return;
      seen.add(name);
      const entry = lock.packages[`node_modules/${name}`];
      if (!entry) { missing.push(name); return; }
      for (const dependency of Object.keys(entry.dependencies ?? {})) visit(dependency);
    };
    coreDependencies.forEach(([name]) => visit(name));
    expect(seen.size).toBeGreaterThan(coreDependencies.length); // the closure is not just the roots
    expect(missing).toEqual([]);
  });
});

describe('Metro resolves what the core ships from this project only (metro.config.js)', () => {
  // The real config, as Metro loads it.
  const metroConfig = require('../metro.config.js');
  const Resolver = require('metro-resolver') as typeof import('metro-resolver');
  const coreFile = path.join(CORE_SRC, 'i18n/service.ts');

  /**
   * The real resolver and the real `resolveRequest`; only the file system is plain `fs`. The context
   * mirrors what Metro 0.84's `ModuleResolver` hands the resolver: a Metro upgrade that changes its
   * shape fails here loudly (a thrown error), it cannot make these assertions pass.
   */
  function resolveFrom(originModulePath: string, specifier: string): string {
    const {resolver} = metroConfig;
    const lookup = (candidate: string) => {
      try {
        const realPath = fs.realpathSync(candidate);
        return {exists: true, realPath, type: fs.statSync(realPath).isDirectory() ? 'd' : 'f'};
      } catch { return {exists: false}; }
    };
    const closestPackage = (absolutePath: string) => {
      for (let dir = path.dirname(absolutePath); ; dir = path.dirname(dir)) {
        const file = path.join(dir, 'package.json');
        if (fs.existsSync(file)) {
          return {packageJson: readJson(file), rootPath: dir, packageRelativePath: path.relative(dir, absolutePath)};
        }
        if (dir === path.dirname(dir)) return null;
      }
    };
    const context = {
      allowHaste: false,
      assetExts: new Set(resolver.assetExts),
      customResolverOptions: {},
      dev: false,
      disableHierarchicalLookup: resolver.disableHierarchicalLookup,
      doesFileExist: (file: string) => lookup(file).type === 'f',
      extraNodeModules: resolver.extraNodeModules,
      fileSystemLookup: lookup,
      getPackage: (file: string) => { try { return readJson(file); } catch { return null; } },
      getPackageForModule: closestPackage,
      isESMImport: true,
      mainFields: resolver.resolverMainFields,
      nodeModulesPaths: resolver.nodeModulesPaths,
      originModulePath,
      preferNativePlatform: true,
      redirectModulePath: (modulePath: string) => modulePath,
      resolveAsset: () => null,
      resolveHasteModule: () => null,
      resolveHastePackage: () => null,
      resolveRequest: resolver.resolveRequest,
      sourceExts: resolver.sourceExts,
      unstable_conditionNames: resolver.unstable_conditionNames,
      unstable_conditionsByPlatform: resolver.unstable_conditionsByPlatform,
      unstable_enablePackageExports: resolver.unstable_enablePackageExports,
      unstable_logWarning: () => {},
    };
    const result = Resolver.resolve(context as never, specifier, 'ios');
    if (result.type !== 'sourceFile') throw new Error(`${specifier}: expected a source file, got ${result.type}`);
    return result.filePath;
  }

  it('watches no folder outside this project except the core source', () => {
    const outside = (metroConfig.watchFolders as string[]).filter(folder => {
      const relative = path.relative(APP_ROOT, folder);
      return relative.startsWith('..') || path.isAbsolute(relative);
    });
    expect(outside).toEqual([CORE_SRC]);
  });

  it('resolves @formatjs/intl, imported by core source, into this project\'s node_modules', () => {
    const fromCore = resolveFrom(coreFile, '@formatjs/intl');
    const fromApp = resolveFrom(path.join(APP_ROOT, 'App.tsx'), '@formatjs/intl');
    expect(path.relative(APP_NODE_MODULES, fromCore).startsWith('..')).toBe(false);
    expect(fromCore).toBe(fromApp); // one copy, whoever asks
    expect(fromCore).toBe(path.join(APP_NODE_MODULES, '@formatjs/intl/index.js'));
  });

  it('keeps the core\'s own files and its by-path imports resolving as before', () => {
    expect(resolveFrom(coreFile, './locale')).toBe(path.join(CORE_SRC, 'i18n/locale.ts'));
    expect(resolveFrom(coreFile, '@momo/core/i18n')).toBe(path.join(CORE_SRC, 'i18n/index.ts'));
  });

  it('does not let a repo-root install stand in for a dependency the phone has not declared', () => {
    const rootModules = path.join(REPO_ROOT, 'node_modules');
    // Any package only the root installed; on a machine without a root install there is nothing to fall back to.
    const rootOnly = fs.existsSync(rootModules)
      ? fs.readdirSync(rootModules).find(name => !name.startsWith('.') && !name.startsWith('@')
        && fs.existsSync(path.join(rootModules, name, 'package.json'))
        && !fs.existsSync(path.join(APP_NODE_MODULES, name)))
      : undefined;
    if (rootOnly === undefined) return;
    expect(() => resolveFrom(coreFile, rootOnly)).toThrow();
  });
});

describe('jest resolves what the core ships from this project only (jest.config.js)', () => {
  it('hands the core the same @formatjs/intl module the phone itself imports', () => {
    // `jest.mock` is keyed by the RESOLVED path. If the core's import resolved to a different
    // copy (a repo-root install) than this file's, the mock would not reach it.
    const createIntl = jest.fn(() => ({formatMessage: () => 'from the phone\'s copy'}));
    try {
      jest.isolateModules(() => {
        jest.doMock('@formatjs/intl', () => ({createIntl, createIntlCache: () => ({})}));
        const {createMessageService} = require('@momo/core/i18n') as typeof import('@momo/core/i18n');
        expect(createMessageService({messageLocale: 'en-US'}).formatMessage('settings.profile.languageLabel'))
          .toBe('from the phone\'s copy');
      });
    } finally {
      jest.dontMock('@formatjs/intl');
    }
    expect(createIntl).toHaveBeenCalled();
  });
});
