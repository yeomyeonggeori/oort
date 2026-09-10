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
# Three traps worth naming, because each has already cost a red:
#   * Interpolation happens BEFORE profile filtering. A service behind
#     `profiles: ["workhost"]` still demands its variables from an operator who
#     will never select that profile — when the requirement is a compose
#     interpolation (`${VAR:?}`).
#   * `${VAR:?}` rejects empty as well as unset. A template line ending in `=`
#     is not a filled key, so this script does not count one.
#   * `$${VAR:?}` is NOT compose interpolation. Compose turns `$$` into a
#     literal `$` and hands `${VAR:?}` to the container shell. The huddle
#     LiveKit entrypoint uses this form so an unselected profile never
#     demands secrets (#1781). This script must not treat the escaped form
#     as a template requirement. Empty `KEY=` is then correct for those
#     keys: they are optional at compose time (`${VAR:-}`) and hard-required
#     only inside the selected container.
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
# infra/rust/README.md §2, docs/cicd/12-push-relay-deploy-runbook.md,
# docs/runbooks/pgbackrest-pitr.md, docs/SELF_HOST.md and
# docs/SELF_HOST_AGENT.md §3.3.0. Retired
# f399e417:infra/prod renderings and the NCP overlay row are out of this
# gate (#2142 / ADR-0183).
#
# Adding a compose file or an env template without adding it here is itself a
# failure — see the coverage checks at the bottom (1 · 1b · 2 · 3). Platform
# templates that are not compose renderings have their own table below.
# -----------------------------------------------------------------------------
RENDERINGS=(
  "rust base stack (infra/rust/README.md §2)|infra/rust/rust-smoke.env.example|infra/rust/docker-compose.rust.yml"
  "rust base + local build (infra/rust/README.md §3)|infra/rust/rust-smoke.env.example|infra/rust/docker-compose.rust.yml infra/rust/docker-compose.rust.build.yml"
  "rust + push path (docs/cicd/12-push-relay-deploy-runbook.md)|infra/rust/rust-smoke.env.example infra/rust/push-relay.env.example|infra/rust/docker-compose.rust.yml infra/rust/docker-compose.push.yml"
  "rust + public-edge overlays (infra/rust caddy/t3/cent-origin)|infra/rust/rust-smoke.env.example infra/rust/overlays.env.example|infra/rust/docker-compose.rust.yml infra/rust/t3.override.yml infra/rust/caddy.override.yml infra/rust/cent-origin.override.yml"
  "rust + local edge (docs/SELF_HOST.md)|infra/rust/rust-smoke.env.example|infra/rust/docker-compose.rust.yml infra/rust/local.override.yml"
  "rust + host-network overlay (docs/SELF_HOST_AGENT.md §3.3.0)|infra/rust/rust-smoke.env.example|infra/rust/docker-compose.rust.yml infra/rust/local.override.yml infra/rust/docker-compose.host-network.yml"
  "rust + encrypted POSIX backup pre-proof transition (docs/runbooks/pgbackrest-pitr.md)|infra/rust/rust-smoke.env.example infra/rust/backup-preproof.env.example|infra/rust/docker-compose.rust.yml infra/rust/docker-compose.backup.yml"
  "rust + encrypted POSIX backup/PITR signed run (docs/runbooks/pgbackrest-pitr.md)|infra/rust/rust-smoke.env.example infra/rust/backup.env.example infra/rust/pitr-bindings.env.example|infra/rust/docker-compose.rust.yml infra/rust/docker-compose.backup.yml"
  "rust + S3-compatible backup/PITR seam (docs/runbooks/pgbackrest-pitr.md)|infra/rust/rust-smoke.env.example infra/rust/backup.env.example infra/rust/pitr-bindings.env.example infra/rust/pgbackrest-s3.env.example|infra/rust/docker-compose.rust.yml infra/rust/docker-compose.backup.yml infra/rust/pgbackrest.s3.override.yml"
)

# Env templates under infra/rust that are NOT compose env files in this table.
# Anything here is exempt from the table; everything else must be in it.
NON_COMPOSE_ENV_TEMPLATES=()

# -----------------------------------------------------------------------------
# Platform templates (non-compose) — ADR-0184 D5 / #2297.
#
# A managed platform (Railway today; Fly/AWS rows arrive with SH-11b/c) ships
# its deployment as a service catalog + edge file + image recipe, not as a
# compose rendering. Those files sit outside the RENDERINGS table by nature,
# and until #2297 the only record of that was a prose note inside
# infra/railway/railway.json ("Not a docker-compose rendering …") — an
# exemption nothing checked. This table makes the exemption explicit and
# bounded. One row per platform directory, `directory|contract|files`:
#   * `contract` is the test that actually exercises the row; it runs in
#     scripts/local_gate.sh's docs profile, so this script only checks that it
#     still exists and is executable (on a tree that carries scripts/tests).
#   * `files` is the COMPLETE inventory of the directory. Coverage 3 below
#     enforces both directions: a listed file that disappears is red, and a
#     file that appears in the directory without a listing is red — so a
#     compose file or env template dropped into infra/<platform>/ cannot hide
#     behind the platform's exemption. An infra/ directory that carries
#     deployment material without a row here is red as well.
# -----------------------------------------------------------------------------
PLATFORM_TEMPLATES=(
  "infra/railway|scripts/tests/test_railway_template.sh|infra/railway/README.md infra/railway/railway.json infra/railway/Caddyfile.railway infra/railway/Dockerfile.caddy"
)

# Compose-shaped files under infra/ that no rendering row names, with the
# reason. A compose file is a rendering until proven otherwise: everything
# compose-shaped that is neither tabled nor listed here is red (Coverage 1b),
# whether or not it happens to contain a `${VAR:?}` today.
COMPOSE_FILES_OUTSIDE_TABLE=(
  "infra/rust/docker-compose.lane-phone.yml|MAESTRO-1 phone lane overlay (#1022): rendered only by clients/mobile/scripts/lane-phone.sh with an env file it generates at run time — no operator template to check it against — and it declares no \${VAR:?}"
)

FAILURES=0
CHECKED=0

fail() { echo "[compose-env] FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }

# Variables a compose file demands. Full-line YAML comments are stripped first —
# infra/rust/docker-compose.push.yml documents the `${VAR:?}` idiom in prose and
# that sentence is not a requirement. `$${VAR:?}` is stripped next: compose
# does not interpolate it (the first `$` escapes the second), so it is a
# container-shell check, not an operator-template requirement (#1781).
required_keys() {
  sed -E 's/^[[:space:]]*#.*$//' "$@" |
    sed -E 's/\$\$\{/__COMPOSE_ESCAPED_{/g' |
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
      where="$(grep -HnE '(^|[^$])\$\{'"$key"':\?' "${compose_files[@]}" 2>/dev/null |
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
# Coverage 1b — no compose-shaped file may sit outside the table unexplained,
# `${VAR:?}` or not (#2297). A compose file without a required variable today
# is one edit away from having one, and Coverage 1 would only notice then.
# -----------------------------------------------------------------------------
exempt_compose="$(for row in "${COMPOSE_FILES_OUTSIDE_TABLE[@]}"; do printf '%s\n' "${row%%|*}"; done | LC_ALL=C sort -u)"
while IFS= read -r yml; do
  [ -n "$yml" ] || continue
  grep -qxF "$yml" <<<"$tabled_compose" && continue
  grep -qxF "$yml" <<<"$exempt_compose" && continue
  fail "$yml is compose-shaped but no rendering in this script names it — add a row, or add it to COMPOSE_FILES_OUTSIDE_TABLE with the reason it is not an operator rendering"
done < <(find infra -type f \( -name 'docker-compose*.yml' -o -name 'docker-compose*.yaml' -o -name 'compose*.yml' -o -name 'compose*.yaml' -o -name '*.override.yml' -o -name '*.override.yaml' \) | LC_ALL=C sort)
for row in "${COMPOSE_FILES_OUTSIDE_TABLE[@]}"; do
  yml="${row%%|*}"
  [ -f "$yml" ] || fail "COMPOSE_FILES_OUTSIDE_TABLE names a file that no longer exists: $yml"
done

# -----------------------------------------------------------------------------
# Coverage 2 — no env template may sit outside the table unexplained.
# -----------------------------------------------------------------------------
tabled_env="$(
{
  for row in "${RENDERINGS[@]}"; do
    rest="${row#*|}"; tr ' ' '\n' <<<"${rest%%|*}"
  done
  if [ "${#NON_COMPOSE_ENV_TEMPLATES[@]}" -gt 0 ]; then
    printf '%s\n' "${NON_COMPOSE_ENV_TEMPLATES[@]}"
  fi
} | LC_ALL=C sort -u
)"

while IFS= read -r tpl; do
  [ -n "$tpl" ] || continue
  grep -qxF "$tpl" <<<"$tabled_env" ||
    fail "$tpl is an env template no rendering uses — add it to a row, or to NON_COMPOSE_ENV_TEMPLATES with the reason it is not a compose env"
done < <(find infra/rust -maxdepth 1 -type f -name '*.env.example' | LC_ALL=C sort)

if [ "${#NON_COMPOSE_ENV_TEMPLATES[@]}" -gt 0 ]; then
  for tpl in "${NON_COMPOSE_ENV_TEMPLATES[@]}"; do
    [ -f "$tpl" ] || fail "NON_COMPOSE_ENV_TEMPLATES names a file that no longer exists: $tpl"
  done
fi

# -----------------------------------------------------------------------------
# Coverage 3 — platform template rows are complete inventories (#2297), and
# every infra/ directory that carries deployment material is either infra/rust
# (the RENDERINGS domain) or a PLATFORM_TEMPLATES row.
# -----------------------------------------------------------------------------
PLATFORM_ROWS=0
platform_dirs="$(for row in "${PLATFORM_TEMPLATES[@]}"; do printf '%s\n' "${row%%|*}"; done | LC_ALL=C sort -u)"
for row in "${PLATFORM_TEMPLATES[@]}"; do
  dir="${row%%|*}"
  rest="${row#*|}"
  contract="${rest%%|*}"
  read -r -a listed <<<"${rest#*|}"
  PLATFORM_ROWS=$((PLATFORM_ROWS + 1))

  [ -d "$dir" ] || { fail "$dir: PLATFORM_TEMPLATES names a directory that does not exist"; continue; }
  for f in "${listed[@]}"; do
    [ -f "$f" ] || fail "$dir: PLATFORM_TEMPLATES names a file that no longer exists: $f"
  done
  # The contract lives under scripts/tests; regression fixtures hand this
  # script an infra/-only tree, so the check is conditional on the tree
  # carrying scripts/tests at all — and says so when it is not.
  if [ -d scripts/tests ]; then
    [ -f "$contract" ] && [ -x "$contract" ] ||
      fail "$dir: platform contract test $contract is missing or not executable — the row's exemption from the compose table rests on that test running in the docs profile"
  else
    echo "[compose-env] note: $dir contract $contract not checked — this tree carries no scripts/tests (fixture tree)"
  fi
  listed_lines="$(printf '%s\n' "${listed[@]}")"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    grep -qxF "$f" <<<"$listed_lines" ||
      fail "$f sits in platform directory $dir but PLATFORM_TEMPLATES does not list it — a platform row is a complete inventory, so a new compose file or env template cannot hide behind the platform exemption; list it there (or table it as a rendering)"
  done < <(find "$dir" -type f | LC_ALL=C sort)
done

while IFS= read -r dir; do
  [ -n "$dir" ] || continue
  [ "$dir" = "infra/rust" ] && continue
  grep -qxF "$dir" <<<"$platform_dirs" && continue
  material="$(find "$dir" -type f \( -name 'docker-compose*.y*ml' -o -name 'compose*.y*ml' -o -name '*.override.y*ml' -o -name '*.env.example' -o -name 'Caddyfile*' -o -name 'railway.json' -o -name 'fly.toml' -o -name '*.tf' \) | LC_ALL=C sort | tr '\n' ' ')"
  [ -z "$material" ] ||
    fail "$dir carries deployment templates but is neither infra/rust nor a PLATFORM_TEMPLATES row: ${material% }— add a row naming its contract test and its complete file list"
done < <(find infra -mindepth 1 -maxdepth 1 -type d | LC_ALL=C sort)

if [ "$FAILURES" -ne 0 ]; then
  echo "[compose-env] $FAILURES check(s) failed" >&2
  exit 1
fi

echo "[compose-env] PASS: $CHECKED rendering(s); every \${VAR:?} is filled in its template$([ "$SKIP_DOCKER" -eq 1 ] && echo ' (static only — docker cross-check skipped)'); $PLATFORM_ROWS platform template row(s) complete; ${#COMPOSE_FILES_OUTSIDE_TABLE[@]} compose file(s) exempt by reason"
