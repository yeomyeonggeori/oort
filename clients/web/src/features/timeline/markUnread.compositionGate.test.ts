import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// =============================================================================
// ADR-0178 D3 composition gate (#1934 R2 H-1 / R3 M-7).
//
// Outside the allowlist, a mark field (or an alias that received it) may not
// sit under arithmetic, comparison, Math.min/max, ??, or a non-presence
// ternary. Pass-through is mapping, wire copies, and type-field declarations.
// The scan is statement/scope-aware (TypeScript compiler API), not a line
// window: aliases are tracked across functions in the same file.
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));

function repoRoot(): string {
  let dir = HERE;
  for (let i = 0; i < 12; i++) {
    if (
      existsSync(join(dir, "packages", "momo-core", "src")) &&
      existsSync(join(dir, "clients", "web", "src"))
    ) {
      return dir;
    }
    dir = join(dir, "..");
  }
  throw new Error("repo root not found from composition gate test");
}

const REPO_ROOT = repoRoot();
const CORE_SRC = join(REPO_ROOT, "packages", "momo-core", "src");
const WEB_SRC = join(REPO_ROOT, "clients", "web", "src");

const IDENT_NAMES = new Set([
  "markedUnreadBeforeSeq",
  "marked_unread_before_seq",
  "markUnreadBeforeSeq",
  "mark_unread_before_seq",
]);

const CORE_CALLEES = new Set([
  "effectiveUnreadStartSeq",
  "composedUnreadCount",
  "unreadDividerCursorSeq",
  "freezeOpenedRead",
  "foldInVisitMark",
  "timelineUnreadFromOpened",
  "advertiseReadState",
  "updateReadState",
  "applyReadStateToCache",
  "markedUnreadBeforeSeqFromWire",
]);

const ALLOW_RELATIVE = new Set([
  "features/readState/model.ts",
  "features/readState/model.test.ts",
  "features/readState/proof.ts",
  "lib/api.ts",
  "features/timeline/markUnread.compositionGate.test.ts",
]);

const RELATIONAL = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

const ARITH = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
]);

const EQ = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

type Scope = {
  parent: Scope | undefined;
  decls: Map<string, ts.Node>;
};

function isFunctionLike(
  node: ts.Node
): node is ts.FunctionLikeDeclarationBase & ts.Node {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function skipSubtree(node: ts.Node): boolean {
  return (
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isTypeParameterDeclaration(node) ||
    ts.isImportDeclaration(node) ||
    ts.isImportEqualsDeclaration(node) ||
    ts.isExportDeclaration(node) ||
    (ts.isTypeNode(node) && !ts.isExpression(node))
  );
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (let i = 0; i < 8; i++) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    if (ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    break;
  }
  return current;
}

function isNullish(node: ts.Expression): boolean {
  const inner = unwrap(node);
  return (
    inner.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(inner) && inner.text === "undefined")
  );
}

function isPresenceCompare(node: ts.BinaryExpression): boolean {
  if (!EQ.has(node.operatorToken.kind)) return false;
  if (isNullish(node.left) || isNullish(node.right)) return true;
  return ts.isTypeOfExpression(node.left) || ts.isTypeOfExpression(node.right);
}

function isPresenceCondition(node: ts.Expression): boolean {
  const inner = unwrap(node);
  if (
    ts.isPrefixUnaryExpression(inner) &&
    inner.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return true;
  }
  if (ts.isTypeOfExpression(inner)) return true;
  if (ts.isBinaryExpression(inner)) return isPresenceCompare(inner);
  return false;
}

function isMathMinMax(expr: ts.Expression): boolean {
  const inner = unwrap(expr);
  return (
    ts.isPropertyAccessExpression(inner) &&
    ts.isIdentifier(inner.expression) &&
    inner.expression.text === "Math" &&
    (inner.name.text === "min" || inner.name.text === "max")
  );
}

function calleeName(expr: ts.Expression): string | undefined {
  const inner = unwrap(expr);
  if (ts.isIdentifier(inner)) return inner.text;
  if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.name)) {
    return inner.name.text;
  }
  return undefined;
}

function propNameOf(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function bindingPropName(el: ts.BindingElement): string | undefined {
  if (el.propertyName) return propNameOf(el.propertyName);
  if (ts.isIdentifier(el.name)) return el.name.text;
  return undefined;
}

function bindBinding(name: ts.BindingName, scope: Scope, identOwner: ts.Node) {
  if (ts.isIdentifier(name)) {
    scope.decls.set(name.text, identOwner);
    return;
  }
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) bindBinding(el.name, scope, el);
  }
}

export function scanComposition(
  source: string
): { line: number; text: string }[] {
  const sf = ts.createSourceFile(
    "probe.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const lines = source.split("\n");
  const scopeOf = new Map<ts.Node, Scope>();
  const rootScope: Scope = { parent: undefined, decls: new Map() };
  const fns = new Map<string, ts.SignatureDeclaration>();

  function collectFns(node: ts.Node) {
    if (skipSubtree(node)) return;
    if (ts.isFunctionDeclaration(node) && node.name) {
      fns.set(node.name.text, node);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isFunctionExpression(node.initializer) ||
        ts.isArrowFunction(node.initializer))
    ) {
      fns.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectFns);
  }
  collectFns(sf);

  function bindScopes(node: ts.Node, scope: Scope) {
    scopeOf.set(node, scope);
    if (skipSubtree(node)) return;

    if (isFunctionLike(node)) {
      const inner: Scope = { parent: scope, decls: new Map() };
      for (const param of node.parameters) {
        scopeOf.set(param, inner);
        bindBinding(param.name, inner, param);
        if (param.initializer) bindScopes(param.initializer, inner);
      }
      if (node.body) bindScopes(node.body, inner);
      return;
    }

    if (ts.isBlock(node) || ts.isModuleBlock(node)) {
      const inner: Scope = { parent: scope, decls: new Map() };
      for (const stmt of node.statements) bindScopes(stmt, inner);
      return;
    }

    if (ts.isCatchClause(node)) {
      const inner: Scope = { parent: scope, decls: new Map() };
      if (node.variableDeclaration) {
        bindBinding(
          node.variableDeclaration.name,
          inner,
          node.variableDeclaration
        );
      }
      bindScopes(node.block, inner);
      return;
    }

    if (ts.isVariableDeclaration(node)) {
      bindBinding(node.name, scope, node);
      if (node.initializer) bindScopes(node.initializer, scope);
      return;
    }

    ts.forEachChild(node, (child) => bindScopes(child, scope));
  }
  bindScopes(sf, rootScope);

  function resolveIdent(ident: ts.Identifier): ts.Node | undefined {
    const parent = ident.parent;
    if (
      parent &&
      (ts.isPropertyAccessExpression(parent) ||
        ts.isPropertyAccessChain(parent)) &&
      parent.name === ident
    ) {
      return undefined;
    }
    if (
      parent &&
      ts.isPropertyAssignment(parent) &&
      parent.name === ident
    ) {
      return undefined;
    }
    let scope = scopeOf.get(ident);
    if (!scope) {
      let walk: ts.Node | undefined = ident.parent;
      while (walk && !scope) {
        scope = scopeOf.get(walk);
        walk = walk.parent;
      }
    }
    while (scope) {
      const decl = scope.decls.get(ident.text);
      if (decl) return decl;
      scope = scope.parent;
    }
    return undefined;
  }

  const taintedDecls = new Set<ts.Node>();
  const taintedProps = new Set<string>(IDENT_NAMES);
  const taintedFns = new Set<string>();

  function addFn(name: string): boolean {
    if (taintedFns.has(name)) return false;
    taintedFns.add(name);
    return true;
  }

  function enclosingFnName(node: ts.Node): string | undefined {
    let current: ts.Node | undefined = node;
    while (current) {
      if (ts.isFunctionDeclaration(current) && current.name) {
        return current.name.text;
      }
      if (
        (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) &&
        current.parent &&
        ts.isVariableDeclaration(current.parent) &&
        ts.isIdentifier(current.parent.name)
      ) {
        return current.parent.name.text;
      }
      current = current.parent;
    }
    return undefined;
  }

  function addDecl(node: ts.Node): boolean {
    if (taintedDecls.has(node)) return false;
    taintedDecls.add(node);
    return true;
  }

  function addProp(name: string): boolean {
    if (taintedProps.has(name)) return false;
    taintedProps.add(name);
    return true;
  }

  function taintBinding(name: ts.BindingName, identOwner: ts.Node): boolean {
    if (ts.isIdentifier(name)) return addDecl(identOwner);
    let changed = false;
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) {
        changed = taintBinding(el.name, el) || changed;
      }
    }
    return changed;
  }

  function isTaintedExpr(node: ts.Expression): boolean {
    const inner = unwrap(node);
    if (ts.isIdentifier(inner)) {
      if (IDENT_NAMES.has(inner.text)) return true;
      const decl = resolveIdent(inner);
      return Boolean(decl && taintedDecls.has(decl));
    }
    if (
      ts.isPropertyAccessExpression(inner) ||
      ts.isPropertyAccessChain(inner)
    ) {
      const name = inner.name.text;
      return IDENT_NAMES.has(name) || taintedProps.has(name);
    }
    if (
      ts.isElementAccessExpression(inner) &&
      ts.isStringLiteralLike(inner.argumentExpression)
    ) {
      const name = inner.argumentExpression.text;
      return IDENT_NAMES.has(name) || taintedProps.has(name);
    }
    if (ts.isConditionalExpression(inner)) {
      return (
        isTaintedExpr(inner.whenTrue) || isTaintedExpr(inner.whenFalse)
      );
    }
    if (ts.isCallExpression(inner) || ts.isCallChain(inner)) {
      const name = calleeName(inner.expression);
      if (name && taintedFns.has(name) && !CORE_CALLEES.has(name)) return true;
    }
    return false;
  }

  function propagate(node: ts.Node): boolean {
    let changed = false;
    function visit(n: ts.Node) {
      if (skipSubtree(n)) return;

      if (ts.isVariableDeclaration(n) && n.initializer && isTaintedExpr(n.initializer)) {
        changed = taintBinding(n.name, n) || changed;
      }

      if (ts.isBindingElement(n)) {
        const prop = bindingPropName(n);
        if (prop && (IDENT_NAMES.has(prop) || taintedProps.has(prop))) {
          changed = addDecl(n) || changed;
        }
      }

      if (ts.isParameter(n) && n.initializer && isTaintedExpr(n.initializer)) {
        changed = taintBinding(n.name, n) || changed;
      }

      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isTaintedExpr(n.right)
      ) {
        const left = unwrap(n.left);
        if (ts.isIdentifier(left)) {
          const decl = resolveIdent(left);
          if (decl) changed = addDecl(decl) || changed;
        }
        if (
          ts.isPropertyAccessExpression(left) ||
          ts.isPropertyAccessChain(left)
        ) {
          changed = addProp(left.name.text) || changed;
        }
      }

      if (ts.isPropertyAssignment(n) && isTaintedExpr(n.initializer)) {
        const name = propNameOf(n.name);
        if (name) changed = addProp(name) || changed;
      }

      if (ts.isShorthandPropertyAssignment(n) && isTaintedExpr(n.name)) {
        changed = addProp(n.name.text) || changed;
      }

      if (ts.isReturnStatement(n) && n.expression && isTaintedExpr(n.expression)) {
        const fnName = enclosingFnName(n);
        if (fnName) changed = addFn(fnName) || changed;
      }

      if (
        (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
        n.body &&
        !ts.isBlock(n.body) &&
        isTaintedExpr(n.body)
      ) {
        const fnName = enclosingFnName(n);
        if (fnName) changed = addFn(fnName) || changed;
      }

      if (ts.isCallExpression(n) || ts.isCallChain(n)) {
        const name = calleeName(n.expression);
        if (name && !CORE_CALLEES.has(name) && !isMathMinMax(n.expression)) {
          const fn = fns.get(name);
          if (fn) {
            n.arguments.forEach((arg, i) => {
              const param = fn.parameters[i];
              if (param && isTaintedExpr(arg)) {
                changed = taintBinding(param.name, param) || changed;
              }
            });
          }
        }
      }

      ts.forEachChild(n, visit);
    }
    visit(node);
    return changed;
  }

  for (let i = 0; i < 16; i++) {
    if (!propagate(sf)) break;
  }

  const hits: { line: number; text: string }[] = [];
  const seen = new Set<number>();

  function hit(n: ts.Node) {
    const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf, false));
    if (seen.has(line)) return;
    seen.add(line);
    hits.push({ line: line + 1, text: (lines[line] ?? "").trim() });
  }

  function flag(n: ts.Node) {
    if (skipSubtree(n)) return;

    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (isTaintedExpr(n.left) || isTaintedExpr(n.right)) {
        if (isPresenceCompare(n)) {
          /* presence == null / typeof — not composition */
        } else if (
          op === ts.SyntaxKind.QuestionQuestionToken ||
          RELATIONAL.has(op) ||
          ARITH.has(op)
        ) {
          hit(n);
        }
      }
    }

    if (
      ts.isPrefixUnaryExpression(n) &&
      (n.operator === ts.SyntaxKind.PlusToken ||
        n.operator === ts.SyntaxKind.MinusToken) &&
      isTaintedExpr(n.operand)
    ) {
      hit(n);
    }

    if (ts.isConditionalExpression(n)) {
      if (isTaintedExpr(n.condition) && !isPresenceCondition(n.condition)) {
        hit(n);
      }
    }

    if (
      (ts.isCallExpression(n) || ts.isCallChain(n)) &&
      isMathMinMax(n.expression) &&
      n.arguments.some((arg) => isTaintedExpr(arg))
    ) {
      hit(n);
    }

    ts.forEachChild(n, flag);
  }
  flag(sf);
  return hits;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function compositionHits(
  root: string,
  relPrefix: string
): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = [];
  for (const full of walk(root)) {
    const rel = `${relPrefix}${relative(root, full)}`;
    const allowKey = rel.replace(
      /^(?:packages\/momo-core\/src\/|clients\/web\/src\/)/,
      ""
    );
    if (ALLOW_RELATIVE.has(allowKey)) continue;
    if (/\.test\.tsx?$/.test(full)) continue;
    for (const hit of scanComposition(readFileSync(full, "utf8"))) {
      hits.push({ file: rel, ...hit });
    }
  }
  return hits;
}

const SABOTAGE = {
  direct: `export function s(row: { markedUnreadBeforeSeq: number | null; lastReadSeq: number }) {
  return Math.min(row.markedUnreadBeforeSeq ?? Infinity, row.lastReadSeq + 1);
}`,
  alias: `export function s(row: { markedUnreadBeforeSeq: number | null; lastReadSeq: number }) {
  const mark = row.markedUnreadBeforeSeq;
  const cursorStart = row.lastReadSeq + 1;
  return mark == null ? cursorStart : Math.min(mark, cursorStart);
}`,
  nospace: `export function s(row: { markedUnreadBeforeSeq: number | null; lastReadSeq: number }) {
  return row.markedUnreadBeforeSeq ?? row.lastReadSeq+1;
}`,
  compare: `export function s(row: { markedUnreadBeforeSeq: number | null; lastReadSeq: number }) {
  return row.markedUnreadBeforeSeq !== null && row.markedUnreadBeforeSeq < row.lastReadSeq + 1 ? row.markedUnreadBeforeSeq : row.lastReadSeq + 1;
}`,
  destructure: `export function s(row: { markedUnreadBeforeSeq: number | null; lastReadSeq: number }) {
  const { markedUnreadBeforeSeq, lastReadSeq } = row;
  if (markedUnreadBeforeSeq == null) return lastReadSeq + 1;
  return markedUnreadBeforeSeq < lastReadSeq + 1 ? markedUnreadBeforeSeq : lastReadSeq + 1;
}`,
} as const;

const PASS_THROUGH = {
  mapping: `export function toRow(row: { markedUnreadBeforeSeq: number | null }) {
  return { markedUnreadBeforeSeq: row.markedUnreadBeforeSeq };
}`,
  wire: `export function toWire(incoming: { marked_unread_before_seq: number | null }) {
  return { marked_unread_before_seq: incoming.marked_unread_before_seq };
}`,
  typeField: `export interface ReadState {
  markedUnreadBeforeSeq: number | null;
}`,
} as const;

const ALIAS_FORMS = {
  renameAliasFar: `export function toSnap(row: { markedUnreadBeforeSeq: number | null; lastReadSeq: number }) {
  return {
    markSeq: row.markedUnreadBeforeSeq,
    cursor: row.lastReadSeq,
  };
}

export function start(s: { markSeq: number | null; cursor: number }) {
  return Math.min(s.markSeq ?? Infinity, s.cursor + 1);
}`,
  aliasBeyondWindow: `export function s(row: { markedUnreadBeforeSeq: number | null; lastReadSeq: number }) {
  const mark = row.markedUnreadBeforeSeq;
  const cursor = row.lastReadSeq;
  let out = cursor;
  out = out;
  out = out;
  out = out;
  return mark == null ? out : Math.min(mark, out);
}`,
  helperCall: `function lower(a: number | null, b: number): number { return a == null ? b : Math.min(a, b); }




export function s(row: { markedUnreadBeforeSeq: number | null; lastReadSeq: number }) {
  const next = row.lastReadSeq;
  return lower(row.markedUnreadBeforeSeq, next);
}`,
  destructureRename: `export function s(row: { markedUnreadBeforeSeq: number | null; lastReadSeq: number }) {
  const { markedUnreadBeforeSeq: m, lastReadSeq: c } = row;
  const a = c;
  const b = a;
  const d = b;
  const e = d;
  const f = e;
  return m == null ? f : (m < f ? m : f);
}`,
  returnValueTaint: `function pick(row: { markedUnreadBeforeSeq: number | null }) {
  return row.markedUnreadBeforeSeq;
}
export function s(row: { markedUnreadBeforeSeq: number | null; lastReadSeq: number }) {
  const m = pick(row);
  return Math.min(m ?? Infinity, row.lastReadSeq + 1);
}`,
} as const;

describe("D3 합성은 momo-core 함수 한 곳뿐이다", () => {
  it("core 와 web src 에서 마크 필드 산술/비교가 합성 함수 밖에 없다", () => {
    const hits = [
      ...compositionHits(CORE_SRC, "packages/momo-core/src/"),
      ...compositionHits(WEB_SRC, "clients/web/src/"),
    ];
    expect(hits).toEqual([]);
  });

  it("허용 목록이 실제 파일을 가리킨다", () => {
    expect(statSync(join(CORE_SRC, "features/readState/model.ts")).isFile()).toBe(
      true
    );
    expect(statSync(join(CORE_SRC, "lib/api.ts")).isFile()).toBe(true);
    expect(
      statSync(
        join(WEB_SRC, "features/timeline/markUnread.compositionGate.test.ts")
      ).isFile()
    ).toBe(true);
  });
});

describe("게이트는 사보타주 5형을 잡고 패스스루 3형은 놓아 준다 (H-1)", () => {
  it("주입 5형이 각각 걸린다", () => {
    for (const [name, snippet] of Object.entries(SABOTAGE)) {
      expect(scanComposition(snippet).length, name).toBeGreaterThan(0);
    }
  });

  it("적법한 패스스루 3형은 걸리지 않는다", () => {
    for (const [name, snippet] of Object.entries(PASS_THROUGH)) {
      expect(scanComposition(snippet), name).toEqual([]);
    }
  });
});

describe("게이트는 창 밖 별칭 4형을 잡는다 (M-7)", () => {
  it("rename-alias / 창 밖 별칭 / 헬퍼 / 구조분해 개명 / 반환값 오염이 각각 걸린다", () => {
    for (const [name, snippet] of Object.entries(ALIAS_FORMS)) {
      expect(scanComposition(snippet).length, name).toBeGreaterThan(0);
    }
  });
});
