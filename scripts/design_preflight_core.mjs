#!/usr/bin/env node
// =============================================================================
// design_preflight_core.mjs — 코어의 사용자 가시 문자열 기계 검사 (이슈 #1141).
//
// `scripts/design_preflight_web.sh` 가 부르는 한 단계다. 단독으로도 돈다.
//
// ## 왜 있나
//
// 웹 pre-flight 는 `clients/web/src` 만 훑었다. 그런데 사람이 화면에서 읽는 문장의
// 상당수는 거기 없다 — `packages/momo-core` 에 있고, 웹과 폰이 **그것을 그대로**
// 렌더한다. 그래서 코어에 em-dash 를 적으면 두 클라 모두 그것을 출하하는데 어느
// 게이트도 붉지 않았다. #1138 B2(출하 직전에 사람이 발견한 em-dash 3건)의 원인이
// 정확히 이 구멍이다.
//
// ## 분리 규칙 — 무엇이 「사용자 가시 문자열」인가
//
// 코어는 순수 TS 라 마크업이 없다. 그래서 「렌더되는 글자」와 「사람이 읽으라고
// 적은 산문(주석·독스트링·테스트 이름)」을 가르는 문법적 표지가 없다. 규칙이
// 필요했고, 세 후보를 실측해서 골랐다(근거는 아래 표, `--selftest` 가 케이스로
// 들고 있다).
//
//   (A) 줄 기반 grep + 주석 줄 버리기   ← 웹 pre-flight 가 쓰는 것
//   (B) 명명 규약 (label/absentReason/... 같은 필드 이름만 검사)
//   (C) TS AST 의 **문자열 리터럴 노드만** 검사   ← 채택
//
// (A) 를 코어에 그대로 쓰면 두 곳에서 무너진다. 주석이 줄 앞에 오지 않는 경우
//     (`const x = 1; // 여기 — 이렇게`) 와, 여러 줄에 걸친 템플릿 리터럴이다.
//     전자는 오탐, 후자는 미탐이고 둘 다 조용하다. 이 레포는 이미 같은 결론을
//     한 번 냈다: `packages/momo-core/scripts/purity.mjs` 머리말 — "a grep would
//     either drown in false positives or be tuned until it stopped catching
//     anything. The AST sees identifiers, not prose."
//
// (B) 는 표를 손으로 관리해야 한다. 새 필드를 추가한 사람이 표에 적지 않으면
//     검사가 조용히 그 문장을 놓치고, **놓쳤다는 사실 자체가 보이지 않는다.**
//     전파되지 않는 규약은 규약이 아니라는 것이 이 레포가 `#1137` 에서 세 번
//     배운 것이다(design_preflight_web.sh 의 raw_color 주석).
//
// (C) 는 주석을 **정의상** 보지 않는다. 파서가 주석을 리터럴 노드로 만들지 않기
//     때문이고, 그래서 「주석을 어떻게 알아보나」라는 질문 자체가 사라진다.
//     비용은 `typescript` 하나인데, 코어는 이미 그것을 devDependency 로 갖고
//     있고 이미 AST 게이트(purity.mjs)를 돌린다. 새 의존이 아니다.
//
// 그 (C) 의 구현은 이제 `scripts/design_preflight_ast.mjs` 에 있다. 웹 emdash 도
// 같은 부류의 오탐(테스트 이름·주석 산문 12건)에 걸려 있었고 같은 판정을 써야
// 하므로 규칙을 한 벌만 둔다 — 두 곳에 적힌 규칙은 한쪽만 고쳐지는 날이 온다.
// 여기 남는 것은 **코어의 계약**이다: 무엇을 훑고(packages/momo-core/src), 어떤
// 분류를 걸고(셋), 어떤 케이스로 그것을 증명하는가(17).
//
// 남는 두 축은 규칙이 아니라 **선언**으로 처리한다:
//
//   · `*.test.ts` 는 통째로 제외한다. 테스트가 들고 있는 낱말은 **표면을 인용한
//     것**이지 만든 것이 아니다. 인용을 막으면 가드가 자기 픽스처에 걸려 무뎌
//     진다(폰의 이름 가드가 주석을 걷어내는 것과 같은 판단). 인용된 원본은
//     프로덕션 파일에서 이 검사가 이미 잡는다 — 잃는 것이 없다.
//     실측: 코어 em-dash 72건 중 70건이 `describe`/`it` 의 **테스트 이름**이었다.
//   · 렌더되지 않는다고 문서에 적혀 있는 프로덕션 문자열은 `design-preflight-allow`
//     마커를 그 줄에 단다. 웹 pre-flight 가 이미 쓰는 그 마커고, 지금 코어에
//     해당하는 줄은 두 개다(serverSurfaces.measured, DIVIDER_TONE_SPEC.meaning —
//     둘 다 자기 독스트링이 "사용자에게 보이지 않는다"고 적고 있고, 어느 클라도
//     읽지 않는다).
//
// ## 부채는 왜 일괄 치환하지 않았나
//
// #1141 이 적은 실측치는 em-dash 73 · raw_color 47 이었다. 그 숫자는 **분리 규칙이
// 없을 때**의 숫자다. 위 규칙을 적용하면 em-dash 2 · raw_color 0 으로 줄고, 남은
// 둘은 사용자에게 보이지 않는 문자열이다. 즉 「부채」의 실체는 사용자 가시 문구가
// 아니라 산문과 테스트 이름이었다. 그래서 기준선(ratchet) 파일을 만들지 않았다 —
// 지킬 부채가 없는데 기준선을 세우면 그 파일이 다음 사람에게 "여기까지는 괜찮다"고
// 거짓말한다. 코어도 웹과 같은 **하드 제로**다.
//
// 사용:
//   node scripts/design_preflight_core.mjs            검사 (0 통과 / 1 위반)
//   node scripts/design_preflight_core.mjs --list     현재 적중 전부 출력, 게이트 안 함
//   node scripts/design_preflight_core.mjs --selftest 분리 규칙을 케이스로 증명
// =============================================================================

import { readFileSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOW_MARKER,
  EMDASH_CATEGORY,
  loadTypeScript,
  runCases,
  scanSource,
  shipsStrings,
  walk,
} from "./design_preflight_ast.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const CORE_SRC = join(REPO_ROOT, "packages/momo-core/src");

const ts = loadTypeScript(REPO_ROOT);
if (!ts) {
  console.error(
    "design pre-flight (core): typescript 를 찾지 못했다.\n" +
      "  npm ci  또는  npm --prefix packages/momo-core install  먼저."
  );
  process.exit(2);
}

// ---- 분류 -------------------------------------------------------------------
//
// 웹 쪽 10 분류 중 코어에서 성립하는 것은 **낱말과 값**에 대한 셋뿐이다. 나머지
// 일곱(inline_style·arbitrary_tw·ai_gradient·toast·naked_focus·external_font·
// pure_bw)은 마크업/CSS 에 대한 검사인데, 코어에는 `.tsx`·`.css` 가 존재할 수
// 없다 — `packages/momo-core/scripts/purity.mjs` 가 파일 확장자 단계에서 막는다.
// 여기서 그 일곱을 흉내 내면 영원히 0 인 줄이 일곱 개 늘 뿐이고, 초록 줄이 많은
// 게이트는 읽히지 않는다.
const ISSUE_REF_RE = /#[0-9]{3,5}(?![0-9a-fA-F])/g;
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/;

const CATEGORIES = [
  // 대시의 정의는 웹과 공유한다 (design_preflight_ast.mjs).
  EMDASH_CATEGORY,
  {
    key: "raw_color",
    rule: "raw color literal handed to a client (색은 클라의 토큰이 정한다 — 코어는 역할만 말한다)",
    // 이슈 참조(`#1137`)를 먼저 걷어낸 뒤에도 색이 남는가. 웹 스크립트의
    // `drop_issue_refs` 와 같은 판정이고, 같은 이유로 존재한다.
    hit: (text) => COLOR_RE.test(text.replace(ISSUE_REF_RE, "")),
  },
  {
    key: "hype",
    rule: "filler-hype vocabulary in user-visible copy (SKILL §7)",
    hit: (text) =>
      /seamless|effortless|unleash|elevate|원활한|손쉽게|매끄러운/i.test(text),
  },
];

// 파일 분류·스캔·허용 마커는 웹과 공유한다 (scripts/design_preflight_ast.mjs).
// 마커의 낱말(`design-preflight-allow`)과 다는 자리(문자열 줄의 뒤꼬리 주석 또는
// 그 칸의 머리 주석)도 거기 적혀 있다.

function scanCore() {
  if (!existsSync(CORE_SRC)) {
    console.error(`design pre-flight (core): ${CORE_SRC} 없음 (momo 레포에서 실행)`);
    process.exit(2);
  }
  const results = [];
  for (const file of walk(CORE_SRC).filter(shipsStrings)) {
    const text = readFileSync(file, "utf8");
    for (const hit of scanSource(ts, file, text, CATEGORIES)) {
      results.push({ ...hit, file: relative(REPO_ROOT, file) });
    }
  }
  results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return results;
}

// ---- 자기 증명 --------------------------------------------------------------
//
// 규칙을 산문으로 다시 말하지 않고 **케이스로** 들고 있는다. 각 줄은 있을 법한
// 코어 소스 한 조각과 그것이 받아야 하는 판정이다. `(A) 줄 기반`이 틀렸을 자리
// 에는 그렇게 적어 두었다 — 이 표가 곧 (C)를 고른 근거다.
const SELFTEST_CASES = [
  {
    want: ["emdash"],
    file: "features/x/copy.ts",
    why: "렌더되는 문자열의 em-dash — 이 게이트의 존재 이유(#1138 B2)",
    src: 'export const NOTE = "지금은 보낼 수 없습니다 — 다시 연결되면 여기서 보냅니다";',
  },
  {
    want: [],
    file: "features/x/copy.ts",
    why: "줄 앞 주석의 같은 글자 — 산문은 이 낱말을 계속 써야 한다",
    src: '// 지금은 보낼 수 없습니다 — 다시 연결되면 여기서\nexport const NOTE = "지금은 보낼 수 없습니다";',
  },
  {
    want: [],
    file: "features/x/copy.ts",
    why: "독스트링의 같은 글자",
    src: '/**\n * 오프라인 문장 — 컴포저에만 있는 절이다.\n */\nexport const NOTE = "지금은 보낼 수 없습니다";',
  },
  {
    want: [],
    file: "features/x/copy.ts",
    why: "코드 뒤에 붙은 주석 — (A) 줄 기반이 오탐하는 자리 ①",
    src: 'export const NOTE = "지금은 보낼 수 없습니다"; // 여기 — 이렇게 적으면 안 된다',
  },
  {
    want: [],
    file: "features/x/copy.ts",
    why: "별표로 시작하지 않는 블록 주석 속줄 — (A) 줄 기반이 오탐하는 자리 ②",
    src: 'export const NOTE = "ok";\n/*\n인용 부호 안의 대시 "— 이렇게" 도 여기서는 산문이다\n*/',
  },
  {
    want: ["emdash"],
    file: "features/x/copy.ts",
    why: "여러 줄 템플릿 리터럴 — (A) 줄 기반이 미탐하는 자리(한 줄 정규식이 못 넘는다)",
    src: "export const NOTE = `첫 줄\n둘째 줄 — 여기에 대시가 있다`;",
  },
  {
    want: ["emdash"],
    file: "features/x/copy.ts",
    why: "치환이 섞인 템플릿의 글자 부분",
    src: "export const line = (n: string) => `${n} 님 — 지금 작업 중입니다`;",
  },
  {
    want: [],
    file: "features/x/copy.test.ts",
    why: "테스트 이름은 표면을 인용한다 — 실측 72건 중 70건이 이 모양이었다",
    src: 'it("오프라인 문장 모양을 지킨다 — 지금 못 하는 것 → 다시 연결되면", () => {});',
  },
  {
    want: [],
    file: "features/x/copy.ts",
    why: "허용 마커가 달린 줄 — 렌더되지 않는다고 문서에 적힌 문자열",
    src: 'export const MEASURED = "라우터에 있음 — 2026-08-04 실측"; // design-preflight-allow',
  },
  {
    want: [],
    file: "features/x/copy.ts",
    why: "허용 마커가 그 칸의 머리 주석에 있어도 같다 — 사유를 적을 자리가 필요하다",
    src:
      "export const TABLE = {\n" +
      "  // 실측 근거. 화면에 나가지 않는다. design-preflight-allow\n" +
      '  measured:\n    "셋 다 등록됨 — " +\n    "GET …/approvals",\n' +
      "};",
  },
  {
    want: ["emdash"],
    file: "features/x/copy.ts",
    why: "옆 칸의 마커가 이 칸까지 덮지는 않는다",
    src:
      "export const TABLE = {\n" +
      "  // design-preflight-allow\n" +
      '  measured: "셋 다 등록됨 — GET …/approvals",\n' +
      '  fallback: "채널을 열어 직접 찾아보세요 — 지금은 그것뿐입니다",\n' +
      "};",
  },
  {
    want: ["raw_color"],
    file: "features/x/tone.ts",
    why: "코어가 색 값을 문자열로 들고 있다",
    src: 'export const UNREAD = "#a54c08";',
  },
  {
    want: ["raw_color"],
    file: "features/x/tone.ts",
    why: "함수형 색도 같다",
    src: 'export const VEIL = "rgba(12, 18, 28, 0.2)";',
  },
  {
    want: [],
    file: "features/x/tone.ts",
    why: "문자열 속 이슈 번호는 색이 아니다 — 웹 raw_color 와 같은 판정",
    src: 'export const NOTE = "부분 복원 고지 (ADR-0154 D3, #1137)";',
  },
  {
    want: ["raw_color"],
    file: "features/x/tone.ts",
    why: "한 문자열에 둘 다 있으면 색이 남는다",
    src: 'export const NOTE = "#1137 이 금지한 색이 바로 이것이다: #1a2740";',
  },
  {
    want: [],
    file: "features/x/tone.ts",
    why: "모듈 지정자는 사람이 읽는 글이 아니다",
    src: 'import { x } from "./a-b-c-color-1234";\nexport const y = x;',
  },
  {
    want: ["hype"],
    file: "features/x/copy.ts",
    why: "과장 어휘도 사용자 문장의 문제다",
    src: 'export const NOTE = "손쉽게 이어서 작업하세요";',
  },
];

function runSelftest() {
  const failures = runCases(
    ts,
    CORE_SRC,
    SELFTEST_CASES.map((c) => ({ ...c, categories: CATEGORIES })),
    "core string-literal separation rule self-test"
  );
  console.log("");
  if (failures > 0) {
    console.log("RESULT: FAIL, the core separation rule does not hold.");
    return 1;
  }
  console.log(
    `RESULT: PASS, ${SELFTEST_CASES.length} cases — 렌더 문자열은 잡히고 주석·테스트 이름은 통과한다.`
  );
  return 0;
}

// ---- 진입 -------------------------------------------------------------------

const mode = process.argv[2] ?? "";
if (mode === "--selftest") {
  process.exit(runSelftest());
}
if (mode === "--help" || mode === "-h") {
  console.log("usage: node scripts/design_preflight_core.mjs [--list|--selftest]");
  console.log("  (no args)  packages/momo-core/src 의 렌더 문자열 하드 제로 검사");
  console.log("  --list     현재 적중 전부 출력, 게이트 안 함");
  console.log("  --selftest 주석/테스트/렌더 문자열 분리 규칙을 케이스로 증명");
  process.exit(0);
}
if (mode !== "" && mode !== "--list") {
  console.error(`unknown argument: ${mode} (see --help)`);
  process.exit(2);
}

const hits = scanCore();

if (mode === "--list") {
  console.log("== design pre-flight (core): all current hits ==");
  for (const category of CATEGORIES) {
    const mine = hits.filter((h) => h.key === category.key);
    console.log(`-- ${category.key} (${mine.length}): ${category.rule}`);
    for (const h of mine) console.log(`   ${h.file}:${h.line}: ${h.text}`);
  }
  process.exit(0);
}

console.log("== design pre-flight (core), 이슈 #1141 ==");
console.log("   scanned: packages/momo-core/src (문자열 리터럴 노드만, *.test.ts 제외)");
console.log(`   excluded: 주석·독스트링(AST가 보지 않는다), *.test.ts, ${ALLOW_MARKER} 줄`);
console.log("");

let failed = false;
for (const category of CATEGORIES) {
  const mine = hits.filter((h) => h.key === category.key);
  if (mine.length > 0) {
    console.log(`FAIL  ${category.key}: ${mine.length} hit(s)`);
    console.log(`        rule: ${category.rule}`);
    for (const h of mine) console.log(`          ${h.file}:${h.line}: ${h.text}`);
    failed = true;
  } else {
    console.log(`OK    ${category.key}: 0`);
  }
}

console.log("");
if (failed) {
  console.log("RESULT: FAIL, 코어의 사용자 가시 문자열에 위반이 있다.");
  console.log("  두 클라가 이 문자열을 그대로 렌더한다 — 여기서 고치면 두 화면이 함께 낫는다.");
  console.log(`  렌더되지 않는 문자열이라면 그 줄에 ${ALLOW_MARKER} 마커를 달고 PR 본문에 근거를 적는다.`);
  process.exit(1);
}
console.log(`RESULT: PASS, ${CATEGORIES.length}/${CATEGORIES.length} categories clean.`);
process.exit(0);
