// =============================================================================
// design_preflight_ast.mjs — TS/TSX 문자열 리터럴 스캐너 (이슈 #1141).
//
// CLI 가 아니다. 소비자들이 **같은 판정**을 쓰도록 규칙 하나를 여기에 둔다.
// 소비자가 늘 때 이 표도 함께 고친다 — 규칙 한 벌을 만든 파일이 자기 소비자
// 목록에서 낡으면, 그 목록을 읽고 「내 클라는 안 재진다」를 잘못 아는 사람이
// 생긴다 (#1511 회전 1 Nitpick):
//
//   · scripts/design_preflight_core.mjs          packages/momo-core/src
//         emdash · raw_color · hype · progress_word · latin_particle   (#1511)
//         legacy_term                                                  (#3445)
//   · scripts/design_preflight_web_strings.mjs   clients/web/src
//         emdash · progress_word · latin_particle                      (#1511)
//         legacy_term                                                  (#3445)
//   · scripts/design_preflight_phone_strings.mjs clients/mobile/src
//         progress_word · latin_particle                               (#1511 회전 1)
//         legacy_term                                                  (#3445)
//         em-dash 는 여기서 걸지 않는다 — 폰은 conversationHygiene.test.tsx 의
//         `src/` 전수 스윕이 이미 잡는다. 같은 위반을 두 곳에서 세면 어느 쪽이
//         정본인지 모르게 된다.
//
// 앞 둘은 `design_preflight_web.sh` 가, 셋째는 폰 jest 스위트가 부른다(폰에는
// 「디자인 프리플라이트」라는 실행 단위가 없다 — 디자인 시스템 §5.4).
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

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

/**
 * 검토된 예외 마커. 웹 pre-flight 가 이미 쓰는 **그 낱말**이다. 다른 마커를 만들면
 * 두 게이트를 함께 통과하려는 사람이 어느 쪽 마커인지부터 배워야 한다.
 *
 * 다는 자리는 둘이다: 문자열이 시작하는 줄의 뒤꼬리 주석, 또는 그 문자열을 담은
 * **선언의 머리 주석**(`legacy_term` 만 바깥 선언들의 머리 주석도 본다, #3445). 뒤꼬리만 허용하면 사유가 100자짜리 문자열 뒤에 매달려
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
 * 「-하는 중」이 옳은 꼴인 고유어 어간 (#1511). 규칙(#1490 전수 조사 → #1501
 * 정본화)은 어간의 출신으로 갈린다 — 한자어 동작명사가 있으면 「명사 + 중」
 * (저장 중·연결 중·인수 중), 없으면 고유어 동사가 「-는 중」(받는 중·만드는 중).
 * 「받는 중」류는 애초에 「-하는 중」 꼴이 아니라 이 검사에 걸리지 않고, 걸리는
 * 것은 X하다 동사뿐이다. 그중 X 가 고유어인 낱말만 여기 선다.
 *
 * 어간을 더하는 것은 곧 「이 X 는 한자어가 아니다」라는 판정이다 — 표에 적기
 * 전에 그 판정을 실제로 하라. 지금 유일한 항목: 생각(생각하는 중,
 * workSessionModel 의 think 국면. #1509 전수 조사도 이것을 위반으로 세지 않았다).
 */
export const NATIVE_HANEUN_STEMS = ["생각"];

const NATIVE_HANEUN_RE = new RegExp(
  `(^|[^가-힣])(${NATIVE_HANEUN_STEMS.join("|")})하는 중…?$`
);

/**
 * 진행 낱말꼴 분류 (#1511). 원래 라벨을 **제자리에서** 대체하는 진행 낱말만
 * 겨냥하므로 끝 고정이다: 문자열이 「-하는 중」(말줄임표 동행 포함)으로 **끝나는**
 * 경우만 위반이고, 문장 꼴 「-하는 중입니다」나 문중의 「-하는 중이라 …」 산문은
 * 검사 밖이다 (#1509 이탈 7 — 문장에서는 그 꼴이 옳다).
 */
export const PROGRESS_WORD_CATEGORY = {
  key: "progress_word",
  rule:
    "진행 낱말은 「명사 + 중」 (#1501 정본·#1511 게이트): 한자어 동작명사가 있으면 「저장 중」, " +
    "「-하는 중」은 고유어 어간 자리(NATIVE_HANEUN_STEMS)만 — 문장 꼴 「-하는 중입니다」는 검사 밖",
  hit: (text) => {
    const t = text.trim();
    if (!/[가-힣]하는 중…?$/.test(t)) return false;
    return !NATIVE_HANEUN_RE.test(t);
  },
};

/**
 * 라틴 낱말+조사 띄어쓰기 분류 (#1511 편입 — design-review #1560 Medium ①).
 * 「Esc 는」「Tab 으로」처럼 라틴 낱말과 조사 사이를 띄면, break-keep 아래서
 * 조사가 줄머리 고아로 선다(§5.3 7위 축). 형제 정답은 「Esc로」(composerCopy).
 *
 * 조사 뒤가 한글이면 조사가 아니라 낱말의 첫 글자다(「API 이름」의 「이」) —
 * 그래서 뒤 경계는 「한글 아님 또는 끝」이다.
 */
export const LATIN_PARTICLE_CATEGORY = {
  key: "latin_particle",
  rule:
    "라틴 낱말 뒤 조사는 붙여 쓴다 (「Esc 는」→「Esc는」, #1511·#1560 M①): " +
    "break-keep 아래서 띈 조사가 줄머리 고아로 선다",
  hit: (text) =>
    /[A-Za-z] (은|는|이|가|을|를|과|와|의|로|으로|에|에서|도|만)(?=$|[^가-힣])/.test(text),
};

/**
 * 옛 용어 분류 (AIH-10, #3445). 용어집(플랜 §2)이 흡수한 옛 말이 화면 문자열에 남으면
 * 위반이다. 목록의 정본은 코어의 `LEGACY_TERM_MAP`(grepGate: true 항목)이고 여기서
 * 베끼지 않는다 — `loadLegacyTerms` 가 그 파일을 파싱해 읽는다. 코어의 시험도 같은
 * 표로 `findLegacyTerms` 를 고정하므로 두 갈래 정의가 생기지 않는다.
 *
 * 영문 식별자 꼴 항목(`owner_only`)은 **한글이 함께 든 문자열**에서만 위반이다. 맨
 * 기계 값(`"owner_only"`)은 와이어 코드라 바꾸지 않는다(이슈 계약).
 *
 * 허용 예외는 한 가지 길뿐이다: `design-preflight-allow` 마커(문자열 줄의 뒤꼬리 또는
 * 선언의 머리 주석, 바깥 선언 포함). 옛 말을 정의하는 표와 용어집이 그 자리다.
 */
export function makeLegacyTermCategory(terms) {
  const isIdentifier = (term) => /^[\x21-\x7e]+$/.test(term);
  return {
    key: "legacy_term",
    rule:
      "옛 용어 (AI 허브 용어집 §2, #3445): 「AI 연결」→「AI」, 「오너」→「소유자」, 「합류」·「구독 붙이기」·「호스티드 에이전트」 등은 " +
      "화면에서 쓰지 않는다. 목록 정본 = core LEGACY_TERM_MAP(grepGate). 예외는 design-preflight-allow 마커 + PR 근거",
    hit: (text) =>
      terms.some((term) => text.includes(term) && (!isIdentifier(term) || /[가-힣]/.test(text))),
  };
}

/** core 의 LEGACY_TERM_MAP 에서 grepGate 항목의 `old` 를 읽는다. 못 읽으면 던진다(조용한 초록 금지). */
export function loadLegacyTerms(ts, repoRoot) {
  const file = join(repoRoot, "packages/momo-core/src/features/ai/aiHubModel.ts");
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
  const terms = [];
  let found = false;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(sf) === "LEGACY_TERM_MAP" &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      found = true;
      for (const el of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(el)) continue;
        let old = null;
        let gate = false;
        for (const prop of el.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const name = prop.name.getText(sf);
          if (name === "old" && ts.isStringLiteralLike(prop.initializer)) old = prop.initializer.text;
          if (name === "grepGate" && prop.initializer.kind === ts.SyntaxKind.TrueKeyword) gate = true;
        }
        if (old && gate) terms.push(old);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!found || terms.length === 0) {
    throw new Error(`LEGACY_TERM_MAP(grepGate)를 ${file} 에서 읽지 못했다`);
  }
  return terms;
}

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

  // outer=false: 가장 가까운 칸만(모든 기존 분류의 의미). outer=true: 바깥 선언들의 머리
  // 주석도 본다 — `legacy_term` 만 쓴다(#3445). 옛 말을 **정의**하는 표(LEGACY_TERM_MAP)는
  // 항목마다 마커를 달 수 없어서 표 선언 하나의 머리 주석이 그 안 전부를 덮어야 한다.
  // 다른 분류에 이 상승을 주면 컴포넌트 머리의 마커 하나가 본문 전체의 em-dash 를 지운다.
  const allowed = (node, line, outer) => {
    // ① 문자열이 시작하는 줄의 뒤꼬리 주석. 여러 줄 템플릿이면 그 시작 줄이다.
    if ((lines[line] ?? "").includes(ALLOW_MARKER)) return true;
    // ② 그 칸의 머리 주석(`//` 든 `/** */` 든). 파서가 붙여 주므로 「주석을 어떻게
    //    알아보나」를 여기서도 다시 풀지 않는다.
    for (let declaration = enclosingDeclaration(node); declaration; ) {
      const ranges = ts.getLeadingCommentRanges(text, declaration.getFullStart()) ?? [];
      if (ranges.some((r) => text.slice(r.pos, r.end).includes(ALLOW_MARKER))) return true;
      if (!outer) return false;
      declaration = enclosingDeclaration(declaration);
    }
    return false;
  };

  const record = (node, literalText) => {
    // JsxText 의 getStart 는 앞 공백을 건너뛰므로 보고되는 줄이 글자가 실제로
    // 시작하는 줄이다(TS 의 getTokenPosOfNode 가 JsxText 를 특례로 다룬다).
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    for (const category of categories) {
      if (allowed(node, line, category.key === "legacy_term")) continue;
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
