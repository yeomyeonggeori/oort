#!/usr/bin/env node
/**
 * 하네스가 아는 표면 이름인가 — 캡처 스크립트가 앱을 띄우기 **전에** 묻는 한 줄 (#5172).
 *
 *   node measure/known-surface.cjs <이름>...   아는 이름이면 0, 모르는 이름이 하나라도 있으면 2 (사용법 틀림 64)
 *   node measure/known-surface.cjs --list      하네스가 아는 이름·접두를 출력한다
 *
 * ## 왜
 *
 * `-momoMeasure <이름>` 은 어떤 이름이든 받는다. 하네스가 모르는 이름이면 `measure/surfaces.tsx` 의 `default:` 가 「알 수 없는
 * 표면: <이름>」 안내 화면을 그리는데, 그 화면도 스크린샷으로는 멀쩡한 사진이다. 검증 줄 3회차는 `APPROVED` 두 장을 승인된 카드의
 * 증거로 받아 놓고 나서야 오류 화면임을 알았고(#5172), `measure.sh` 는 #2864 가 지운 `WORK-CONSOLE` 을 그 뒤로도 계속 찍고 있었다.
 * 실패해야 할 자리(모르는 이름)가 사진 한 장으로 바뀌는 것이 문제라서, 앱을 띄우기 전에 이름을 묻고 모르면 스크립트가 멈춘다.
 *
 * ## 어떻게
 *
 * 앱을 띄우지 않는다. `Surface()`(`measure/surfaces.tsx`)의 **맨 위 디스패치**를 TypeScript 구문 트리로 읽는다:
 *
 *   · `switch (name)` 의 `case '<이름>':`
 *   · `if (name === '<이름>')` · `if (name.startsWith('<접두>'))` — `||`·`&&` 로 이은 것 포함, `!` 아래는 뺀다
 *   · `if (isXxx(name))` — 그 술어(import 한 모듈의 함수)의 반환식을 같은 방식으로 읽는다
 *
 * 소스가 곧 장부라서 따로 적어 둘 목록이 없다. 표면을 하나 더하면 이 도구도 그 이름을 안다. 읽는 방법이 소스의 모양(위 세 가지)에
 * 기대므로, 디스패치가 다른 모양으로 바뀌면 조용히 틀리지 않고 **던진다**(`Surface` 를 못 찾음·술어를 못 풂).
 *
 * 이름 정규화는 `measure/root.ts` 의 `measureMode()` 와 같다: `YES`·`1` = 계측 하네스, `states` = 상태 장면, 앞의 `light-` 는 스킴이고
 * 나머지는 소문자 이름이다. `__tests__/measureSurfaces.test.tsx` 가 이 도구의 답을 **실제로 그려 본 결과**와 맞대어 둘이 어긋나면 붉어진다.
 *
 * ## 한계 (숨기지 않는다)
 *
 * 접두로 갈리는 가족(`sheetkit-…`·`shell-…` 의 일부 등)은 가족 안의 이름까지는 보지 못한다 — 가족이 자기 `which` 를 판정한다.
 * 이 도구가 막는 것은 **맨 위에서 모르는 이름**(`approved`·`work-console`)이다.
 *
 * CommonJS 인 까닭: jest(react-native 프리셋)는 `.mjs` 를 직접 불러올 수 없다. 이 파일은 시험이 함수로 부르고, 스크립트가 명령으로 부른다.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SURFACES_FILE = path.join(__dirname, 'surfaces.tsx');
/** 하네스가 이름으로 디스패치하는 함수와 그 인자 이름. */
const DISPATCH_FUNCTION = 'Surface';
const NAME_PARAM = 'name';
/** `measure/root.ts` 의 `SCHEME_PREFIX`. */
const SCHEME_PREFIX = 'light-';

let tsModule = null;
function loadTypeScript() {
  // 느리게 읽는다: 이름 정규화만 쓰는 호출자(시험)가 구문 분석기를 안 불러도 된다.
  if (tsModule === null) tsModule = require('typescript');
  return tsModule;
}

function parse(ts, file, source) {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function stringValue(ts, node) {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

/** 소스 파일의 최상위 함수 선언. */
function topLevelFunction(ts, sf, name) {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined && stmt.name.text === name) return stmt;
  }
  return null;
}

/** `import {a, b as c} from './x'` 에서 지역 이름 → 모듈 경로. */
function importedFrom(ts, sf, localName) {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || stmt.importClause === undefined) continue;
    const bindings = stmt.importClause.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    if (bindings.elements.some(element => element.name.text === localName)) {
      return stringValue(ts, stmt.moduleSpecifier);
    }
  }
  return null;
}

/**
 * 조건식에서 이름을 가리키는 항을 모은다. `param` 은 비교 대상 식별자(`name`)다.
 * `!` 아래(제외 조건)는 읽지 않는다 — 제외된 이름은 다른 갈래가 받거나 모르는 이름이다.
 */
function collectCondition(ctx, expr, param, rules) {
  const {ts} = ctx;
  if (ts.isParenthesizedExpression(expr)) return collectCondition(ctx, expr.expression, param, rules);
  if (ts.isPrefixUnaryExpression(expr)) return undefined;
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken) {
      collectCondition(ctx, expr.left, param, rules);
      collectCondition(ctx, expr.right, param, rules);
      return undefined;
    }
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) {
      const leftIsParam = ts.isIdentifier(expr.left) && expr.left.text === param;
      const rightIsParam = ts.isIdentifier(expr.right) && expr.right.text === param;
      const literal = stringValue(ts, leftIsParam ? expr.right : rightIsParam ? expr.left : undefined);
      if (literal !== null) rules.exact.add(literal);
    }
    return undefined;
  }
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression;
    // name.startsWith('접두')
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === 'startsWith' &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === param
    ) {
      const prefix = stringValue(ts, expr.arguments[0]);
      if (prefix !== null) rules.prefixes.push(prefix);
      return undefined;
    }
    // isXxx(name) — import 한 술어를 풀어 같은 방식으로 읽는다.
    if (
      ts.isIdentifier(callee) &&
      expr.arguments.length === 1 &&
      ts.isIdentifier(expr.arguments[0]) &&
      expr.arguments[0].text === param
    ) {
      collectPredicate(ctx, callee.text, rules);
    }
  }
  return undefined;
}

function collectPredicate(ctx, predicateName, rules) {
  const {ts, sf, baseDir} = ctx;
  let predicateCtx = ctx;
  let fn = topLevelFunction(ts, sf, predicateName);
  if (fn === null) {
    const specifier = importedFrom(ts, sf, predicateName);
    if (specifier === null || !specifier.startsWith('.')) {
      throw new Error(`술어 ${predicateName}(name) 을 풀지 못했다 — import 한 곳을 찾지 못함`);
    }
    const base = path.resolve(baseDir, specifier);
    const file = ['.tsx', '.ts'].map(ext => base + ext).find(candidate => fs.existsSync(candidate));
    if (file === undefined) throw new Error(`술어 ${predicateName}(name) 의 모듈 ${specifier} 를 찾지 못했다`);
    const predicateSf = parse(ts, file, fs.readFileSync(file, 'utf8'));
    predicateCtx = {ts, sf: predicateSf, baseDir: path.dirname(file)};
    fn = topLevelFunction(ts, predicateSf, predicateName);
    if (fn === null) throw new Error(`${file} 에 함수 ${predicateName} 이 없다`);
  }
  const param = fn.parameters[0] !== undefined && ts.isIdentifier(fn.parameters[0].name) ? fn.parameters[0].name.text : null;
  const ret = fn.body === undefined ? undefined : fn.body.statements.find(stmt => ts.isReturnStatement(stmt));
  if (param === null || ret === undefined || ret.expression === undefined) {
    throw new Error(`술어 ${predicateName} 이 「인자 하나 + return 식 하나」 모양이 아니라 읽지 못했다`);
  }
  collectCondition(predicateCtx, ret.expression, param, rules);
}

/**
 * `Surface()` 맨 위 디스패치가 받는 이름 규칙.
 * @param {string} source `measure/surfaces.tsx` 의 글
 * @param {string} baseDir 그 파일이 있는 폴더(술어 모듈의 상대 경로를 푼다)
 * @returns {{exact: Set<string>, prefixes: string[]}}
 */
function surfaceRules(source, baseDir = __dirname) {
  const ts = loadTypeScript();
  const sf = parse(ts, 'surfaces.tsx', source);
  const fn = topLevelFunction(ts, sf, DISPATCH_FUNCTION);
  if (fn === null || fn.body === undefined) {
    throw new Error(`surfaces.tsx 에 함수 ${DISPATCH_FUNCTION} 이 없다 — 디스패치 모양이 바뀌었다`);
  }
  const ctx = {ts, sf, baseDir};
  const rules = {exact: new Set(), prefixes: []};
  let switches = 0;
  for (const stmt of fn.body.statements) {
    if (ts.isIfStatement(stmt)) {
      collectCondition(ctx, stmt.expression, NAME_PARAM, rules);
    } else if (
      ts.isSwitchStatement(stmt) &&
      ts.isIdentifier(stmt.expression) &&
      stmt.expression.text === NAME_PARAM
    ) {
      switches += 1;
      for (const clause of stmt.caseBlock.clauses) {
        if (!ts.isCaseClause(clause)) continue;
        const literal = stringValue(ts, clause.expression);
        if (literal !== null) rules.exact.add(literal);
      }
    }
  }
  if (switches !== 1 || rules.exact.size === 0 || rules.prefixes.length === 0) {
    // 헛도는 가드 금지: 아무것도 못 읽었는데 「모든 이름이 모르는 이름」이라고 답하면 스크립트가 영원히 멈추거나(과잉), 반대로 읽은 것이
    // 없는 채 통과한다. 읽은 것이 없으면 도구가 고장인 것이다.
    throw new Error(
      `surfaces.tsx 의 디스패치에서 읽은 것이 이상하다(switch ${switches}개, 이름 ${rules.exact.size}개, 접두 ${rules.prefixes.length}개) — 읽는 모양을 고쳐야 한다`
    );
  }
  return rules;
}

/** 하네스 파일에서 규칙을 읽는다(기본: 이 폴더의 `surfaces.tsx`). */
function loadRules(file = SURFACES_FILE) {
  return surfaceRules(fs.readFileSync(file, 'utf8'), path.dirname(file));
}

/**
 * 시작 인자(`-momoMeasure <값>`)를 `measure/root.ts` 의 `measureMode()` 와 같은 규칙으로 읽는다.
 * @returns {{kind: 'measure'} | {kind: 'states'} | {kind: 'surface', name: string, scheme: 'light' | 'dark'} | null}
 */
function launchMode(raw) {
  if (raw === 'YES' || raw === '1') return {kind: 'measure'};
  if (typeof raw !== 'string' || raw === '') return null;
  const normalized = raw.toLowerCase();
  if (normalized === 'states') return {kind: 'states'};
  const light = normalized.startsWith(SCHEME_PREFIX);
  return {
    kind: 'surface',
    name: light ? normalized.slice(SCHEME_PREFIX.length) : normalized,
    scheme: light ? 'light' : 'dark',
  };
}

/** 이 시작 인자를 하네스가 아는가. 계측(`YES`)·상태(`STATES`) 장면도 안다. */
function isKnownLaunch(raw, rules) {
  const mode = launchMode(raw);
  if (mode === null) return false;
  if (mode.kind !== 'surface') return true;
  return rules.exact.has(mode.name) || rules.prefixes.some(prefix => mode.name.startsWith(prefix));
}

/** 모르는 이름 곁에 보여 줄 비슷한 이름(첫 토막이 같은 것). */
function suggestions(raw, rules, limit = 6) {
  const mode = launchMode(raw);
  if (mode === null || mode.kind !== 'surface') return [];
  const head = mode.name.split('-')[0];
  const pool = [...rules.exact, ...rules.prefixes].filter(candidate => candidate.startsWith(head));
  return [...new Set(pool)].sort().slice(0, limit);
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 1 && args[0] === '--list') {
    const rules = loadRules();
    process.stdout.write(
      `이름 ${rules.exact.size}개:\n${[...rules.exact].sort().join('\n')}\n접두 ${rules.prefixes.length}개:\n${[...rules.prefixes].sort().join('\n')}\n`
    );
    return 0;
  }
  if (args.length === 0 || args.some(arg => arg.startsWith('--'))) {
    process.stderr.write('usage: node measure/known-surface.cjs <이름>...   |   --list\n');
    return 64;
  }
  const rules = loadRules();
  const unknown = args.filter(arg => !isKnownLaunch(arg, rules));
  for (const arg of unknown) {
    const near = suggestions(arg, rules);
    process.stderr.write(
      `알 수 없는 표면: ${arg} — 하네스(measure/surfaces.tsx)가 모르는 이름이라 「알 수 없는 표면」 안내 화면이 찍힌다.` +
        (near.length > 0 ? ` 비슷한 이름: ${near.join(', ')}` : '') +
        '\n'
    );
  }
  if (unknown.length > 0) return 2;
  process.stdout.write(`known-surface: ${args.length}개 모두 하네스가 아는 이름\n`);
  return 0;
}

module.exports = {launchMode, isKnownLaunch, loadRules, suggestions, surfaceRules};

if (require.main === module) {
  process.exitCode = main(process.argv);
}
