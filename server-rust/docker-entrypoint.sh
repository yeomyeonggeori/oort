#!/usr/bin/env sh
# momo Rust image entrypoint — role selection only, no configuration logic.
#
# Contract parity with the Swift image (`infra/prod/docker/momo-entrypoint.sh`):
# the first argument names the role, everything after it is forwarded verbatim,
# and an unknown role is exit 2 rather than a silently wrong process. Each
# binary reads its own environment (nothing is exported here) and `exec` keeps
# PID 1 so compose's SIGTERM reaches the process that must drain.
set -eu

command=${1:-migrate}
if [ "$#" -gt 0 ]; then
  shift
fi

case "$command" in
  api)
    exec /usr/local/bin/momo-server "$@"
    ;;
  relay)
    exec /usr/local/bin/momo-relay "$@"
    ;;
  migrate)
    # Sub-commands (`migrate set-owner`) are the binary's own; this script does
    # not interpret them.
    exec /usr/local/bin/momo-migrate "$@"
    ;;
  set-owner)
    # `docker compose run <service> set-owner` REPLACES the service's
    # `command: ["migrate"]`, so the sub-command arrives here as the role
    # (B1.7 docker-gate 실측). Route it to the migrate binary so the runbook's
    # `run --rm migrate set-owner` invocation works as documented.
    exec /usr/local/bin/momo-migrate set-owner "$@"
    ;;
  *)
    echo "[momo] unknown command: $command" >&2
    echo "usage: momo-rust-entrypoint {api|relay|migrate}" >&2
    exit 2
    ;;
esac
