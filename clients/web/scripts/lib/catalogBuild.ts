// =============================================================================
// 테마 카탈로그 생성기의 순수 부분 (ADR-0189 증보 3 D1·D2, AP-1b #4188).
//
// 입력은 npm tarball 두 개를 **읽은 바이트**(`@shikijs/themes`의 테마 모듈, `tm-themes`의 NOTICE)이고
// 출력은 세 파일의 문자열이다(`packages/momo-core/src/design/themeCatalog.generated.ts`, 같은 폴더의
// `themeCatalogIndex.generated.ts`, `legal/generated/THEME_PALETTE_NOTICES.txt`). 파일을 읽고 쓰는 일은
// `scripts/gen-theme-catalog.ts`가 하고, 이 파일은 파일 시스템을 모른다: 그래서 시험이 작은 가짜
// 입력으로 규칙 전체(허용 목록·금지 이름·모드 일치·출력 모양)를 잴 수 있다.
//
// Adapted from block/buzz `desktop/src/shared/theme/theme-loader.ts` @ af5bb0a
// (https://github.com/block/buzz, Apache-2.0, Copyright 2026 Block, Inc.): 테마 목록·라이트·다크 짝은 Buzz의
// `SYNTAX_THEMES`·`LIGHT_THEMES`·`THEME_PAIRS`에서 옮겼다.
// Changed by oort (Apache-2.0 §4(b)): Buzz 자체 테마 두 종(`buzz`·`buzz-dark`)과 GPL-3.0 한 종(`aurora-x`),
// 경쟁 제품 이름이 든 두 종(`slack-dark`·`slack-ochin`, ADR-0189 증보 3 결정 2)을 뺐다. 쌍은 Buzz처럼 두
// 항목이 아니라 **한 항목**(id는 명시 표, 라벨도 명시 표)으로 묶었고, 단일 모드 항목은 없는 모드를 복제하지 않는다.
//
// **fail-closed 세 가지.** (1) 금지 이름이 표에 있으면 실패한다. (2) 표의 테마가 NOTICE에 없거나 그
// SPDX가 허용 목록(MIT·Apache-2.0·BSD·ISC) 밖이면 실패한다. (3) 씨앗을 못 뽑거나 라이트 칸에 어두운 바탕이
// (또는 반대로) 들어 있으면 실패한다. 조용히 건너뛰는 길이 없다.
// =============================================================================

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  CATALOG_ALLOWED_SPDX,
  CATALOG_ID_RE,
  SEED_KEYS,
  extractSeed,
  isAllowedSpdx,
  seedMode,
  type CatalogEntry,
  type CatalogSourceRef,
  type ThemeSeed,
} from "@momo/core/design/themeSeed";
import type { Mode } from "@momo/core/design/themes";

export interface EntryDef {
  readonly id: string;
  readonly label: string;
  /** shiki 테마 이름(`@shikijs/themes`의 파일 이름). 한 모드뿐인 항목은 한쪽만 있다. */
  readonly light?: string;
  readonly dark?: string;
}

/** 쌍 16 · 라이트 단독 1 · 다크 단독 24 = 41항목, 57 테마-모드. id 순이다(갤러리 정렬). */
export const CATALOG_DEFS: readonly EntryDef[] = [
  { id: "andromeeda", label: "Andromeeda", dark: "andromeeda" },
  { id: "ayu-dark", label: "Ayu Dark", dark: "ayu-dark" },
  { id: "catppuccin", label: "Catppuccin", light: "catppuccin-latte", dark: "catppuccin-mocha" },
  { id: "catppuccin-frappe", label: "Catppuccin Frappé", dark: "catppuccin-frappe" },
  { id: "catppuccin-macchiato", label: "Catppuccin Macchiato", dark: "catppuccin-macchiato" },
  { id: "dracula", label: "Dracula", dark: "dracula" },
  { id: "dracula-soft", label: "Dracula Soft", dark: "dracula-soft" },
  { id: "everforest", label: "Everforest", light: "everforest-light", dark: "everforest-dark" },
  { id: "github", label: "GitHub", light: "github-light", dark: "github-dark" },
  { id: "github-dark-dimmed", label: "GitHub Dark Dimmed", dark: "github-dark-dimmed" },
  { id: "github-default", label: "GitHub Default", light: "github-light-default", dark: "github-dark-default" },
  {
    id: "github-high-contrast",
    label: "GitHub High Contrast",
    light: "github-light-high-contrast",
    dark: "github-dark-high-contrast",
  },
  { id: "gruvbox-hard", label: "Gruvbox Hard", light: "gruvbox-light-hard", dark: "gruvbox-dark-hard" },
  { id: "gruvbox-medium", label: "Gruvbox Medium", light: "gruvbox-light-medium", dark: "gruvbox-dark-medium" },
  { id: "gruvbox-soft", label: "Gruvbox Soft", light: "gruvbox-light-soft", dark: "gruvbox-dark-soft" },
  { id: "houston", label: "Houston", dark: "houston" },
  { id: "kanagawa", label: "Kanagawa", light: "kanagawa-lotus", dark: "kanagawa-wave" },
  { id: "kanagawa-dragon", label: "Kanagawa Dragon", dark: "kanagawa-dragon" },
  { id: "laserwave", label: "Laserwave", dark: "laserwave" },
  { id: "material", label: "Material", light: "material-theme-lighter", dark: "material-theme" },
  { id: "material-theme-darker", label: "Material Darker", dark: "material-theme-darker" },
  { id: "material-theme-ocean", label: "Material Ocean", dark: "material-theme-ocean" },
  { id: "material-theme-palenight", label: "Material Palenight", dark: "material-theme-palenight" },
  { id: "min", label: "Min", light: "min-light", dark: "min-dark" },
  { id: "monokai", label: "Monokai", dark: "monokai" },
  { id: "night-owl", label: "Night Owl", dark: "night-owl" },
  { id: "nord", label: "Nord", dark: "nord" },
  { id: "one", label: "One", light: "one-light", dark: "one-dark-pro" },
  { id: "plastic", label: "Plastic", dark: "plastic" },
  { id: "poimandres", label: "Poimandres", dark: "poimandres" },
  { id: "red", label: "Red", dark: "red" },
  { id: "rose-pine", label: "Rosé Pine", light: "rose-pine-dawn", dark: "rose-pine" },
  { id: "rose-pine-moon", label: "Rosé Pine Moon", dark: "rose-pine-moon" },
  { id: "snazzy-light", label: "Snazzy Light", light: "snazzy-light" },
  { id: "solarized", label: "Solarized", light: "solarized-light", dark: "solarized-dark" },
  { id: "synthwave-84", label: "Synthwave 84", dark: "synthwave-84" },
  { id: "tokyo-night", label: "Tokyo Night", dark: "tokyo-night" },
  { id: "vesper", label: "Vesper", dark: "vesper" },
  { id: "vitesse", label: "Vitesse", light: "vitesse-light", dark: "vitesse-dark" },
  { id: "vitesse-black", label: "Vitesse Black", dark: "vitesse-black" },
  { id: "vscode-plus", label: "VS Code Plus", light: "light-plus", dark: "dark-plus" },
];

/**
 * 표에 들어올 수 없는 원본 이름과 이유. Buzz 목록 62종에서 빠지는 다섯이다(62 − 5 = 57).
 * `aurora-x`는 라이선스(GPL-3.0)라 SPDX 검사와 별개로 **이름으로도** 막는다: NOTICE가 거짓이어도
 * 같은 파일이 들어오지 못하게 하는 두 번째 걸쇠다.
 */
export const CATALOG_FORBIDDEN: Readonly<Record<string, string>> = {
  "aurora-x": "GPL-3.0 (허용 라이선스 밖)",
  "slack-dark": "경쟁 제품 이름 (ADR-0189 증보 3 결정 2)",
  "slack-ochin": "경쟁 제품 이름 (ADR-0189 증보 3 결정 2)",
  buzz: "Buzz 자체 테마 (우리 자리는 첫 파티 3종)",
  "buzz-dark": "Buzz 자체 테마 (우리 자리는 첫 파티 3종)",
};

// ---- tar·gzip -----------------------------------------------------------------

/**
 * npm tarball(`.tgz`)을 메모리에서 푼다. 키는 첫 경로 조각(`package/`)을 뗀 경로다. 일반 파일만 읽고
 * PAX 확장 헤더는 건너뛴다(우리가 읽는 `dist/<이름>.mjs`·`NOTICE`·`package.json`은 짧은 경로다).
 */
export function readTgz(gz: Uint8Array): Map<string, Uint8Array> {
  const tar = gunzipSync(gz);
  const files = new Map<string, Uint8Array>();
  const text = (from: number, length: number): string => {
    const end = tar.indexOf(0, from);
    return new TextDecoder().decode(tar.subarray(from, end < 0 || end > from + length ? from + length : end));
  };
  let offset = 0;
  let longName: string | null = null;
  while (offset + 512 <= tar.length) {
    if (tar.subarray(offset, offset + 512).every((b) => b === 0)) break;
    const name = text(offset, 100);
    const prefix = text(offset + 345, 155);
    const size = parseInt(text(offset + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(tar[offset + 156] || 48);
    const body = offset + 512;
    if (type === "L") {
      longName = text(body, size);
    } else if (type === "0") {
      const full = longName ?? (prefix ? `${prefix}/${name}` : name);
      longName = null;
      const slash = full.indexOf("/");
      files.set(slash < 0 ? full : full.slice(slash + 1), tar.slice(body, body + size));
    } else {
      longName = null;
    }
    offset = body + Math.ceil(size / 512) * 512;
  }
  return files;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---- shiki 테마 모듈 ------------------------------------------------------------

const SHIKI_MODULE_RE =
  /^\/\* Theme: ([\w-]+) \*\/\nexport default Object\.freeze\(JSON\.parse\(("(?:[^"\\]|\\.)*")\)\);?\s*$/;

/** `export default Object.freeze(JSON.parse("…"))` 모양의 모듈 텍스트에서 테마 객체를 꺼낸다. 코드를 실행하지 않는다. */
export function parseShikiModule(source: string): { name: string; theme: unknown } {
  const found = SHIKI_MODULE_RE.exec(source);
  if (!found) throw new Error("shiki 테마 모듈의 모양이 예상과 다르다");
  return { name: found[1], theme: JSON.parse(JSON.parse(found[2]) as string) as unknown };
}

// ---- NOTICE ---------------------------------------------------------------------

export interface NoticeBlock {
  readonly files: readonly string[];
  readonly licenseUrl: string;
  readonly spdx: string;
  readonly repo: string;
  readonly text: string;
}

/** `https://raw.githubusercontent.com/<owner>/<repo>/…` → `owner/repo`. */
function repoOf(licenseUrl: string): string {
  const found = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\//.exec(licenseUrl);
  if (!found) throw new Error(`상류 저장소를 읽을 수 없는 License URL: ${licenseUrl}`);
  return `${found[1]}/${found[2]}`;
}

/** tm-themes `NOTICE`를 블록 단위로 읽는다. 블록은 `====` 줄로 갈리고 `Files:`·`License:`·`SPDX:` 뒤에 본문이 온다. */
export function parseNotice(text: string): NoticeBlock[] {
  const blocks: NoticeBlock[] = [];
  const chunks = text.replace(/\r\n/g, "\n").split(/\n={20,}\n/).slice(1);
  for (const chunk of chunks) {
    const head = /^Files:\s*(.+)\nLicense:\s*(\S+)\nSPDX:\s*(\S+)\n-{20,}\n([\s\S]*)$/.exec(chunk);
    if (!head) throw new Error("NOTICE 블록의 머리(Files·License·SPDX)를 읽을 수 없다");
    const files = head[1].split(",").map((name) => name.trim()).filter(Boolean);
    blocks.push({
      files,
      licenseUrl: head[2],
      spdx: head[3],
      repo: repoOf(head[2]),
      text: head[4].replace(/\s+$/, ""),
    });
  }
  return blocks;
}

// ---- 빌드 ----------------------------------------------------------------------

export interface CatalogInputs {
  /** shiki 테마 이름 → 모듈 텍스트. */
  readonly themeModules: ReadonlyMap<string, string>;
  readonly noticeText: string;
  readonly upstream: {
    readonly shiki: { readonly version: string; readonly sha256: string };
    readonly tm: { readonly version: string; readonly sha256: string };
  };
}

export interface CatalogOutputs {
  readonly entries: readonly CatalogEntry[];
  readonly catalogTs: string;
  readonly indexTs: string;
  readonly noticesTxt: string;
}

function sourceFor(name: string, blocks: readonly NoticeBlock[]): CatalogSourceRef {
  const block = blocks.find((b) => b.files.includes(`${name}.json`));
  if (!block) throw new Error(`NOTICE에 ${name} 테마의 라이선스 블록이 없다`);
  if (!isAllowedSpdx(block.spdx)) {
    throw new Error(
      `${name}: 라이선스 ${block.spdx}는 허용 목록(${CATALOG_ALLOWED_SPDX.join(", ")}) 밖이다`
    );
  }
  return { theme: name, repo: block.repo, spdx: block.spdx };
}

function seedFor(name: string, slot: Mode, modules: ReadonlyMap<string, string>): ThemeSeed {
  const source = modules.get(name);
  if (source === undefined) throw new Error(`${name}: 테마 모듈이 입력에 없다`);
  const { theme } = parseShikiModule(source);
  const seed = extractSeed(theme, { defaults: true });
  if (seed === null) throw new Error(`${name}: 배경·글자 색을 읽을 수 없다`);
  const actual = seedMode(seed);
  if (actual !== slot) {
    throw new Error(`${name}: ${slot} 칸에 들어갈 테마인데 바탕 휘도는 ${actual}이다`);
  }
  return seed;
}

export function buildCatalog(inputs: CatalogInputs, defs: readonly EntryDef[] = CATALOG_DEFS): CatalogOutputs {
  const blocks = parseNotice(inputs.noticeText);
  const seen = new Set<string>();
  const used = new Set<string>();
  const entries: CatalogEntry[] = [];

  for (const def of defs) {
    if (!CATALOG_ID_RE.test(def.id)) throw new Error(`id 문법이 틀렸다: ${def.id}`);
    if (seen.has(def.id)) throw new Error(`id가 겹친다: ${def.id}`);
    seen.add(def.id);
    if (!def.light && !def.dark) throw new Error(`${def.id}: 모드가 하나도 없다`);
    for (const name of [def.light, def.dark]) {
      if (name === undefined) continue;
      if (Object.prototype.hasOwnProperty.call(CATALOG_FORBIDDEN, name)) {
        throw new Error(`${def.id}: ${name}은 카탈로그에 들어올 수 없다 (${CATALOG_FORBIDDEN[name]})`);
      }
      if (used.has(name)) throw new Error(`${def.id}: ${name}이 두 번 쓰였다`);
      used.add(name);
    }
    const light = def.light ? seedFor(def.light, "light", inputs.themeModules) : undefined;
    const dark = def.dark ? seedFor(def.dark, "dark", inputs.themeModules) : undefined;
    entries.push({
      id: def.id,
      label: def.label,
      ...(light ? { light } : {}),
      ...(dark ? { dark } : {}),
      source: {
        ...(def.light ? { light: sourceFor(def.light, blocks) } : {}),
        ...(def.dark ? { dark: sourceFor(def.dark, blocks) } : {}),
      },
    });
  }

  return {
    entries,
    catalogTs: renderCatalogTs(entries, inputs),
    indexTs: renderIndexTs(entries),
    noticesTxt: renderNotices(entries, blocks, inputs),
  };
}

// ---- 출력 ----------------------------------------------------------------------

const q = (value: string): string => JSON.stringify(value);

function renderSeed(seed: ThemeSeed): string {
  const parts: string[] = [];
  for (const key of SEED_KEYS) {
    const value = (seed as Record<string, string | undefined>)[key];
    if (value !== undefined) parts.push(`${key}: ${q(value)}`);
  }
  return `{ ${parts.join(", ")} }`;
}

function renderRef(ref: CatalogSourceRef): string {
  return `{ theme: ${q(ref.theme)}, repo: ${q(ref.repo)}, spdx: ${q(ref.spdx)} }`;
}

export const CATALOG_GENERATOR_COMMAND = "npm --prefix clients/web run gen:theme-catalog -- --from <dir>";

function header(inputs: CatalogInputs, what: string): string[] {
  return [
    `// GENERATED by clients/web/scripts/gen-theme-catalog.ts (ADR-0189 증보 3 D1, #4188). Do not edit by hand.`,
    `// ${what}`,
    `// Regenerate: ${CATALOG_GENERATOR_COMMAND}`,
    `//   <dir> holds the two npm tarballs: \`npm pack @shikijs/themes@${inputs.upstream.shiki.version} tm-themes@${inputs.upstream.tm.version} --pack-destination <dir>\``,
    `// Inputs: @shikijs/themes@${inputs.upstream.shiki.version} sha256:${inputs.upstream.shiki.sha256}`,
    `//         tm-themes@${inputs.upstream.tm.version} sha256:${inputs.upstream.tm.sha256}`,
    `// Seeds are colors read from third-party VS Code themes (MIT / Apache-2.0). Upstream notices: legal/generated/THEME_PALETTE_NOTICES.txt`,
    `// Theme list and light/dark pairs adapted from block/buzz desktop/src/shared/theme/theme-loader.ts @ af5bb0a (Apache-2.0, Copyright 2026 Block, Inc.).`,
  ];
}

function renderCatalogTs(entries: readonly CatalogEntry[], inputs: CatalogInputs): string {
  const lines = [
    ...header(inputs, "The full catalog: one entry per theme (a pair is one entry), seeds only."),
    "",
    `import type { CatalogEntry } from "./themeSeed";`,
    "",
    "export const THEME_CATALOG_UPSTREAM = {",
    `  shikiThemes: { name: "@shikijs/themes", version: ${q(inputs.upstream.shiki.version)}, tgzSha256: ${q(inputs.upstream.shiki.sha256)} },`,
    `  tmThemes: { name: "tm-themes", version: ${q(inputs.upstream.tm.version)}, tgzSha256: ${q(inputs.upstream.tm.sha256)} },`,
    `  buzz: { repo: "block/buzz", commit: "af5bb0a" },`,
    "} as const;",
    "",
    "export const THEME_CATALOG: readonly CatalogEntry[] = [",
  ];
  for (const entry of entries) {
    lines.push("  {", `    id: ${q(entry.id)},`, `    label: ${q(entry.label)},`);
    if (entry.light) lines.push(`    light: ${renderSeed(entry.light)},`);
    if (entry.dark) lines.push(`    dark: ${renderSeed(entry.dark)},`);
    const refs: string[] = [];
    if (entry.source.light) refs.push(`light: ${renderRef(entry.source.light)}`);
    if (entry.source.dark) refs.push(`dark: ${renderRef(entry.source.dark)}`);
    lines.push(`    source: { ${refs.join(", ")} },`, "  },");
  }
  lines.push("];", "");
  return lines.join("\n");
}

function modesName(entry: CatalogEntry): "light" | "dark" | "both" {
  if (entry.light && entry.dark) return "both";
  return entry.light ? "light" : "dark";
}

function renderIndexTs(entries: readonly CatalogEntry[]): string {
  const lines = [
    `// GENERATED by clients/web/scripts/gen-theme-catalog.ts (ADR-0189 증보 3 D1, #4188). Do not edit by hand.`,
    `// The catalog's id, modes and label only. The main bundle reads this (membership and the single-mode rule);`,
    `// the seeds live in themeCatalog.generated.ts and load with the gallery.`,
    `// Regenerate: ${CATALOG_GENERATOR_COMMAND}`,
    "",
    "export type CatalogModes = \"light\" | \"dark\" | \"both\";",
    "",
    "export const THEME_CATALOG_INDEX: readonly (readonly [id: string, modes: CatalogModes, label: string])[] = [",
  ];
  for (const entry of entries) lines.push(`  [${q(entry.id)}, ${q(modesName(entry))}, ${q(entry.label)}],`);
  lines.push("];", "");
  return lines.join("\n");
}

function renderNotices(
  entries: readonly CatalogEntry[],
  blocks: readonly NoticeBlock[],
  inputs: CatalogInputs
): string {
  const usedByRepo = new Map<string, { block: NoticeBlock; themes: string[] }>();
  for (const entry of entries) {
    for (const ref of [entry.source.light, entry.source.dark]) {
      if (!ref) continue;
      const block = blocks.find((b) => b.files.includes(`${ref.theme}.json`))!;
      const found = usedByRepo.get(block.repo) ?? { block, themes: [] };
      found.themes.push(ref.theme);
      usedByRepo.set(block.repo, found);
    }
  }
  const rule = "=".repeat(105);
  const thin = "-".repeat(105);
  const out = [
    "oort theme palette notices (GENERATED, do not edit by hand)",
    "",
    "The theme catalog (packages/momo-core/src/design/themeCatalog.generated.ts) stores a handful of colors",
    "(background, foreground, comment, git decoration, accent, terminal) read from each theme below. The",
    "themes are third-party VS Code color themes bundled in the npm packages named here, and each is used",
    "under its upstream license. oort derives its own interface tokens from those colors; no theme file is",
    "redistributed.",
    "",
    `Packages read: @shikijs/themes@${inputs.upstream.shiki.version} (sha256:${inputs.upstream.shiki.sha256})`,
    `               tm-themes@${inputs.upstream.tm.version} (sha256:${inputs.upstream.tm.sha256}), its NOTICE file`,
    `Regenerate: ${CATALOG_GENERATOR_COMMAND}`,
    "",
  ];
  const repos = [...usedByRepo.keys()].sort((a, b) => a.localeCompare(b));
  out.push(`Upstream projects: ${repos.length}`, "");
  for (const repo of repos) {
    const { block, themes } = usedByRepo.get(repo)!;
    out.push(
      rule,
      `Upstream: ${repo}`,
      `Themes used: ${[...new Set(themes)].sort().join(", ")}`,
      `SPDX: ${block.spdx}`,
      `License: ${block.licenseUrl}`,
      thin,
      block.text,
      ""
    );
  }
  return out.join("\n");
}
