// =============================================================================
// DS2 테마 CSS를 core 원천에서 다시 쓴다 (ADR-0189 D5, #2712).
//
//   npm run gen:palettes
//
// 생성 규칙은 `packages/momo-core/src/design/themesCss.ts`에 있고, 이 파일은 그
// 결과를 `src/design/themes/palettes/`에 쓰기만 한다. 커밋본이 원천과 어긋나면
// `palettes.drift.test.ts`가 빨개진다. vite-node로 도는 것은 `@momo/core` 별칭을
// vite 설정 그대로 풀기 위해서다.
// =============================================================================
import { readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PALETTE_FILES, renderPaletteCss } from "@momo/core/design/themesCss";

const DIR = fileURLToPath(new URL("../src/design/themes/palettes/", import.meta.url));
const expected = new Set(PALETTE_FILES.map((f) => f.file));

for (const name of readdirSync(DIR)) {
  if (name.endsWith(".css") && !expected.has(name)) {
    unlinkSync(DIR + name);
    console.log(`removed ${name}`);
  }
}
for (const { theme, file } of PALETTE_FILES) {
  writeFileSync(DIR + file, renderPaletteCss(theme));
  console.log(`wrote ${file}`);
}
