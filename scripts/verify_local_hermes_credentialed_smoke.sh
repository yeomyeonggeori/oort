#!/usr/bin/env bash
# =============================================================================
# scripts/verify_local_hermes_credentialed_smoke.sh
#
# MOMO-257 user-owned credential setup wrapper for a local Hermes-compatible
# provider. Codex/momo never receive Codex/OpenAI OAuth credentials or provider
# API keys; this wrapper only passes a loopback provider URL and Hermes-facing
# bearer to the existing external-agent verifier.
# =============================================================================
set -euo pipefail

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
DEFAULT_ENV_FILE="${HOME:-}/.momo/local-hermes-provider.env"
PROVIDER_ENV_FILE="${LOCAL_HERMES_PROVIDER_ENV_FILE:-${EXTERNAL_AGENT_PROVIDER_ENV_FILE:-$DEFAULT_ENV_FILE}}"
OUT_DIR="${LOCAL_HERMES_CREDENTIAL_SMOKE_OUT_DIR:-${LOCAL_GATE_OUTPUT_DIR:-${TMPDIR:-/tmp}/momo-local-hermes-credentialed}}"
RUN_SLUG="$(date -u +%Y%m%dT%H%M%SZ)-$$"
EVIDENCE_FILE="$OUT_DIR/local-hermes-credentialed-smoke-${RUN_SLUG}.md"
RESULT="UNKNOWN"
REASON=""

mkdir -p "$OUT_DIR"

truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
  esac
  return 1
}

write_evidence() {
  local provider_env_label="$PROVIDER_ENV_FILE"
  if [ "${INLINE_MOMO_FACING_PROVIDER_ENV:-0}" = "1" ]; then
    provider_env_label="<inline momo-facing provider env>"
  fi
  {
    echo "## MOMO-257 Local Hermes/Codex OAuth Credentialed Smoke"
    echo "- Result: \`${RESULT}\`"
    echo "- Reason: ${REASON}"
    echo "- Runbook: \`docs/external-agent-provider/local-hermes-codex-oauth-setup.md\`"
    echo "- Provider env file: \`${provider_env_label}\`"
    echo "- Credential boundary ADR: \`docs/adr/0004-codex-oauth-hermes-provider-boundary.md\`"
    echo "- Boundary: user/provider owns Codex OAuth login, access/refresh token storage, GPT/OpenAI API keys, refresh, unlink, and revoke."
    echo "- momo receives only \`HERMES_BASE_URL\`, \`HERMES_API_KEY\`, \`AGENT_MODEL\`, and local opt-in flags needed to call the Hermes-compatible SSE boundary."
    echo "- Evidence handling: this wrapper never prints or copies provider env contents; the downstream verifier redacts \`HERMES_API_KEY\`, bearer tokens, app tokens, and DB passwords."
    echo "- Safe local defaults: \`MOMO_ENV=local\`, \`AGENT_PROVIDER_MODE=external-hermes\`, \`AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1\`, \`AGENT_HANDLE=hermes\`, \`AGENT_DISPLAY_NAME=Hermes\`."
    if [ "$RESULT" = "NEEDS_USER_CREDENTIAL" ]; then
      echo "- Next human step: start/log in to the local Hermes-compatible provider, create the out-of-repo env file from \`docs/external-agent-provider/local-hermes-provider.env.example\`, then rerun this script."
      echo "- Not covered: real provider SSE preflight and @hermes timeline roundtrip remain \`runtime-unverified(external provider credentials)\`."
    elif [ "$RESULT" = "FAIL" ]; then
      echo "- Failure is before the external verifier, so no provider call was attempted."
    else
      echo "- External verifier executed. See the external-agent-provider evidence printed by the downstream script for provider preflight and @hermes roundtrip details."
    fi
  } > "$EVIDENCE_FILE"
}

fail() {
  RESULT="FAIL"
  REASON="$1"
  write_evidence
  cat "$EVIDENCE_FILE"
  echo "[local-hermes-credentialed] FAIL: $1" >&2
  exit 1
}

needs_user_credential() {
  RESULT="NEEDS_USER_CREDENTIAL"
  REASON="$1"
  write_evidence
  cat "$EVIDENCE_FILE"
  if truthy "${LOCAL_HERMES_REQUIRE_CREDENTIALS:-${EXTERNAL_AGENT_PROVIDER_REQUIRE_CREDENTIALS:-0}}"; then
    echo "[local-hermes-credentialed] missing required credentialed provider env" >&2
    exit 1
  fi
  echo "[local-hermes-credentialed] NEEDS_USER_CREDENTIAL: $1"
  exit 0
}

validate_no_forbidden_provider_env() {
  local forbidden=()
  local key
  for key in CODEX_OAUTH_TOKEN CODEX_OAUTH_ACCESS_TOKEN CODEX_OAUTH_REFRESH_TOKEN \
    CODEX_ACCESS_TOKEN CODEX_REFRESH_TOKEN CODEX_API_KEY CODEX_PROVIDER_API_KEY \
    OPENAI_OAUTH_TOKEN OPENAI_OAUTH_ACCESS_TOKEN OPENAI_OAUTH_REFRESH_TOKEN \
    OPENAI_ACCESS_TOKEN OPENAI_REFRESH_TOKEN OPENAI_API_KEY OPENAI_ADMIN_KEY \
    OPENAI_PROVIDER_API_KEY; do
    if [ "${!key+x}" ] && [ "${!key:-}" != "" ]; then
      forbidden+=("$key")
    fi
  done
  if [ "${#forbidden[@]}" -gt 0 ]; then
    fail "Codex/OpenAI OAuth token or API key env must not be present in the momo smoke process: $(IFS=', '; echo "${forbidden[*]}"). Move it into the local Hermes-compatible provider runtime."
  fi
}

absolute_path() {
  python3 - "$1" <<'PY'
import os
import sys
print(os.path.realpath(os.path.expanduser(sys.argv[1])))
PY
}

validate_no_forbidden_provider_env

if [ "$PROVIDER_ENV_FILE" = "" ]; then
  if [ "${HERMES_BASE_URL:-}" != "" ] && [ "${HERMES_API_KEY:-}" != "" ]; then
    INLINE_MOMO_FACING_PROVIDER_ENV=1
  else
    needs_user_credential "No provider env file path configured. Set LOCAL_HERMES_PROVIDER_ENV_FILE or create ${DEFAULT_ENV_FILE}."
  fi
fi

if [ "${INLINE_MOMO_FACING_PROVIDER_ENV:-0}" != "1" ] && [ ! -f "$PROVIDER_ENV_FILE" ]; then
  if [ "${HERMES_BASE_URL:-}" != "" ] && [ "${HERMES_API_KEY:-}" != "" ]; then
    INLINE_MOMO_FACING_PROVIDER_ENV=1
  else
    needs_user_credential "Provider env file is not present yet."
  fi
fi

if [ "${INLINE_MOMO_FACING_PROVIDER_ENV:-0}" != "1" ]; then
  ENV_ABS="$(absolute_path "$PROVIDER_ENV_FILE")"
  REPO_ABS="$(absolute_path "$REPO_ROOT")"
  case "$ENV_ABS" in
    "$REPO_ABS"/*)
      fail "Provider env file must live outside the repository so credentials cannot be committed accidentally."
      ;;
  esac
fi

RESULT="RUNNING"
if [ "${INLINE_MOMO_FACING_PROVIDER_ENV:-0}" = "1" ]; then
  REASON="Momo-facing provider env exists in the current shell; delegating to scripts/verify_external_agent_provider.sh without printing secret values."
else
  REASON="Provider env file exists outside the repository; delegating to scripts/verify_external_agent_provider.sh without printing env contents."
fi
write_evidence

if [ "${INLINE_MOMO_FACING_PROVIDER_ENV:-0}" = "1" ]; then
  echo "[local-hermes-credentialed] using inline momo-facing provider env (secret values not printed)"
else
  echo "[local-hermes-credentialed] using out-of-repo provider env file (contents not printed)"
fi
echo "[local-hermes-credentialed] evidence preface: $EVIDENCE_FILE"

if [ "${INLINE_MOMO_FACING_PROVIDER_ENV:-0}" = "1" ]; then
  unset EXTERNAL_AGENT_PROVIDER_ENV_FILE
  EXTERNAL_AGENT_PROVIDER_REQUIRE_CREDENTIALS=1 \
  MOMO_ENV="${MOMO_ENV:-local}" \
  AGENT_PROVIDER_MODE="${AGENT_PROVIDER_MODE:-external-hermes}" \
  AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK="${AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK:-1}" \
  AGENT_HANDLE="${AGENT_HANDLE:-hermes}" \
  AGENT_DISPLAY_NAME="${AGENT_DISPLAY_NAME:-Hermes}" \
  "$REPO_ROOT/scripts/verify_external_agent_provider.sh"
else
  EXTERNAL_AGENT_PROVIDER_ENV_FILE="$PROVIDER_ENV_FILE" \
  EXTERNAL_AGENT_PROVIDER_REQUIRE_CREDENTIALS=1 \
  MOMO_ENV="${MOMO_ENV:-local}" \
  AGENT_PROVIDER_MODE="${AGENT_PROVIDER_MODE:-external-hermes}" \
  AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK="${AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK:-1}" \
  AGENT_HANDLE="${AGENT_HANDLE:-hermes}" \
  AGENT_DISPLAY_NAME="${AGENT_DISPLAY_NAME:-Hermes}" \
  "$REPO_ROOT/scripts/verify_external_agent_provider.sh"
fi
