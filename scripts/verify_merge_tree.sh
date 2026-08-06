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

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
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
