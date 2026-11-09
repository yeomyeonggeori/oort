// Build/test only: AST extraction and the direct-copy ratchet (#4834, redesigned by #5589).
// Never a runtime dependency of the core or either client.
//
// The ledger (`direct-copy-baseline.json`, version 2) only goes down:
//   - `anchor` is a frozen count per file taken at `anchorHead`. Its sha256 is pinned below
//     (`ANCHOR_SEAL`), so a tool that rewrites the anchor turns every check RED.
//   - `lowered` holds the files that went down since the anchor (written by `shrink`/`land`).
//   - `raises` are explicit, one-file entries with an issue number and a reason. They are the
//     only way a count may go up.
// Allowed count = (lowered ?? anchor) + raises, and the scan must equal it exactly: higher means
// new hardcoded copy (use a dictionary key, or add a raise), lower means a stale allowance (run
// `shrink`). A whole-ledger regeneration — the old landing step that rewrote `{version: 1, files}`
// — has no place in this format and fails the check.
import {existsSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../../..');
export const LEDGER_PATH = 'packages/momo-core/src/i18n/tooling/direct-copy-baseline.json';
export const LEDGER_VERSION = 2;
/**
 * sha256 of the canonical frozen anchor (`anchorHead` + `anchor`). Tools never write the anchor.
 * Re-anchoring is a planner act: `anchor <commit>` prints a new ledger and seal, and this
 * constant changes in a reviewed diff. Nothing else may change it.
 */
export const ANCHOR_SEAL = '2de8389cf02f1f6dec527b0d338e1875a7b8d168cfd0617bb7c8757a77bf3e08';
export const DIMENSIONS = Object.freeze(['ko', 'en', 'cat']);

/**
 * Every surface counts Korean anywhere and English only where it is copy (#5589 fix round 1: the
 * clients' old #4834 "any one-word literal" rule counted class names and state words — ~90% noise
 * that a strict ratchet turned into landing stops). The core excludes only the dictionary itself
 * (catalogs, generated code, this tooling) and the language self-names.
 */
export const SURFACES = Object.freeze({
  core: {
    roots: ['packages/momo-core/src'], files: [],
    exclude: /^packages\/momo-core\/src\/i18n\/(?:catalogs\/|generated\/|tooling\/|autonyms\.ts$)/,
  },
  web: {roots: ['clients/web/src'], files: []},
  mobile: {roots: ['clients/mobile/src'], files: ['clients/mobile/App.tsx', 'clients/mobile/index.js']},
});

// Names that carry copy: exact (case-insensitive) or a camelCase copy suffix (`actionLabel`, `emptyHeadline`).
const COPY_EXACT = /^(?:aria-label|aria-description|aria-valuetext|aria-roledescription|aria-placeholder|title|label|text|message|description|subtitle|placeholder|alt|children|content|accessibilityLabel|accessibilityHint|accessibilityValue|headerTitle|emptyText|errorMessage|hint|caption|body|buttonText|confirmText|cancelText|headline|heading|detail|details|summary|tooltip|legend|lead|note|eyebrow|question|prompt|subject|term)$/i;
const COPY_SUFFIX = /[a-z0-9](?:Label|Text|Title|Message|Description|Hint|Placeholder|Caption|Heading|Headline|Detail|Details|Tooltip|Copy|Summary|Note|Prompt|Legend|Question)$/;
export const isCopyName = name => COPY_EXACT.test(name) || COPY_SUFFIX.test(name);
// JSX attributes whose value is never shown as text, however it is computed (`cn(…)`, `a ? … : …`,
// templates). Korean in any *other* attribute counts (#5589); `name` is not here because components
// show it (`SettingsToggleRow name="…"`), and English in it is not copy anyway (not a copy name).
const TECH_ATTRIBUTE = /^(?:className|class|style|testID|nativeID|id|key|ref|href|src|srcSet|rel|target|role|type|htmlFor|form|method|action|accept|pattern|autoComplete|autoCapitalize|inputMode|enterKeyHint|lang|dir|d|viewBox|fill|stroke|points|transform|xmlns|data-[\w-]+|aria-(?:labelledby|describedby|controls|owns|activedescendant|keyshortcuts|haspopup|live|current|relevant|autocomplete|orientation|sort|errormessage|details))$/;
const TEST_PATH = /(?:^|\/)(?:__tests__|__mocks__|fixtures?|testkit|testing|generated)(?:\/|$)|\.(?:test|spec|stories)\.[cm]?[jt]sx?$|\.d\.ts$/;
const SOURCE = /\.[cm]?[jt]sx?$/;
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const DIAGNOSTIC_CALL = /^(?:console\.|logger\.|log\.|invariant$|assert$)/;
const FORMAT_CALL = /(?:^|\.)formatMessage$/;
// `useBlockedReason("changeIt")`의 인자는 사전 틀 이름(타입이 존재를 지킨다)이지 문구가 아니다(#5260).
const FRAME_CALL = /(?:^|\.)(?:useBlockedReason|useBlockedStale)$/;
// `setStatus` is not here: every literal handed to it is a state name (`setStatus("loading")`).
const SURFACE_CALL = /(?:^|\.)(?:alert|confirm|prompt|toast|setError|announceForAccessibility)$/;
// A raise reason must say why this copy cannot use a dictionary key yet, not that a tool ran.
const REGENERATION_REASON = /re-?generat|re-?baselin|(?:refresh|rebuil[dt]|recount|re-?scan)\w*\s+(?:the\s+)?ledger|ledger\s+(?:refresh|rebuil|recount)|다시\s*(?:만들|셈|센다|센\s|세어|세기|생성)|재생성|재계산|장부\s*(?:다시|새로|갱신)|자동\s*갱신/i;

export function isProductSource(file) {
  return SOURCE.test(file) && !TEST_PATH.test(file);
}

export function surfaceOf(file) {
  for (const [surface, spec] of Object.entries(SURFACES)) {
    if (spec.exclude?.test(file)) continue;
    if (spec.files.includes(file) || spec.roots.some(root => file.startsWith(`${root}/`))) return surface;
  }
  return undefined;
}

const unwrap = node => {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
    || ts.isSatisfiesExpression?.(node)) node = node.expression;
  return node;
};

// Expressions that pass a literal's value on unchanged in kind: the JSX attribute above them decides
// what the literal is (`className={cn("flex", open && "hidden")}` is a class list, not copy). An object
// property is not one of them — its own name decides (`action={{label: "…"}}` is copy).
const forwardsValue = (node, child) => ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
  || ts.isNonNullExpression(node) || ts.isSatisfiesExpression?.(node) || ts.isTypeAssertionExpression?.(node)
  || ts.isConditionalExpression(node) || ts.isBinaryExpression(node) || ts.isTemplateExpression(node)
  || ts.isTemplateSpan(node) || ts.isTaggedTemplateExpression(node) || ts.isArrayLiteralExpression(node)
  || ts.isSpreadElement(node) || ts.isElementAccessExpression(node)
  || ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.expression !== child)
  || (ts.isJsxExpression(node) && ts.isJsxAttribute(node.parent));
// A literal compared against a value is never shown (`kind === "dm" ? … : …`, `"id" in row`).
const COMPARISON = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.InKeyword,
  ts.SyntaxKind.InstanceOfKeyword,
]);

/**
 * Counts direct copy in one file, without line numbers or copy text:
 * `ko` Hangul literals, `en` English copy, `cat` sentences assembled from dictionary output.
 */
export function extractDirectCopy(file, source, knownKeys = []) {
  const result = {ko: 0, en: 0, cat: 0, unknownKeys: []};
  if (!isProductSource(file)) return result;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const keys = new Set(knownKeys);
  const calleeOf = node => node.expression.getText(sf);
  const isFormatCall = node => ts.isCallExpression(node) && FORMAT_CALL.test(calleeOf(node));
  /**
   * `skip` — never copy (imports, types, console/logger/log calls, a message key or frame name);
   * `korean` — only Korean counts: an Error message (diagnostics are English, so Korean in one is
   * shown to someone) and the values handed to a message (`formatMessage(k, {label: "…"})`);
   * undefined — the ordinary rules. `forCat` keeps the #4834 rule for concatenations: an Error
   * constructor is still a diagnostic there.
   */
  function exemption(node, {forCat = false} = {}) {
    let mode;
    for (let child = node, p = node.parent; p; child = p, p = p.parent) {
      if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isTypeNode(p)) return 'skip';
      if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression !== child) {
        const callee = calleeOf(p);
        if (DIAGNOSTIC_CALL.test(callee)) return 'skip';
        if (ts.isNewExpression(p) && /Error$/.test(callee)) {
          if (forCat) return 'skip';
          mode ??= 'korean';
        }
        if (!forCat && (FORMAT_CALL.test(callee) || FRAME_CALL.test(callee))) {
          if (child === p.arguments?.[0]) return 'skip';
          mode ??= 'korean';
        }
      }
    }
    return mode;
  }
  /** The JSX attribute that receives this literal through value-forwarding expressions, if any. */
  function enclosingAttribute(node) {
    for (let child = node, p = node.parent; p; child = p, p = p.parent) {
      if (ts.isJsxAttribute(p)) return p.name.getText(sf);
      if (!forwardsValue(p, child)) return undefined;
    }
    return undefined;
  }
  /** Whether an English literal is copy: the nearest thing that names its role decides. */
  function surfaceContext(node) {
    for (let child = node, p = node.parent; p; child = p, p = p.parent) {
      if (ts.isBinaryExpression(p) && COMPARISON.has(p.operatorToken.kind)) return false;
      if (ts.isCaseClause(p) && p.expression === child) return false;
      if (ts.isElementAccessExpression(p) && p.argumentExpression === child) return false;
      if (ts.isJsxAttribute(p)) return isCopyName(p.name.getText(sf));
      // A JSX child is shown; an attribute's `{…}` is judged by the attribute's name above it.
      if (ts.isJsxExpression(p) && !ts.isJsxAttribute(p.parent)) return true;
      // `{title: "Settings"}` is copy; `textAlign: "center"` inside a style named `title` is not.
      if (ts.isPropertyAssignment(p) && p.initializer === child) return isCopyName(p.name.getText(sf).replace(/['"]/g, ''));
      if (ts.isVariableDeclaration(p) && p.initializer === child) return isCopyName(p.name.getText(sf));
      if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression !== child) {
        if (SURFACE_CALL.test(calleeOf(p))) return true;
        // An argument is whatever the callee's parameter is (`failureMessage("list", error)`,
        // `toLocaleString("ko-KR")`); a callback's result still flows on (`useMemo(() => "…")`).
        if (!ts.isArrowFunction(child) && !ts.isFunctionExpression(child)) return false;
      }
      if (ts.isTaggedTemplateExpression(p)) return false;
    }
    return false;
  }
  function concatenates(node) {
    if (ts.isTemplateExpression(node)) {
      const calls = node.templateSpans.filter(span => isFormatCall(unwrap(span.expression))).length;
      const text = node.head.text + node.templateSpans.map(span => span.literal.text).join('');
      return calls > 0 && (node.templateSpans.length > 1 || /\S/.test(text));
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return isFormatCall(unwrap(node.left)) || isFormatCall(unwrap(node.right));
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'join') {
      const target = unwrap(node.expression.expression);
      return ts.isArrayLiteralExpression(target) && target.elements.some(element => isFormatCall(unwrap(element)));
    }
    return false;
  }
  function visit(node) {
    if (isFormatCall(node)) {
      const key = node.arguments[0];
      if (key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) && !keys.has(key.text)) result.unknownKeys.push(key.text);
    }
    // Dictionary output is a whole sentence: joining pieces (or adding text to one) breaks word order in other languages.
    if (concatenates(node) && exemption(node, {forCat: true}) !== 'skip') result.cat++;
    const literal = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node);
    const exempt = literal ? exemption(node) : 'skip';
    if (exempt !== 'skip') {
      const p = node.parent;
      const isName = (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)) && p.name === node;
      const text = node.text.trim();
      const attribute = ts.isJsxText(node) ? undefined : enclosingAttribute(node);
      if (!isName && text && !(attribute && TECH_ATTRIBUTE.test(attribute))) {
        if (HANGUL.test(text)) result.ko++;
        else if (!exempt && /[a-zA-Z]/.test(text) && (ts.isJsxText(node) || surfaceContext(node))) result.en++;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return result;
}

function filesUnder(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, {withFileTypes: true}).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

export function surfaceFiles(surface, root = ROOT) {
  const spec = SURFACES[surface];
  if (!spec) throw new Error(`Unknown surface: ${surface}`);
  return [
    ...spec.roots.flatMap(dir => filesUnder(join(root, dir))).map(file => relative(root, file)),
    ...spec.files.filter(file => existsSync(join(root, file))),
  ].filter(file => isProductSource(file) && surfaceOf(file) === surface).sort();
}

function messageKeys(root) {
  return filesUnder(join(root, 'packages/momo-core/src/i18n/catalogs/en-US'))
    .filter(file => file.endsWith('.json'))
    .flatMap(file => Object.keys(JSON.parse(readFileSync(file, 'utf8'))));
}

/** `{counts: {file: {ko, en, cat}}, unknownKeys}`; files with no direct copy are omitted. */
export function scanSurface(surface, {root = ROOT, readSource, files} = {}) {
  const keys = messageKeys(root);
  const counts = {};
  const unknownKeys = [];
  const paths = (files ?? surfaceFiles(surface, root)).filter(file => isProductSource(file) && surfaceOf(file) === surface).sort();
  for (const file of paths) {
    const source = readSource ? readSource(file) : readFileSync(join(root, file), 'utf8');
    const {unknownKeys: unknown, ...count} = extractDirectCopy(file, source, keys);
    if (DIMENSIONS.some(d => count[d])) counts[file] = count;
    unknownKeys.push(...unknown.map(key => `${file}: unknown message key ${key}`));
  }
  return {counts, unknownKeys};
}

// ---- ledger -------------------------------------------------------------------------------

const ZERO = Object.freeze({ko: 0, en: 0, cat: 0});
const normalize = value => Object.fromEntries(DIMENSIONS.map(d => [d, value?.[d] ?? 0]));
const add = (a, b) => Object.fromEntries(DIMENSIONS.map(d => [d, (a?.[d] ?? 0) + (b?.[d] ?? 0)]));
const same = (a, b) => DIMENSIONS.every(d => (a?.[d] ?? 0) === (b?.[d] ?? 0));
const isCount = n => Number.isInteger(n) && n >= 0;
const sortedObject = object => Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]));

export function anchorSeal(ledger) {
  const anchor = Object.fromEntries(Object.keys(ledger.anchor ?? {}).sort().map(file => [file, normalize(ledger.anchor[file])]));
  return createHash('sha256').update(JSON.stringify({anchorHead: ledger.anchorHead, anchor})).digest('hex');
}

/** Format, seal and monotonicity problems that need no scan. Empty when the ledger is usable. */
export function validateLedger(ledger, {seal = ANCHOR_SEAL} = {}) {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) return ['ledger: expected a JSON object'];
  if (ledger.version !== LEDGER_VERSION) {
    return [`ledger version ${JSON.stringify(ledger.version)} is not ${LEDGER_VERSION}: this is the shape the old whole-ledger `
      + 'regeneration wrote ({version: 1, files}). Regenerating the ledger is not allowed (#5589). Restore the committed '
      + 'ledger, then lower counts with `shrink` or add one explicit `raise <file> --issue N --reason ...`.'];
  }
  const problems = [];
  const allowed = new Set(['version', 'policy', 'anchorHead', 'anchor', 'lowered', 'raises']);
  for (const key of Object.keys(ledger)) {
    if (!allowed.has(key)) problems.push(`ledger: unknown field ${key}${key === 'files' ? ' (a v1 field: the ledger was regenerated)' : ''}`);
  }
  if (!/^[a-f0-9]{40}$/.test(ledger.anchorHead ?? '')) problems.push('ledger: anchorHead must be a 40-hex commit');
  const countProblem = (where, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${where}: expected {ko, en, cat?}`;
    const extra = Object.keys(value).filter(key => !DIMENSIONS.includes(key));
    if (extra.length) return `${where}: unknown count ${extra.join(', ')}`;
    if (!DIMENSIONS.every(d => value[d] === undefined || isCount(value[d]))) return `${where}: counts must be non-negative integers`;
    return undefined;
  };
  for (const name of ['anchor', 'lowered']) {
    const map = ledger[name];
    if (!map || typeof map !== 'object' || Array.isArray(map)) { problems.push(`ledger: ${name} must be an object`); continue; }
    for (const [file, value] of Object.entries(map)) {
      if (!surfaceOf(file)) problems.push(`${name} ${file}: not a scanned product path`);
      const problem = countProblem(`${name} ${file}`, value);
      if (problem) problems.push(problem);
    }
  }
  if (problems.length) return problems;
  if (anchorSeal(ledger) !== seal) {
    problems.push('ledger: anchor seal mismatch — the frozen anchor was rewritten. Tools never write the anchor; '
      + 'only the planner re-anchors (`anchor <commit>`), and the new seal is a reviewed edit to ANCHOR_SEAL.');
  }
  for (const [file, value] of Object.entries(ledger.lowered)) {
    const anchor = ledger.anchor[file];
    if (!anchor) problems.push(`lowered ${file}: not in the anchor (a new file needs a raise, not a lowered entry)`);
    else if (DIMENSIONS.some(d => (value[d] ?? 0) > (anchor[d] ?? 0))) problems.push(`lowered ${file}: higher than the anchor; only raises may add`);
    else if (same(value, anchor)) problems.push(`lowered ${file}: equal to the anchor; remove the entry`);
  }
  if (!Array.isArray(ledger.raises)) problems.push('ledger: raises must be an array');
  else ledger.raises.forEach((raise, index) => {
    const where = `raises[${index}]`;
    if (!raise || typeof raise !== 'object' || Array.isArray(raise)) { problems.push(`${where}: expected an object`); return; }
    const extra = Object.keys(raise).filter(key => !['file', 'issue', 'reason', ...DIMENSIONS].includes(key));
    if (extra.length) problems.push(`${where}: unknown field ${extra.join(', ')}`);
    if (!surfaceOf(raise.file ?? '')) problems.push(`${where}: file must be a scanned product path`);
    if (!Number.isInteger(raise.issue) || raise.issue <= 0) problems.push(`${where}: issue must be the issue number that justifies it`);
    const reason = typeof raise.reason === 'string' ? raise.reason.trim() : '';
    if (reason.length < 15) problems.push(`${where}: reason must say why this copy cannot use a dictionary key yet (15+ characters)`);
    else if (REGENERATION_REASON.test(reason)) problems.push(`${where}: a regeneration is not a reason; name the copy and why it waits for P1`);
    if (!DIMENSIONS.every(d => raise[d] === undefined || isCount(raise[d])) || !DIMENSIONS.some(d => raise[d] > 0)) {
      problems.push(`${where}: give at least one positive ko/en/cat delta`);
    }
  });
  return problems;
}

/** Allowed counts per file: (lowered ?? anchor) + Σ raises. */
export function ceilings(ledger) {
  const result = {};
  for (const file of new Set([...Object.keys(ledger.anchor), ...Object.keys(ledger.lowered)])) {
    result[file] = normalize(ledger.lowered[file] ?? ledger.anchor[file]);
  }
  for (const raise of ledger.raises) result[raise.file] = add(result[raise.file] ?? ZERO, raise);
  return result;
}

/** Scan vs ledger for one surface: every file must match its allowance exactly. */
export function compareSurface(ledger, surface, counts) {
  const allowed = Object.fromEntries(Object.entries(ceilings(ledger)).filter(([file]) => surfaceOf(file) === surface));
  const increases = [];
  const decreases = [];
  const files = [...new Set([...Object.keys(allowed), ...Object.keys(counts)])].sort();
  for (const file of files) {
    const before = normalize(allowed[file]);
    const after = normalize(counts[file]);
    const up = DIMENSIONS.filter(d => after[d] > before[d]).map(d => `${d} ${before[d]} → ${after[d]}`);
    const down = DIMENSIONS.filter(d => after[d] < before[d]).map(d => `${d} ${before[d]} → ${after[d]}`);
    if (up.length) {
      increases.push(`${file}: ${up.join(', ')}; put the new text in a dictionary key (no sentence concatenation), `
        + 'or add one explicit raise: node packages/momo-core/src/i18n/tooling/direct-copy.mjs raise '
        + `${file} --issue <N> --reason "<why this copy waits for P1>"`);
    }
    if (down.length) {
      decreases.push(`${file}: ${down.join(', ')}; lower the ledger: node packages/momo-core/src/i18n/tooling/direct-copy.mjs shrink`);
    }
  }
  return {increases, decreases};
}

export function readLedger(path = join(ROOT, LEDGER_PATH)) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function checkSurface(surface, {root = ROOT, ledger = readLedger(join(root, LEDGER_PATH)), seal = ANCHOR_SEAL} = {}) {
  const problems = validateLedger(ledger, {seal});
  if (problems.length) throw new Error(`Direct UI copy guard (ledger):\n${problems.join('\n')}`);
  const {counts, unknownKeys} = scanSurface(surface, {root});
  const {increases, decreases} = compareSurface(ledger, surface, counts);
  const failures = [...increases, ...decreases, ...unknownKeys];
  if (failures.length) throw new Error(`Direct UI copy guard (${surface}):\n${failures.join('\n')}`);
  return counts;
}

function trimRaises(raises, file, need) {
  // Keep the oldest justification first; trim the newest entries down to what the file still needs.
  const left = {...need};
  const kept = raises.map(raise => {
    if (raise.file !== file) return raise;
    const next = {...raise};
    for (const d of DIMENSIONS) {
      const value = Math.min(raise[d] ?? 0, left[d]);
      left[d] -= value;
      if (value) next[d] = value; else delete next[d];
    }
    return next;
  });
  return kept.filter(raise => raise.file !== file || DIMENSIONS.some(d => raise[d] > 0));
}

/** Lower-only: lowers allowances to the scan and trims raises that are no longer used. */
export function shrinkLedger(ledger, counts) {
  const allowed = ceilings(ledger);
  const refused = [];
  let raises = ledger.raises.map(raise => ({...raise}));
  const lowered = {...ledger.lowered};
  for (const file of [...new Set([...Object.keys(allowed), ...Object.keys(counts)])].sort()) {
    const actual = normalize(counts[file]);
    const ceiling = normalize(allowed[file]);
    const over = DIMENSIONS.filter(d => actual[d] > ceiling[d]);
    if (over.length) { refused.push(`${file}: ${over.map(d => `${d} ${ceiling[d]} → ${actual[d]}`).join(', ')}`); continue; }
    if (same(actual, ceiling)) continue;
    const base = normalize(ledger.lowered[file] ?? ledger.anchor[file]);
    const need = Object.fromEntries(DIMENSIONS.map(d => [d, Math.max(0, actual[d] - base[d])]));
    const nextBase = Object.fromEntries(DIMENSIONS.map(d => [d, Math.min(base[d], actual[d])]));
    raises = trimRaises(raises, file, need);
    if (ledger.anchor[file] && same(nextBase, ledger.anchor[file])) delete lowered[file];
    else if (ledger.anchor[file]) lowered[file] = compact(nextBase, true);
  }
  return {ledger: {...ledger, lowered: sortedObject(lowered), raises}, refused};
}

/** One explicit raise for one file, sized to the current excess. */
export function raiseLedger(ledger, file, actual, {issue, reason}) {
  const ceiling = normalize(ceilings(ledger)[file]);
  const delta = Object.fromEntries(DIMENSIONS.map(d => [d, Math.max(0, (actual?.[d] ?? 0) - ceiling[d])]));
  if (!DIMENSIONS.some(d => delta[d])) throw new Error(`${file}: nothing to raise; the scan is within its allowance`);
  const next = {...ledger, raises: [...ledger.raises, {file, issue, ...compact(delta), reason}]};
  const problems = validateLedger(next, {seal: anchorSeal(ledger)});
  if (problems.length) throw new Error(problems.join('\n'));
  return next;
}

const sameRaise = (a, b) => a.file === b.file && a.issue === b.issue && a.reason === b.reason && same(a, b);

/**
 * Landing: derive the merged ledger from the target track's committed ledger plus the branch's
 * *new* raises — never from the working copy — then lower to the merged scan. Copy that neither
 * side justified stops the landing.
 */
export function landLedger(baseLedger, oursLedger, counts) {
  const notes = [];
  let start;
  if (baseLedger?.version === LEDGER_VERSION) start = baseLedger;
  else if (oursLedger?.version === LEDGER_VERSION) {
    start = oursLedger;
    notes.push('base ledger is v1 (before #5589): starting from this branch\'s v2 ledger');
  } else throw new Error('neither ledger is v2: this landing predates #5589 on both sides');
  const fresh = oursLedger?.version === LEDGER_VERSION && start !== oursLedger
    ? oursLedger.raises.filter(raise => !start.raises.some(existing => sameRaise(existing, raise))) : [];
  const merged = {...start, raises: [...start.raises, ...fresh]};
  return {...shrinkLedger(merged, counts), notes, carried: fresh.length};
}

function compact(value, keepZero = false) {
  const out = {};
  for (const d of DIMENSIONS) if (value[d] || (keepZero && d !== 'cat')) out[d] = value[d] ?? 0;
  return out;
}

export function serializeLedger(ledger) {
  const line = value => `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${JSON.stringify(item)}`).join(', ')}}`;
  const map = (name, object) => {
    const entries = Object.keys(object).sort().map(file => `    ${JSON.stringify(file)}: ${line(object[file])}`);
    return `  ${JSON.stringify(name)}: ${entries.length ? `{\n${entries.join(',\n')}\n  }` : '{}'}`;
  };
  const raises = ledger.raises.map(raise => `    ${line(raise)}`);
  return `{\n  "version": ${ledger.version},\n  "policy": ${JSON.stringify(ledger.policy ?? POLICY)},\n`
    + `  "anchorHead": ${JSON.stringify(ledger.anchorHead)},\n${map('anchor', ledger.anchor)},\n${map('lowered', ledger.lowered)},\n`
    + `  "raises": ${raises.length ? `[\n${raises.join(',\n')}\n  ]` : '[]'}\n}\n`;
}

export const POLICY = 'Only goes down. Do not regenerate this file. Lower with `shrink`; a raise is one file with an issue and a reason '
  + '(`raise`); landings use `land`. The anchor is frozen and sealed in direct-copy.mjs (#5589).';

// ---- git-backed operations (never used by `check`, which must stay git-free for CI) ---------

function git(args, options = {}) {
  return execFileSync('git', args, {cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options});
}

function ledgerAt(ref) {
  return JSON.parse(git(['show', `${ref}:${LEDGER_PATH}`]));
}

/** Reads every scanned file at a commit through one `git cat-file --batch`. */
function scanCommit(commit) {
  const roots = Object.values(SURFACES).flatMap(spec => [...spec.roots, ...spec.files]);
  const listed = git(['ls-tree', '-r', '--name-only', commit, '--', ...roots]).trim().split('\n').filter(Boolean);
  const files = listed.filter(file => isProductSource(file) && surfaceOf(file));
  const output = execFileSync('git', ['cat-file', '--batch'], {
    cwd: ROOT, input: files.map(file => `${commit}:${file}\n`).join(''), maxBuffer: 512 * 1024 * 1024,
  });
  const sources = new Map();
  let offset = 0;
  for (const file of files) {
    const end = output.indexOf(10, offset);
    const size = Number(output.subarray(offset, end).toString('utf8').split(' ')[2]);
    sources.set(file, output.subarray(end + 1, end + 1 + size).toString('utf8'));
    offset = end + 1 + size + 1;
  }
  const counts = {};
  for (const surface of Object.keys(SURFACES)) {
    const scoped = files.filter(file => surfaceOf(file) === surface);
    Object.assign(counts, scanSurface(surface, {files: scoped, readSource: file => sources.get(file)}).counts);
  }
  return counts;
}

function scanAll(root = ROOT) {
  const counts = {};
  const unknownKeys = [];
  for (const surface of Object.keys(SURFACES)) {
    const result = scanSurface(surface, {root});
    Object.assign(counts, result.counts);
    unknownKeys.push(...result.unknownKeys);
  }
  return {counts, unknownKeys};
}

function totals(counts) {
  const out = {};
  for (const [file, count] of Object.entries(counts)) {
    const surface = surfaceOf(file);
    out[surface] ??= {files: 0, ko: 0, en: 0, cat: 0};
    out[surface].files++;
    for (const d of DIMENSIONS) out[surface][d] += count[d] ?? 0;
  }
  return out;
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function main(argv) {
  const [action = 'check', ...args] = argv;
  const ledgerFile = join(ROOT, LEDGER_PATH);
  const write = ledger => writeFileSync(ledgerFile, serializeLedger(ledger));
  if (action === '--baseline') {
    throw new Error('--baseline was removed (#5589): the ledger is never re-emitted whole. Use `report`, `shrink`, `raise` or `land`.');
  }
  if (action === 'check' || Object.hasOwn(SURFACES, action)) {
    const surfaces = Object.hasOwn(SURFACES, action) ? [action] : (args.length ? args : Object.keys(SURFACES));
    const failures = [];
    for (const surface of surfaces) {
      try { checkSurface(surface); } catch (error) { failures.push(error.message); }
    }
    if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
    return;
  }
  if (action === 'report') {
    const {counts} = scanAll();
    const ledger = readLedger(ledgerFile);
    console.log(JSON.stringify({scan: totals(counts), anchor: ledger.anchor ? totals(ledger.anchor) : undefined}, null, 2));
    return;
  }
  if (action === 'shrink') {
    const ledger = readLedger(ledgerFile);
    const problems = validateLedger(ledger);
    if (problems.length) throw new Error(problems.join('\n'));
    const {counts} = scanAll();
    const {ledger: next, refused} = shrinkLedger(ledger, counts);
    if (refused.length) {
      console.error(`shrink only lowers. These files went up; use a dictionary key or one explicit raise:\n${refused.join('\n')}`);
      process.exitCode = 1;
      return;
    }
    write(next);
    return;
  }
  if (action === 'raise') {
    const [file] = args;
    const issue = Number(String(option(args, '--issue') ?? '').replace(/^#/, ''));
    const reason = option(args, '--reason');
    const ledger = readLedger(ledgerFile);
    const problems = validateLedger(ledger);
    if (problems.length) throw new Error(problems.join('\n'));
    const surface = surfaceOf(file ?? '');
    if (!surface) throw new Error('raise <scanned product file> --issue <N> --reason "<why>"');
    const {counts} = scanSurface(surface, {files: [file]});
    write(raiseLedger(ledger, file, counts[file], {issue, reason}));
    return;
  }
  if (action === 'land') {
    const base = option(args, '--base');
    const ours = option(args, '--ours');
    if (!base || !ours) throw new Error('land --base <target track ref> --ours <branch tip> [--check]');
    let oursLedger;
    try { oursLedger = ledgerAt(ours); } catch { oursLedger = undefined; }
    const baseLedger = ledgerAt(base);
    const {counts, unknownKeys} = scanAll();
    const {ledger: next, refused, notes, carried} = landLedger(baseLedger, oursLedger, counts);
    notes.forEach(note => console.error(`note: ${note}`));
    const problems = [...validateLedger(next), ...unknownKeys];
    if (refused.length || problems.length) {
      console.error(`land: copy that neither side justified, or ledger problems — not written:\n${[...refused, ...problems].join('\n')}`);
      process.exitCode = 1;
      return;
    }
    if (args.includes('--check')) {
      if (serializeLedger(next) !== readFileSync(ledgerFile, 'utf8')) {
        console.error('land --check: the working ledger differs from the one derived from the base and the branch raises');
        process.exitCode = 1;
      }
      return;
    }
    write(next);
    console.error(`land: carried ${carried} new raise(s); lowered ${Object.keys(next.lowered).length} file(s) in total`);
    return;
  }
  if (action === 'anchor') {
    // Planner only: a deliberate re-anchor. Prints the new ledger (or writes it) and the seal to paste.
    const [ref] = args;
    if (!ref) throw new Error('anchor <commit> [--write]');
    const commit = git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
    const anchor = Object.fromEntries(Object.entries(scanCommit(commit)).map(([file, count]) => [file, compact(count, true)]));
    const ledger = {version: LEDGER_VERSION, policy: POLICY, anchorHead: commit, anchor: sortedObject(anchor), lowered: {}, raises: []};
    if (args.includes('--write')) write(ledger); else process.stdout.write(serializeLedger(ledger));
    console.error(`ANCHOR_SEAL = '${anchorSeal(ledger)}' (edit direct-copy.mjs in the same reviewed change)`);
    console.error(JSON.stringify(totals(anchor)));
    return;
  }
  throw new Error('Use check [core|web|mobile] | core | web | mobile | report | shrink | raise | land | anchor');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
