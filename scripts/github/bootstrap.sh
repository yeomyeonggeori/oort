#!/usr/bin/env bash
# momo — LEGACY GitHub 운영 구조 일괄 부트스트랩 (idempotent)
# 마일스톤(=릴리스) + 라벨 택소노미 + 시드 이슈를 gh CLI로 생성한다.
# 새 9단계 spine 정본은 ../github_bootstrap.sh 이다. 이 파일은 보존용이며,
# 실수 실행 방지를 위해 ALLOW_LEGACY_BOOTSTRAP=1 일 때만 동작한다.
#
# 사용법:
#   ALLOW_LEGACY_BOOTSTRAP=1 scripts/github/bootstrap.sh [--repo Dawn-kim-official/momo] [--dry-run] [--skip-issues]
#
# 전제:
#   - gh CLI 설치 + `gh auth login` 완료. 토큰 스코프: repo (필수).
#   - 라벨/이슈는 repo 스코프로 충분. (issue *types* 는 admin:org 필요 → 파일 하단 주석)
#   - 마일스톤은 native `gh milestone` 명령이 없어 `gh api repos/{owner}/{repo}/milestones` 사용.
#     출처: github.com/cli/cli/issues/1200 (milestone 관리 native 미지원, gh api 우회).
#
# 데이터 소스(같은 디렉터리):
#   labels.tsv      name<TAB>color<TAB>description
#   milestones.tsv  title<TAB>state<TAB>description
#   issues.tsv      title<TAB>milestone<TAB>labels(comma)<TAB>body(\n=개행)
#
# idempotent 규칙:
#   - 라벨: gh label create --force (있으면 update, 없으면 create).
#   - 마일스톤: title로 조회해 있으면 skip, 없으면 create.
#   - 이슈: 동일 title 의 이슈가 있으면 skip(중복 방지).
#
# 구현 메모: eval 미사용(제목/설명에 따옴표·괄호가 섞여도 안전). 인자는 배열로 전달.

set -euo pipefail

REPO=""
DRY_RUN=0
SKIP_ISSUES=0
DIR="$(cd "$(dirname "$0")" && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift;;
    --skip-issues) SKIP_ISSUES=1; shift;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

if [ -z "$REPO" ]; then
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "Dawn-kim-official/momo")"
fi
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
# 배열 인자를 안전 실행. dry-run이면 따옴표 붙여 출력만.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run]'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

command -v gh >/dev/null || { echo "gh CLI 필요. https://cli.github.com" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh auth login 먼저." >&2; exit 1; }

if [ "${ALLOW_LEGACY_BOOTSTRAP:-0}" != "1" ]; then
  echo "scripts/github/bootstrap.sh is legacy. Use scripts/github_bootstrap.sh --org Dawn-kim-official --repo momo." >&2
  echo "Set ALLOW_LEGACY_BOOTSTRAP=1 only if you intentionally need the old TSV seed." >&2
  exit 2
fi

say "repo = $REPO (dry-run=$DRY_RUN)"

# ── 1) 라벨 ──────────────────────────────────────────────────────────────────
say "라벨 생성/갱신 (labels.tsv)"
while IFS=$'\t' read -r lname lcolor ldesc; do
  case "$lname" in ''|\#*) continue;; esac
  run gh label create "$lname" --repo "$REPO" --color "$lcolor" --description "$ldesc" --force
done < "$DIR/labels.tsv"

# ── 2) 마일스톤 (gh api — native 명령 없음) ───────────────────────────────────
say "마일스톤 생성 (milestones.tsv, 중복 skip)"
existing_ms="$(gh api "repos/$OWNER/$NAME/milestones?state=all&per_page=100" -q '.[].title' 2>/dev/null || true)"
while IFS=$'\t' read -r mtitle mstate mdesc; do
  case "$mtitle" in ''|\#*) continue;; esac
  if printf '%s\n' "$existing_ms" | grep -Fxq "$mtitle"; then
    echo "  skip (존재): $mtitle"
    continue
  fi
  run gh api --method POST "repos/$OWNER/$NAME/milestones" \
    -f title="$mtitle" -f state="$mstate" -f description="$mdesc" --silent
  [ "$DRY_RUN" = 0 ] && echo "  created: $mtitle" || true
done < "$DIR/milestones.tsv"

# ── 3) 이슈 ──────────────────────────────────────────────────────────────────
if [ "$SKIP_ISSUES" = 1 ]; then say "이슈 생성 skip (--skip-issues)"; exit 0; fi
say "이슈 생성 (issues.tsv, 동일 title 이슈 있으면 skip)"
existing_issues="$(gh issue list --repo "$REPO" --state all --limit 500 --json title -q '.[].title' 2>/dev/null || true)"
while IFS=$'\t' read -r ititle imilestone ilabels ibody; do
  case "$ititle" in ''|\#*) continue;; esac
  if printf '%s\n' "$existing_issues" | grep -Fxq "$ititle"; then
    echo "  skip (존재): $ititle"
    continue
  fi
  body="$(printf '%b' "$ibody")"          # \n → 실제 개행
  tmp="$(mktemp)"; printf '%s\n' "$body" > "$tmp"
  # 라벨 콤마 → --label 반복 (배열)
  args=(gh issue create --repo "$REPO" --title "$ititle" --body-file "$tmp" --milestone "$imilestone")
  IFS=',' read -ra arr <<< "$ilabels"
  for l in "${arr[@]}"; do [ -n "$l" ] && args+=(--label "$l"); done
  run "${args[@]}"
  rm -f "$tmp"
  [ "$DRY_RUN" = 0 ] && echo "  created: $ititle" || true
done < "$DIR/issues.tsv"

say "완료. Project(roadmap) 추가는 docs/GITHUB_OPS.md §4 참고."

# ── (선택) Issue Types — org 레벨, admin:org 스코프 필요 ───────────────────────
# Issue Types(GitHub 1급 분류; type:* 라벨과 다름)는 org 단위 + admin:org 스코프.
# 출처: docs.github.com/en/rest/orgs/issue-types · github.blog/changelog/2025-03-18-...
# 예시(수동, Dawn-kim-official org admin 권한 필요):
#   gh api --method POST orgs/Dawn-kim-official/issue-types \
#     -f name="Feature" -f is_enabled=true -f color="green" -f description="신규 기능"
# 본 스크립트는 repo 스코프만 가정하므로 type:* 는 라벨로 대체(labels.tsv).
