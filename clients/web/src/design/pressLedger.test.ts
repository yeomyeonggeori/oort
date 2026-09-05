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
 * Population is every JSX/`createElement` site whose **tag** is
 * button/a/Link/NavLink/summary/label[associated checkbox|radio]/input[checkbox|
 * radio|submit|button]/select, whose **role** is button|link|menuitem*|tab|
 * option|checkbox|switch|radio|treeitem, or whose tag is a canonical primitive
 * (`Button`, react-router `Link`/`NavLink` via import, `Command.Item`,
 * `DropdownMenuItem`, `ContextMenuItem`, `TabsTrigger`, plus dotted
 * `*.Item`/`*.Trigger`). Lucide `Link` icons are not the router primitive. Minus
 * disabled/aria-disabled, minus a **base** `cursor-not-allowed`/`cursor-wait`
 * (not `disabled:`/`aria-disabled:` variants), minus text links. No hover/press
 * marker gating. No file-name escapes.
 *
 * "Has press" is the named vocabulary only: `.press`, `scrim-press`,
 * `press-instant-fill` (a `@utility` whose `:active` paints `--surface-pressed`),
 * `active:bg-surface-pressed`, or a `@utility` whose `:active`
 * block uses `--surface-pressed` or `--motion-instant`. An arbitrary
 * `:active { color }` does not count. A named press member must paint.
 *
 * Full-width is a **width**, not a class token: source heuristic (list rows,
 * `w-full`, `summary`, parent-`li` row) plus a capture runtime probe
 * (`getBoundingClientRect().width` ≥ 480px or ≥ 50% of the content column →
 * `transform: none` on `:active`).
 *
 * red proof:
 *   - put `press` on a non-interactive `div`/`li` → forbidden-press is red
 *   - add `press` and `transition-colors` on one element → dual-class is red
 *   - swap `.press` / `.transition-colors` rule order in a scratch CSS → cascade red
 *   - add a hover-only `@utility` in a scratch copy of tokens.css → CSS pin red
 *   - a hover-only local `<button>` → residue red
 *   - repair one text-link residue without lowering CEILING → stale-ceiling red
 *   - selected arm of a ternary without press → INTERACTIVE residue
 *   - checked toggle branch without hover/press → INTERACTIVE residue
 *   - drop the cmdk selected+active compound → compiled CSS red
 *   - put `press` (scale) on a full-width row → B4-3 red
 *   - drop or add a PRESS_TRIPLET_INSITU id without updating the pin → set red
 *   - delete `active:bg-surface-pressed` from ComposerFormatTray's pressed arm → H5-2 red
 *   - add `disabled:cursor-not-allowed` to a live button → still in the population (M5-1)
 *   - `@utility` with `&:active { color: … }` → not counted as press (M5-2)
 *   - `<TabsPrimitive.Trigger className="hover:bg-surface-hover">` → in population (N5-1)
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
const WORK_PANEL_SRC = readFileSync(
  new URL("../features/work/WorkPanel.tsx", import.meta.url),
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
const QUICKSWITCHER_SRC = readFileSync(
  new URL("../app/QuickSwitcher.tsx", import.meta.url),
  "utf8"
);
const DRAFTS_SRC = readFileSync(
  new URL("../features/drafts/DraftsRoute.tsx", import.meta.url),
  "utf8"
);
const AGENT_CARD_SRC = readFileSync(
  new URL("../features/timeline/AgentCard.tsx", import.meta.url),
  "utf8"
);
const ARTIFACT_SRC = readFileSync(
  new URL("../features/timeline/ArtifactCard.tsx", import.meta.url),
  "utf8"
);
const UNFURL_SRC = readFileSync(
  new URL("../features/timeline/UnfurlCards.tsx", import.meta.url),
  "utf8"
);
const FORMAT_TRAY_SRC = readFileSync(
  new URL("../features/chat/ComposerFormatTray.tsx", import.meta.url),
  "utf8"
);

const HOVER_RE = /(?<![\w-])hover:/;
const PRESS_RE = /(?:(?<![\w-])press\b|(?<![\w-])active:)/;
const TRANSITION_COLORS_RE = /(?<![\w-])transition-colors\b/;
const DURATION_LITERAL = /(?<![\w-])duration-\d+\b/;
const SCALE_LITERAL = /(?<![\w-])scale-\d+\b/;

const INTERACTIVE_TAGS = new Set(["button", "a", "summary", "select"]);
const BUTTON_INPUT_TYPES = new Set(["checkbox", "radio", "submit", "button"]);
const CLASS_COMBINERS = new Set(["cn", "clsx", "classNames", "twMerge"]);
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "checkbox",
  "switch",
  "radio",
  "treeitem",
]);
const LIST_ITEM_ROLES = new Set([
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "treeitem",
]);
/**
 * PascalCase / dotted tags that are controls even without a written `role`.
 * Documented next to the population (N5-1). `Link`/`NavLink` enter via the
 * react-router import (`routerLink`), not the tag name — lucide `Link` is an
 * icon. Dotted `*.Item` / `*.Trigger` (cmdk, Radix) join this list by suffix
 * so dropping `role="option"` cannot empty that slice.
 */
const CANONICAL_PRIMITIVES = new Set([
  "Button",
  "Command.Item",
  "DropdownMenuItem",
  "ContextMenuItem",
  "TabsTrigger",
  "DropdownMenuRadioItem",
  "ContextMenuRadioItem",
]);
const CANONICAL_PRIMITIVE_SUFFIXES = new Set(["Item", "Trigger"]);
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
  htmlFor?: string;
  inputType?: string;
  disabled?: boolean;
  parentTag?: string;
  labelIsControl?: boolean;
  routerLink?: boolean;
}

interface ExpandCtx {
  strings: Map<string, string>;
  fns: Map<string, { node: ts.Node; ctx: ExpandCtx }>;
}

function ctxFromStrings(strings: Map<string, string>): ExpandCtx {
  return { strings, fns: new Map() };
}

function hasHover(text: string): boolean {
  return HOVER_RE.test(text);
}

function hasPress(text: string): boolean {
  return PRESS_RE.test(text);
}

function isNativeHtmlTag(tag: string): boolean {
  return tag === tag.toLowerCase();
}

function isAnchorLike(tag: string, routerLink = false): boolean {
  if (routerLink) return true;
  const t = tag.toLowerCase();
  return t === "a" || t === "button" || tag === "Link" || tag === "NavLink";
}

function restTextColor(text: string): string | null {
  const matches = [
    ...text.matchAll(
      /(?:^|\s)text-(ink(?:-muted)?|accent|agent|warn|ok|danger)(?=\s|$)/g
    ),
  ];
  return matches.length > 0 ? matches[matches.length - 1][1] : null;
}

function hoverTextColor(text: string): string | null {
  const match = text.match(
    /(?<![\w-])hover:text-(ink(?:-muted)?|accent|agent|warn|ok|danger)(?=\s|$)/
  );
  return match ? match[1] : null;
}

/**
 * Canonical §2.6 D5: a text link is an `<a>`/`<button>`/`Link`/`NavLink`
 * whose rendering is text only — underline or `hover:text-`, with no
 * background fill and no border/rounded box. Any `border*` class is a box.
 * Padding alone (a touch target) does not make a box.
 * `hover:text-X` whose X equals the rest `text-*` colour is not feedback (H6-2).
 */
export function isTextLink(tag: string, text: string, routerLink = false): boolean {
  if (!isAnchorLike(tag, routerLink)) return false;
  const underline = /\bunderline\b/.test(text);
  const hoverText = /(?<![\w-])hover:text-/.test(text);
  if (!underline && !hoverText) return false;
  if (/(?<![\w-])(?:hover:)?bg-/.test(text)) return false;
  if (/(?<![\w-])hover:(?:opacity-|border-)/.test(text)) return false;
  if (/(?<![\w-])border(?:-|\s|$)/.test(text)) return false;
  const hover = hoverTextColor(text);
  const rest = restTextColor(text);
  if (hover && rest && hover === rest) return false;
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

function isCanonicalPrimitive(tag: string): boolean {
  if (CANONICAL_PRIMITIVES.has(tag)) return true;
  const dotted = tag.includes(".");
  const last = dotted ? tag.slice(tag.lastIndexOf(".") + 1) : tag;
  return dotted && CANONICAL_PRIMITIVE_SUFFIXES.has(last);
}

function isInteractiveElement(
  s: Pick<
    PressSite,
    "tag" | "role" | "inputType" | "labelIsControl" | "routerLink"
  >
): boolean {
  const role = (s.role ?? "").toLowerCase();
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  if (s.routerLink) return true;
  if (isCanonicalPrimitive(s.tag)) return true;
  if (!isNativeHtmlTag(s.tag)) return false;
  if (INTERACTIVE_TAGS.has(s.tag)) return true;
  if (s.tag === "input") {
    return BUTTON_INPUT_TYPES.has((s.inputType ?? "").toLowerCase());
  }
  if (s.tag === "label") return Boolean(s.labelIsControl);
  return false;
}

function isVisuallyHidden(text: string): boolean {
  return /(?<![\w-])sr-only\b/.test(text);
}

function isNativeUaWidget(s: PressSite): boolean {
  if (!isNativeHtmlTag(s.tag)) return false;
  if (hasHover(s.text)) return false;
  if (s.tag === "select") return true;
  if (s.tag === "input") {
    return BUTTON_INPUT_TYPES.has((s.inputType ?? "").toLowerCase());
  }
  return false;
}

function isControl(tag: string, role: string, _text = ""): boolean {
  return isInteractiveElement({ tag, role, inputType: "", labelIsControl: false });
}

function hasPressScaleClass(text: string): boolean {
  return text.split(/\s+/).includes("press");
}

function hasFillPress(text: string): boolean {
  return (
    /(?<![\w-])active:bg-surface-pressed/.test(text) ||
    /(?<![\w-])press-instant-fill\b/.test(text)
  );
}

function isCenteredCta(text: string): boolean {
  return /(?<![\w-])max-w-sm\b/.test(text) && /(?<![\w-])h-control/.test(text);
}

function isGridCell(text: string): boolean {
  return /(?<![\w-])aspect-square\b/.test(text);
}

function isCompactChip(text: string): boolean {
  if (/(?<![\w-])w-full\b/.test(text)) return false;
  if (
    /(?<![\w-])(?:size-control(?:-sm)?|size-6|h-control(?:-sm|-lg)?)\b/.test(
      text
    )
  ) {
    return true;
  }
  return (
    /(?<![\w-])(?:py-px|py-1)\b/.test(text) &&
    /(?<![\w-])px-[23]\b/.test(text) &&
    !/(?<![\w-])py-[23]\b/.test(text)
  );
}

export function isFullWidthRow(s: PressSite): boolean {
  if (isTextLink(s.tag, s.text, s.routerLink)) return false;
  if (!isInteractiveElement(s)) return false;
  if (isCenteredCta(s.text) || isGridCell(s.text)) return false;
  if (isCompactChip(s.text)) return false;
  if (/(?<![\w-])shrink-0\b/.test(s.text)) return false;
  if (LIST_ITEM_ROLES.has((s.role ?? "").toLowerCase())) return true;
  if (/(?<![\w-])w-full\b/.test(s.text)) return true;
  if (s.tag === "summary") return true;
  const t = s.tag;
  const rowTag =
    t === "a" ||
    t === "button" ||
    t === "summary" ||
    t === "label" ||
    Boolean(s.routerLink);
  // FeedRow-shaped: an anchor that is the list row. It fills the column by
  // layout (the `li` is a flex column) without `w-full` / `flex-1`.
  if (s.parentTag === "li" && (t === "a" || Boolean(s.routerLink))) {
    return true;
  }
  return (
    s.parentTag === "li" &&
    rowTag &&
    /(?<![\w-])flex-1\b/.test(s.text)
  );
}

function isFnNode(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isBlock(node)
  );
}

function isClassInitializer(node: ts.Node): boolean {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return true;
  }
  if (ts.isTemplateExpression(node)) return true;
  if (ts.isIdentifier(node)) return true;
  if (ts.isPropertyAccessExpression(node)) return isClassInitializer(node.name);
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return isClassInitializer(node.expression);
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    return isClassInitializer(node.left) && isClassInitializer(node.right);
  }
  if (ts.isConditionalExpression(node)) {
    return (
      isClassInitializer(node.whenTrue) && isClassInitializer(node.whenFalse)
    );
  }
  if (ts.isCallExpression(node)) {
    const callee = calleeName(node.expression);
    return Boolean(callee && CLASS_COMBINERS.has(callee));
  }
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
    const callee = calleeName(node.expression);
    if (callee && CLASS_COMBINERS.has(callee)) {
      return node.arguments.map((arg) => collect(arg, index)).join(" ");
    }
    const parts = node.arguments.map((arg) => collect(arg, index));
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
function expandClass(node: ts.Node, ctx: ExpandCtx): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [node.text];
  }
  if (ts.isTemplateExpression(node)) {
    let acc = [node.head.text];
    for (const span of node.templateSpans) {
      const mids = expandClass(span.expression, ctx);
      acc = acc.flatMap((a) => mids.map((m) => a + m + span.literal.text));
    }
    return acc;
  }
  if (ts.isIdentifier(node)) {
    if (node.text === "PRESS_CLASS") return [PRESS_CLASS];
    const fn = ctx.fns.get(node.text);
    if (fn) return expandClass(fn.node, fn.ctx);
    return [ctx.strings.get(node.text) ?? ""];
  }
  if (ts.isPropertyAccessExpression(node)) {
    return expandClass(node.name, ctx);
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return expandClass(node.expression, ctx);
  }
  if (ts.isConditionalExpression(node)) {
    return [
      ...expandClass(node.whenTrue, ctx),
      ...expandClass(node.whenFalse, ctx),
    ];
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      return expandClass(node.right, ctx);
    }
    if (op === ts.SyntaxKind.BarBarToken) {
      return [
        ...expandClass(node.left, ctx),
        ...expandClass(node.right, ctx),
      ];
    }
    return cartesianJoin([
      expandClass(node.left, ctx),
      expandClass(node.right, ctx),
    ]);
  }
  if (ts.isCallExpression(node)) {
    const callee = calleeName(node.expression);
    if (callee && CLASS_COMBINERS.has(callee)) {
      return cartesianJoin(
        node.arguments.map((arg) => expandClass(arg, ctx))
      );
    }
    if (callee && ctx.fns.has(callee)) {
      const fn = ctx.fns.get(callee)!;
      return expandClass(fn.node, fn.ctx);
    }
    return [ctx.strings.get(callee ?? "") ?? ""];
  }
  if (ts.isObjectLiteralExpression(node)) {
    return cartesianJoin(
      node.properties.map((prop) => {
        if (ts.isPropertyAssignment(prop)) {
          return expandClass(prop.initializer, ctx);
        }
        if (ts.isShorthandPropertyAssignment(prop)) {
          return [ctx.strings.get(prop.name.text) ?? ""];
        }
        if (ts.isSpreadAssignment(prop)) {
          return expandClass(prop.expression, ctx);
        }
        return [""];
      })
    );
  }
  if (ts.isArrayLiteralExpression(node)) {
    return cartesianJoin(node.elements.map((el) => expandClass(el, ctx)));
  }
  if (ts.isJsxExpression(node) && node.expression) {
    return expandClass(node.expression, ctx);
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return expandClass(node.body, ctx);
  }
  if (ts.isBlock(node)) {
    const returns: ts.ReturnStatement[] = [];
    const visit = (n: ts.Node) => {
      if (
        ts.isArrowFunction(n) ||
        ts.isFunctionExpression(n) ||
        ts.isFunctionDeclaration(n) ||
        ts.isMethodDeclaration(n)
      ) {
        return;
      }
      if (ts.isReturnStatement(n)) {
        returns.push(n);
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    if (returns.length === 0) return [collect(node, ctx.strings)];
    return returns.flatMap((stmt) => expandClass(stmt, ctx));
  }
  if (ts.isReturnStatement(node) && node.expression) {
    return expandClass(node.expression, ctx);
  }
  return [collect(node, ctx.strings)];
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

function resolveStrings(decls: Decl[]): Map<string, string> {
  const index = new Map<string, string>([["PRESS_CLASS", PRESS_CLASS]]);
  for (let pass = 0; pass < 6; pass += 1) {
    for (const decl of decls) {
      if (isFnNode(decl.node)) continue;
      if (!isClassInitializer(decl.node)) continue;
      index.set(decl.name, collect(decl.node, index));
    }
  }
  return index;
}

function buildExpandCtx(sf: ts.SourceFile): ExpandCtx {
  const decls = collectDecls(sf);
  const ctx: ExpandCtx = {
    strings: resolveStrings(decls),
    fns: new Map(),
  };
  for (const decl of decls) {
    if (!isFnNode(decl.node)) continue;
    if (CLASS_COMBINERS.has(decl.name)) continue;
    ctx.fns.set(decl.name, { node: decl.node, ctx });
  }
  return ctx;
}

function jsxTagName(tag: ts.JsxTagNameExpression): string {
  if (ts.isIdentifier(tag)) return tag.text;
  if (ts.isPropertyAccessExpression(tag)) {
    const left = ts.isIdentifier(tag.expression)
      ? tag.expression.text
      : ts.isPropertyAccessExpression(tag.expression) ||
          ts.isJsxNamespacedName(tag.expression as ts.Node)
        ? jsxTagName(tag.expression as ts.JsxTagNameExpression)
        : "";
    return left ? `${left}.${tag.name.text}` : tag.name.text;
  }
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
  ctx: ExpandCtx
): string[] {
  if (!attr?.initializer) return [""];
  if (ts.isStringLiteral(attr.initializer)) return [attr.initializer.text];
  if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
    return expandClass(attr.initializer.expression, ctx);
  }
  return [""];
}

function attrText(
  attr: ts.JsxAttribute | undefined,
  ctx: ExpandCtx
): string {
  return attrClasses(attr, ctx).join(" ").replace(/\s+/g, " ").trim();
}

function attrExprText(attr: ts.JsxAttribute | undefined): string {
  if (!attr?.initializer) return "";
  if (ts.isStringLiteral(attr.initializer)) return attr.initializer.text;
  if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
    const ex = attr.initializer.expression;
    if (ts.isStringLiteral(ex) || ts.isNoSubstitutionTemplateLiteral(ex)) {
      return ex.text;
    }
    return ex.getText();
  }
  return "";
}

function attrIsLiteralTrue(attr: ts.JsxAttribute | undefined): boolean {
  if (!attr) return false;
  if (!attr.initializer) return true;
  if (ts.isStringLiteral(attr.initializer)) return attr.initializer.text === "true";
  if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
    return attr.initializer.expression.kind === ts.SyntaxKind.TrueKeyword;
  }
  return false;
}

function jsxContainsBinaryInput(opening: ts.JsxOpeningLikeElement): boolean {
  const parent = opening.parent;
  if (!parent || !ts.isJsxElement(parent)) return false;
  const walk = (n: ts.Node): boolean => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      if (jsxTagName(n.tagName).toLowerCase() === "input") {
        const type = attrExprText(jsxAttr(n, ["type"])).toLowerCase();
        if (type === "checkbox" || type === "radio") return true;
      }
    }
    return Boolean(ts.forEachChild(n, walk));
  };
  return parent.children.some((child) => walk(child));
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
  ctx: ExpandCtx;
  pressTags: Set<string>;
  fillTags: Set<string>;
  routerTags: Set<string>;
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
  ctx: ExpandCtx
): string {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = ts.isIdentifier(prop.name)
      ? prop.name.text
      : ts.isStringLiteral(prop.name)
        ? prop.name.text
        : "";
    if (key === name) return collect(prop.initializer, ctx.strings);
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

function cssUtilitiesWithNamedPress(source: string): Set<string> {
  const names = new Set<string>();
  const re = /@utility\s+([a-z0-9-]+)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const body = braceBody(source, match.index + match[0].length - 1);
    const stripped = body.replace(/\/\*[\s\S]*?\*\//g, "");
    const activeRe = /:active[^{]*\{/g;
    let am: RegExpExecArray | null;
    let named = false;
    while ((am = activeRe.exec(stripped))) {
      const block = braceBody(stripped, am.index + am[0].length - 1);
      if (
        /--surface-pressed/.test(block) ||
        /var\(--motion-instant\)/.test(block) ||
        /var\(--motion-instant\)/.test(stripped)
      ) {
        // Opacity/transform on the press ladder counts when the utility's
        // :active block is the named step (scrim-press) or the fill token.
        if (
          /--surface-pressed/.test(block) ||
          (/opacity\s*:/.test(block) && /var\(--motion-instant\)/.test(stripped))
        ) {
          named = true;
        }
      }
    }
    if (named) names.add(match[1]);
  }
  return names;
}

const UTILITIES_WITH_NAMED_PRESS = cssUtilitiesWithNamedPress(TOKENS_CSS);

function hasNamedUtilityPress(text: string): boolean {
  return text.split(/\s+/).some((tok) => UTILITIES_WITH_NAMED_PRESS.has(tok));
}

const NAMED_PRESS_TOKEN = /(?:^|\s)(?:press|scrim-press)(?:\s|$)/;
const NAMED_PRESS_FILL = /active:bg-surface-pressed/;

function siteHasPress(s: PressSite): boolean {
  if (NAMED_PRESS_TOKEN.test(` ${s.text} `)) return true;
  if (NAMED_PRESS_FILL.test(` ${s.text} `)) return true;
  if (hasNamedUtilityPress(s.text)) return true;
  if (isNativeUaWidget(s)) return true;
  return false;
}

function parseImportedSf(resolved: string): ts.SourceFile {
  return ts.createSourceFile(
    resolved,
    readFileSync(resolved, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    resolved.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

function buildFileIndex(file: string, sf: ts.SourceFile): FileIndex {
  const ctx = buildExpandCtx(sf);
  const pressTags = new Set<string>();
  const fillTags = new Set<string>();
  const routerTags = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) {
      continue;
    }
    const spec = stmt.moduleSpecifier.text;
    const bindings = stmt.importClause?.namedBindings;
    if (/ui\/button$/.test(spec) && bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        const imported = (el.propertyName ?? el.name).text;
        if (imported === "Button") pressTags.add(el.name.text);
      }
    }
    if (
      (/ui\/dropdown-menu$/.test(spec) || /ui\/context-menu$/.test(spec)) &&
      bindings &&
      ts.isNamedImports(bindings)
    ) {
      for (const el of bindings.elements) {
        const imported = (el.propertyName ?? el.name).text;
        if (
          imported === "DropdownMenuItem" ||
          imported === "DropdownMenuRadioItem" ||
          imported === "ContextMenuItem" ||
          imported === "ContextMenuRadioItem"
        ) {
          fillTags.add(el.name.text);
        }
      }
    }
    if (
      /react-router-dom$/.test(spec) &&
      bindings &&
      ts.isNamedImports(bindings)
    ) {
      for (const el of bindings.elements) {
        const imported = (el.propertyName ?? el.name).text;
        if (imported === "Link" || imported === "NavLink") {
          routerTags.add(el.name.text);
        }
      }
    }
    const resolved = resolveModule(file, spec);
    if (!resolved) continue;
    const importedSf = parseImportedSf(resolved);
    const importedCtx = buildExpandCtx(importedSf);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        const imported = (el.propertyName ?? el.name).text;
        const local = el.name.text;
        if (importedCtx.strings.has(imported)) {
          ctx.strings.set(local, importedCtx.strings.get(imported)!);
        }
        const fn = importedCtx.fns.get(imported);
        if (
          fn &&
          !CLASS_COMBINERS.has(imported) &&
          !CLASS_COMBINERS.has(local)
        ) {
          ctx.fns.set(local, fn);
        }
      }
    }
  }
  return { ctx, pressTags, fillTags, routerTags };
}

function visitJsxAttrs(
  el: ts.JsxOpeningLikeElement,
  hostTag: string,
  visit: (node: ts.Node, parentTag: string, parentAsChild: boolean) => void
): void {
  for (const attr of el.attributes.properties) {
    if (ts.isJsxSpreadAttribute(attr)) {
      visit(attr.expression, hostTag, false);
      continue;
    }
    if (!ts.isJsxAttribute(attr) || !attr.initializer) continue;
    if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
      visit(attr.initializer.expression, hostTag, false);
    }
  }
}

function discover(): PressSite[] {
  const sites: PressSite[] = [];
  for (const file of SOURCE_FILES) {
    const src = readFileSync(file, "utf8");
    const rel = `clients/web/src/${relative(WEB_SRC, file)}`;
    const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
    const { ctx, pressTags, fillTags, routerTags } = buildFileIndex(file, sf);
    const binaryIds = new Set<string>();
    const collectIds = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (jsxTagName(node.tagName) === "input") {
          const type = attrExprText(jsxAttr(node, ["type"])).toLowerCase();
          if (type === "checkbox" || type === "radio") {
            const id = attrExprText(jsxAttr(node, ["id"]));
            if (id) binaryIds.add(id);
          }
        }
      }
      ts.forEachChild(node, collectIds);
    };
    collectIds(sf);

    const emitJsx = (
      node: ts.JsxOpeningLikeElement,
      parentTag: string,
      parentAsChild: boolean
    ) => {
      const tag = jsxTagName(node.tagName);
      const role = attrText(jsxAttr(node, ["role"]), ctx);
      const htmlFor = attrExprText(jsxAttr(node, ["htmlFor"]));
      const inputType = attrExprText(jsxAttr(node, ["type"]));
      const disabled =
        attrIsLiteralTrue(jsxAttr(node, ["disabled"])) ||
        attrIsLiteralTrue(jsxAttr(node, ["aria-disabled"]));
      const containsBinary =
        tag === "label" && jsxContainsBinaryInput(node);
      const labelIsControl =
        tag === "label" &&
        (containsBinary || (htmlFor !== "" && binaryIds.has(htmlFor)));
      const classes = attrClasses(jsxAttr(node, ["className", "class"]), ctx);
      const unique = [...new Set(classes.map((c) => c.replace(/\s+/g, " ").trim()))];
      for (const raw of unique.length > 0 ? unique : [""]) {
        let text = raw;
        if (pressTags.has(tag)) text = `${text} ${PRESS_CLASS}`;
        if (fillTags.has(tag)) text = `${text} press-instant-fill`;
        if (parentAsChild && pressTags.has(parentTag)) {
          text = `${text} ${PRESS_CLASS}`;
        }
        if (parentAsChild && fillTags.has(parentTag)) {
          text = `${text} press-instant-fill`;
        }
        sites.push({
          rel,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          tag,
          role,
          text: text.replace(/\s+/g, " ").trim(),
          kind: "jsx",
          htmlFor,
          inputType,
          disabled,
          parentTag,
          labelIsControl,
          routerLink: routerTags.has(tag),
        });
      }
    };

    const visit = (node: ts.Node, parentTag: string, parentAsChild: boolean) => {
      if (ts.isJsxElement(node)) {
        const tag = jsxTagName(node.openingElement.tagName);
        const asChild = attrIsLiteralTrue(
          jsxAttr(node.openingElement, ["asChild"])
        );
        emitJsx(node.openingElement, parentTag, parentAsChild);
        visitJsxAttrs(node.openingElement, tag, visit);
        for (const child of node.children) visit(child, tag, asChild);
        return;
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        emitJsx(node, parentTag, parentAsChild);
        visitJsxAttrs(node, jsxTagName(node.tagName), visit);
        return;
      }
      if (
        ts.isCallExpression(node) &&
        isCreateElement(node.expression) &&
        node.arguments.length >= 2
      ) {
        const tagArg = node.arguments[0];
        const propsArg = node.arguments[1];
        const tag = ts.isStringLiteral(tagArg)
          ? tagArg.text
          : ts.isIdentifier(tagArg)
            ? tagArg.text
            : "";
        let texts: string[] = [""];
        let role = "";
        let inputType = "";
        let disabled = false;
        let htmlFor = "";
        if (ts.isObjectLiteralExpression(propsArg)) {
          const classAttr =
            objectPropNode(propsArg, "className") || objectPropNode(propsArg, "class");
          texts = classAttr ? expandClass(classAttr, ctx) : [""];
          role = objectProp(propsArg, "role", ctx);
          inputType = objectProp(propsArg, "type", ctx);
          htmlFor = objectProp(propsArg, "htmlFor", ctx);
          const disabledNode = objectPropNode(propsArg, "disabled");
          disabled =
            Boolean(
              disabledNode && disabledNode.kind === ts.SyntaxKind.TrueKeyword
            );
        }
        const unique = [...new Set(texts.map((c) => c.replace(/\s+/g, " ").trim()))];
        for (const raw of unique.length > 0 ? unique : [""]) {
          let text = raw;
          if (pressTags.has(tag)) text = `${text} ${PRESS_CLASS}`;
          if (fillTags.has(tag)) text = `${text} press-instant-fill`;
          sites.push({
            rel,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            tag,
            role,
            text: text.replace(/\s+/g, " ").trim(),
            kind: "createElement",
            htmlFor,
            inputType,
            disabled,
            parentTag: "",
            labelIsControl:
              tag === "label" && htmlFor !== "" && binaryIds.has(htmlFor),
            routerLink: routerTags.has(tag),
          });
        }
      }
      ts.forEachChild(node, (child) => visit(child, parentTag, parentAsChild));
    };
    visit(sf, "", false);
  }
  return sites;
}

function isInertPointer(text: string): boolean {
  return text.split(/\s+/).some((tok) => tok === "cursor-not-allowed" || tok === "cursor-wait");
}

function isPointerInteractive(s: PressSite): boolean {
  if (s.disabled) return false;
  if (isVisuallyHidden(s.text)) return false;
  if (isInertPointer(s.text)) return false;
  if (isPressForbidden(s.tag, s.role, s.text)) return false;
  return isInteractiveElement(s);
}

const SITES = discover();
const POPULATION = SITES.filter(isPointerInteractive);
const MISSING_PRESS = POPULATION.filter((s) => !siteHasPress(s));
const HOVER_ONLY = MISSING_PRESS;
const TEXT_LINKS = MISSING_PRESS.filter((s) =>
  isTextLink(s.tag, s.text, s.routerLink)
);
const INTERACTIVE = MISSING_PRESS.filter(
  (s) => !isTextLink(s.tag, s.text, s.routerLink)
);
if (process.env.PRESS_LEDGER_CENSUS === "1") {
  console.log(
    `PRESS_LEDGER N0=${POPULATION.length} N1=${MISSING_PRESS.length} interactive=${INTERACTIVE.length}`
  );
  console.log(JSON.stringify(countedByFile(TEXT_LINKS)));
}
const FORBIDDEN_PRESS = SITES.filter(
  (s) => isPressForbidden(s.tag, s.role, s.text) && /(?<![\w-])press\b/.test(s.text)
);
const DUAL_TRANSITION = SITES.filter(
  (s) => /(?<![\w-])press\b/.test(s.text) && TRANSITION_COLORS_RE.test(s.text)
);

/**
 * Remaining press-missing **text links** after the UX-R1e R6 tag/role
 * population (canonical primitives + nested returns + base-only inert).
 * Interactive elements without named press/fill (or native UA press)
 * are hard-zero. Pin shrinks only.
 *
 * Bare underlined links (padding/rounded/touch-target without a painted fill
 * or any `border*` class) are text, not boxes. `Link`/`NavLink` from
 * react-router-dom count with `<a>`/`<button>`.
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

function classBranchesInFunctionOnTag(
  source: string,
  fileName: string,
  fnName: string,
  tag: string
): string[] {
  const sf = sourceFile(source, fileName);
  const ctx = buildExpandCtx(sf);
  const fn = collectDecls(sf).find((d) => d.name === fnName);
  if (!fn) throw new Error(`${fnName} 이 없다`);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (jsxTagName(node.tagName) === tag) {
        out.push(...attrClasses(jsxAttr(node, ["className", "class"]), ctx));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.node);
  return uniqueClasses(out);
}

function classBranchesOfFunction(
  source: string,
  fileName: string,
  fnName: string
): string[] {
  const sf = sourceFile(source, fileName);
  const ctx = buildExpandCtx(sf);
  const fn = ctx.fns.get(fnName);
  if (!fn) throw new Error(`${fnName} 이 없다`);
  return uniqueClasses(expandClass(fn.node, fn.ctx));
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
    expect(channel.every((s) => isTextLink(s.tag, s.text, s.routerLink))).toBe(
      true
    );
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

  it("정본 프리미티브와 dotted 태그는 인구에 들고 그 외 PascalCase 는 안 든다 (N5-1)", () => {
    expect(
      isInteractiveElement({
        tag: "Button",
        role: "",
        inputType: "",
        labelIsControl: false,
      })
    ).toBe(true);
    expect(
      isInteractiveElement({
        tag: "Command.Item",
        role: "",
        inputType: "",
        labelIsControl: false,
      })
    ).toBe(true);
    expect(
      isInteractiveElement({
        tag: "TabsPrimitive.Trigger",
        role: "",
        inputType: "",
        labelIsControl: false,
      })
    ).toBe(true);
    expect(
      isInteractiveElement({
        tag: "Widget",
        role: "",
        inputType: "",
        labelIsControl: false,
      })
    ).toBe(false);
    expect(
      isInteractiveElement({
        tag: "button",
        role: "",
        inputType: "",
        labelIsControl: false,
      })
    ).toBe(true);
    const scratch = ts.createSourceFile(
      "SabotageTabs.tsx",
      `import * as TabsPrimitive from "@radix-ui/react-tabs";
export function Probe() {
  return <TabsPrimitive.Trigger className="hover:bg-surface-hover" />;
}
`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const ctx = buildExpandCtx(scratch);
    const sites: PressSite[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const tag = jsxTagName(node.tagName);
        const text = attrText(jsxAttr(node, ["className", "class"]), ctx);
        sites.push({
          rel: "SabotageTabs.tsx",
          line: 1,
          tag,
          role: "",
          text,
          kind: "jsx",
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(scratch);
    expect(sites.map((s) => s.tag)).toEqual(["TabsPrimitive.Trigger"]);
    expect(isPointerInteractive(sites[0])).toBe(true);
    expect(siteHasPress(sites[0])).toBe(false);
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
        const text = attrText(
          jsxAttr(node, ["className", "class"]),
          ctxFromStrings(new Map())
        );
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
        const role = attrText(jsxAttr(node, ["role"]), ctxFromStrings(new Map()));
        const text = attrText(
          jsxAttr(node, ["className", "class"]),
          ctxFromStrings(new Map())
        );
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
          text = objectProp(propsArg, "className", ctxFromStrings(new Map()));
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
    expect(row).not.toMatch(/(?<![\w-])press\b/);
    expect(row).toMatch(/active:bg-surface-pressed/);
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
    expect(last).toMatch(/background-color/);
    expect(last).not.toMatch(/scale\(/);
    expect(css).toMatch(/\.press-instant-fill[\s\S]*?transform:\s*none/);
    expect(css).toMatch(/\.press-instant-fill[\s\S]*?var\(--surface-pressed\)/);
  });

  it("SidebarRow 전폭 행은 채움만 하고 변형이 없다 (B4-3)", async () => {
    const rowClass = constString(SIDEBAR_ROW_SRC, "rowClass");
    const inactiveClass = constString(SIDEBAR_ROW_SRC, "inactiveClass");
    const activeClass = constString(SIDEBAR_ROW_SRC, "activeClass");
    expect(rowClass).not.toMatch(/(?:^|\s)press(?:\s|$)/);
    expect(inactiveClass).toMatch(/active:bg-surface-pressed/);
    expect(activeClass).toMatch(/bg-accent-soft/);
    expect(activeClass).toMatch(/active:bg-surface-pressed/);
    expect(activeClass).not.toMatch(/hover:bg-surface-hover/);
    const css = await buildCss(
      classTokens(`${inactiveClass} ${activeClass} active:bg-surface-pressed`)
    );
    expect(css).toMatch(/var\(--surface-pressed\)/);
    expect(`${rowClass} ${inactiveClass} ${activeClass}`).not.toMatch(
      /(?:^|\s)press(?:\s|$)/
    );
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

  it("모든 분기는 press 또는 채움 눌림을 진다 (B4-1)", () => {
    expect(
      INTERACTIVE.map((s) => `${s.rel}:${s.line} <${s.tag}> ${s.text}`),
      "interactive without press"
    ).toEqual([]);
    for (const s of POPULATION) {
      if (isTextLink(s.tag, s.text, s.routerLink)) continue;
      expect(siteHasPress(s), `${s.rel}:${s.line} <${s.tag}>`).toBe(true);
    }
  });

  it("선택 분기에서 press 를 빼면 전수가 그 분기를 센다 (B4-1 RED)", () => {
    const site: PressSite = {
      rel: "clients/web/src/features/agentHub/AgentHubRoute.tsx",
      line: 216,
      tag: "button",
      role: "",
      text: "flex w-full items-start gap-3 px-4 py-3 text-left focus-visible:focus-ring bg-accent-soft",
      kind: "jsx",
    };
    expect(isPointerInteractive(site)).toBe(true);
    expect(hasPress(site.text)).toBe(false);
    expect(isTextLink(site.tag, site.text)).toBe(false);
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
    expect(rowClass).toMatch(
      /checked\s*\?\s*"bg-accent-soft active:bg-surface-pressed"/
    );
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
      text: "flex min-w-0 cursor-pointer items-start gap-3 border-b border-line p-3 last:border-b-0 bg-accent-soft",
      kind: "jsx",
      labelIsControl: true,
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
    expect(
      isTextLink("a", "underline border-2 hover:text-ink")
    ).toBe(false);
    expect(isTextLink("a", "underline border hover:text-ink")).toBe(false);
    expect(isTextLink("Link", "underline hover:text-ink")).toBe(true);
    expect(
      isTextLink(
        "a",
        "break-all text-body text-ink underline decoration-line-strong underline-offset-2 hover:text-ink focus-visible:focus-ring"
      )
    ).toBe(false);
    expect(
      isTextLink(
        "a",
        "break-all text-body text-ink-muted underline decoration-line-strong underline-offset-2 hover:text-ink focus-visible:focus-ring"
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
    const ctx = buildExpandCtx(scratch);
    const classes: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node)) {
        classes.push(
          ...attrClasses(jsxAttr(node, ["className"]), ctx).map((c) =>
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
      "settings-row-checked",
      "drafts-li",
    ] as const;
    const skip = new Set([
      "root",
      "row-link",
      "settings-toggle",
      "settings-toggle-checked",
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
      `const PRESS_TRIPLET_INSITU = [\n  "message-row",\n  "pending-row",\n  "settings-row",\n  "drafts-li",\n]`
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

  it("초안 행은 채움만 지고 변형이 없다 (B4-3)", () => {
    expect(DRAFTS_SRC).toMatch(
      /<Link[\s\S]*?className="flex w-full[^"]*hover:bg-surface-hover active:bg-surface-pressed/
    );
    expect(DRAFTS_SRC).not.toMatch(
      /<Link[\s\S]*?className="flex w-full[^"]*(?:^|\s)press(?:\s|$)/
    );
    expect(DRAFTS_SRC).not.toMatch(
      /<li\b[^>]*hover:bg-surface-hover[\s\S]*?<Link/
    );
    const drafts = POPULATION.filter((s) => s.rel.endsWith("DraftsRoute.tsx"));
    const row = drafts.find((s) => /flex w-full gap-3/.test(s.text));
    expect(row).toBeTruthy();
    expect(isFullWidthRow(row!)).toBe(true);
    expect(hasPressScaleClass(row!.text)).toBe(false);
    expect(hasFillPress(row!.text)).toBe(true);
  });

  it("초안 행에 press 를 되돌리면 전폭 가드가 붉다 (B4-3 RED)", () => {
    const site: PressSite = {
      rel: "clients/web/src/features/drafts/DraftsRoute.tsx",
      line: 121,
      tag: "Link",
      role: "",
      text: "flex w-full gap-3 py-2 pl-4 pr-8 press hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:focus-ring",
      kind: "jsx",
      parentTag: "li",
      routerLink: true,
    };
    expect(isFullWidthRow(site)).toBe(true);
    expect(hasPressScaleClass(site.text)).toBe(true);
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

  it("캡처는 시작에 3짝을 지우고 완료된 세트는 이후 중단에 남긴다 (N4-5)", () => {
    expect(CAPTURE_SRC).toMatch(/function wipePressTripletEvidence/);
    expect(CAPTURE_SRC).toMatch(/wipePressTripletEvidence\(\);/);
    expect(CAPTURE_SRC).toMatch(/function commitPressTripletCatalog/);
    expect(CAPTURE_SRC).toMatch(/pressTripletCatalogCommitted/);
    expect(CAPTURE_SRC).toMatch(/abort-after-triplet/);
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

  it("전폭 행은 채움만 있고 press 스케일이 없다 (B4-3)", () => {
    const rows = POPULATION.filter(isFullWidthRow);
    expect(rows.length).toBeGreaterThan(0);
    for (const s of rows) {
      expect(
        hasPressScaleClass(s.text),
        `${s.rel}:${s.line} <${s.tag}> ${s.text}`
      ).toBe(false);
      if (isNativeUaWidget(s)) continue;
      if (!isTextLink(s.tag, s.text, s.routerLink)) {
        expect(hasFillPress(s.text), `${s.rel}:${s.line} ${s.text}`).toBe(true);
      }
    }
  });

  it("선택 채움은 hover 에 유지되고 눌림 채움이 이긴다 (B4-4)", () => {
    for (const s of POPULATION) {
      if (!/(?<![\w-])bg-accent-soft/.test(s.text)) continue;
      if (isTextLink(s.tag, s.text, s.routerLink)) continue;
      if (!isFullWidthRow(s) && hasPressScaleClass(s.text)) continue;
      expect(
        s.text,
        `${s.rel}:${s.line} <${s.tag}> ${s.text}`
      ).not.toMatch(/(?<![\w-])hover:bg-surface-hover/);
      expect(s.text, `${s.rel}:${s.line}`).toMatch(
        /(?<![\w-])active:bg-surface-pressed/
      );
    }
  });

  it("cmdk 선택+active 합성은 selected 채움보다 이긴다 (B4-2)", async () => {
    const itemClass = constString(QUICKSWITCHER_SRC, "itemClass");
    expect(itemClass).toMatch(/data-\[selected=true\]:bg-accent-soft/);
    expect(itemClass).toMatch(
      /data-\[selected=true\]:active:bg-surface-pressed/
    );
    expect(itemClass).not.toMatch(/(?:^|\s)press(?:\s|$)/);
    const css = await buildCss(classTokens(itemClass));
    expect(css).toMatch(/\[data-selected=.true.\]:active/);
    expect(css).toMatch(/var\(--surface-pressed\)/);
    expect(css).toMatch(/var\(--accent-soft\)/);
    const stripped = itemClass.replace(
      /data-\[selected=true\]:active:bg-surface-pressed\s*/,
      ""
    );
    const strippedCss = await buildCss(classTokens(stripped));
    expect(strippedCss).not.toMatch(/\[data-selected=.true.\]:active/);
  });

  it("카드 열을 가로지르는 summary 와 unfurl 은 채움만 한다 (H5-1)", () => {
    const summaries = POPULATION.filter(
      (s) =>
        (s.rel.endsWith("AgentCard.tsx") || s.rel.endsWith("ArtifactCard.tsx")) &&
        s.tag === "summary" &&
        !isCompactChip(s.text)
    );
    expect(summaries.length).toBeGreaterThanOrEqual(3);
    for (const s of summaries) {
      expect(isFullWidthRow(s), `${s.rel}:${s.line}`).toBe(true);
      expect(hasPressScaleClass(s.text), `${s.rel}:${s.line} ${s.text}`).toBe(false);
      expect(hasFillPress(s.text), `${s.rel}:${s.line}`).toBe(true);
    }
    const unfurl = POPULATION.find(
      (s) =>
        s.rel.endsWith("UnfurlCards.tsx") &&
        /flex w-full min-w-0 flex-1/.test(s.text)
    );
    expect(unfurl).toBeTruthy();
    expect(isFullWidthRow(unfurl!)).toBe(true);
    expect(hasPressScaleClass(unfurl!.text)).toBe(false);
    expect(hasFillPress(unfurl!.text)).toBe(true);
    expect(AGENT_CARD_SRC).not.toMatch(
      /<summary className="[^"]*\bpress\b/
    );
    expect(ARTIFACT_SRC).not.toMatch(
      /cursor-pointer px-3 py-2[^"]*\bpress\b/
    );
  });

  it("638px 카드에 press 를 되돌리면 전폭 가드가 붉다 (H5-1 RED)", () => {
    const site: PressSite = {
      rel: "clients/web/src/features/timeline/AgentCard.tsx",
      line: 163,
      tag: "summary",
      role: "",
      text: "cursor-pointer px-3 py-2 text-meta text-ink-muted press hover:bg-surface-hover focus-visible:focus-ring",
      kind: "jsx",
    };
    expect(isFullWidthRow(site)).toBe(true);
    expect(hasPressScaleClass(site.text)).toBe(true);
    expect(UNFURL_SRC).toMatch(/hover:bg-surface-hover active:bg-surface-pressed/);
  });

  it("캡처 레인은 넓은 컨트롤의 :active transform 을 잰다 (H5-1)", () => {
    expect(CAPTURE_SRC).toMatch(/function assertWideRowsFillOnly/);
    expect(CAPTURE_SRC).toMatch(/getBoundingClientRect\(\)\.width/);
    expect(CAPTURE_SRC).toMatch(/WIDE_MIN_PX = 480/);
    expect(CAPTURE_SRC).toMatch(/WIDE_MIN_FRAC = 0\.5/);
    expect(CAPTURE_SRC).toMatch(/CSS\.forcePseudoState|forcedPseudoClasses/);
    expect(CAPTURE_SRC).toMatch(/transform === "none"/);
    expect(CAPTURE_SRC).toMatch(/visited=\$\{visited\}/);
    expect(CAPTURE_SRC).toMatch(/assertWideRowsFillOnly\([^,]+, `inbox /);
    expect(CAPTURE_SRC).toMatch(/assertWideRowsFillOnly\([^,]+, `activity /);
    expect(CAPTURE_SRC).toMatch(/assertWideRowsFillOnly\([^,]+, `connect /);
    expect(CAPTURE_SRC).toMatch(/assertWideRowsFillOnly\([^,]+, `thread /);
    expect(CAPTURE_SRC).toMatch(/assertWideRowsFillOnly\([^,]+, `drafts /);
    expect(CAPTURE_SRC).toMatch(/assertWideRowsFillOnly\([^,]+, `search /);
    expect(CAPTURE_SRC).toMatch(/assertWideRowsFillOnly\([^,]+, `agent hub /);
    expect(CAPTURE_SRC).toMatch(/assertWideRowsFillOnly\(settingsSweep/);
  });

  it("FeedRow 는 전폭 행이고 press 스케일이 없다 (M6-1)", () => {
    const rows = POPULATION.filter(
      (s) => s.rel.endsWith("FeedRow.tsx") && Boolean(s.routerLink)
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const s of rows) {
      expect(isFullWidthRow(s), `${s.rel}:${s.line} ${s.text}`).toBe(true);
      expect(hasPressScaleClass(s.text), `${s.rel}:${s.line}`).toBe(false);
      expect(hasFillPress(s.text), `${s.rel}:${s.line}`).toBe(true);
    }
  });

  it("FeedRow 에 press 를 되돌리면 전폭 가드가 붉다 (M6-1 RED)", () => {
    const site: PressSite = {
      rel: "clients/web/src/features/inbox/FeedRow.tsx",
      line: 76,
      tag: "Link",
      role: "",
      text: "flex gap-3 px-4 py-2 press hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring",
      kind: "jsx",
      parentTag: "li",
      routerLink: true,
    };
    expect(isFullWidthRow(site)).toBe(true);
    expect(hasPressScaleClass(site.text)).toBe(true);
  });

  it("early return 분기도 전수가 센다 (H5-2)", () => {
    const branches = classBranchesOfFunction(
      FORMAT_TRAY_SRC,
      "ComposerFormatTray.tsx",
      "formatItemClass"
    );
    expect(branches.length).toBeGreaterThanOrEqual(3);
    const pressed = branches.filter((c) => /bg-accent-soft/.test(c));
    expect(pressed.length).toBeGreaterThan(0);
    expect(
      pressed.every((c) => /active:bg-surface-pressed/.test(c)),
      pressed.join(" | ")
    ).toBe(true);
    const formatButtons = POPULATION.filter((s) =>
      s.rel.endsWith("ComposerFormatTray.tsx")
    );
    expect(formatButtons.length).toBeGreaterThanOrEqual(3);
  });

  it("early return 의 눌림 팔을 빼면 붉다 (H5-2 RED)", () => {
    const sabotaged = FORMAT_TRAY_SRC.replace(
      `"bg-accent-soft text-ink active:bg-surface-pressed"`,
      `"bg-accent-soft text-ink"`
    );
    const branches = classBranchesOfFunction(
      sabotaged,
      "ComposerFormatTray.tsx",
      "formatItemClass"
    );
    const pressed = branches.filter(
      (c) => /bg-accent-soft/.test(c) && !/active:bg-surface-pressed/.test(c)
    );
    expect(pressed.length).toBeGreaterThan(0);
    expect(
      pressed.every((c) => hasFillPress(c)),
      pressed.join(" | ")
    ).toBe(false);
  });

  it("disabled: 변이의 cursor 는 산 컨트롤을 인구에서 빼지 않는다 (M5-1)", () => {
    const live: PressSite = {
      rel: "sabotage.tsx",
      line: 1,
      tag: "button",
      role: "",
      text: "hover:bg-surface-hover disabled:cursor-not-allowed",
      kind: "jsx",
    };
    expect(isInertPointer(live.text)).toBe(false);
    expect(isPointerInteractive(live)).toBe(true);
    const base: PressSite = {
      ...live,
      text: "cursor-not-allowed hover:bg-surface-hover",
    };
    expect(isInertPointer(base.text)).toBe(true);
    expect(isPointerInteractive(base)).toBe(false);
    const marketplace = POPULATION.filter((s) =>
      s.rel.endsWith("PluginSection.tsx") && /\bplugin-marketplace-row\b/.test(s.text)
    );
    expect(marketplace.length).toBeGreaterThan(0);
  });

  it("이름 없는 :active 유틸은 눌림이 아니다 (M5-2)", () => {
    const scratch = `${TOKENS_CSS}\n@utility sabotage-color-active {\n  &:hover { background-color: var(--surface-hover); }\n  &:active { color: var(--ink); }\n}\n`;
    expect(cssUtilitiesWithNamedPress(scratch).has("sabotage-color-active")).toBe(
      false
    );
    expect(cssUtilitiesWithNamedPress(TOKENS_CSS).has("scrim-press")).toBe(true);
    expect(cssUtilitiesWithNamedPress(TOKENS_CSS).has("plugin-marketplace-row")).toBe(
      true
    );
    expect(cssUtilitiesWithNamedPress(TOKENS_CSS).has("press-instant-fill")).toBe(
      true
    );
    expect(cssUtilitiesWithNamedPress(TOKENS_CSS).has("sidebar-scrim")).toBe(false);
    const unnamed: PressSite = {
      rel: "sabotage.tsx",
      line: 1,
      tag: "button",
      role: "",
      text: "sabotage-color-active hover:bg-surface-hover",
      kind: "jsx",
    };
    expect(siteHasPress(unnamed)).toBe(false);
  });

  it("스크림은 이름 있는 scrim-press 를 든다 (M5-2)", () => {
    expect(GALLERY_SRC).toMatch(/"scrim-press"/);
    expect(TOKENS_CSS).toMatch(/@utility scrim-press/);
    expect(CAPTURE_SRC).toMatch(/assertNotificationsDndRest|notification-rules-dnd/);
  });

  it("캡처는 같은 파일을 두 번 쓰지 않고 알림 샷은 가드된 장면만 쓴다 (H6-1)", () => {
    expect(CAPTURE_SRC).toMatch(/function claimShotPath/);
    expect(CAPTURE_SRC).toMatch(/duplicate shot writer/);
    expect(CAPTURE_SRC).toMatch(/function wrapBrowserShotGuard/);
    expect(CAPTURE_SRC).toMatch(/wrapBrowserShotGuard\(await chromium\.launch/);
    const sweep = CAPTURE_SRC.match(
      /for \(const \[section, heading, name\] of \[([\s\S]*?)\]\)/
    )?.[1];
    expect(sweep, "settings sweep list").toBeTruthy();
    expect(sweep).not.toMatch(/\["notifications"/);
    const notificationsWrites = [
      ...CAPTURE_SRC.matchAll(
        /\$\{OUT_DIR\}\/settings-notifications-\$\{scheme\}\.png/g
      ),
    ];
    expect(notificationsWrites.length).toBe(1);
    expect(CAPTURE_SRC).toMatch(/DND row rest pixels/);
    const sabotaged = CAPTURE_SRC.replace(
      /\/\/ notifications is owned by the parked-pointer scene above \(H6-1\)\.\n    \/\/ Listing it here overwrote that file with an unguarded hover fill\.\n/,
      `["notifications", "알림 규칙", "notifications"],\n    `
    );
    const sabotagedSweep = sabotaged.match(
      /for \(const \[section, heading, name\] of \[([\s\S]*?)\]\)/
    )?.[1];
    expect(sabotagedSweep).toMatch(/\["notifications"/);
  });

  it("같은 경로를 두 번 claim 하면 붉다 (H6-1 RED)", () => {
    const claimed = new Set<string>();
    const claim = (path: string) => {
      if (claimed.has(path)) {
        throw new Error(`duplicate shot writer: ${path} already written in this run`);
      }
      claimed.add(path);
    };
    claim("/tmp/settings-notifications-light.png");
    expect(() => claim("/tmp/settings-notifications-light.png")).toThrow(
      /duplicate shot writer/
    );
  });

  it("플러그인 상세 링크는 muted→ink 이고 rest=hover 는 텍스트 링크가 아니다 (H6-2)", () => {
    expect(PLUGIN_SRC).toMatch(
      /break-all text-body text-ink-muted underline decoration-line-strong underline-offset-2 hover:text-ink focus-visible:focus-ring/
    );
    expect(PLUGIN_SRC).not.toMatch(
      /break-all text-body text-ink underline decoration-line-strong underline-offset-2 hover:text-ink focus-visible:focus-ring/
    );
    const restInk: PressSite = {
      rel: "clients/web/src/features/plugins/PluginSection.tsx",
      line: 924,
      tag: "a",
      role: "",
      text: "break-all text-body text-ink underline decoration-line-strong underline-offset-2 hover:text-ink focus-visible:focus-ring",
      kind: "jsx",
    };
    expect(isTextLink(restInk.tag, restInk.text)).toBe(false);
    expect(siteHasPress(restInk)).toBe(false);
    expect(isPointerInteractive(restInk)).toBe(true);
  });

  it("press-instant-fill 은 채움을 칠하고 이름만으로는 부족하다 (M6-2)", () => {
    expect(cssUtilitiesWithNamedPress(TOKENS_CSS).has("press-instant-fill")).toBe(
      true
    );
    expect(TOKENS_CSS).toMatch(
      /@utility press-instant-fill[\s\S]*?&:active[\s\S]*?--surface-pressed/
    );
    const stripped = TOKENS_CSS.replace(
      /@utility press-instant-fill \{[\s\S]*?\n\}/,
      `@utility press-instant-fill {\n  &:active { transform: none; }\n}\n`
    );
    expect(cssUtilitiesWithNamedPress(stripped).has("press-instant-fill")).toBe(
      false
    );
    const bare: PressSite = {
      rel: "sabotage.tsx",
      line: 1,
      tag: "button",
      role: "",
      text: "press-instant-fill hover:bg-surface-hover",
      kind: "jsx",
    };
    expect(siteHasPress(bare)).toBe(true);
    const unnamed = { ...bare, text: "hover:bg-surface-hover" };
    expect(siteHasPress(unnamed)).toBe(false);
    expect(GALLERY_SRC).toMatch(/data-testid="press-instant-fill-swatch"/);
    expect(GALLERY_SRC).toMatch(
      /hover:bg-surface-hover press-instant-fill/
    );
    expect(CAPTURE_SRC).toMatch(/function assertInstantFillSwatch/);
  });

  it("갤러리 눌림 어휘는 tokens.css 파생 집합을 포함한다 (N6-1)", () => {
    const gallery = new Set(stringArrayConst(GALLERY_SRC, "MOTION_VOCABULARY"));
    const derived = cssUtilitiesWithNamedPress(TOKENS_CSS);
    const missing = [...derived].filter((name) => !gallery.has(name)).sort();
    expect(missing, `gallery missing press utilities: ${missing.join(",")}`).toEqual(
      []
    );
    expect(gallery.has("plugin-marketplace-row")).toBe(true);
    const dropped = GALLERY_SRC.replace(/"plugin-marketplace-row",\n/, "");
    const droppedSet = new Set(stringArrayConst(dropped, "MOTION_VOCABULARY"));
    expect(
      [...derived].filter((name) => !droppedSet.has(name))
    ).toContain("plugin-marketplace-row");
  });
});
