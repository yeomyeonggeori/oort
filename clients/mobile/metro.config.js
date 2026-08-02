const fs = require('fs');
const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

/**
 * Metro — the app's half of the `@momo/core` contract (ADR-0137 D3, goal RN-C2).
 *
 * The core is a package OUTSIDE this project directory (`packages/momo-core`),
 * it ships raw TypeScript (`exports: {"./*": "./src/*.ts"}`), and it declares
 * **zero runtime dependencies** on purpose — the purity gate fails if that ever
 * stops being true.
 *
 * Three things follow, and each maps to one setting below:
 *
 *   watchFolders      Metro refuses to serve a file it is not watching. Without
 *                     the core in this list every `@momo/core/...` import fails
 *                     from the bundler rather than from the resolver, which is a
 *                     considerably more confusing error to read.
 *
 *   resolveRequest    `@momo/core/lib/api` maps to
 *                     `packages/momo-core/src/lib/api.ts` BY PATH, not through
 *                     node_modules. Same choice `clients/web` documents on its
 *                     Vite alias: an alias cannot drift with a lockfile, and
 *                     there is exactly one copy of the source on disk that both
 *                     consumers compile. Two clients, one file — which is the
 *                     entire point of the extraction.
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
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
