import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #3277 R1 H-1: 닫힌 spacing 스케일(`--spacing: initial`)에서 `min-w-28` 같은 이름은
// CSS 가 생성되지 않아 아무 일도 하지 않는다(버튼 폭 79→124px 로 흔들렸다). 이 파일의
// `min-w-*` 는 tokens.css 에 이름 붙은 폭으로 실제 존재해야 한다.
function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("프로필 사진 단추 폭", () => {
  // 주석은 걷는다: 왜 그 이름이 없는지를 적는 문장이 자기 스캔에 걸리지 않게.
  const source = read("./ProfileAvatarField.tsx")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
  const tokens = read("../../design/tokens.css");
  const names = [...source.matchAll(/min-w-([a-z][a-z-]*)/g)].map((m) => m[1]);

  it("min-w 를 쓰고, 모두 tokens.css 의 이름 붙은 폭이다", () => {
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(tokens, `--spacing-${name} 가 tokens.css 에 없다`).toContain(`--spacing-${name}:`);
    }
  });

  it("스케일에 없는 숫자 폭(min-w-28 등)을 쓰지 않는다", () => {
    expect(source).not.toMatch(/min-w-\d/);
  });
});
