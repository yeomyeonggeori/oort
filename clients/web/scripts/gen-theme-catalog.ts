// =============================================================================
// 테마 카탈로그를 상류 npm tarball에서 다시 쓴다 (ADR-0189 증보 3 D1, AP-1b #4188).
//
//   npm pack @shikijs/themes@4.1.0 tm-themes@1.12.12 --pack-destination <dir>
//   npm --prefix clients/web run gen:theme-catalog -- --from <dir>          # 쓴다
//   npm --prefix clients/web run gen:theme-catalog -- --from <dir> --check  # 커밋본과 바이트 비교, 다르면 exit 1
//
// `<dir>`에는 tarball 두 개(`shikijs-themes-*.tgz`, `tm-themes-*.tgz`)가 있어야 한다. 이 도구는 둘을
// 메모리에서 풀고(`readTgz`) 해시를 헤더에 적는다. **devDependency를 더하지 않는다**: `tm-themes`는
// MIT로 표기되지만 GPL-3.0 테마 파일(`aurora-x`)을 안에 들고 있어서 의존으로 들이지 않는 것이 깔끔하다.
//
// 규칙(허용 라이선스·금지 이름·모드 일치)은 `scripts/lib/catalogBuild.ts`에 있고 시험이 잰다.
// 쓰는 파일은 셋이다:
//   packages/momo-core/src/design/themeCatalog.generated.ts
//   packages/momo-core/src/design/themeCatalogIndex.generated.ts
//   legal/generated/THEME_PALETTE_NOTICES.txt
// =============================================================================
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalog, readTgz, sha256Hex } from "./lib/catalogBuild";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
export const OUTPUTS = {
  catalog: join(REPO, "packages/momo-core/src/design/themeCatalog.generated.ts"),
  index: join(REPO, "packages/momo-core/src/design/themeCatalogIndex.generated.ts"),
  notices: join(REPO, "legal/generated/THEME_PALETTE_NOTICES.txt"),
} as const;

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function findTgz(dir: string, prefix: string): string {
  const hits = readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith(".tgz"));
  if (hits.length !== 1) {
    throw new Error(`${dir}: ${prefix}*.tgz가 정확히 하나여야 한다 (찾은 것: ${hits.join(", ") || "없음"})`);
  }
  return join(dir, hits[0]);
}

function readPackage(path: string, expectedName: string) {
  const bytes = readFileSync(path);
  const files = readTgz(bytes);
  const manifest = files.get("package.json");
  if (!manifest) throw new Error(`${path}: package.json이 없다`);
  const pkg = JSON.parse(new TextDecoder().decode(manifest)) as { name?: string; version?: string };
  if (pkg.name !== expectedName || typeof pkg.version !== "string") {
    throw new Error(`${path}: ${expectedName} 패키지가 아니다 (${pkg.name}@${pkg.version})`);
  }
  return { files, version: pkg.version, sha256: sha256Hex(bytes) };
}

const from = arg("--from");
if (!from) {
  console.error("usage: gen-theme-catalog.ts --from <dir with the two npm tarballs> [--check]");
  process.exit(2);
}

const shiki = readPackage(findTgz(from, "shikijs-themes-"), "@shikijs/themes");
const tm = readPackage(findTgz(from, "tm-themes-"), "tm-themes");

const decoder = new TextDecoder();
const themeModules = new Map<string, string>();
for (const [path, bytes] of shiki.files) {
  const found = /^dist\/([\w-]+)\.mjs$/.exec(path);
  if (found && found[1] !== "index") themeModules.set(found[1], decoder.decode(bytes));
}
const notice = tm.files.get("NOTICE");
if (!notice) throw new Error("tm-themes에 NOTICE가 없다");

const built = buildCatalog({
  themeModules,
  noticeText: decoder.decode(notice),
  upstream: {
    shiki: { version: shiki.version, sha256: shiki.sha256 },
    tm: { version: tm.version, sha256: tm.sha256 },
  },
});

const files: readonly (readonly [string, string])[] = [
  [OUTPUTS.catalog, built.catalogTs],
  [OUTPUTS.index, built.indexTs],
  [OUTPUTS.notices, built.noticesTxt],
];

if (process.argv.includes("--check")) {
  let drift = 0;
  for (const [path, expected] of files) {
    const same = existsSync(path) && readFileSync(path, "utf8") === expected;
    console.log(`${same ? "same " : "DRIFT"} ${path.slice(REPO.length)}`);
    if (!same) drift += 1;
  }
  if (drift > 0) process.exit(1);
  console.log(`catalog: ${built.entries.length} entries, byte-identical to the committed files`);
} else {
  for (const [path, text] of files) {
    writeFileSync(path, text);
    console.log(`wrote ${path.slice(REPO.length)}`);
  }
  console.log(`catalog: ${built.entries.length} entries`);
}
