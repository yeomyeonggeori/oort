#!/usr/bin/env sh
set -eu

command=${1:-migrate}
if [ "$#" -gt 0 ]; then
  shift
fi

case "$command" in
  api)
    exec /usr/local/bin/MomoServer "$@"
    ;;
  relay)
    exec /usr/local/bin/OutboxRelay "$@"
    ;;
  worker)
    exec /usr/local/bin/AgentWorker "$@"
    ;;
  linkshort)
    exec /usr/local/bin/LinkShort "$@"
    ;;
  migrate)
    exec /usr/local/bin/internal-smoke-migrate "$@"
    ;;
  web-assets)
    [ "$#" -eq 0 ] || {
      echo "[momo] web-assets does not accept arguments" >&2
      exit 2
    }
    rm -rf /srv/momo-web/* /srv/momo-web/.[!.]* /srv/momo-web/..?* 2>/dev/null || true
    cp -a /opt/momo-web/. /srv/momo-web/
    ;;
  *)
    echo "[momo] unknown command: $command" >&2
    echo "usage: momo-entrypoint {api|relay|worker|migrate|linkshort|web-assets}" >&2
    exit 2
    ;;
esac
