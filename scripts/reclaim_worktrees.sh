#!/usr/bin/env bash
# MOMO-566: worker 워크트리 디스크 회수 — SPM .build 누적(실측 251GB 전례) 대응.
#
#   scripts/reclaim_worktrees.sh          # 대상 목록과 예상 회수량만 출력(dry-run)
#   scripts/reclaim_worktrees.sh --apply  # 실제 제거
#
# 제거 기준(둘 다 충족해야 함):
#   1) 워킹트리 clean (미커밋 변경 0)
#   2) HEAD가 origin에 보존됨 — origin/main에 포함되었거나, 동명 원격 브랜치가
#      같은 커밋을 가리킴(push 완료)
# 즉 원격에 없는 작업물은 절대 지우지 않는다. 진행 중 goal은 1)에서 걸리거나
# 원격 미push 상태라 2)에서 걸린다.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "[reclaim-worktrees] must run inside the repository" >&2
  exit 1
}
WORKTREES_DIR="${MOMO_WORKTREES_DIR:-$HOME/projects/momo-worktrees}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

cd "$REPO_ROOT"
git fetch origin --quiet || echo "[reclaim-worktrees] warn: fetch failed; using last-known origin refs" >&2

# 활성 fleet goal은 clean(커밋 전)이어도 제거 금지 — exit-code 없는 RUN_DIR의
# goal 번호를 자동 제외한다. 수동 제외는 RECLAIM_EXCLUDE="681 655" 형태.
ACTIVE_GOALS="${RECLAIM_EXCLUDE:-}"
for run_dir in "$HOME"/.codex-fleet/runs/goal-*/; do
  [ -d "$run_dir" ] || continue
  [ -f "$run_dir/exit-code" ] && continue
  goal_num="$(basename "$run_dir" | sed -E 's/^goal-([0-9]+)-.*/\1/')"
  ACTIVE_GOALS="$ACTIVE_GOALS $goal_num"
done

is_active() {
  local name num
  name="$(basename "$1")"
  for num in $ACTIVE_GOALS; do
    case "$name" in "$num"-*) return 0 ;; esac
  done
  return 1
}

total_kb=0
removed=0
kept=0

for wt in "$WORKTREES_DIR"/*/; do
  wt="${wt%/}"
  [ -d "$wt/.git" ] || [ -f "$wt/.git" ] || continue

  if is_active "$wt"; then
    echo "KEEP  $wt (활성 fleet goal)"
    kept=$((kept + 1))
    continue
  fi
  if ! git -C "$wt" rev-parse HEAD >/dev/null 2>&1; then
    echo "KEEP  $wt (git 상태 판독 불가 — 수동 확인)"
    kept=$((kept + 1))
    continue
  fi
  if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
    echo "KEEP  $wt (미커밋 변경 존재)"
    kept=$((kept + 1))
    continue
  fi

  head_sha="$(git -C "$wt" rev-parse HEAD)"
  branch="$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
  preserved=0
  if git merge-base --is-ancestor "$head_sha" origin/main 2>/dev/null; then
    preserved=1
  elif [ "$branch" != "HEAD" ] &&
       [ "$(git rev-parse "origin/$branch" 2>/dev/null || true)" = "$head_sha" ]; then
    preserved=1
  fi
  if [ "$preserved" != "1" ]; then
    echo "KEEP  $wt (HEAD가 origin에 미보존 — branch=$branch)"
    kept=$((kept + 1))
    continue
  fi

  size_kb="$(du -sk "$wt" 2>/dev/null | cut -f1)"
  total_kb=$((total_kb + size_kb))
  if [ "$APPLY" = "1" ]; then
    git worktree remove --force "$wt"
    echo "REMOVED $wt ($((size_kb / 1024 / 1024))GB)"
  else
    echo "REMOVE  $wt ($((size_kb / 1024 / 1024))GB) [dry-run]"
  fi
  removed=$((removed + 1))
done

[ "$APPLY" = "1" ] && git worktree prune

echo "[reclaim-worktrees] $([ "$APPLY" = "1" ] && echo 회수 || echo 예상) ${removed}개 / $((total_kb / 1024 / 1024))GB, 보존 ${kept}개"
[ "$APPLY" = "1" ] || echo "[reclaim-worktrees] 실제 제거는 --apply"
