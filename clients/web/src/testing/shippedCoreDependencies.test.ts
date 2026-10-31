/**
 * What the web ships, the web declares (#4913) — the twin of
 * `clients/mobile/__tests__/shippedCoreDependencies.test.ts`.
 *
 * `packages/momo-core` ships raw TypeScript that this app compiles into its own bundle
 * (`@momo/core` is an alias, not an install). A bare import inside a core file is resolved
 * from the CORE FILE's directory, so on a machine that ran `npm ci` at the repository root it
 * finds the root's hoisted copy and everything looks fine — on developer machines and in PR CI.
 * The server image (`server-rust/Dockerfile`) and `release-desktop.yml` run `npm ci` in
 * `clients/web` only; there `tsc -b` died with `TS2307: Cannot find module '@formatjs/intl'`
 * (and `vite build` would have died next). So three things must hold, and each assertion below
 * measures a real value, not a list of names:
 *
 *   1. every package the core's shipped source imports is declared here, at the exact version
 *      the core pins, and this project's lock installs exactly that version;
 *   2. the real TypeScript resolver, run with this app's real compiler options, takes each of
 *      those imports from THIS project's node_modules (tsconfig `paths`);
 *   3. so does the real Vite resolver, run with the real vite.config.ts (`resolve.dedupe`).
 *
 * Halves 2 and 3 compare against this project's node_modules instead of asking only "did it
 * resolve?": with a repo-root install present an unfixed config still resolves — to the root's
 * hoisted copy, which is exactly the copy the image does not have.
 */
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { resolveConfig } from "vite";

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CORE_ROOT = join(WEB_ROOT, "../../packages/momo-core");
const CORE_SRC = join(CORE_ROOT, "src");
// realpath: the merge-tree gate lends this folder's node_modules out as a symlink.
const WEB_NODE_MODULES = realpathSync(join(WEB_ROOT, "node_modules"));

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
type PackageLock = {
  packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
};
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

/** The core's TypeScript that a client bundle can pull in: everything under src but its tests. */
function shippedCoreSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return shippedCoreSources(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`. */
const packageName = (specifier: string): string =>
  specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
const isBare = (specifier: string): boolean =>
  !/^[./]/.test(specifier) && !specifier.startsWith("node:") && !specifier.startsWith("@momo/core");

// Real import declarations (the scanner skips comments and strings), type-only ones included:
// `tsc -b` needs those to resolve as much as the bundler needs the value imports.
const USES = shippedCoreSources(CORE_SRC).flatMap((file) =>
  ts
    .preProcessFile(readFileSync(file, "utf8"), true, true)
    .importedFiles.map((imported) => imported.fileName)
    .filter(isBare)
    .map((specifier) => ({ file, specifier, pkg: packageName(specifier) })),
);
const PACKAGES = [...new Set(USES.map((use) => use.pkg))].sort();

const insideWebNodeModules = (resolved: string | undefined): boolean =>
  resolved !== undefined &&
  realpathSync(resolved.split("?")[0]).startsWith(WEB_NODE_MODULES + sep);
const describeUse = (use: { file: string; specifier: string }, resolved: string | undefined) =>
  `${relative(CORE_ROOT, use.file)} imports ${use.specifier} -> ${resolved ?? "<unresolved>"}`;

function compilerOptionsOf(tsconfig: string): ts.CompilerOptions {
  const file = join(WEB_ROOT, tsconfig);
  const read = ts.readConfigFile(file, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  return ts.parseJsonConfigFileContent(read.config, ts.sys, WEB_ROOT, undefined, file).options;
}

describe("웹이 싣는 것은 웹이 선언한다 (#4913) — 코어의 bare import는 이 프로젝트에서 풀린다", () => {
  const core = readJson<PackageJson>(join(CORE_ROOT, "package.json"));
  const web = readJson<PackageJson>(join(WEB_ROOT, "package.json"));
  const lock = readJson<PackageLock>(join(WEB_ROOT, "package-lock.json"));

  it("코어 소스의 import를 실제로 읽는다 — 비어 있거나 코어의 런타임 의존을 놓치지 않는다", () => {
    // A loop over an empty list proves nothing: the core really imports FormatJS.
    expect(PACKAGES.length).toBeGreaterThan(0);
    for (const name of Object.keys(core.dependencies ?? {})) expect(PACKAGES).toContain(name);
  });

  it("그 패키지를 코어가 못 박은 정확한 버전으로 dependencies에 선언하고, 이 lock이 그 버전을 깐다", () => {
    const drift: string[] = [];
    for (const name of PACKAGES) {
      const pinned = core.dependencies?.[name] ?? core.devDependencies?.[name];
      if (pinned === undefined || !/^\d+\.\d+\.\d+$/.test(pinned)) {
        drift.push(`${name}: the core must pin an exact version, found ${pinned ?? "<none>"}`);
        continue;
      }
      if (web.dependencies?.[name] !== pinned) {
        drift.push(`${name}: core ${pinned}, web dependencies ${web.dependencies?.[name] ?? "<missing>"}`);
      }
      const root = lock.packages[""]?.dependencies?.[name];
      if (root !== pinned) drift.push(`${name}: web lock root entry ${root ?? "<missing>"}, want ${pinned}`);
      const locked = lock.packages[`node_modules/${name}`]?.version;
      if (locked !== pinned) drift.push(`${name}: web lock installs ${locked ?? "<missing>"}, want ${pinned}`);
    }
    expect(drift).toEqual([]);
  });

  it.each(["tsconfig.app.json", "tsconfig.measure.json"])(
    "TypeScript 해석기가 %s로 코어의 import를 이 프로젝트 node_modules에서 가져온다",
    (tsconfig) => {
      const options = compilerOptionsOf(tsconfig);
      const outside: string[] = [];
      for (const use of USES) {
        const resolved = ts.resolveModuleName(use.specifier, use.file, options, ts.sys).resolvedModule
          ?.resolvedFileName;
        if (!insideWebNodeModules(resolved)) outside.push(describeUse(use, resolved));
      }
      expect(outside).toEqual([]);
    },
  );

  it("Vite 해석기가 vite.config.ts로 코어의 import를 이 프로젝트 node_modules에서 가져온다", async () => {
    const config = await resolveConfig(
      { root: WEB_ROOT, configFile: join(WEB_ROOT, "vite.config.ts") },
      "build",
    );
    const resolve = config.createResolver();
    const outside: string[] = [];
    for (const use of USES) {
      const resolved = await resolve(use.specifier, use.file);
      if (!insideWebNodeModules(resolved)) outside.push(describeUse(use, resolved));
    }
    expect(outside).toEqual([]);
  });
});
