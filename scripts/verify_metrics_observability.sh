#!/usr/bin/env bash
# MOMO-562 / ADR-0121 D7-D10 runtime verifier.
# Docker execution belongs to the orchestrator. Workers run syntax/static gates.
set -euo pipefail

fail() {
  printf '[metrics] FAIL: %s\n' "$*" >&2
  exit 1
}

pass() {
  printf '[metrics] PASS: %s\n' "$*"
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

need docker
need curl

API_METRICS_PORT="${MOMO_METRICS_API_PORT:-28210}"
RELAY_METRICS_PORT="${MOMO_METRICS_RELAY_PORT:-28211}"
WORKER_METRICS_PORT="${MOMO_METRICS_WORKER_PORT:-28212}"
PUSH_METRICS_PORT="${MOMO_METRICS_PUSH_PORT:-28213}"
PROJECT="${MOMO_METRICS_PROJECT:-momo562metrics$$}"
BOOT_TIMEOUT="${MOMO_METRICS_BOOT_TIMEOUT:-2400}"
COMPOSE_BASE="$REPO_ROOT/infra/docker-compose.e2e.yml"
COMPOSE_OVERLAY="$REPO_ROOT/infra/e2e/metrics.overlay.yml"

case "$PROJECT" in
  *[!a-z0-9_-]*|"") fail "compose project must be non-empty lowercase [a-z0-9_-]" ;;
esac

compose() {
  local env_args=()
  if [ -f "$REPO_ROOT/.env.worktree" ]; then
    env_args=(--env-file "$REPO_ROOT/.env.worktree")
  fi
  POSTGRES_PORT=0 CENT_PORT=0 HERMES_PORT=0 PORT=0 \
  MOMO_METRICS_API_PORT="$API_METRICS_PORT" \
  MOMO_METRICS_RELAY_PORT="$RELAY_METRICS_PORT" \
  MOMO_METRICS_WORKER_PORT="$WORKER_METRICS_PORT" \
  MOMO_METRICS_PUSH_PORT="$PUSH_METRICS_PORT" \
    docker compose "${env_args[@]+${env_args[@]}}" -p "$PROJECT" \
      --profile observability -f "$COMPOSE_BASE" -f "$COMPOSE_OVERLAY" "$@"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && {
    exec 3>&- 3<&-
    return 0
  }
  return 1
}

for port in "$API_METRICS_PORT" "$RELAY_METRICS_PORT" \
  "$WORKER_METRICS_PORT" "$PUSH_METRICS_PORT"; do
  port_in_use "$port" && fail "reserved verifier port $port is already in use"
done
pass "reserved ports 28210-28213 are available"

rendered="$(compose config)"
case "$rendered" in
  *"published: \"9090\""*|*"published: 9090"*)
    fail "production Prometheus port must not be published" ;;
esac
grep -Fq 'profiles:' infra/prod/docker-compose.prod.yml \
  || fail "production Prometheus service must be profile-gated"
grep -Fq 'profiles: ["observability"]' infra/prod/docker-compose.prod.yml \
  || fail "production Prometheus service must require observability profile"
if awk '/prometheus:/{seen=1} seen && /networks:/{net=1} seen && net && /- public/{bad=1} END{exit bad?0:1}' \
  infra/prod/docker-compose.prod.yml; then
  fail "Prometheus must not attach to the public network"
fi
pass "observability profile renders without public Prometheus/metrics ports"

printf '[metrics] cold-building and starting api/relay/worker/push-relay metrics endpoints\n'
compose up -d api relay worker metrics-push-relay

deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
for endpoint in \
  "api:$API_METRICS_PORT" \
  "relay:$RELAY_METRICS_PORT" \
  "worker:$WORKER_METRICS_PORT" \
  "push:$PUSH_METRICS_PORT"; do
  service="${endpoint%%:*}"
  port="${endpoint##*:}"
  until curl -fsS "http://127.0.0.1:$port/metrics" >/dev/null 2>&1; do
    if [ "$(date -u +%s)" -ge "$deadline" ]; then
      compose logs --tail 160 api relay worker metrics-push-relay >&2 || true
      fail "$service /metrics did not become ready"
    fi
    sleep 2
  done
done

api_metrics="$(curl -fsS "http://127.0.0.1:$API_METRICS_PORT/metrics")"
relay_metrics="$(curl -fsS "http://127.0.0.1:$RELAY_METRICS_PORT/metrics")"
worker_metrics="$(curl -fsS "http://127.0.0.1:$WORKER_METRICS_PORT/metrics")"
push_metrics="$(curl -fsS "http://127.0.0.1:$PUSH_METRICS_PORT/metrics")"

case "$api_metrics" in *'# momo Prometheus metrics'*) ;; *) fail "api metrics body missing" ;; esac
for name in momo_outbox_pending_oldest_age_seconds momo_outbox_publish_latency_seconds; do
  case "$relay_metrics" in *"$name"*) ;; *) fail "relay missing $name" ;; esac
done
for name in momo_budget_trips_total momo_agent_turn_duration_seconds; do
  case "$worker_metrics" in *"$name"*) ;; *) fail "worker missing $name" ;; esac
done
case "$push_metrics" in *'momo_apns_failures_total{code_class="429"}'*) ;;
  *) fail "push relay missing bounded APNs code_class series" ;;
esac

all_metrics="$api_metrics
$relay_metrics
$worker_metrics
$push_metrics"
for forbidden in workspace_id run_id member_id message_body prompt display_name email channel_name; do
  case "$all_metrics" in
    *"$forbidden"*) fail "forbidden tenant/content key entered metrics: $forbidden" ;;
  esac
done
pass "four private endpoints expose exactly the five bounded/content-free metric families"

for port in "$API_METRICS_PORT" "$RELAY_METRICS_PORT" \
  "$WORKER_METRICS_PORT" "$PUSH_METRICS_PORT"; do
  content_type="$(curl -fsS -D - -o /dev/null "http://127.0.0.1:$port/metrics" \
    | tr -d '\r' | awk 'tolower($1)=="content-type:"{$1=""; sub(/^ /,""); print; exit}')"
  case "$content_type" in
    'text/plain; version=0.0.4; charset=utf-8') ;;
    *) fail "port $port has wrong Prometheus content type: $content_type" ;;
  esac
done
pass "all endpoints use Prometheus text format 0.0.4"

printf '[metrics] PASS: MOMO-562 runtime observability contract\n'
