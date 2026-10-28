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
  printf 'test result: ok. 600 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 9.00s\n' >"$1/main.log"
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

test result: FAILED. 599 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s
error: test failed, to rerun pass `-p fake --test quar_pg`
error: 1 target failed:
    `-p fake --test quar_pg`
LOG
if out="$(report_in "$rn" "$d")"; then fail "요약: 실패한 시험이 있는데 초록"; fi
want_in "요약(실패 상세)" "$out" '`-p fake --test quar_pg`' '`red_probe_two`' 'the probe says no' '::error title=야간 PG 시험 빨강'
# 분기마다 그 분기만 걸리는 입력 — 한 분기가 꺼져도 다른 분기가 대신 잡아 가려지지 않아야 한다.
d="$TMP/rp-failcount"; mk_logs "$d" # 실패 개수만(타깃 목록·오류 줄 없음)
printf 'test result: FAILED. 599 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s\n' >"$d/main.log"
if out="$(report_in "$rn" "$d")"; then fail "요약: 실패 1개(개수만)가 초록"; fi
want_in "요약(실패 개수)" "$out" '실패 1개'
d="$TMP/rp-targetlist"; mk_logs "$d" # 실패 타깃 목록만(실패 개수 0·'test failed' 줄 없음)
printf 'test result: ok. 600 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 9.00s\nerror: 1 target failed:\n    `-p fake --test quar_pg`\n' >"$d/main.log"
if out="$(report_in "$rn" "$d")"; then fail "요약: 실패 타깃 목록만 있는 로그가 초록"; fi
want_in "요약(타깃 목록)" "$out" '`-p fake --test quar_pg`'
d="$TMP/rp-compile"; mk_logs "$d" # 컴파일 오류만
printf 'test result: ok. 600 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 9.00s\nerror: could not compile `fake` (test "quar_pg") due to 1 previous error\n' >"$d/main.log"
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
    if [ "$4" = ok ]; then echo 'test result: ok. 600 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.0s'
    else echo 'test result: FAILED. 599 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.0s'; exit 101; fi ;;
  *prod_role_conformance_pg*) echo 'test result: ok. 13 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 1.0s' ;;
  *"--test quar_pg"*) echo 'test red_probe_two ... $3'; [ "$3" = ok ] || exit 101 ;;
esac
EOF
  chmod +x "$1/cargo"
}
nightly_in() { # <루트> <가짜 bin> — 출력과 종료 코드를 그대로 낸다
  PATH="$2:$PATH" DATABASE_URL='postgres://u:p@127.0.0.1:5432/db' GITHUB_STEP_SUMMARY="$1/step.md" \
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
echo "test_security_pack: OK (lint 음성 7종 + 워크플로 배선 변이 8종 + 격리 lint 대조군 3·음성 14종 + 요약 12종 + nightly 흐름 7종)"
