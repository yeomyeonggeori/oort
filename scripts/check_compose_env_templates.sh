#!/usr/bin/env bash
# #1250 — every `${VAR:?}` a prod/rust compose file requires must be a filled
# line in the env template(s) that compose file is documented to be rendered
# with.
#
# Four times now the same trap has sprung: a service gained a required variable,
# the env template it ships with did not, and the failure surfaced days later as
# a verifier that had been red since the commit that added the service. The last
# instance (#1246) sat red from 2026-07-24 to 2026-08-10. What every instance
# has in common is that nothing mechanical connected the two files — the link
# lived in whoever remembered to edit both.
#
# `docker compose config` is the runtime truth, but it is a poor guard on its
# own: it stops at the FIRST missing variable, so a template three keys behind
# takes three edit/run cycles to repair, and it only ever checks the one
# rendering somebody happened to run. This script checks every documented
# rendering, reports every missing key at once, and then hands each rendering to
# `docker compose config` anyway so the static reading cannot drift away from
# what compose actually does.
#
# Two traps worth naming, because both have already cost a red:
#   * Interpolation happens BEFORE profile filtering. A service behind
#     `profiles: ["workhost"]` still demands its variables from an operator who
#     will never select that profile.
#   * `${VAR:?}` rejects empty as well as unset. A template line ending in `=`
#     is not a filled key, so this script does not count one.
set -euo pipefail

ROOT=""
SKIP_DOCKER=0

usage() {
  cat <<'EOF'
Usage: scripts/check_compose_env_templates.sh [--root DIR] [--skip-docker]

  --root DIR      Tree to check. Default: the enclosing git worktree root.
  --skip-docker   Static check only. For the regression harness, which needs to
                  exercise the table logic on trees that are deliberately broken.
                  A normal run must not use this: the docker cross-check is what
                  keeps the static reading honest.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    --skip-docker) SKIP_DOCKER=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[compose-env] unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$ROOT" ]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" ||
    { echo "[compose-env] not inside a git worktree; pass --root DIR" >&2; exit 1; }
fi
cd "$ROOT"

# -----------------------------------------------------------------------------
# The table. One row per compose rendering this repository documents, in the
# form `label|env templates|compose files`. A rendering is a command an operator
# or a verifier actually runs, not a hypothetical layering: the sources are
# docs/RUN.md §2.3, docs/DEPLOY.md, infra/rust/README.md §2, the header comment
# of docker-compose.internal-smoke.yml, docs/runbooks/ncp-rust-deploy.md,
# docs/cicd/12-push-relay-deploy-runbook.md and docs/SELF_HOST.md.
#
# Adding a compose file or an env template without adding it here is itself a
# failure — see the two coverage checks at the bottom.
# -----------------------------------------------------------------------------
RENDERINGS=(
  "prod deploy, host env file (docs/DEPLOY.md · infra/prod/install.sh --env-file)|infra/prod/.env.example|infra/prod/docker-compose.prod.yml"
  "prod deploy, SOPS process env (docs/RUN.md §2.3 sops exec-env)|infra/prod/secrets.env.example|infra/prod/docker-compose.prod.yml"
  "internal hosting smoke (scripts/verify_internal_hosting_smoke.sh)|infra/prod/internal-smoke.env.example|infra/prod/docker-compose.prod.yml infra/prod/docker-compose.internal-smoke.yml"
  "rust base stack (infra/rust/README.md §2)|infra/rust/rust-smoke.env.example|infra/rust/docker-compose.rust.yml"
  "rust base + local build (infra/rust/README.md §3)|infra/rust/rust-smoke.env.example|infra/rust/docker-compose.rust.yml infra/rust/docker-compose.rust.build.yml"
  "rust + push path (docs/cicd/12-push-relay-deploy-runbook.md)|infra/rust/rust-smoke.env.example infra/rust/push-relay.env.example|infra/rust/docker-compose.rust.yml infra/rust/docker-compose.push.yml"
  "rust + deploy overlays (docs/runbooks/ncp-rust-deploy.md)|infra/rust/rust-smoke.env.example infra/rust/overlays.env.example|infra/rust/docker-compose.rust.yml infra/rust/t3.override.yml infra/rust/caddy.override.yml infra/rust/cent-origin.override.yml"
  "rust + local edge (docs/SELF_HOST.md)|infra/rust/rust-smoke.env.example|infra/rust/docker-compose.rust.yml infra/rust/local.override.yml"
  "rust + encrypted POSIX backup pre-proof transition (docs/runbooks/pgbackrest-pitr.md)|infra/rust/rust-smoke.env.example infra/rust/backup-preproof.env.example|infra/rust/docker-compose.rust.yml infra/rust/docker-compose.backup.yml"
  "rust + encrypted POSIX backup/PITR signed run (docs/runbooks/pgbackrest-pitr.md)|infra/rust/rust-smoke.env.example infra/rust/backup.env.example infra/rust/pitr-bindings.env.example|infra/rust/docker-compose.rust.yml infra/rust/docker-compose.backup.yml"
  "rust + S3-compatible backup/PITR seam (docs/runbooks/pgbackrest-pitr.md)|infra/rust/rust-smoke.env.example infra/rust/backup.env.example infra/rust/pitr-bindings.env.example infra/rust/pgbackrest-s3.env.example|infra/rust/docker-compose.rust.yml infra/rust/docker-compose.backup.yml infra/rust/pgbackrest.s3.override.yml"
)

# Env templates under infra/prod and infra/rust that are NOT compose env files.
# Anything here is exempt from the table; everything else must be in it.
NON_COMPOSE_ENV_TEMPLATES=(
  # MOMO-233 topology fixture: consumed only by
  # scripts/aws_internal_alpha_preflight.sh --env-file, which reads instance
  # types and CIDRs. It is never handed to docker compose.
  "infra/prod/aws-internal-alpha.env.example"
)

FAILURES=0
CHECKED=0

fail() { echo "[compose-env] FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }

# Variables a compose file demands. Full-line YAML comments are stripped first —
# infra/rust/docker-compose.push.yml documents the `${VAR:?}` idiom in prose and
# that sentence is not a requirement.
required_keys() {
  sed -E 's/^[[:space:]]*#.*$//' "$@" |
    grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*:\?' |
    sed -E 's/^\$\{//; s/:\?$//' |
    LC_ALL=C sort -u
}

# Keys a template actually fills. The `[^[:space:]]` is load-bearing: `${VAR:?}`
# treats an empty value exactly like an absent one, so `KEY=` is not an answer.
assigned_keys() {
  sed -E 's/^[[:space:]]*#.*$//' "$@" |
    grep -E '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]' |
    sed -E 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/' |
    LC_ALL=C sort -u
}

for row in "${RENDERINGS[@]}"; do
  label="${row%%|*}"
  rest="${row#*|}"
  env_files_raw="${rest%%|*}"
  compose_files_raw="${rest#*|}"
  read -r -a env_files <<<"$env_files_raw"
  read -r -a compose_files <<<"$compose_files_raw"

  missing_file=0
  for f in "${env_files[@]}" "${compose_files[@]}"; do
    [ -f "$f" ] || { fail "$label: missing file $f"; missing_file=1; }
  done
  [ "$missing_file" -eq 0 ] || continue

  CHECKED=$((CHECKED + 1))
  missing="$(LC_ALL=C comm -23 \
    <(required_keys "${compose_files[@]}") \
    <(assigned_keys "${env_files[@]}"))"

  if [ -n "$missing" ]; then
    fail "$label"
    echo "  env template(s): ${env_files[*]}" >&2
    while IFS= read -r key; do
      [ -n "$key" ] || continue
      where="$(grep -HnE "\\\$\\{$key:\\?" "${compose_files[@]}" 2>/dev/null |
        grep -vE '^[^:]*:[0-9]+:[[:space:]]*#' | head -1 | cut -d: -f1,2)"
      echo "  - $key   required at ${where:-unknown}" >&2
    done <<<"$missing"
  fi
done

# -----------------------------------------------------------------------------
# Cross-check: hand every rendering to compose itself. The static pass above can
# only be as right as its idea of what `${VAR:?}` means; this pass is the thing
# an operator will actually meet.
# -----------------------------------------------------------------------------
if [ "$SKIP_DOCKER" -eq 0 ]; then
  if ! docker compose version >/dev/null 2>&1; then
    echo "[compose-env] docker compose is unavailable — install Docker Desktop or run with --skip-docker (which weakens this gate to a static read)" >&2
    exit 1
  fi
  for row in "${RENDERINGS[@]}"; do
    label="${row%%|*}"
    rest="${row#*|}"
    read -r -a env_files <<<"${rest%%|*}"
    read -r -a compose_files <<<"${rest#*|}"
    args=()
    for f in "${env_files[@]}"; do args+=(--env-file "$f"); done
    for f in "${compose_files[@]}"; do args+=(-f "$f"); done
    if ! err="$(docker compose "${args[@]}" config 2>&1 >/dev/null)"; then
      fail "$label: docker compose config"
      echo "  $err" >&2
    fi
  done
fi

# -----------------------------------------------------------------------------
# Coverage 1 — no compose file may require a variable from outside the table.
# -----------------------------------------------------------------------------
tabled_compose="$(for row in "${RENDERINGS[@]}"; do
  rest="${row#*|}"; tr ' ' '\n' <<<"${rest#*|}"
done | LC_ALL=C sort -u)"

while IFS= read -r yml; do
  [ -n "$yml" ] || continue
  [ -n "$(required_keys "$yml")" ] || continue
  grep -qxF "$yml" <<<"$tabled_compose" ||
    fail "$yml requires \${VAR:?} but no rendering in this script names it — add a row so its variables are checked against some template"
done < <(find infra -type f \( -name '*.yml' -o -name '*.yaml' \) | LC_ALL=C sort)

# -----------------------------------------------------------------------------
# Coverage 2 — no env template may sit outside the table unexplained.
# -----------------------------------------------------------------------------
tabled_env="$(for row in "${RENDERINGS[@]}"; do
  rest="${row#*|}"; tr ' ' '\n' <<<"${rest%%|*}"
done
printf '%s\n' "${NON_COMPOSE_ENV_TEMPLATES[@]}" | LC_ALL=C sort -u)"

while IFS= read -r tpl; do
  [ -n "$tpl" ] || continue
  grep -qxF "$tpl" <<<"$tabled_env" ||
    fail "$tpl is an env template no rendering uses — add it to a row, or to NON_COMPOSE_ENV_TEMPLATES with the reason it is not a compose env"
done < <(find infra/prod infra/rust -maxdepth 1 -type f -name '*.env.example' | LC_ALL=C sort)

for tpl in "${NON_COMPOSE_ENV_TEMPLATES[@]}"; do
  [ -f "$tpl" ] || fail "NON_COMPOSE_ENV_TEMPLATES names a file that no longer exists: $tpl"
done

if [ "$FAILURES" -ne 0 ]; then
  echo "[compose-env] $FAILURES check(s) failed" >&2
  exit 1
fi

echo "[compose-env] PASS: $CHECKED rendering(s); every \${VAR:?} is filled in its template$([ "$SKIP_DOCKER" -eq 1 ] && echo ' (static only — docker cross-check skipped)')"
