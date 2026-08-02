#!/usr/bin/env node
// =============================================================================
// The core purity gate (ADR-0137 D3, goal RN-C1).
//
// "코어에 UI·플랫폼 API 금지" is a rule that a human keeps for about one batch.
// This makes it mechanical: `npm run gate:purity` fails the build the moment a
// `window`, a React import, a Vite `import.meta.env` or a reach back into
// `clients/web` appears under packages/momo-core/src.
//
// It parses with the TypeScript compiler rather than grepping, because this
// codebase's comments are long and discuss `window`, `document` and React by
// name constantly — a grep would either drown in false positives or be tuned
// until it stopped catching anything. The AST sees identifiers, not prose.
//
// Deliberately NOT the same mechanism as the eslint rules in eslint.config.js.
// Those are scope-aware and run in the editor; this one runs with no eslint
// config loaded, checks things eslint cannot see (file extensions, the
// package's own dependency list), and is therefore the one a CI job can trust
// on its own.
// =============================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(PKG, "src");

/**
 * Globals that only exist because a browser (or a DOM-shaped test env) is
 * underneath. RN has none of them. `fetch`, `URL`, `AbortController` and the
 * timers are deliberately absent from this list: they are web-standard and RN
 * ships them (URL via `react-native-url-polyfill`, per spike #837 gate 2).
 */
const BANNED_GLOBALS = new Set([
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "navigator",
  "history",
  "location",
  "alert",
  "confirm",
  "prompt",
  "matchMedia",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Element",
  "Node",
  "MutationObserver",
  "IntersectionObserver",
  "ResizeObserver",
  "CustomEvent",
  "Notification",
  "WebSocket",
  "process",
  "require",
  "__dirname",
]);

/** Packages that drag a UI framework, a bundler or a transport in with them. */
const BANNED_IMPORT_PATTERNS = [
  /^react$/,
  /^react\//,
  /^react-dom/,
  /^react-native/,
  /^react-router/,
  /^@react-native/,
  /^@tanstack\//,
  /^@tauri-apps\//,
  /^@radix-ui\//,
  /^@xterm\//,
  /^@shopify\/flash-list/,
  /^@legendapp\//,
  /^centrifuge$/,
  /^livekit-client/,
  /^lucide-react/,
  /^tailwind/,
  /^clsx$/,
  /^class-variance-authority$/,
  /^cmdk$/,
  /^expo/,
];

const failures = [];
function fail(file, line, message) {
  failures.push(`${relative(PKG, file)}:${line}  ${message}`);
}

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

const files = walkFiles(SRC);

// ---- 1. no UI files at all --------------------------------------------------
for (const f of files) {
  if (f.endsWith(".tsx") || f.endsWith(".jsx")) {
    fail(f, 1, "JSX file in the core. Components belong to a host client.");
  } else if (f.endsWith(".css")) {
    fail(f, 1, "stylesheet in the core. Styling belongs to a host client.");
  }
}

// ---- 2. the package declares no runtime dependencies ------------------------
const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
  const names = Object.keys(pkg[field] ?? {});
  if (names.length > 0) {
    failures.push(
      `package.json  ${field} must stay empty; found ${names.join(", ")}. ` +
        "A platform arrives as an injected port (src/runtime/host.ts), not as a dependency."
    );
  }
}

// ---- 3. per-file AST checks -------------------------------------------------
for (const file of files.filter((f) => f.endsWith(".ts"))) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const checkSpecifier = (node, spec) => {
    const line = lineOf(node);
    if (spec.startsWith("@/")) {
      fail(file, line, `"${spec}" — "@/" is the web client's alias. The core cannot import from clients/web.`);
      return;
    }
    if (spec.startsWith(".")) {
      const abs = resolve(dirname(file), spec);
      if (!abs.startsWith(SRC)) {
        fail(file, line, `"${spec}" escapes packages/momo-core/src.`);
      }
      return;
    }
    for (const pattern of BANNED_IMPORT_PATTERNS) {
      if (pattern.test(spec)) {
        fail(file, line, `"${spec}" is a UI/platform/transport package. The core stays free of it.`);
        return;
      }
    }
    if (!spec.startsWith("vitest") && !spec.startsWith("node:")) {
      fail(file, line, `"${spec}" — the core has no runtime dependencies; only relative imports (and vitest in tests) are allowed.`);
    }
  };

  // Names this file declares itself. `quotaModel.ts` really does have a domain
  // concept called a "window" (the rolling quota window) and `connectionAlert`
  // really does call its subject an `alert`; flagging those would train people
  // to ignore this gate, which is the only way it can fail. File-scoped rather
  // than block-scoped on purpose — the precise, block-scoped version of this
  // check is `no-restricted-globals` in eslint.config.js, and the two are meant
  // to be read together.
  const declared = new Set();
  const collect = (node) => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isBindingElement(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeParameterDeclaration(node) ||
        ts.isImportSpecifier(node) ||
        ts.isImportClause(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      declared.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      checkSpecifier(node, node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) checkSpecifier(node, arg.text);
    }
    // `import.meta.env` is Vite-only and does not exist under Metro/Hermes.
    if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression)) {
      fail(file, lineOf(node), "`import.meta` is bundler-specific. Configuration arrives through src/runtime/host.ts.");
    }
    if (ts.isIdentifier(node) && BANNED_GLOBALS.has(node.text) && !declared.has(node.text)) {
      const parent = node.parent;
      const isMemberName = ts.isPropertyAccessExpression(parent) && parent.name === node;
      const isPropertyKey =
        (ts.isPropertyAssignment(parent) ||
          ts.isPropertySignature(parent) ||
          ts.isMethodSignature(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isEnumMember(parent) ||
          ts.isBindingElement(parent) ||
          ts.isPropertyDeclaration(parent)) &&
        parent.name === node;
      const isDeclarationName =
        (ts.isVariableDeclaration(parent) ||
          ts.isParameter(parent) ||
          ts.isFunctionDeclaration(parent) ||
          ts.isTypeParameterDeclaration(parent) ||
          ts.isInterfaceDeclaration(parent) ||
          ts.isTypeAliasDeclaration(parent) ||
          ts.isImportSpecifier(parent)) &&
        parent.name === node;
      if (!isMemberName && !isPropertyKey && !isDeclarationName) {
        fail(
          file,
          lineOf(node),
          `\`${node.text}\` is a platform global. Pass the fact in as a parameter, or read it through src/runtime/host.ts.`
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

if (failures.length > 0) {
  console.error(`\n@momo/core purity gate FAILED (${failures.length}):\n`);
  for (const f of failures) console.error("  " + f);
  console.error(
    "\nWhy this exists: the core is consumed by the web client AND by React Native.\n" +
      "Anything on this list compiles on web and breaks — or silently no-ops — on a phone.\n"
  );
  process.exit(1);
}

console.log(`@momo/core purity gate OK — ${files.length} files, 0 platform/UI escapes.`);
