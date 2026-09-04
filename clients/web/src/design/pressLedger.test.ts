import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { PRESS_CLASS } from "./motion";
import { buttonVariants } from "./ui/button";

/**
 * ADR-0179 D5 shrinking ledger (#2000 / UX-R1e).
 *
 * Counts `.tsx` **elements** whose class string has a Tailwind `hover:` variant
 * and no `press` / `active:` on that same element. Discovery is structural
 * (JSX/class expression of the element), not a file-level substring: a comment
 * that still names `hover:bg-surface-hover` after the binding is gone cannot
 * keep this green.
 *
 * red proof:
 *   - add a hover-only `<button className="hover:bg-surface-hover">` in a
 *     scratch copy → count rises, this file is red
 *   - raise CEILING while the count stays → exact pin is red
 *   - put `duration-150` or `scale-95` on a migrated element → raw_motion /
 *     the literal ban below is red
 *   - compile a migrated class list, drop `press` → transition-property no
 *     longer contains transform
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = fileURLToPath(new URL("..", import.meta.url));
const require_ = createRequire(import.meta.url);
const TOKENS_CSS = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const SIDEBAR_ROW_SRC = readFileSync(
  new URL("../features/sidebar/SidebarRow.tsx", import.meta.url),
  "utf8"
);
const LANDING_SRC = readFileSync(
  new URL("../features/auth/LandingStep.tsx", import.meta.url),
  "utf8"
);
const REACTION_SRC = readFileSync(
  new URL("../features/timeline/ReactionChips.tsx", import.meta.url),
  "utf8"
);
const MENU_SRC = readFileSync(
  new URL("./ui/dropdown-menu.tsx", import.meta.url),
  "utf8"
);
const IDLE_CARD_SRC = readFileSync(
  new URL("../features/work/WorkSessionIdleCard.tsx", import.meta.url),
  "utf8"
);
const MESSAGE_ROW_SRC = readFileSync(
  new URL("../features/timeline/MessageRow.tsx", import.meta.url),
  "utf8"
);
const PENDING_ROW_SRC = readFileSync(
  new URL("../features/timeline/PendingRow.tsx", import.meta.url),
  "utf8"
);

const HOVER_RE = /(?<![\w-])hover:/;
const PRESS_RE = /(?:(?<![\w-])press\b|(?<![\w-])active:)/;
const DURATION_LITERAL = /(?<![\w-])duration-\d+\b/;
const SCALE_LITERAL = /(?<![\w-])scale-\d+\b/;

/** Channel-view files the UX-R0 runtime probe sat on. Source grep, not DOM. */
const CHANNEL_VIEW = [
  "features/chat/ChatShell.tsx",
  "features/chat/Composer.tsx",
  "features/chat/ComposerFormatTray.tsx",
  "features/timeline/MessageRow.tsx",
  "features/timeline/MessageActions.tsx",
  "features/timeline/ReactionChips.tsx",
  "features/timeline/PendingRow.tsx",
  "features/timeline/UnreadPill.tsx",
  "features/timeline/UnfurlCards.tsx",
  "features/timeline/QuoteBlock.tsx",
  "features/timeline/FoldToggle.tsx",
  "features/timeline/MessageBody.tsx",
  "features/timeline/LongPressHint.tsx",
  "features/timeline/ThreadPanel.tsx",
  "features/timeline/ThreadComposer.tsx",
  "features/timeline/AttachmentList.tsx",
  "features/timeline/ArtifactCard.tsx",
  "features/timeline/AgentCard.tsx",
  "features/sidebar/Sidebar.tsx",
  "features/sidebar/SidebarRow.tsx",
  "features/sidebar/ProfileCard.tsx",
  "features/huddles/HuddleHeaderControl.tsx",
  "features/huddles/HuddleMicMenu.tsx",
  "features/attachments/AttachmentTray.tsx",
  "features/attachments/AttachmentDownloadButton.tsx",
  "app/AppTitlebar.tsx",
  "app/SidebarDrawerToggle.tsx",
] as const;

function walkTsx(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkTsx(p, out);
    else if (p.endsWith(".tsx") && !/\.test\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

export interface PressSite {
  rel: string;
  line: number;
  tag: string;
  text: string;
}

function hasHover(text: string): boolean {
  return HOVER_RE.test(text);
}

function hasPress(text: string): boolean {
  return PRESS_RE.test(text);
}

function isTextLink(text: string): boolean {
  const controlHover =
    /(?<![\w-])hover:(?:bg-|opacity-|border-)/.test(text);
  if (controlHover) return false;
  return (
    /\bunderline\b/.test(text) ||
    /(?<![\w-])hover:text-/.test(text)
  );
}

function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    return expr.name.text;
  }
  return undefined;
}

function collect(node: ts.Node, index: Map<string, string>): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      out += collect(span.expression, index) + span.literal.text;
    }
    return out;
  }
  if (ts.isIdentifier(node)) {
    if (node.text === "PRESS_CLASS") return PRESS_CLASS;
    return index.get(node.text) ?? "";
  }
  if (ts.isPropertyAccessExpression(node)) {
    return collect(node.name, index);
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return collect(node.expression, index);
  }
  if (ts.isConditionalExpression(node)) {
    return `${collect(node.whenTrue, index)} ${collect(node.whenFalse, index)}`;
  }
  if (ts.isBinaryExpression(node)) {
    return `${collect(node.left, index)} ${collect(node.right, index)}`;
  }
  if (ts.isCallExpression(node)) {
    const parts = node.arguments.map((arg) => collect(arg, index));
    const callee = calleeName(node.expression);
    if (callee && index.has(callee)) parts.unshift(index.get(callee)!);
    return parts.join(" ");
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties
      .map((prop) => {
        if (ts.isPropertyAssignment(prop)) return collect(prop.initializer, index);
        if (ts.isShorthandPropertyAssignment(prop)) {
          return index.get(prop.name.text) ?? "";
        }
        if (ts.isSpreadAssignment(prop)) return collect(prop.expression, index);
        return "";
      })
      .join(" ");
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((el) => collect(el, index)).join(" ");
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return collect(node.body, index);
  }
  if (ts.isBlock(node)) {
    return node.statements.map((stmt) => collect(stmt, index)).join(" ");
  }
  if (ts.isReturnStatement(node) && node.expression) {
    return collect(node.expression, index);
  }
  if (ts.isJsxExpression(node) && node.expression) {
    return collect(node.expression, index);
  }
  const bits: string[] = [];
  ts.forEachChild(node, (child) => {
    bits.push(collect(child, index));
  });
  return bits.filter(Boolean).join(" ");
}

interface Decl {
  name: string;
  node: ts.Node;
}

function collectDecls(sf: ts.SourceFile): Decl[] {
  const decls: Decl[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      decls.push({ name: node.name.text, node: node.initializer });
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      decls.push({ name: node.name.text, node: node.body });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return decls;
}

function resolveIndex(decls: Decl[]): Map<string, string> {
  const index = new Map<string, string>([["PRESS_CLASS", PRESS_CLASS]]);
  for (let pass = 0; pass < 6; pass += 1) {
    for (const decl of decls) {
      index.set(decl.name, collect(decl.node, index));
    }
  }
  return index;
}

function jsxTagName(tag: ts.JsxTagNameExpression): string {
  if (ts.isIdentifier(tag)) return tag.text;
  if (ts.isPropertyAccessExpression(tag)) return tag.name.text;
  if (ts.isJsxNamespacedName(tag)) return `${tag.namespace.text}:${tag.name.text}`;
  return "";
}

function classAttr(el: ts.JsxOpeningLikeElement): ts.JsxAttribute | undefined {
  for (const attr of el.attributes.properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    const name = ts.isIdentifier(attr.name)
      ? attr.name.text
      : attr.name.getText();
    if (name === "className" || name === "class") return attr;
  }
  return undefined;
}

function alwaysPressTag(tag: string): boolean {
  return tag === "Button";
}

function discover(): PressSite[] {
  const sites: PressSite[] = [];
  for (const file of walkTsx(WEB_SRC)) {
    const src = readFileSync(file, "utf8");
    const rel = `clients/web/src/${relative(WEB_SRC, file)}`;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const index = resolveIndex(collectDecls(sf));
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const attr = classAttr(node);
        const tag = jsxTagName(node.tagName);
        let text = "";
        if (attr?.initializer) {
          if (ts.isStringLiteral(attr.initializer)) text = attr.initializer.text;
          else if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
            text = collect(attr.initializer.expression, index);
          }
        }
        if (alwaysPressTag(tag)) text = `${text} ${PRESS_CLASS}`;
        if (hasHover(text) && !hasPress(text)) {
          sites.push({
            rel,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            tag,
            text: text.replace(/\s+/g, " ").trim(),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sites;
}

const SITES = discover();
const HOVER_ONLY = SITES;
const TEXT_LINKS = HOVER_ONLY.filter((s) => isTextLink(s.text));
const INTERACTIVE = HOVER_ONLY.filter((s) => !isTextLink(s.text));

/**
 * Remaining hover-without-press sites after the UX-R1e sweep.
 * All 12 are text links (underline or color-only `hover:text-`). Interactive
 * hover-without-press is hard-zero. Pin is exact: raise this without adding
 * sites → red; add a hover-only control without raising → red.
 *
 * N0 (pre-sweep, this scanner) = 107 (interactive 95 · text-link 12).
 */
const RESIDUE: readonly (readonly [string, number])[] = [
  ["clients/web/src/features/attachments/AttachmentTray.tsx", 2],
  ["clients/web/src/features/chat/ChatShell.tsx", 1],
  ["clients/web/src/features/inbox/InboxRoute.tsx", 1],
  ["clients/web/src/features/routing/MentionRoutingBar.tsx", 1],
  ["clients/web/src/features/timeline/FoldToggle.tsx", 1],
  ["clients/web/src/features/timeline/LongPressHint.tsx", 1],
  ["clients/web/src/features/timeline/MessageBody.tsx", 1],
  ["clients/web/src/features/timeline/MessageRow.tsx", 2],
  ["clients/web/src/features/timeline/PendingRow.tsx", 1],
  ["clients/web/src/features/workstreams/WorkstreamDetailRoute.tsx", 1],
];

const CEILING = 12;

function countedByFile(sites: PressSite[]): [string, number][] {
  const counted = new Map<string, number>();
  for (const site of sites) {
    counted.set(site.rel, (counted.get(site.rel) ?? 0) + 1);
  }
  return [...counted].sort(([a], [b]) => a.localeCompare(b));
}

async function loadStylesheet(id: string, base: string) {
  if (id === "tailwindcss" || id.endsWith("tailwindcss/index.css")) {
    const path = require_.resolve("tailwindcss/index.css");
    return { path, base: dirname(path), content: readFileSync(path, "utf8") };
  }
  const path = id.startsWith(".") || id.startsWith("/") ? `${base}/${id}` : id;
  return { path, base: dirname(path), content: readFileSync(path, "utf8") };
}

async function buildCss(candidates: string[]): Promise<string> {
  const compiler = await compile(TOKENS_CSS, { base: HERE, loadStylesheet });
  return compiler.build(candidates);
}

function classTokens(className: string): string[] {
  return className.split(/\s+/).filter(Boolean);
}

function lastPressOrColorsTransition(css: string): {
  selector: string;
  body: string;
} {
  const rules = [
    ...css.matchAll(/(\.press|\.transition-colors)\s*\{([^}]*)\}/g),
  ].filter((match) => /transition-property:/.test(match[2]));
  if (rules.length === 0) {
    throw new Error(".press / .transition-colors 에 transition-property 가 없다");
  }
  const last = rules[rules.length - 1];
  return { selector: last[1], body: last[2] };
}

function constString(source: string, name: string): string {
  const re = new RegExp(
    `(?:const|let|var)\\s+${name}\\s*=\\s*([\\s\\S]*?);`
  );
  const match = source.match(re);
  if (!match) throw new Error(`${name} 이 없다`);
  const bits = [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (bits.length === 0) throw new Error(`${name} 문자열 없음`);
  return bits.join(" ");
}

function classBeforeTestId(source: string, testId: string): string {
  const idx = source.indexOf(`data-testid="${testId}"`);
  expect(idx, testId).toBeGreaterThan(-1);
  return source.slice(Math.max(0, idx - 500), idx);
}

describe("ADR-0179 D5 shrinking ledger (#2000)", () => {
  it("발견이 JSX 클래스이지 주석이 아니다", () => {
    expect(IDLE_CARD_SRC).toMatch(/hover:bg-surface-hover/);
    expect(
      HOVER_ONLY.filter((s) => s.rel.endsWith("WorkSessionIdleCard.tsx"))
    ).toEqual([]);
  });

  it("컨트롤 hover-only 는 0 이다", () => {
    expect(
      INTERACTIVE.map((s) => `${s.rel}:${s.line} <${s.tag}>`),
      "interactive hover-without-press"
    ).toEqual([]);
  });

  it("hover 만 있고 press/active 가 없는 자리는 줄어들기만 한다", () => {
    expect(HOVER_ONLY.length).toBe(CEILING);
    expect(HOVER_ONLY.length).toBeLessThanOrEqual(CEILING);
    expect(TEXT_LINKS.length).toBe(CEILING);
  });

  it("잔량은 좌표와 수까지 표와 정확히 맞는다", () => {
    expect(
      countedByFile(HOVER_ONLY),
      "잔량 표가 낡았다 — 고쳤으면 줄이고, 늘었으면 적어라"
    ).toEqual(RESIDUE.map(([rel, n]) => [rel, n]));
  });

  it("채널 뷰 소스 잔량은 텍스트 링크뿐이다 (UX-R0 52/6/26 은 런타임 DOM)", () => {
    const channel = HOVER_ONLY.filter((s) =>
      CHANNEL_VIEW.some((part) => s.rel.endsWith(part))
    );
    expect(channel.every((s) => isTextLink(s.text))).toBe(true);
    expect(channel.length).toBeGreaterThan(0);
  });

  it("이관 표면은 duration-* / scale-* 리터럴을 들지 않는다", () => {
    const row =
      constString(SIDEBAR_ROW_SRC, "rowClass") +
      " " +
      constString(SIDEBAR_ROW_SRC, "inactiveClass");
    expect(row).toContain("press");
    expect(row).not.toMatch(DURATION_LITERAL);
    expect(row).not.toMatch(SCALE_LITERAL);
    expect(REACTION_SRC).toMatch(/\bpress\b/);
    for (const site of HOVER_ONLY) {
      expect(site.text, `${site.rel}:${site.line}`).not.toMatch(DURATION_LITERAL);
      expect(site.text, `${site.rel}:${site.line}`).not.toMatch(SCALE_LITERAL);
    }
  });

  it("S0 CTA 와 메뉴 행은 press 를 든다 (N-4, D5 메뉴)", () => {
    const landing = LANDING_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /(?<!:)\/\/.*$/gm,
      ""
    );
    expect(classBeforeTestId(landing, "onboarding-choose-server")).toMatch(
      /\bpress\b/
    );
    expect(classBeforeTestId(landing, "onboarding-choose-invite")).toMatch(
      /\bpress\b/
    );
    expect(MENU_SRC.replace(/\/\*[\s\S]*?\*\//g, "")).toMatch(
      /function menuRowClass[\s\S]*?\bpress\b/
    );
  });

  it("SidebarRow 이관 목록은 press 가 이기고 transform 이 있으며 outline-color 는 없다", async () => {
    const rowClass = constString(SIDEBAR_ROW_SRC, "rowClass");
    const inactiveClass = constString(SIDEBAR_ROW_SRC, "inactiveClass");
    const className = `${rowClass} ${inactiveClass}`;
    expect(className).toContain("press");
    expect(className).not.toMatch(DURATION_LITERAL);
    expect(className).not.toMatch(SCALE_LITERAL);

    const css = await buildCss(classTokens(className));
    const last = lastPressOrColorsTransition(css);
    expect(last.selector, "캐스케이드 마지막 소유자는 press").toBe(".press");
    expect(last.body).toMatch(/transform/);
    expect(last.body).not.toMatch(/outline-color/);
  });

  it("눌림 스케일은 토큰이지 scale-95 가 아니다", async () => {
    const css = await buildCss(["press"]);
    expect(css).toMatch(/scale\(\s*0\.98\s*\)/);
    expect(buttonVariants({ variant: "ghost" })).toContain("press");
    expect(PRESS_CLASS).toBe("press");
  });

  it("메시지 본문 행은 press 가 아니라 active 채움이다 (#1743 드래그 선택)", () => {
    const article = [
      ...MESSAGE_ROW_SRC.matchAll(/"(group relative flex gap-2 px-4[^"]*)"/g),
    ].map((m) => m[1]);
    expect(article, "MessageRow article class").toHaveLength(1);
    expect(article[0]).toMatch(/hover:bg-surface-hover/);
    expect(article[0]).toMatch(/active:bg-surface-hover/);
    expect(article[0]).not.toMatch(/(?<![\w-])press\b/);
    const pending = [
      ...PENDING_ROW_SRC.matchAll(/"(flex gap-2 px-4[^"]*)"/g),
    ].map((m) => m[1]);
    expect(pending, "PendingRow article class").toHaveLength(1);
    expect(pending[0]).toMatch(/active:bg-surface-hover/);
    expect(pending[0]).not.toMatch(/(?<![\w-])press\b/);
  });
});
