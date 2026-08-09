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
  agent-worker)
    # The agent turn loop (B5.1). Its outbound HTTP to the LLM provider is the
    # binary's purpose; it still calls no momo-server and publishes to no
    # Centrifugo — the reply travels the message write path like any other.
    exec /usr/local/bin/momo-agent-worker "$@"
    ;;
  notifier)
    # The durability + notification worker (B2.3 + P2). Both of its opt-in loops
    # are default-off: T3 needs MOMO_T3_ENABLED=1, the ADR-0120 push drain needs
    # MOMO_PUSH_NOTIFIER_ENABLED=1 plus a relay signing key. It holds no APNs
    # credential — dispatches go to the push relay, never to Apple.
    exec /usr/local/bin/momo-notifier "$@"
    ;;
  migrate)
    # Sub-commands (`migrate set-owner`) are the binary's own; this script does
    # not interpret them.
    exec /usr/local/bin/momo-migrate "$@"
    ;;
  web-assets)
    # The SPA staging one-shot (#1228). Same contract as the Swift image's
    # `web-assets` (infra/prod/docker/momo-entrypoint.sh:25): copy the bundled
    # dist into the volume Caddy serves, then exit. It is not a server — no
    # momo binary ever hands out browser assets.
    [ "$#" -eq 0 ] || {
      echo "[momo] web-assets does not accept arguments" >&2
      exit 2
    }
    # REPLACE, not merge. A downgrade must not leave a newer content-hashed
    # chunk behind for the older index.html to never reference — the volume has
    # to be exactly one build. The globs are guarded because `set -eu` plus a
    # non-matching glob would abort on an already-empty volume.
    rm -rf /srv/web/* /srv/web/.[!.]* /srv/web/..?* 2>/dev/null || true
    cp -a /opt/momo/web/. /srv/web/
    echo "[momo] web-assets staged $(find /srv/web -type f | wc -l) files into /srv/web"
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
    echo "usage: momo-rust-entrypoint {api|relay|agent-worker|notifier|migrate|web-assets}" >&2
    exit 2
    ;;
esac
