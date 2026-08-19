#!/usr/bin/env node
// =============================================================================
// design_preflight_web_strings.mjs — 웹 클라의 em-dash 검사 (이슈 #1141 완결).
//
// `scripts/design_preflight_web.sh` 의 `emdash` 분류가 부르는 단계다. 단독으로도
// 돈다.
//
// ## 왜 줄 기반에서 AST 로 옮겼나
//
// 웹 pre-flight 의 emdash 는 「따옴표 쌍 안에 대시가 있는 줄」을 찾고 주석처럼
// 보이는 줄을 뒤에서 걷어내는 방식이었다(`grep -E '"[^"]*—[^"]*"' | drop_comment_lines`).
// 그 판정이 실제로 세운 숫자가 base 빨강 12건이었는데, 건별로 보면 이렇다:
//
//   · 10건 = `describe`/`it` 의 **테스트 이름** (composerCopy·navigation·spacing)
//   ·  1건 = JSX 주석 안의 산문 (`TypingLine.tsx:188`)
//   ·  1건 = 진짜 프로덕션 문자열 (`spacing.ts` 의 throw 문구)
//
// 즉 11/12 가 오탐이었다. #1171 이 코어에 대해 같은 실측(72건 중 70건이 테스트
// 이름)을 하고 AST 를 골랐고, 여기서 그 도구를 그대로 쓴다. 규칙과 세 후보의
// 비교 근거는 `scripts/design_preflight_core.mjs` 머리말, 구현은
// `scripts/design_preflight_ast.mjs`.
//
// ## 옮기면서 늘어난 것 하나
//
// 줄 기반은 **따옴표가 있는 것만** 볼 수 있었다. 그런데 웹에서 사람이 읽는 글자
// 상당수는 따옴표 없이 태그 사이에 놓인다:
//
//     <p>지금은 보낼 수 없습니다 — 다시 연결되면 여기서 보냅니다</p>
//
// 이 모양을 옛 판정은 한 번도 본 적이 없다. AST 는 JsxText 를 노드로 주므로
// 공짜로 잡힌다 — 오탐 11 을 없애면서 미탐 한 종류가 함께 닫힌다. selftest 가
// 그 자리를 케이스로 들고 있다.
//
// ## 웹은 왜 emdash 하나인가
//
// 나머지 아홉 분류(raw_color·inline_style·arbitrary_tw·…)는 클래스 이름·CSS·
// 마크업에 대한 검사라 문자열 리터럴 노드가 답할 수 있는 질문이 아니다. 특히
// raw_color 는 `.css` 를 훑어야 하는데 CSS 에는 TS AST 가 없다. 그쪽은 줄 기반이
// 옳은 자리이므로 그대로 두었다(웹 raw_color 판별자의 11 케이스 selftest 도 그대로).
//
// 사용:
//   node scripts/design_preflight_web_strings.mjs            검사 (0 통과 / 1 위반)
//   node scripts/design_preflight_web_strings.mjs --emit     적중을 `파일:줄: 글` 로만 출력(게이트 안 함)
//   node scripts/design_preflight_web_strings.mjs --list     --emit 과 같되 머리말을 붙인다
//   node scripts/design_preflight_web_strings.mjs --selftest 분리 규칙을 케이스로 증명
// =============================================================================

import { readFileSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOW_MARKER,
  EMDASH_CATEGORY,
  LATIN_PARTICLE_CATEGORY,
  PROGRESS_WORD_CATEGORY,
  loadTypeScript,
  runCases,
  scanSource,
  shipsStrings,
  walk,
} from "./design_preflight_ast.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const WEB_SRC = join(REPO_ROOT, "clients/web/src");

// emdash 하나로 시작한 파일이지만(#1141), 낱말꼴 게이트(#1511)가 같은 판정
// (렌더 문자열만, 주석·테스트 이름 제외)을 필요로 해서 분류가 셋이 됐다.
// 쉘(design_preflight_web.sh)은 --emit 의 `key|` 접두로 셋을 가른다.
const CATEGORIES = [EMDASH_CATEGORY, PROGRESS_WORD_CATEGORY, LATIN_PARTICLE_CATEGORY];

const ts = loadTypeScript(REPO_ROOT, [
  join(REPO_ROOT, "clients/web/node_modules/typescript"),
]);
if (!ts) {
  console.error(
    "design pre-flight (web strings): typescript 를 찾지 못했다.\n" +
      "  npm ci  또는  npm --prefix clients/web install  먼저."
  );
  process.exit(2);
}

function scanWeb() {
  if (!existsSync(WEB_SRC)) {
    console.error(`design pre-flight (web strings): ${WEB_SRC} 없음 (momo 레포에서 실행)`);
    process.exit(2);
  }
  const results = [];
  for (const file of walk(WEB_SRC).filter(shipsStrings)) {
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
// 케이스마다 「있을 법한 웹 소스 한 조각 + 받아야 하는 판정」이다. 옛 줄 기반이
// 틀렸을 자리에는 그렇게 적어 두었고, 그 표가 곧 이관의 근거다. 12건 부채의 세
// 모양(테스트 이름 · JSX 주석 · 진짜 문자열)이 전부 여기 있다.
const SELFTEST_CASES = [
  {
    want: ["emdash"],
    file: "features/chat/copy.ts",
    why: "렌더되는 문자열의 em-dash — 이 분류의 존재 이유(#1138 B2)",
    src: 'export const NOTE = "지금은 보낼 수 없습니다 — 다시 연결되면 여기서 보냅니다";',
  },
  {
    want: ["emdash"],
    file: "features/chat/Line.tsx",
    why: "따옴표 없는 JSX 텍스트 — 줄 기반이 **한 번도 못 보던** 자리",
    src: "export const L = () => <p>지금은 보낼 수 없습니다 — 다시 연결되면</p>;",
  },
  {
    want: ["emdash"],
    file: "features/chat/Line.tsx",
    why: "여러 줄에 걸친 JSX 텍스트도 같다",
    src: "export const L = () => (\n  <p>\n    지금은 보낼 수 없습니다 — 다시\n    연결되면 여기서 보냅니다\n  </p>\n);",
  },
  {
    want: ["emdash"],
    file: "features/chat/Line.tsx",
    why: "속성 문자열은 낭독 라벨로 나간다",
    src: 'export const L = () => <button aria-label="다시 보내기 — 지금" />;',
  },
  {
    want: [],
    file: "features/chat/Line.tsx",
    why: "JSX 주석의 산문 — 옛 판정이 오탐하던 자리(TypingLine.tsx:188 이 이 모양)",
    src:
      "export const L = () => (\n" +
      "  <p>\n" +
      "    {/* `title`로는 이 치환이 일어나지 않았다 — 역할 없는 `<p>`의 접근 이름은\n" +
      "        텍스트 콘텐츠에서 나온다. */}\n" +
      "    <span className=\"sr-only\">ok</span>\n" +
      "  </p>\n" +
      ");",
  },
  {
    want: [],
    file: "features/chat/copy.ts",
    why: "줄 앞 주석의 같은 글자 — 산문은 이 낱말을 계속 써야 한다",
    src: '// 지금은 보낼 수 없습니다 — 다시 연결되면 여기서\nexport const NOTE = "지금은 보낼 수 없습니다";',
  },
  {
    want: [],
    file: "features/chat/copy.ts",
    why: "코드 뒤에 붙은 주석 — 옛 판정이 오탐하던 자리",
    src: 'export const NOTE = "지금은 보낼 수 없습니다"; // 여기 — 이렇게 적으면 안 된다',
  },
  {
    want: [],
    file: "features/chat/copy.ts",
    why: "독스트링의 같은 글자",
    src: '/**\n * 오프라인 문장 — 컴포저에만 있는 절이다.\n */\nexport const NOTE = "지금은 보낼 수 없습니다";',
  },
  {
    want: ["emdash"],
    file: "features/chat/copy.ts",
    why: "여러 줄 템플릿 리터럴 — 한 줄 정규식이 못 넘어 옛 판정이 미탐하던 자리",
    src: "export const NOTE = `첫 줄\n둘째 줄 — 여기에 대시가 있다`;",
  },
  {
    want: ["emdash"],
    file: "features/chat/copy.ts",
    why: "치환이 섞인 템플릿의 글자 부분",
    src: "export const line = (n: string) => `${n} 님 — 지금 작업 중입니다`;",
  },
  {
    want: [],
    file: "features/timeline/navigation.test.ts",
    why: "테스트 이름은 표면을 인용한다 — 실측 12건 중 10건이 이 모양이었다",
    src: 'it("저자를 모르면 빼지 않는다 — 남의 말을 놓치는 쪽이 더 나쁘다", () => {});',
  },
  {
    want: [],
    file: "features/chat/Composer.test.tsx",
    why: "`.tsx` 테스트도 같다 — 확장자가 아니라 성격이 기준이다",
    src: 'it("오프라인 배너 모양을 지킨다 — 지금 못 하는 것 → 다시 연결되면", () => {});',
  },
  {
    want: [],
    file: "features/chat/copy.ts",
    why: "허용 마커가 달린 줄 — 렌더되지 않는다고 문서에 적힌 문자열",
    src: 'export const MEASURED = "라우터에 있음 — 2026-08-04 실측"; // design-preflight-allow',
  },
  {
    want: ["emdash"],
    file: "features/chat/Line.tsx",
    why: "옆 속성의 마커가 이 속성까지 덮지는 않는다",
    src:
      "export const L = () => (\n" +
      "  <button\n" +
      '    data-note="계측용 — 렌더 안 됨" // design-preflight-allow\n' +
      '    aria-label="다시 보내기 — 지금"\n' +
      "  />\n" +
      ");",
  },
  {
    want: [],
    file: "features/chat/copy.ts",
    why: "모듈 지정자는 사람이 읽는 글이 아니다",
    src: 'import { x } from "./a-b-c-dash-1234";\nexport const y = x;',
  },
  {
    want: [],
    file: "api/schema.d.ts",
    why: "생성 타입은 사람이 쓴 글이 아니다",
    src: 'export type T = { note: "생성기가 적은 것 — 손으로 고치지 않는다" };',
  },
  // ---- progress_word (#1511) ------------------------------------------------
  {
    want: ["progress_word"],
    file: "features/settings/copy.ts",
    why: "한자어 동작명사의 「-하는 중」 — 이 분류의 존재 이유(#1501 정본)",
    src: 'export const BUSY = "저장하는 중";',
  },
  {
    want: ["progress_word"],
    file: "features/auth/copy.ts",
    why: "말줄임표가 동행해도 같은 위반이다 (ConnectPage 가 이 모양이었다)",
    src: 'export const BUSY = "참여하는 중…";',
  },
  {
    want: ["progress_word"],
    file: "features/work/copy.ts",
    why: "치환 꼬리의 진행 낱말 — HostPicker busy 접근성 이름이 이 모양이었다",
    src: "export const busy = (name: string) => `${name}에서 인수하는 중`;",
  },
  {
    want: [],
    file: "features/plugins/copy.ts",
    why: "문장 꼴 「-하는 중입니다」는 옳다 (#1509 이탈 7 — 라벨 대체가 아니라 문장)",
    src: 'export const NOTE = "관리자 권한을 확인하는 중입니다.";',
  },
  {
    want: [],
    file: "features/work/copy.ts",
    why: "고유어 어간 허용표(NATIVE_HANEUN_STEMS) — 「생각 중」이 아니라 이 꼴이 맞다",
    src: 'export const THINKING = "생각하는 중";',
  },
  {
    want: [],
    file: "features/work/copy.ts",
    why: "고유어 동사의 「-는 중」은 애초에 「-하는 중」 꼴이 아니다",
    src: 'export const ISSUING = "관전 권한을 받는 중";',
  },
  // ---- latin_particle (#1511 편입 — #1560 M①) -------------------------------
  {
    want: ["latin_particle"],
    file: "features/work/copy.ts",
    why: "라틴 낱말과 조사 사이의 공백 — break-keep 아래서 조사가 줄머리 고아가 된다",
    src: 'export const NOTE = "Esc 는 호스트로 가지 않습니다.";',
  },
  {
    want: ["latin_particle"],
    file: "features/work/copy.ts",
    why: "두 글자 조사(으로)도 같다 — CONTROL_KEYBOARD_LOST_COPY 가 이 모양이었다",
    src: 'export const NOTE = "화면을 한 번 누르거나 Tab 으로 이 화면에 오면 다시 이어집니다.";',
  },
  {
    want: [],
    file: "features/chat/copy.ts",
    why: "붙여 쓴 조사가 정답이다 (composerCopy 「Esc로 취소」)",
    src: 'export const HINT = "Esc로 취소";',
  },
  {
    want: [],
    file: "features/settings/copy.ts",
    why: "조사가 아니라 낱말의 첫 글자 — 뒤가 한글이면 조사 판정이 아니다",
    src: 'export const LABEL = "API 이름을 적으세요";',
  },
];

function runSelftest() {
  const failures = runCases(
    ts,
    WEB_SRC,
    SELFTEST_CASES.map((c) => ({ ...c, categories: CATEGORIES })),
    "web string-literal / JSX separation rule self-test"
  );
  console.log("");
  if (failures > 0) {
    console.log("RESULT: FAIL, the web separation rule does not hold.");
    return 1;
  }
  console.log(
    `RESULT: PASS, ${SELFTEST_CASES.length} cases — 렌더 문자열·JSX 텍스트는 잡히고 주석·테스트 이름은 통과한다.`
  );
  return 0;
}

// ---- 진입 -------------------------------------------------------------------

const mode = process.argv[2] ?? "";
if (mode === "--selftest") {
  process.exit(runSelftest());
}
if (mode === "--help" || mode === "-h") {
  console.log("usage: node scripts/design_preflight_web_strings.mjs [--emit|--list|--selftest]");
  console.log("  (no args)  clients/web/src 렌더 문자열의 emdash·progress_word·latin_particle 하드 제로 검사");
  console.log("  --emit     적중을 `key|파일:줄: 글` 한 줄씩만 출력(게이트 안 함) — 쉘이 세는 형식");
  console.log("  --list     분류별 머리말을 붙여 출력");
  console.log("  --selftest 주석·JSX 주석·테스트 이름과 렌더 문자열의 분리를 케이스로 증명");
  process.exit(0);
}
if (mode !== "" && mode !== "--emit" && mode !== "--list") {
  console.error(`unknown argument: ${mode} (see --help)`);
  process.exit(2);
}

const hits = scanWeb();

if (mode === "--emit") {
  // 쉘(design_preflight_web.sh)이 분류별로 세는 형식: `key|파일:줄: 글`.
  for (const h of hits) console.log(`${h.key}|${h.file}:${h.line}: ${h.text}`);
  process.exit(0);
}

if (mode === "--list") {
  for (const category of CATEGORIES) {
    const mine = hits.filter((h) => h.key === category.key);
    console.log(`== design pre-flight (web strings): ${category.key} (${mine.length}) ==`);
    for (const h of mine) console.log(`   ${h.file}:${h.line}: ${h.text}`);
  }
  process.exit(0);
}

console.log("== design pre-flight (web strings), 이슈 #1141·#1511 ==");
console.log("   scanned: clients/web/src (문자열 리터럴·JSX 텍스트 노드만, *.test.ts(x) 제외)");
console.log(`   excluded: 주석·JSX 주석(AST가 보지 않는다), *.test.ts(x), *.d.ts, ${ALLOW_MARKER}`);
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
  console.log("RESULT: FAIL, 웹의 사용자 가시 문자열에 위반이 있다.");
  process.exit(1);
}
console.log(`RESULT: PASS, 웹 렌더 문자열 ${CATEGORIES.length}/${CATEGORIES.length} 분류 clean.`);
process.exit(0);
