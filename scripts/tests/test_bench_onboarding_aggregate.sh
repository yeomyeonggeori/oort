#!/usr/bin/env bash
# T-6 / #1656 — bench_onboarding.sh aggregate 가 M5 p50/p95 를 내고
# M1~M4 로직을 건드리지 않는지. docker 없이 timings.tsv 픽스처만 읽는다.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
BENCH="$REPO_ROOT/scripts/bench_onboarding.sh"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/oort-m5-agg-test.XXXXXX")"
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT INT TERM

fail() { echo "[m5-agg-test] FAIL: $*" >&2; exit 1; }
pass() { echo "[m5-agg-test] ok: $*"; }

header=$'cycle\tphase\tmilestone\tms\tnote\n'
write_tsv() {
  local path="$1"
  mkdir -p "$(dirname "$path")"
  printf '%s' "$header" > "$path"
  cat >> "$path"
}

# 5표본. 정렬 100,200,300,400,1000.
# p50 nearest-rank n=5 → idx=ceil(0.5*5)=3 → 300
# p95 → idx=ceil(0.95*5)=5 → 1000
write_tsv "$SANDBOX/run-a/timings.tsv" <<'EOF'
1	P1	first-screen	10000	env
1	P7	first-reply	100	 grok
2	P7	first-reply	200	 grok
3	P7	first-reply	300	 grok
4	P7	first-reply	400	 grok
5	P7	first-reply	1000	 grok
EOF

out="$("$BENCH" aggregate --from "$SANDBOX/run-a/timings.tsv")"
printf '%s\n' "$out" | grep -q 'p50: 0:00.300 (300 ms)' || fail "p50 불일치: $out"
printf '%s\n' "$out" | grep -q 'p95: 0:01.000 (1000 ms)' || fail "p95 불일치: $out"
printf '%s\n' "$out" | grep -q '표본: 5' || fail "표본 수 불일치: $out"
printf '%s\n' "$out" | grep -q '게이트가 아니다' || fail "게이트 아님 고지 없음"
pass "단일 tsv p50/p95"

write_tsv "$SANDBOX/run-b/timings.tsv" <<'EOF'
1	P7	first-reply	50	 second run
EOF
out="$("$BENCH" aggregate --evidence-root "$SANDBOX")"
printf '%s\n' "$out" | grep -q '표본: 6' || fail "디렉터리 합산 실패: $out"
pass "evidence-root 합산"

empty="$SANDBOX/empty"
mkdir -p "$empty"
write_tsv "$empty/timings.tsv" <<'EOF'
1	P1	first-screen	123	 no m5
EOF
out="$("$BENCH" aggregate --from "$empty/timings.tsv")"
printf '%s\n' "$out" | grep -q '표본 없음' || fail "빈 M5 표본 문구 없음: $out"
printf '%s\n' "$out" | grep -q 'p50:' && fail "빈 표본에 p50 이 나오면 안 된다"
pass "M5 없으면 표본 없음"

# M1~M4 본문은 집계 모드가 실행하지 않는다.
if grep -n 'MODE_ACTION = "aggregate"' "$BENCH" | grep -q .; then
  :
fi
# run_cycle 안의 M1 발급은 aggregate 분기 뒤에 있다. 소스 계약:
agg_line="$(grep -n 'MODE_ACTION" = "aggregate"' "$BENCH" | head -1 | cut -d: -f1)"
m4_line="$(grep -n 'emit_timing .* M4 ' "$BENCH" | head -1 | cut -d: -f1)"
[ -n "$agg_line" ] && [ -n "$m4_line" ] || fail "aggregate/M4 앵커 없음"
[ "$agg_line" -lt "$m4_line" ] || fail "aggregate 가 M4 발급보다 뒤에 있다"
# M1~M4 emit_timing 호출 수가 이 티켓에서 늘어나면 안 된다(가산만).
m_count="$(grep -c 'emit_timing .* M[1-4] ' "$BENCH" || true)"
[ "$m_count" -eq 4 ] || fail "M1~M4 emit_timing 이 4가 아니다: $m_count"
pass "M1~M4 로직 비접촉"

echo "[m5-agg-test] $SANDBOX 기준 PASS"
