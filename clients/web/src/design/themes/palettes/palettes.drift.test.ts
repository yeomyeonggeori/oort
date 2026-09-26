import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PALETTE_FILES, renderPaletteCss } from "@momo/core/design/themesCss";

// =============================================================================
// ADR-0189 D5 — 웹 테마 CSS는 core 원천에서 생성해 커밋한다. 생성 결과와
// 커밋본이 한 바이트라도 다르면 빨개진다. 고치는 길은 하나다:
//
//   npm run gen:palettes
//
// 이 폴더는 `themes/index.ts`의 `import.meta.glob("./*.css")`(비재귀)와
// `catalog.contrast.test.ts`의 액센트 목록 밖이다. 화면 적용은 DS2-1(#2713)이
// 이 파일들을 불러오면서 시작한다. 지금은 아무 루트에도 `data-palette`가 없다.
// =============================================================================

const DIR = fileURLToPath(new URL(".", import.meta.url));

describe("DS2 테마 CSS 드리프트", () => {
  it.each(PALETTE_FILES.map((f) => [f.file, f.theme] as const))(
    "%s = renderPaletteCss(%s)",
    (file, theme) => {
      const committed = readFileSync(DIR + file, "utf8");
      expect(committed, `${file} is stale — run: npm --prefix clients/web run gen:palettes`).toBe(
        renderPaletteCss(theme)
      );
    }
  );

  it("원천에 없는 테마 파일이 남아 있지 않다", () => {
    const onDisk = readdirSync(DIR).filter((n) => n.endsWith(".css")).sort();
    expect(onDisk).toEqual(PALETTE_FILES.map((f) => f.file).sort());
  });
});
