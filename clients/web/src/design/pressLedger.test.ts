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
 *   - R2 ScopeButton (press only on unselected) → selected duration 0s
 *   - checked toggle branch without hover/press → INTERACTIVE residue
 *   - drop or add a PRESS_TRIPLET_INSITU id without updating the pin → set red
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
const SETTINGS_FIELDS_SRC = readFileSync(
  new URL("../features/settings/SettingsFields.tsx", import.meta.url),
  "utf8"
);
const USAGE_SRC = readFileSync(
  new URL("../features/settings/UsageSection.tsx", import.meta.url),
  "utf8"
);
const WEBHOOK_SRC = readFileSync(
  new URL("../features/settings/WebhookSection.tsx", import.meta.url),
  "utf8"
);
const PLUGIN_SRC = readFileSync(
  new URL("../features/plugins/PluginSection.tsx", import.meta.url),
  "utf8"
);
const CHANNEL_HEADER_SRC = readFileSync(
  new URL("../features/chat/channelHeaderControl.ts", import.meta.url),
  "utf8"
);
const TERMINAL_DOCK_SRC = readFileSync(
  new URL("../features/work/TerminalDock.tsx", import.meta.url),
  "utf8"
);
const WORK_PANEL_SRC = readFileSync(
  new URL("../features/work/WorkPanel.tsx", import.meta.url),
  "utf8"
);
const WORK_CONSOLE_SRC = readFileSync(
  new URL("../features/workConsole/WorkConsoleRoute.tsx", import.meta.url),
  "utf8"
);
const GALLERY_SRC = readFileSync(
  new URL("./Gallery.tsx", import.meta.url),
  "utf8"
);
const CAPTURE_SRC = readFileSync(
  new URL("../../scripts/capture-screens.mjs", import.meta.url),
  "utf8"
);
const DRAFTS_SRC = readFileSync(
  new URL("../features/drafts/DraftsRoute.tsx", import.meta.url),
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
 * Canonical §2.6 D5: a text link is an `<a>`/`<button>` whose rendering is
 * text only — underline or `hover:text-`, with no background fill and no
 * border/rounded box. Padding alone (a touch target) does not make a box.
 */
export function isTextLink(tag: string, text: string): boolean {
  if (!isAnchorLike(tag)) return false;
  const underline = /\bunderline\b/.test(text);
  const hoverText = /(?<![\w-])hover:text-/.test(text);
  if (!underline && !hoverText) return false;
  if (/(?<![\w-])(?:hover:)?bg-/.test(text)) return false;
  if (/(?<![\w-])hover:(?:opacity-|border-)/.test(text)) return false;
  if (/(?<![\w-])border(?!-\d)/.test(text)) return false;
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
  if (
    t === "label" &&
    (hasHover(text) ||
      hasPress(text) ||
      /(?<![\w-])bg-accent-soft/.test(text) ||
      /data-\[selected/.test(text))
  ) {
    return true;
  }
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

function cartesianJoin(parts: string[][]): string[] {
  return parts.reduce<string[]>(
    (acc, next) => acc.flatMap((a) => next.map((n) => `${a} ${n}`.trim())),
    [""]
  );
}

/** One class string per conditional branch. `collect()` still merges for import indexes. */
function expandClass(node: ts.Node, index: Map<string, string>): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [node.text];
  }
  if (ts.isTemplateExpression(node)) {
    let acc = [node.head.text];
    for (const span of node.templateSpans) {
      const mids = expandClass(span.expression, index);
      acc = acc.flatMap((a) => mids.map((m) => a + m + span.literal.text));
    }
    return acc;
  }
  if (ts.isIdentifier(node)) {
    if (node.text === "PRESS_CLASS") return [PRESS_CLASS];
    return [index.get(node.text) ?? ""];
  }
  if (ts.isPropertyAccessExpression(node)) {
    return expandClass(node.name, index);
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return expandClass(node.expression, index);
  }
  if (ts.isConditionalExpression(node)) {
    return [
      ...expandClass(node.whenTrue, index),
      ...expandClass(node.whenFalse, index),
    ];
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken
    ) {
      return ["", ...expandClass(node.right, index)];
    }
    return cartesianJoin([
      expandClass(node.left, index),
      expandClass(node.right, index),
    ]);
  }
  if (ts.isCallExpression(node)) {
    const parts = node.arguments.map((arg) => expandClass(arg, index));
    const callee = calleeName(node.expression);
    if (callee && index.has(callee)) parts.unshift([index.get(callee)!]);
    return cartesianJoin(parts);
  }
  if (ts.isObjectLiteralExpression(node)) {
    return cartesianJoin(
      node.properties.map((prop) => {
        if (ts.isPropertyAssignment(prop)) {
          return expandClass(prop.initializer, index);
        }
        if (ts.isShorthandPropertyAssignment(prop)) {
          return [index.get(prop.name.text) ?? ""];
        }
        if (ts.isSpreadAssignment(prop)) {
          return expandClass(prop.expression, index);
        }
        return [""];
      })
    );
  }
  if (ts.isArrayLiteralExpression(node)) {
    return cartesianJoin(node.elements.map((el) => expandClass(el, index)));
  }
  if (ts.isJsxExpression(node) && node.expression) {
    return expandClass(node.expression, index);
  }
  return [collect(node, index)];
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

function attrClasses(
  attr: ts.JsxAttribute | undefined,
  index: Map<string, string>
): string[] {
  if (!attr?.initializer) return [""];
  if (ts.isStringLiteral(attr.initializer)) return [attr.initializer.text];
  if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
    return expandClass(attr.initializer.expression, index);
  }
  return [""];
}

function attrText(
  attr: ts.JsxAttribute | undefined,
  index: Map<string, string>
): string {
  return attrClasses(attr, index).join(" ").replace(/\s+/g, " ").trim();
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

function objectPropNode(
  obj: ts.ObjectLiteralExpression,
  name: string
): ts.Expression | undefined {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = ts.isIdentifier(prop.name)
      ? prop.name.text
      : ts.isStringLiteral(prop.name)
        ? prop.name.text
        : "";
    if (key === name) return prop.initializer;
  }
  return undefined;
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
        const classes = attrClasses(jsxAttr(node, ["className", "class"]), strings);
        const unique = [...new Set(classes.map((c) => c.replace(/\s+/g, " ").trim()))];
        for (const raw of unique.length > 0 ? unique : [""]) {
          let text = raw;
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
      }
      if (ts.isCallExpression(node) && isCreateElement(node.expression) && node.arguments.length >= 2) {
        const tagArg = node.arguments[0];
        const propsArg = node.arguments[1];
        const tag = ts.isStringLiteral(tagArg)
          ? tagArg.text
          : ts.isIdentifier(tagArg)
            ? tagArg.text
            : "";
        let texts: string[] = [""];
        let role = "";
        if (ts.isObjectLiteralExpression(propsArg)) {
          const classAttr =
            objectPropNode(propsArg, "className") || objectPropNode(propsArg, "class");
          texts = classAttr
            ? expandClass(classAttr, strings)
            : [""];
          role = objectProp(propsArg, "role", strings);
        }
        const unique = [...new Set(texts.map((c) => c.replace(/\s+/g, " ").trim()))];
        for (const raw of unique.length > 0 ? unique : [""]) {
          let text = raw;
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
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sites;
}

function isInertPointer(text: string): boolean {
  return /cursor-not-allowed|cursor-wait/.test(text);
}

function isPointerInteractive(s: PressSite): boolean {
  if (isPressForbidden(s.tag, s.role, s.text)) return false;
  if (!isControl(s.tag, s.role, s.text)) return false;
  if (hasHover(s.text) || hasPress(s.text) || isTextLink(s.tag, s.text)) {
    return true;
  }
  if (isInertPointer(s.text)) return false;
  if (/data-\[selected/.test(s.text)) return true;
  return (
    s.rel.endsWith("SettingsFields.tsx") &&
    s.tag.toLowerCase() === "label" &&
    /(?<![\w-])bg-accent-soft/.test(s.text)
  );
}

const SITES = discover();
const POPULATION = SITES.filter(isPointerInteractive);
const MISSING_PRESS = POPULATION.filter((s) => !hasPress(s.text));
const HOVER_ONLY = MISSING_PRESS;
const TEXT_LINKS = MISSING_PRESS.filter((s) => isTextLink(s.tag, s.text));
const INTERACTIVE = MISSING_PRESS.filter((s) => !isTextLink(s.tag, s.text));
const FORBIDDEN_PRESS = SITES.filter(
  (s) => isPressForbidden(s.tag, s.role, s.text) && /(?<![\w-])press\b/.test(s.text)
);
const DUAL_TRANSITION = SITES.filter(
  (s) => /(?<![\w-])press\b/.test(s.text) && TRANSITION_COLORS_RE.test(s.text)
);

/**
 * Remaining press-missing **text links** after the UX-R1e R4 classifier.
 * Interactive elements (tag/role + neither-hover-nor-press cmdk/checked
 * toggle) without press are hard-zero. Pin shrinks only.
 *
 * Bare underlined links (padding/rounded/touch-target without a painted fill
 * or border) are text, not boxes.
 */
const RESIDUE: readonly (readonly [string, number])[] = [
  ["clients/web/src/features/attachments/AttachmentTray.tsx", 2],
  ["clients/web/src/features/auth/ConnectPage.tsx", 1],
  ["clients/web/src/features/inbox/InboxRoute.tsx", 1],
  ["clients/web/src/features/plugins/PluginSection.tsx", 1],
  ["clients/web/src/features/routing/MentionRoutingBar.tsx", 1],
  ["clients/web/src/features/timeline/FoldToggle.tsx", 1],
  ["clients/web/src/features/timeline/LongPressHint.tsx", 1],
  ["clients/web/src/features/timeline/MessageBody.tsx", 1],
  ["clients/web/src/features/timeline/MessageRow.tsx", 1],
  ["clients/web/src/features/timeline/PendingRow.tsx", 1],
];

const CEILING = 11;

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

function sourceFile(source: string, fileName: string): ts.SourceFile {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
}

function uniqueClasses(values: string[]): string[] {
  return [...new Set(values.map((c) => c.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

function cnBranchesInFunction(source: string, fileName: string, fnName: string): string[] {
  const sf = sourceFile(source, fileName);
  const index = resolveIndex(collectDecls(sf));
  const fn = collectDecls(sf).find((d) => d.name === fnName);
  if (!fn) throw new Error(`${fnName} 이 없다`);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && calleeName(node.expression) === "cn") {
      out.push(...expandClass(node, index));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.node);
  return uniqueClasses(out);
}

function classBranchesInFunctionOnTag(
  source: string,
  fileName: string,
  fnName: string,
  tag: string
): string[] {
  const sf = sourceFile(source, fileName);
  const index = resolveIndex(collectDecls(sf));
  const fn = collectDecls(sf).find((d) => d.name === fnName);
  if (!fn) throw new Error(`${fnName} 이 없다`);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (jsxTagName(node.tagName) === tag) {
        out.push(...attrClasses(jsxAttr(node, ["className", "class"]), index));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.node);
  return uniqueClasses(out);
}

function classBranchesByTestId(source: string, fileName: string, testId: string): string[] {
  const sf = sourceFile(source, fileName);
  const index = resolveIndex(collectDecls(sf));
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (attrText(jsxAttr(node, ["data-testid"]), index) === testId) {
        out.push(...attrClasses(jsxAttr(node, ["className", "class"]), index));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return uniqueClasses(out);
}

function stringArrayConst(source: string, name: string): string[] {
  const match = source.match(new RegExp(String.raw`const ${name} = \[([^\]]*)\]`));
  if (!match) throw new Error(`${name} 배열이 없다`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("ADR-0179 D5 shrinking ledger (#2000)", () => {
  it("발견이 JSX 클래스이지 주석이 아니다", () => {
    expect(IDLE_CARD_SRC).toMatch(/hover:bg-surface-hover/);
    expect(
      HOVER_ONLY.filter((s) => s.rel.endsWith("WorkSessionIdleCard.tsx"))
    ).toEqual([]);
  });

  it("컨트롤 중 press 없는 자리는 텍스트 링크뿐이다", () => {
    expect(
      INTERACTIVE.map((s) => `${s.rel}:${s.line} <${s.tag}> ${s.text}`),
      "interactive without press"
    ).toEqual([]);
  });

  it("press 없는 자리는 줄어들기만 한다", () => {
    expect(MISSING_PRESS.length).toBeLessThanOrEqual(CEILING);
  });

  it("천장이 낡지 않았다", () => {
    const added =
      INTERACTIVE[0] ??
      HOVER_ONLY.find((s) => !RESIDUE.some(([rel]) => rel === s.rel)) ??
      HOVER_ONLY[0];
    const message =
      HOVER_ONLY.length > CEILING
        ? `press-missing control added at ${added.rel}:${added.line}`
        : `lower the ceiling to ${HOVER_ONLY.length}`;
    expect(HOVER_ONLY.length, message).toBe(CEILING);
    expect(TEXT_LINKS.length).toBe(HOVER_ONLY.length);
  });

  it("잔량은 좌표와 수까지 표와 정확히 맞는다", () => {
    expect(
      countedByFile(HOVER_ONLY),
      "잔량 표가 낡았다 — 고쳤으면 줄이고, 늘었으면 적어라"
    ).toEqual(RESIDUE.map(([rel, n]) => [rel, n]));
  });

  it("전수 인구는 상호작용 요소이다 (M-3)", () => {
    expect(POPULATION.length, `N0=${POPULATION.length}`).toBeGreaterThan(
      MISSING_PRESS.length
    );
    expect(TEXT_LINKS.length, `N1=${MISSING_PRESS.length}`).toBe(
      MISSING_PRESS.length
    );
    expect(INTERACTIVE, `interactive without press; N0=${POPULATION.length}`).toEqual(
      []
    );
    expect(CEILING, `ceiling=${CEILING}`).toBe(MISSING_PRESS.length);
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

  it("S0 CTA 는 press 를 들고 메뉴 행은 채움만 든다 (N-5)", () => {
    const landing = stripComments(LANDING_SRC);
    expect(classBeforeTestId(landing, "onboarding-choose-server")).toMatch(
      /\bpress\b/
    );
    expect(classBeforeTestId(landing, "onboarding-choose-invite")).toMatch(
      /\bpress\b/
    );
    const menu = stripComments(MENU_SRC);
    expect(menu).toMatch(/function menuRowClass[\s\S]*?\bpress-instant-fill\b/);
    expect(menu).toMatch(/function menuRowClass[\s\S]*?active:bg-surface-pressed/);
    expect(menu).not.toMatch(
      /function menuRowClass[\s\S]*?\bpress press-instant-fill\b/
    );
  });

  it("메뉴 행은 채움만 있고 변형은 없다 (N-5)", async () => {
    expect(MENU_SRC).toMatch(/\bpress-instant-fill\b/);
    const css = await buildCss(["press", "press-instant-fill"]);
    const fillRules = [...css.matchAll(/\.press-instant-fill\s*\{([^}]*)\}/g)].filter(
      (match) => /transition-property:/.test(match[1])
    );
    expect(fillRules.length).toBeGreaterThan(0);
    const last = fillRules[fillRules.length - 1][1];
    expect(last).not.toMatch(/transform/);
    expect(last).not.toMatch(/background-color/);
    expect(css).toMatch(/\.press-instant-fill:active[\s\S]*?transform:\s*none/);
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

  it("반경 있는 details 는 overflow-hidden 으로 summary 채움을 자른다 (H-1)", () => {
    expect(SETTINGS_FIELDS_SRC).toMatch(
      /SETTINGS_COLLAPSIBLE_CARD_CLASS =\s*"min-w-0 overflow-hidden rounded-md border border-line"/
    );
    expect(USAGE_SRC).toMatch(/SETTINGS_COLLAPSIBLE_CARD_CLASS/);
    expect(WEBHOOK_SRC).toMatch(/SETTINGS_COLLAPSIBLE_CARD_CLASS/);
    expect(GALLERY_SRC).toMatch(/SETTINGS_COLLAPSIBLE_CARD_CLASS/);
    expect(GALLERY_SRC).toMatch(/press-triplet-summary-card/);
  });

  it("선택 분기도 press 전이를 진다 (H-2g)", async () => {
    const groups = [
      classBranchesInFunctionOnTag(WORK_PANEL_SRC, "WorkPanel.tsx", "ScopeButton", "button"),
      classBranchesByTestId(WORK_PANEL_SRC, "WorkPanel.tsx", "work-session-row"),
      classBranchesByTestId(TERMINAL_DOCK_SRC, "TerminalDock.tsx", "terminal-dock-tab"),
      classBranchesInFunctionOnTag(WORK_CONSOLE_SRC, "WorkConsoleRoute.tsx", "WorkConsoleRow", "Link"),
      cnBranchesInFunction(
        CHANNEL_HEADER_SRC,
        "channelHeaderControl.ts",
        "channelHeaderControlClass"
      ),
    ];
    expect(groups.every((g) => g.length > 0)).toBe(true);
    for (const branches of groups) {
      for (const className of branches) {
        expect(className, className).toMatch(/(?<![\w-])press\b/);
        const css = await buildCss(classTokens(className));
        expect(pressDuration(css), className).not.toBe("0s");
      }
    }
  });

  it("ScopeButton 을 R2 모양으로 되돌리면 선택 분기가 붉다 (H-2g RED)", async () => {
    const sabotaged = WORK_PANEL_SRC.replace(
      `"h-control-sm rounded-sm px-2 text-meta press focus-visible:focus-ring"`,
      `"h-control-sm rounded-sm px-2 text-meta focus-visible:focus-ring"`
    ).replace(
      `: "text-ink-muted hover:bg-surface-hover"`,
      `: "text-ink-muted press hover:bg-surface-hover"`
    );
    const branches = classBranchesInFunctionOnTag(
      sabotaged,
      "WorkPanel.tsx",
      "ScopeButton",
      "button"
    );
    const selected = branches.filter((c) => /bg-accent-soft/.test(c));
    expect(selected.length).toBeGreaterThan(0);
    expect(
      selected.filter((c) => /(?<![\w-])press\b/.test(c)),
      selected.join(" | ")
    ).toEqual([]);
  });

  it("설정 토글 행은 행 전체가 라벨이고 채움만 한다 (H-3)", () => {
    const toggle = SETTINGS_FIELDS_SRC.match(
      /export function SettingsToggleRow[\s\S]*?\nexport function /
    )?.[0];
    expect(toggle).toBeTruthy();
    expect(toggle).toMatch(/<label\s+htmlFor=\{testId\}/);
    const rowClass = toggle!.match(/<label[\s\S]*?className=\{cn\(([\s\S]*?)\)\}/)?.[1];
    expect(rowClass).toMatch(/hover:bg-surface-hover active:bg-surface-pressed/);
    expect(rowClass).toMatch(/checked && "bg-accent-soft"/);
    expect(rowClass).not.toMatch(/(?<![\w-])press\b/);
    expect(toggle).toMatch(/<input[\s\S]*?\bpress\b/);
    expect(constString(SETTINGS_FIELDS_SRC, "SETTINGS_COLLAPSIBLE_SUMMARY_CLASS")).toMatch(
      /hover:bg-surface-hover active:bg-surface-pressed/
    );
    expect(constString(SETTINGS_FIELDS_SRC, "SETTINGS_COLLAPSIBLE_SUMMARY_CLASS")).not.toMatch(
      /(?<![\w-])press\b/
    );
  });

  it("checked 분기의 hover/press 를 빼면 전수가 그 분기를 센다 (H-3 RED)", () => {
    const site: PressSite = {
      rel: "clients/web/src/features/settings/SettingsFields.tsx",
      line: 53,
      tag: "label",
      role: "",
      text: 'flex min-w-0 cursor-pointer items-start gap-3 border-b border-line p-3 last:border-b-0 bg-accent-soft',
      kind: "jsx",
    };
    expect(isPointerInteractive(site)).toBe(true);
    expect(hasHover(site.text)).toBe(false);
    expect(hasPress(site.text)).toBe(false);
    expect(isTextLink(site.tag, site.text)).toBe(false);
  });

  it("underline 만으로 텍스트 링크가 되지 않는다 (M-4)", () => {
    expect(
      isTextLink(
        "button",
        "rounded-md bg-accent-soft px-3 py-2 text-ink underline hover:text-ink"
      )
    ).toBe(false);
    expect(
      isTextLink("button", "underline underline-offset-2 hover:text-ink")
    ).toBe(true);
    expect(
      isTextLink(
        "button",
        "touch-target rounded-sm px-2 underline underline-offset-2 hover:text-ink"
      )
    ).toBe(true);
  });

  it("plugin-marketplace-row 합성 클래스는 :active 규칙을 컴파일한다 (N-1)", async () => {
    const rows = SITES.filter((s) =>
      /\bplugin-marketplace-row\b/.test(s.text)
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(PLUGIN_SRC).not.toMatch(
      /plugin-marketplace-row[\s\S]{0,80}\bpress\b/
    );
    for (const row of rows) {
      expect(row.text, `${row.rel}:${row.line}`).not.toMatch(
        /(?<![\w-])press\b/
      );
      const css = await buildCss(classTokens(row.text));
      expect(css, `${row.rel}:${row.line}`).toMatch(/:active/);
    }
  });

  it("조건식 분기를 한 문자열로 합치지 않는다 (N-2)", () => {
    const scratch = ts.createSourceFile(
      "Branch.tsx",
      `export function Probe({ on }: { on: boolean }) {
  return <button className={on ? "bg-accent-soft" : "press hover:bg-surface-hover"} />;
}
`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const index = resolveIndex(collectDecls(scratch));
    const classes: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node)) {
        classes.push(
          ...attrClasses(jsxAttr(node, ["className"]), index).map((c) =>
            c.replace(/\s+/g, " ").trim()
          )
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(scratch);
    expect(classes).toContain("bg-accent-soft");
    expect(classes.some((c) => /\bpress\b/.test(c))).toBe(true);
    expect(classes.some((c) => /\bpress\b/.test(c) && /bg-accent-soft/.test(c))).toBe(
      false
    );
  });

  it("3짝 표면 목록이 정본과 집합이 같다 (M-2g)", () => {
    const gallery = [
      "button-default",
      "button-secondary",
      "button-ghost",
      "button-destructive",
      "chip",
      "row",
    ] as const;
    const insitu = [
      "message-row",
      "pending-row",
      "settings-row",
      "drafts-li",
    ] as const;
    const skip = new Set([
      "root",
      "row-link",
      "settings-toggle",
      "summary-card",
    ]);
    const galleryFrames = [
      ...new Set(
        [...GALLERY_SRC.matchAll(/data-testid="press-triplet-([^"]+)"/g)].map(
          (m) => m[1]
        )
      ),
    ]
      .filter((id) => !skip.has(id))
      .sort();
    const capturedGallery = stringArrayConst(CAPTURE_SRC, "PRESS_TRIPLET_GALLERY");
    const capturedInsitu = stringArrayConst(CAPTURE_SRC, "PRESS_TRIPLET_INSITU");
    const canonical = [...gallery, ...insitu].sort();
    expect(galleryFrames).toEqual(canonical);
    expect([...capturedGallery].sort()).toEqual([...gallery].sort());
    expect([...capturedInsitu].sort()).toEqual([...insitu].sort());
    expect([...capturedGallery, ...capturedInsitu].sort()).toEqual(canonical);
    expect(capturedGallery).toHaveLength(gallery.length);
    expect(capturedInsitu).toHaveLength(insitu.length);
    for (const surface of canonical) {
      expect(GALLERY_SRC).toContain(`press-triplet-${surface}`);
    }
    expect(GALLERY_SRC).toMatch(/<DraftRow\b/);
    expect(GALLERY_SRC).toMatch(
      /onClick=\{\(event\) => event\.preventDefault\(\)\}/
    );
    expect(CAPTURE_SRC).toMatch(/MOBILE_VIEWPORT/);
    expect(CAPTURE_SRC).toMatch(/suffix: "-390"/);
    expect(CAPTURE_SRC).toMatch(
      /for \(const scheme of \["light", "dark"\]\)/
    );
    expect(CAPTURE_SRC).not.toMatch(
      /if \(scheme === "light"\) \{\s*\n\s*all\.push\(\s*\.\.\.\((?:await shot\(\(\) =>\s*)?capturePressTriplet/
    );
  });

  it("in-situ 목록에서 하나를 빼거나 더하면 집합이 붉다 (M-2g RED)", () => {
    const pin = stringArrayConst(CAPTURE_SRC, "PRESS_TRIPLET_INSITU");
    const dropped = pin.filter((id) => id !== "settings-row");
    const extra = [...pin, "ghost-row"];
    expect(new Set(dropped)).not.toEqual(new Set(pin));
    expect(dropped).not.toHaveLength(pin.length);
    expect(new Set(extra)).not.toEqual(new Set(pin));
    const scratchDrop = CAPTURE_SRC.replace(
      /const PRESS_TRIPLET_INSITU = \[[^\]]*\]/,
      `const PRESS_TRIPLET_INSITU = [\n  "message-row",\n  "pending-row",\n  "drafts-li",\n]`
    );
    expect(stringArrayConst(scratchDrop, "PRESS_TRIPLET_INSITU").sort()).not.toEqual(
      [...pin].sort()
    );
    const scratchAdd = CAPTURE_SRC.replace(
      /const PRESS_TRIPLET_INSITU = \[[^\]]*\]/,
      `const PRESS_TRIPLET_INSITU = [\n  "message-row",\n  "pending-row",\n  "settings-row",\n  "drafts-li",\n  "ghost-row",\n]`
    );
    expect(stringArrayConst(scratchAdd, "PRESS_TRIPLET_INSITU").sort()).not.toEqual(
      [...pin].sort()
    );
  });

  it("초안 행은 링크가 채움과 press 를 같이 진다 (N-1)", () => {
    expect(DRAFTS_SRC).toMatch(
      /<Link[\s\S]*?className="flex w-full[^"]*\bpress hover:bg-surface-hover/
    );
    expect(DRAFTS_SRC).not.toMatch(
      /<li\b[^>]*hover:bg-surface-hover[\s\S]*?<Link/
    );
    expect(DRAFTS_SRC).not.toMatch(
      /<li\b[^>]*\bpress\b[\s\S]*?<Link/
    );
  });

  it("모서리 프로브는 AABB 꼭짓점이 아니라 호 밖 내부를 잰다 (H-1g)", () => {
    expect(CAPTURE_SRC).toMatch(/function cornerInteriorPoints/);
    expect(CAPTURE_SRC).toMatch(/\[2, 2\]/);
    expect(CAPTURE_SRC).toMatch(/\[1, 1\]/);
    expect(CAPTURE_SRC).not.toMatch(
      /sampleRgb\(\s*page,\s*box\.x,\s*box\.y\s*\)/
    );
    expect(SETTINGS_FIELDS_SRC).toMatch(
      /SETTINGS_COLLAPSIBLE_CARD_CLASS =\s*"min-w-0 overflow-hidden rounded-md border border-line"/
    );
  });

  it("캡처는 시작과 중단에 3짝 증거를 지운다 (N-4)", () => {
    expect(CAPTURE_SRC).toMatch(/function wipePressTripletEvidence/);
    expect(CAPTURE_SRC).toMatch(/wipePressTripletEvidence\(\);/);
    expect(CAPTURE_SRC).toMatch(/function recordPressTripletAbort/);
    expect(CAPTURE_SRC).toMatch(/press-triplet-catalog/);
    expect(CAPTURE_SRC).toMatch(/#2057 N-4/);
  });

  it("3짝 픽셀 차는 크기 문턱을 든다 (N-2)", () => {
    expect(CAPTURE_SRC).toMatch(/PIXEL_DE_MIN = 0\.01/);
    expect(CAPTURE_SRC).toMatch(/dE >= PIXEL_DE_MIN/);
  });

  it("토글 행 타깃 프로브는 라벨이 행을 채운다 (H-3)", () => {
    expect(CAPTURE_SRC).toMatch(/function assertToggleRowTarget/);
    expect(CAPTURE_SRC).toMatch(/deadRight > 2/);
    expect(CAPTURE_SRC).toMatch(/tag !== "LABEL"/);
  });

  it("본문 행과 전폭 summary 는 채움만 한다 (N-5)", () => {
    expect(MESSAGE_ROW_SRC).toMatch(/active:bg-surface-pressed/);
    expect(PENDING_ROW_SRC).toMatch(/active:bg-surface-pressed/);
    const article = MESSAGE_ROW_SRC.match(
      /"(group relative flex gap-2 px-4[^"]*)"/
    )?.[1];
    expect(article).not.toMatch(/(?<![\w-])press\b/);
    expect(constString(SETTINGS_FIELDS_SRC, "SETTINGS_COLLAPSIBLE_SUMMARY_CLASS")).not.toMatch(
      /(?<![\w-])press\b/
    );
  });
});

function pressDuration(css: string): string {
  const rules = [
    ...css.matchAll(/\.press\s*\{([^}]*)\}/g),
  ].filter((match) => /transition-duration:/.test(match[1]));
  if (rules.length === 0) return "0s";
  const match = rules[rules.length - 1][1].match(
    /transition-duration:\s*([^;]+)/
  );
  return match ? match[1].trim() : "0s";
}
