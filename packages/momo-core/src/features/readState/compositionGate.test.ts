import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// =============================================================================
// ADR-0178 D3 grep gate (#1934).
//
// `marked_unread_before_seq` / `markedUnreadBeforeSeq` may be passed through
// DTO mapping. They may not be composed (min, relational compare, +/−) outside
// `effectiveUnreadStartSeq` and this folder's tests.
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_SRC = join(HERE, "..", "..");
const WEB_SRC = join(CORE_SRC, "..", "..", "..", "clients", "web", "src");

const IDENT =
  /\b(?:markedUnreadBeforeSeq|marked_unread_before_seq|markUnreadBeforeSeq|mark_unread_before_seq)\b/g;

const COMPOSITION =
  /\bMath\.(?:min|max)\b|(?<![=>])[<>]=?(?!=)|(?<![\w$])[+-](?![=>])/;

const ALLOW_RELATIVE = new Set([
  "features/readState/model.ts",
  "features/readState/model.test.ts",
  "features/readState/proof.ts",
  "features/readState/compositionGate.test.ts",
  "lib/api.ts",
]);

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");
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

function isPassThrough(line: string): boolean {
  const trimmed = line.trim();
  // Type / interface field, or object key in a mapping literal.
  if (
    /(?:markedUnreadBeforeSeq|marked_unread_before_seq|markUnreadBeforeSeq|mark_unread_before_seq)\s*[?:]/.test(
      trimmed
    )
  ) {
    return true;
  }
  // Presence check for "server said null, drop the local mark" — not D3 math.
  if (
    /(?:==|!=|===|!==)\s*null/.test(trimmed) ||
    /\?\?/.test(trimmed) ||
    /=\s*(?:null|undefined)/.test(trimmed)
  ) {
    return !COMPOSITION.test(trimmed.replace(/===|!==|==|!=/g, ""));
  }
  return false;
}

function compositionHits(
  root: string,
  relPrefix: string
): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = [];
  for (const full of walk(root)) {
    const rel = `${relPrefix}${relative(root, full)}`;
    const allowKey = rel.replace(/^(?:packages\/momo-core\/src\/|clients\/web\/src\/)/, "");
    if (ALLOW_RELATIVE.has(allowKey)) continue;
    if (/\.test\.tsx?$/.test(full) && allowKey.startsWith("features/readState/")) {
      continue;
    }
    const lines = codeOnly(readFileSync(full, "utf8")).split("\n");
    lines.forEach((line, index) => {
      const withoutStrings = line
        .replace(/`(?:\\.|[^`])*`/g, "")
        .replace(/"(?:\\.|[^"])*"/g, "")
        .replace(/'(?:\\.|[^'])*'/g, "");
      if (!IDENT.test(withoutStrings)) {
        IDENT.lastIndex = 0;
        return;
      }
      IDENT.lastIndex = 0;
      if (isPassThrough(withoutStrings)) return;
      if (!COMPOSITION.test(withoutStrings)) return;
      hits.push({ file: rel, line: index + 1, text: line.trim() });
    });
  }
  return hits;
}

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
  });
});
