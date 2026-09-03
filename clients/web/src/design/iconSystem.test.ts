import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// =============================================================================
// ADR-0172의 아이콘 경계를 전수로 잰다.
//
// 기능 아이콘은 lucide-react가 정본이다. 로컬 SVG는 "지금 아는 파일"을 대충
// 세는 잔량이 아니라, Lucide에 없는 도메인 고유 글리프와 데이터 행렬(QR)만
// 허용하는 닫힌 예외다. QR은 글리프가 아니라 페이로드를 모듈로 그린 것이다.
// 새 <svg>나 public/*.svg가 생기면 이 테스트가 먼저 실패하고, 그 파일을 예외로
// 추가하려면 코드 주석과 디자인 시스템 정본에 존치 사유를 함께 적어야 한다.
// =============================================================================

const WEB_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC_DIR = join(WEB_ROOT, "src");
const PUBLIC_DIR = join(WEB_ROOT, "public");
const EXCEPTION_MARKER = "icon-system-exception(ADR-0172)";

function filesUnder(dir: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, pattern));
    else if (pattern.test(entry.name)) out.push(full);
  }
  return out;
}

/** 주석 속 반례와 문서용 `<svg>` 문자열은 실제 렌더 트리가 아니다. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");
}

const LOCAL_SVG_COMPONENTS = filesUnder(SRC_DIR, /\.tsx$/)
  .filter((file) => !file.endsWith(".test.tsx"))
  .filter((file) => /<svg\b/.test(codeOnly(readFileSync(file, "utf8"))))
  .map((file) => relative(WEB_ROOT, file))
  .sort();

const STATIC_SVG_ASSETS = filesUnder(PUBLIC_DIR, /\.svg$/)
  .map((file) => relative(WEB_ROOT, file))
  .sort();

const SHIPPED_SOURCES = filesUnder(SRC_DIR, /\.tsx?$/)
  .filter((file) => !/\.test\.tsx?$/.test(file))
  .map((file) => ({
    file: relative(WEB_ROOT, file),
    code: codeOnly(readFileSync(file, "utf8")),
  }));

describe("ADR-0172 lucide 아이콘 경계", () => {
  it("기능 표면의 raw SVG는 브랜드 글리프와 데이터 행렬(QR)만 남는다", () => {
    expect(LOCAL_SVG_COMPONENTS).toEqual([
      "src/design/brand/OortMark.tsx",
      "src/features/auth/OortCloudMarks.tsx",
      "src/features/settings/DeviceLinkCard.tsx",
    ]);
  });

  it("정적 SVG는 oort 브랜드 자산 두 파일만 남는다", () => {
    expect(STATIC_SVG_ASSETS).toEqual([
      "public/favicon.svg",
      "public/oort-mark.svg",
    ]);
  });

  it("모든 로컬 SVG 예외가 코드에서 존치 사유를 선언한다", () => {
    for (const file of [...LOCAL_SVG_COMPONENTS, ...STATIC_SVG_ASSETS]) {
      expect(readFileSync(join(WEB_ROOT, file), "utf8"), file).toContain(
        EXCEPTION_MARKER
      );
    }
  });

  it("Lucide를 정적인 named import로만 가져온다", () => {
    const dynamicImports = SHIPPED_SOURCES.filter(({ code }) =>
      /lucide-react\/dynamicIconImports|import\s*\(\s*["']lucide-react/.test(code)
    ).map(({ file }) => file);
    const namespaceImports = SHIPPED_SOURCES.filter(({ code }) =>
      /import\s+\*\s+as\s+\w+\s+from\s+["']lucide-react["']/.test(code)
    ).map(({ file }) => file);

    expect(dynamicImports).toEqual([]);
    expect(namespaceImports).toEqual([]);
  });

  it("lucide-react가 ISC lockfile 의존성으로 고정돼 있다", () => {
    const manifest = JSON.parse(
      readFileSync(join(WEB_ROOT, "package.json"), "utf8")
    ) as { dependencies?: Record<string, string> };
    const lockfile = JSON.parse(
      readFileSync(join(WEB_ROOT, "package-lock.json"), "utf8")
    ) as {
      packages?: Record<string, { version?: string; license?: string }>;
    };
    const locked = lockfile.packages?.["node_modules/lucide-react"];

    expect(locked?.license).toBe("ISC");
    expect(manifest.dependencies?.["lucide-react"]).toBe(
      `^${locked?.version}`
    );
  });
});
