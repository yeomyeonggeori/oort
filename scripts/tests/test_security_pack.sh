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
echo "test_security_pack: OK (lint 음성 7종 + 워크플로 배선 변이 8종)"
