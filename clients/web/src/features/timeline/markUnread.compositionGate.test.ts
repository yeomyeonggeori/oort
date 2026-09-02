import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// =============================================================================
// ADR-0178 D3 grep gate (#1934 R2 H-1).
//
// Outside the allowlist, naming a mark identifier next to arithmetic,
// comparison, Math.*, ??, or a ternary is a composition. Pass-through is only
// `key: <simple member>` in mapping code and type-field declarations.
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));

function repoRoot(): string {
  let dir = HERE;
  for (let i = 0; i < 12; i++) {
    if (
      existsSync(join(dir, "packages", "momo-core", "src")) &&
      existsSync(join(dir, "clients", "web", "src"))
    ) {
      return dir;
    }
    dir = join(dir, "..");
  }
  throw new Error("repo root not found from composition gate test");
}

const REPO_ROOT = repoRoot();
const CORE_SRC = join(REPO_ROOT, "packages", "momo-core", "src");
const WEB_SRC = join(REPO_ROOT, "clients", "web", "src");

const IDENT_NAMES = [
  "markedUnreadBeforeSeq",
  "marked_unread_before_seq",
  "markUnreadBeforeSeq",
  "mark_unread_before_seq",
] as const;

const IDENT = new RegExp(`\\b(?:${IDENT_NAMES.join("|")})\\b`);
const IDENT_ALT = IDENT_NAMES.join("|");

/** Math / ?? / ternary `?` (not `??` `?.` `?:`) / spaced relational / + −.
 *  `<Type>` generics are not comparisons — `>` before `{` is a return type. */
const COMPOSITION =
  /\bMath\.(?:min|max)\b|\?\?|(?<!\?)\?(?![?.:])|(?<=\s)[<>]=?(?!=)(?=\s[A-Za-z0-9_(])|(?<![\w$])[+\-](?![=>])/;

const ALLOW_RELATIVE = new Set([
  "features/readState/model.ts",
  "features/readState/model.test.ts",
  "features/readState/proof.ts",
  "lib/api.ts",
  "features/timeline/markUnread.compositionGate.test.ts",
]);

const WINDOW_BEFORE = 2;
const WINDOW_AFTER = 4;

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");
}

function withoutStrings(line: string): string {
  return line
    .replace(/`(?:\\.|[^`])*`/g, '""')
    .replace(/"(?:\\.|[^"])*"/g, '""')
    .replace(/'(?:\\.|[^'])*'/g, '""');
}

function isTypeField(line: string): boolean {
  return new RegExp(
    `^(?:readonly\\s+)?(?:${IDENT_ALT})\\s*\\??\\s*:\\s*(?:number|null|undefined|[A-Za-z_$][\\w$]*(?:\\s*\\|\\s*[A-Za-z_$][\\w$]*)*)\\s*;?\\s*$`
  ).test(line.trim());
}

function isSimplePassThrough(line: string): boolean {
  return new RegExp(
    `\\b(?:${IDENT_ALT})\\s*:\\s*(?:null|undefined|[A-Za-z_$][\\w$]*(?:\\??\\.[A-Za-z_$][\\w$]*)*)\\s*,?\\s*\\}?\\s*$`
  ).test(line.trim());
}

function isRenamedPassThrough(line: string): boolean {
  // Other-key mapping: markSeq: read.markedUnreadBeforeSeq
  return new RegExp(
    `^[A-Za-z_$][\\w$]*\\s*:\\s*[A-Za-z_$][\\w$]*(?:\\??\\.)(?:${IDENT_ALT})\\s*,?\\s*$`
  ).test(line.trim());
}

function isInlineOptionalType(line: string): boolean {
  return new RegExp(`\\b(?:${IDENT_ALT})\\s*\\?:`).test(line.trim());
}

function isAllowedOccurrence(line: string): boolean {
  const stripped = withoutStrings(line);
  return (
    isTypeField(stripped) ||
    isInlineOptionalType(stripped) ||
    isSimplePassThrough(stripped) ||
    isRenamedPassThrough(stripped)
  );
}

export function scanComposition(
  source: string
): { line: number; text: string }[] {
  const lines = codeOnly(source).split("\n");
  const hits: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const stripped = withoutStrings(lines[i] ?? "");
    if (!IDENT.test(stripped)) {
      IDENT.lastIndex = 0;
      continue;
    }
    IDENT.lastIndex = 0;
    if (isAllowedOccurrence(stripped)) continue;
    const from = Math.max(0, i - WINDOW_BEFORE);
    const to = Math.min(lines.length, i + WINDOW_AFTER + 1);
    const window = lines
      .slice(from, to)
      .map((line) => withoutStrings(line))
      .join("\n");
    if (!COMPOSITION.test(window)) continue;
    hits.push({ line: i + 1, text: (lines[i] ?? "").trim() });
  }
  return hits;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function compositionHits(
  root: string,
  relPrefix: string
): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = [];
  for (const full of walk(root)) {
    const rel = `${relPrefix}${relative(root, full)}`;
    const allowKey = rel.replace(
      /^(?:packages\/momo-core\/src\/|clients\/web\/src\/)/,
      ""
    );
    if (ALLOW_RELATIVE.has(allowKey)) continue;
    if (/\.test\.tsx?$/.test(full)) continue;
    for (const hit of scanComposition(readFileSync(full, "utf8"))) {
      hits.push({ file: rel, ...hit });
    }
  }
  return hits;
}

const SABOTAGE = {
  direct: `export function s(row: { markedUnreadBeforeSeq: number | null; lastReadSeq: number }) {
  return Math.min(row.markedUnreadBeforeSeq ?? Infinity, row.lastReadSeq + 1);
}`,
  alias: `export function s(row: { markedUnreadBeforeSeq: number | null; lastReadSeq: number }) {
  const mark = row.markedUnreadBeforeSeq;
  const cursorStart = row.lastReadSeq + 1;
  return mark == null ? cursorStart : Math.min(mark, cursorStart);
}`,
  nospace: `export function s(row: { markedUnreadBeforeSeq: number | null; lastReadSeq: number }) {
  return row.markedUnreadBeforeSeq ?? row.lastReadSeq+1;
}`,
  compare: `export function s(row: { markedUnreadBeforeSeq: number | null; lastReadSeq: number }) {
  return row.markedUnreadBeforeSeq !== null && row.markedUnreadBeforeSeq < row.lastReadSeq + 1 ? row.markedUnreadBeforeSeq : row.lastReadSeq + 1;
}`,
  destructure: `export function s(row: { markedUnreadBeforeSeq: number | null; lastReadSeq: number }) {
  const { markedUnreadBeforeSeq, lastReadSeq } = row;
  if (markedUnreadBeforeSeq == null) return lastReadSeq + 1;
  return markedUnreadBeforeSeq < lastReadSeq + 1 ? markedUnreadBeforeSeq : lastReadSeq + 1;
}`,
} as const;

const PASS_THROUGH = {
  mapping: `export function toRow(row: { markedUnreadBeforeSeq: number | null }) {
  return { markedUnreadBeforeSeq: row.markedUnreadBeforeSeq };
}`,
  wire: `export function toWire(incoming: { marked_unread_before_seq: number | null }) {
  return { marked_unread_before_seq: incoming.marked_unread_before_seq };
}`,
  typeField: `export interface ReadState {
  markedUnreadBeforeSeq: number | null;
}`,
} as const;

describe("D3 합성은 momo-core 함수 한 곳뿐이다", () => {
  it("core 와 web src 에서 마크 필드 산술/비교가 합성 함수 밖에 없다", () => {
    const hits = [
      ...compositionHits(CORE_SRC, "packages/momo-core/src/"),
      ...compositionHits(WEB_SRC, "clients/web/src/"),
    ];
    expect(hits).toEqual([]);
  });

  it("허용 목록이 실제 파일을 가리킨다", () => {
    expect(statSync(join(CORE_SRC, "features/readState/model.ts")).isFile()).toBe(
      true
    );
    expect(statSync(join(CORE_SRC, "lib/api.ts")).isFile()).toBe(true);
    expect(statSync(join(WEB_SRC, "features/timeline/markUnread.compositionGate.test.ts")).isFile()).toBe(
      true
    );
  });
});

describe("게이트는 사보타주 5형을 잡고 패스스루 3형은 놓아 준다 (H-1)", () => {
  it("주입 5형이 각각 걸린다", () => {
    for (const [name, snippet] of Object.entries(SABOTAGE)) {
      expect(scanComposition(snippet).length, name).toBeGreaterThan(0);
    }
  });

  it("적법한 패스스루 3형은 걸리지 않는다", () => {
    for (const [name, snippet] of Object.entries(PASS_THROUGH)) {
      expect(scanComposition(snippet), name).toEqual([]);
    }
  });
});
