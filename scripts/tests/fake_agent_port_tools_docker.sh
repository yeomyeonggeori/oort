#!/usr/bin/env bash
set -euo pipefail
: "${FAKE_DOCKER_STATE:?}"
: "${FAKE_DOCKER_ID:?}"
command_name="${1:-}"
shift || true
case "$command_name" in
  inspect)
    [ ! -e "$FAKE_DOCKER_STATE/inspect_error" ] || exit 1
    [ -e "$FAKE_DOCKER_STATE/present" ] || exit 1
    format=''
    if [ "${1:-}" = "--format" ]; then format="$2"; shift 2; fi
    case "$format" in
      '{{.Id}}') printf '%s\n' "$FAKE_DOCKER_ID" ;;
      *) printf '%s|/%s|%s\n' "$FAKE_DOCKER_ID" "$FAKE_DOCKER_NAME" "$FAKE_DOCKER_NONCE" ;;
    esac
    ;;
  ps)
    [ ! -e "$FAKE_DOCKER_STATE/list_error" ] || exit 1
    if [ -e "$FAKE_DOCKER_STATE/present" ]; then printf '%s\n' "$FAKE_DOCKER_ID"; fi
    exit 0
    ;;
  rm)
    [ ! -e "$FAKE_DOCKER_STATE/remove_error" ] || exit 1
    [ -e "$FAKE_DOCKER_STATE/remove_lie" ] || rm -f "$FAKE_DOCKER_STATE/present"
    ;;
  *) exit 2 ;;
esac
