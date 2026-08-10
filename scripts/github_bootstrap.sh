#!/usr/bin/env bash
# =============================================================================
# momo — GitHub 운영 구조 일괄 부트스트랩 (spine 기반, 멱등)
# -----------------------------------------------------------------------------
# 무엇:  gh CLI 로 라벨(labels.json) + 마일스톤(M0~M8) + 시드 이슈(MOMO-NNN)를
#        ROADMAP.md / SPINE 정본에 맞춰 일괄 생성한다. 모두 멱등(존재 시 skip/update).
#
# ⚠️ 실제 생성은 "사용자가 직접 실행"한다. 이 스크립트는 yeomyeonggeori/oort 에 라벨/마일스톤/
#    이슈를 실제로 만든다(원격 변경). Codex/자동화는 이 파일을 작성·검증만 하고,
#    트리거(실행)는 권한 가진 사람이 한다. 먼저 --dry-run 으로 검토할 것.
#
# 사용법:
#   scripts/github_bootstrap.sh --dry-run            # 무엇이 만들어질지 출력만 (원격 무변경)
#   scripts/github_bootstrap.sh                      # 실제 적용 (ORG=yeomyeonggeori REPO=oort 기본)
#   scripts/github_bootstrap.sh --labels-only        # 라벨만
#   scripts/github_bootstrap.sh --skip-issues        # 라벨+마일스톤만
#   ORG=myorg REPO=myrepo scripts/github_bootstrap.sh   # 대상 변경(환경변수)
#   scripts/github_bootstrap.sh --org myorg --repo myrepo
#
# 전제:
#   - gh CLI 설치 + `gh auth login` 완료(토큰 스코프 repo). 미설치/미인증이면 안내 후 종료.
#   - jq 설치(.github/labels.json 파싱). 미설치면 안내 후 종료.
#   - 마일스톤은 native `gh milestone` 명령이 없어(2026 현재, cli/cli#1200)
#     `gh api repos/{owner}/{repo}/milestones` 로 생성한다.
#
# 멱등 규칙:
#   - 라벨:     `gh label create --force` (있으면 update, 없으면 create). 출처: cli/cli#5450.
#   - 마일스톤: title 로 조회해 있으면 skip, 없으면 create.
#   - 이슈:     동일 title 의 이슈(open/closed)가 있으면 skip(중복 방지).
#
# 데이터 소스:
#   - 라벨:     .github/labels.json (정본 택소노미)
#   - 마일스톤: 이 파일 하단 MILESTONES heredoc (M0~M8, ROADMAP §1 정본)
#   - 이슈:     이 파일 하단 TICKETS heredoc (MOMO-NNN, SPINE tickets)
#
# 정합: 마일스톤 9단계(M0~M8)는 ROADMAP.md 가 상위 정본. 기존 scripts/github/*.tsv 의
#       7단계(M0~M6)는 부분집합이며, 본 스크립트(spine)가 9단계 backbone을 만든다.
#       라벨은 .github/labels.json + scripts/github/labels.tsv 와 정합(같은 택소노미).
# =============================================================================
set -euo pipefail

# ── 대상(ORG/REPO) — 환경변수 또는 플래그로 오버라이드 ─────────────────────────
ORG="${ORG:-yeomyeonggeori}"
REPO="${REPO:-oort}"
DRY_RUN=0
LABELS_ONLY=0
SKIP_ISSUES=0

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABELS_JSON="$ROOT/.github/labels.json"

while [ $# -gt 0 ]; do
  case "$1" in
    --org) ORG="$2"; shift 2;;
    --repo) REPO="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift;;
    --labels-only) LABELS_ONLY=1; shift;;
    --skip-issues) SKIP_ISSUES=1; shift;;
    -h|--help) grep '^#' "$0" | sed 's/^#\{1,\} \{0,1\}//'; exit 0;;
    *) echo "unknown arg: $1 (--help 참고)" >&2; exit 2;;
  esac
done

SLUG="$ORG/$REPO"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; }

# 배열 인자를 안전 실행(eval 미사용 — 제목/본문에 따옴표·괄호 섞여도 안전).
# dry-run 이면 따옴표 붙여 출력만.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run]'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

# ── 0) 전제 점검: gh 설치/인증 + jq ──────────────────────────────────────────
if ! command -v gh >/dev/null 2>&1; then
  err "gh CLI 가 설치되어 있지 않습니다."
  cat >&2 <<'EOF'
  설치:
    macOS:   brew install gh
    기타:    https://cli.github.com/  (또는 https://github.com/cli/cli#installation)
  설치 후:   gh auth login   (HTTPS + 토큰 스코프 repo)
EOF
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  err "jq 가 설치되어 있지 않습니다(.github/labels.json 파싱에 필요)."
  echo "  설치: brew install jq  |  apt-get install jq" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  err "gh 인증이 안 되어 있습니다."
  cat >&2 <<'EOF'
  먼저 로그인:
    gh auth login
  스코프 확인/추가(라벨·이슈·마일스톤 생성은 repo 스코프면 충분):
    gh auth status
    gh auth refresh -s repo
EOF
  exit 1
fi

if [ ! -f "$LABELS_JSON" ]; then
  err "라벨 정본을 찾을 수 없습니다: $LABELS_JSON"
  exit 1
fi

# 리포 접근 확인(존재/권한). dry-run 에서도 확인은 한다(읽기).
if ! gh repo view "$SLUG" >/dev/null 2>&1; then
  warn "리포 $SLUG 에 접근할 수 없습니다(미존재이거나 권한 없음)."
  warn "리포를 먼저 만드세요:  gh repo create $SLUG --private --source=. --remote=origin"
  warn "그래도 진행하면 생성 호출에서 실패할 수 있습니다."
fi

say "대상 = $SLUG  (dry-run=$DRY_RUN, labels-only=$LABELS_ONLY, skip-issues=$SKIP_ISSUES)"

# ── 1) 라벨 (.github/labels.json → gh label create --force, 멱등) ─────────────
say "라벨 생성/갱신 (.github/labels.json)"
# jq 로 name/color/description 를 NUL 구분 레코드로 흘려 안전 파싱.
while IFS=$'\t' read -r lname lcolor ldesc; do
  [ -z "$lname" ] && continue
  run gh label create "$lname" --repo "$SLUG" --color "$lcolor" --description "$ldesc" --force
done < <(jq -r '.labels[] | [.name, .color, (.description // "")] | @tsv' "$LABELS_JSON")

if [ "$LABELS_ONLY" = 1 ]; then say "labels-only 완료."; exit 0; fi

# ── 2) 마일스톤 (gh api — native 명령 없음, cli/cli#1200) ─────────────────────
say "마일스톤 생성 (M0~M8, 존재 시 skip)"
existing_ms="$(gh api "repos/$ORG/$REPO/milestones?state=all&per_page=100" -q '.[].title' 2>/dev/null || true)"
declared_ms_titles=""

# title<TAB>description  (state 는 모두 open). 순서가 곧 로드맵(ROADMAP §1).
create_milestone() {
  local mtitle="$1" mdesc="$2"
  if printf '%s\n' "$existing_ms" | grep -Fxq "$mtitle"; then
    echo "  skip (존재): $mtitle"; return 0
  fi
  run gh api --method POST "repos/$ORG/$REPO/milestones" \
    -f title="$mtitle" -f state="open" -f description="$mdesc" --silent
  [ "$DRY_RUN" = 0 ] && echo "  created: $mtitle" || true
}

while IFS=$'\t' read -r mtitle mdesc; do
  case "$mtitle" in ''|\#*) continue;; esac
  declared_ms_titles="${declared_ms_titles}${mtitle}"$'\n'
  create_milestone "$mtitle" "$mdesc"
done <<'MILESTONES'
M0 Foundation (완료)	리포 골격 + 5개 Swift 패키지(MomoCore/MomoServer/OutboxRelay/AgentWorker/MomoMac) 컴파일 통과 + 정본 스키마/인프라/마이그레이션 파일 정합. Phase 0 baseline = 달성됨. exit: swift build green ×5 + schema_v0.sql/infra/Migrations 정합 + adapters/hermes py_compile.
M1 Backend 런타임 + 배포(staging)	docker(PG18+Centrifugo v6+hermes)에서 서버 런타임 e2e(seq/outbox/relay/RLS/SSE/비용회계) + staging 배포(단일 VPS + Caddy 자동TLS + Redis 엔진 + pgBackRest PITR + SOPS/age 시크릿 + 경량 모니터링). exit: G-0 런타임 e2e PASS + staging URL 헬스 green + TLS/시크릿/백업 검증. 선행 M0.
M2 멀티팀 온보딩	워크스페이스 스핀업 + 스핀업별 고유 초대코드→자가가입 + 플랫폼 관리자 전체 추적. schema_v0.sql 위에 003_onboarding.sql(invite_code + platform_admin)로 확장(정본 미수정). exit: 3개+ 팀(10인=1팀) 격리 + 초대코드 자가가입 e2e + 관리자 전역 조회. 선행 M1.
M3 데스크탑 v0 UX (D/B/C 실데이터)	macOS 클라가 D Live Tool-Call · B 비용 호흡 링 · C 승인 인박스를 staging 실데이터로 렌더. MomoMac VM↔LiveBackend 바인딩. exit: D/B/C 3경험이 staging 백엔드(M1) 실접속으로 동작. 선행 M1.
M4 데스크탑 패키징 (Xcode·공증·DMG·Sparkle)	macOS Xcode .app + Developer ID 서명 + notarytool 공증 + DMG + Sparkle 2 자동업데이트. App Store 트랙과 별개의 직접배포 경로. exit: 공증 .dmg가 타 맥에서 spctl 통과 + Sparkle 업데이트 1회. 선행 M3 (+ 배포는 M7 게이트 PASS 후).
M5 iOS 앱	iOS Xcode App 타깃 + explicit Bundle ID + Push capability + APNs(.p8 ES256) + 계정 삭제(5.1.1(v)) + UGC 모더레이션 4종(1.2) + PrivacyInfo.xcprivacy. iOS 26 SDK/Xcode 26 이상 빌드. exit: 실기기에서 로그인→채널→메시지→에이전트 응답 + 멀티팀 초대코드 자가가입. 선행 M3, M2.
M6 CI/CD (fastlane·ASC API key)	fastlane(match/pilot/deliver/notarytool) + App Store Connect API Key(Team Key) + GitHub Actions 자동화. release 워크플로우는 게이트 전 비활성/dry-run. exit: ci-build green + match 동기화 + 6개 필수 secret + release-*.yml syntax/lint+dry-run(미트리거). 선행 M0, M4, M5.
M7 QA · 사용성 검수 게이트	빌드 산출물의 사용성을 빡세게 검수해 "사용 가능 완전 판명". G-0~G-G 객관 통과기준 측정·PASS. 🔒 스토어 제출 선행 차단 게이트. exit: G-0~G-G 전부 PASS + 증거 첨부 + docs/cicd/03 상단 PASS 블록(날짜+커밋+빌드#+증거). 선행 M1,M3,M4,M5,M6.
M8 스토어 제출 (App Store + Developer ID)	macOS 공증 DMG 공개 다운로드(+Sparkle 라이브) + iOS App Store Connect 업로드→App Review→배포. 🔒 M7 게이트 PASS 후에만 진행. exit: M7 PASS 기록 확인 + App Store 승인·배포 + 공증 DMG 공개 + Sparkle 라이브. 선행 M7, M4, M5, M6.
MILESTONES

# 마일스톤 title 의 prefix(M0..M8)로 이슈를 마일스톤에 매칭하기 위한 룩업.
# gh issue create --milestone 는 정확한 title 을 요구하므로, 갱신된 목록을 다시 읽는다.
remote_ms_titles="$(gh api "repos/$ORG/$REPO/milestones?state=all&per_page=100" -q '.[].title' 2>/dev/null || true)"
if [ "$DRY_RUN" = 1 ]; then
  ms_titles="$(printf '%s\n%s\n' "$remote_ms_titles" "$declared_ms_titles" | sed '/^$/d')"
else
  ms_titles="$remote_ms_titles"
fi
milestone_for() {  # $1 = "M3" → 해당 prefix 로 시작하는 전체 title 반환
  printf '%s\n' "$ms_titles" | grep -m1 -E "^$1( |\$)" || true
}

# ── 3) 이슈 (MOMO-NNN, 동일 title 있으면 skip) ────────────────────────────────
if [ "$SKIP_ISSUES" = 1 ]; then say "이슈 생성 skip (--skip-issues)"; exit 0; fi
say "시드 이슈 생성 (MOMO-NNN, 동일 title 이슈 있으면 skip)"
existing_issues="$(gh issue list --repo "$SLUG" --state all --limit 1000 --json title -q '.[].title' 2>/dev/null || true)"

# TICKETS heredoc 포맷:  id<TAB>Mn<TAB>labels(comma)<TAB>title<TAB>body(\n=개행)
# title 은 "MOMO-NNN: <title>" 로 만들어 멱등 매칭/추적 용이.
created=0; skipped=0
while IFS=$'\t' read -r tid tms tlabels ttitle tbody; do
  case "$tid" in ''|\#*) continue;; esac
  full_title="$tid: $ttitle"
  if printf '%s\n' "$existing_issues" | grep -Fxq "$full_title"; then
    echo "  skip (존재): $full_title"; skipped=$((skipped+1)); continue
  fi
  ms_title="$(milestone_for "$tms")"
  if [ -z "$ms_title" ]; then
    warn "마일스톤 미발견($tms) → 마일스톤 없이 생성: $full_title"
  fi
  body="$(printf '%b' "$tbody")"   # \n → 실제 개행
  tmpf="$(mktemp)"; printf '%s\n' "$body" > "$tmpf"
  args=(gh issue create --repo "$SLUG" --title "$full_title" --body-file "$tmpf")
  [ -n "$ms_title" ] && args+=(--milestone "$ms_title")
  IFS=',' read -ra larr <<< "$tlabels"
  for l in "${larr[@]}"; do [ -n "$l" ] && args+=(--label "$l"); done
  run "${args[@]}"
  rm -f "$tmpf"
  [ "$DRY_RUN" = 0 ] && { echo "  created: $full_title"; created=$((created+1)); } || true
done <<'TICKETS'
MOMO-001	M1	type:infra,area:server,area:infra,status:runtime-unverified,gate:qa,size:m	docker 런타임 e2e: migrate 멱등 + /health + seq 갭리스	## Goal\ndocker(PG18+Centrifugo v6) 기동 후 migrate 멱등 적용 + /health 200 + 메시지 송신 시 channel_seq 갭리스 발급(동시 송신 직렬화)을 런타임 확인.\n\n## Context\n- Epic EP-RT · Milestone M1 · platform backend\n- Spec: research/07-deepdive/04-self-build-l4-spec.md §3.1, §8.1\n- Schema: schema_v0.sql channel_seq/message/outbox\n\n## Acceptance\n- [ ] [runtime] make migrate(001→002) 멱등(재실행 무오류)\n- [ ] [runtime] MomoServer 기동 → GET /health 200\n- [ ] [runtime] 메시지 송신 → channel_seq UPDATE...RETURNING 갭리스 seq(동시 직렬화)\n- [ ] STATUS.md runtime-unverified 항목 갱신\n\n## Depends on: M0
MOMO-002	M1	type:infra,area:relay,area:infra,status:runtime-unverified,gate:qa,size:m	outbox→relay→Centrifugo publish 왕복 검증	## Goal\n메시지 INSERT + outbox INSERT 단일 tx → OutboxRelay SKIP LOCKED 클레임 → Centrifugo /api/publish → status=done → 구독 클라 version=seq 수신(멱등 무손실).\n\n## Context\n- Epic EP-RT · M1 · backend · Spec L4 §8.1\n\n## Acceptance\n- [ ] [runtime] message+outbox 단일 tx commit\n- [ ] [runtime] relay 클레임→publish→done\n- [ ] [runtime] 구독 클라 version=seq 수신, 중복 무손실\n- [ ] STATUS.md 갱신\n\n## Depends on: MOMO-001
MOMO-003	M1	type:infra,area:schema,area:tenancy,status:runtime-unverified,gate:qa,size:m	RLS 테넌트 격리 런타임 검증	## Goal\nSET LOCAL app.workspace_id 누락 시 행 미노출, 워크스페이스 A에서 B의 message/channel/member 조회 불가, relay/worker BYPASSRLS만 전 테넌트 폴링 가능 확인.\n\n## Context\n- Epic EP-RT · M1 · backend · Spec L4 §1.3, §9.1\n\n## Acceptance\n- [ ] [runtime] workspace_id 누락 시 0건\n- [ ] [runtime] 교차 워크스페이스 조회 불가\n- [ ] [runtime] BYPASSRLS role만 전 테넌트 조회\n- [ ] STATUS.md 갱신\n\n## Depends on: MOMO-001
MOMO-004	M1	type:feature,area:worker,status:runtime-unverified,gate:qa,size:l	AgentWorker↔hermes SSE 실연결 + 비용 reserve/reconcile	## Goal\n김인턴 멘션 → outbox(agent_job) 클레임 → agent_run 게이트(step/depth) → hermes OpenAI-compat /v1/chat/completions SSE 델타를 message PATCH 스트리밍 → 호출 전 budget_window reserve / 호출 후 usage_ledger reconcile(서킷브레이커 트립 경로 포함).\n\n## Context\n- Epic EP-RT · M1 · backend · Spec L4 §3.5, §6.2, §6.3, §8.5\n\n## Acceptance\n- [ ] [runtime] 멘션→agent.partial 스트리밍 수신\n- [ ] [runtime] reserve→reconcile 1행 기록\n- [ ] [runtime] 6중 루프 게이트 기본값 동작\n- [ ] STATUS.md 갱신\n\n## Depends on: MOMO-002
MOMO-005	M1	type:infra,area:infra,status:runtime-unverified,size:l	docker-compose.prod: Caddy 자동TLS + Centrifugo Redis 엔진	## Goal\ninfra/prod/docker-compose.prod.yml(caddy 자동HTTPS + redis, relay/worker 실서비스 승격) + Caddyfile(api/rt 라우팅 + 보안헤더, subscribe proxy 콜백은 compose 네트워크 내) + Centrifugo Memory→Redis 엔진 전환.\n\n## Context\n- Epic EP-DEPLOY · M1 · backend\n\n## Acceptance\n- [ ] [infra] docker-compose.prod.yml 정합(caddy/redis/relay/worker)\n- [ ] [infra] Caddyfile 도메인 라우팅+보안헤더\n- [ ] [infra] Centrifugo Redis 엔진 설정\n- [ ] runtime-unverified 표기\n\n## Depends on: MOMO-001
MOMO-006	M1	type:infra,area:infra,status:runtime-unverified,size:m	시크릿 관리(SOPS+age) + DB 백업(pgBackRest PITR)	## Goal\nSOPS+age 로 .env 암호화(git 버전관리, 배포 시 메모리 복호화) + change-me/dev-insecure 기본값을 openssl rand 로 교체 + pgBackRest 주간 풀 + 연속 WAL 아카이빙 + 복원(PITR) 1회 검증.\n\n## Context\n- Epic EP-DEPLOY · M1 · backend\n\n## Acceptance\n- [ ] [infra] SOPS/age 암호화 .env + 복호화 절차\n- [ ] [infra] 약한 기본값 교체\n- [ ] [runtime] pgBackRest 구성 + PITR 1회 검증\n\n## Depends on: MOMO-005
MOMO-007	M1	type:infra,area:infra,type:docs,status:runtime-unverified,size:m	staging 배포 + 경량 모니터링 + RUN 런북 갱신	## Goal\nstaging VPS 스택 기동 → URL 헬스 green + TLS 정상 + 구조화 로그(run_id/workspace_id 상관) + 핵심 메트릭(outbox lag/예산 트립율/APNs 실패) + docs/RUN.md staging 기동/롤백/시크릿/백업 절차.\n\n## Context\n- Epic EP-DEPLOY · M1 · backend\n\n## Acceptance\n- [ ] [runtime] staging URL 헬스 green + TLS\n- [ ] [infra] 구조화 로그 + healthcheck + 메트릭\n- [ ] [infra] docs/RUN.md staging 절차 추가\n\n## Depends on: MOMO-005, MOMO-006
MOMO-010	M2	type:spec,area:schema,area:tenancy,status:runtime-unverified,size:m	003_onboarding.sql: invite_code 테이블 + RLS 등록	## Goal\nserver/Migrations/003_onboarding.sql 신규(schema_v0.sql 미수정): invite_code{id uuidv7, workspace_id FK, code, role, max_uses, used_count, expires_at, revoked_at, created_by} + 고엔트로피 random code + 만료 + 사용횟수 한정 + revoke + RLS DO-block ARRAY 등록(FORCE).\n\n## Context\n- Epic EP-TENANCY · M2 · backend · Spec L4 §1.3, §7.1\n\n## Acceptance\n- [ ] [sql] 003_onboarding.sql 컨벤션 정합(uuidv7/workspace_id/RLS)\n- [ ] [sql] schema_v0.sql 정본 미수정 + RLS ARRAY 등록\n- [ ] runtime-unverified 표기\n\n## Depends on: MOMO-003
MOMO-011	M2	type:feature,area:server,area:tenancy,status:runtime-unverified,size:m	워크스페이스 스핀업 REST + 초대코드 자동 발급	## Goal\nPOST /v1/workspaces(워크스페이스 + 초기 owner + 고유 invite_code 1개 자동 발급) + POST /v1/invites(owner/admin이 role/max_uses/expires_at로 생성). 트랜잭션마다 SET LOCAL app.workspace_id 후 INSERT.\n\n## Context\n- Epic EP-TENANCY · M2 · backend · Spec L4 §7.1/§7.2\n\n## Acceptance\n- [ ] [swift] swift build green: MomoServer\n- [ ] [swift] /v1/workspaces, /v1/invites 라우트\n- [ ] [sql] SET LOCAL app.workspace_id 후 INSERT\n- [ ] runtime-unverified 표기\n\n## Depends on: MOMO-010
MOMO-012	M2	type:feature,area:server,area:tenancy,status:runtime-unverified,gate:qa,size:l	초대코드 자가가입 플로우 + audit_log	## Goal\nPOST /v1/join: 초대코드 검증(만료/사용횟수/revoke) → app.workspace_id 컨텍스트 → member/membership 생성 → used_count 증가 → audit_log(actor/subject/via_token). 3개+ 팀(10인=1팀) 자가가입 e2e + 격리 재확인.\n\n## Context\n- Epic EP-TENANCY · M2 · backend\n\n## Acceptance\n- [ ] [swift] swift build green: /v1/join\n- [ ] [runtime] 검증→가입→used_count++→audit_log\n- [ ] [runtime] 3팀 e2e + 격리 재확인\n- [ ] runtime-unverified 표기(미가용 시)\n\n## Depends on: MOMO-011
MOMO-013	M2	type:feature,area:server,area:tenancy,status:runtime-unverified,size:m	platform_admin 전역 추적 뷰/엔드포인트 (BYPASSRLS 읽기)	## Goal\nplatform_admin 테이블 + BYPASSRLS 읽기 전용 경로(쓰기엔 BYPASSRLS 금지) + GET /v1/platform/workspaces, /v1/platform/members(전 테넌트 전수 조회: 팀/멤버/초대코드 사용현황). 일반 테넌트 토큰은 접근 불가.\n\n## Context\n- Epic EP-ADMIN · M2 · backend\n\n## Acceptance\n- [ ] [swift] swift build green\n- [ ] [sql] BYPASSRLS 읽기 전용, 쓰기 경로 금지\n- [ ] [runtime] 권한 분리 확인\n- [ ] runtime-unverified 표기\n\n## Depends on: MOMO-010
MOMO-020	M3	type:feature,area:macos,status:blocked,size:m	D Live Tool-Call 실데이터 렌더	## Goal\nMessageBubble가 tool_call/tool_result/diff 1급 메시지를 실데이터로 렌더 + AgentPartialView가 agent.partial 스트리밍 델타 실시간 표시. staging 백엔드 접속하여 김인턴 응답 1회 렌더.\n\n## Context\n- Epic EP-UX-DBC · M3 · macos · 경험설계 05 경험 D · Spec L4 §5.2\n\n## Acceptance\n- [ ] [swift] swift build green: MomoMac\n- [ ] tool_call/tool_result/diff 1급 렌더\n- [ ] agent.partial 스트리밍 표시(스텁 OK, 컴파일 보장)\n\n## Depends on: MOMO-004
MOMO-021	M3	type:feature,area:macos,status:blocked,size:m	B 비용 호흡 링 실데이터 바인딩	## Goal\nCostBreathingRing이 usage_ledger/budget_window 실데이터에 바인딩 + 예산 소진율 따라 링 시각 변화 + soft/hard limit 표시 + staging 실데이터로 비용 누적 반영.\n\n## Context\n- Epic EP-UX-DBC · M3 · macos · 경험설계 05 경험 B · Spec L4 §8.5\n\n## Acceptance\n- [ ] [swift] swift build green: MomoMac\n- [ ] reserve/reconcile 바인딩(데모 데이터 가능)\n- [ ] soft/hard limit 시각 표시\n\n## Depends on: MOMO-004
MOMO-022	M3	type:feature,area:macos,status:blocked,size:m	C 승인 인박스 실데이터 왕복	## Goal\nApprovalInboxView가 approval(pending) 실데이터 표시 + 승인/거절 → 서버 PATCH → agent_run 게이트 해제 왕복 + 결정 audit_log 기록.\n\n## Context\n- Epic EP-UX-DBC · M3 · macos · 경험설계 05 경험 C · Spec L4 §5.2, §7.3\n\n## Acceptance\n- [ ] [swift] swift build green: MomoMac\n- [ ] approval pending 리스트 + 승인/거절 액션(스텁 OK)\n- [ ] PATCH→게이트 해제 배선\n\n## Depends on: MOMO-004
MOMO-030	M4	type:infra,area:macos,area:store,status:blocked,size:l	C1: MomoMac.xcodeproj (Developer ID, hardened runtime)	## Goal\nclients/macOS/MomoMac.xcodeproj 생성(MomoCore/MomoMac 로컬 SwiftPM 의존, 앱 타깃만 Xcode) + scheme MomoMac, Bundle ID com.dawnkim.momo, hardened runtime ON, entitlements(네트워크/keychain).\n\n## Context\n- Epic EP-MAC-PKG · M4 · macos\n\n## Acceptance\n- [ ] [xcode] xcodebuild build -scheme MomoMac -destination platform=macOS CODE_SIGNING_ALLOWED=NO 성공\n- [ ] MomoCore/MomoMac 로컬 SwiftPM 의존\n- [ ] hardened runtime + entitlements\n\n## Depends on: MOMO-020
MOMO-031	M4	type:infra,area:macos,area:store,gate:qa,status:blocked,size:l	macOS codesign + notarytool 공증 + stapler	## Goal\nbottom-up codesign(--options runtime --timestamp --entitlements, Developer ID Application) → create-dmg → xcrun notarytool submit --wait Accepted → stapler staple(.app/.dmg). 타 맥 spctl --assess + codesign --verify --deep --strict 통과.\n\n## Context\n- Epic EP-MAC-PKG · M4 · macos · 1차 출처: developer.apple.com (altool 폐기 2023-11-01 → notarytool 유일). 법률 자문 아님.\n\n## Acceptance\n- [ ] [manual] codesign(Developer ID, hardened runtime)\n- [ ] [manual] notarytool submit --wait Accepted\n- [ ] [manual] stapler staple + spctl 통과\n- [ ] 🔒 배포는 M7 게이트 PASS 후\n\n## Depends on: MOMO-030
MOMO-032	M4	type:feature,area:macos,area:store,status:blocked,size:m	Sparkle 2 EdDSA 자동업데이트 + appcast	## Goal\nSparkle 2 EdDSA generate_keys → SUPublicEDKey/SUFeedURL Info.plist + generate_appcast(각 릴리스 .app 공증·staple 필수) + 구버전→신버전 자동업데이트 1회.\n\n## Context\n- Epic EP-MAC-PKG · M4 · macos\n\n## Acceptance\n- [ ] [manual] EdDSA 키 + Info.plist 설정\n- [ ] [manual] appcast.xml 생성(공증·staple된 .app)\n- [ ] [manual] 자동업데이트 1회 성공\n\n## Depends on: MOMO-031
MOMO-040	M5	type:infra,area:ios,area:store,status:blocked,size:l	C2: MomoiOS.xcodeproj (iOS 26 SDK, Push capability)	## Goal\nclients/iOS/ 생성 + MomoiOS.xcodeproj(MomoCore 공유), iOS 26 SDK + Xcode 26 빌드 + scheme MomoiOS, explicit Bundle ID + Push Notifications capability(+Background Modes remote notification).\n\n## Context\n- Epic EP-IOS · M5 · ios · 1차 출처: developer.apple.com/news (2026-04-28부터 iOS 26 SDK+Xcode 26 업로드 요건)\n\n## Acceptance\n- [ ] [xcode] xcodebuild build-for-testing -scheme MomoiOS -destination 'platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO 성공\n- [ ] explicit Bundle ID + Push capability\n- [ ] MomoCore 공유\n\n## Depends on: MOMO-020
MOMO-041	M5	type:feature,area:ios,area:server,status:runtime-unverified,size:m	APNs .p8(ES256) 연결 + push_token 등록 경로	## Goal\nAPNs Auth Key .p8(ES256) 기반 provider JWT(1h 수명) 갱신 액터 + 디바이스 토큰 등록→push_token(env/topic=bundle id) 저장 + 410/400 시 invalidated_at + push_dispatch_log 발송 결과 추적.\n\n## Context\n- Epic EP-IOS · M5 · 1차 출처: developer.apple.com/documentation/usernotifications (.p8 1회 다운로드/만료 없음, JWT 1h). Spec L4 §8.3\n\n## Acceptance\n- [ ] [swift] swift build green: provider JWT 갱신 액터\n- [ ] [sql] push_token/push_dispatch_log 스키마 정합\n- [ ] 410/400 invalidated_at 경로\n- [ ] runtime-unverified 표기\n\n## Depends on: MOMO-040
MOMO-042	M5	type:feature,area:ios,area:server,gate:qa,status:runtime-unverified,size:m	앱 내 계정 삭제 흐름 (5.1.1(v))	## Goal\n설정에 '계정 삭제'(비활성화 아님) 진입점 + 확인 + 서버 삭제 엔드포인트(member/human 및 연관 데이터 삭제 + audit_log) + 삭제 후 재로그인 불가.\n\n## Context\n- Epic EP-IOS · M5 · 1차 출처: App Store Review Guideline 5.1.1(v) — 앱 내 계정 삭제 필수(비활성화 아님). 법률 자문 아님.\n\n## Acceptance\n- [ ] [swift] swift build green: 삭제 진입점+확인\n- [ ] [swift] 서버 삭제 엔드포인트 + audit_log\n- [ ] [runtime] 삭제 후 재로그인 불가\n- [ ] runtime-unverified 표기\n\n## Depends on: MOMO-040
MOMO-043	M5	type:infra,area:ios,area:store,type:docs,status:runtime-unverified,size:m	PrivacyInfo.xcprivacy + 암호화 export 신고	## Goal\nPrivacyInfo.xcprivacy(수집 데이터 유형 + NSPrivacyAccessedAPITypes required reason + 포함 SDK) + Info.plist ITSAppUsesNonExemptEncryption(표준 TLS/APNs만이면 면제 NO, 자체 암호화면 YES — 의존성 전수 확인) + App Privacy 라벨과 manifest 일관.\n\n## Context\n- Epic EP-IOS · M5 · 1차 출처: developer.apple.com/news/?id=pvszzano (manifest 2024-11-12 필수). 법률 자문 아님.\n\n## Acceptance\n- [ ] [infra] PrivacyInfo.xcprivacy 생성 + SDK required-reason 반영\n- [ ] [infra] ITSAppUsesNonExemptEncryption 결정 + 근거 기록\n- [ ] App Privacy 라벨 일관(문서)\n\n## Depends on: MOMO-040
MOMO-044	M5	type:feature,area:ios,area:store,gate:qa,status:runtime-unverified,size:l	UGC 모더레이션 4종 + EULA 무관용 (1.2)	## Goal\n게시 전 objectionable material 필터링 + 신고(report) + 차단(block) + 공개 연락처 + EULA objectionable content 무관용(외부 변호사 검토) + 에이전트 생성 콘텐츠 모더레이션 정책(에이전트=1급 멤버).\n\n## Context\n- Epic EP-UGC · M5 · 1차 출처: App Store Review Guideline 1.2 — UGC 4종 강제(필터/신고/차단/연락처). 법률 자문 아님.\n\n## Acceptance\n- [ ] [swift] swift build green: 필터/신고/차단/연락처\n- [ ] [manual] EULA 무관용 명시(외부 변호사 검토 표기)\n- [ ] 에이전트 콘텐츠 모더레이션 정책 문서\n- [ ] runtime-unverified 표기\n\n## Depends on: MOMO-040
MOMO-050	M6	type:infra,area:ci,status:blocked,size:m	ci-build.yml: swift build/test + xcode-apps 빌드	## Goal\n.github/workflows/ci-build.yml swift build/test 잡 green + xcode-apps 잡 주석 해제(iOS+macOS 무서명 빌드, 경로/scheme 정합) + actionlint 통과.\n\n## Context\n- Epic EP-CICD · M6 · ci · docs/cicd/04-codex-tickets.md\n\n## Acceptance\n- [ ] [ci] swift build/test 잡 green\n- [ ] [ci] xcode-apps 무서명 빌드 green\n- [ ] [ci] actionlint 통과\n\n## Depends on: MOMO-030, MOMO-040
MOMO-051	M6	type:infra,area:ci,status:blocked,size:m	ASC API Key(Team) + fastlane match 초기화	## Goal\nApp Store Connect API Key(.p8/key_id/issuer_id, Team Key) 발급 + base64 단일 secret + fastlane match appstore(iOS)/developer_id(macOS) 최초 동기화(별도 signing repo, CI readonly) + gh secret list 에 6개 필수 secret 존재.\n\n## Context\n- Epic EP-CICD · M6 · ci · 1차 출처: docs.fastlane.tools (API Key 반드시 Team Key; Individual 불가). 법률 자문 아님.\n\n## Acceptance\n- [ ] [manual] ASC API Key(Team) 발급 + base64 secret\n- [ ] [manual] match appstore/developer_id 최초 동기화\n- [ ] [manual] gh secret list --repo yeomyeonggeori/oort 6개 secret\n\n## Depends on: MOMO-050
MOMO-052	M6	type:infra,area:ci,gate:qa,status:blocked,size:m	release-ios/release-macos dry-run (게이트 전 미트리거)	## Goal\nrelease-ios.yml(gym→pilot) + release-macos.yml(notarytool submit --wait→stapler) syntax/lint 통과 + dry-run 성공(태그 미푸시 또는 environment protection으로 실배포 차단) + altool 미사용(notarytool 전용).\n\n## Context\n- Epic EP-CICD · M6 · ci\n\n## Acceptance\n- [ ] [ci] release-*.yml syntax/lint 통과\n- [ ] [ci] dry-run 성공(실배포 차단)\n- [ ] 🔒 게이트 PASS 전 미트리거 확인\n\n## Depends on: MOMO-051
MOMO-060	M7	type:feature,area:macos,area:ios,gate:qa,status:blocked,size:m	크래시/분석 계측 (Sentry Cocoa + MetricKit)	## Goal\nSentry Cocoa(self-host) Release Health(crash-free 세션/유저) + MetricKit(MXCrashDiagnostic/MXHangDiagnostic) 인입 + macOS는 TestFlight 없으므로 Sentry/MetricKit 의존(실기기 페이로드) + App Privacy 라벨에 수집 데이터 반영.\n\n## Context\n- Epic EP-QA-GATE · M7 · shared · docs/cicd/07-crash-analytics-spec.md, 05 §G-A\n\n## Acceptance\n- [ ] [swift] sentry-cocoa 의존 추가 후 5패키지 swift build green 유지\n- [ ] [swift] SentrySDK.start 래퍼 + MXMetricManagerSubscriber 골격(DSN은 Config 주입)\n- [ ] App Privacy 라벨 반영(문서)\n- [ ] runtime-unverified(no device) 표기\n\n## Depends on: MOMO-030, MOMO-040
MOMO-061	M7	type:feature,area:macos,area:ios,gate:qa,status:blocked,size:l	핵심 8플로우 XCUITest + 접근성 + 성능 측정	## Goal\n핵심 8플로우 XCUITest 8/8 PASS + 수동 스모크(치명0) + performAccessibilityAudit 치명 위반 0 + VoiceOver 핵심플로우 조작 + XCTApplicationLaunchMetric 콜드 런치 p90<2s, hang≈0(실기기·Release).\n\n## Context\n- Epic EP-QA-GATE · M7 · shared · docs/cicd/08-e2e-accessibility-performance.md, 05 §G-B/§G-C/§G-D\n\n## Acceptance\n- [ ] [xcode] XCUITest 8/8 + 수동 스모크 치명0\n- [ ] [xcode] performAccessibilityAudit 치명0 + VoiceOver\n- [ ] [xcode] 성능 baseline(런치 p90<2s, hang≈0)\n\n## Depends on: MOMO-060
MOMO-062	M7	type:infra,area:ci,gate:qa,status:blocked,size:m	베타 배포 (TestFlight 내부 + macOS 공증 DMG 비공개)	## Goal\niOS fastlane pilot로 TestFlight 내부(≤100) 업로드(외부는 게이트 PASS 후) + macOS Developer ID 공증 .dmg 비공개 베타(타 맥 spctl/Gatekeeper 통과) + 베타 피드백 ASC API 수집 → P0/P1 전수 트리아지.\n\n## Context\n- Epic EP-QA-GATE · M7 · shared · 1차 출처: developer.apple.com (TestFlight 내부≤100 무심사/외부≤10,000 첫빌드 Beta App Review). docs/cicd/06\n\n## Acceptance\n- [ ] [manual] TestFlight 내부 업로드\n- [ ] [manual] macOS 공증 .dmg 비공개 + Gatekeeper 통과\n- [ ] [infra] ASC API 피드백 수집 → P0/P1 트리아지\n- [ ] 🔒 외부 TestFlight는 게이트 PASS 후\n\n## Depends on: MOMO-052, MOMO-061
MOMO-063	M7	type:docs,gate:qa,priority:p0,status:blocked,size:s	게이트 PASS 판정 + 03 PASS 블록 기록	## Goal\nG-0~G-G 전부 PASS + 증거(크래시-free 지표/분모/윈도우, e2e 결과, 접근성 감사, 성능 수치, 베타 피드백) 첨부 + docs/cicd/03-store-readiness-gate.md 상단 PASS 블록(날짜+커밋해시+빌드#+증거 링크) + STATUS.md 게이트 상태 OPEN→PASS.\n\n## Context\n- Epic EP-QA-GATE · M7 · shared · 05 §10 PASS 양식. 🔒 이 이슈가 닫혀야 M8 착수.\n\n## Acceptance\n- [ ] [manual] G-0~G-G 전부 PASS + 증거 첨부\n- [ ] [docs] 03 상단 PASS 블록 기록\n- [ ] [docs] STATUS.md OPEN→PASS\n- [ ] 🔒 게이트 PASS 전 release-*.yml 미트리거 확인\n\n## Depends on: MOMO-001, MOMO-060, MOMO-061, MOMO-062
MOMO-070	M8	type:infra,area:store,area:ios,priority:p0,status:blocked,size:m	iOS App Store 메타/스크린샷/연령등급/App Privacy 제출	## Goal\nApp Store Connect 앱 레코드 + 메타(이름/부제/설명/키워드/지원URL) + 현 규격 스크린샷(6.9/6.5 iPhone, 13 iPad — 제출 직전 재확인) + App Privacy 라벨(제3자/LLM 포함) + 연령등급 설문(UGC 반영) + 심사용 데모 워크스페이스 + 유효 초대코드 + 백엔드 가동 SLA.\n\n## Context\n- Epic EP-STORE · M8 · ios · 🔒 M7 PASS 후. 1차 출처: developer.apple.com/app-store/submitting. 법률 자문 아님.\n\n## Acceptance\n- [ ] [manual] 앱 레코드 + 메타 + 스크린샷(현 규격)\n- [ ] [manual] App Privacy 라벨 + 연령등급\n- [ ] [manual] 심사용 데모 워크스페이스 + 초대코드 + 백엔드 SLA\n\n## Depends on: MOMO-063
MOMO-071	M8	type:infra,area:store,area:ios,gate:qa,priority:p0,status:blocked,size:m	iOS 빌드 업로드 → App Review → 배포	## Goal\nexternal TestFlight 첫 빌드 Beta App Review 통과(게이트 PASS 후) + fastlane deliver(submit_for_review) → App Review 승인 → 배포(1.0 보통 즉시 전체 출시, phased는 업데이트 한정).\n\n## Context\n- Epic EP-STORE · M8 · ios · 1차 출처: developer.apple.com (App Review ~24~48h 추정, phased 7일은 업데이트 한정). 법률 자문 아님.\n\n## Acceptance\n- [ ] [manual] external TestFlight Beta App Review 통과\n- [ ] [manual] deliver(submit_for_review) → 승인\n- [ ] [manual] 배포\n- [ ] 🔒 M7 PASS 확인 후에만\n\n## Depends on: MOMO-070
MOMO-072	M8	type:infra,area:store,area:macos,priority:p0,status:blocked,size:m	macOS 공증 DMG 공개 다운로드 + Sparkle 라이브	## Goal\nrelease-macos.yml(게이트 PASS 후) 가동 → 공증 .dmg를 GitHub Release/다운로드 페이지에 공개 + 공개 다운로드 후 Gatekeeper 통과(사용자 머신 spctl) + Sparkle appcast 라이브(신버전 자동업데이트 노출).\n\n## Context\n- Epic EP-STORE · M8 · macos · 🔒 M7 PASS 후.\n\n## Acceptance\n- [ ] [manual] release-macos.yml 가동 → 공증 .dmg 공개\n- [ ] [manual] 공개 다운로드 Gatekeeper 통과\n- [ ] [manual] Sparkle appcast 라이브\n- [ ] 🔒 M7 PASS 확인 후에만\n\n## Depends on: MOMO-063, MOMO-032
MOMO-080	M2	type:docs,area:legal,priority:p1,status:ready,size:s	법무 L0/L1: 등록주체 + D-U-N-S + Apple 등록	## Goal\n개인 vs 법인 결정 문서화 + (법인) D-U-N-S 발급 신청(무료, 약 7영업일, expedite 불가) + Apple Developer Program 조직 가입($99/년, 2FA Apple Account). Codex는 절차/런북만 준비, 실제 발급/계약은 사람 위임.\n\n## Context\n- Epic EP-LEGAL · M2 · legal · 1차 출처: developer.apple.com/help/account/membership. 법률 자문 아님 — 외부 변호사 1회 검토.\n\n## Acceptance\n- [ ] [docs] 개인/법인 결정 + D-U-N-S 절차 런북\n- [ ] [docs] Apple Developer Program 가입 절차\n- [ ] [manual] 실제 발급/계약은 사람 위임 표기\n\n## Depends on: (없음)
MOMO-081	M2	type:docs,area:legal,area:store,priority:p1,status:blocked,size:m	법무 L3/L5: 개인정보처리방침 + App Privacy + LLM 고지	## Goal\n개인정보처리방침 URL 작성(미수집도 필수, 한국 개인정보보호법/GDPR 고려) + App Privacy 라벨 초안(제3자/hermes LLM 전송 정직 신고) + 에이전트 LLM 제3자 전송 온보딩 동의 + 승인 인박스 고지. 외부 변호사 1회 검토.\n\n## Context\n- Epic EP-LEGAL · M2 · legal · 법률 자문 아님.\n\n## Acceptance\n- [ ] [docs] 개인정보처리방침 URL 초안\n- [ ] [docs] App Privacy 라벨 초안(LLM 전송 신고)\n- [ ] [docs] LLM 제3자 전송 고지/동의 경로\n- [ ] [manual] 외부 변호사 검토 표기\n\n## Depends on: MOMO-080
MOMO-082	M5	type:docs,area:legal,area:store,priority:p1,status:blocked,size:s	법무 L7/EULA: NOTICE 귀속 + UGC 무관용 EULA	## Goal\nApache 2.0 NOTICE 귀속을 앱 화면에 표기 + UGC(채팅) EULA에 objectionable content 무관용(1.2) + 한국 부가통신 신고 면제 여부 확인(자본금 1억원 이하, 시행령 30조 — 법인화 시 재확인).\n\n## Context\n- Epic EP-LEGAL · M5 · legal · 법률 자문 아님 — 외부 변호사 1회 검토.\n\n## Acceptance\n- [ ] [docs] NOTICE 귀속 앱 화면 표기\n- [ ] [docs] EULA 무관용 명시\n- [ ] [docs] 부가통신 면제 여부 확인 메모\n- [ ] [manual] 외부 변호사 검토 표기\n\n## Depends on: MOMO-081
MOMO-090	M8	type:spec,area:schema,priority:p2,status:runtime-unverified,size:l	P1 branch_id 좌표축 (분기 타임라인, 가장 큰 신규)	## Goal\nmessage에 branch_id 컬럼 + 분기당 channel_seq 별도 카운터(또는 경량 서브채널) + branch→main 정본 병합 시 seq 재매핑 + 갈래별 reserve/reconcile 원장 격리 + 폐기 갈래 자동 환불(추정 — 현 seq는 채널당 단일 모노토닉).\n\n## Context\n- Epic EP-PRIMITIVES · M8(후속) · backend · v0 데모엔 불필요, 출시 후 후속.\n\n## Acceptance\n- [ ] [sql] branch_id + 분기 seq 카운터 스펙\n- [ ] [sql] branch→main 병합 seq 재매핑\n- [ ] [sql] 갈래별 원장 격리 + 환불\n- [ ] runtime-unverified 표기\n\n## Depends on: MOMO-071, MOMO-072
MOMO-091	M8	type:spec,area:schema,priority:p2,status:runtime-unverified,size:m	P2 reversibility_tier + 보상 레지스트리 (되돌리기 동료)	## Goal\ntool_call props에 reversibility green/amber/red + 보상 핸들러 매핑(compensation registry) + audit_log를 역연산 소스로 재사용(인라인 UNDO 경로).\n\n## Context\n- Epic EP-PRIMITIVES · M8(후속) · backend\n\n## Acceptance\n- [ ] [sql] reversibility_tier 스펙\n- [ ] [sql] compensation registry 매핑\n- [ ] [sql] audit_log 역연산 경로\n- [ ] runtime-unverified 표기\n\n## Depends on: MOMO-071, MOMO-072
MOMO-092	M8	type:spec,area:schema,priority:p2,status:runtime-unverified,size:m	P3 belief 메시지 타입 + 교정 원장 (길들이기)	## Goal\nmessage_type에 belief 추가 또는 diff 재사용 + belief 원장(member 속성 + 교정 이력) + co-sign/dispute는 reaction 재사용.\n\n## Context\n- Epic EP-PRIMITIVES · M8(후속) · backend\n\n## Acceptance\n- [ ] [sql] belief 타입/원장 스펙\n- [ ] [sql] co-sign/dispute reaction 재사용\n- [ ] runtime-unverified 표기\n\n## Depends on: MOMO-071, MOMO-072
MOMO-093	M8	type:spec,area:schema,priority:p2,status:runtime-unverified,size:m	P4 autonomy_level + 승급/강등 사건 (수습→정직원)	## Goal\nagent 테이블에 autonomy_level + 승급/강등 audit_log 사건 + 게이트 정책 바인딩(scope별 점진 소멸/자동 강등).\n\n## Context\n- Epic EP-PRIMITIVES · M8(후속) · backend\n\n## Acceptance\n- [ ] [sql] autonomy_level 스펙\n- [ ] [sql] 승급/강등 audit_log + 게이트 정책\n- [ ] runtime-unverified 표기\n\n## Depends on: MOMO-071, MOMO-072
MOMO-094	M8	type:spec,area:schema,priority:p2,status:runtime-unverified,size:m	P5 TIE-BREAK 결정표 + decision_ledger (공개 토론)	## Goal\napproval 확장(2지선다→다지선다 캐스팅보트) + 불변 decision_ledger 테이블 + minority report 첨부/recall.\n\n## Context\n- Epic EP-PRIMITIVES · M8(후속) · backend\n\n## Acceptance\n- [ ] [sql] approval 다지선다 확장\n- [ ] [sql] decision_ledger(불변) + minority report\n- [ ] runtime-unverified 표기\n\n## Depends on: MOMO-071, MOMO-072
MOMO-095	M8	type:spec,area:schema,priority:p2,status:runtime-unverified,size:m	P6 scheduled trigger (스탠드업/야간조/노크)	## Goal\ncron/트리거 테이블(outbox agent_job kind 확장으로 흡수 가능) + 예약/모니터링 트리거 디스패치 + 예산 가진 주도적 노크 경로.\n\n## Context\n- Epic EP-PRIMITIVES · M8(후속) · backend\n\n## Acceptance\n- [ ] [sql] cron/트리거 테이블 스펙\n- [ ] [sql] 디스패치 + 주도적 노크 경로\n- [ ] runtime-unverified 표기\n\n## Depends on: MOMO-071, MOMO-072
TICKETS

if [ "$DRY_RUN" = 0 ]; then
  say "이슈 완료: created=$created, skipped=$skipped"
fi

say "완료. Project(roadmap) 추가는 docs/GITHUB_OPS.md §4 참고."

# ── (선택) Issue Types — org 레벨, admin:org 스코프 필요 ───────────────────────
# GitHub Issue Types(1급 분류; type:* 라벨과 다름)는 org 단위 + admin:org 스코프.
# 출처: docs.github.com/en/rest/orgs/issue-types · github.blog/changelog/2025-03-18-...
# 본 스크립트는 repo 스코프만 가정하므로 type:* 는 .github/labels.json 의 라벨로 대체.
# org admin 권한이 생기면 수동 승격 예시:
#   gh api --method POST orgs/yeomyeonggeori/issue-types \
#     -f name="Feature" -f is_enabled=true -f color="green" -f description="신규 기능"
