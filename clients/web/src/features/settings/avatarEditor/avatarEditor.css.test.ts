import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// =============================================================================
// 편집기 스크롤 본문의 CSS 계약 (#4261 design-review B-1 · H-3 · M-6 · M-7).
//
// jsdom 은 레이아웃을 하지 않으므로 「초점이 간 칸이 눈에 보이는가」는 이 시험이 못 잰다. 그 측정은 `scripts/capture-4261.mjs` 의
// 키보드 장면이 Chromium·WebKit 에서 한다. 이 시험은 그 측정이 믿는 **규칙이 CSS 에 서 있는지**를 지킨다: 한 줄만 빠져도 Tab·방향키가
// 가는 칸이 스크롤 밖이나 미리보기 띠 밑에 서기 때문이다(ADR-0112 D6, 키보드로는 닿는데 눈으로는 못 보는 컨트롤은 늘 Blocker).
//
// 검사 함수(`contractViolations`)는 위반 목록을 돌려주고, 아래 「스캐너가 실제로 잡는다」 시험이 규칙을 하나씩 빼 보며 그 위반이 정확히
// 그 이름으로 나오는지 잰다(통과만 하는 시험이 아니다).
// =============================================================================

interface Rule {
  selector: string;
  media: string | null;
  decls: Map<string, string>;
}

function parseDecls(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of body.split(";")) {
    const at = part.indexOf(":");
    if (at < 0) continue;
    out.set(part.slice(0, at).trim(), part.slice(at + 1).replace(/\s+/g, " ").trim());
  }
  return out;
}

function parseRules(source: string, media: string | null, out: Rule[]): Rule[] {
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("{", index);
    if (open < 0) break;
    const head = source.slice(index, open).trim();
    let depth = 1;
    let cursor = open + 1;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === "{") depth += 1;
      else if (source[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    const body = source.slice(open + 1, cursor - 1);
    if (head.startsWith("@media")) parseRules(body, head.slice("@media".length).trim(), out);
    else out.push({ selector: head.replace(/\s+/g, " "), media, decls: parseDecls(body) });
    index = cursor;
  }
  return out;
}

function parse(css: string): Rule[] {
  return parseRules(css.replace(/\/\*[\s\S]*?\*\//g, ""), null, []);
}

const TALL = "(height > 780px)";

/** 규칙 하나를 선택자(와 미디어)로 찾는다. 같은 선택자가 여러 번 서면 선언을 합친다(나중 것이 이긴다). */
function find(rules: Rule[], selector: string, media: string | null): Map<string, string> | null {
  const matches = rules.filter((rule) => rule.selector === selector && rule.media === media);
  if (matches.length === 0) return null;
  const merged = new Map<string, string>();
  for (const rule of matches) for (const [key, value] of rule.decls) merged.set(key, value);
  return merged;
}

/** 이 편집기의 키보드 가시성 계약. 어긴 규칙의 이름을 돌려준다(통과하면 빈 목록). */
function contractViolations(css: string): string[] {
  const rules = parse(css);
  const problems: string[] = [];
  const body = find(rules, ".avatar-editor-body", null);
  const cue = find(rules, ".avatar-editor-body[data-scrollable]", null);
  const label = find(rules, ".avatar-editor-body label:has(> input.sr-only)", null);
  const radio = find(rules, ".avatar-editor-body label > input.sr-only", null);
  const stickyBase = find(rules, ".avatar-editor-sticky", null);
  const bodyTall = find(rules, ".avatar-editor-body", TALL);
  const stickyTall = find(rules, ".avatar-editor-sticky", TALL);

  if (body?.get("position") !== "relative") problems.push("본문이 위치 기준(position: relative)이 아니다");
  if (!body?.has("margin-inline") || !body?.has("padding-inline")) problems.push("본문에 고리 여백(margin-inline·padding-inline)이 없다");
  if (!/^var\(--spacing-\d+\) var\(--spacing-\d+\)$/.test(body?.get("scroll-padding-block") ?? "")) {
    problems.push("본문에 위·아래 초점 스크롤 여백(scroll-padding-block)이 없다");
  }
  if (!cue?.has("padding-block-end")) problems.push("스크롤 단서에 끝 여백(padding-block-end)이 없다");
  if (!/^linear-gradient\(to bottom, var\(--ink\) calc\(100% - var\(--spacing-\d+\)\), transparent\)$/.test(cue?.get("mask-image") ?? "")) {
    problems.push("스크롤 단서에 아래 가장자리 마스크(mask-image)가 없다");
  }
  if (label?.get("position") !== "relative") problems.push("라디오 라벨이 위치 기준(position: relative)이 아니다");
  if (radio?.get("inset") !== "0" || radio?.get("inline-size") !== "100%" || radio?.get("block-size") !== "100%") {
    problems.push("숨긴 라디오가 라벨 전체를 덮지 않는다(inset: 0, 100% × 100%)");
  }
  // 띠가 붙는 것은 큰 창에서만이다: 큰 창 밖(미디어 없음)의 어떤 규칙도 sticky 를 쓰면 안 된다.
  for (const rule of rules) {
    if (rule.media !== TALL && rule.decls.get("position") === "sticky") problems.push(`큰 창 밖에서 ${rule.selector} 가 sticky 다`);
  }
  if (stickyTall?.get("position") !== "sticky") problems.push("큰 창에서 미리보기 띠가 sticky 가 아니다");
  if (stickyTall?.get("z-index") !== "var(--layer-content-float)") problems.push("띠의 층이 이름 붙은 층(--layer-content-float)이 아니다");
  if (!stickyTall?.has("background-color")) problems.push("띠에 바탕이 없다(스크롤하는 칸이 비친다)");
  if (!stickyBase?.has("margin-inline") || !stickyBase?.has("padding-inline")) problems.push("띠가 본문의 바깥 여백까지 덮지 않는다");
  if (!/^calc\(var\(--avatar-editor-sticky-height, [^)]+\) \+ var\(--spacing-\d+\)\)$/.test(bodyTall?.get("scroll-padding-block-start") ?? "")) {
    problems.push("큰 창에서 초점 스크롤이 띠 높이를 비우지 않는다(scroll-padding-block-start)");
  }
  return problems;
}

const CSS = readFileSync(fileURLToPath(new URL("./avatarEditor.css", import.meta.url)), "utf8");

describe("avatarEditor.css: 키보드로 닿은 칸이 눈에 보이게 하는 규칙", () => {
  it("계약이 전부 서 있다", () => {
    expect(contractViolations(CSS)).toEqual([]);
  });

  it("대화상자가 이 CSS 를 가져온다 (본문 규칙이 지연 청크에 실린다)", () => {
    const dialog = readFileSync(fileURLToPath(new URL("./AvatarEditorDialog.tsx", import.meta.url)), "utf8");
    expect(dialog).toMatch(/^import "\.\/avatarEditor\.css";$/m);
    expect(dialog).toContain('className="avatar-editor-body ');
    expect(dialog).toContain('className="avatar-editor-sticky"');
  });

  it("파서가 실제로 읽는다: 규칙 수와 미디어 안의 규칙을 구분한다", () => {
    const rules = parse(CSS);
    expect(rules.length).toBeGreaterThan(15);
    expect(rules.some((rule) => rule.media === TALL)).toBe(true);
    expect(find(rules, ".avatar-chip", null)?.get("border-radius")).toBe("9999px");
  });

  // 규칙을 하나씩 빼 본다: 각 변형은 정확히 그 이름의 위반을 낸다(스캐너가 헛돌지 않는다는 증거).
  const mutations: Array<[string, (css: string) => string, RegExp]> = [
    [
      "본문의 위치 기준을 빼면",
      (css) => css.replace(/(\.avatar-editor-body \{[^}]*?)position: relative;/, "$1"),
      /본문이 위치 기준/,
    ],
    [
      "라디오 라벨의 위치 기준을 빼면",
      (css) => css.replace(/(label:has\(> input\.sr-only\) \{\s*)position: relative;/, "$1"),
      /라디오 라벨이 위치 기준/,
    ],
    [
      "라디오가 라벨을 덮는 규칙을 빼면",
      (css) => css.replace(/(label > input\.sr-only \{\s*)inset: 0;/, "$1"),
      /라벨 전체를 덮지 않는다/,
    ],
    [
      "띠의 sticky 를 큰 창 밖으로 꺼내면",
      (css) => css.replace("@media (height > 780px) {", "@media (height > 0px) {"),
      /큰 창에서 미리보기 띠가 sticky 가 아니다/,
    ],
    [
      "띠가 미디어 없이 sticky 면",
      (css) => css.replace(/(\.avatar-editor-sticky \{)/, "$1\n  position: sticky;"),
      /큰 창 밖에서 \.avatar-editor-sticky 가 sticky/,
    ],
    [
      "초점 스크롤의 띠 높이 여백을 빼면",
      (css) => css.replace(/scroll-padding-block-start: calc\(var\(--avatar-editor-sticky-height, [^)]+\) \+ var\(--spacing-\d+\)\);/, ""),
      /scroll-padding-block-start/,
    ],
    [
      "본문의 초점 스크롤 여백을 빼면",
      (css) => css.replace(/scroll-padding-block: var\(--spacing-3\) var\(--spacing-8\);/, ""),
      /scroll-padding-block\)/,
    ],
    [
      "스크롤 단서의 마스크를 빼면",
      (css) => css.replace(/mask-image: [^;]+;/, ""),
      /마스크/,
    ],
    [
      "띠의 층을 숫자로 바꾸면",
      (css) => css.replace("z-index: var(--layer-content-float);", "z-index: 5;"),
      /이름 붙은 층/,
    ],
  ];
  it.each(mutations)("%s 위반으로 잡힌다", (_name, mutate, expected) => {
    const mutated = mutate(CSS);
    expect(mutated, "변형이 아무것도 바꾸지 못했다").not.toBe(CSS);
    const problems = contractViolations(mutated);
    expect(problems.length, "위반이 없다").toBeGreaterThan(0);
    expect(problems.join(" | ")).toMatch(expected);
  });
});
