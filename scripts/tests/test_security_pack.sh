#!/usr/bin/env bash
# #4241 SEC-03: scripts/security_pack.sh lint 의 음성 대조. 진짜 레포 선택 목록은 초록이어야 하고,
# 임시 트리에 만든 깨진 선택 7종은 각각 빨강이며 **의도한 이유 문구**로 빨강이어야 한다.
set -euo pipefail
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
PACK="$REPO_ROOT/scripts/security_pack.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

"$PACK" lint >/dev/null || fail "진짜 선택 목록 lint 가 빨강"
# 진짜 선택 목록이 6개 영역 전부 + 28개 이상을 갖는다(빈 선택 초록 방지).
[ "$("$PACK" list | wc -l | tr -d ' ')" -ge 20 ] || fail "선택 타깃이 20개 미만"

# 임시 트리: 크레이트 하나, 시험 파일 둘(하나는 #[ignore] 없음).
mk_tree() {
  local r="$1"
  mkdir -p "$r/server-rust/crates/fake/tests" "$r/infra/security-pack"
  printf '[package]\nname = "fake"\n' > "$r/server-rust/crates/fake/Cargo.toml"
  printf '#[tokio::test]\n#[ignore]\nasync fn a() {}\n' > "$r/server-rust/crates/fake/tests/good_pg.rs"
  printf '#[tokio::test]\nasync fn a() {}\n' > "$r/server-rust/crates/fake/tests/noignore_pg.rs"
}
full_sel() {
  printf '%s\n' 'tenant-isolation fake good_pg' 'auth fake good_pg2' 'approval fake good_pg3' \
    'push fake good_pg4' 'attachment fake good_pg5' 'webhook fake good_pg6'
}
expect_red() { # <이름> <기대 문구> <선택 내용>
  local name="$1" want="$2" body="$3" r="$TMP/$1" out
  mk_tree "$r"
  for i in 2 3 4 5 6; do cp "$r/server-rust/crates/fake/tests/good_pg.rs" "$r/server-rust/crates/fake/tests/good_pg$i.rs"; done
  printf '%s\n' "$body" > "$r/infra/security-pack/selection.txt"
  if out="$(SECURITY_PACK_ROOT="$r" "$PACK" lint 2>&1)"; then fail "$name: 깨진 선택이 초록"; fi
  grep -Fq "$want" <<<"$out" || fail "$name: 다른 이유로 빨강 — $out"
}
# 대조군: 같은 임시 트리의 온전한 선택은 초록.
r="$TMP/control"; mk_tree "$r"
for i in 2 3 4 5 6; do cp "$r/server-rust/crates/fake/tests/good_pg.rs" "$r/server-rust/crates/fake/tests/good_pg$i.rs"; done
full_sel > "$r/infra/security-pack/selection.txt"
SECURITY_PACK_ROOT="$r" "$PACK" lint >/dev/null || fail "대조군(온전한 임시 선택)이 빨강"

expect_red missing-file "시험 파일이 없어요" "$(full_sel; echo 'auth fake nope_pg')"
expect_red no-ignore "#[ignore] 시험이 없어요" "$(full_sel; echo 'auth fake noignore_pg')"
expect_red unknown-package "패키지를 찾을 수 없어요" "$(full_sel; echo 'auth ghost good_pg')"
expect_red duplicate "중복 항목" "$(full_sel; echo 'auth fake good_pg')"
expect_red unknown-domain "알 수 없는 영역" "$(full_sel; echo 'billing fake good_pg')"
expect_red missing-domain "영역에 시험이 하나도 없어요: webhook" "$(full_sel | grep -v '^webhook')"
expect_red extra-column "열이 3개를 넘어요" "$(full_sel; echo 'auth fake good_pg extra')"
# ── 워크플로 배선(pr-ci.yml): 잡이 이름·이미지·단계·gate 연결을 유지하는지 ─────────────
WF="${SECURITY_PACK_WORKFLOW:-$REPO_ROOT/.github/workflows/pr-ci.yml}"
wired() { # <workflow 파일>
  local f="$1" job gate
  job="$(awk '/^  security_pack:$/{on=1;print;next} on&&/^  [a-z_]+:$/{exit} on{print}' "$f")"
  gate="$(awk '/^  gate:$/{on=1;print;next} on&&/^  [a-z_]+:$/{exit} on{print}' "$f")"
  [ -n "$job" ] && [ -n "$gate" ] || return 1
  grep -Fq '    name: Security pack' <<<"$job" || return 1
  grep -Fq 'image: pgvector/pgvector:pg18' <<<"$job" || return 1
  grep -Fq "if: needs.changes.outputs.rust == 'true'" <<<"$job" || return 1
  grep -Fq 'scripts/security_pack.sh setup' <<<"$job" || return 1
  grep -Fq 'scripts/security_pack.sh run' <<<"$job" || return 1
  grep -Fq 'scripts/security_pack.sh negative' <<<"$job" || return 1
  grep -Fq '      - security_pack' <<<"$gate" || return 1
  grep -Fq 'SECURITY_PACK_RESULT: ${{ needs.security_pack.result }}' <<<"$gate" || return 1
  grep -Fq '"$SECURITY_PACK_RESULT" security_pack' <<<"$gate" || return 1
  grep -Eq '^  (pull_request_target|workflow_run):' "$f" && return 1
  grep -Fq 'secrets.' <<<"$job" && return 1
  grep -Eq 'continue-on-error|\|\| *true' <<<"$job" && return 1
  return 0
}
wired "$WF" || fail "pr-ci.yml 의 Security pack 배선이 어긋났어요"
mut() { # <이름> <sed 식>
  sed "$2" "$WF" > "$TMP/wf-$1.yml"
  cmp -s "$WF" "$TMP/wf-$1.yml" && fail "$1: 변이가 적용되지 않았어요(닻 문구가 바뀜)"
  if wired "$TMP/wf-$1.yml"; then fail "$1: 깨진 배선이 통과"; fi
}
mut gate-drops-pack 's/^      - security_pack$/      - rust/'
mut no-negative 's#scripts/security_pack.sh negative#true#'
mut wrong-image 's#pgvector/pgvector:pg18#postgres:18#'
mut no-setup 's#scripts/security_pack.sh setup#true#'
mut result-ignored 's#"$SECURITY_PACK_RESULT" security_pack#"$RUST_RESULT" security_pack#'
mut pack-secrets 's#DATABASE_URL: postgres://momo:momo@localhost:5432/momo#DATABASE_URL: ${{ secrets.X }}#'
mut continue-on-error 's/timeout-minutes: 30$/continue-on-error: true/'
mut run-or-true 's#scripts/security_pack.sh run$#scripts/security_pack.sh run || true#'
# ── 야간 격리·요약(#4707) ─────────────────────────────────────────────────────────────
# 야간이 초록이어야 그 시험이 있는 것이다. 못 고치는 시험은 이름·소유 이슈·기한이 있는 격리 목록으로만 빠진다.
# (1) 격리 목록 lint 음성 대조 (2) report 요약의 종료 코드·내용 (3) 가짜 cargo 로 nightly 흐름 —
# 격리 시험은 전량 실행에서 빠지고 따로 돌며, 따로 돌다 빨강이어도 야간을 막지 않지만 기한이 지나면 막는다.
NOW=2026-10-28 SOON=2026-11-27 FAR=2027-03-01 PAST=2026-10-01
WHY='외부 도구가 필요해 야간에서 못 돌려요'
mk_quar_tree() { # <루트> — 선택 목록은 온전, 격리 대상 시험 파일 둘(함수 이름이 겹치는 것 포함)
  local r="$1" t="$1/server-rust/crates/fake/tests" i
  mk_tree "$r"
  for i in 2 3 4 5 6; do cp "$t/good_pg.rs" "$t/good_pg$i.rs"; done
  full_sel >"$r/infra/security-pack/selection.txt"
  printf '#[tokio::test]\n#[ignore]\nasync fn red_probe_one() {}\n#[tokio::test]\n#[ignore]\nasync fn red_probe_two() {}\n' >"$t/quar_pg.rs"
  printf '#[tokio::test]\n#[ignore]\nasync fn red_probe_one_extended() {}\n' >"$t/amb_pg.rs"
}
qline() { printf 'fake quar_pg %s %s %s %s\n' "$1" "$2" "$3" "$4"; } # <시험> <#이슈> <기한> <사유>
lint_in() { SECURITY_PACK_ROOT="$1" SECURITY_PACK_TODAY="$NOW" "$PACK" lint 2>&1; }
q_red() { # <이름> <기대 문구> <격리 목록 내용>
  local name="$1" want="$2" body="$3" r="$TMP/q-$1" out
  mk_quar_tree "$r"; printf '%s\n' "$body" >"$r/infra/security-pack/nightly-quarantine.txt"
  if out="$(lint_in "$r")"; then fail "격리 $name: 깨진 격리 목록이 초록"; fi
  grep -Fq -- "$want" <<<"$out" || fail "격리 $name: 다른 이유로 빨강 — $out"
}
r="$TMP/q-control"; mk_quar_tree "$r"
qline red_probe_two '#9001' "$SOON" "$WHY" >"$r/infra/security-pack/nightly-quarantine.txt"
out="$(lint_in "$r")" || fail "격리 대조군(온전한 1건)이 빨강 — $out"
grep -Fq 'quarantine lint OK: 1건' <<<"$out" || fail "격리 대조군: 건수 줄이 없어요 — $out"
# 만료는 lint 가 보지 않는다 — 기한이 지난 날 모든 Rust PR 이 막히면 안 된다(만료는 야간만 빨강, 아래).
r="$TMP/q-expired-lint"; mk_quar_tree "$r"
qline red_probe_two '#9001' "$PAST" "$WHY" >"$r/infra/security-pack/nightly-quarantine.txt"
lint_in "$r" >/dev/null || fail "기한 지난 격리가 lint 를 막아요(만료는 야간만 빨강이어야 해요)"
q_red missing-column "격리 열이 모자라요" "fake quar_pg red_probe_two #9001 $SOON"
q_red short-reason "격리 사유가 너무 짧아요" "$(qline red_probe_two '#9001' "$SOON" short)"
q_red not-a-name "함수 이름 하나여야" "$(qline 'a::b' '#9001' "$SOON" "$WHY")"
q_red owner-not-issue "소유 이슈는 #번호" "$(qline red_probe_two 9001 "$SOON" "$WHY")"
q_red bad-date "올바른 날짜" "$(qline red_probe_two '#9001' 2026-13-45 "$WHY")"
q_red too-far "넘어요" "$(qline red_probe_two '#9001' "$FAR" "$WHY")"
q_red duplicate "중복" "$(qline red_probe_two '#9001' "$SOON" "$WHY"; qline red_probe_two '#9002' "$SOON" "$WHY")"
q_red unknown-package "패키지를 찾을 수 없어요" "ghost quar_pg red_probe_two #9001 $SOON $WHY"
q_red missing-file "시험 파일이 없어요" "fake nope_pg red_probe_two #9001 $SOON $WHY"
q_red no-ignore "#[ignore] 시험이 없어요" "fake noignore_pg a #9001 $SOON $WHY"
q_red missing-fn "시험 함수가 없어요" "$(qline red_probe_gone '#9001' "$SOON" "$WHY")"
q_red ambiguous "함수 2개와 맞아요" "$(qline red_probe_one '#9001' "$SOON" "$WHY")"
# 보안 주장(docs/security/claims.yaml)의 증거 시험은 격리할 수 없다.
r="$TMP/q-claim-proof"; mk_quar_tree "$r"; mkdir -p "$r/docs/security"
printf '    proofs:\n      - "server-rust/crates/fake/tests/quar_pg.rs#red_probe_two"\n' >"$r/docs/security/claims.yaml"
qline red_probe_two '#9001' "$SOON" "$WHY" >"$r/infra/security-pack/nightly-quarantine.txt"
if out="$(lint_in "$r")"; then fail "격리 claim-proof: 보안 주장의 증거 시험이 격리돼요"; fi
grep -Fq '보안 주장' <<<"$out" || fail "격리 claim-proof: 다른 이유로 빨강 — $out"
qline red_probe_one_extended '#9001' "$SOON" "$WHY" >"$r/infra/security-pack/nightly-quarantine.txt"
sed -i.bak 's/^fake quar_pg/fake amb_pg/' "$r/infra/security-pack/nightly-quarantine.txt"; rm -f "$r/infra/security-pack/nightly-quarantine.txt.bak"
lint_in "$r" >/dev/null || fail "격리 claim-proof: 증거가 아닌 시험까지 막아요"
# 같은 이름의 함수가 다른 파일에도 있으면 `--skip` 이 둘 다 빼므로 빨강이어야 한다(이름 기준 중복 제거 금지).
r="$TMP/q-dup-name"; mk_quar_tree "$r"
printf '#[tokio::test]\n#[ignore]\nasync fn red_probe_two() {}\n' >"$r/server-rust/crates/fake/tests/dup_pg.rs"
qline red_probe_two '#9001' "$SOON" "$WHY" >"$r/infra/security-pack/nightly-quarantine.txt"
if out="$(lint_in "$r")"; then fail "격리 dup-name: 같은 이름 함수가 두 파일에 있는데 초록"; fi
grep -Fq '함수 2개와 맞아요' <<<"$out" || fail "격리 dup-name: 다른 이유로 빨강 — $out"

mk_logs() { # <디렉터리> — 전량 600 통과 · prod_role 13 통과 · 격리 로그 비어 있음
  mkdir -p "$1"
  printf 'test result: ok. 2000 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 9.00s\n' >"$1/main.log"
  printf 'test result: ok. 13 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 3.00s\n' >"$1/role.log"
  : >"$1/quar.log"
}
report_in() { # <루트> <로그 디렉터리> — 종료 코드를 그대로 낸다. 요약 파일은 <로그 디렉터리>/step.md
  GITHUB_STEP_SUMMARY="$2/step.md" SECURITY_PACK_ROOT="$1" SECURITY_PACK_TODAY="$NOW" SECURITY_PACK_OUT="$2/out" \
    "$PACK" report "$2/main.log" "$2/role.log" "$2/quar.log" 2>&1
}
want_in() { # <이름> <출력> <문구…> — 문구가 모두 있어야 한다
  local name="$1" out="$2" w; shift 2
  for w in "$@"; do grep -Fq -- "$w" <<<"$out" || fail "$name: '$w' 를 못 찾았어요 — $out"; done
}
rn="$TMP/rp-none"; mk_quar_tree "$rn" # 격리 목록 파일이 없는 트리
d="$TMP/rp-green"; mk_logs "$d"
out="$(report_in "$rn" "$d")" || fail "요약: 깨끗한 로그가 빨강 — $out"
want_in "요약(초록)" "$out" '**초록**' '격리: 없음'
grep -Fq '야간 PG 시험 전량' "$d/step.md" || fail "요약이 GITHUB_STEP_SUMMARY 파일에 안 쓰였어요"
d="$TMP/rp-failed"; mk_logs "$d"
cat >"$d/main.log" <<'LOG'
running 2 tests
test a_green_one ... ok
test red_probe_two ... FAILED

failures:

---- red_probe_two stdout ----

thread 'red_probe_two' (7) panicked at crates/fake/tests/quar_pg.rs:7:5:
the probe says no
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace


failures:
    red_probe_two

test result: FAILED. 1999 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s
error: test failed, to rerun pass `-p fake --test quar_pg`
error: 1 target failed:
    `-p fake --test quar_pg`
LOG
if out="$(report_in "$rn" "$d")"; then fail "요약: 실패한 시험이 있는데 초록"; fi
want_in "요약(실패 상세)" "$out" '`-p fake --test quar_pg`' '`red_probe_two`' 'the probe says no' '::error title=야간 PG 시험 빨강'
# 분기마다 그 분기만 걸리는 입력 — 한 분기가 꺼져도 다른 분기가 대신 잡아 가려지지 않아야 한다.
d="$TMP/rp-failcount"; mk_logs "$d" # 실패 개수만(타깃 목록·오류 줄 없음)
printf 'test result: FAILED. 1999 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s\n' >"$d/main.log"
if out="$(report_in "$rn" "$d")"; then fail "요약: 실패 1개(개수만)가 초록"; fi
want_in "요약(실패 개수)" "$out" '실패 1개'
d="$TMP/rp-targetlist"; mk_logs "$d" # 실패 타깃 목록만(실패 개수 0·'test failed' 줄 없음)
printf 'test result: ok. 2000 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 9.00s\nerror: 1 target failed:\n    `-p fake --test quar_pg`\n' >"$d/main.log"
if out="$(report_in "$rn" "$d")"; then fail "요약: 실패 타깃 목록만 있는 로그가 초록"; fi
want_in "요약(타깃 목록)" "$out" '`-p fake --test quar_pg`'
d="$TMP/rp-compile"; mk_logs "$d" # 컴파일 오류만
printf 'test result: ok. 2000 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 9.00s\nerror: could not compile `fake` (test "quar_pg") due to 1 previous error\n' >"$d/main.log"
if out="$(report_in "$rn" "$d")"; then fail "요약: 컴파일 오류가 있는 로그가 초록"; fi
want_in "요약(컴파일 오류)" "$out" '컴파일 또는 실행 오류'
d="$TMP/rp-collapsed"; mk_logs "$d"
printf 'test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s\n' >"$d/main.log"
if out="$(report_in "$rn" "$d")"; then fail "요약: 통과 3개(하한 미달)가 초록"; fi
want_in "요약(빈 초록)" "$out" '빈 초록 방지'
d="$TMP/rp-nolog"; mk_logs "$d"; rm "$d/main.log"
if out="$(report_in "$rn" "$d")"; then fail "요약: 전량 로그가 없는데 초록"; fi
want_in "요약(로그 없음)" "$out" '전량 로그가 없어요'
d="$TMP/rp-role"; mk_logs "$d"
printf 'test result: FAILED. 12 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 3.00s\n' >"$d/role.log"
if out="$(report_in "$rn" "$d")"; then fail "요약: prod_role 이 빨강인데 초록"; fi

rq="$TMP/rp-quar"; mk_quar_tree "$rq"
qline red_probe_two '#9001' "$SOON" "$WHY" >"$rq/infra/security-pack/nightly-quarantine.txt"
d="$TMP/rp-quar-red"; mk_logs "$d"
printf 'test red_probe_two ... FAILED\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s\n' >"$d/quar.log"
out="$(report_in "$rq" "$d")" || fail "요약: 기한 안의 격리 빨강이 야간을 막아요 — $out"
want_in "요약(격리 빨강)" "$out" '격리: **1건**(기한 지남 0건)' '| #9001 | 2026-11-27 (30일 남음) | 빨강 |' '::warning title=야간 격리 시험 1건'
printf 'test red_probe_two ... ok\n' >"$d/quar.log"
out="$(report_in "$rq" "$d")" || fail "요약: 통과한 격리가 야간을 막아요 — $out"
want_in "요약(격리 통과)" "$out" '통과 — 목록에서 뺄 수 있어요'
: >"$d/quar.log"
out="$(report_in "$rq" "$d")" || fail "요약: 안 돈 격리가 야간을 막아요 — $out"
want_in "요약(격리 안 돎)" "$out" '| 안 돎 |'
if out="$(NOW=2026-12-01 report_in "$rq" "$d")"; then fail "요약: 기한이 지난 격리가 초록"; fi
want_in "요약(격리 만료)" "$out" '기한 지남' '::error title=야간 격리 기한이 지났어요'

# nightly 흐름(가짜 cargo): 격리 시험은 전량 실행에서 `--skip` 으로 빠지고, 그 뒤 따로 돈다.
mk_fake_cargo() { # <bin 디렉터리> <호출 기록> <격리 따로 실행 결과: ok|FAILED> <전량 결과: ok|FAILED>
  mkdir -p "$1"
  cat >"$1/cargo" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$2"
case "\$*" in
  *--workspace*)
    if [ "$4" = ok ]; then echo 'test result: ok. 2000 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.0s'
    else echo 'test result: FAILED. 1999 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.0s'; exit 101; fi ;;
  *prod_role_conformance_pg*) echo 'test result: ok. 13 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 1.0s' ;;
  *"--test quar_pg"*) echo 'test red_probe_two ... $3'; [ "$3" = ok ] || exit 101 ;;
esac
EOF
  chmod +x "$1/cargo"
}
nightly_in() { # <루트> <가짜 bin> — 출력과 종료 코드를 그대로 낸다
  SECURITY_PACK_TARGET_DB=0 PATH="$2:$PATH" DATABASE_URL='postgres://u:p@127.0.0.1:5432/db' GITHUB_STEP_SUMMARY="$1/step.md" \
    SECURITY_PACK_ROOT="$1" SECURITY_PACK_TODAY="$NOW" SECURITY_PACK_OUT="$1/out" "$PACK" nightly 2>&1
}
rn="$TMP/nt"; mk_quar_tree "$rn"
qline red_probe_two '#9001' "$SOON" "$WHY" >"$rn/infra/security-pack/nightly-quarantine.txt"
calls="$TMP/nt-calls.txt"; : >"$calls"; mk_fake_cargo "$TMP/nt-bin" "$calls" FAILED ok
out="$(nightly_in "$rn" "$TMP/nt-bin")" || fail "nightly: 기한 안의 격리가 빨강이어도 야간은 초록이어야 해요 — $out"
grep -Eq -- '--workspace .*--skip red_probe_two' "$calls" || fail "nightly: 격리 시험이 전량 실행에서 안 빠졌어요 — $(cat "$calls")"
grep -Eq -- '-p fake --test quar_pg .*red_probe_two$' "$calls" || fail "nightly: 격리 시험을 따로 돌리지 않았어요 — $(cat "$calls")"
grep -Eq -- '--test quar_pg .*--skip' "$calls" && fail "nightly: 따로 도는 격리 실행이 자기 시험을 건너뛰어요 — $(cat "$calls")"
[ "$(grep -n -- '--workspace' "$calls" | head -1 | cut -d: -f1)" -lt "$(grep -n -- '--test quar_pg' "$calls" | head -1 | cut -d: -f1)" ] \
  || fail "nightly: 격리 실행이 전량 실행보다 먼저 돌아요(잔여물이 야간 결과에 닿아요)"
want_in "nightly 요약" "$(cat "$rn/step.md")" '| #9001 | 2026-11-27 (30일 남음) | 빨강 |'
out="$(GITHUB_ACTIONS=true nightly_in "$rn" "$TMP/nt-bin")" || fail "nightly(Actions): 초록이어야 해요 — $out"
want_in "nightly 원문 접기" "$out" '::group::nightly.log 전문' '::group::nightly-quarantine.log 전문'
if out="$(NOW=2026-12-01 nightly_in "$rn" "$TMP/nt-bin")"; then fail "nightly: 기한이 지난 격리인데 초록"; fi
mk_fake_cargo "$TMP/nt-bin-red" "$calls" ok FAILED
if out="$(nightly_in "$rn" "$TMP/nt-bin-red")"; then fail "nightly: 전량 실행이 빨강인데 초록"; fi
qline red_probe_two 9001 "$SOON" "$WHY" >"$rn/infra/security-pack/nightly-quarantine.txt"; : >"$calls"
if out="$(nightly_in "$rn" "$TMP/nt-bin")"; then fail "nightly: 깨진 격리 목록(소유 이슈 형식)인데 초록"; fi
[ ! -s "$calls" ] || fail "nightly: 깨진 격리 목록인데 cargo 를 불렀어요(lint 가 먼저여야 해요) — $(cat "$calls")"
rm "$rn/infra/security-pack/nightly-quarantine.txt"; : >"$calls"; mk_fake_cargo "$TMP/nt-bin-ok" "$calls" ok ok
out="$(nightly_in "$rn" "$TMP/nt-bin-ok")" || fail "nightly: 격리가 없고 전량이 초록인데 빨강 — $out"
grep -Fq -- 'quar_pg' "$calls" && fail "nightly: 격리 목록이 없는데 격리 실행이 돌았어요"
want_in "nightly(격리 없음)" "$out" '격리: 없음'
# ── 타깃마다 새 DB 실행기(#4707) ──────────────────────────────────────────────────────────
# 시험 실행 파일마다 템플릿 복제본을 주고(없는 쪽은 그대로 실행), 끝나면 — 실패해도 — 지우며, 종료 코드를 보존한다.
RUNNER="$REPO_ROOT/infra/security-pack/nightly-target-db.sh"
mk_fake_psql() { # <bin 디렉터리> <기록 파일> — 접속 URL 과 -c 의 SQL 을 적는다(FAKE_PSQL_FAIL=1 이면 실패)
  mkdir -p "$1"
  cat >"$1/psql" <<EOF
#!/usr/bin/env bash
url="\$1"; sql=""
while [ "\$#" -gt 0 ]; do if [ "\$1" = -c ]; then sql="\$2"; break; fi; shift; done
echo "\$url | \$sql" >>"$2"
[ "\${FAKE_PSQL_FAIL:-0}" = 1 ] && exit 1
exit 0
EOF
  chmod +x "$1/psql"
}
mk_fake_exe() { # <경로> <기록 파일> <#[ignore] 시험 유무 yes|no> <종료 코드> [--list 의 종료 코드, 기본 0]
  cat >"$1" <<EOF
#!/usr/bin/env bash
if [ "\$1" = --list ]; then [ "$3" = yes ] && echo 'a_test: test'; exit ${5:-0}; fi
echo "RAN args=\$* DATABASE_URL=\${DATABASE_URL:-} PGDATABASE=\${PGDATABASE:-}" >>"$2"
exit $4
EOF
  chmod +x "$1"
}
run_runner() { # <작업 디렉터리> <실행 파일> [인자…] — 종료 코드를 그대로 낸다
  local d="$1" exe="$2"; shift 2
  NIGHTLY_DB_TEMPLATE=nt_tpl DATABASE_URL="${RUNNER_DB_URL:-postgres://u:p@h:5432/momo}" PSQL_BIN="$d/bin/psql" "$RUNNER" "$exe" "$@"
}
rd() { d="$TMP/rn-$1"; mkdir -p "$d"; mk_fake_psql "$d/bin" "$d/psql.log"; : >"$d/psql.log"; : >"$d/ran.log"; mk_fake_exe "$d/exe" "$d/ran.log" "$2" "$3"; }
clone_name() { sed -n 's/.*CREATE DATABASE "\([^"]*\)".*/\1/p' "$1/psql.log" | head -1; }

rd noignore no 0
run_runner "$d" "$d/exe" --ignored --test-threads=1 || fail "실행기: #[ignore] 없는 실행 파일이 빨강"
[ ! -s "$d/psql.log" ] || fail "실행기: #[ignore] 없는 실행 파일에 DB 를 만들었어요 — $(cat "$d/psql.log")"
grep -Fq 'RAN args=--ignored --test-threads=1 DATABASE_URL=postgres://u:p@h:5432/momo PGDATABASE=' "$d/ran.log" \
  || fail "실행기: #[ignore] 없는 실행 파일의 인자·환경이 바뀌었어요 — $(cat "$d/ran.log")"

rd clone yes 0
run_runner "$d" "$d/exe" --ignored --test-threads=1 --skip x || fail "실행기: 정상 실행이 빨강"
n="$(clone_name "$d")"; [ -n "$n" ] || fail "실행기: 새 DB 를 만들지 않았어요 — $(cat "$d/psql.log")"
grep -Fq "postgres://u:p@h:5432/postgres | CREATE DATABASE \"$n\" TEMPLATE \"nt_tpl\"" "$d/psql.log" || fail "실행기: 템플릿 복제 문장이 달라요 — $(cat "$d/psql.log")"
grep -Fq "RAN args=--ignored --test-threads=1 --skip x DATABASE_URL=postgres://u:p@h:5432/$n PGDATABASE=$n" "$d/ran.log" \
  || fail "실행기: 시험에 새 DB 의 DATABASE_URL·PGDATABASE 를 주지 않았어요 — $(cat "$d/ran.log")"
[ "$(grep -n 'CREATE DATABASE' "$d/psql.log" | head -1 | cut -d: -f1)" -lt "$(grep -n "DROP DATABASE IF EXISTS \"$n\" WITH (FORCE)" "$d/psql.log" | head -1 | cut -d: -f1)" ] \
  || fail "실행기: 끝난 뒤 새 DB 를 지우지 않았어요 — $(cat "$d/psql.log")"

rd fail yes 7
rc=0; run_runner "$d" "$d/exe" --ignored || rc=$?
[ "$rc" = 7 ] || fail "실행기: 시험의 종료 코드(7)를 보존하지 않았어요 — rc=$rc"
n="$(clone_name "$d")"; grep -Fq "DROP DATABASE IF EXISTS \"$n\" WITH (FORCE)" "$d/psql.log" || fail "실행기: 시험이 실패한 뒤 새 DB 를 지우지 않았어요"

rd query yes 0
RUNNER_DB_URL='postgres://u:p@h:5432/momo?sslmode=disable' run_runner "$d" "$d/exe" --ignored || fail "실행기: 옵션이 붙은 URL 이 빨강"
n="$(clone_name "$d")"
grep -Fq "postgres://u:p@h:5432/postgres?sslmode=disable | CREATE" "$d/psql.log" || fail "실행기: 관리 접속에서 URL 옵션이 사라졌어요 — $(cat "$d/psql.log")"
grep -Fq "DATABASE_URL=postgres://u:p@h:5432/$n?sslmode=disable" "$d/ran.log" || fail "실행기: 시험 URL 에서 옵션이 사라졌어요 — $(cat "$d/ran.log")"

rd listrc yes 0; mk_fake_exe "$d/exe" "$d/ran.log" yes 0 101
run_runner "$d" "$d/exe" --ignored || fail "실행기: --list 가 101 로 끝나는 실행 파일이 빨강"
n="$(clone_name "$d")"; [ -n "$n" ] || fail "실행기: --list 가 0 이 아닌 코드로 끝나는 실행 파일(tenant_catalog_pg 는 101)을 새 DB 없이 돌렸어요"
grep -Fq "DATABASE_URL=postgres://u:p@h:5432/$n" "$d/ran.log" || fail "실행기: --list 가 101 인 실행 파일에 새 DB 를 주지 않았어요 — $(cat "$d/ran.log")"

rd twice yes 0
run_runner "$d" "$d/exe" --ignored; run_runner "$d" "$d/exe" --ignored
[ "$(sed -n 's/.*CREATE DATABASE "\([^"]*\)".*/\1/p' "$d/psql.log" | sort -u | wc -l | tr -d ' ')" = 2 ] || fail "실행기: 실행 파일마다 다른 새 DB 를 주지 않았어요 — $(cat "$d/psql.log")"

rd nocreate yes 0
rc=0; FAKE_PSQL_FAIL=1 run_runner "$d" "$d/exe" --ignored 2>/dev/null || rc=$?
[ "$rc" = 99 ] || fail "실행기: 복제 실패가 99 가 아니에요 — rc=$rc"
[ ! -s "$d/ran.log" ] || fail "실행기: DB 를 못 만들었는데 시험을 돌렸어요(빈 DB 에서 엉뚱한 빨강)"
rc=0; DATABASE_URL=x "$RUNNER" "$d/exe" --ignored 2>/dev/null || rc=$?
[ "$rc" = 2 ] || fail "실행기: 템플릿 이름이 없는데 실행했어요 — rc=$rc"

# nightly 가 실행기를 거는지(가짜 rustc·psql·cargo): 템플릿을 만들고, 모든 cargo 호출에 실행기를 주고, 끝에 템플릿을 지운다.
mk_iso_bin() { # <bin 디렉터리> <cargo 호출 기록> <psql 기록>
  mkdir -p "$1"; mk_fake_psql "$1" "$3"
  printf '#!/usr/bin/env bash\n[ "$1" = -vV ] && echo "host: x86_64-unknown-linux-gnu"\n' >"$1/rustc"
  cat >"$1/cargo" <<EOF
#!/usr/bin/env bash
echo "\$* | RUNNER=\${CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER:-unset} TPL=\${NIGHTLY_DB_TEMPLATE:-unset}" >>"$2"
case "\$*" in
  *--workspace*) echo 'test result: ok. 2000 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.0s' ;;
  *prod_role_conformance_pg*) echo 'test result: ok. 13 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 1.0s' ;;
esac
EOF
  chmod +x "$1/rustc" "$1/cargo"
}
iso_nightly() { # <루트> <bin> — 격리를 켠 채(SECURITY_PACK_TARGET_DB 기본값) 실행
  PATH="$2:$PATH" PSQL_BIN="$2/psql" DATABASE_URL='postgres://u:p@127.0.0.1:5432/db' GITHUB_STEP_SUMMARY="$1/step.md" \
    SECURITY_PACK_ROOT="$1" SECURITY_PACK_TODAY="$NOW" SECURITY_PACK_OUT="$1/out" "$PACK" nightly 2>&1
}
ri="$TMP/iso"; mk_quar_tree "$ri"; : >"$ri/cargo.log"; : >"$ri/psql.log"; mk_iso_bin "$ri/bin" "$ri/cargo.log" "$ri/psql.log"
out="$(iso_nightly "$ri" "$ri/bin")" || fail "nightly(격리): 초록이어야 해요 — $out"
want_in "nightly(격리 안내)" "$out" '시험 실행 파일마다 새 DB' 'CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER'
grep -Fq 'DROP DATABASE IF EXISTS "nt_template" WITH (FORCE)' "$ri/psql.log" || fail "nightly(격리): 옛 템플릿을 지우지 않았어요 — $(cat "$ri/psql.log")"
grep -Fq 'CREATE DATABASE "nt_template" TEMPLATE "db" ALLOW_CONNECTIONS false' "$ri/psql.log" || fail "nightly(격리): setup 이 끝난 DB(db)에서 템플릿을 만들지 않았어요 — $(cat "$ri/psql.log")"
[ "$(grep -c 'DROP DATABASE IF EXISTS "nt_template"' "$ri/psql.log")" = 2 ] || fail "nightly(격리): 끝에 템플릿을 지우지 않았어요 — $(cat "$ri/psql.log")"
[ "$(grep -c 'RUNNER=.*/infra/security-pack/nightly-target-db.sh TPL=nt_template' "$ri/cargo.log")" = "$(wc -l <"$ri/cargo.log" | tr -d ' ')" ] \
  || fail "nightly(격리): 모든 cargo 호출에 실행기를 걸지 않았어요 — $(cat "$ri/cargo.log")"
runner_path="$(sed -n 's/.*RUNNER=\([^ ]*\) TPL=.*/\1/p' "$ri/cargo.log" | head -1)"
[ -x "$runner_path" ] || fail "nightly(격리): cargo 에 건 실행기 경로가 실행 파일이 아니에요 — '$runner_path'"
ro="$TMP/iso-off"; mk_quar_tree "$ro"; : >"$ro/cargo.log"; : >"$ro/psql.log"; mk_iso_bin "$ro/bin" "$ro/cargo.log" "$ro/psql.log"
out="$(SECURITY_PACK_TARGET_DB=0 iso_nightly "$ro" "$ro/bin")" || fail "nightly(격리 끔): 초록이어야 해요 — $out"
[ ! -s "$ro/psql.log" ] || fail "nightly(격리 끔): DB 를 만졌어요"
grep -Fq 'RUNNER=unset' "$ro/cargo.log" || fail "nightly(격리 끔): 실행기가 걸렸어요"
# ── 대상 병렬 실행(#5495) ──────────────────────────────────────────────────────────────
# `run` 은 선택 대상을 SECURITY_PACK_JOBS(기본 4)개씩 **동시에**, 대상마다 템플릿 복제 DB 에서 돈다. 가짜 cargo·psql·rustc 로 DB 없이:
# (1) 정말 겹쳐 돌고 상한을 지킨다 (2) 직렬(JOBS=1)과 같은 대상·같은 시험 수가 돈다 (3) 대상 하나가 빨강·0개·결과 없음이면
# 잡이 빨갛고 **어느 대상인지** 찍힌다(집합 대조 — 숫자만 맞춰서는 통과하지 못한다).
mk_run_bin() { # <bin 디렉터리> <상태 디렉터리> — 가짜 cargo(동시에 도는 개수를 conc.log 에 적는다)·psql·rustc
  mkdir -p "$1" "$2/running"; : >"$2/conc.log"; : >"$2/calls.log"; : >"$2/psql.log"
  mk_fake_psql "$1" "$2/psql.log"
  printf '#!/usr/bin/env bash\n[ "$1" = -vV ] && echo "host: x86_64-unknown-linux-gnu"\n' >"$1/rustc"
  cat >"$1/cargo" <<EOF
#!/usr/bin/env bash
target=""; prev=""
for a in "\$@"; do [ "\$prev" = --test ] && target="\$a"; prev="\$a"; done
touch "$2/running/\$\$"
ls "$2/running" | wc -l | tr -d ' ' >>"$2/conc.log"
echo "\$target RUNNER=\${CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER:-unset} TPL=\${NIGHTLY_DB_TEMPLATE:-unset} PSQL=\$(command -v psql)" >>"$2/calls.log"
sleep "\${FAKE_CARGO_SLEEP:-0}"
rm -f "$2/running/\$\$"
echo '    Finished \`test\` profile [unoptimized] target(s) in 0.50s'
if [ "\${FAKE_CARGO_RETRY:-}" = "\$target" ]; then echo '[psql-retry] 역할 DDL 충돌(tuple concurrently updated) — 다시 시도 1/12' >&2; fi
if [ "\${FAKE_CARGO_FAIL:-}" = "\$target" ]; then
  echo 'test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s'; exit 101
fi
if [ "\${FAKE_CARGO_ZERO:-}" = "\$target" ]; then
  echo 'test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.10s'; exit 0
fi
echo 'test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s'
EOF
  chmod +x "$1/rustc" "$1/cargo"
}
run_pack() { # <루트> <bin> <packer 스크립트> [VAR=값…] — 출력과 종료 코드를 그대로 낸다
  local r="$1" bin="$2" packer="$3"; shift 3
  env "$@" PATH="$bin:$PATH" PSQL_BIN="$bin/psql" DATABASE_URL='postgres://u:p@127.0.0.1:5432/db' \
    SECURITY_PACK_ROOT="$r" SECURITY_PACK_TODAY="$NOW" SECURITY_PACK_OUT="$r/out" "$packer" run 2>&1
}
max_conc() { sort -n "$1/conc.log" | tail -n 1; }
rp="$TMP/par"; mk_quar_tree "$rp"; mk_run_bin "$rp/bin" "$rp/st"
out="$(run_pack "$rp" "$rp/bin" "$PACK" SECURITY_PACK_JOBS=4 FAKE_CARGO_SLEEP=1)" || fail "병렬: 초록이어야 해요 — $out"
want_in "병렬(초록)" "$out" '대상 6개를 4개씩 동시에' 'PASS targets=6 tests=18 ' ' jobs=4 retries=0'
[ "$(grep -c '^\[security-pack\] ok fake/' <<<"$out")" = 6 ] || fail "병렬: 대상마다 ok 줄이 하나씩이어야 해요 — $out"
[ "$(wc -l <"$rp/st/calls.log" | tr -d ' ')" = 6 ] || fail "병렬: cargo 를 대상마다 한 번씩 부르지 않았어요 — $(cat "$rp/st/calls.log")"
[ "$(max_conc "$rp/st")" -ge 2 ] || fail "병렬: 대상이 겹쳐 돌지 않았어요(동시 개수 최대 $(max_conc "$rp/st")) — 직렬과 같아요"
[ "$(max_conc "$rp/st")" -le 4 ] || fail "병렬: 동시 개수가 상한 4 를 넘었어요($(max_conc "$rp/st"))"
[ "$(grep -c 'RUNNER=.*/infra/security-pack/nightly-target-db.sh TPL=nt_template' "$rp/st/calls.log")" = 6 ] \
  || fail "병렬: 모든 cargo 호출에 대상별 DB 실행기를 걸지 않았어요 — $(cat "$rp/st/calls.log")"
[ "$(grep -c 'PSQL=.*/infra/security-pack/shim/psql$' "$rp/st/calls.log")" = 6 ] \
  || fail "병렬: 모든 cargo 호출의 PATH 맨 앞에 psql 대리인(infra/security-pack/shim)을 두지 않았어요 — $(cat "$rp/st/calls.log")"
grep -Fq 'CREATE DATABASE "nt_template" TEMPLATE "db" ALLOW_CONNECTIONS false' "$rp/st/psql.log" || fail "병렬: setup 이 끝난 DB 에서 템플릿을 만들지 않았어요 — $(cat "$rp/st/psql.log")"
[ "$(grep -c 'DROP DATABASE IF EXISTS "nt_template"' "$rp/st/psql.log")" = 2 ] || fail "병렬: 끝에 템플릿을 지우지 않았어요 — $(cat "$rp/st/psql.log")"
# 대상 로그에 남은 psql 재시도 횟수가 PASS 줄에 보인다(0 에서 멀어지면 병렬이 흔들린다는 신호).
rr="$TMP/par-retry"; mk_quar_tree "$rr"; mk_run_bin "$rr/bin" "$rr/st"
out_r="$(run_pack "$rr" "$rr/bin" "$PACK" FAKE_CARGO_RETRY=good_pg3)" || fail "병렬(재시도 표시): 초록이어야 해요 — $out_r"
want_in "병렬(재시도 표시)" "$out_r" 'PASS targets=6 tests=18 ' ' jobs=4 retries=1'
# 직렬(JOBS=1)과 같은 대상·같은 시험 수 — 같은 선택 목록·같은 가짜 cargo 에서 숫자가 정확히 같아야 한다.
rs="$TMP/ser"; mk_quar_tree "$rs"; mk_run_bin "$rs/bin" "$rs/st"
out_s="$(run_pack "$rs" "$rs/bin" "$PACK" SECURITY_PACK_JOBS=1)" || fail "직렬: 초록이어야 해요 — $out_s"
want_in "직렬(초록)" "$out_s" 'PASS targets=6 tests=18 '
[ "$(max_conc "$rs/st")" = 1 ] || fail "직렬: 대상이 겹쳐 돌았어요(최대 $(max_conc "$rs/st"))"
[ ! -s "$rs/st/psql.log" ] || fail "직렬: DB 를 만졌어요(예전 방식은 한 DB 에서 차례로) — $(cat "$rs/st/psql.log")"
grep -Fq 'RUNNER=unset' "$rs/st/calls.log" || fail "직렬: 대상별 DB 실행기가 걸렸어요"
grep -Fq '/infra/security-pack/shim/psql' "$rs/st/calls.log" && fail "직렬: psql 대리인이 PATH 에 걸렸어요(예전 방식은 그대로여야 해요)"
[ "$(sed -n 's/.*PASS \(targets=[0-9]* tests=[0-9]*\) .*/\1/p' <<<"$out")" = "$(sed -n 's/.*PASS \(targets=[0-9]* tests=[0-9]*\) .*/\1/p' <<<"$out_s")" ] \
  || fail "직렬과 병렬의 대상·시험 수가 달라요 — 병렬 '$out' / 직렬 '$out_s'"
# 상한: 2개씩이면 동시 개수가 정확히 2 를 넘지 않는다.
rc2="$TMP/par2"; mk_quar_tree "$rc2"; mk_run_bin "$rc2/bin" "$rc2/st"
out2="$(run_pack "$rc2" "$rc2/bin" "$PACK" SECURITY_PACK_JOBS=2 FAKE_CARGO_SLEEP=1)" || fail "병렬(2): 초록이어야 해요 — $out2"
[ "$(max_conc "$rc2/st")" = 2 ] || fail "병렬(2): 동시 개수가 2 가 아니에요(최대 $(max_conc "$rc2/st"))"
# 대상별 DB 를 끄면 동시에 못 돈다(공용 DB 에서 겹치면 서로 깨뜨린다) — 차례로 돌고 알려 준다.
rt="$TMP/par-nodb"; mk_quar_tree "$rt"; mk_run_bin "$rt/bin" "$rt/st"
out_t="$(run_pack "$rt" "$rt/bin" "$PACK" SECURITY_PACK_JOBS=4 SECURITY_PACK_TARGET_DB=0 FAKE_CARGO_SLEEP=1)" || fail "병렬(TARGET_DB=0): 초록이어야 해요 — $out_t"
want_in "병렬(TARGET_DB=0)" "$out_t" '동시에 못 돌아요' 'PASS targets=6 tests=18 '
[ "$(max_conc "$rt/st")" = 1 ] && [ ! -s "$rt/st/psql.log" ] || fail "병렬(TARGET_DB=0): 공용 DB 에서 겹쳐 돌았어요"
for bad_jobs in 0 abc 04 -1; do
  rj="$TMP/par-jobs$bad_jobs"; mk_quar_tree "$rj"; mk_run_bin "$rj/bin" "$rj/st"
  if out_j="$(run_pack "$rj" "$rj/bin" "$PACK" SECURITY_PACK_JOBS="$bad_jobs")"; then fail "병렬: SECURITY_PACK_JOBS='$bad_jobs' 인데 초록"; fi
  grep -Fq 'SECURITY_PACK_JOBS 는 1 이상의 정수' <<<"$out_j" || fail "병렬: JOBS='$bad_jobs' 가 다른 이유로 빨강 — $out_j"
  [ ! -s "$rj/st/calls.log" ] || fail "병렬: JOBS='$bad_jobs' 인데 cargo 를 불렀어요"
done
# 한 대상이 빨강이면 잡이 빨갛고 그 대상이 찍힌다. 나머지는 끝까지 돌아 한 번에 모두 보인다.
rf="$TMP/par-fail"; mk_quar_tree "$rf"; mk_run_bin "$rf/bin" "$rf/st"
if out_f="$(run_pack "$rf" "$rf/bin" "$PACK" FAKE_CARGO_FAIL=good_pg3)"; then fail "병렬: 대상 하나가 빨강인데 초록"; fi
want_in "병렬(대상 빨강)" "$out_f" 'fake/good_pg3' '병렬 실행 빨강' '결과가 없는 대상: fake/good_pg3' '::error title=Security pack 대상 빨강::fake/good_pg3'
grep -Fq 'PASS' <<<"$out_f" && fail "병렬: 빨강인데 PASS 줄이 있어요"
grep -Fq '[security-pack] ok fake/good_pg6 ' <<<"$out_f" || fail "병렬: 한 대상이 빨강이어도 나머지는 끝까지 돌아야 해요 — $out_f"
# 0개를 실행한 대상(빈 초록)도 빨강이고 어느 대상인지 찍힌다.
rz="$TMP/par-zero"; mk_quar_tree "$rz"; mk_run_bin "$rz/bin" "$rz/st"
if out_z="$(run_pack "$rz" "$rz/bin" "$PACK" FAKE_CARGO_ZERO=good_pg2)"; then fail "병렬: 0개를 실행한 대상인데 초록"; fi
want_in "병렬(0개)" "$out_z" '빈 초록' 'fake/good_pg2'
# ── psql 대리인(infra/security-pack/shim/psql) ───────────────────────────────────────────
# 시험 실행 파일이 시작 때 `psql -f bootstrap_roles.sql` 로 클러스터 전역 역할 DDL 을 다시 적용하므로, 대상을 동시에 시작하면
# `tuple concurrently updated` 로 죽는다(실측). 대리인은 그 호출에서 **그 오류 하나만** 다시 시도하고 나머지는 그대로 넘긴다.
SHIM="$REPO_ROOT/infra/security-pack/shim/psql"
[ -x "$SHIM" ] || fail "psql 대리인이 없거나 실행 권한이 없어요: $SHIM"
mk_shim_env() { # <이름> — 실제 psql 흉내(호출 횟수·인자를 적는다). FAKE_MODE: ok | transient2 | transient_always | other
  local d="$TMP/shim-$1"; mkdir -p "$d"; : >"$d/args"; rm -f "$d/count"
  cat >"$d/realpsql" <<EOF
#!/usr/bin/env bash
n=\$(( \$(cat "$d/count" 2>/dev/null || echo 0) + 1 )); echo \$n >"$d/count"
echo "ARGS: \$*" >>"$d/args"
case "\${FAKE_MODE:-ok}" in
  transient2) if [ "\$n" -le 2 ]; then echo 'psql: ERROR:  tuple concurrently updated' >&2; exit 3; fi ;;
  transient_always) echo 'psql: ERROR:  tuple concurrently updated' >&2; exit 3 ;;
  other) echo 'psql: ERROR:  permission denied for table x' >&2; exit 4 ;;
esac
echo "out-\$n"
EOF
  chmod +x "$d/realpsql"; printf '%s' "$d"
}
shim_call() { # <dir> <FAKE_MODE> <인자…> — 종료 코드를 그대로 낸다
  local d="$1" mode="$2"; shift 2
  FAKE_MODE="$mode" PSQL_BIN="$d/realpsql" PSQL_RETRY_SLEEP=0 PSQL_RETRY_MAX="${PSQL_RETRY_MAX:-12}" "$SHIM" "$@"
}
BOOT=/x/infra/rust/sql/bootstrap_roles.sql
d="$(mk_shim_env retry)"; out_h="$(shim_call "$d" transient2 postgres://u@h/db -v ON_ERROR_STOP=1 --single-transaction -f $BOOT 2>&1)" \
  || fail "대리인: 일시 오류 두 번 뒤 성공해야 해요 — $out_h"
[ "$(cat "$d/count")" = 3 ] || fail "대리인: 세 번째 시도에서 성공해야 해요(호출 $(cat "$d/count")회)"
want_in "대리인(재시도)" "$out_h" 'out-3' '다시 시도 1/12' '다시 시도 2/12'
grep -Fq 'psql: ERROR:' <<<"$out_h" && fail "대리인: 성공했는데 실패한 시도의 psql 오류가 출력에 남았어요 — $out_h"
d="$(mk_shim_env same-args)"; shim_call "$d" transient2 postgres://u@h/db -v ON_ERROR_STOP=1 --single-transaction -f $BOOT >/dev/null 2>&1
[ "$(sort -u "$d/args" | wc -l | tr -d ' ')" = 1 ] || fail "대리인: 다시 시도할 때 인자가 달라졌어요 — $(cat "$d/args")"
d="$(mk_shim_env file-eq)"; shim_call "$d" transient2 postgres://u@h/db --file=$BOOT >/dev/null 2>&1 || fail "대리인: --file=… 형태도 감싸야 해요"
[ "$(cat "$d/count")" = 3 ] || fail "대리인: --file=… 형태가 다시 시도되지 않았어요(호출 $(cat "$d/count")회)"
d="$(mk_shim_env other)"; rc=0; out_h="$(shim_call "$d" other postgres://u@h/db -f $BOOT 2>&1)" || rc=$?
[ "$rc" = 4 ] && [ "$(cat "$d/count")" = 1 ] || fail "대리인: 다른 오류는 다시 시도하지 않고 종료 코드(4)를 그대로 내야 해요(rc=$rc, 호출 $(cat "$d/count")회)"
grep -Fq 'permission denied for table x' <<<"$out_h" || fail "대리인: 다른 오류의 출력이 사라졌어요 — $out_h"
d="$(mk_shim_env cap)"; rc=0; out_h="$(PSQL_RETRY_MAX=3 shim_call "$d" transient_always postgres://u@h/db -f $BOOT 2>&1)" || rc=$?
[ "$rc" = 3 ] && [ "$(cat "$d/count")" = 3 ] || fail "대리인: 상한(3)에서 멈추고 마지막 종료 코드(3)를 내야 해요(rc=$rc, 호출 $(cat "$d/count")회)"
grep -Fq 'tuple concurrently updated' <<<"$out_h" || fail "대리인: 상한에서 멈출 때 마지막 오류를 보여 줘야 해요 — $out_h"
# 감싸지 않는 호출: 같은 일시 오류 문구가 나와도 한 번만 부르고 그대로 넘긴다(다른 SQL 파일·-c 는 건드리지 않는다).
d="$(mk_shim_env passthrough)"; rc=0; shim_call "$d" transient_always postgres://u@h/db -c 'select 1' >/dev/null 2>&1 || rc=$?
[ "$rc" = 3 ] && [ "$(cat "$d/count")" = 1 ] || fail "대리인: bootstrap 이 아닌 호출을 감쌌어요(rc=$rc, 호출 $(cat "$d/count")회)"
d="$(mk_shim_env other-file)"; rc=0; shim_call "$d" transient_always postgres://u@h/db -f /x/seed.sql >/dev/null 2>&1 || rc=$?
[ "$rc" = 3 ] && [ "$(cat "$d/count")" = 1 ] || fail "대리인: 다른 SQL 파일(-f)을 감쌌어요(rc=$rc, 호출 $(cat "$d/count")회)"
d="$(mk_shim_env args-pass)"; shim_call "$d" ok postgres://u@h/db -v 'a=b c' -c "select 'x y'" >/dev/null 2>&1
grep -Fxq "ARGS: postgres://u@h/db -v a=b c -c select 'x y'" "$d/args" || fail "대리인: 감싸지 않는 호출의 인자를 바꿨어요 — $(cat "$d/args")"
# 집합 대조가 정말 실패할 수 있는지: 병렬 실행기의 결과 기록을 일부러 깬 사본에서 빨강이어야 한다.
# 사본은 스크립트와 실행기를 같은 상대 위치에 복사하고, 결과를 적는 한 줄만 리터럴로 바꾼다(정규식 아님 — 인용 사고를 막는다).
OK_OLD="$(cat <<'EOF'
    printf '%s/%s passed=%s\n' "$pkg" "$test" "$n" >"$res/$pkg.$test.ok"
EOF
)"
mut_pack() { # <이름> <바꿀 줄> — 사본 스크립트 경로를 낸다
  local m="$TMP/mutpack-$1"
  mkdir -p "$m/scripts" "$m/infra/security-pack/shim"
  cp "$RUNNER" "$m/infra/security-pack/nightly-target-db.sh"; cp "$SHIM" "$m/infra/security-pack/shim/psql"
  OLD="$OK_OLD" NEW="$2" awk '$0 == ENVIRON["OLD"] { print ENVIRON["NEW"]; next } { print }' "$PACK" >"$m/scripts/security_pack.sh"
  chmod +x "$m/scripts/security_pack.sh"
  cmp -s "$PACK" "$m/scripts/security_pack.sh" && fail "$1: 변이가 적용되지 않았어요(결과를 적는 줄이 바뀜)"
  printf '%s' "$m/scripts/security_pack.sh"
}
mut_run() { # <이름> <바꿀 줄> — 변이 사본으로 새 트리에서 `run`. 출력과 종료 코드를 그대로 낸다
  local m r="$TMP/par-$1"
  m="$(mut_pack "$1" "$2")"
  mk_quar_tree "$r"; mk_run_bin "$r/bin" "$r/st"
  run_pack "$r" "$r/bin" "$m"
}
if out_m="$(mut_run no-result '    [ "$test" = good_pg4 ] || printf '"'"'%s/%s passed=%s\n'"'"' "$pkg" "$test" "$n" >"$res/$pkg.$test.ok"')"; then
  fail "병렬: 결과 파일이 빠진 대상(good_pg4)인데 초록 — 집합 대조가 실패할 수 없는 가드예요"
fi
want_in "병렬(결과 없음)" "$out_m" '결과가 없는 대상: fake/good_pg4' '결과 없음 1개'
if out_m="$(mut_run zero-result '    printf '"'"'%s/%s passed=%s\n'"'"' "$pkg" "$test" "$([ "$test" = good_pg5 ] && echo 0 || echo "$n")" >"$res/$pkg.$test.ok"')"; then
  fail "병렬: 통과 0개로 기록된 대상(good_pg5)인데 초록 — 집계가 0 을 걸러내지 못해요"
fi
want_in "병렬(통과 0 기록)" "$out_m" '통과 개수가 0 이거나 숫자가 아닌 대상: fake/good_pg5'
if out_m="$(mut_run extra-result '    printf '"'"'%s/%s passed=%s\n'"'"' "$pkg" "$([ "$test" = good_pg6 ] && echo ghost || echo "$test")" "$n" >"$res/$pkg.$test.ok"')"; then
  fail "병렬: 선택에 없는 이름(ghost)으로 기록된 결과인데 초록"
fi
want_in "병렬(선택에 없는 결과)" "$out_m" '선택에 없는 결과: fake/ghost' '결과가 없는 대상: fake/good_pg6'
# 대조군: 줄을 같은 내용으로 "바꾼" 사본(같은 복사 절차)은 초록이어야 변이 시험이 "사본이라서 빨강"이 아니라는 것이 보인다.
m="$TMP/mutpack-control"; mkdir -p "$m/scripts" "$m/infra/security-pack/shim"
cp "$PACK" "$m/scripts/security_pack.sh"; cp "$RUNNER" "$m/infra/security-pack/nightly-target-db.sh"; cp "$SHIM" "$m/infra/security-pack/shim/psql"
rm_="$TMP/par-control"; mk_quar_tree "$rm_"; mk_run_bin "$rm_/bin" "$rm_/st"
out_m="$(run_pack "$rm_" "$rm_/bin" "$m/scripts/security_pack.sh")" || fail "병렬: 변이 없는 사본(대조군)이 빨강 — $out_m"
want_in "병렬(대조군)" "$out_m" 'PASS targets=6 tests=18 '
echo "test_security_pack: OK (lint 음성 7종 + 워크플로 배선 변이 8종 + 격리 lint 대조군 3·음성 14종 + 요약 12종 + nightly 흐름 7종 + 타깃별 DB 실행기 8종·nightly 배선 3종 + 대상 병렬 실행: 동시성·상한·직렬 동치·잘못된 JOBS 4종·실패/0개/결과 없음/0 기록/선택 밖 결과 5종 + 대조군 + psql 대리인 8종)"
