// Build/test only: AST extraction, not a runtime dependency of either client.
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {execFileSync} from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../../..');
const LEDGER = join(HERE, 'direct-copy-baseline.json');
const COPY_NAME = /^(?:aria-label|aria-description|aria-valuetext|title|label|text|message|description|subtitle|placeholder|alt|children|accessibilityLabel|accessibilityHint|headerTitle|emptyText|errorMessage|hint|caption|body|buttonText|confirmText|cancelText)$/i;
const TEST_PATH = /(?:^|\/)(?:__tests__|__mocks__|fixtures?|testkit|testing|generated)(?:\/|$)|\.(?:test|spec|stories)\.[cm]?[jt]sx?$|\.d\.ts$/;
const SOURCE = /\.[cm]?[jt]sx?$/;

export function isProductSource(file) {
  return SOURCE.test(file) && !TEST_PATH.test(file);
}

/** Counts literal occurrences, including English: no line numbers or copy text in the ledger. */
export function extractDirectCopy(file, source, knownKeys = []) {
  if (!isProductSource(file)) return {count: 0, unknownKeys: []};
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const keys = new Set(knownKeys);
  const unknownKeys = [];
  let count = 0;
  function ignored(node) {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isTypeNode(p)) return true;
      if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
        const callee = p.expression.getText(sf);
        if (/^(?:console\.|logger\.|log\.|invariant$|assert$)/.test(callee)
          || (ts.isNewExpression(p) && /Error$/.test(callee))) return true;
        // ICU keys and user-supplied values are handled by the dictionary/type contract.
        if (/(?:^|\.)formatMessage$/.test(callee)) return true;
      }
    }
    return false;
  }
  function surfaceContext(node) {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isJsxAttribute(p)) return COPY_NAME.test(p.name.getText(sf));
      if (ts.isJsxExpression(p)) return true;
      if (ts.isPropertyAssignment(p) && COPY_NAME.test(p.name.getText(sf).replace(/['"]/g, ''))) return true;
      if (ts.isVariableDeclaration(p) && COPY_NAME.test(p.name.getText(sf))) return true;
      if (ts.isCallExpression(p) && /(?:^|\.)(?:alert|confirm|prompt|toast|setError|setStatus|announceForAccessibility)$/.test(p.expression.getText(sf))) return true;
    }
    return false;
  }
  function visit(node) {
    if (ts.isCallExpression(node) && /(?:^|\.)formatMessage$/.test(node.expression.getText(sf))) {
      const key = node.arguments[0];
      if (key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) && !keys.has(key.text)) unknownKeys.push(key.text);
    }
    const literal = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node);
    if (literal && !ignored(node)) {
      const p = node.parent;
      const isName = (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)) && p.name === node;
      const text = node.text.trim();
      // Non-copy JSX attributes (className, paths, test IDs, roles, styles) are technical.
      const attr = ts.isJsxAttribute(p) ? p : undefined;
      if (!isName && (!attr || COPY_NAME.test(attr.name.getText(sf))) && text) {
        const korean = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/.test(text);
        const english = /[a-zA-Z]/.test(text) && (ts.isJsxText(node) || surfaceContext(node)
          || /[a-zA-Z][ ,!?]+[a-zA-Z]/.test(text) || /^[a-zA-Z]+[.!?…]?$/.test(text));
        if (korean || english) count++;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return {count, unknownKeys};
}

function filesUnder(root) {
  return readdirSync(root, {withFileTypes: true}).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

export function scanSurface(surface, {root = ROOT, readSource, files} = {}) {
  if (!['web', 'mobile'].includes(surface)) throw new Error(`Unknown surface: ${surface}`);
  const paths = files ?? [
    ...filesUnder(join(root, `clients/${surface}/src`)),
    ...(surface === 'mobile' ? ['App.tsx', 'index.js'].map(file => join(root, 'clients/mobile', file)).filter(existsSync) : []),
  ].map(file => relative(root, file));
  const keys = filesUnder(join(root, 'packages/momo-core/src/i18n/catalogs/en-US'))
    .filter(file => file.endsWith('.json'))
    .flatMap(file => Object.keys(JSON.parse(readFileSync(file, 'utf8'))));
  const counts = {};
  const unknownKeys = [];
  for (const file of paths.filter(isProductSource).sort()) {
    const result = extractDirectCopy(file, readSource ? readSource(file) : readFileSync(join(root, file), 'utf8'), keys);
    if (result.count) counts[file] = result.count;
    unknownKeys.push(...result.unknownKeys.map(key => `${file}: unknown message key ${key}`));
  }
  return {counts, unknownKeys};
}

export function compareCounts(baseline, actual) {
  const increases = [];
  const decreases = [];
  for (const file of [...new Set([...Object.keys(baseline), ...Object.keys(actual)])].sort()) {
    const before = baseline[file] ?? 0;
    const after = actual[file] ?? 0;
    if (after > before) increases.push(`${file}: ${before} → ${after}; use a dictionary key`);
    if (after < before) decreases.push(`${file}: ${before} → ${after}; reduce the committed extraction ledger`);
  }
  return {increases, decreases};
}

export function checkSurface(surface) {
  const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
  const {counts, unknownKeys} = scanSurface(surface);
  const baseline = Object.fromEntries(Object.entries(ledger.files).filter(([file]) => file.startsWith(`clients/${surface}/`)));
  const {increases, decreases} = compareCounts(baseline, counts);
  // Reductions must shrink the allowance too; otherwise a later addition spends stale budget.
  const failures = [...increases, ...decreases, ...unknownKeys];
  if (failures.length) throw new Error(`Direct UI copy guard:\n${failures.join('\n')}`);
  return counts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, arg] = process.argv.slice(2);
  if (action === '--baseline') {
    // Emit only. The caller reviews and writes a smaller ledger; normal checks never update it.
    if (!/^[a-f0-9]{40}$/.test(arg ?? '')) throw new Error('--baseline requires the fixed starting HEAD');
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', arg, 'clients/web/src', 'clients/mobile/src', 'clients/mobile/App.tsx', 'clients/mobile/index.js'], {cwd: ROOT, encoding: 'utf8'}).trim().split('\n');
    const readSource = file => execFileSync('git', ['show', `${arg}:${file}`], {cwd: ROOT, encoding: 'utf8'});
    const counts = {};
    for (const surface of ['web', 'mobile']) {
      Object.assign(counts, scanSurface(surface, {files: files.filter(file => file.startsWith(`clients/${surface}/`)), readSource}).counts);
    }
    process.stdout.write(JSON.stringify({version: 1, baselineHead: arg, files: counts}, null, 2) + '\n');
  } else if (['web', 'mobile'].includes(action)) {
    checkSurface(action);
  } else throw new Error('Use web | mobile | --baseline <starting HEAD>');
}
