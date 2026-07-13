#!/usr/bin/env bash
# Build the source-checkout-free deploy bundle used by the AWS internal alpha.
set -euo pipefail

SOURCE_ROOT=""
OUTPUT=""
STAGE_ROOT=""
OUTPUT_CREATED=0
SUCCESS=0

usage() {
  cat <<'EOF'
Usage: scripts/make_deploy_bundle.sh --output FILE [--source-root DIR]

Packages only the production compose/Caddy/Centrifugo configuration, non-secret
env templates, and operator runbooks. The output is a tar.gz rooted at
`momo-deploy/`.

The packer never includes a source checkout or a populated .env file. Required
inputs must be regular, non-symlink files, and secret-looking values in env
templates fail closed.
EOF
}

fail() {
  echo "[deploy-bundle] FAIL: $*" >&2
  exit 1
}

cleanup() {
  if [ "$STAGE_ROOT" != "" ] && [ -d "$STAGE_ROOT" ]; then
    rm -rf "$STAGE_ROOT"
  fi
  if [ "$OUTPUT_CREATED" = "1" ] && [ "$SUCCESS" != "1" ] && [ -f "$OUTPUT" ]; then
    rm -f "$OUTPUT"
  fi
}
trap cleanup EXIT INT TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source-root)
      SOURCE_ROOT="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT="${2:-}"
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

[ "$OUTPUT" != "" ] || {
  usage >&2
  exit 2
}

if [ "$SOURCE_ROOT" = "" ]; then
  SOURCE_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || \
    fail "must run inside a git repository or pass --source-root"
fi
[ -d "$SOURCE_ROOT" ] || fail "source root does not exist: $SOURCE_ROOT"
SOURCE_ROOT="$(cd "$SOURCE_ROOT" && pwd -P)"

case "$OUTPUT" in
  *.tar.gz) ;;
  *) fail "output must end in .tar.gz: $OUTPUT" ;;
esac

OUTPUT_DIR="$(dirname "$OUTPUT")"
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd -P)"
OUTPUT="$OUTPUT_DIR/$(basename "$OUTPUT")"
[ ! -e "$OUTPUT" ] || fail "refusing to overwrite existing output: $OUTPUT"

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}
need grep
need cmp
need install
need mktemp
need sort
need tar

SOURCE_PATHS=(
  "infra/prod/docker-compose.prod.yml"
  "infra/prod/Caddyfile"
  "infra/prod/centrifugo.prod.json"
  "infra/prod/aws-internal-alpha.env.example"
  "infra/prod/secrets.env.example"
  "docs/runbooks/aws-internal-alpha-deploy.md"
  "docs/runbooks/internal-alpha-onboarding.md"
)
DEST_PATHS=(
  "momo-deploy/docker-compose.prod.yml"
  "momo-deploy/Caddyfile"
  "momo-deploy/centrifugo.prod.json"
  "momo-deploy/templates/aws-internal-alpha.env.example"
  "momo-deploy/templates/prod.env.example"
  "momo-deploy/runbooks/aws-internal-alpha-deploy.md"
  "momo-deploy/runbooks/internal-alpha-onboarding.md"
)

validate_input() {
  local relative="$1"
  local absolute="$SOURCE_ROOT/$relative"
  [ -f "$absolute" ] || fail "missing required input: $relative"
  [ ! -L "$absolute" ] || fail "required input must not be a symlink: $relative"
}

validate_env_template() {
  local relative="$1"
  local line key value

  while IFS= read -r line || [ "$line" != "" ]; do
    case "$line" in
      ''|'#'*) continue ;;
      *=*) ;;
      *) fail "invalid env template line in $relative: $line" ;;
    esac

    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || fail "invalid env key in $relative: $key"
    case "$key" in
      SECRET_SOURCE)
        continue
        ;;
    esac

    if [[ "$key" =~ (PASSWORD|DATABASE_URL|REDIS_ADDRESS|HMAC|API_KEY|PROXY_SECRET|CIPHER_PASS|ACCESS_KEY|SECRET_KEY|BEARER|TOKEN)$ ]]; then
      if [[ ! "$value" =~ __[A-Z0-9_]+__ ]] && [[ ! "$value" =~ ^change-me-[a-z0-9-]+$ ]]; then
        fail "secret-looking key has a non-placeholder value in $relative: $key"
      fi
    fi
  done < "$SOURCE_ROOT/$relative"
}

for relative in "${SOURCE_PATHS[@]}"; do
  validate_input "$relative"
done
validate_env_template "infra/prod/aws-internal-alpha.env.example"
validate_env_template "infra/prod/secrets.env.example"

grep -Fq '"X-Centrifugo-Proxy-Secret": "change-me-cent-proxy-secret"' \
  "$SOURCE_ROOT/infra/prod/centrifugo.prod.json" || \
  fail "Centrifugo config must contain only the committed proxy-secret placeholder"

# shellcheck disable=SC2016 # Compose placeholders must remain literal.
for compose_placeholder in \
  'POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}' \
  'REDIS_PASSWORD: ${REDIS_PASSWORD:?set REDIS_PASSWORD}' \
  'CENT_TOKEN_HMAC: ${CENT_TOKEN_HMAC:?set CENT_TOKEN_HMAC}' \
  'CENT_API_KEY: ${CENT_API_KEY:?set CENT_API_KEY}' \
  'JWT_HMAC: ${JWT_HMAC:?set JWT_HMAC}' \
  'HERMES_API_KEY: ${HERMES_API_KEY:?set HERMES_API_KEY}'
do
  grep -Fq "$compose_placeholder" "$SOURCE_ROOT/infra/prod/docker-compose.prod.yml" || \
    fail "compose secret must remain env-injected: ${compose_placeholder%%:*}"
done

STAGE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/momo-deploy-bundle.XXXXXX")"
mkdir -p "$STAGE_ROOT/momo-deploy/templates" "$STAGE_ROOT/momo-deploy/runbooks"

index=0
while [ "$index" -lt "${#SOURCE_PATHS[@]}" ]; do
  source_path="${SOURCE_PATHS[$index]}"
  dest_path="${DEST_PATHS[$index]}"
  install -m 0644 "$SOURCE_ROOT/$source_path" "$STAGE_ROOT/$dest_path"
  index=$((index + 1))
done

# These patterns should never occur in an operator artifact. Placeholders such
# as __OPENSSL_RAND_HEX_32__ and change-me-* remain allowed in the templates.
if LC_ALL=C grep -ERq -- \
  '-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}' \
  "$STAGE_ROOT/momo-deploy"; then
  fail "bundle input contains a private key or token-shaped value"
fi

ACTUAL_LIST="$STAGE_ROOT/archive-list.actual"
EXPECTED_LIST="$STAGE_ROOT/archive-list.expected"
cat > "$EXPECTED_LIST" <<'EOF'
momo-deploy/
momo-deploy/Caddyfile
momo-deploy/centrifugo.prod.json
momo-deploy/docker-compose.prod.yml
momo-deploy/runbooks/
momo-deploy/runbooks/aws-internal-alpha-deploy.md
momo-deploy/runbooks/internal-alpha-onboarding.md
momo-deploy/templates/
momo-deploy/templates/aws-internal-alpha.env.example
momo-deploy/templates/prod.env.example
EOF

umask 077
OUTPUT_CREATED=1
tar -czf "$OUTPUT" -C "$STAGE_ROOT" momo-deploy
tar -tzf "$OUTPUT" | LC_ALL=C sort > "$ACTUAL_LIST"
LC_ALL=C sort "$EXPECTED_LIST" -o "$EXPECTED_LIST"

if ! cmp -s "$EXPECTED_LIST" "$ACTUAL_LIST"; then
  rm -f "$OUTPUT"
  fail "archive contains a path outside the deploy allowlist"
fi

SUCCESS=1
echo "[deploy-bundle] PASS: $OUTPUT"
echo "[deploy-bundle] contents: ${#SOURCE_PATHS[@]} allowlisted files; no source checkout or populated .env"
