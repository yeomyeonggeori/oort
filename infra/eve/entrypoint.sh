#!/usr/bin/env sh
# MOMO-538: stage the read-only MOMO-534 preset, build it, and start eve.
set -eu

preset_dir=${EVE_PRESET_DIR:-/preset}
runtime_dir=${EVE_RUNTIME_DIR:-/eve-runtime}
port=${EVE_PORT:-28140}

[ -f "$preset_dir/agent/channels/momo.ts" ] || {
  echo "[eve] missing MOMO-534 channel preset at $preset_dir" >&2
  exit 1
}
[ -f "$preset_dir/package-lock.json" ] || {
  echo "[eve] missing pinned preset package-lock.json" >&2
  exit 1
}

rm -rf "$runtime_dir/app"
mkdir -p "$runtime_dir/app"
cp -R "$preset_dir/." "$runtime_dir/app/"
cd "$runtime_dir/app"

npm ci --no-audit --no-fund
eve_version=$(node -p "require('./node_modules/eve/package.json').version")
[ "$eve_version" = "0.27.0" ] || {
  echo "[eve] unexpected eve version: $eve_version" >&2
  exit 1
}

echo "[eve] momo channel preset loaded (eve $eve_version, world=$WORKFLOW_TARGET_WORLD)"
npx --no-install bootstrap
echo "[eve] Postgres world schema ready"
npx --no-install eve build --skip-sandbox-prewarm
exec npx --no-install eve start --host 0.0.0.0 --port "$port"
