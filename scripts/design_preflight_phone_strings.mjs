#!/usr/bin/env node
// =============================================================================
// design_preflight_phone_strings.mjs — 폰 클라의 낱말꼴 검사 (#1511 회전 1 M3).
//
// #1511 이 진행 낱말(`progress_word`)과 라틴 낱말 뒤 조사(`latin_particle`)를
// 기계로 내렸을 때, 코어까지 확장한 사유는 실측이었다: `CANCEL_BUSY_LABEL` 이
// 웹 게이트가 못 보는 코어 상수 자리에서 **폰까지 출하**됐다. 그런데 그렇게
// 말하고도 정작 **폰 자체의 리터럴**(`ConnectScreen` 의 busyLabel 처럼 코어를
// 거치지 않는 문자열)은 사각지대로 남았다.
//
// 지금 돌리면 0 이다. 그러나 「재고 있어서 0」과 「안 재서 0」은 다른 물건이고,
// 그 구분이 이 레포가 §5.5 에서 성문화한 규율이다. 이 파일은 그 0 을 **재서**
// 만든다.
//
// ## 왜 별도 파일인가 — 규칙은 여전히 한 벌이다
//
// 판정은 `design_preflight_ast.mjs` 의 같은 객체를 그대로 든다. 여기 있는 것은
// 「무엇을 훑는가」(clients/mobile/src)뿐이다. 웹·코어 소비자와 같은 구조다.
//
// ## 왜 쉘이 아니라 jest 가 부르는가
//
// `design_preflight_web.sh` 는 이름 그대로 웹의 실행 단위이고, 폰에는
// 「디자인 프리플라이트」라는 실행 단위가 없다 — 검사는 jest 안에 섞여 있고
// 그것이 병합 트리 게이트의 phone suite 레인으로 **돈다**(디자인 시스템 §5.4).
// 그래서 호출자는 `clients/mobile/__tests__/conversationHygiene.test.tsx` 이고,
// 그 스위트가 이 스크립트를 자식 프로세스로 돌린다. jest 는 이 `.mjs` 를 직접
// import 할 수 없다(react-native preset 이 node_modules 밖 ESM 을 변환하지
// 않는다) — 그 제약이 규칙을 베껴 적는 이유가 되면 안 되므로, 베끼는 대신 판정을
// 가진 프로세스를 부른다.
//
// ## emdash 를 여기서 걸지 않는 이유
//
// 폰의 em-dash 는 `conversationHygiene.test.tsx` 가 이미 `src/` 전수로 잡는다.
// 여기서 또 걸면 같은 위반이 두 번 세어지고, 어느 쪽이 정본인지 모르게 된다.
//
// 사용:
//   node scripts/design_preflight_phone_strings.mjs            검사 (0 통과 / 1 위반)
//   node scripts/design_preflight_phone_strings.mjs --emit     적중을 `key|파일:줄: 글` 로만 출력
// =============================================================================

import { readFileSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LATIN_PARTICLE_CATEGORY,
  PROGRESS_WORD_CATEGORY,
  loadTypeScript,
  scanSource,
  shipsStrings,
  walk,
} from "./design_preflight_ast.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const PHONE_SRC = join(REPO_ROOT, "clients/mobile/src");

const CATEGORIES = [PROGRESS_WORD_CATEGORY, LATIN_PARTICLE_CATEGORY];

const ts = loadTypeScript(REPO_ROOT, [
  join(REPO_ROOT, "clients/mobile/node_modules/typescript"),
  join(REPO_ROOT, "clients/web/node_modules/typescript"),
]);
if (!ts) {
  // 조용히 건너뛰지 않는다: 안 돈 것이 초록과 구별되지 않는 것이 이 레포가
  // 게이트마다 닫아 온 구멍이다.
  console.error(
    "design pre-flight (phone strings): typescript 를 찾지 못했다.\n" +
      "  npm ci  또는  npm --prefix clients/mobile install  먼저."
  );
  process.exit(2);
}

function scanPhone() {
  if (!existsSync(PHONE_SRC)) {
    console.error(
      `design pre-flight (phone strings): ${PHONE_SRC} 없음 (momo 레포에서 실행)`
    );
    process.exit(2);
  }
  const results = [];
  for (const file of walk(PHONE_SRC).filter(shipsStrings)) {
    for (const hit of scanSource(ts, file, readFileSync(file, "utf8"), CATEGORIES)) {
      results.push({ ...hit, file: relative(REPO_ROOT, file) });
    }
  }
  results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return results;
}

const mode = process.argv[2] ?? "";
if (mode !== "" && mode !== "--emit") {
  console.error("usage: node scripts/design_preflight_phone_strings.mjs [--emit]");
  process.exit(2);
}

const hits = scanPhone();

if (mode === "--emit") {
  for (const h of hits) console.log(`${h.key}|${h.file}:${h.line}: ${h.text}`);
  process.exit(0);
}

console.log("== design pre-flight (phone strings), 이슈 #1511 ==");
console.log(
  "   scanned: clients/mobile/src (문자열 리터럴·JSX 텍스트만, *.test.ts(x)·*.d.ts 제외)"
);
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
  console.log("RESULT: FAIL, 폰의 사용자 가시 문자열에 낱말꼴 위반이 있다.");
  process.exit(1);
}
console.log(`RESULT: PASS, 폰 렌더 문자열 ${CATEGORIES.length}/${CATEGORIES.length} 분류 clean.`);
process.exit(0);
