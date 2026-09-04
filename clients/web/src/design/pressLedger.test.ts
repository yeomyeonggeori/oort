import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { PRESS_CLASS } from "./motion";
import { buttonVariants } from "./ui/button";

/**
 * ADR-0179 D5 shrinking ledger (#2000 / UX-R1e R2).
 *
 * The sweep's unit is the **control**, classified by tag/role, not the row
 * that contains it. Discovery is a full sweep: JSX + `createElement` in `.ts`
 * and `.tsx`, same-file and imported class constants, `tokens.css` @utility
 * blocks. A comment cannot keep this green.
 *
 * red proof:
 *   - put `press` on a non-interactive `div`/`li` → forbidden-press is red
 *   - add `press` and `transition-colors` on one element → dual-class is red
 *   - swap `.press` / `.transition-colors` rule order in a scratch CSS → cascade red
 *   - add a hover-only `@utility` in a scratch copy of tokens.css → CSS pin red
 *   - a hover-only local `<Button>` (not `@/design/ui/button`) → residue red
 *   - repair one text-link residue without lowering CEILING → stale-ceiling red
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
const TRANSITION_COLORS_RE = /(?<![\w-])transition-colors\b/;
const DURATION_LITERAL = /(?<![\w-])duration-\d+\b/;
const SCALE_LITERAL = /(?<![\w-])scale-\d+\b/;

const NATIVE_CONTROLS = new Set([
  "button",
  "a",
  "summary",
  "input",
  "select",
  "textarea",
  "option",
]);
const INTERACTIVE_ROLES = new Set([
  "button",
  "menuitem",
  "menuitemradio",
  "menuitemcheckbox",
  "tab",
  "option",
  "checkbox",
  "switch",
  "link",
  "radio",
]);
const PRESS_FORBIDDEN_TAGS = new Set([
  "div",
  "li",
  "span",
  "section",
  "p",
  "ul",
  "ol",
  "article",
  "header",
  "footer",
  "nav",
  "main",
  "aside",
  "h1",
  "h2",
  "h3",
  "h4",
  "figure",
]);

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

function walkSource(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkSource(p, out);
    else if (/\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p) && !/\.d\.ts$/.test(p)) {
      out.push(p);
    }
  }
  return out;
}

export interface PressSite {
  rel: string;
  line: number;
  tag: string;
  role: string;
  text: string;
  kind: "jsx" | "createElement";
}

function hasHover(text: string): boolean {
  return HOVER_RE.test(text);
}

function hasPress(text: string): boolean {
  return PRESS_RE.test(text);
}

function isPascalCase(tag: string): boolean {
  return tag.length > 0 && tag[0] === tag[0].toUpperCase() && tag[0] !== tag[0].toLowerCase();
}

function isAnchorLike(tag: string): boolean {
  const t = tag.toLowerCase();
  return t === "a" || t === "button" || tag === "Link" || tag === "NavLink";
}

/**
 * Canonical §2.6 D5: a text link is an `<a>`/`<button>` whose only affordance
 * is underline or `hover:text-`, with no fill and no box.
 */
function isTextLink(tag: string, text: string): boolean {
  if (!isAnchorLike(tag)) return false;
  if (/(?<![\w-])hover:(?:bg-|opacity-|border-)/.test(text)) return false;
  const underline = /\bunderline\b/.test(text);
  const hoverText = /(?<![\w-])hover:text-/.test(text);
  if (!underline && !hoverText) return false;
  if (underline) return true;
  if (/\brounded-/.test(text)) return false;
  if (/\bflex\b/.test(text) && /\bitems-center\b/.test(text)) return false;
  if (/(?<![\w-])(?:tap-target|size-control|h-control|w-control)\b/.test(text)) {
    return false;
  }
  if (/(?<![\w-])(?:p|px|py|pt|pb|pl|pr)-\d/.test(text)) return false;
  return true;
}

function isPressForbidden(tag: string, role: string, text: string): boolean {
  const t = tag.toLowerCase();
  if (!PRESS_FORBIDDEN_TAGS.has(t)) return false;
  if (role && INTERACTIVE_ROLES.has(role)) return false;
  // Painted face of a hidden native control (UsageSection radio segment).
  if (t === "span" && /peer-(?:checked|focus-visible|focus):/.test(text)) {
    return false;
  }
  return true;
}

function isControl(tag: string, role: string, text = ""): boolean {
  if (isPressForbidden(tag, role, text)) return false;
  const t = tag.toLowerCase();
  if (NATIVE_CONTROLS.has(t)) return true;
  if (tag === "Link" || tag === "NavLink") return true;
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  if (isPascalCase(tag)) return true;
  return false;
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

function jsxAttr(
  el: ts.JsxOpeningLikeElement,
  names: string[]
): ts.JsxAttribute | undefined {
  for (const attr of el.attributes.properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    const name = ts.isIdentifier(attr.name) ? attr.name.text : attr.name.getText();
    if (names.includes(name)) return attr;
  }
  return undefined;
}

function attrText(
  attr: ts.JsxAttribute | undefined,
  index: Map<string, string>
): string {
  if (!attr?.initializer) return "";
  if (ts.isStringLiteral(attr.initializer)) return attr.initializer.text;
  if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
    const expr = attr.initializer.expression;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      return expr.text;
    }
    return collect(expr, index);
  }
  return "";
}

function resolveModule(fromFile: string, spec: string): string | undefined {
  let base: string;
  if (spec.startsWith("@/")) base = join(WEB_SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = join(dirname(fromFile), spec);
  else return undefined;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  for (const p of candidates) {
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return undefined;
}

interface FileIndex {
  strings: Map<string, string>;
  pressTags: Set<string>;
}

function isCreateElement(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr) && expr.text === "createElement") return true;
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.name) &&
    expr.name.text === "createElement"
  ) {
    return true;
  }
  return false;
}

function objectProp(
  obj: ts.ObjectLiteralExpression,
  name: string,
  index: Map<string, string>
): string {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = ts.isIdentifier(prop.name)
      ? prop.name.text
      : ts.isStringLiteral(prop.name)
        ? prop.name.text
        : "";
    if (key === name) return collect(prop.initializer, index);
  }
  return "";
}

function braceBody(source: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIdx + 1, i);
    }
  }
  return "";
}

/** Hover-without-:active `@utility` blocks in tokens.css. Pin 0. */
export function cssHoverWithoutActive(source: string): string[] {
  const names: string[] = [];
  const re = /@utility\s+([a-z0-9-]+)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const body = braceBody(source, match.index + match[0].length - 1);
    const stripped = body.replace(/\/\*[\s\S]*?\*\//g, "");
    if (/:hover\b/.test(stripped) && !/:active\b/.test(stripped)) {
      names.push(match[1]);
    }
  }
  return names;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
}

const SOURCE_FILES = walkSource(WEB_SRC);

function buildFileIndex(file: string, sf: ts.SourceFile): FileIndex {
  const strings = resolveIndex(collectDecls(sf));
  const pressTags = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) {
      continue;
    }
    const spec = stmt.moduleSpecifier.text;
    if (/ui\/button$/.test(spec)) {
      const bindings = stmt.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          const imported = (el.propertyName ?? el.name).text;
          if (imported === "Button") pressTags.add(el.name.text);
        }
      }
    }
    const resolved = resolveModule(file, spec);
    if (!resolved) continue;
    const importedSf = ts.createSourceFile(
      resolved,
      readFileSync(resolved, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      resolved.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const importedIndex = resolveIndex(collectDecls(importedSf));
    const bindings = stmt.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        const imported = (el.propertyName ?? el.name).text;
        const local = el.name.text;
        if (importedIndex.has(imported)) strings.set(local, importedIndex.get(imported)!);
      }
    }
  }
  return { strings, pressTags };
}

function discover(): PressSite[] {
  const sites: PressSite[] = [];
  for (const file of SOURCE_FILES) {
    const src = readFileSync(file, "utf8");
    const rel = `clients/web/src/${relative(WEB_SRC, file)}`;
    const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
    const { strings, pressTags } = buildFileIndex(file, sf);
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = jsxTagName(node.tagName);
        const role = attrText(jsxAttr(node, ["role"]), strings);
        let text = attrText(jsxAttr(node, ["className", "class"]), strings);
        if (pressTags.has(tag)) text = `${text} ${PRESS_CLASS}`;
        sites.push({
          rel,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          tag,
          role,
          text: text.replace(/\s+/g, " ").trim(),
          kind: "jsx",
        });
      }
      if (ts.isCallExpression(node) && isCreateElement(node.expression) && node.arguments.length >= 2) {
        const tagArg = node.arguments[0];
        const propsArg = node.arguments[1];
        const tag = ts.isStringLiteral(tagArg)
          ? tagArg.text
          : ts.isIdentifier(tagArg)
            ? tagArg.text
            : "";
        let text = "";
        let role = "";
        if (ts.isObjectLiteralExpression(propsArg)) {
          text = objectProp(propsArg, "className", strings) || objectProp(propsArg, "class", strings);
          role = objectProp(propsArg, "role", strings);
        }
        if (pressTags.has(tag)) text = `${text} ${PRESS_CLASS}`;
        sites.push({
          rel,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          tag,
          role,
          text: text.replace(/\s+/g, " ").trim(),
          kind: "createElement",
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sites;
}

const SITES = discover();
const HOVER_ONLY = SITES.filter(
  (s) => isControl(s.tag, s.role, s.text) && hasHover(s.text) && !hasPress(s.text)
);
const TEXT_LINKS = HOVER_ONLY.filter((s) => isTextLink(s.tag, s.text));
const INTERACTIVE = HOVER_ONLY.filter((s) => !isTextLink(s.tag, s.text));
const FORBIDDEN_PRESS = SITES.filter(
  (s) => isPressForbidden(s.tag, s.role, s.text) && /(?<![\w-])press\b/.test(s.text)
);
const DUAL_TRANSITION = SITES.filter(
  (s) => /(?<![\w-])press\b/.test(s.text) && TRANSITION_COLORS_RE.test(s.text)
);

/**
 * Remaining hover-without-press **text links** after the UX-R1e R2 sweep.
 * Interactive hover-without-press is hard-zero. Pin shrinks only.
 *
 * R1 scanner N0=107 (interactive 95 · text-link 12) → N1=12. That scanner was
 * JSX-class-string only. This ledger's full sweep is the new denominator.
 */
const RESIDUE: readonly (readonly [string, number])[] = [
  ["clients/web/src/features/attachments/AttachmentTray.tsx", 2],
  ["clients/web/src/features/inbox/InboxRoute.tsx", 1],
  ["clients/web/src/features/routing/MentionRoutingBar.tsx", 1],
  ["clients/web/src/features/timeline/FoldToggle.tsx", 1],
  ["clients/web/src/features/timeline/LongPressHint.tsx", 1],
  ["clients/web/src/features/timeline/MessageBody.tsx", 1],
  ["clients/web/src/features/timeline/MessageRow.tsx", 1],
  ["clients/web/src/features/timeline/PendingRow.tsx", 1],
];

const CEILING = 9;

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
      INTERACTIVE.map((s) => `${s.rel}:${s.line} <${s.tag}> ${s.text}`),
      "interactive hover-without-press"
    ).toEqual([]);
  });

  it("hover 만 있고 press/active 가 없는 자리는 줄어들기만 한다", () => {
    expect(HOVER_ONLY.length).toBeLessThanOrEqual(CEILING);
  });

  it("천장이 낡지 않았다", () => {
    expect(
      HOVER_ONLY.length === CEILING,
      `lower the ceiling to ${HOVER_ONLY.length}`
    ).toBe(true);
    expect(TEXT_LINKS.length).toBe(HOVER_ONLY.length);
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
    expect(channel.every((s) => isTextLink(s.tag, s.text))).toBe(true);
    expect(channel.length).toBeGreaterThan(0);
  });

  it("비상호작용 태그에는 press 가 없다 (H-1)", () => {
    expect(
      FORBIDDEN_PRESS.map((s) => `${s.rel}:${s.line} <${s.tag}>`),
      "press on a non-interactive container"
    ).toEqual([]);
  });

  it("press 와 transition-colors 를 같은 요소에 두지 않는다 (H-2)", () => {
    expect(
      DUAL_TRANSITION.map((s) => `${s.rel}:${s.line} <${s.tag}>`),
      "press + transition-colors on one element"
    ).toEqual([]);
  });

  it("tokens.css hover-without-active 유틸은 0 이다 (H-3)", () => {
    expect(cssHoverWithoutActive(TOKENS_CSS)).toEqual([]);
  });

  it("hover-only @utility 를 넣으면 붉다", () => {
    const scratch = `${TOKENS_CSS}\n@utility sabotage-hover-only {\n  &:hover { color: var(--ink); }\n}\n`;
    expect(cssHoverWithoutActive(scratch)).toEqual(["sabotage-hover-only"]);
  });

  it("이름만 Button 인 hover-only 는 잔량이다 (H-3 이름 허용목록 없음)", () => {
    const scratch = ts.createSourceFile(
      "SabotageButton.tsx",
      `function Button(props: { className?: string }) { return null; }
export function Probe() {
  return <Button className="hover:bg-surface-hover" />;
}
`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const index = resolveIndex(collectDecls(scratch));
    const sites: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const tag = jsxTagName(node.tagName);
        const text = attrText(jsxAttr(node, ["className", "class"]), index);
        if (isControl(tag, "", text) && hasHover(text) && !hasPress(text)) {
          sites.push(tag);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(scratch);
    expect(sites).toEqual(["Button"]);
  });

  it("비상호작용 div 에 press 를 두면 붉다 (H-1)", () => {
    const scratch = ts.createSourceFile(
      "SabotageDiv.tsx",
      `export function Probe() {
  return <div className="press hover:bg-surface-hover" />;
}
`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const forbidden: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const tag = jsxTagName(node.tagName);
        const text = attrText(jsxAttr(node, ["className", "class"]), new Map());
        if (isPressForbidden(tag, "", text) && /(?<![\w-])press\b/.test(text)) {
          forbidden.push(tag);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(scratch);
    expect(forbidden).toEqual(["div"]);
  });

  it("장식 div 의 hover 는 컨트롤이 아니다 (M-4)", () => {
    const scratch = ts.createSourceFile(
      "SabotageDecor.tsx",
      `export function Probe() {
  return <div aria-hidden="true" className="rounded-sm bg-surface hover:bg-surface-hover" />;
}
`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const counted: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const tag = jsxTagName(node.tagName);
        const role = attrText(jsxAttr(node, ["role"]), new Map());
        const text = attrText(jsxAttr(node, ["className", "class"]), new Map());
        if (isControl(tag, role, text) && hasHover(text) && !hasPress(text)) {
          counted.push(tag);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(scratch);
    expect(counted).toEqual([]);
  });

  it(".ts createElement hover-only 는 잔량이다 (H-3)", () => {
    const scratch = ts.createSourceFile(
      "sabotageCreate.ts",
      `import { createElement } from "react";
export function Probe() {
  return createElement("button", { className: "hover:bg-surface-hover" });
}
`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const counted: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        isCreateElement(node.expression) &&
        node.arguments.length >= 2
      ) {
        const tagArg = node.arguments[0];
        const tag = ts.isStringLiteral(tagArg) ? tagArg.text : "";
        let text = "";
        const propsArg = node.arguments[1];
        if (ts.isObjectLiteralExpression(propsArg)) {
          text = objectProp(propsArg, "className", new Map());
        }
        if (isControl(tag, "", text) && hasHover(text) && !hasPress(text)) {
          counted.push(tag);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(scratch);
    expect(counted).toEqual(["button"]);
  });

  it("다른 모듈에서 온 클래스 함수의 hover 도 본다 (H-3)", () => {
    const header = SITES.filter(
      (s) =>
        s.rel.endsWith("ChannelHeaderMenu.tsx") &&
        /hover:bg-surface-hover/.test(s.text)
    );
    expect(header.length).toBeGreaterThan(0);
    expect(header.every((s) => hasPress(s.text))).toBe(true);
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
    const landing = stripComments(LANDING_SRC);
    expect(classBeforeTestId(landing, "onboarding-choose-server")).toMatch(
      /\bpress\b/
    );
    expect(classBeforeTestId(landing, "onboarding-choose-invite")).toMatch(
      /\bpress\b/
    );
    expect(stripComments(MENU_SRC)).toMatch(
      /function menuRowClass[\s\S]*?\bpress\b/
    );
  });

  it("메뉴 행 하이라이트는 background 를 전이하지 않는다 (N-3)", async () => {
    expect(MENU_SRC).toMatch(/\bpress-instant-fill\b/);
    const css = await buildCss(["press", "press-instant-fill"]);
    const fillRules = [...css.matchAll(/\.press-instant-fill\s*\{([^}]*)\}/g)].filter(
      (match) => /transition-property:/.test(match[1])
    );
    expect(fillRules.length).toBeGreaterThan(0);
    const last = fillRules[fillRules.length - 1][1];
    expect(last).toMatch(/transform/);
    expect(last).not.toMatch(/background-color/);
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

  it("compiled CSS 에서 .press 는 .transition-colors 뒤에 선다 (H-2)", async () => {
    const css = await buildCss(["press", "transition-colors"]);
    const last = lastPressOrColorsTransition(css);
    expect(last.selector, "캐스케이드 마지막 소유자는 press").toBe(".press");
    const swapped = css
      .replace(/\.press(?=[{\s])/g, ".transition-colors-HOLD")
      .replace(/\.transition-colors(?=[{\s])/g, ".press")
      .replace(/\.transition-colors-HOLD/g, ".transition-colors");
    expect(
      lastPressOrColorsTransition(swapped).selector,
      "규칙 순서를 바꾸면 .transition-colors 가 이긴다"
    ).toBe(".transition-colors");
  });

  it("눌림 스케일은 토큰이지 scale-95 가 아니다", async () => {
    const css = await buildCss(["press"]);
    expect(css).toMatch(/scale\(\s*0\.98\s*\)/);
    expect(buttonVariants({ variant: "ghost" })).toContain("press");
    expect(PRESS_CLASS).toBe("press");
  });

  it("메시지 본문 행은 press 가 아니라 구분된 active 채움이다 (#1743)", async () => {
    const article = [
      ...MESSAGE_ROW_SRC.matchAll(/"(group relative flex gap-2 px-4[^"]*)"/g),
    ].map((m) => m[1]);
    expect(article, "MessageRow article class").toHaveLength(1);
    expect(article[0]).toMatch(/hover:bg-surface-hover/);
    expect(article[0]).toMatch(/active:bg-surface-pressed/);
    expect(article[0]).not.toMatch(/(?<![\w-])press\b/);
    const pending = [
      ...PENDING_ROW_SRC.matchAll(/"(flex gap-2 px-4[^"]*)"/g),
    ].map((m) => m[1]);
    expect(pending, "PendingRow article class").toHaveLength(1);
    expect(pending[0]).toMatch(/active:bg-surface-pressed/);
    expect(pending[0]).not.toMatch(/(?<![\w-])press\b/);

    const css = await buildCss([
      "hover:bg-surface-hover",
      "active:bg-surface-pressed",
    ]);
    expect(css).toMatch(/var\(--surface-hover\)/);
    expect(css).toMatch(/var\(--surface-pressed\)/);
    const hoverToken = css.match(/--surface-hover/g);
    const pressedToken = css.match(/--surface-pressed/g);
    expect(hoverToken).toBeTruthy();
    expect(pressedToken).toBeTruthy();
  });
});
