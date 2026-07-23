#!/usr/bin/env bash
# Validate the AWS one-week internal alpha topology contract before host deploy.
set -euo pipefail

ENV_FILE=""
FROM_ENV=0
MODE="auto"
EVIDENCE_DIR=""
CHECK_RESULTS=()

usage() {
  cat <<'EOF'
Usage: scripts/aws_internal_alpha_preflight.sh (--env-file FILE | --from-env) [--mode auto|minimum|recommended|split] [--evidence-dir DIR]

Validates non-secret AWS topology choices for the one-week internal alpha host:
  - minimum/recommended/split topology shape
  - Lightsail vs EC2 provider choice
  - public DNS/TLS intent
  - security-group exposure intent
  - encrypted volume and backup/restore requirements
  - source-checkout-free, image-based deploy and rollback intent

This script does not call AWS APIs, create resources, decrypt secrets, pull
images, or verify real DNS/TLS. It is a fail-fast preflight for operator input
and writes redacted evidence when --evidence-dir is set.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --from-env)
      FROM_ENV=1
      shift
      ;;
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --evidence-dir)
      EVIDENCE_DIR="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ "$ENV_FILE" = "" ] && [ "$FROM_ENV" != "1" ]; then
  echo "missing --env-file or --from-env" >&2
  usage >&2
  exit 2
fi

if [ "$ENV_FILE" != "" ] && [ ! -f "$ENV_FILE" ]; then
  echo "missing env file: $ENV_FILE" >&2
  exit 1
fi

failures=0

fail() {
  failures=$((failures + 1))
  echo "FAIL: $*" >&2
  CHECK_RESULTS+=("fail|$*")
}

pass() {
  echo "PASS: $*"
  CHECK_RESULTS+=("pass|$*")
}

load_env() {
  [ "$ENV_FILE" != "" ] || return 0
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
}

get_var() {
  eval "printf '%s' \"\${$1-}\""
}

require_var() {
  local key="$1"
  if [ "$(get_var "$key")" = "" ]; then
    fail "missing required env: $key"
  else
    pass "required env present: $key"
  fi
}

require_vars() {
  local key
  for key in "$@"; do
    require_var "$key"
  done
}

assert_exact() {
  local key="$1"
  local expected="$2"
  local value
  value="$(get_var "$key")"
  if [ "$value" = "$expected" ]; then
    pass "$key is $expected"
  else
    fail "$key must be '$expected' (got '${value:-<empty>}')"
  fi
}

assert_int_between() {
  local key="$1"
  local min="$2"
  local max="$3"
  local value
  value="$(get_var "$key")"
  case "$value" in
    ''|*[!0-9]*)
      fail "$key must be an integer"
      return 0
      ;;
  esac
  if [ "$value" -ge "$min" ] && [ "$value" -le "$max" ]; then
    pass "$key is within $min..$max"
  else
    fail "$key must be within $min..$max (got $value)"
  fi
}

assert_public_domain_value() {
  local label="$1"
  local value="$2"
  local lowered
  lowered="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  case "$lowered" in
    localhost|*.localhost|*.local|*.localdomain|*.test|*.invalid|*.example|example.com|*.example.com|*.internal)
      fail "$label must use a public DNS-shaped name, not reserved/local '$value'"
      return 0
      ;;
  esac
  case "$value" in
    *.*) pass "$label looks public-shaped" ;;
    *) fail "$label must include a registrable domain suffix" ;;
  esac
}

assert_public_domain() {
  local key="$1"
  local value
  value="$(get_var "$key")"
  [ "$value" != "" ] || return 0
  assert_public_domain_value "$key" "$value"
}

assert_email() {
  local key="$1"
  local value
  value="$(get_var "$key")"
  case "$value" in
    *@*.*) pass "$key looks like an email address" ;;
    *) fail "$key must look like an email address" ;;
  esac
}

assert_no_cidr_anywhere() {
  local key="$1"
  local value
  value="$(get_var "$key")"
  case "$value" in
    *0.0.0.0/0*|*::/0*)
      fail "$key must not include 0.0.0.0/0 or ::/0"
      ;;
    '')
      fail "$key must not be empty"
      ;;
    *)
      pass "$key is restricted"
      ;;
  esac
}

assert_https_cidr() {
  local key="$1"
  local value
  value="$(get_var "$key")"
  if [ "$value" = "" ]; then
    fail "$key must declare tester CIDRs or 0.0.0.0/0 for public alpha HTTPS"
  else
    pass "$key is declared"
  fi
}

assert_s3_bucket_name() {
  local key="$1"
  local value
  value="$(get_var "$key")"
  case "$value" in
    [a-z0-9][a-z0-9.-][a-z0-9.-]*[a-z0-9])
      if [ "${#value}" -ge 3 ] && [ "${#value}" -le 63 ]; then
        pass "$key looks like an S3 bucket name"
      else
        fail "$key must be 3..63 characters"
      fi
      ;;
    *)
      fail "$key must be lowercase letters, numbers, dots, or hyphens, and start/end alphanumeric"
      ;;
  esac
}

assert_image_pinned() {
  local key="$1"
  local value
  value="$(get_var "$key")"
  case "$value" in
    *@sha256:*|*:sha-[0-9a-f][0-9a-f]*)
      pass "$key is pinned by digest or git SHA tag"
      ;;
    *:latest|*:main|*:staging|*:internal-smoke*|momo-*:*)
      fail "$key must not use mutable/local image tag: $value"
      ;;
    *)
      fail "$key must be pinned by digest (@sha256:) or ':sha-<gitsha>' tag (got '$value')"
      ;;
  esac
}

assert_release_tag() {
  local key="$1"
  local value
  value="$(get_var "$key")"
  if printf '%s\n' "$value" | grep -Eq '^sha-[0-9a-f]{40}$'; then
    pass "$key is an immutable 40-character git SHA tag"
  else
    fail "$key must be 'sha-<40 lowercase hex git SHA>' (got '${value:-<empty>}')"
  fi
}

assert_image_matches_release() {
  local key="$1"
  local value
  local tag
  value="$(get_var "$key")"
  tag="$(get_var MOMO_IMAGE_TAG)"
  if printf '%s\n' "$value" | grep -Eq '@sha256:[0-9a-f]{64}$'; then
    pass "$key uses a per-image digest override"
    return 0
  fi
  case "$value" in
    *:"$tag") pass "$key uses MOMO_IMAGE_TAG" ;;
    *) fail "$key must use MOMO_IMAGE_TAG or a per-image @sha256 digest (got '$value')" ;;
  esac
}

assert_placement() {
  local key="$1"
  local expected="$2"
  assert_exact "$key" "$expected"
}

write_evidence() {
  [ "$EVIDENCE_DIR" != "" ] || return 0
  mkdir -p "$EVIDENCE_DIR"
  local stamp markdown json
  stamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  markdown="$EVIDENCE_DIR/aws-internal-alpha-preflight-${topology}.md"
  json="$EVIDENCE_DIR/aws-internal-alpha-preflight-${topology}.json"

  {
    echo "## AWS Internal Alpha Preflight"
    echo "- Result: $([ "$failures" -eq 0 ] && echo PASS || echo FAIL)"
    echo "- Topology: \`$topology\`"
    echo "- Provider: \`${AWS_ALPHA_PROVIDER:-}\`"
    echo "- Region: \`${AWS_REGION:-}\`"
    echo "- Source: \`${ENV_FILE:-process environment}\`"
    echo "- Generated: $stamp"
    echo "- Secrets: not read; this preflight validates topology shape only."
    echo "- Checks:"
    local entry status message marker
    for entry in "${CHECK_RESULTS[@]:-}"; do
      status="${entry%%|*}"
      message="${entry#*|}"
      marker="[ ]"
      [ "$status" = "pass" ] && marker="[x]"
      echo "  - $marker $message"
    done
    echo "- Coverage:"
    echo "  - AWS provider/topology, DNS/TLS intent, security-group exposure intent, encrypted gp3 volume intent, image pinning, source-checkout-free deploy, backup/restore/rollback acknowledgements."
    echo "- Not covered:"
    echo "  - AWS resource creation, IAM policy simulation, DNS propagation, Caddy ACME issuance, registry pull, SOPS decrypt, pgBackRest backup, EBS snapshot, PITR restore rehearsal, live host smoke."
  } > "$markdown"

  python3 - "$json" "$topology" "${AWS_ALPHA_PROVIDER:-}" "${AWS_REGION:-}" "${ENV_FILE:-process environment}" "$failures" "$stamp" "${CHECK_RESULTS[@]:-}" <<'PY'
import json
import sys

out, topology, provider, region, source, failures, stamp, *entries = sys.argv[1:]
checks = []
for entry in entries:
    status, _, message = entry.partition("|")
    checks.append({"status": status, "message": message})
payload = {
    "result": "PASS" if int(failures) == 0 else "FAIL",
    "topology": topology,
    "provider": provider,
    "region": region,
    "source": source,
    "generated_at_utc": stamp,
    "secret_values": "not_read",
    "checks": checks,
    "coverage": [
        "provider_topology",
        "dns_tls_intent",
        "security_group_exposure_intent",
        "encrypted_gp3_volume_intent",
        "image_pin_intent",
        "source_checkout_free_deploy",
        "backup_restore_rollback_acknowledgements",
    ],
    "not_covered": [
        "aws_resource_creation",
        "iam_policy_simulation",
        "dns_propagation",
        "caddy_acme_issuance",
        "registry_pull",
        "sops_decrypt",
        "pgbackrest_backup",
        "ebs_snapshot",
        "pitr_restore_rehearsal",
        "live_host_smoke",
    ],
}
with open(out, "w", encoding="utf-8") as f:
    json.dump(payload, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY

  echo "wrote AWS alpha preflight evidence markdown: $markdown"
  echo "wrote AWS alpha preflight evidence json: $json"
}

load_env

topology="$MODE"
if [ "$topology" = "auto" ]; then
  topology="${AWS_ALPHA_TOPOLOGY:-}"
fi

case "$topology" in
  minimum|recommended|split) ;;
  *)
    fail "unknown or missing AWS_ALPHA_TOPOLOGY/mode: ${topology:-<empty>}"
    topology="${topology:-unknown}"
    ;;
esac

require_vars \
  AWS_ALPHA_PROVIDER AWS_REGION AWS_ALPHA_TOPOLOGY AWS_ALPHA_DURATION_DAYS \
  AWS_ALPHA_DOMAIN_ROOT API_DOMAIN REALTIME_DOMAIN TLS_MODE ACME_EMAIL \
  IMAGE_DEPLOY_MODE SOURCE_CHECKOUT_ON_HOST MOMO_IMAGE_TAG MOMO_API_IMAGE MOMO_RELAY_IMAGE MOMO_WORKER_IMAGE MOMO_MIGRATE_IMAGE MOMO_WEB_IMAGE MOMO_LINKSHORT_IMAGE \
  CADDY_PLACEMENT API_PLACEMENT RELAY_PLACEMENT WORKER_PLACEMENT LINKSHORT_PLACEMENT CENTRIFUGO_PLACEMENT REDIS_PLACEMENT POSTGRES_PLACEMENT \
  SECURITY_GROUP_SSH_CIDRS SECURITY_GROUP_HTTP_CIDRS SECURITY_GROUP_HTTPS_CIDRS \
  EXPOSE_POSTGRES EXPOSE_REDIS EXPOSE_CENTRIFUGO EXPOSE_API_DIRECT \
  DB_BACKUP_STRATEGY DB_RESTORE_REHEARSAL_REQUIRED ROLLBACK_STRATEGY

assert_exact AWS_ALPHA_DURATION_DAYS 7
assert_public_domain AWS_ALPHA_DOMAIN_ROOT
assert_public_domain API_DOMAIN
assert_public_domain REALTIME_DOMAIN
assert_email ACME_EMAIL

case "${TLS_MODE:-}" in
  caddy-http-01)
    pass "TLS_MODE uses Caddy HTTP-01"
    case "${SECURITY_GROUP_HTTP_CIDRS:-}" in
      *0.0.0.0/0*|*::/0*) pass "SECURITY_GROUP_HTTP_CIDRS allows ACME HTTP-01 reachability" ;;
      *) fail "caddy-http-01 requires port 80 reachable for ACME, usually 0.0.0.0/0 temporarily or continuously" ;;
    esac
    ;;
  caddy-dns-01)
    pass "TLS_MODE uses Caddy DNS-01"
    ;;
  *)
    fail "TLS_MODE must be caddy-http-01 or caddy-dns-01"
    ;;
esac

assert_no_cidr_anywhere SECURITY_GROUP_SSH_CIDRS
assert_https_cidr SECURITY_GROUP_HTTPS_CIDRS
assert_exact EXPOSE_POSTGRES 0
assert_exact EXPOSE_REDIS 0
assert_exact EXPOSE_CENTRIFUGO 0
assert_exact EXPOSE_API_DIRECT 0

assert_exact IMAGE_DEPLOY_MODE registry-pinned
assert_exact SOURCE_CHECKOUT_ON_HOST 0
assert_release_tag MOMO_IMAGE_TAG
assert_image_pinned MOMO_API_IMAGE
assert_image_pinned MOMO_RELAY_IMAGE
assert_image_pinned MOMO_WORKER_IMAGE
assert_image_pinned MOMO_MIGRATE_IMAGE
assert_image_pinned MOMO_WEB_IMAGE
assert_image_pinned MOMO_LINKSHORT_IMAGE
if [ "${MOMO_IMAGE:-}" != "" ]; then
  assert_image_pinned MOMO_IMAGE
  assert_image_matches_release MOMO_IMAGE
  for momo565_alias in \
    MOMO_API_IMAGE MOMO_RELAY_IMAGE MOMO_WORKER_IMAGE MOMO_MIGRATE_IMAGE \
    MOMO_WEB_IMAGE MOMO_LINKSHORT_IMAGE; do
    if [ "${!momo565_alias}" = "$MOMO_IMAGE" ]; then
      pass "$momo565_alias converges on MOMO_IMAGE"
    else
      fail "$momo565_alias must equal MOMO_IMAGE when the canonical unified image is set"
    fi
  done
else
  pass "MOMO_IMAGE is unset — accepting a legacy six-image environment"
fi
assert_image_matches_release MOMO_API_IMAGE
assert_image_matches_release MOMO_RELAY_IMAGE
assert_image_matches_release MOMO_WORKER_IMAGE
assert_image_matches_release MOMO_MIGRATE_IMAGE
assert_image_matches_release MOMO_WEB_IMAGE
assert_image_matches_release MOMO_LINKSHORT_IMAGE

assert_exact DB_RESTORE_REHEARSAL_REQUIRED 1
assert_exact ROLLBACK_STRATEGY previous-image+snapshot-restore
case "${DB_BACKUP_STRATEGY:-}" in
  *pgbackrest*ebs-snapshot*|*ebs-snapshot*pgbackrest*) pass "DB_BACKUP_STRATEGY includes pgBackRest and EBS snapshot layers" ;;
  *) fail "DB_BACKUP_STRATEGY must include pgBackRest and EBS snapshot layers" ;;
esac

case "${AWS_ALPHA_PROVIDER:-}" in
  ec2)
    require_vars EC2_APP_INSTANCE_TYPE EC2_ROOT_VOLUME_GB EC2_DATA_VOLUME_GB EBS_VOLUME_TYPE EBS_ENCRYPTED IMDSV2_REQUIRED IAM_INSTANCE_PROFILE EBS_SNAPSHOT_RETENTION_DAYS PGBACKREST_RETENTION_FULL S3_BACKUP_BUCKET S3_BACKUP_STORAGE_CLASS
    assert_exact EBS_VOLUME_TYPE gp3
    assert_exact EBS_ENCRYPTED 1
    assert_exact IMDSV2_REQUIRED 1
    assert_int_between EC2_ROOT_VOLUME_GB 20 200
    assert_int_between EC2_DATA_VOLUME_GB 40 2000
    assert_int_between EBS_SNAPSHOT_RETENTION_DAYS 7 14
    assert_int_between PGBACKREST_RETENTION_FULL 2 7
    assert_s3_bucket_name S3_BACKUP_BUCKET
    assert_exact S3_BACKUP_STORAGE_CLASS STANDARD
    ;;
  lightsail)
    require_vars LIGHTSAIL_BUNDLE LIGHTSAIL_SNAPSHOT_RETENTION_DAYS
    assert_int_between LIGHTSAIL_SNAPSHOT_RETENTION_DAYS 7 14
    ;;
  *)
    fail "AWS_ALPHA_PROVIDER must be ec2 or lightsail"
    ;;
esac

case "$topology" in
  minimum)
    case "${AWS_ALPHA_PROVIDER:-}" in
      ec2)
        case "${EC2_APP_INSTANCE_TYPE:-}" in
          t4g.medium|t4g.large|t4g.xlarge) pass "minimum EC2 instance size is acceptable" ;;
          *) fail "minimum EC2 topology should use t4g.medium or larger" ;;
        esac
        ;;
      lightsail)
        case "${LIGHTSAIL_BUNDLE:-}" in
          linux-gp-4gb|linux-gp-8gb|linux-gp-16gb) pass "minimum Lightsail bundle is acceptable" ;;
          *) fail "minimum Lightsail topology should use linux-gp-4gb or larger" ;;
        esac
        ;;
    esac
    assert_placement CADDY_PLACEMENT app-node
    assert_placement API_PLACEMENT app-node
    assert_placement RELAY_PLACEMENT app-node
    assert_placement WORKER_PLACEMENT app-node
    assert_placement CENTRIFUGO_PLACEMENT app-node
    assert_placement REDIS_PLACEMENT app-node
    assert_placement POSTGRES_PLACEMENT app-node
    ;;
  recommended)
    assert_exact AWS_ALPHA_PROVIDER ec2
    case "${EC2_APP_INSTANCE_TYPE:-}" in
      t4g.large|t4g.xlarge|m7g.large|m7g.xlarge) pass "recommended EC2 instance has at least 8 GiB class" ;;
      *) fail "recommended EC2 topology should use t4g.large or larger" ;;
    esac
    if [ "${EC2_DATA_VOLUME_GB:-0}" -ge 100 ] 2>/dev/null; then
      pass "recommended EC2 data volume is at least 100 GB"
    else
      fail "recommended EC2 data volume must be at least 100 GB"
    fi
    assert_placement CADDY_PLACEMENT app-node
    assert_placement API_PLACEMENT app-node
    assert_placement RELAY_PLACEMENT app-node
    assert_placement WORKER_PLACEMENT app-node
    assert_placement CENTRIFUGO_PLACEMENT app-node
    assert_placement REDIS_PLACEMENT app-node
    assert_placement POSTGRES_PLACEMENT app-node
    ;;
  split)
    assert_exact AWS_ALPHA_PROVIDER ec2
    require_vars EC2_DB_INSTANCE_TYPE EC2_DB_VOLUME_GB DB_PRIVATE_SUBNET_REQUIRED DB_SECURITY_GROUP_SOURCE
    assert_int_between EC2_DB_VOLUME_GB 100 4000
    assert_exact DB_PRIVATE_SUBNET_REQUIRED 1
    assert_exact DB_SECURITY_GROUP_SOURCE app-sg
    assert_placement CADDY_PLACEMENT app-node
    assert_placement API_PLACEMENT app-node
    assert_placement RELAY_PLACEMENT app-node
    assert_placement WORKER_PLACEMENT app-node
    assert_placement CENTRIFUGO_PLACEMENT app-node
    assert_placement REDIS_PLACEMENT app-node
    assert_placement POSTGRES_PLACEMENT db-node
    ;;
esac

if [ "$failures" -ne 0 ]; then
  write_evidence
  echo "AWS internal alpha preflight failed ($failures issue(s)): ${ENV_FILE:-process environment}" >&2
  exit 1
fi

write_evidence
pass "AWS internal alpha preflight passed for $topology: ${ENV_FILE:-process environment}"
