#!/usr/bin/env bash
# =============================================================================
# scripts/bench_onboarding.sh — "설치→첫 성공 N분" 실측 하네스 (goal #1526, dsh-B)
#
# 무엇을 재나
# -----------
# `docs/SELF_HOST.md`가 약속하는 경로 — clone된 checkout에서 시작해 브라우저가
# 볼 수 있는 화면·로그인·첫 메시지·첫 에이전트까지 — 를 **사람이 아니라 스크립트가**
# 같은 순서로 밟고, 구간마다 벽시계를 찍는다. 비교 기준선은 DeepSeek Harness(dsh)의
# "한 줄 설치 → 5~10분"(정본: docs/planning/research/2026-08-18-deepseek-harness-dsh-benchmark.md §3-B).
#
#   M1  first-screen   env 생성 + 스택 기동 → 엣지가 index.html을 준다
#   M2  first-login    POST /v1/auth/login 이 accessToken을 준다
#   M3  first-message  메시지가 커밋되고 **outbox가 비워진다**(레일까지 갔다는 증거)
#   M4  first-agent    에이전트 member 생성 + 채널 합류 + 베어러 발급
#
# 왜 outbox까지 보나: relay는 성공 publish를 로그하지 않는다(SELF_HOST.md §막히면).
# "화면에 떴다"의 서버측 증거는 로그가 아니라 `outbox` 질의뿐이다.
#
# 왜 1회로 끝내지 않나
# --------------------
# 이미지 빌드는 캐시 상태에 지배당한다. 1회 측정은 캐시 상태를 수치에 숨긴 채
# 발표하게 되므로 이 하네스는 **기본 2회전**이고, 회전마다 빌드 캐시 상태를
# 함께 기록한다. `--cold`는 회전 전에 builder 캐시를 비워 상한을 재고,
# 기본(warm)은 재실행 하한을 잰다. 두 수치는 다른 질문의 답이며 서로를 대체하지 않는다.
#
# 기본값 감사 (A1~A5)
# -------------------
# 시간만으로는 "왜 오래 걸렸나"를 못 말한다. 같은 실행에서 마찰의 원인이 되는
# 기본값을 기계적으로 확인해 PASS/FAIL/NA로 남긴다 — 감사 항목은 §audit 참고.
#
# 제품 코드 비접촉
# ----------------
# 이 스크립트는 감사 도구다. server-rust·clients·infra의 바이트를 바꾸지 않고,
# 오직 정본 절차(`scripts/self_host_env.sh`)와 공개 REST 표면만 호출한다.
#
# 사용법
# ------
#   scripts/bench_onboarding.sh plan
#   scripts/bench_onboarding.sh run
#   scripts/bench_onboarding.sh run --repeat 2 --cold
#   scripts/bench_onboarding.sh run --repeat 1 --keep      # 스택을 남겨 손으로 이어본다
#
# 증거는 repo 밖(`${TMPDIR:-/tmp}/oort-onboarding-bench/<UTC>/`)에 남는다.
# =============================================================================
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"

MODE_ACTION="plan"
REPEAT=2
IMAGE_MODE="local-build"
PUBLISHED_IMAGE=""
COLD=0
KEEP=0
SKIP_AGENT=0
TMP_BASE="${TMPDIR:-/tmp}"
TMP_BASE="${TMP_BASE%/}"
EVIDENCE_ROOT="${BENCH_ONBOARDING_EVIDENCE_ROOT:-$TMP_BASE/oort-onboarding-bench}"
PROJECT_PREFIX="oort-bench"
STACK_TIMEOUT="${BENCH_STACK_TIMEOUT:-3600}"
HTTP_TIMEOUT="${BENCH_HTTP_TIMEOUT:-30}"
RAIL_TIMEOUT="${BENCH_RAIL_TIMEOUT:-60}"

usage() {
  cat <<'EOF'
Usage:
  scripts/bench_onboarding.sh plan [options]
  scripts/bench_onboarding.sh run  [options]

Actions:
  plan   아무것도 띄우지 않고 실행 계획·구간 정의·증거 경로만 출력한다.
  run    실제로 스택을 띄우고 구간별 실측 + 기본값 감사를 수행한다.

Options:
  --repeat N              회전 수 (기본 2). 1회 측정은 캐시 상태를 수치에 숨긴다.
  --cold                  회전 전에 `docker builder prune -af` — 콜드 빌드 상한 측정.
  --first-run             --cold + 미사용 이미지까지 회수 — 베이스 이미지를 다시
                          받는 "정말 처음 받는 사람"의 시간. 네트워크에 지배된다.
  --keep                  마지막 회전의 스택을 내리지 않는다(손으로 이어보기용).
  --published-image REF   digest pull 모드로 잰다 (ghcr.io/yeomyeonggeori/oort@sha256:...).
  --skip-agent            M4(첫 에이전트)와 A1(provider key) 감사를 건너뛴다.
  --evidence-root DIR     증거 루트 (기본 ${TMPDIR:-/tmp}/oort-onboarding-bench).
  --stack-timeout SEC     스택 기동 상한 (기본 3600).
  -h, --help

Environment:
  BENCH_ONBOARDING_EVIDENCE_ROOT, BENCH_STACK_TIMEOUT, BENCH_HTTP_TIMEOUT,
  BENCH_RAIL_TIMEOUT
EOF
}

case "${1:-}" in
  plan|run) MODE_ACTION="$1"; shift ;;
  -h|--help) usage; exit 0 ;;
  "") usage >&2; exit 2 ;;
  *) echo "[bench] 알 수 없는 action: $1" >&2; usage >&2; exit 2 ;;
esac

while [ $# -gt 0 ]; do
  case "$1" in
    --repeat) REPEAT="$2"; shift 2 ;;
    --cold) [ "$COLD" -ge 1 ] || COLD=1; shift ;;
    --first-run) COLD=2; shift ;;
    --keep) KEEP=1; shift ;;
    --skip-agent) SKIP_AGENT=1; shift ;;
    --published-image) IMAGE_MODE="published-digest"; PUBLISHED_IMAGE="$2"; shift 2 ;;
    --evidence-root) EVIDENCE_ROOT="$2"; shift 2 ;;
    --stack-timeout) STACK_TIMEOUT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[bench] 알 수 없는 인자: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$REPEAT" in
  ''|*[!0-9]*) echo "[bench] --repeat 는 양의 정수여야 한다." >&2; exit 2 ;;
esac
[ "$REPEAT" -ge 1 ] || { echo "[bench] --repeat 는 1 이상이어야 한다." >&2; exit 2; }

log() { printf '[bench] %s\n' "$*"; }
fail() { printf '[bench] ERROR: %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || fail "필요한 명령이 없다: $1"; }

# --------------------------------------------------------------------------
# 밀리초 시계. BSD date에는 %N이 없으므로 있는 것을 골라 쓴다.
# --------------------------------------------------------------------------
CLOCK=""
pick_clock() {
  local probe
  probe="$(date +%s%3N 2>/dev/null || true)"
  case "$probe" in
    ''|*[!0-9]*) ;;
    *) CLOCK="date"; return 0 ;;
  esac
  if command -v python3 >/dev/null 2>&1; then CLOCK="python3"; return 0; fi
  if command -v perl >/dev/null 2>&1; then CLOCK="perl"; return 0; fi
  CLOCK="sec"
}
now_ms() {
  case "$CLOCK" in
    date) date +%s%3N ;;
    python3) python3 -c 'import time; print(int(time.time()*1000))' ;;
    perl) perl -MTime::HiRes=time -e 'printf("%d\n", time()*1000)' ;;
    *) echo "$(( $(date +%s) * 1000 ))" ;;
  esac
}
# ms -> "m:ss.mmm"
fmt_ms() {
  local ms="$1" total_s frac m s
  total_s=$(( ms / 1000 ))
  frac=$(( ms % 1000 ))
  m=$(( total_s / 60 ))
  s=$(( total_s % 60 ))
  printf '%d:%02d.%03d' "$m" "$s" "$frac"
}

# --------------------------------------------------------------------------
# 증거
# --------------------------------------------------------------------------
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
EVIDENCE_DIR="$EVIDENCE_ROOT/$RUN_ID"
TIMINGS_TSV=""
AUDIT_TSV=""

emit_timing() { # cycle phase milestone ms note
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "${5:-}" >> "$TIMINGS_TSV"
}
emit_audit() { # cycle id verdict detail
  # detail은 서버 응답 본문을 그대로 물고 오는 경우가 있다. 줄바꿈·탭·파이프가
  # 섞이면 TSV 한 행과 마크다운 한 칸이 동시에 깨지므로 여기서 한 줄로 접는다.
  local detail
  detail="$(printf '%s' "$4" | tr '\n\t' '  ' | tr '|' '/' | sed -E 's/  +/ /g; s/^ +//; s/ +$//')"
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$detail" >> "$AUDIT_TSV"
  log "audit $2: $3 — $detail"
}

# --------------------------------------------------------------------------
# plan
# --------------------------------------------------------------------------
print_plan() {
  cat <<EOF

[bench] oort 온보딩 실측 하네스 — 계획 (아무것도 띄우지 않았다)

  repo         $REPO_ROOT
  이미지 모드   $IMAGE_MODE${PUBLISHED_IMAGE:+ ($PUBLISHED_IMAGE)}
  회전 수       $REPEAT ($([ "$COLD" -ge 2 ] && echo "first-run: 캐시+이미지 회수" || { [ "$COLD" -eq 1 ] && echo "cold: 회전마다 builder 캐시 비움" || echo "warm: 빌드 캐시 유지"; }))
  증거          $EVIDENCE_DIR
  기준선        dsh 한 줄 설치 → 5~10분 (research/2026-08-18-deepseek-harness-dsh-benchmark.md §3-B)

구간 (회전마다)

  P0 preflight    docker/curl/jq/openssl 확인, 호스트·캐시 상태 기록
  P1 env          scripts/self_host_env.sh --local-build            (정본 2단계)
  P2 stack        scripts/self_host_env.sh --compose up -d --build --wait  (정본 3단계)
                  └ 하위 분해는 컨테이너 StartedAt/FinishedAt에서 사후 유도
  P3 login        POST /v1/auth/login                                (정본 4단계)
  P4 workspace    GET /v1/workspaces/{ws} · GET .../channels
  P5 message      POST .../messages → outbox가 'broadcast|done' 으로 비워질 때까지
  P6 agent        POST .../agents → POST .../channels/{ch}/members → POST .../credentials

마일스톤 (t0 = P1 시작)

  M1 first-screen   = P1+P2
  M2 first-login    = M1+P3
  M3 first-message  = M2+P4+P5
  M4 first-agent    = M3+P6

기본값 감사

  A1 키 반영 무재시작   PUT /v1/provider/link 후 api 재시작 없이 GET에 반영되나
  A2 빈 상태            첫 로그인 시 채널/메시지/에이전트 개수 — 사람이 무엇을 보나
  A3 이탈 지점          마일스톤별 필수 왕복 수(기계적 계수)
  A4 문서 드리프트      self_host_env.sh가 인쇄하는 명령 vs docs/SELF_HOST.md의 명령
  A5 로그인 워크스페이스 칸  빈 칸 / 쓰레기 값 / 정확한 UUID 세 경우의 서버 응답
  A6 에이전트 엔드포인트 게이트  루프백 http baseUrl 이 받아들여지나(노트북의 로컬 모델)
  A7 시드 계정          공개 기본 비밀번호가 잠겼나

정리

  회전 끝마다 \`--compose down -v\` + 프로젝트 스코프 자원 회수.
  --keep 을 주면 마지막 회전만 남긴다.

EOF
}

if [ "$MODE_ACTION" = "plan" ]; then
  print_plan
  exit 0
fi

# --------------------------------------------------------------------------
# run
# --------------------------------------------------------------------------
need docker
need curl
need jq
need openssl
pick_clock

cd "$REPO_ROOT"

mkdir -p "$EVIDENCE_DIR"
TIMINGS_TSV="$EVIDENCE_DIR/timings.tsv"
AUDIT_TSV="$EVIDENCE_DIR/audit.tsv"
printf 'cycle\tphase\tmilestone\tms\tnote\n' > "$TIMINGS_TSV"
printf 'cycle\tid\tverdict\tdetail\n' > "$AUDIT_TSV"

log "증거 디렉터리: $EVIDENCE_DIR"

{
  echo "# host facts ($RUN_ID)"
  echo "uname: $(uname -a)"
  echo "docker: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
  echo "compose: $(docker compose version --short 2>/dev/null || echo unknown)"
  echo "repo HEAD: $(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "repo branch: $(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  echo "clock: $CLOCK"
  echo "image mode: $IMAGE_MODE"
  echo "repeat: $REPEAT  cold: $COLD"
  echo
  echo "# docker system df (실행 전)"
  docker system df 2>&1 || true
} > "$EVIDENCE_DIR/host.txt"

ENV_FILE="infra/rust/local.secrets.env"
CURRENT_PROJECT=""

env_value() { # key
  [ -f "$ENV_FILE" ] || return 1
  sed -n -E "s/^$1=(.*)$/\1/p" "$ENV_FILE" | head -1
}

compose() { # compose subcommand + args
  "$REPO_ROOT/scripts/self_host_env.sh" --compose "$@"
}

teardown() {
  local why="${1:-cleanup}"
  if [ -f "$ENV_FILE" ]; then
    log "정리($why): down -v"
    compose down -v --remove-orphans >>"$EVIDENCE_DIR/teardown.log" 2>&1 || true
    rm -f "$ENV_FILE"
  fi
  if [ -n "$CURRENT_PROJECT" ]; then
    # compose가 남긴 것이 없어야 정상이다. 남았다면 프로젝트 라벨로 회수한다.
    docker ps -aq --filter "label=com.docker.compose.project=$CURRENT_PROJECT" 2>/dev/null \
      | while IFS= read -r cid; do [ -n "$cid" ] && docker rm -f "$cid" >/dev/null 2>&1 || true; done
    docker volume ls -q --filter "label=com.docker.compose.project=$CURRENT_PROJECT" 2>/dev/null \
      | while IFS= read -r vol; do [ -n "$vol" ] && docker volume rm -f "$vol" >/dev/null 2>&1 || true; done
    docker network ls -q --filter "label=com.docker.compose.project=$CURRENT_PROJECT" 2>/dev/null \
      | while IFS= read -r net; do [ -n "$net" ] && docker network rm "$net" >/dev/null 2>&1 || true; done
  fi
}

# 측정이 중간에 죽어도 컨테이너·볼륨을 남기지 않는다. 이 호스트의 자원 누적은
# 정확히 "게이트가 실패한 자리에 스택이 남는" 데서 왔다.
CLEAN_EXIT=0
on_signal() { log "신호 수신 — 정리하고 종료한다."; teardown "signal"; exit 130; }
on_exit() { [ "$CLEAN_EXIT" -eq 1 ] || teardown "abnormal exit"; }
trap on_signal INT TERM
trap on_exit EXIT

# api 컨테이너의 StartedAt (A1의 "재시작 없었다"를 증명하는 값)
api_started_at() {
  docker inspect --format '{{.State.StartedAt}}' "$(docker ps -q --filter "label=com.docker.compose.project=$CURRENT_PROJECT" --filter "label=com.docker.compose.service=api" | head -1)" 2>/dev/null || echo ""
}

# --------------------------------------------------------------------------
# 회전 하나
# --------------------------------------------------------------------------
run_cycle() {
  local cycle="$1"
  local cdir="$EVIDENCE_DIR/cycle-$cycle"
  mkdir -p "$cdir"
  log "──── 회전 $cycle/$REPEAT ────"

  CURRENT_PROJECT="$PROJECT_PREFIX-$cycle-$$"

  # 앞선 상태가 남아 있으면 측정이 아니다. 반드시 비운 데서 시작한다.
  if [ -f "$ENV_FILE" ]; then
    log "기존 $ENV_FILE 발견 — 측정 전에 내린다."
    compose down -v --remove-orphans >>"$cdir/pre-teardown.log" 2>&1 || true
    rm -f "$ENV_FILE"
  fi

  if [ "$COLD" -ge 1 ]; then
    log "cold: docker builder prune -af"
    docker builder prune -af >>"$cdir/prune.log" 2>&1 || true
  fi
  if [ "$COLD" -ge 2 ]; then
    # 진짜 첫 실행: 빌드 캐시만 지우면 베이스 이미지가 로컬에 남아 있어
    # "처음 받는 사람"의 시간이 아니다. 쓰이지 않는 이미지까지 회수한다.
    log "first-run: 빌드 이미지 + 미사용 이미지 회수 (베이스 이미지를 다시 받는다)"
    docker image rm -f oort:local >>"$cdir/prune.log" 2>&1 || true
    docker image prune -af >>"$cdir/prune.log" 2>&1 || true
  fi
  docker system df > "$cdir/df-before.txt" 2>&1 || true
  docker image ls --format '{{.Repository}}:{{.Tag}}\t{{.Size}}' > "$cdir/images-before.txt" 2>&1 || true

  # ---- P1 env -------------------------------------------------------------
  local t0 t1
  t0="$(now_ms)"
  if [ "$IMAGE_MODE" = "published-digest" ]; then
    COMPOSE_PROJECT_NAME="$CURRENT_PROJECT" \
      "$REPO_ROOT/scripts/self_host_env.sh" --published-image "$PUBLISHED_IMAGE" \
      > "$cdir/p1-env.log" 2>&1 || { cat "$cdir/p1-env.log" >&2; fail "P1 env 실패"; }
  else
    COMPOSE_PROJECT_NAME="$CURRENT_PROJECT" \
      "$REPO_ROOT/scripts/self_host_env.sh" --local-build \
      > "$cdir/p1-env.log" 2>&1 || { cat "$cdir/p1-env.log" >&2; fail "P1 env 실패"; }
  fi
  t1="$(now_ms)"
  local p1=$(( t1 - t0 ))
  emit_timing "$cycle" P1 env "$p1" "self_host_env.sh --$IMAGE_MODE"
  log "P1 env        $(fmt_ms "$p1")"

  local web_port owner_email owner_password
  web_port="$(env_value MOMO_WEB_PORT)"
  owner_email="$(env_value MOMO_INITIAL_OWNER_EMAIL)"
  owner_password="$(env_value MOMO_INITIAL_OWNER_PASSWORD)"
  [ -n "$web_port" ] && [ -n "$owner_email" ] && [ -n "$owner_password" ] \
    || fail "생성된 env에서 포트/계정을 읽지 못했다."
  local base="http://127.0.0.1:$web_port"
  log "엣지: $base  계정: $owner_email"

  # 비밀번호를 제외한 env를 증거로 남긴다.
  sed -E 's/^(MOMO_INITIAL_OWNER_PASSWORD|POSTGRES_PASSWORD|MOMO_APP_POSTGRES_PASSWORD|RELAY_POSTGRES_PASSWORD|WORKER_POSTGRES_PASSWORD|JWT_HMAC|CENT_TOKEN_HMAC|CENT_API_KEY|CENT_PROXY_SECRET|PROVIDER_LINK_MASTER_KEY)=.*/\1=<redacted>/; s#(postgres://[^:]+:)[^@]+@#\1<redacted>@#' \
    "$ENV_FILE" > "$cdir/env.redacted" 2>/dev/null || true

  # ---- A4 문서 드리프트 ----------------------------------------------------
  # 정본 문서가 적어 둔 기동 명령과 스크립트가 인쇄한 명령이 같은가.
  local printed_cmd doc_cmd
  printed_cmd="$(sed -n -E 's#^ *(scripts/self_host_env\.sh --compose .*)$#\1#p' "$cdir/p1-env.log" | head -1)"
  doc_cmd="$(sed -n -E 's#^(scripts/self_host_env\.sh --compose up .*)$#\1#p' "$REPO_ROOT/docs/SELF_HOST.md" | head -1)"
  if [ -n "$printed_cmd" ] && [ "$printed_cmd" = "$doc_cmd" ]; then
    emit_audit "$cycle" A4 PASS "인쇄 명령 = 문서 명령: $printed_cmd"
  else
    emit_audit "$cycle" A4 FAIL "인쇄='$printed_cmd' 문서='$doc_cmd'"
  fi

  # ---- P2 stack -----------------------------------------------------------
  local t2
  t0="$(now_ms)"
  if [ "$IMAGE_MODE" = "published-digest" ]; then
    compose up -d --pull missing --wait > "$cdir/p2-up.log" 2>&1 \
      || { tail -40 "$cdir/p2-up.log" >&2; fail "P2 stack 실패"; }
  else
    compose up -d --build --wait > "$cdir/p2-up.log" 2>&1 \
      || { tail -40 "$cdir/p2-up.log" >&2; fail "P2 stack 실패"; }
  fi
  t2="$(now_ms)"
  local p2=$(( t2 - t0 ))
  emit_timing "$cycle" P2 stack "$p2" "up -d --wait"
  log "P2 stack      $(fmt_ms "$p2")"

  # 하위 분해: 원샷 컨테이너들이 실제로 얼마나 걸렸나.
  # p2-window 두 줄은 "이미지를 굽는 시간"과 "떠서 healthy가 되는 시간"을
  # 나중에 빼서 구할 수 있게 하는 기준점이다 — 첫 컨테이너가 시작하기 전까지가
  # 전자, 그 뒤가 후자다.
  {
    printf '# p2-window-start-ms\t%s\n' "$(( t2 - p2 ))"
    printf '# p2-window-end-ms\t%s\n' "$t2"
    printf 'service\tstarted\tfinished\texit\n'
    docker ps -a --filter "label=com.docker.compose.project=$CURRENT_PROJECT" --format '{{.ID}}' \
      | while IFS= read -r cid; do
          [ -n "$cid" ] || continue
          docker inspect --format \
            '{{index .Config.Labels "com.docker.compose.service"}}{{"\t"}}{{.State.StartedAt}}{{"\t"}}{{.State.FinishedAt}}{{"\t"}}{{.State.ExitCode}}' \
            "$cid" 2>/dev/null || true
        done
  } > "$cdir/container-timeline.tsv" 2>/dev/null || true

  # P2를 둘로 가른다: 이미지가 준비될 때까지(build/pull) vs 떠서 healthy까지.
  # 경계는 "이 프로젝트에서 가장 먼저 시작한 컨테이너의 StartedAt"이다.
  if command -v python3 >/dev/null 2>&1; then
    local split
    split="$(python3 - "$cdir/container-timeline.tsv" "$(( t2 - p2 ))" "$t2" <<'PY' 2>/dev/null || true
import sys, datetime
path, start_ms, end_ms = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
earliest = None
for line in open(path):
    if line.startswith('#') or line.startswith('service'):
        continue
    parts = line.rstrip('\n').split('\t')
    if len(parts) < 2:
        continue
    raw = parts[1]
    if raw.startswith('0001-'):
        continue
    try:
        base, frac = raw.split('.', 1)
        dt = datetime.datetime.strptime(base, '%Y-%m-%dT%H:%M:%S').replace(tzinfo=datetime.timezone.utc)
        ms = int(dt.timestamp() * 1000) + int(frac.rstrip('Z')[:3])
    except Exception:
        continue
    if earliest is None or ms < earliest:
        earliest = ms
if earliest is None or not (start_ms <= earliest <= end_ms):
    sys.exit(1)
print(f"{earliest - start_ms}\t{end_ms - earliest}")
PY
)"
    if [ -n "$split" ]; then
      emit_timing "$cycle" P2a image "$(printf '%s' "$split" | cut -f1)" "이미지 준비(build/pull) — 첫 컨테이너 시작까지"
      emit_timing "$cycle" P2b converge "$(printf '%s' "$split" | cut -f2)" "기동+롤+마이그레이션+오너+healthy"
      log "  ├ P2a image     $(fmt_ms "$(printf '%s' "$split" | cut -f1)")"
      log "  └ P2b converge  $(fmt_ms "$(printf '%s' "$split" | cut -f2)")"
    fi
  fi

  local api_started_before
  api_started_before="$(api_started_at)"

  # 엣지가 실제로 화면을 주는가 (M1 성립 조건).
  # 주의: 엣지는 /healthz만 프록시한다. /health 는 SPA 폴백에 걸려 index.html을
  # 200으로 돌려주므로, 그것을 헬스체크로 쓰면 죽은 스택도 통과한다.
  local screen_code health_code
  screen_code="$(curl -s -o "$cdir/index.html" -w '%{http_code}' --max-time "$HTTP_TIMEOUT" "$base/" || echo 000)"
  [ "$screen_code" = "200" ] || fail "M1 실패: 엣지가 $screen_code 를 줬다."
  health_code="$(curl -s -o "$cdir/healthz.json" -w '%{http_code}' --max-time "$HTTP_TIMEOUT" "$base/healthz" || echo 000)"
  [ "$health_code" = "200" ] || fail "M1 실패: /healthz 가 $health_code 를 줬다."
  local m1=$(( p1 + p2 ))
  emit_timing "$cycle" M1 first-screen "$m1" "http 200 from $base/"
  log "M1 첫 화면    $(fmt_ms "$m1")"

  # ---- P3 login -----------------------------------------------------------
  t0="$(now_ms)"
  local login_json access ws member_id realtime_url
  login_json="$(curl -sS --max-time "$HTTP_TIMEOUT" -X POST "$base/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg e "$owner_email" --arg p "$owner_password" '{email:$e,password:$p}')")" \
    || fail "P3 login 요청 실패"
  t1="$(now_ms)"
  local p3=$(( t1 - t0 ))
  access="$(printf '%s' "$login_json" | jq -r '.accessToken // empty')"
  ws="$(printf '%s' "$login_json" | jq -r '.member.workspaceId // empty')"
  member_id="$(printf '%s' "$login_json" | jq -r '.member.id // empty')"
  realtime_url="$(printf '%s' "$login_json" | jq -r '.realtimeWebSocketUrl // empty')"
  [ -n "$access" ] || { printf '%s\n' "$login_json" > "$cdir/p3-login-fail.json"; fail "P3: accessToken 없음"; }
  [ -n "$ws" ] || fail "P3: 로그인 응답에 workspaceId가 없다 — 워크스페이스를 알아낼 다른 경로가 필요하다."
  printf '%s' "$login_json" | jq 'del(.accessToken,.refreshToken)' > "$cdir/p3-login.json" 2>/dev/null || true
  emit_timing "$cycle" P3 login "$p3" "POST /v1/auth/login"
  local m2=$(( m1 + p3 ))
  emit_timing "$cycle" M2 first-login "$m2" "accessToken 수령"
  log "P3 login      $(fmt_ms "$p3")   → M2 첫 로그인 $(fmt_ms "$m2")"

  auth_get()  { curl -sS --max-time "$HTTP_TIMEOUT" -H "Authorization: Bearer $access" "$base$1"; }
  auth_post() { curl -sS --max-time "$HTTP_TIMEOUT" -H "Authorization: Bearer $access" \
                  -H 'Content-Type: application/json' -X POST "$base$1" -d "$2"; }
  auth_put()  { curl -sS --max-time "$HTTP_TIMEOUT" -H "Authorization: Bearer $access" \
                  -H 'Content-Type: application/json' -X PUT "$base$1" -d "$2"; }
  auth_code() { curl -sS --max-time "$HTTP_TIMEOUT" -o /dev/null -w '%{http_code}' \
                  -H "Authorization: Bearer $access" "$base$1"; }

  # ---- A5 로그인 워크스페이스 칸 -------------------------------------------
  # SELF_HOST.md는 "워크스페이스 칸은 비워 둔다"고 한다. 비워 두는 것이 정말
  # 되는지, 그리고 사람이 뭔가 잘못 적었을 때 무슨 일이 벌어지는지 함께 잰다.
  local junk_code exact_code
  junk_code="$(curl -sS -o "$cdir/a5-junk.json" -w '%{http_code}' --max-time "$HTTP_TIMEOUT" \
    -X POST "$base/v1/auth/login" -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg e "$owner_email" --arg p "$owner_password" '{email:$e,password:$p,workspace:"not-a-uuid"}')" || echo 000)"
  exact_code="$(curl -sS -o "$cdir/a5-exact.json" -w '%{http_code}' --max-time "$HTTP_TIMEOUT" \
    -X POST "$base/v1/auth/login" -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg e "$owner_email" --arg p "$owner_password" --arg w "$ws" '{email:$e,password:$p,workspace:$w}')" || echo 000)"
  emit_audit "$cycle" A5 INFO "빈 칸=200(성공) · 쓰레기 UUID=$junk_code · 정확한 UUID=$exact_code"

  # ---- P4 workspace -------------------------------------------------------
  t0="$(now_ms)"
  local ws_json channels_json channel_id channel_count
  ws_json="$(auth_get "/v1/workspaces/$ws")" || fail "P4: 워크스페이스 조회 실패"
  channels_json="$(auth_get "/v1/workspaces/$ws/channels")" || fail "P4: 채널 목록 실패"
  t1="$(now_ms)"
  local p4=$(( t1 - t0 ))
  printf '%s' "$ws_json" > "$cdir/p4-workspace.json"
  printf '%s' "$channels_json" > "$cdir/p4-channels.json"
  channel_count="$(printf '%s' "$channels_json" | jq -r 'if type=="array" then length else (.channels // []) | length end')"
  channel_id="$(printf '%s' "$channels_json" | jq -r 'if type=="array" then .[0].id else (.channels // [])[0].id end // empty')"
  [ -n "$channel_id" ] || fail "P4: 들어갈 채널이 하나도 없다 — 첫 메시지를 보낼 자리가 없다."
  emit_timing "$cycle" P4 workspace "$p4" "GET workspace + channels (n=$channel_count)"
  log "P4 workspace  $(fmt_ms "$p4")   채널 $channel_count 개"

  # ---- A2 빈 상태 ---------------------------------------------------------
  local msgs_json msg_count agents_json agent_count
  msgs_json="$(auth_get "/v1/workspaces/$ws/channels/$channel_id/messages")" || msgs_json='{}'
  msg_count="$(printf '%s' "$msgs_json" | jq -r 'if type=="array" then length else (.messages // []) | length end' 2>/dev/null || echo '?')"
  agents_json="$(auth_get "/v1/workspaces/$ws/roster")" || agents_json='{}'
  agent_count="$(printf '%s' "$agents_json" | jq -r '[ (if type=="array" then .[] else (.members // .roster // [])[] end) | select(.kind=="agent") ] | length' 2>/dev/null || echo '?')"
  printf '%s' "$agents_json" > "$cdir/a2-roster.json"
  emit_audit "$cycle" A2 INFO "첫 로그인 직후 — 채널 $channel_count · 첫 채널 메시지 $msg_count · 에이전트 member $agent_count"

  # ---- P5 first message ---------------------------------------------------
  t0="$(now_ms)"
  local post_json msg_id
  post_json="$(auth_post "/v1/workspaces/$ws/channels/$channel_id/messages" \
    "$(jq -cn --arg c "$(uuidgen | tr '[:upper:]' '[:lower:]')" --arg b "onboarding bench $RUN_ID cycle $cycle" \
      '{clientMsgId:$c,body:$b}')")" || fail "P5: 메시지 전송 실패"
  msg_id="$(printf '%s' "$post_json" | jq -r '.id // .message.id // empty')"
  [ -n "$msg_id" ] || { printf '%s\n' "$post_json" > "$cdir/p5-fail.json"; fail "P5: 메시지 id를 못 받았다"; }

  # 레일까지 갔다는 증거는 로그가 아니라 outbox다 (SELF_HOST.md §막히면).
  local rail_deadline pending rail_ok=0
  rail_deadline=$(( $(date -u +%s) + RAIL_TIMEOUT ))
  while [ "$(date -u +%s)" -le "$rail_deadline" ]; do
    pending="$(compose exec -T postgres psql -U momo -d momo -tA \
      -c "SELECT count(*) FROM outbox WHERE kind = 'broadcast' AND status <> 'done';" 2>/dev/null | tr -d '[:space:]' || echo err)"
    if [ "$pending" = "0" ]; then rail_ok=1; break; fi
    sleep 1
  done
  t1="$(now_ms)"
  local p5=$(( t1 - t0 ))
  [ "$rail_ok" -eq 1 ] || fail "P5: outbox가 ${RAIL_TIMEOUT}초 안에 비워지지 않았다 (relay 미동작)."
  compose exec -T postgres psql -U momo -d momo -c \
    "SELECT kind, status, count(*) FROM outbox GROUP BY 1,2;" > "$cdir/p5-outbox.txt" 2>&1 || true
  emit_timing "$cycle" P5 message "$p5" "POST message + outbox drained"
  local m3=$(( m2 + p4 + p5 ))
  emit_timing "$cycle" M3 first-message "$m3" "메시지가 레일까지"
  log "P5 message    $(fmt_ms "$p5")   → M3 첫 메시지 $(fmt_ms "$m3")"

  if [ "$SKIP_AGENT" -eq 1 ]; then
    emit_audit "$cycle" A1 SKIP "--skip-agent"
    emit_audit "$cycle" A3 INFO "왕복 수: M2=1 · M3=+3 (workspace·channels·message) · M4=미측정"
    finish_cycle "$cycle" "$cdir"
    return 0
  fi

  # ---- P6 agent pairing ---------------------------------------------------
  # openapi.yaml(611): createAgent 는 채널 멤버십도 베어러도 만들지 않는다고
  # 스스로 적고 있다. 즉 "에이전트를 붙였다"는 한 번의 호출이 아니라 셋이다.
  # 그리고 displayName·handle·model·baseUrl 은 전부 필수다(dto.rs CreateAgentRequest).
  t0="$(now_ms)"
  local handle agent_json agent_id agent_steps=0
  handle="bench$(printf '%s' "$RUN_ID" | tr -dc '0-9' | tail -c 8)c$cycle"

  # A6 — 노트북 셀프호스터의 실제 첫 시도: 로컬에 띄운 모델 엔드포인트.
  # 생성된 env는 MOMO_ENV=staging 이고 AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK 이
  # 없다. 그 조합에서 루프백 http가 받아들여지는지 먼저 재고, 거절이면
  # https 로 한 번 더 시도해 M4 자체는 성립시킨다.
  local loopback_body https_body loopback_code
  loopback_body="$(jq -cn --arg h "$handle" --arg d "onboarding bench agent" \
    '{displayName:$d,handle:$h,model:"hermes-agent",baseUrl:"http://127.0.0.1:11434/v1"}')"
  https_body="$(printf '%s' "$loopback_body" | jq -c '.baseUrl="https://provider.invalid/v1"')"
  loopback_code="$(curl -sS -o "$cdir/p6-loopback.json" -w '%{http_code}' --max-time "$HTTP_TIMEOUT" \
    -X POST "$base/v1/workspaces/$ws/agents" -H "Authorization: Bearer $access" \
    -H 'Content-Type: application/json' -d "$loopback_body" || echo 000)"
  if [ "$loopback_code" = "201" ]; then
    emit_audit "$cycle" A6 PASS "루프백 http 프로바이더 엔드포인트 허용(201)"
    agent_json="$(cat "$cdir/p6-loopback.json")"
  else
    emit_audit "$cycle" A6 BLOCKED "루프백 http baseUrl → $loopback_code ($(jq -r '.message // .error // empty' "$cdir/p6-loopback.json" 2>/dev/null)). 노트북의 로컬 모델을 붙이려면 HTTPS가 필요하다."
    agent_json="$(auth_post "/v1/workspaces/$ws/agents" "$https_body")" || agent_json='{}'
  fi
  agent_id="$(printf '%s' "$agent_json" | jq -r '.agent.id // .id // .member.id // empty')"
  printf '%s' "$agent_json" > "$cdir/p6-agent.json"
  if [ -z "$agent_id" ]; then
    t1="$(now_ms)"
    emit_timing "$cycle" P6 agent "$(( t1 - t0 ))" "createAgent 실패 — 본문 p6-agent.json"
    emit_audit "$cycle" A3 INFO "왕복 수: M2=1 · M3=+3 · M4=createAgent에서 막힘"
    emit_audit "$cycle" A1 SKIP "에이전트 생성 실패로 provider 감사 미수행"
    log "P6 agent      실패 — 증거: $cdir/p6-agent.json"
    finish_cycle "$cycle" "$cdir"
    return 0
  fi
  agent_steps=1
  auth_post "/v1/workspaces/$ws/channels/$channel_id/members" \
    "$(jq -cn --arg m "$agent_id" '{memberId:$m,role:"member"}')" > "$cdir/p6-member.json" 2>&1 || true
  agent_steps=$(( agent_steps + 1 ))
  auth_post "/v1/workspaces/$ws/agents/$agent_id/credentials" \
    "$(jq -cn '{label:"onboarding-bench"}')" \
    | jq 'del(.bearer,.token,.credential.bearer)' > "$cdir/p6-credential.json" 2>&1 || true
  agent_steps=$(( agent_steps + 1 ))
  t1="$(now_ms)"
  local p6=$(( t1 - t0 ))
  emit_timing "$cycle" P6 agent "$p6" "createAgent + channel member + credential ($agent_steps calls)"
  local m4=$(( m3 + p6 ))
  emit_timing "$cycle" M4 first-agent "$m4" "에이전트 신원+합류+베어러"
  log "P6 agent      $(fmt_ms "$p6")   → M4 첫 에이전트 $(fmt_ms "$m4")"

  emit_audit "$cycle" A3 INFO "왕복 수: M2=1 · M3=+3(workspace·channels·message) · M4=+$agent_steps(agent·member·credential)"

  # ---- A1 키 반영 무재시작 -------------------------------------------------
  # ADR-0004: provider 자격증명은 유입되지 않는다. 그래서 이 감사가 묻는 것은
  # "키가 어디에 사나"이다 — 프로세스 env면 재시작이 필요하고, 행이면 아니다.
  local put_code get_before get_after tail_after api_started_after
  get_before="$(curl -sS -o "$cdir/a1-get-before.json" -w '%{http_code}' --max-time "$HTTP_TIMEOUT" \
    -H "Authorization: Bearer $access" "$base/v1/provider/link" || echo 000)"
  put_code="$(curl -sS -o "$cdir/a1-put.json" -w '%{http_code}' --max-time "$HTTP_TIMEOUT" \
    -X PUT "$base/v1/provider/link" -H "Authorization: Bearer $access" \
    -H 'Content-Type: application/json' \
    -d "$(jq -cn '{baseUrl:"https://provider.invalid/v1",bearer:"sk-bench-0000000000000000abcd"}')" || echo 000)"
  get_after="$(curl -sS -o "$cdir/a1-get.json" -w '%{http_code}' --max-time "$HTTP_TIMEOUT" \
    -H "Authorization: Bearer $access" "$base/v1/provider/link" || echo 000)"
  tail_after="$(jq -r '.bearerLast4 // .link.bearerLast4 // empty' "$cdir/a1-get.json" 2>/dev/null || true)"
  api_started_after="$(api_started_at)"
  if [ "$put_code" = "200" ] && [ -n "$tail_after" ] && [ "$api_started_before" = "$api_started_after" ]; then
    emit_audit "$cycle" A1 PASS "PUT $put_code · GET $get_after · bearerLast4=$tail_after · api StartedAt 불변 → 재시작 불요"
  elif [ "$put_code" = "403" ] || [ "$put_code" = "401" ]; then
    emit_audit "$cycle" A1 BLOCKED "GET $get_before · PUT /v1/provider/link → $put_code (MOMO-583 인스턴스 오퍼레이터 게이트). 셀프호스트 첫 owner는 AI 연결을 저장할 수 없다."
  else
    emit_audit "$cycle" A1 FAIL "PUT $put_code · GET $get_after · bearerLast4='$tail_after' · api StartedAt $api_started_before → $api_started_after"
  fi

  # ---- A7 시드 계정 ---------------------------------------------------------
  # 마이그레이션 002는 demo@momo.local 을 심고 012가 그 공개 비밀번호를 잠근다고
  # env 주석이 말한다. 셀프호스트 인스턴스에서 그 잠금이 실제로 걸렸는지 잰다.
  local seed_code
  seed_code="$(curl -sS -o "$cdir/a7-seed-login.json" -w '%{http_code}' --max-time "$HTTP_TIMEOUT" \
    -X POST "$base/v1/auth/login" -H 'Content-Type: application/json' \
    -d '{"email":"demo@momo.local","password":"dev-password"}' || echo 000)"
  if [ "$seed_code" = "401" ] || [ "$seed_code" = "400" ]; then
    emit_audit "$cycle" A7 PASS "시드 계정 demo@momo.local/dev-password → $seed_code (잠김)"
  else
    emit_audit "$cycle" A7 FAIL "시드 계정 demo@momo.local/dev-password → $seed_code — 공개 기본 비밀번호가 살아 있다"
  fi

  finish_cycle "$cycle" "$cdir"
}

finish_cycle() {
  local cycle="$1" cdir="$2"
  docker system df > "$cdir/df-after.txt" 2>&1 || true
  compose logs --no-color --tail 200 > "$cdir/stack-logs.txt" 2>&1 || true
  if [ "$KEEP" -eq 1 ] && [ "$cycle" -eq "$REPEAT" ]; then
    log "--keep: 마지막 회전의 스택을 남긴다. 내리려면:"
    log "  scripts/self_host_env.sh --compose down -v"
  else
    teardown "cycle $cycle"
  fi
}

CYCLE=1
while [ "$CYCLE" -le "$REPEAT" ]; do
  run_cycle "$CYCLE"
  CYCLE=$(( CYCLE + 1 ))
done

# --------------------------------------------------------------------------
# 요약
# --------------------------------------------------------------------------
{
  echo "# oort 온보딩 실측 — $RUN_ID"
  echo
  echo "- repo: \`$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')@$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')\`"
  echo "- 이미지 모드: $IMAGE_MODE · 회전 $REPEAT · $([ "$COLD" -ge 2 ] && echo first-run || { [ "$COLD" -eq 1 ] && echo cold || echo warm; })"
  echo "- 기준선: dsh 한 줄 설치 → 5~10분"
  echo
  echo "## 구간"
  echo
  echo "| 회전 | 구간 | 마일스톤 | 시간 | 비고 |"
  echo "|---|---|---|---|---|"
  tail -n +2 "$TIMINGS_TSV" | while IFS="$(printf '\t')" read -r c p m ms note; do
    printf '| %s | %s | %s | %s | %s |\n' "$c" "$p" "$m" "$(fmt_ms "$ms")" "$note"
  done
  echo
  echo "## 기본값 감사"
  echo
  echo "| 회전 | 항목 | 판정 | 내용 |"
  echo "|---|---|---|---|"
  tail -n +2 "$AUDIT_TSV" | while IFS="$(printf '\t')" read -r c id v d; do
    printf '| %s | %s | %s | %s |\n' "$c" "$id" "$v" "$d"
  done
  echo
  echo "증거: \`$EVIDENCE_DIR\`"
} > "$EVIDENCE_DIR/summary.md"

CLEAN_EXIT=1
log "완료. 요약: $EVIDENCE_DIR/summary.md"
cat "$EVIDENCE_DIR/summary.md"
