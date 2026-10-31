const fs = require('fs');
const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

/**
 * Metro — the app's half of the `@momo/core` contract (ADR-0137 D3, goal RN-C2).
 *
 * The core is a package OUTSIDE this project directory (`packages/momo-core`),
 * it ships raw TypeScript (`exports: {"./*": "./src/*.ts"}`), and it declares
 * one approved runtime dependency, FormatJS `@formatjs/intl` (ADR-0213).
 *
 * What the phone ships, the phone declares (#4833 review). Xcode Cloud
 * (`ios/ci_scripts/ci_post_clone.sh`), `scripts/archive-release.sh`,
 * `scripts/build-sim.sh` and `scripts/lane-phone.sh` run `npm ci` in
 * `clients/mobile` and NEVER at the repository root, and the archive records
 * only this project's lock hash. So `package.json` lists every runtime
 * dependency of the core at the core's exact version, this project's lockfile
 * pins the transitive closure, and Metro resolves the core's bare imports from
 * THIS project's `node_modules` whether or not a repo-root install exists on
 * the machine. A bundle that leaned on the root install built on a laptop and
 * could not even start on the build host (Metro died with `ENOENT … /node_modules`
 * in `Transformer.js` because the watched root folder was missing).
 * `__tests__/shippedCoreDependencies.test.ts` pins all three halves.
 *
 * Three things follow, and each maps to one setting below:
 *
 *   watchFolders      Metro refuses to serve a file it is not watching. Without
 *                     the core in this list every `@momo/core/...` import fails
 *                     from the bundler rather than from the resolver, which is a
 *                     considerably more confusing error to read. It is the ONLY
 *                     folder outside this project that is watched: everything
 *                     else that ships, FormatJS included, lives in this
 *                     project's own `node_modules`.
 *
 *   resolveRequest    Two jobs. `@momo/core/lib/api` maps to
 *                     `packages/momo-core/src/lib/api.ts` BY PATH, not through
 *                     node_modules. Same choice `clients/web` documents on its
 *                     Vite alias: an alias cannot drift with a lockfile, and
 *                     there is exactly one copy of the source on disk that both
 *                     consumers compile. Two clients, one file — which is the
 *                     entire point of the extraction.
 *                     And a bare module that core source imports
 *                     (`@formatjs/intl`) is resolved as if the app root had
 *                     imported it, from this project's `node_modules` only.
 *                     Metro's default walks up from the core file instead and
 *                     finds whatever the workspace install hoisted to the
 *                     repository root, which the build host does not have.
 *
 *   nodeModulesPaths  Core source is transpiled while living outside this tree,
 *                     so its babel runtime helpers must still resolve to this
 *                     project's copy: `packages/momo-core/node_modules` holds
 *                     only the core's devDependencies and no `@babel/runtime`.
 *
 * NOT here: any `clients/web` path. The spike harness pointed at the web source
 * tree because its job was to prove `deepLink.ts` passed unmodified. This app
 * consumes the core and nothing else, so a web import is a layering mistake and
 * should fail to resolve rather than quietly work.
 */
const CORE_SRC = path.resolve(__dirname, '../../packages/momo-core/src');
const PROJECT_NODE_MODULES = path.resolve(__dirname, 'node_modules');
/** A file inside this project: where a core file's bare import is resolved from. */
const APP_ORIGIN = path.join(__dirname, 'index.js');

/** `lib/api` -> `<core>/src/lib/api.ts`, trying the extensions Metro would. */
function resolveCoreSource(rest) {
  const base = path.join(CORE_SRC, rest);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

const isCoreSource = filePath => filePath.startsWith(CORE_SRC + path.sep);

/** `@formatjs/intl`, `@scope/pkg/sub`: not `./x`, `../x`, `/abs`, `#internal` or `@momo/core/…`. */
const isBareModule = moduleName =>
  !path.isAbsolute(moduleName) &&
  !/^(?:\.\.?(?:\/|$)|#)/.test(moduleName) &&
  !moduleName.startsWith('@momo/core/');

const config = {
  watchFolders: [CORE_SRC],
  resolver: {
    nodeModulesPaths: [PROJECT_NODE_MODULES],
    extraNodeModules: {
      '@babel/runtime': path.join(PROJECT_NODE_MODULES, '@babel/runtime'),
    },
    resolveRequest: (context, moduleName, platform) => {
      if (moduleName.startsWith('@momo/core/')) {
        const filePath = resolveCoreSource(
          moduleName.slice('@momo/core/'.length),
        );
        if (filePath) {
          return {type: 'sourceFile', filePath};
        }
        throw new Error(
          `[momo-mobile] '${moduleName}' does not exist under ${CORE_SRC}. ` +
            'The core resolves by path, so this is a wrong file name rather ' +
            'than a missing install.',
        );
      }
      if (isCoreSource(context.originModulePath) && isBareModule(moduleName)) {
        // Strict on purpose: no hierarchical walk, so an import the phone has
        // not declared fails here on every machine instead of resolving to a
        // root install on this one and failing only on the build host.
        return context.resolveRequest(
          {
            ...context,
            originModulePath: APP_ORIGIN,
            disableHierarchicalLookup: true,
          },
          moduleName,
          platform,
        );
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
