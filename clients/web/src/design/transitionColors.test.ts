import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

/**
 * 포커스 링은 페이드하지 않는다 (#1210 D3).
 *
 * Tailwind v4 의 `transition-colors` 는 v3 에 없던 `outline-color` 를 전이 목록에
 * 넣는다. 이 레포의 포커스 링은 색을 `focus-visible:outline-accent` 로 **상태에서만**
 * 주므로, 그 조합은 링이 정지 색(currentcolor = --ink)에서 --accent 로 150ms 동안
 * 번지게 만든다. `tokens.css` 가 `@layer utilities` 에서 그 한 항목을 빼고, 이
 * 파일이 **컴파일 산출물**에서 그것을 확인한다.
 *
 * 왜 grep 이 아니라 컴파일인가: 이 수리는 「우리 선언이 코어 선언보다 뒤에 온다」는
 * 캐스케이드 사실 위에 서 있다. 소스를 읽어서는 그 사실을 알 수 없고, 실제로
 * `@utility transition-colors` 로 적으면 Tailwind 가 코어 선언을 우리 것 **뒤에**
 * 붙여서 조용히 지는 것을 확인했다. 그래서 재는 것은 문자열이 아니라 결과다.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

/** Tailwind 코어 v4 의 목록. 우리가 빼는 것은 이 중 `outline-color` 하나뿐이다. */
const CORE_PROPERTIES = [
  "color",
  "background-color",
  "border-color",
  "outline-color",
  "text-decoration-color",
  "fill",
  "stroke",
  "--tw-gradient-from",
  "--tw-gradient-via",
  "--tw-gradient-to",
] as const;

/** `@import "tailwindcss"` 를 디스크에서 실제로 읽어 준다. */
async function loadStylesheet() {
  const path = require_.resolve("tailwindcss/index.css");
  return {
    path,
    base: dirname(path),
    content: readFileSync(path, "utf8"),
  };
}

async function buildCss(source: string, candidates: string[]): Promise<string> {
  const compiler = await compile(source, { base: HERE, loadStylesheet });
  return compiler.build(candidates);
}

/**
 * `.transition-colors` 규칙 안의 `transition-property` 선언을 **선언 순서대로**.
 *
 * 마지막 것이 브라우저가 쓰는 값이다. 코어와 우리 것이 한 규칙으로 합쳐지므로
 * 목록이 둘 나오고, 이 테스트가 재는 것은 그중 마지막이다.
 */
function transitionProperties(css: string): string[][] {
  const rules = [...css.matchAll(/\.transition-colors\s*\{([^}]*)\}/g)];
  if (rules.length === 0)
    throw new Error(".transition-colors 규칙이 컴파일 산출물에 없다");
  // 규칙이 둘로 나뉘어 나올 수 있다(코어 한 벌 + 우리 재정의 한 벌). 캐스케이드가
  // 보는 것은 **문서 순서**이므로 여기서도 순서대로 이어 붙인다.
  return rules.flatMap((rule) =>
    [...rule[1].matchAll(/transition-property:\s*([^;]+);/g)].map((m) =>
      m[1]
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    )
  );
}

describe("#1210 D3 — transition-colors", () => {
  it("코어 Tailwind 는 outline-color 를 전이시킨다 (이 수리가 존재하는 이유)", async () => {
    // 이 단정이 초록인 동안에만 아래 재정의가 필요하다. 언젠가 upstream 이 목록에서
    // outline-color 를 빼면 여기서 먼저 빨개지고, 그때 재정의를 지울 수 있다.
    const css = await buildCss(`@import "tailwindcss";`, ["transition-colors"]);
    const declarations = transitionProperties(css);
    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toEqual([...CORE_PROPERTIES]);
  });

  it("tokens.css 를 통과한 뒤에는 outline-color 가 목록에 없다", async () => {
    const css = await buildCss(readFileSync(`${HERE}/tokens.css`, "utf8"), [
      "transition-colors",
    ]);
    const declarations = transitionProperties(css);
    const effective = declarations[declarations.length - 1];

    expect(effective, "브라우저가 쓰는 마지막 선언").not.toContain(
      "outline-color"
    );
    // 목록을 새로 발명하지 않았다는 것도 함께 잰다: 빠진 것은 정확히 하나여야 한다.
    expect(effective).toEqual(
      CORE_PROPERTIES.filter((property) => property !== "outline-color")
    );
  });

  it("포커스 링과 함께 서는 자리가 이 한 선언으로 전부 덮인다", async () => {
    // 감사(§B-4 ⑤)는 「프리미티브 3개」로 적었지만, 25곳 중 22곳은 자기 문자열에
    // transition-colors 를 직접 든 feature 파일이다. 그 사실을 여기서 세어 둔다 —
    // 이 숫자가 3 으로 줄지 않는 한 프리미티브 수리는 답이 될 수 없다.
    const { globSync } = await import("node:fs");
    const files = globSync("**/*.{ts,tsx}", { cwd: `${HERE}/..` });
    let withRing = 0;
    let inPrimitives = 0;
    for (const file of files) {
      const source = readFileSync(`${HERE}/../${file}`, "utf8");
      for (const line of source.split("\n")) {
        if (!line.includes("transition-colors")) continue;
        if (!line.includes("focus-visible:outline")) continue;
        withRing += 1;
        if (file.startsWith("design/ui/")) inPrimitives += 1;
      }
    }
    expect(withRing).toBeGreaterThan(inPrimitives);
    expect(inPrimitives).toBe(3);
  });
});
