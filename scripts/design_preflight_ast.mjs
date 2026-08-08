// =============================================================================
// design_preflight_ast.mjs — TS/TSX 문자열 리터럴 스캐너 (이슈 #1141).
//
// CLI 가 아니다. 두 게이트가 **같은 판정**을 쓰도록 규칙 하나를 여기에 둔다:
//
//   · scripts/design_preflight_core.mjs        packages/momo-core/src  (emdash·raw_color·hype)
//   · scripts/design_preflight_web_strings.mjs clients/web/src         (emdash)
//
// ## 왜 AST 인가
//
// 「렌더되는 글자」와 「사람이 읽으라고 적은 산문(주석·독스트링·테스트 이름)」을
// 가르는 문법적 표지가 소스에는 없다. #1171 이 코어에 대해 세 후보를 실측했고
// (근거표는 design_preflight_core.mjs 머리말), 답은 **파서가 주석을 리터럴로
// 만들지 않는다**는 사실이었다. 그래서 "주석을 어떻게 알아보나"라는 질문 자체가
// 사라진다. 웹도 같은 질문에 걸려 있었으므로(현행 12건 전부 테스트 이름·주석
// 산문) 같은 답을 쓴다.
//
// ## 웹이 코어에 없는 것을 하나 갖고 있다: JSX
//
// 코어는 순수 TS 라 `.tsx` 가 존재할 수 없다(purity.mjs 가 확장자 단계에서 막는다).
// 웹은 `.tsx` 가 대부분이고, 거기서 사용자가 읽는 글자는 **따옴표 없이** 태그
// 사이에 놓인다:
//
//     <p>지금은 보낼 수 없습니다 — 다시 연결되면 여기서 보냅니다</p>
//
// 줄 기반 grep 은 따옴표 쌍을 찾으므로 이 모양을 **한 번도 본 적이 없다**. 반대로
// JSX 주석(`{/* … */}`)은 따옴표(백틱 포함)를 품기 쉬워서 오탐의 단골이었다 —
// 현행 12건 중 `TypingLine.tsx:188` 이 정확히 그 자리다. AST 는 둘 다 정확히
// 반대로 본다: JsxText 는 노드이고, JSX 주석은 노드가 아니다.
//
// 그래서 여기서 세는 노드는 넷이다.
//   ① 문자열 리터럴 (`"…"`, `'…'`, 치환 없는 백틱)
//   ② 템플릿의 글자 부분 (head/middle/tail — `${…}` 안의 식은 자기 노드로 따로 온다)
//   ③ JSX 텍스트 (공백만인 노드는 제외)
//   ④ (제외) import/export/import() 의 모듈 지정자 — 경로는 사람이 읽는 글이 아니고,
//      상대 경로에 하이픈이 들어가는 날 오탐이 된다.
//
// 알고 남기는 구멍: JSX 엔티티(`&mdash;`)는 소스에 대시 글자가 없으므로 이 스캔이
// 보지 못한다. 이 레포에 그렇게 적힌 자리는 0 이고(전수 grep), 생기면 그때가
// 규칙을 늘릴 자리다 — 지금 늘리면 영원히 0 인 줄이 하나 더 늘 뿐이다.
// =============================================================================

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

/**
 * 검토된 예외 마커. 웹 pre-flight 가 이미 쓰는 **그 낱말**이다. 다른 마커를 만들면
 * 두 게이트를 함께 통과하려는 사람이 어느 쪽 마커인지부터 배워야 한다.
 *
 * 다는 자리는 둘이다: 문자열이 시작하는 줄의 뒤꼬리 주석, 또는 그 문자열을 담은
 * **선언의 머리 주석**. 뒤꼬리만 허용하면 사유가 100자짜리 문자열 뒤에 매달려
 * 아무도 읽지 않는데, 검토된 예외에서 정작 읽혀야 하는 것이 그 사유다.
 */
export const ALLOW_MARKER = "design-preflight-allow";

/**
 * em-dash 분류. 코어와 웹이 이 객체를 함께 쓴다 — 「대시가 무엇인가」가 두 파일에
 * 따로 적혀 있으면 한쪽만 고쳐지는 날이 온다.
 */
export const EMDASH_CATEGORY = {
  key: "emdash",
  rule: "em-dash (—/–) in a user-visible string (SKILL §7: binary fail, use , : ( ) or a line break)",
  hit: (text) => /—|–/.test(text),
};

/**
 * `typescript` 를 찾는다. 워크스페이스 루트로 호이스트되기도 하고 패키지 안에 남기도
 * 한다. 못 찾으면 **조용히 건너뛰지 않는다**: 안 돌린 것과 초록이 구별되지 않는
 * 상태를 만들지 않는 것이 이 레포의 게이트 규칙이다(verify_merge_tree.sh 머리말).
 * 그 판단은 호출자가 하도록 여기서는 null 을 돌려준다.
 */
export function loadTypeScript(repoRoot, extraCandidates = []) {
  const require_ = createRequire(import.meta.url);
  const candidates = [
    "typescript",
    join(repoRoot, "node_modules/typescript"),
    join(repoRoot, "packages/momo-core/node_modules/typescript"),
    ...extraCandidates,
  ];
  for (const candidate of candidates) {
    try {
      return require_(candidate);
    } catch {
      /* 다음 후보 */
    }
  }
  return null;
}

export function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * 이 파일이 사람에게 무언가를 **출하하는가**.
 *
 * 테스트는 인용할 뿐 출하하지 않는다. 인용을 막으면 가드가 자기 픽스처에 걸려
 * 무뎌지고, 인용된 원본은 프로덕션 파일에서 이 스캔이 이미 잡으므로 잃는 것이
 * 없다. 생성 타입(`.d.ts`)은 사람이 쓴 글이 아니다.
 */
export function shipsStrings(path) {
  if (!/\.tsx?$/.test(path)) return false;
  if (/\.test\.tsx?$/.test(path)) return false;
  if (path.endsWith(".d.ts")) return false;
  return true;
}

/**
 * 한 소스가 **렌더로 흘러갈 수 있는 문자열**을 훑는다.
 *
 * `fileName` 의 확장자가 파싱 모드를 정한다 — `.tsx` 여야 JSX 가 노드가 된다.
 * 그래서 가상 케이스(selftest)도 실제 확장자를 그대로 들고 온다.
 */
export function scanSource(ts, fileName, text, categories) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const lines = text.split("\n");
  const hits = [];

  const moduleSpecifiers = new Set();
  const collectSpecifiers = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      moduleSpecifiers.add(node.moduleSpecifier);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0]
    ) {
      moduleSpecifiers.add(node.arguments[0]);
    }
    if (ts.isImportTypeNode(node) && node.argument) {
      moduleSpecifiers.add(node.argument);
    }
    ts.forEachChild(node, collectSpecifiers);
  };
  collectSpecifiers(sf);

  /**
   * 이 리터럴을 담고 있는 「칸」 — 예외가 붙을 수 있는 가장 가까운 선언.
   *
   * 선언 단위인 것은 예외가 붙는 대상이 문자열 조각이 아니라 그 칸이기 때문이다
   * (이어붙인 문자열 여섯 조각이어도 렌더되지 않는 칸은 하나다). JSX 속성과
   * `throw` 를 멈춤 지점에 넣은 것도 같은 이유다 — 한 속성의 예외가 형제 속성까지
   * 덮으면 안 되고, 이어붙인 throw 문구는 사유를 적을 자리가 머리 주석뿐이다
   * (뒤꼬리 마커는 여섯 조각 중 어느 줄에 다는가를 사람이 외워야 한다).
   */
  const enclosingDeclaration = (node) => {
    let current = node.parent;
    while (current && !ts.isSourceFile(current)) {
      if (
        ts.isJsxAttribute(current) ||
        ts.isThrowStatement(current) ||
        ts.isPropertyAssignment(current) ||
        ts.isPropertyDeclaration(current) ||
        ts.isPropertySignature(current) ||
        ts.isVariableStatement(current) ||
        ts.isReturnStatement(current) ||
        ts.isExpressionStatement(current)
      ) {
        return current;
      }
      current = current.parent;
    }
    return null;
  };

  const allowed = (node, line) => {
    // ① 문자열이 시작하는 줄의 뒤꼬리 주석. 여러 줄 템플릿이면 그 시작 줄이다.
    if ((lines[line] ?? "").includes(ALLOW_MARKER)) return true;
    // ② 그 칸의 머리 주석(`//` 든 `/** */` 든). 파서가 붙여 주므로 「주석을 어떻게
    //    알아보나」를 여기서도 다시 풀지 않는다.
    const declaration = enclosingDeclaration(node);
    if (!declaration) return false;
    const ranges = ts.getLeadingCommentRanges(text, declaration.getFullStart()) ?? [];
    return ranges.some((r) => text.slice(r.pos, r.end).includes(ALLOW_MARKER));
  };

  const record = (node, literalText) => {
    // JsxText 의 getStart 는 앞 공백을 건너뛰므로 보고되는 줄이 글자가 실제로
    // 시작하는 줄이다(TS 의 getTokenPosOfNode 가 JsxText 를 특례로 다룬다).
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    if (allowed(node, line)) return;
    for (const category of categories) {
      if (category.hit(literalText)) {
        hits.push({
          key: category.key,
          line: line + 1,
          text: literalText.replace(/\s+/g, " ").trim().slice(0, 120),
        });
      }
    }
  };

  const visit = (node) => {
    if (moduleSpecifiers.has(node)) {
      ts.forEachChild(node, visit);
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      record(node, node.text);
    } else if (
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      // 치환이 있는 템플릿의 **글자 부분**. `${…}` 안의 식은 자기 노드로 따로
      // 방문되므로 두 번 세지 않는다.
      record(node, node.text);
    } else if (ts.isJsxText(node)) {
      // 태그 사이의 맨 글자 — 따옴표가 없어서 줄 기반 grep 이 못 보던 자리다.
      // 들여쓰기만 있는 노드는 JSX 트리의 접착제이지 문장이 아니다.
      if (!node.containsOnlyTriviaWhiteSpaces) record(node, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return hits;
}

/**
 * selftest 공통 실행기. 케이스는 「있을 법한 소스 한 조각 + 그것이 받아야 하는
 * 판정」이고, 규칙을 산문으로 다시 말하는 대신 이 표가 규칙을 들고 있는다.
 */
export function runCases(ts, srcRoot, cases, title, log = console.log) {
  log(`== ${title} ==`);
  let failures = 0;
  for (const testCase of cases) {
    const virtual = join(srcRoot, testCase.file);
    const got = shipsStrings(virtual)
      ? [...new Set(scanSource(ts, virtual, testCase.src, testCase.categories).map((h) => h.key))].sort()
      : [];
    const want = [...testCase.want].sort();
    const same = got.length === want.length && got.every((k, i) => k === want[i]);
    if (same) {
      log(`OK    want=[${want}] ${testCase.why}`);
    } else {
      log(`FAIL  want=[${want}] got=[${got}]  ${testCase.why}`);
      log(`        ${testCase.src.replace(/\n/g, "\\n")}`);
      failures += 1;
    }
  }
  return failures;
}
