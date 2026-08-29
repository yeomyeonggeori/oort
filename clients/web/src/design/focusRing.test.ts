import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

/**
 * 포커스 링은 '테두리 밖에 뜬 링'이 아니라 '엣지를 감싸는 링'이다 (검수 피드백 #1).
 *
 * 실체는 옛 집 패턴(2px accent 아웃라인을 양수 offset 으로 컨트롤 테두리 바깥에)이
 * 63파일 108곳에 복붙된 것이었고, 양수 offset 이 링을 컨트롤에서 떨어뜨려 띄웠다.
 * `tokens.css` 의 `@utility focus-ring` 이 그것을 인셋(offset 음수) accent 아웃라인
 * 하나로 모으고, 108곳 전부가 `focus-visible:focus-ring`(및 peer/within 변형)으로
 * 그 유틸을 가리킨다.
 *
 * 왜 outline 인가(border-color 가 아니라): border-color 는 hover 를 위해
 * transition-colors 에 남아 있어서 focus 에 걸면 다시 페이드하고(#1210 D3 이 잡은
 * 결함), 테두리 없는 컨트롤(ghost 버튼·행·메뉴 항목)에선 그릴 것이 없다. outline-color
 * 는 #1210 D3 이 transition-colors 에서 빼 두었으므로 즉시 서고, 테두리 유무와
 * 무관하게 그려지며, forced-colors 에서 UA 가 색을 강제해 접근성이 유지된다.
 *
 * 왜 grep 이 아니라 컴파일인가: 유틸이 실제로 무엇을 산출하는지(색·두께·인셋 방향)를
 * 재려면 소스 문자열이 아니라 **컴파일 산출물**을 봐야 한다. 유틸을 지우거나 offset
 * 부호를 뒤집으면(다시 바깥으로) 여기서 빨개진다(red proof).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

async function loadStylesheet() {
  const path = require_.resolve("tailwindcss/index.css");
  return { path, base: dirname(path), content: readFileSync(path, "utf8") };
}

async function buildCss(candidates: string[]): Promise<string> {
  const compiler = await compile(readFileSync(`${HERE}/tokens.css`, "utf8"), {
    base: HERE,
    loadStylesheet,
  });
  return compiler.build(candidates);
}

/** `focus-ring` 을 언급하는 규칙의 { 셀렉터, 선언본문 } 을 컴파일 산출물에서 뽑는다. */
function focusRingRule(css: string, candidate: string) {
  const rules = [...css.matchAll(/([^{}]*focus-ring[^{}]*)\{([^}]*)\}/g)].map(
    (m) => ({
      selector: m[1].trim(),
      body: m[2].replace(/\s+/g, " ").trim(),
    })
  );
  const escaped = candidate.replace(/[:]/g, "\\:");
  const rule = rules.find((r) => r.selector.includes(escaped));
  if (!rule)
    throw new Error(
      `${candidate} 에 대한 규칙이 컴파일 산출물에 없다 — @utility focus-ring 이 사라졌나?`
    );
  return rule;
}

/** outline-offset 값을 px 수로. 부호가 요점이라 부호째 읽는다. */
function outlineOffsetPx(body: string): number {
  const m = body.match(/outline-offset:\s*(-?\d+(?:\.\d+)?)px/);
  if (!m) throw new Error(`outline-offset 선언이 없다: ${body}`);
  return Number(m[1]);
}

describe("검수 #1 — focus-ring 유틸", () => {
  it("focus-visible:focus-ring 은 accent 2px outline 을 상태에서만 세운다", async () => {
    const css = await buildCss(["focus-visible:focus-ring"]);
    const rule = focusRingRule(css, "focus-visible:focus-ring");

    // 상태에서만: 셀렉터가 :focus-visible 로 게이트된다.
    expect(rule.selector).toContain(":focus-visible");
    // 색은 --focus-ring-ink(채워진 컨트롤이 덮는 변수), 기본 폴백은 --accent.
    // 두께 2px · solid.
    expect(rule.body).toContain("var(--accent)");
    expect(rule.body).toMatch(
      /outline:\s*2px solid var\(--focus-ring-ink,\s*var\(--accent\)\)/
    );
  });

  it("링은 인셋이다 — 테두리 '바깥'이 아니라 엣지 위에 (피드백 #1 의 핵심)", async () => {
    const css = await buildCss(["focus-visible:focus-ring"]);
    const rule = focusRingRule(css, "focus-visible:focus-ring");
    // 음수(또는 0) 여야 한다. 양수면 옛 결함(테두리 밖 2px 에 뜬 링)으로 되돌아간 것.
    expect(outlineOffsetPx(rule.body)).toBeLessThan(0);
  });

  it("세 변형(focus-visible · focus-within · peer-focus-visible)이 모두 같은 링을 낸다", async () => {
    const candidates = [
      "focus-visible:focus-ring",
      "focus-within:focus-ring",
      "peer-focus-visible:focus-ring",
    ];
    const css = await buildCss(candidates);
    for (const candidate of candidates) {
      const rule = focusRingRule(css, candidate);
      expect(rule.body, candidate).toMatch(
        /outline:\s*2px solid var\(--focus-ring-ink,\s*var\(--accent\)\)/
      );
      expect(outlineOffsetPx(rule.body), candidate).toBeLessThan(0);
    }
  });

  it("focus-visible-within:focus-ring 은 Tab 모달리티 + 자식 :focus-visible 에서만 같은 링을 낸다", async () => {
    const css = await buildCss(["focus-visible-within:focus-ring"]);
    const rule = focusRingRule(css, "focus-visible-within:focus-ring");
    expect(rule.selector).toContain("data-focus-modality");
    expect(rule.selector).toContain("keyboard");
    expect(rule.selector).toContain(":focus-visible");
    expect(rule.selector).not.toContain(":focus-within");
    expect(rule.body).toMatch(
      /outline:\s*2px solid var\(--focus-ring-ink,\s*var\(--accent\)\)/
    );
    expect(outlineOffsetPx(rule.body)).toBeLessThan(0);
  });
});

describe("검수 #1 재검토 — 채워진 컨트롤 위 대비 (design-review High)", () => {
  /** tokens.css 에서 `--이름:` 의 값(우변)을 읽는다. */
  function tokenValue(name: string): string {
    const css = readFileSync(`${HERE}/tokens.css`, "utf8");
    const m = css.match(new RegExp(`\\s${name}:\\s*([^;]+);`));
    if (!m) throw new Error(`${name} 토큰이 tokens.css 에 없다`);
    return m[1].trim();
  }

  it("focus-ring-on-fill 은 링 색을 채움 전경색(--on-accent)으로 세운다", async () => {
    const css = await buildCss(["focus-ring-on-fill"]);
    const rule = focusRingRule(css, "focus-ring-on-fill");
    // 변형 없이(bare) 붙는다: :focus-visible 로 게이트되지 않는다(변수만 세팅).
    expect(rule.selector).not.toContain(":focus");
    expect(rule.body).toMatch(/--focus-ring-ink:\s*var\(--on-accent\)/);
  });

  it("링 색(--on-accent) ≠ 채움 색(--accent) — amber-on-amber 로 사라지지 않는다", () => {
    // red proof 의 핵심: 채워진 컨트롤에서 링 색과 fill 색이 같으면 안 된다.
    // focus-ring-on-fill 이 링을 --on-accent 로, bg-accent 는 fill 을 --accent 로 준다.
    expect(tokenValue("--on-accent")).not.toEqual(tokenValue("--accent"));
    // --on-accent 는 --danger-fill 컨트롤도 덮는다(값이 --on-danger-fill 과 같다).
    expect(tokenValue("--on-accent")).toEqual(tokenValue("--on-danger-fill"));
  });

  it("accent/danger 채움 컨트롤은 focus-ring-on-fill 을 든다", () => {
    // button 의 두 채움 변형 — 채움과 focus-ring-on-fill 이 같은 변형 문자열에.
    const button = readFileSync(`${HERE}/ui/button.tsx`, "utf8");
    for (const [fill, line] of [
      ["bg-accent", /default:[^,]*bg-accent[^,]*focus-ring-on-fill/s],
      ["bg-danger-fill", /destructive:[^,]*bg-danger-fill[^,]*focus-ring-on-fill/s],
    ] as const) {
      expect(button, `button.tsx ${fill} 변형`).toMatch(line);
    }
    // 손으로 그린 accent 보내기 버튼도(ThreadComposer).
    const thread = readFileSync(
      `${HERE}/../features/timeline/ThreadComposer.tsx`,
      "utf8"
    );
    for (const line of thread.split("\n")) {
      if (line.includes("bg-accent") && line.includes("focus-visible:focus-ring")) {
        expect(line, "ThreadComposer 보내기 버튼").toContain("focus-ring-on-fill");
      }
    }
  });
});

describe("검수 #1 — 전면 치환", () => {
  const { globSync } = require_("node:fs") as typeof import("node:fs");
  const sources = globSync("**/*.{ts,tsx}", { cwd: HERE + "/.." }) as string[];

  /** 손으로 적힌 옛 포커스 링 문법(주석/테스트 프로즈 제외한 코드 라인). */
  function handWrittenOutlineFocus(): string[] {
    const hits: string[] = [];
    for (const file of sources) {
      // 테스트는 표면을 **인용**할 뿐 산출하지 않는다 — 프리플라이트가 *.test.ts 를
      // 통째로 빼는 것과 같은 이유(SKILL.md 10.1). 이 파일도 옛 문법을 문자열로 든다.
      if (/\.test\.tsx?$/.test(file)) continue;
      const source = readFileSync(`${HERE}/../${file}`, "utf8");
      source.split("\n").forEach((line, index) => {
        // 주석 프로즈(`* ` 블록 · `//` 줄)는 대상 아님. tokens.css 의 설명이 옛
        // 문법을 인용하고, 그것을 위반으로 세면 설명을 지워야 초록이 된다.
        const trimmed = line.trimStart();
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) return;
        // 금지 토큰을 조각으로 짜서 이 소스 자체가 Tailwind 스캐너의 후보가 되지
        // 않게 한다(안 그러면 죽은 유틸 규칙이 dist 에 생긴다 — design-review Nitpick).
        const forbidden = new RegExp(
          `(focus-visible|focus-within|peer-focus-visible):outline-${"accent"}`
        );
        if (forbidden.test(line))
          hits.push(`${file}:${index + 1} ${line.trim()}`);
      });
    }
    return hits;
  }

  it("어떤 컴포넌트도 옛 outline 포커스 문법을 손으로 적지 않는다", () => {
    // 되돌아오면(누가 옛 아웃셋 아웃라인 포커스 문법을 다시 손으로 붙이면) 빨개진다.
    expect(handWrittenOutlineFocus()).toEqual([]);
  });

  it("누를 수 있는 프리미티브는 포커스를 focus-ring 으로 낸다", () => {
    for (const file of ["ui/button.tsx", "ui/input.tsx", "ui/select.tsx"]) {
      const source = readFileSync(`${HERE}/${file}`, "utf8");
      expect(source, file).toContain("focus-visible:focus-ring");
      expect(source, file).not.toMatch(/focus:border/);
    }
  });

  it("컴포저 그릇은 포인터 :focus-within 링이 아니라 focus-visible-within 이다", () => {
    for (const file of [
      "../features/chat/Composer.tsx",
      "../features/timeline/ThreadComposer.tsx",
    ]) {
      const source = readFileSync(`${HERE}/${file}`, "utf8");
      expect(source, file).toContain("focus-visible-within:focus-ring");
      expect(source, file).not.toContain("focus-within:focus-ring");
      expect(source, file).not.toMatch(/focus:border/);
    }
  });
});
