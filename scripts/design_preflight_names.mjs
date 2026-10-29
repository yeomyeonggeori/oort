#!/usr/bin/env node
// =============================================================================
// design_preflight_names.mjs — 시험 고정값·측정 하네스의 실명 재유입 검사 (이슈 #4632).
//
// `scripts/design_preflight_web.sh` 가 부르는 한 단계다(웹 pre-flight 의 코어 단계
// 바로 뒤). 단독으로도 돈다. `gate:copy`(packages/momo-core) 도 같은 파일을 부른다.
//
// ## 왜 있나
//
// 이 레포는 **공개**다. 시험 고정값·하네스·캡처 스크립트에 실제 팀원 이름이 들어가면
// 그대로 공개된다. #4458 에서 코어 스트레스 로스터의 실명 두 건이 폰 캡처에 찍힐 뻔했고,
// 하네스가 「순서로 덮기」 우회로 그것을 가렸다. 이 단계는 그 부류를 기계로 내린다.
//
// ## 금지 목록 자체가 실명이 되지 않게 — 평문 목록을 두지 않는다
//
// 목록은 `design_preflight_names.digests` 의 **SHA-256** 뿐이다(NFC·소문자 정규화 뒤
// 솔트 접두). 검사기는 대상 텍스트에서 후보 낱말을 뽑아 같은 해시를 계산해 맞춘다.
//   · 한글(h<길이>): 한글 연속 음절의 모든 부분 문자열. 조사가 붙어도(「…님이」) 잡힌다.
//   · 영문(l<길이>): 영문자 덩어리를 비영문자·카멜 경계로 쪼갠 **한 토막 전체**.
//     `handle`·`HANDLE_ID`·`name-claude`·`name@host` 는 걸리고, 더 긴 소문자 한 덩이
//     (공개된 GitHub 로그인 같은 것)는 토막이 다르므로 걸리지 않는다.
// 출력은 파일:줄과 해시 앞 8자리 표지만 찍는다. **적중한 글자는 절대 출력하지 않는다**
// (CI 로그가 목록의 복사본이 되지 않게).
//
// 한계(PR 본문에도 적는다): 2~3음절 한국 이름은 해시만으로 사전 대입이 가능하다. 이 방식이
// 주는 것은 「새 평문 목록을 공개 레포에 남기지 않는다」이지 비밀 보장이 아니다. 목록에
// 오른 이름들은 이미 공개 이력에 있는 것들이다. 새 이름은 `--mint` 로 해시만 더한다.
//
// ## 무엇을 훑나 — 코어 `*.test.ts` 를 **제외하지 않는다**
//
// `design_preflight_core.mjs` 는 테스트 파일을 통째로 뺀다(테스트가 인용한 낱말은
// 표면을 인용한 것이지 만든 것이 아니라서). 이름은 반대다: 실명이 새는 자리가 바로
// 테스트 고정값이다. 그래서 별도 단계이고, **주석·식별자·문자열 전부**를 같은 규칙으로 본다.
//
// 훑는 범위는 아래 `SCOPE` 한 곳이다. #4632 가 정리한 트리만 넣었다: 정리하지 않은 트리를
// 넣으면 첫날부터 붉다. 후속 정리(웹·폰 시험 고정값)가 끝난 트리를 거기에 더한다.
//
// ## 「안 돈 것」과 「초록」을 구분한다
//
// 해시 집합이 비었거나, 훑은 파일이 0개거나, 범위의 폴더가 없으면 통과가 아니라
// **종료 코드 2**다(두 pre-flight 머리말이 닫아 온 구멍과 같다).
//
// 사용:
//   node scripts/design_preflight_names.mjs                 검사 (0 통과 / 1 위반 / 2 못 돌림)
//   node scripts/design_preflight_names.mjs --list          적중 전부(표지만), 게이트 안 함
//   node scripts/design_preflight_names.mjs --selftest      가짜 이름으로 판별 규칙을 증명
//   node scripts/design_preflight_names.mjs --mint - < 파일  새 금지 낱말의 해시 줄을 만든다
//                                                            (평문은 stdin 으로만, 인자로 주지 않는다)
// 오탐은 그 줄에 `design-preflight-allow` 마커(웹 pre-flight 와 같은 것)를 달고 PR 본문에 사유를 적는다.
// =============================================================================

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DIGEST_FILE = resolve(HERE, "design_preflight_names.digests");

// ---- 범위 -------------------------------------------------------------------
//
// 넓힐 때: 후속 정리가 끝난 트리를 여기에 더한다(예: clients/mobile/__tests__,
// clients/web/src, clients/web/scripts). 정리 전 트리를 넣으면 붉다.
export const SCOPE = ["packages/momo-core/src", "clients/mobile/measure"];

// 값을 바꿀 수 없는 파일. 경로가 정확히 같을 때만 면제한다.
export const EXEMPT = new Map([
  [
    "packages/momo-core/src/features/auth/__fixtures__/human-control-signing-v4.vectors.json",
    "서명 벡터: 같은 바이트를 docs/api·모바일 사본·Rust 시험이 함께 서명/검증한다. 값을 바꾸면 서명이 깨진다(재서명 후속 이슈).",
  ],
]);

const TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|ya?ml|sh|md|txt|html|css)$/i;
const ALLOW_MARKER = "design-preflight-allow";
const SALT = "oort/fixture-names/v1\0";

// ---- 해시와 후보 -------------------------------------------------------------

const normalize = (s) => s.normalize("NFC").toLowerCase();
const digestOf = (term) => createHash("sha256").update(SALT + normalize(term)).digest("hex");

/** `h3 <hex>` / `l8 <hex>` 줄들을 읽는다. 주석(#)·빈 줄은 무시. */
export function parseDigests(text) {
  const entries = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([hl])(\d+)\s+([0-9a-f]{64})$/.exec(line);
    if (!m) throw new Error(`design_preflight_names: 해시 줄 형식 오류: ${raw.slice(0, 20)}…`);
    entries.push({ kind: m[1], len: Number(m[2]), hex: m[3] });
  }
  return entries;
}

/** 평문 낱말에서 해시 줄을 만든다(`--mint` 와 selftest 의 가짜 이름이 쓴다). */
export function mintEntry(term) {
  const t = normalize(term.trim());
  if (/^[가-힣]{2,}$/.test(t)) return { kind: "h", len: t.length, hex: digestOf(t) };
  if (/^[a-z]{4,}$/.test(t)) return { kind: "l", len: t.length, hex: digestOf(t) };
  throw new Error("낱말은 한글 2음절 이상 또는 영문 소문자 4자 이상만 받는다(섞인 낱말은 나눠서).");
}

const SPLIT_CAMEL = /(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;

function decodeEscapes(line) {
  // JSON·JS 문자열의 \uXXXX · \u{…} 를 풀어 읽는다(이스케이프로 적힌 이름을 놓치지 않으려고).
  return line
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (m, h) => {
      const cp = parseInt(h, 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** 한 줄의 적중 목록(해시 앞 8자리 표지). 글자는 돌려주지 않는다. */
export function scanLine(rawLine, index) {
  if (rawLine.includes(ALLOW_MARKER)) return [];
  const line = decodeEscapes(rawLine).normalize("NFC");
  const hits = [];
  for (const run of line.match(/[가-힣]+/g) ?? []) {
    for (const len of index.hangulLens) {
      for (let i = 0; i + len <= run.length; i++) {
        const id = index.hangul.get(digestOf(run.slice(i, i + len)));
        if (id) hits.push(`h${len}·${id}`);
      }
    }
  }
  for (const word of line.match(/[A-Za-z]+/g) ?? []) {
    for (const piece of word.split(SPLIT_CAMEL)) {
      if (piece.length < 4 || !index.latinLens.has(piece.length)) continue;
      const id = index.latin.get(digestOf(piece));
      if (id) hits.push(`l${piece.length}·${id}`);
    }
  }
  return hits;
}

/** 해시 집합을 검사용 색인으로. 비어 있으면 던진다(안 돈 것이 초록이 되지 않게). */
export function buildIndex(entries) {
  if (!entries.length) throw new Error("해시 집합이 비어 있다");
  const hangul = new Map();
  const latin = new Map();
  for (const e of entries) (e.kind === "h" ? hangul : latin).set(e.hex, e.hex.slice(0, 8));
  const lens = (kind) => new Set(entries.filter((e) => e.kind === kind).map((e) => e.len));
  return {
    hangul,
    latin,
    hangulLens: [...lens("h")].sort((a, b) => a - b),
    latinLens: lens("l"),
  };
}

/** 텍스트 한 덩이의 적중: [{line, id}] */
export function scanText(text, index) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    for (const id of scanLine(line, index)) out.push({ line: i + 1, id });
  });
  return out;
}

// ---- 파일 훑기 ---------------------------------------------------------------

function listScopeFiles() {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...SCOPE],
    { cwd: REPO_ROOT, maxBuffer: 1 << 28 }
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  return out.filter((f) => TEXT_FILE.test(f));
}

function loadIndex() {
  if (!existsSync(DIGEST_FILE)) throw new Error(`${DIGEST_FILE} 없음`);
  return buildIndex(parseDigests(readFileSync(DIGEST_FILE, "utf8")));
}

function runScan() {
  for (const root of SCOPE) {
    if (!existsSync(resolve(REPO_ROOT, root))) throw new Error(`범위 폴더가 없다: ${root}`);
  }
  const index = loadIndex();
  const files = listScopeFiles();
  if (files.length === 0) throw new Error("훑은 파일이 0개다 (범위 설정 오류)");
  const results = [];
  let exempt = 0;
  for (const file of files) {
    if (EXEMPT.has(file)) {
      exempt++;
      continue;
    }
    for (const hit of scanText(readFileSync(resolve(REPO_ROOT, file), "utf8"), index)) {
      results.push({ file, ...hit });
    }
  }
  return { results, scanned: files.length, exempt, entries: index.hangul.size + index.latin.size };
}

// ---- 자기 증명 ---------------------------------------------------------------
//
// 규칙을 케이스로 든다. 이름은 **가짜**(홍길동·gildong)를 쓰고, 실제 목록은 건드리지 않는다.
const DECOYS = ["홍길동", "gildong"];

function selftest() {
  const index = buildIndex(DECOYS.map(mintEntry));
  const HONG = "홍길동";
  const cases = [
    { want: 1, why: "문자열 안의 이름", src: `displayName: "${HONG}",` },
    { want: 1, why: "조사가 붙어도 잡는다", src: `"${HONG}님이 작성 중…"` },
    { want: 1, why: "주석에서도 잡는다(이름은 어디에도 두지 않는다)", src: `// ${HONG} 실측` },
    { want: 1, why: "\\u 이스케이프로 적어도 잡는다(JSON 벡터)", src: '"\\ud64d\\uae38\\ub3d9"' },
    { want: 1, why: "영문 핸들", src: 'handle: "gildong",' },
    { want: 1, why: "대문자 상수 이름", src: "const GILDONG = ID_1;" },
    { want: 1, why: "카멜 덩이의 한 토막", src: "const gildongId = 1;" },
    { want: 1, why: "카멜 덩이(앞 토막)", src: "const GildongHong = 1;" },
    { want: 1, why: "하이픈으로 이은 핸들", src: '"gildong-claude 빌드 봐 줘"' },
    { want: 1, why: "이메일 로컬 파트", src: 'login("gildong@example.com")' },
    { want: 0, why: "더 긴 소문자 한 덩이는 다른 토막이다(공개 로그인이 이래서 통과한다)", src: "/Users/xxgildong/projects" },
    { want: 0, why: "2음절 부분은 목록에 없으면 통과(이름만 금지한 게 아니다)", src: '"길동 맥북"' },
    { want: 0, why: "가상 인물은 통과", src: 'displayName: "이도현", handle: "dohyun" // 박서연 최민수 정하윤' },
    { want: 0, why: "허용 마커가 달린 줄", src: `"${HONG}" // ${ALLOW_MARKER}` },
  ];
  let bad = 0;
  for (const c of cases) {
    const got = scanText(c.src, index).length;
    const ok = got === c.want;
    if (!ok) bad++;
    console.log(`${ok ? "OK  " : "FAIL"}  want=${c.want} got=${got}  ${c.why}`);
  }
  // 빈 해시 집합은 통과가 아니라 던진다.
  let threw = false;
  try {
    buildIndex([]);
  } catch {
    threw = true;
  }
  console.log(`${threw ? "OK  " : "FAIL"}  빈 해시 집합은 던진다(안 돈 것은 초록이 아니다)`);
  if (!threw) bad++;
  // 실제 목록이 비었거나 깨지지 않았음을 값 없이 증명한다.
  let live = 0;
  try {
    live = loadIndex().hangul.size + loadIndex().latin.size;
  } catch (e) {
    console.log(`FAIL  실제 해시 목록을 못 읽었다: ${e.message}`);
    bad++;
  }
  if (live > 0) console.log(`OK    실제 해시 목록 ${live}항목 (값은 찍지 않는다)`);
  else if (!bad) bad++;
  return bad === 0 ? 0 : 1;
}

// ---- 진입 --------------------------------------------------------------------

function main(argv) {
  const mode = argv[0] ?? "";
  if (mode === "--selftest") return selftest();
  if (mode === "--mint") {
    // 평문은 stdin 으로만 받는다: 인자로 받으면 셸 기록·프로세스 목록에 이름이 남는다.
    if (argv[1] !== "-" || argv.length !== 2) {
      console.error("usage: node scripts/design_preflight_names.mjs --mint -   (낱말은 stdin 한 줄에 하나)");
      return 2;
    }
    for (const t of readFileSync(0, "utf8").split("\n").map((x) => x.trim()).filter(Boolean)) {
      const e = mintEntry(t);
      console.log(`${e.kind}${e.len} ${e.hex}`);
    }
    return 0;
  }
  if (mode !== "" && mode !== "--list") {
    console.error("usage: node scripts/design_preflight_names.mjs [--list|--selftest|--mint -]");
    return 2;
  }
  let scan;
  try {
    scan = runScan();
  } catch (e) {
    console.error(`design pre-flight (names): 돌리지 못했다. ${e.message}`);
    console.error("  (이 단계는 건너뛰지 않는다: 안 돈 것을 초록으로 세지 않기 위해서다)");
    return 2;
  }
  console.log("== design pre-flight (names), 이슈 #4632 ==");
  console.log(`   scanned: ${SCOPE.join(", ")} (테스트 포함, 주석·식별자·문자열 전부)`);
  console.log(`   files: ${scan.scanned}  exempt: ${scan.exempt}  digests: ${scan.entries}`);
  for (const [f, why] of EXEMPT) console.log(`   exempt: ${f} (${why})`);
  if (scan.results.length === 0) {
    console.log("OK    real_name: 0");
    console.log("RESULT: PASS, 실명 재유입 0 (적중한 글자는 어떤 경우에도 출력하지 않는다).");
    return 0;
  }
  console.log(`FAIL  real_name: ${scan.results.length} hit(s)`);
  console.log("        rule: 시험 고정값·하네스에 실제 사람 이름을 두지 않는다(가상 인물: 이도현·박서연·최민수·정하윤)");
  for (const r of scan.results) console.log(`          ${r.file}:${r.line}  [${r.id}]`);
  if (mode === "--list") return 0;
  console.log("RESULT: FAIL, 실명 재유입. 가상 인물로 바꾼다. 글자는 로그에 찍지 않는다.");
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
