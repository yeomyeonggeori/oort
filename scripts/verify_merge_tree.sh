#!/usr/bin/env bash
# =============================================================================
# scripts/verify_merge_tree.sh — 병합 트리 크로스-클라 게이트 (#1108)
#
# **머지 결과가 검증되지 않는다**는 실패 양식을 닫는다. 같은 양식이 두 번 왔다:
#   ① U4-4 W-1 — 게이트 증거를 **버려질 판**에서 수집했다(브랜치 HEAD 는 초록,
#      병합 결과는 아무도 안 봄).
#   ② U4-6 B1 — 웹 PR 이 코어 API 를 재편했고 폰 PR 은 옛 API 를 소비했다. 각
#      브랜치는 각자 초록이었고, **병합 트리에서만** 폰이 tsc TS2353 로 무너졌다.
#      런타임(Metro 는 타입을 지운다)에서는 오프라인 승인 버튼이 되살아났다.
#      리뷰 경고: "세우지 않으면 세 번째가 온다."
#
# 이 스크립트가 재는 것은 **브랜치가 아니라 병합 결과**다. 그래서 워킹 트리를
# 건드리지 않고 `git merge-tree --write-tree` 로 병합 트리를 만들고, 그 트리를
# 임시 워크트리에 실체화한 뒤 거기서 웹·폰·코어 3종을 컴파일한다. 브랜치 HEAD 는
# 한 번도 체크아웃되지 않는다 — 그것이 지금까지 초록이었던 그 판이기 때문이다.
#
# 사용:
#   scripts/verify_merge_tree.sh                        # HEAD 를 origin/track/engine 에
#   scripts/verify_merge_tree.sh --base main --head PR브랜치
#   scripts/verify_merge_tree.sh --install              # 병합 트리에서 npm ci 를 새로
#
# 환경/플래그:
#   --base <ref>     병합 대상(기본 origin/track/engine, MERGE_TREE_BASE 로도 지정)
#   --head <ref>     병합할 쪽(기본 HEAD, MERGE_TREE_HEAD)
#   --install        node_modules 를 재사용하지 않고 병합 트리에서 npm ci 한다.
#                    락파일이 병합으로 바뀌면 자동으로 이 모드가 된다.
#   --typecheck-only 스위트를 건너뛰고 3종 컴파일만 본다(빠른 사전 확인용).
#   --keep           끝나고 임시 워크트리를 남긴다(디버깅 전용).
#
# 판정: 어느 한 갈래라도 실패하면 exit 1 이고, 실행표를 이름으로 찍는다.
# "안 돌린 것"과 "초록"이 구별되지 않는 상태는 만들지 않는다 — 건너뛴 갈래는
# skip 과 사유로 표에 남는다.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

BASE_REF="${MERGE_TREE_BASE:-origin/track/engine}"
HEAD_REF="${MERGE_TREE_HEAD:-HEAD}"
DO_INSTALL=0
TYPECHECK_ONLY=0
KEEP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE_REF="$2"; shift 2 ;;
    --head) HEAD_REF="$2"; shift 2 ;;
    --install) DO_INSTALL=1; shift ;;
    --typecheck-only) TYPECHECK_ONLY=1; shift ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '3,35p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "[merge-tree] unknown argument: $1" >&2; exit 2 ;;
  esac
done

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[merge-tree] missing required command: $1" >&2
    exit 1
  }
}
need git
need npm

# The ancestry gate below is only meaningful against fresh remote refs. Always
# refresh main plus any origin/* base/head actually requested. This preserves
# the canonical default while allowing an OSS fork without track/* branches to
# run `--base origin/main` instead of failing on unrelated missing refs.
FETCH_SPECS=(+refs/heads/main:refs/remotes/origin/main)
for requested_ref in "$BASE_REF" "$HEAD_REF"; do
  case "$requested_ref" in
    origin/*)
      requested_branch="${requested_ref#origin/}"
      FETCH_SPECS+=("+refs/heads/$requested_branch:refs/remotes/origin/$requested_branch")
      ;;
  esac
done
if ! git fetch --no-tags origin "${FETCH_SPECS[@]}"; then
  echo "[merge-tree] canonical ref fetch failed; refusing stale merge-tree evidence" >&2
  exit 1
fi

# git merge-tree --write-tree 는 2.38 부터다. 그 이전 git 의 merge-tree 는 전혀
# 다른 것(트리 3개 진단 출력)이라 조용히 틀린 답을 내므로 여기서 막는다.
git_version="$(git --version | awk '{print $3}')"
git_major="${git_version%%.*}"
git_rest="${git_version#*.}"
git_minor="${git_rest%%.*}"
if [ "$git_major" -lt 2 ] || { [ "$git_major" -eq 2 ] && [ "$git_minor" -lt 38 ]; }; then
  echo "[merge-tree] git >= 2.38 필요 (현재 $git_version) — --write-tree 가 없다" >&2
  exit 1
fi

BASE_OID="$(git rev-parse --verify "${BASE_REF}^{commit}" 2>/dev/null)" || {
  echo "[merge-tree] base ref 를 못 찾는다: $BASE_REF (git fetch 부터)" >&2
  exit 1
}
HEAD_OID="$(git rev-parse --verify "${HEAD_REF}^{commit}" 2>/dev/null)" || {
  echo "[merge-tree] head ref 를 못 찾는다: $HEAD_REF" >&2
  exit 1
}

# A stale track base can produce a perfectly green synthetic tree that still
# omits work already on main. The fetch above makes this an actual remote
# freshness proof rather than a comparison of potentially stale tracking refs.
scripts/check_track_alignment.sh --contains-main "$BASE_OID"

echo "[merge-tree] base $BASE_REF ($(git rev-parse --short "$BASE_OID"))"
echo "[merge-tree] head $HEAD_REF ($(git rev-parse --short "$HEAD_OID"))"

# 커밋되지 않은 변경은 병합 트리에 들어가지 않는다. 그걸 말하지 않으면 이 게이트가
# "지금 내 변경"을 봤다고 오해하기 딱 좋다 — U4-4 W-1 이 정확히 그 오해였다.
if [ "$HEAD_REF" = "HEAD" ] && [ -n "$(git status --porcelain)" ]; then
  echo "[merge-tree] WARN 워킹 트리에 커밋되지 않은 변경이 있다 — 이 게이트는 그것을 보지 않는다."
  git status --short | sed 's/^/[merge-tree]   /'
fi

if git merge-base --is-ancestor "$HEAD_OID" "$BASE_OID"; then
  echo "[merge-tree] head 가 이미 base 에 들어 있다 — 병합할 것이 없다."
fi

TMP_ROOT="${TMPDIR:-/tmp}/momo-merge-tree-$(date -u +%s)-$$"
WORKTREE="$TMP_ROOT/tree"
mkdir -p "$TMP_ROOT"

cleanup() {
  local rc=$?
  if [ "$KEEP" = "1" ]; then
    echo "[merge-tree] --keep — 워크트리를 남긴다: $WORKTREE"
  else
    git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
    rm -rf "$TMP_ROOT"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---- 1) 병합 트리 -----------------------------------------------------------
# --write-tree 는 충돌이 있으면 non-zero 로 끝난다. 충돌은 이 게이트의 첫 번째
# 발견이지 실행 오류가 아니므로 이름을 붙여 실패한다.
MERGE_OUT="$TMP_ROOT/merge-tree.out"
if ! git merge-tree --write-tree "$BASE_OID" "$HEAD_OID" >"$MERGE_OUT" 2>"$TMP_ROOT/merge-tree.err"; then
  echo "[merge-tree] FAIL 병합 충돌 — 병합 결과를 만들 수 없다" >&2
  cat "$MERGE_OUT" >&2
  cat "$TMP_ROOT/merge-tree.err" >&2
  exit 1
fi
MERGE_TREE_OID="$(head -n 1 "$MERGE_OUT")"
MERGE_COMMIT="$(git commit-tree "$MERGE_TREE_OID" -p "$BASE_OID" -p "$HEAD_OID" \
  -m "merge-tree gate: $HEAD_REF into $BASE_REF")"
echo "[merge-tree] 병합 트리 $(git rev-parse --short "$MERGE_TREE_OID") (임시 커밋 $(git rev-parse --short "$MERGE_COMMIT"))"

git worktree add --detach "$WORKTREE" "$MERGE_COMMIT" >/dev/null

# ---- 2) 의존성 --------------------------------------------------------------
# 기본은 소스 체크아웃의 node_modules 를 심볼릭 링크로 빌려 쓴다: 3종 npm ci 는
# 수 분이고, 이 게이트는 머지 루틴에서 매번 도는 자리이기 때문이다. 다만 **락파일이
# 병합으로 바뀌었으면 빌려 쓰기가 거짓말이 된다** — 그 경우 자동으로 설치 모드다.
# 설치 단위 세 곳. 코어는 npm workspace 라서 락파일도 node_modules 도 **레포 루트**에
# 있다(packages/momo-core 에는 둘 다 없다) — 여기서 그걸 틀리면 매번 설치 모드가 되고,
# 빌려 쓰기 경로는 죽은 코드가 된다.
INSTALL_DIRS=("." "clients/web" "clients/mobile")

lane_stale() {
  local dir="$1"
  ! diff -q "$REPO_ROOT/$dir/package-lock.json" \
    "$WORKTREE/$dir/package-lock.json" >/dev/null 2>&1
}

if [ "$DO_INSTALL" = "0" ]; then
  for dir in "${INSTALL_DIRS[@]}"; do
    # 비교 대상은 **지금 이 체크아웃**의 락파일이다. 빌려 쓸 node_modules 가 그
    # 락파일로 설치된 것이므로, 병합 결과의 락파일이 다르면 빌려 쓰기는 거짓말이 된다.
    if lane_stale "$dir"; then
      echo "[merge-tree] $dir 의 락파일이 이 체크아웃과 다르다 — 설치 모드로 전환"
      DO_INSTALL=1
      break
    fi
  done
fi

for dir in "${INSTALL_DIRS[@]}"; do
  if [ "$DO_INSTALL" = "1" ]; then
    echo "[merge-tree] npm ci — ${dir#./}"
    (cd "$WORKTREE/$dir" && npm ci --silent >/dev/null)
  else
    [ -d "$REPO_ROOT/$dir/node_modules" ] || {
      echo "[merge-tree] $dir/node_modules 가 없다 — 먼저 설치하거나 --install 로 돌려라" >&2
      exit 1
    }
    ln -s "$REPO_ROOT/$dir/node_modules" "$WORKTREE/$dir/node_modules"
  fi
done

# ---- 3) 실행표 --------------------------------------------------------------
RESULTS=()
FAILED=0

run_lane() {
  local name="$1" dir="$2"
  shift 2
  echo ""
  echo "[merge-tree] ===== $name ====="
  local log="$TMP_ROOT/${name//[^a-zA-Z0-9]/_}.log"
  if (cd "$WORKTREE/$dir" && "$@" >"$log" 2>&1); then
    RESULTS+=("green  $name")
    echo "[merge-tree] green $name"
  else
    RESULTS+=("RED    $name")
    FAILED=1
    echo "[merge-tree] RED   $name" >&2
    tail -n 60 "$log" >&2
  fi
}

# 코어가 먼저다. 두 소비자가 같은 API 를 다르게 읽는 것이 이 게이트가 존재하는
# 이유이므로, 코어가 무너졌으면 그 아래 두 빨강은 파생이라는 것을 순서가 말한다.
run_lane "core typecheck" "packages/momo-core" npm run typecheck
run_lane "web typecheck" "clients/web" npm run typecheck
run_lane "phone typecheck" "clients/mobile" npm run typecheck

if [ "$TYPECHECK_ONLY" = "1" ]; then
  RESULTS+=("skip   core suite (--typecheck-only)")
  RESULTS+=("skip   web suite (--typecheck-only)")
  RESULTS+=("skip   phone suite (--typecheck-only)")
else
  run_lane "core suite" "packages/momo-core" npm test
  run_lane "web suite" "clients/web" npm test
  run_lane "phone suite" "clients/mobile" npm test
fi

# 사용자 가시 문자열 (이슈 #1141) — 웹과 코어를 한 번에.
#
# 컴파일도 스위트도 이것을 보지 못한다: em-dash 를 적어도 타입은 맞고 테스트는
# 초록이며, 코어의 문장은 두 클라가 **그대로** 화면에 내놓는다. #1138 B2 가 출하
# 직전에 사람 눈으로 잡힌 이유가 그것이다.
#
# 이 게이트에 있는 이유는 여기가 이미 「두 소비자가 코어를 함께 소비한다」를 재는
# 자리이기 때문이다. #1171 은 코어만 걸었다 — 웹이 base 빨강(emdash 12)이라 함께
# 들여올 수 없었다. 그 12건이 11 오탐 + 1 검토된 예외로 판정되어 웹도 하드 제로가
# 된 지금(#1141 완결), 한 실행이 두 층을 다 말한다.
# 규칙과 근거는 scripts/design_preflight_core.mjs 머리말.
run_lane "copy scan (web + core)" "." bash scripts/design_preflight_web.sh

# 정본 웹 클라의 ESLint — 여덟 번째 레인 (#1210).
#
# `clients/web/eslint.config.js` 는 두 디자인 규칙을 `no-restricted-syntax` 로
# 진다: JSX `style=` 금지(셸의 CSP `style-src 'self'`)와 `#rrggbb` 리터럴 금지
# (색은 tokens.css 에서만 온다). **그 규칙을 지금까지 어느 게이트도 실행하지
# 않았다.** `local_gate.sh --profile web` 의 lint 단계가 도는 것은
# `clients/web-legacy`(ADR-0119 v0, UI 로는 동결)이고, 이 표에는 lint 가 없었다.
# 정본 UI 의 규칙은 사람이 `npm run lint` 를 손으로 칠 때만 돌고 있었다
# (감사 2026-08-09 §B-5 ②).
#
# 지금까지 손실이 없었던 이유는 `design_preflight_web.sh` 의 raw_color·inline_style
# 분류가 같은 두 규칙을 그렙으로 **중복** 커버했기 때문이다. 즉 안전망이 중복
# 하나뿐이었고, 그 중복이 걷히는 날 조용해진다.
#
# 그리고 이 레인이 더하는 것은 그 두 규칙만이 아니다. 실측한 예: 조건 안에서
# 부른 훅(`react-hooks/rules-of-hooks`, error)은 **tsc 초록 · 그렙 프리플라이트
# 초록 · 이 레인만 빨강**이다. 정본 UI 의 lint 가 게이트 밖이던 동안 그런 결함은
# 사람이 손으로 `npm run lint` 를 칠 때까지 아무 데서도 붉지 않았다.
#
# 새 프로파일을 세우지 않고 이 표에 한 줄을 더한 이유: 여기가 이미 웹의
# node_modules 를 세워 두고 병합 **결과**에서 도는 자리다. 새 실행 단위를 만들면
# 그 단위를 돌릴 보장이 다시 사람이 되고, 그것이 §B-5 ① 이 지적한 구멍 자체다.
#
# 문턱은 error 다(경고는 통과). base 실측 `origin/track/engine` 2204c321:
# 0 errors · 12 warnings — react-refresh/only-export-components 11 +
# react-hooks/exhaustive-deps 1. 그 12건까지 빨갛게 만들면 이 레인은 첫날부터
# 우회되는 레인이 된다.
run_lane "web lint (eslint)" "clients/web" npm run lint

echo ""
echo "[merge-tree] ===== 실행표 (병합 결과 $(git rev-parse --short "$MERGE_TREE_OID")) ====="
for row in "${RESULTS[@]}"; do
  echo "[merge-tree]   $row"
done
echo "[merge-tree] ==============================================="

if [ "$FAILED" = "1" ]; then
  echo "[merge-tree] FAIL 병합 트리가 컴파일되지 않는다 — 브랜치가 초록이어도 머지하면 안 된다 (#1108)" >&2
  exit 1
fi
echo "[merge-tree] PASS 웹·폰·코어가 병합 결과에서 함께 선다"
