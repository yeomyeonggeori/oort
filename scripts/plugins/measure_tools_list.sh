#!/usr/bin/env bash
# measure_tools_list.sh <app|google|all> [--probe] [--login]
# Wrapper for measure_tools_list.mjs (Node >= 20, no dependencies). See the header there.
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/measure_tools_list.mjs" "$@"
