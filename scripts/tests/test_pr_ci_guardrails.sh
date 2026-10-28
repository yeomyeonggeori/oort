#!/usr/bin/env bash
# Static contract for the PR trigger, retired web-legacy lane absence, and stable
# required context. ADR-0183 / #2142: the OpenAPI ↔ web-legacy generated-contract
# job must stay gone — restoring it turns this red. actionlint is the semantic
# YAML validator; these checks name the exact policy strings that must not
# quietly disappear in a later refactor.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/pr-ci.yml"
MONITOR="$REPO_ROOT/.github/workflows/track-alignment.yml"

fail() {
  echo "[pr-ci-guard-test] FAIL: $*" >&2
  exit 1
}

job_block() {
  local workflow="$1"
  local job="$2"
  awk -v marker="  ${job}:" '
    $0 == marker { active = 1 }
    active && $0 ~ /^  [[:alnum:]_-]+:$/ && $0 != marker { exit }
    active { print }
  ' "$workflow"
}

extract_change_filter() {
  local workflow="$1"
  awk '
    $0 == "      - id: filter" { saw_filter = 1; next }
    saw_filter && $0 == "        run: |" { in_script = 1; next }
    in_script && $0 == "" { print; next }
    in_script && substr($0, 1, 10) == "          " {
      print substr($0, 11)
      next
    }
    in_script { exit }
  ' "$workflow"
}

gitleaks_job_compliant() {
  local gitleaks="$1"
  [ -n "$gitleaks" ] || return 1
  grep -Fq '    name: gitleaks secret scan' <<<"$gitleaks" || return 1
  grep -Fq 'fetch-depth: 0' <<<"$gitleaks" || return 1
  grep -Fq 'persist-credentials: false' <<<"$gitleaks" || return 1
  grep -Fq 'GITLEAKS_VERSION: 8.30.1' <<<"$gitleaks" || return 1
  grep -Fq '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb' <<<"$gitleaks" || return 1
  grep -Fq 'sha256sum -c' <<<"$gitleaks" || return 1
  grep -Fq 'gitleaks is not installed' <<<"$gitleaks" || return 1
  grep -Fq 'missing triage baseline: .gitleaksignore' <<<"$gitleaks" || return 1
  grep -Fq -- '--gitleaks-ignore-path .gitleaksignore' <<<"$gitleaks" || return 1
  grep -Fq 'log_opts="${BASE_SHA}..${HEAD_SHA}"' <<<"$gitleaks" || return 1
  grep -Fq -- '--log-opts "$log_opts"' <<<"$gitleaks" || return 1
  grep -Fq 'log_opts="-1"' <<<"$gitleaks" || return 1
  grep -Fq -- '--redact=90' <<<"$gitleaks" || return 1
  grep -Fq 'gitleaks detect' <<<"$gitleaks" || return 1
  grep -Fq 'EVENT_NAME: ${{ github.event_name }}' <<<"$gitleaks" || return 1
  grep -Fq 'BASE_SHA: ${{ github.event.pull_request.base.sha }}' <<<"$gitleaks" || return 1
  grep -Fq 'HEAD_SHA: ${{ github.event.pull_request.head.sha }}' <<<"$gitleaks" || return 1
  grep -Fq 'gitleaks/releases/download/v${GITLEAKS_VERSION}/' <<<"$gitleaks" || return 1
  if grep -Fq -- '--all' <<<"$gitleaks"; then
    return 1
  fi
  if grep -Fq -- '--no-git' <<<"$gitleaks"; then
    return 1
  fi
  if grep -Fq -- '--report-path' <<<"$gitleaks"; then
    return 1
  fi
  if grep -Fq 'continue-on-error' <<<"$gitleaks"; then
    return 1
  fi
  if grep -Fq 'gitleaks/gitleaks-action' <<<"$gitleaks"; then
    return 1
  fi
  if grep -Fq 'GITLEAKS_LICENSE' <<<"$gitleaks"; then
    return 1
  fi
  if grep -Fq '    if:' <<<"$gitleaks"; then
    return 1
  fi
  if grep -Fq 'needs:' <<<"$gitleaks"; then
    return 1
  fi
  return 0
}

advisories_job_compliant() {
  local advisories="$1"
  [ -n "$advisories" ] || return 1
  grep -Fq '    name: dependency advisory gate' <<<"$advisories" || return 1
  grep -Fq 'persist-credentials: false' <<<"$advisories" || return 1
  grep -Fq 'tool: cargo-deny@0.20.2' <<<"$advisories" || return 1
  grep -Fq 'OSV_VERSION: 2.7.0' <<<"$advisories" || return 1
  grep -Fq 'OSV_SHA256: 160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b' <<<"$advisories" || return 1
  grep -Fq 'sha256sum -c -' <<<"$advisories" || return 1
  grep -Fq 'osv-scanner/releases/download/v${OSV_VERSION}/' <<<"$advisories" || return 1
  # The real scan is the whole gate (no --only), and the negative controls run after it.
  grep -Fq '        run: python3 scripts/check_advisories.py' <<<"$advisories" || return 1
  grep -Fq '        run: bash scripts/tests/test_advisory_gate.sh --online' <<<"$advisories" || return 1
  # Always on: a new advisory appears without any lockfile change, and a gate that
  # is path-filtered, soft, or waits on another lane would let it through.
  if grep -Fq '    if:' <<<"$advisories"; then
    return 1
  fi
  if grep -Fq 'needs:' <<<"$advisories"; then
    return 1
  fi
  if grep -Fq 'continue-on-error' <<<"$advisories"; then
    return 1
  fi
  if grep -Fq -- '--only' <<<"$advisories"; then
    return 1
  fi
  return 0
}

# #4696: the Node lane is one job per tree and the gate-script regression fixtures
# are a path-selected `policy` job. These helpers pin the parts of that structure
# that decide whether a check can silently stop running. The anchors are exact
# lines (grep -x), so a comment or a longer command that merely contains the text
# cannot satisfy them.
alignment_job_compliant() {
  local alignment="$1"
  [ -n "$alignment" ] || return 1
  grep -Fq 'git show "origin/main:scripts/check_track_alignment.sh"' <<<"$alignment" || return 1
  grep -Fq '915d00bff14fda55b909fcdda72067e3d480dbda|27718c0e68715ae44fc65cdb632e70b8a347ea7c|38587b53c088049e42f9fba1f8d0118985523faf)' \
    <<<"$alignment" || return 1
  # Repo-state check, not a gate-script regression: lockfile hashes and the
  # Dockerfile COPY list can break on a PR no path filter would connect to it.
  grep -Fxq '        run: scripts/check_ghcr_notice_bundle.sh --stale-only' <<<"$alignment" || return 1
  # Always on, like gitleaks: the gate requires `success`, never `skipped`.
  if grep -Fq '    if:' <<<"$alignment"; then
    return 1
  fi
  if grep -Fq 'needs:' <<<"$alignment"; then
    return 1
  fi
  return 0
}

policy_job_compliant() {
  local policy="$1" fixture
  [ -n "$policy" ] || return 1
  grep -Fxq "    if: needs.changes.outputs.policy == 'true'" <<<"$policy" || return 1
  grep -Fxq '    needs: changes' <<<"$policy" || return 1
  for fixture in \
    test_track_alignment_guard \
    test_pr_ci_guardrails \
    test_github_track_guardrails \
    test_policy_integrity_gate \
    test_trusted_policy_runner \
    test_ghcr_notice_bundle; do
    grep -Fxq "          scripts/tests/${fixture}.sh" <<<"$policy" || return 1
  done
  if grep -Eq 'continue-on-error|\|\| *true' <<<"$policy"; then
    return 1
  fi
  return 0
}

node_jobs_compliant() {
  local node_core="$1" node_web="$2" node_mobile="$3" node_job
  for node_job in "$node_core" "$node_web" "$node_mobile"; do
    [ -n "$node_job" ] || return 1
    grep -Fxq "    if: needs.changes.outputs.node == 'true'" <<<"$node_job" || return 1
    grep -Fxq '    needs: changes' <<<"$node_job" || return 1
    # web and mobile consume @momo/core by path, whose third-party dependencies
    # resolve from the root node_modules: every tree's job installs the root first.
    grep -Fxq '        run: npm ci' <<<"$node_job" || return 1
    # #1635: G3 (#1267/#1268) retired the node-lane bandages. vitest test.env is
    # the TZ SoT — a runner TZ pin hides UTC-host local failures. inboxApproval
    # is in the suite, not excluded by filename.
    if grep -Fq 'TZ: Asia/Seoul' <<<"$node_job"; then
      return 1
    fi
    if grep -Fq 'testPathIgnorePatterns' <<<"$node_job"; then
      return 1
    fi
    if grep -Fq 'inboxApproval' <<<"$node_job"; then
      return 1
    fi
    if grep -Eq 'continue-on-error|\|\| *true' <<<"$node_job"; then
      return 1
    fi
  done
  grep -Fxq '        run: node scripts/check_npm_licenses.mjs' <<<"$node_core" || return 1
  grep -Fxq '        run: npm run typecheck --workspace @momo/core' <<<"$node_core" || return 1
  grep -Fxq '        run: npm run test --workspace @momo/core' <<<"$node_core" || return 1
  grep -Fxq '        run: npm --prefix clients/web run typecheck' <<<"$node_web" || return 1
  grep -Fxq '        run: npm --prefix clients/web run test' <<<"$node_web" || return 1
  grep -Fxq '        run: npm --prefix clients/mobile run typecheck' <<<"$node_mobile" || return 1
  grep -Fxq '        run: npm --prefix clients/mobile run test' <<<"$node_mobile" || return 1
  return 0
}

# shellcheck disable=SC2016 # Literal workflow shell contracts, not expansions.
gate_job_compliant() {
  local gate="$1" dependency wiring
  [ -n "$gate" ] || return 1
  for dependency in changes alignment gitleaks advisories policy rust security_pack node_core node_web node_mobile; do
    grep -Fxq "      - $dependency" <<<"$gate" || return 1
  done
  if grep -Fq "      - contract" <<<"$gate"; then
    return 1
  fi
  # The single `node` job no longer exists; a leftover dependency on it would
  # make the gate wait for a job nobody defines.
  if grep -Fxq "      - node" <<<"$gate"; then
    return 1
  fi
  # Every *_RESULT env var reads its OWN job, as an exact line. A result wired to a
  # neighbour (NODE_WEB_RESULT from node_core, say) keeps the job in `needs` and the
  # require_optional_lane line in place, yet lets that job fail unseen (#4696).
  for wiring in \
    CHANGES_RESULT:changes ALIGNMENT_RESULT:alignment GITLEAKS_RESULT:gitleaks \
    ADVISORIES_RESULT:advisories POLICY_RESULT:policy RUST_RESULT:rust \
    SECURITY_PACK_RESULT:security_pack NODE_CORE_RESULT:node_core \
    NODE_WEB_RESULT:node_web NODE_MOBILE_RESULT:node_mobile; do
    grep -Fxq "      ${wiring%%:*}: \${{ needs.${wiring#*:}.result }}" <<<"$gate" || return 1
  done
  grep -Fq "      POLICY_SELECTED: \${{ needs.changes.outputs.policy }}" <<<"$gate" || return 1
  grep -Fq "      RUST_SELECTED: \${{ needs.changes.outputs.rust }}" <<<"$gate" || return 1
  grep -Fq "      NODE_SELECTED: \${{ needs.changes.outputs.node }}" <<<"$gate" || return 1
  grep -Fq '    if: always()' <<<"$gate" || return 1
  grep -Fq 'test "$CHANGES_RESULT" = success' <<<"$gate" || return 1
  grep -Fq 'test "$ALIGNMENT_RESULT" = success' <<<"$gate" || return 1
  grep -Fq 'test "$GITLEAKS_RESULT" = success' <<<"$gate" || return 1
  grep -Fq 'test "$ADVISORIES_RESULT" = success' <<<"$gate" || return 1
  grep -Fq 'true:success|false:skipped) ;;' <<<"$gate" || return 1
  grep -Fq 'lane selection/result mismatch:' <<<"$gate" || return 1
  # Every optional lane's result is checked against its own selection output: a
  # selected lane that was skipped (or an unselected one that ran) is red.
  grep -Fxq '          require_optional_lane "$POLICY_SELECTED" "$POLICY_RESULT" policy' <<<"$gate" || return 1
  grep -Fxq '          require_optional_lane "$RUST_SELECTED" "$RUST_RESULT" rust' <<<"$gate" || return 1
  grep -Fxq '          require_optional_lane "$RUST_SELECTED" "$SECURITY_PACK_RESULT" security_pack' <<<"$gate" || return 1
  grep -Fxq '          require_optional_lane "$NODE_SELECTED" "$NODE_CORE_RESULT" node_core' <<<"$gate" || return 1
  grep -Fxq '          require_optional_lane "$NODE_SELECTED" "$NODE_WEB_RESULT" node_web' <<<"$gate" || return 1
  grep -Fxq '          require_optional_lane "$NODE_SELECTED" "$NODE_MOBILE_RESULT" node_mobile' <<<"$gate" || return 1
  return 0
}

workflow_compliant() {
  local workflow="$1"
  local changes alignment policy gitleaks advisories rust contract gate
  local node_core node_web node_mobile
  changes="$(job_block "$workflow" changes)"
  alignment="$(job_block "$workflow" alignment)"
  policy="$(job_block "$workflow" policy)"
  gitleaks="$(job_block "$workflow" gitleaks)"
  advisories="$(job_block "$workflow" advisories)"
  rust="$(job_block "$workflow" rust)"
  node_core="$(job_block "$workflow" node_core)"
  node_web="$(job_block "$workflow" node_web)"
  node_mobile="$(job_block "$workflow" node_mobile)"
  contract="$(job_block "$workflow" contract)"
  gate="$(job_block "$workflow" gate)"

  [ -n "$changes" ] && [ -n "$alignment" ] && [ -n "$policy" ] && [ -n "$gitleaks" ] \
    && [ -n "$rust" ] && [ -n "$node_core" ] && [ -n "$node_web" ] \
    && [ -n "$node_mobile" ] && [ -n "$gate" ] \
    || return 1
  # #2142 / ADR-0183 D5: the web-legacy generated-contract lane must stay gone.
  [ -z "$contract" ] || return 1
  if grep -Fq 'clients/web-legacy' "$workflow"; then
    return 1
  fi
  if grep -Fq 'OpenAPI ↔ web-legacy generated contract' "$workflow"; then
    return 1
  fi
  if grep -Fq 'verify_web_generated_types.sh' "$workflow"; then
    return 1
  fi
  if grep -Fq 'outputs.contract' "$workflow"; then
    return 1
  fi
  if grep -Fq 'CONTRACT_RESULT' "$workflow"; then
    return 1
  fi
  if grep -Fq 'CONTRACT_SELECTED' "$workflow"; then
    return 1
  fi
  gitleaks_job_compliant "$gitleaks" || return 1
  advisories_job_compliant "$advisories" || return 1
  if grep -Fq 'pull_request_target' "$workflow"; then
    return 1
  fi
  grep -Fq 'gitleaks는 여기 없다: 시크릿은 전 경로라 그 잡은 상시 실행한다.' \
    <<<"$changes" || return 1
  grep -Fq "gh api \"repos/\$REPO/pulls/\$PR\"" <<<"$changes" || return 1
  grep -Fq 'gh api --paginate --slurp' <<<"$changes" || return 1
  grep -Fq "\"repos/\$REPO/pulls/\$PR/files?per_page=100\"" <<<"$changes" || return 1
  grep -Fq '.changed_files' <<<"$changes" || return 1
  grep -Fq '3,000-file API cap is ambiguous' <<<"$changes" || return 1
  grep -Fq 'unique_count=' <<<"$changes" || return 1
  grep -Fq 'incomplete or duplicate changed-files response:' <<<"$changes" || return 1
  grep -Fq '(.filename, (.previous_filename // empty))' <<<"$changes" || return 1
  grep -Fq 'scripts/check_npm_licenses\.mjs$' <<<"$changes" || return 1
  # #4696: topology + repo-state check stay in `alignment` (always on); the six
  # gate-script regression fixtures run in the path-selected `policy` job.
  alignment_job_compliant "$alignment" || return 1
  policy_job_compliant "$policy" || return 1
  grep -Fq "if: needs.changes.outputs.rust == 'true'" <<<"$rust" || return 1
  node_jobs_compliant "$node_core" "$node_web" "$node_mobile" || return 1
  gate_job_compliant "$gate" || return 1

  # Every third-party action in the required workflow is immutable.
  if grep -E '^[[:space:]]*(- )?uses:' "$workflow" \
    | grep -Ev '@[0-9a-f]{40}([[:space:]]|$)' >/dev/null; then
    return 1
  fi
}

for required in \
  '      - main' \
  '      - track/engine' \
  '      - track/uxui' \
  '  pull_request:' \
  '    name: PR CI gate' \
  '  gitleaks:' \
  '    name: gitleaks secret scan' \
  'GITLEAKS_VERSION: 8.30.1' \
  '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb' \
  'sha256sum -c' \
  '--gitleaks-ignore-path .gitleaksignore' \
  'log_opts="${BASE_SHA}..${HEAD_SHA}"' \
  '      GITLEAKS_RESULT: ${{ needs.gitleaks.result }}' \
  'scripts/check_npm_licenses\.mjs$' \
  'run: npm --prefix clients/web run test' \
  'run: npm --prefix clients/mobile run test' \
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' \
  'actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444' \
  'scripts/tests/test_ghcr_notice_bundle.sh' \
  'scripts/check_ghcr_notice_bundle.sh --stale-only' \
  '  advisories:' \
  '    name: dependency advisory gate' \
  '      ADVISORIES_RESULT: ${{ needs.advisories.result }}' \
  'OSV_SHA256: 160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b' \
  'run: python3 scripts/check_advisories.py'; do
  grep -Fq -- "$required" "$WORKFLOW" || fail "pr-ci missing: $required"
done

workflow_compliant "$WORKFLOW" || fail "contract/gate dependency or failure propagation drift"

# Mutation proofs: the static contract must turn red when a later refactor
# drops a selected lane, the legacy license check, or failure propagation.
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cp "$WORKFLOW" "$TMP_DIR/missing-alignment.yml"
sed -i.bak '/^      - alignment$/d' "$TMP_DIR/missing-alignment.yml"
if workflow_compliant "$TMP_DIR/missing-alignment.yml"; then
  fail "missing alignment dependency was accepted"
fi

# Restoring the retired web-legacy contract lane must turn the guard red.
cp "$WORKFLOW" "$TMP_DIR/restored-legacy.yml"
cat >> "$TMP_DIR/restored-legacy.yml" <<'LEGACY_JOB'
  contract:
    name: OpenAPI ↔ web-legacy generated contract
    needs: changes
    if: needs.changes.outputs.contract == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: scripts/verify_web_generated_types.sh
LEGACY_JOB
if workflow_compliant "$TMP_DIR/restored-legacy.yml"; then
  fail "restored web-legacy contract lane was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/missing-notice.yml"
sed -i.bak '/test_ghcr_notice_bundle\.sh/d' "$TMP_DIR/missing-notice.yml"
if workflow_compliant "$TMP_DIR/missing-notice.yml"; then
  fail "missing GHCR notice bundle regression was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/failure-softened.yml"
sed -i.bak 's/true:success|false:skipped) ;;/true:success|true:skipped|false:skipped) ;;/' "$TMP_DIR/failure-softened.yml"
if workflow_compliant "$TMP_DIR/failure-softened.yml"; then
  fail "selected skipped lane was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/missing-always.yml"
sed -i.bak '/^    if: always()$/d' "$TMP_DIR/missing-always.yml"
if workflow_compliant "$TMP_DIR/missing-always.yml"; then
  fail "gate without always() was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/wrong-selection.yml"
sed -i.bak 's/NODE_SELECTED: \${{ needs.changes.outputs.node }}/NODE_SELECTED: ${{ needs.changes.outputs.rust }}/' "$TMP_DIR/wrong-selection.yml"
if workflow_compliant "$TMP_DIR/wrong-selection.yml"; then
  fail "wrong selected-output mapping was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/mutable-action.yml"
sed -i.bak 's#actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1#actions/checkout@v7#g' "$TMP_DIR/mutable-action.yml"
if workflow_compliant "$TMP_DIR/mutable-action.yml"; then
  fail "mutable action tag was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/rename-source-dropped.yml"
sed -i.bak 's/(.filename, (.previous_filename \/\/ empty))/.filename/' "$TMP_DIR/rename-source-dropped.yml"
if workflow_compliant "$TMP_DIR/rename-source-dropped.yml"; then
  fail "classifier without rename source path was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/wrong-bootstrap-base.yml"
sed -i.bak \
  's/38587b53c088049e42f9fba1f8d0118985523faf/38587b53c088049e42f9fba1f8d0118985523fa0/' \
  "$TMP_DIR/wrong-bootstrap-base.yml"
if workflow_compliant "$TMP_DIR/wrong-bootstrap-base.yml"; then
  fail "unreviewed #1302 bootstrap base was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/missing-gitleaks.yml"
sed -i.bak '/^      - gitleaks$/d' "$TMP_DIR/missing-gitleaks.yml"
if workflow_compliant "$TMP_DIR/missing-gitleaks.yml"; then
  fail "missing gitleaks gate dependency was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/gitleaks-optional.yml"
# shellcheck disable=SC2016 # Literal workflow contract, not a shell expansion.
sed -i.bak '/test "$GITLEAKS_RESULT" = success/d' \
  "$TMP_DIR/gitleaks-optional.yml"
if workflow_compliant "$TMP_DIR/gitleaks-optional.yml"; then
  fail "gitleaks result not required by the gate was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/gitleaks-path-filtered.yml"
sed -i.bak 's/^    name: gitleaks secret scan$/    name: gitleaks secret scan\
    if: needs.changes.outputs.rust == '\''true'\''/' \
  "$TMP_DIR/gitleaks-path-filtered.yml"
if workflow_compliant "$TMP_DIR/gitleaks-path-filtered.yml"; then
  fail "path-filtered gitleaks job was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/gitleaks-full-history.yml"
sed -i.bak 's/log_opts="${BASE_SHA}..${HEAD_SHA}"/log_opts="--all"/' \
  "$TMP_DIR/gitleaks-full-history.yml"
if workflow_compliant "$TMP_DIR/gitleaks-full-history.yml"; then
  fail "full-history gitleaks scan was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/gitleaks-unpinned.yml"
sed -i.bak 's/GITLEAKS_VERSION: 8.30.1/GITLEAKS_VERSION: latest/' \
  "$TMP_DIR/gitleaks-unpinned.yml"
if workflow_compliant "$TMP_DIR/gitleaks-unpinned.yml"; then
  fail "unpinned gitleaks version was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/gitleaks-no-checksum.yml"
sed -i.bak '/sha256sum -c/d' "$TMP_DIR/gitleaks-no-checksum.yml"
if workflow_compliant "$TMP_DIR/gitleaks-no-checksum.yml"; then
  fail "gitleaks install without checksum was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/pull-request-target.yml"
sed -i.bak 's/^  pull_request:$/  pull_request_target:/' \
  "$TMP_DIR/pull-request-target.yml"
if workflow_compliant "$TMP_DIR/pull-request-target.yml"; then
  fail "pull_request_target trigger was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/web-tz-pin.yml"
sed -i.bak 's/run: npm --prefix clients\/web run test/env:\
          TZ: Asia\/Seoul\
        run: npm --prefix clients\/web run test/' \
  "$TMP_DIR/web-tz-pin.yml"
if workflow_compliant "$TMP_DIR/web-tz-pin.yml"; then
  fail "web lane TZ: Asia/Seoul pin was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/mobile-inbox-exclude.yml"
sed -i.bak 's/run: npm --prefix clients\/mobile run test/run: npm --prefix clients\/mobile run test -- --testPathIgnorePatterns=inboxApproval/' \
  "$TMP_DIR/mobile-inbox-exclude.yml"
if workflow_compliant "$TMP_DIR/mobile-inbox-exclude.yml"; then
  fail "mobile inboxApproval filename exclusion was accepted"
fi

# Advisory lane (#4243): each way of making it unable to fail must turn the guard red.
cp "$WORKFLOW" "$TMP_DIR/missing-advisories.yml"
sed -i.bak '/^      - advisories$/d' "$TMP_DIR/missing-advisories.yml"
if workflow_compliant "$TMP_DIR/missing-advisories.yml"; then
  fail "missing advisories gate dependency was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/advisories-optional.yml"
# shellcheck disable=SC2016 # Literal workflow contract, not a shell expansion.
sed -i.bak '/test "$ADVISORIES_RESULT" = success/d' "$TMP_DIR/advisories-optional.yml"
if workflow_compliant "$TMP_DIR/advisories-optional.yml"; then
  fail "advisories result not required by the gate was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/advisories-path-filtered.yml"
sed -i.bak 's/^    name: dependency advisory gate$/    name: dependency advisory gate\
    if: needs.changes.outputs.node == '\''true'\''/' "$TMP_DIR/advisories-path-filtered.yml"
if workflow_compliant "$TMP_DIR/advisories-path-filtered.yml"; then
  fail "path-filtered advisories job was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/advisories-soft.yml"
sed -i.bak 's/^    name: dependency advisory gate$/    name: dependency advisory gate\
    continue-on-error: true/' "$TMP_DIR/advisories-soft.yml"
if workflow_compliant "$TMP_DIR/advisories-soft.yml"; then
  fail "continue-on-error advisories job was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/advisories-narrowed.yml"
sed -i.bak 's#run: python3 scripts/check_advisories.py$#run: python3 scripts/check_advisories.py --only ledger#' "$TMP_DIR/advisories-narrowed.yml"
if workflow_compliant "$TMP_DIR/advisories-narrowed.yml"; then
  fail "narrowed advisory gate (--only) was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/advisories-no-negative-control.yml"
sed -i.bak '/test_advisory_gate.sh --online/d' "$TMP_DIR/advisories-no-negative-control.yml"
if workflow_compliant "$TMP_DIR/advisories-no-negative-control.yml"; then
  fail "advisory lane without negative controls was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/advisories-osv-no-checksum.yml"
sed -i.bak '/OSV_SHA256}  /d' "$TMP_DIR/advisories-osv-no-checksum.yml"
if workflow_compliant "$TMP_DIR/advisories-osv-no-checksum.yml"; then
  fail "osv-scanner install without checksum was accepted"
fi

cp "$WORKFLOW" "$TMP_DIR/advisories-osv-unpinned.yml"
sed -i.bak 's/OSV_VERSION: 2.7.0/OSV_VERSION: latest/' "$TMP_DIR/advisories-osv-unpinned.yml"
if workflow_compliant "$TMP_DIR/advisories-osv-unpinned.yml"; then
  fail "unpinned osv-scanner version was accepted"
fi

# --- #4696: structure mutants. The Node lane is split per tree, the gate-script
# fixtures are a path-selected job, and the gate cross-checks every one of them.
# Each deletion below removes exactly one line inside one job and must turn the
# static contract red: a check that can silently stop running is what this file
# exists to prevent. (A control — the unmutated workflow — was accepted above.)
mutate_in_job() { # <name> <job> <exact line to delete>
  awk -v marker="  $2:" -v target="$3" '
    $0 == marker { active = 1; print; next }
    active && $0 ~ /^  [[:alnum:]_-]+:$/ { active = 0 }
    active && $0 == target { next }
    { print }
  ' "$WORKFLOW" > "$TMP_DIR/$1.yml"
  if cmp -s "$WORKFLOW" "$TMP_DIR/$1.yml"; then
    fail "$1 mutation did not apply (anchor line changed): $3"
  fi
  if workflow_compliant "$TMP_DIR/$1.yml"; then
    fail "$1 was accepted"
  fi
}

for gate_dependency in policy node_core node_web node_mobile; do
  mutate_in_job "gate-drops-$gate_dependency" gate "      - $gate_dependency"
done
# shellcheck disable=SC2016 # Literal workflow shell lines, not expansions.
{
  mutate_in_job gate-ignores-policy gate '          require_optional_lane "$POLICY_SELECTED" "$POLICY_RESULT" policy'
  mutate_in_job gate-ignores-node-core gate '          require_optional_lane "$NODE_SELECTED" "$NODE_CORE_RESULT" node_core'
  mutate_in_job gate-ignores-node-web gate '          require_optional_lane "$NODE_SELECTED" "$NODE_WEB_RESULT" node_web'
  mutate_in_job gate-ignores-node-mobile gate '          require_optional_lane "$NODE_SELECTED" "$NODE_MOBILE_RESULT" node_mobile'
}
for fixture in \
  test_track_alignment_guard test_pr_ci_guardrails test_github_track_guardrails \
  test_policy_integrity_gate test_trusted_policy_runner test_ghcr_notice_bundle; do
  mutate_in_job "policy-drops-$fixture" policy "          scripts/tests/${fixture}.sh"
done
mutate_in_job policy-unconditional policy "    if: needs.changes.outputs.policy == 'true'"
mutate_in_job stale-check-dropped alignment '        run: scripts/check_ghcr_notice_bundle.sh --stale-only'
mutate_in_job node-core-no-license-gate node_core '        run: node scripts/check_npm_licenses.mjs'
mutate_in_job node-core-no-typecheck node_core '        run: npm run typecheck --workspace @momo/core'
mutate_in_job node-core-no-test node_core '        run: npm run test --workspace @momo/core'
mutate_in_job node-web-no-typecheck node_web '        run: npm --prefix clients/web run typecheck'
mutate_in_job node-web-no-test node_web '        run: npm --prefix clients/web run test'
mutate_in_job node-web-no-root-install node_web '        run: npm ci'
mutate_in_job node-mobile-no-typecheck node_mobile '        run: npm --prefix clients/mobile run typecheck'
mutate_in_job node-mobile-no-test node_mobile '        run: npm --prefix clients/mobile run test'
mutate_in_job node-mobile-no-root-install node_mobile '        run: npm ci'

mutate_in_job policy-no-needs policy '    needs: changes'
for node_job_name in node_core node_web node_mobile; do
  mutate_in_job "$node_job_name-unconditional" "$node_job_name" "    if: needs.changes.outputs.node == 'true'"
  mutate_in_job "$node_job_name-no-needs" "$node_job_name" '    needs: changes'
done
# shellcheck disable=SC2016 # Literal workflow shell lines, not expansions.
{
  mutate_in_job gate-ignores-rust gate '          require_optional_lane "$RUST_SELECTED" "$RUST_RESULT" rust'
  # The security pack is a required lane too: dropping it from `needs`, from the
  # env, or from the selection cross-check each lets it fail (or never run) unseen.
  mutate_in_job gate-drops-security-pack gate '      - security_pack'
  mutate_in_job gate-ignores-security-pack gate '          require_optional_lane "$RUST_SELECTED" "$SECURITY_PACK_RESULT" security_pack'
  mutate_in_job gate-security-pack-result-unset gate '      SECURITY_PACK_RESULT: ${{ needs.security_pack.result }}'
}

insert_after_in_job() { # <name> <job> <anchor line> <inserted line>
  awk -v marker="  $2:" -v anchor="$3" -v ins="$4" '
    $0 == marker { active = 1 }
    active && $0 ~ /^  [[:alnum:]_-]+:$/ && $0 != marker { active = 0 }
    { print }
    active && $0 == anchor { print ins }
  ' "$WORKFLOW" > "$TMP_DIR/$1.yml"
  if cmp -s "$WORKFLOW" "$TMP_DIR/$1.yml"; then
    fail "$1 mutation did not apply (anchor line changed): $3"
  fi
  if workflow_compliant "$TMP_DIR/$1.yml"; then
    fail "$1 was accepted"
  fi
}
mutate_sed() { # <name> <sed expression>
  sed "$2" "$WORKFLOW" > "$TMP_DIR/$1.yml"
  if cmp -s "$WORKFLOW" "$TMP_DIR/$1.yml"; then
    fail "$1 mutation did not apply (anchor text changed)"
  fi
  if workflow_compliant "$TMP_DIR/$1.yml"; then
    fail "$1 was accepted"
  fi
}
insert_after_in_job alignment-has-needs alignment '    name: canonical track alignment' '    needs: changes'
insert_after_in_job policy-soft policy '    name: 정책 회귀 fixtures' '    continue-on-error: true'
insert_after_in_job node-web-soft node_web '    name: TS web — 타입체크 + 단위 시험' '    continue-on-error: true'
# The trusted checker must come from main, never from the PR's own tree.
mutate_sed alignment-checker-from-pr 's#git show "origin/main:scripts/check_track_alignment.sh"#git show "HEAD:scripts/check_track_alignment.sh"#'
# The gate's own selection mapping and its two always-required results.
mutate_sed policy-selection-mapped-to-rust 's/POLICY_SELECTED: \${{ needs.changes.outputs.policy }}/POLICY_SELECTED: ${{ needs.changes.outputs.rust }}/'
mutate_sed rust-selection-mapped-to-node 's/      RUST_SELECTED: \${{ needs.changes.outputs.rust }}/      RUST_SELECTED: ${{ needs.changes.outputs.node }}/'
# Each *_RESULT env var reads its own job: wiring one to a neighbour's result keeps
# the job in `needs` and its require_optional_lane line in place, yet lets that job
# fail unseen. One mutant per variable (<VAR>:<own job>:<neighbour job>).
for wiring in \
  CHANGES_RESULT:changes:alignment ALIGNMENT_RESULT:alignment:changes GITLEAKS_RESULT:gitleaks:changes \
  ADVISORIES_RESULT:advisories:changes POLICY_RESULT:policy:alignment RUST_RESULT:rust:changes \
  SECURITY_PACK_RESULT:security_pack:rust NODE_CORE_RESULT:node_core:node_web \
  NODE_WEB_RESULT:node_web:node_core NODE_MOBILE_RESULT:node_mobile:node_core; do
  IFS=: read -r wired_var wired_job wired_other <<<"$wiring"
  mutate_sed "gate-${wired_var}-read-from-${wired_other}" \
    "s/      ${wired_var}: \\\${{ needs.${wired_job}.result }}/      ${wired_var}: \\\${{ needs.${wired_other}.result }}/"
done
# shellcheck disable=SC2016 # Literal workflow shell lines, not expansions.
{
  mutate_sed changes-result-optional '/test "$CHANGES_RESULT" = success/d'
  mutate_sed alignment-result-optional '/test "$ALIGNMENT_RESULT" = success/d'
}
mutate_sed gate-message-changed 's#lane selection/result mismatch:#lane mismatch:#'

# The node-lane bandages stay retired one by one (#1635): each string alone is red.
# (The `run:` line stays byte-identical here, so only the string guard can see it.)
insert_after_in_job mobile-path-ignore-env node_mobile '      - name: test — clients/mobile (jest)' '        env:\n          JEST_ARGS: --testPathIgnorePatterns=flaky'
insert_after_in_job mobile-name-filter-env node_mobile '      - name: test — clients/mobile (jest)' '        env:\n          SKIP_SUITE: inboxApproval'
# The retired web-legacy contract lane may not come back through the gate either.
awk '{ print } $0 == "      - node_mobile" { print "      - contract" }' "$WORKFLOW" > "$TMP_DIR/gate-needs-contract.yml"
if cmp -s "$WORKFLOW" "$TMP_DIR/gate-needs-contract.yml"; then
  fail "gate-needs-contract mutation did not apply"
fi
if workflow_compliant "$TMP_DIR/gate-needs-contract.yml"; then
  fail "a gate that needs the retired contract lane was accepted"
fi

# The always-on repo-state check must not become path-selected, and a lane must
# not quietly lose its selection condition.
awk '{ print } $0 == "    name: canonical track alignment" { print "    if: needs.changes.outputs.policy == '\''true'\''" }' \
  "$WORKFLOW" > "$TMP_DIR/alignment-conditional.yml"
if cmp -s "$WORKFLOW" "$TMP_DIR/alignment-conditional.yml"; then
  fail "alignment-conditional mutation did not apply"
fi
if workflow_compliant "$TMP_DIR/alignment-conditional.yml"; then
  fail "a path-selected alignment job was accepted"
fi
# A leftover single `node` dependency would wait on a job nobody defines.
awk '{ print } $0 == "      - node_mobile" { print "      - node" }' "$WORKFLOW" > "$TMP_DIR/gate-needs-node.yml"
if cmp -s "$WORKFLOW" "$TMP_DIR/gate-needs-node.yml"; then
  fail "gate-needs-node mutation did not apply"
fi
if workflow_compliant "$TMP_DIR/gate-needs-node.yml"; then
  fail "a gate that still needs the removed node job was accepted"
fi

# Execute the exact embedded classifier with a fake GitHub API. These fixtures
# prove behavior, rather than only asserting that policy-looking strings exist.
FILTER_SCRIPT="$TMP_DIR/change-filter.sh"
extract_change_filter "$WORKFLOW" > "$FILTER_SCRIPT"
[ -s "$FILTER_SCRIPT" ] || fail "could not extract changed-files classifier"

FAKE_BIN="$TMP_DIR/fake-bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *'/files?per_page=100'*) cat "$FAKE_GH_FILES" ;;
  *'/pulls/'*) cat "$FAKE_GH_METADATA" ;;
  *) echo "unexpected fake gh invocation: $*" >&2; exit 64 ;;
esac
FAKE_GH
chmod +x "$FAKE_BIN/gh"

assert_filter_fixture() {
  local name="$1"
  local metadata_json="$2"
  local pages_json="$3"
  local expected_rust="$4"
  local expected_node="$5"
  local expected_policy="${6:-}"
  local fixture_dir="$TMP_DIR/fixture-$name"
  local key actual expected

  mkdir -p "$fixture_dir/runner"
  printf '%s\n' "$metadata_json" > "$fixture_dir/metadata.json"
  printf '%s\n' "$pages_json" > "$fixture_dir/pages.json"
  : > "$fixture_dir/output"

  # `bash -e` is what Actions runs for a `run:` step without `shell:`; the script's
  # own `set -uo pipefail` adds -u and pipefail but does not switch -e off.
  if ! PATH="$FAKE_BIN:$PATH" \
    FAKE_GH_METADATA="$fixture_dir/metadata.json" \
    FAKE_GH_FILES="$fixture_dir/pages.json" \
    GITHUB_OUTPUT="$fixture_dir/output" \
    RUNNER_TEMP="$fixture_dir/runner" \
    GH_TOKEN=test REPO=example/oort PR=42 \
    bash -e "$FILTER_SCRIPT" > "$fixture_dir/log" 2>&1; then
    # The log starts with the changed-path list (up to 2,999 lines for the big-PR
    # fixtures) and ends with the reason, so show the tail.
    tail -n 40 "$fixture_dir/log" | sed 's/^/[classifier] /' >&2
    fail "$name classifier fixture exited non-zero"
  fi

  for key in rust node; do
    actual="$(awk -F= -v key="$key" '$1 == key { value = $2 } END { print value }' "$fixture_dir/output")"
    case "$key" in
      rust) expected="$expected_rust" ;;
      node) expected="$expected_node" ;;
    esac
    # `any` = this fixture only asserts another lane (the policy-lane row probes).
    [ "$expected" = any ] && continue
    [ "$actual" = "$expected" ] \
      || fail "$name expected $key=$expected, got ${actual:-<empty>}"
  done
  # #4696: the policy lane (gate-script regression fixtures) must be emitted, and a
  # Rust-lane PR always runs it too (test_pr_ci_guardrails.sh reads the Rust
  # sources). An explicit expectation, when given, is exact.
  actual="$(awk -F= '$1 == "policy" { value = $2 } END { print value }' "$fixture_dir/output")"
  case "$actual" in
    true|false) ;;
    *) fail "$name classifier emitted no policy lane (got ${actual:-<empty>})" ;;
  esac
  if [ "$expected_rust" = true ] && [ "$actual" != true ]; then
    fail "$name selected the rust lane but not the policy lane"
  fi
  if [ -n "$expected_policy" ] && [ "$actual" != "$expected_policy" ]; then
    fail "$name expected policy=$expected_policy, got $actual"
  fi
  if grep -Eq '^(contract)=' "$fixture_dir/output"; then
    fail "$name classifier still emitted a contract lane"
  fi
}

# A rename out of server-rust must still select Rust from previous_filename.
assert_filter_fixture rename-source \
  '{"changed_files":1}' \
  '[[{"filename":"docs/renamed.md","previous_filename":"server-rust/Cargo.toml","status":"renamed"}]]' \
  true false

# Rust tests read docs/api files outside server-rust (#4042). An openapi-only
# change must turn the cargo lane on; the same for a golden or vectors file.
assert_filter_fixture openapi-only \
  '{"changed_files":1}' \
  '[[{"filename":"docs/api/openapi.yaml","status":"modified"}]]' \
  true false
assert_filter_fixture api-golden-only \
  '{"changed_files":1}' \
  '[[{"filename":"docs/api/command-suggest-settings-open.golden.json","status":"modified"}]]' \
  true false
assert_filter_fixture api-vectors-only \
  '{"changed_files":1}' \
  '[[{"filename":"docs/api/human-control-signing-v4.vectors.json","status":"modified"}]]' \
  true false
assert_filter_fixture api-vector-singular \
  '{"changed_files":1}' \
  '[[{"filename":"docs/api/refresh-proof.vector.json","status":"modified"}]]' \
  true false
# A neighbouring docs file Rust never reads stays out of the cargo lane.
assert_filter_fixture api-neighbour-doc \
  '{"changed_files":1}' \
  '[[{"filename":"docs/api/notes.md","status":"modified"}]]' \
  false false

# Metadata says two files but pagination returned one: uncertainty runs all.
assert_filter_fixture incomplete-pages \
  '{"changed_files":2}' \
  '[[{"filename":"docs/only-one.md","status":"modified"}]]' \
  true true true

# Duplicate rows cannot masquerade as a complete two-file response.
assert_filter_fixture duplicate-pages \
  '{"changed_files":2}' \
  '[[{"filename":"docs/same.md"},{"filename":"docs/same.md"}]]' \
  true true true

# The API's documented maximum is ambiguous even before listing pages.
assert_filter_fixture api-cap \
  '{"changed_files":3000}' \
  '[[{"filename":"docs/not-consulted.md"}]]' \
  true true true
grep -Fq '3,000-file API cap is ambiguous' "$TMP_DIR/fixture-api-cap/log" \
  || fail "3,000-file fixture did not take the explicit cap fallback"

# A successful HTTP response with the wrong schema is still unknown, not empty.
assert_filter_fixture malformed-metadata \
  '{"changed_files":"2"}' \
  '[[{"filename":"docs/not-consulted.md"}]]' \
  true true true

assert_filter_fixture malformed-pages \
  '{"changed_files":1}' \
  '[[{"filename":17,"status":"modified"}]]' \
  true true true

# The node lane is not under test here; this only keeps its expectation honest.
node_expected_for() {
  case "$1" in
    clients/web/*|clients/mobile/*|packages/*|server/Fixtures/*) echo true ;;
    *) echo false ;;
  esac
}

# --- #4055: every file Rust reads outside its own tree must select the cargo lane.
# Derived half: pr_ci_rust_external_inputs.py scans the Rust sources for
# include_str!/include_bytes!/include! and CARGO_MANIFEST_DIR paths, so a NEW
# reference to a file outside server-rust/ and src-tauri/ turns this red until
# the rust filter covers it. A directory target is probed with a new file in it.
RUST_INPUTS="$(python3 "$SCRIPT_DIR/pr_ci_rust_external_inputs.py" "$REPO_ROOT")" \
  || fail "pr_ci_rust_external_inputs.py failed"
# The scanner must not go blind: these references exist today and must be seen.
for anchor in \
  'server/Migrations/080_hosted_agent_doorbell.sql' \
  'server/Fixtures/plugin-manifests/github.json' \
  'packages/momo-core/src/lib/http.ts' \
  'docs/api/human-control-signing.vectors.json' \
  'docs/SELF_HOST_AGENT.md' \
  'infra/rust/sql/' \
  'infra/centrifugo.json' \
  'server/Fixtures/plugin-wire/' \
  'packages/momo-core/src/features/timeline/' \
  'clients/web/src/features/settings/settingsNav.ts'; do
  grep -Fxq "$anchor" <<<"$RUST_INPUTS" \
    || fail "rust input scanner no longer reports $anchor"
done
rust_input_count=0
while IFS= read -r rust_input; do
  [ -n "$rust_input" ] || continue
  probe="$rust_input"
  case "$rust_input" in */) probe="${rust_input}new-file.probe" ;; esac
  rust_input_count=$((rust_input_count + 1))
  assert_filter_fixture "rust-input-$(printf '%s' "$rust_input" | tr -c 'A-Za-z0-9\n' '_')" \
    '{"changed_files":1}' \
    "[[{\"filename\":\"$probe\",\"status\":\"modified\"}]]" \
    true "$(node_expected_for "$probe")"
done <<<"$RUST_INPUTS"
[ "$rust_input_count" -ge 20 ] || fail "only $rust_input_count rust inputs found"

# Pinned floor: the filter may widen, never narrow. These stay covered even if
# the Rust reference that motivated them is later deleted.
for pinned in \
  docs/api/openapi.yaml \
  docs/api/work-instruction.golden.json \
  docs/api/human-control-signing-v4.vectors.json \
  server/Migrations/080_hosted_agent_doorbell.sql \
  server/Fixtures/plugin-manifests/drive.json \
  packages/momo-core/src/lib/http.ts \
  clients/web/src/lib/session.ts \
  clients/web/src/features/settings/settingsNav.ts \
  packages/momo-core/src/features/ai/aiHubModel.ts \
  packages/momo-core/src/features/timeline/completionReport.ts \
  server/Fixtures/plugin-wire/mutation-new.json \
  infra/prod/centrifugo.prod.json \
  infra/rust/sql/new.sql; do
  assert_filter_fixture "pinned-$(printf '%s' "$pinned" | tr -c 'A-Za-z0-9\n' '_')" \
    '{"changed_files":1}' \
    "[[{\"filename\":\"$pinned\",\"status\":\"modified\"}]]" \
    true "$(node_expected_for "$pinned")"
done
# Neighbours Rust never reads stay out (the filter must not become match-all).
for neighbour in \
  docs/README.md \
  docs/api/notes.md \
  packages/momo-core/src/lib/api.ts \
  clients/web/src/lib/other.ts \
  scripts/desktop/other.sh \
  server/other.txt \
  infra/other.yml \
  infra/rust/docker-compose.rust.yml \
  clients/mobile/src/x.ts \
  clients/web/src/features/settings/other.ts \
  packages/momo-core/src/lib/http.ts.bak; do
  assert_filter_fixture "neighbour-$(printf '%s' "$neighbour" | tr -c 'A-Za-z0-9\n' '_')" \
    '{"changed_files":1}' \
    "[[{\"filename\":\"$neighbour\",\"status\":\"modified\"}]]" \
    false "$(node_expected_for "$neighbour")"
done

# --- #4696: the policy lane. policy=true is a superset of rust=true, plus every
# path whose change should run the six gate-script regression fixtures. The
# neighbours none of them read stay out: a web, phone or docs-only PR skips the
# ~2 minutes, which is the point of the lane. The expectations are written per
# path (rust node policy), so a drift in any one lane regex is visible.
assert_policy_lane() { # <changed path> <rust> <node> <policy>
  assert_filter_fixture "lane-$(printf '%s' "$1" | tr -c 'A-Za-z0-9\n' '_')" \
    '{"changed_files":1}' \
    "[[{\"filename\":\"$1\",\"status\":\"modified\"}]]" \
    "$2" "$3" "$4"
}
assert_policy_lane scripts/new_gate.sh false false true
assert_policy_lane scripts/tests/test_new_gate.sh false false true
assert_policy_lane scripts/tests/fixtures/policy-integrity/case.json false false true
assert_policy_lane scripts/check_npm_licenses.mjs false true true
assert_policy_lane .github/workflows/security-nightly.yml false false true
assert_policy_lane .github/labels.json false false true
assert_policy_lane .github/ISSUE_TEMPLATE/chore.md false false true
assert_policy_lane REVIEW.md false false true
assert_policy_lane AGENTS.md false false true
assert_policy_lane CONTRIBUTING.md false false true
assert_policy_lane deny.toml true false true
assert_policy_lane osv-scanner.toml false false true
assert_policy_lane docs/security/claims.yaml false false true
assert_policy_lane docs/GITHUB_OPS.md false false true
assert_policy_lane docs/LOCAL_PR_GATE.md false false true
assert_policy_lane docs/TRACKS.md false false true
assert_policy_lane docs/adr/0153-ci-stack-selfhosted-runners.md false false true
# A Rust-lane PR runs the policy fixtures too: test_pr_ci_guardrails.sh scans the
# Rust sources for files read from outside the tree, and test_ghcr_notice_bundle.sh
# copies legal/generated/spdx-texts.
assert_policy_lane server-rust/crates/momo-wire/src/lib.rs true false true
assert_policy_lane clients/desktop/src-tauri/src/main.rs true false true
assert_policy_lane legal/generated/spdx-texts/MIT.txt true false true
assert_policy_lane server/Migrations/999_new.sql true false true
assert_policy_lane docs/api/openapi.yaml true false true
# Neighbours none of the six fixtures read: skipped.
assert_policy_lane clients/web/src/App.tsx false true false
assert_policy_lane clients/mobile/src/App.tsx false true false
assert_policy_lane packages/momo-core/src/lib/api.ts false true false
assert_policy_lane docs/README.md false false false
assert_policy_lane docs/api/notes.md false false false
assert_policy_lane docs/adr/0214-security-claims-need-tests.md false false false
assert_policy_lane README.md false false false
assert_policy_lane CHANGELOG.md false false false
assert_policy_lane infra/other.yml false false false
# A rename out of a policy path still selects the policy lane.
assert_filter_fixture policy-rename-source \
  '{"changed_files":1}' \
  '[[{"filename":"docs/renamed.md","previous_filename":"scripts/old_gate.sh","status":"renamed"}]]' \
  false false true

# Each way the classifier can lose the policy lane must turn these fixtures red.
expect_filter_red() { # <classifier script> <assert_filter_fixture args...>
  local script="$1"
  shift
  if ( FILTER_SCRIPT="$script"; assert_filter_fixture "$@" ) >/dev/null 2>&1; then
    fail "a mutated classifier was accepted: $*"
  fi
}
mutated_classifier() { # <name> <sed expression> -> path of the extracted classifier
  sed "$2" "$WORKFLOW" > "$TMP_DIR/$1.yml"
  if cmp -s "$WORKFLOW" "$TMP_DIR/$1.yml"; then
    echo "$1 mutation did not apply (anchor text changed)" >&2
    return 1
  fi
  extract_change_filter "$TMP_DIR/$1.yml" > "$TMP_DIR/$1-filter.sh"
  [ -s "$TMP_DIR/$1-filter.sh" ] || return 1
  printf '%s\n' "$TMP_DIR/$1-filter.sh"
}
one_file_pr() { # <path> -> pages json
  printf '[[{"filename":"%s","status":"modified"}]]' "$1"
}
mutant="$(mutated_classifier policy-lane-lost-osv 's/osv-scanner\\\.toml\$|//')" \
  || fail "policy-lane-lost-osv"
expect_filter_red "$mutant" mutant-osv '{"changed_files":1}' "$(one_file_pr osv-scanner.toml)" false false true
mutant="$(mutated_classifier policy-lane-lost-review 's/|REVIEW\\\.md\$//')" \
  || fail "policy-lane-lost-review"
expect_filter_red "$mutant" mutant-review '{"changed_files":1}' "$(one_file_pr REVIEW.md)" false false true
mutant="$(mutated_classifier policy-lane-lost-github 's#|\\\.github/|REVIEW#|REVIEW#')" \
  || fail "policy-lane-lost-github"
expect_filter_red "$mutant" mutant-github '{"changed_files":1}' "$(one_file_pr .github/workflows/security-nightly.yml)" false false true
mutant="$(mutated_classifier policy-lane-ignores-rust 's/^          policy="\$rust"$/          policy=false/')" \
  || fail "policy-lane-ignores-rust"
expect_filter_red "$mutant" mutant-rust-only '{"changed_files":1}' "$(one_file_pr server-rust/crates/momo-wire/src/lib.rs)" true false true
mutant="$(mutated_classifier policy-lane-unknown-state '/^              echo "policy=true"$/d')" \
  || fail "policy-lane-unknown-state"
expect_filter_red "$mutant" mutant-unknown '{"changed_files":2}' '[[{"filename":"docs/only-one.md","status":"modified"}]]' true true true

# --- #4728: a big PR must not lose a lane, and a classifier fault is never "no match" ---
# The old lane lines were `printf '%s\n' "$files" | grep -Eq <pattern> && lane=true`.
# When grep matched an early line and exited, printf (still writing a list larger than
# the pipe buffer) died of SIGPIPE; pipefail turned that into a failed pipeline, so the
# `&&` never ran and every lane stayed false while the step still succeeded: rust, the
# security pack, node and policy were all skipped and the gate was green. These fixtures
# run the real classifier on big PRs whose FIRST path matches. The API cap (3,000) is
# handled earlier by `run_all` (fixture api-cap), so 2,999 is the largest list that
# reaches the matcher.
big_pr_pad="$(printf '%*s' 120 '' | tr ' ' p)"
big_pr_pages() { # <file count> <first path, or "" for a PR that matches no lane> -> REST pages of 100
  jq -cn --argjson n "$1" --arg first "$2" --arg pad "$big_pr_pad" '
    [ (if $first == "" then empty else $first end) ]
    + [ range(0; $n - (if $first == "" then 0 else 1 end))
        | "x-bulk/section-\(. / 100 | floor)/file-\(.)-\($pad).md" ]
    | map({filename: ., status: "modified"})
    | [ range(0; length; 100) as $i | .[$i:$i+100] ]'
}
# A fixture that is too small to fill two pipe buffers could not catch the old form.
[ "$(big_pr_pages 1000 NOTICE | jq -r '.[][].filename' | wc -c | tr -d ' ')" -gt 131072 ] \
  || fail "the 1,000-file fixture no longer exceeds two pipe buffers"
assert_big_pr() { # <file count> <first path or ""> <rust> <node> <policy>
  assert_filter_fixture "big-$1-$(printf '%s' "${2:-none}" | tr -c 'A-Za-z0-9\n' '_')" \
    "{\"changed_files\":$1}" "$(big_pr_pages "$1" "$2")" "$3" "$4" "$5"
}
for big_count in 1000 2999; do
  # The workflow itself matches all three patterns on the very first line.
  assert_big_pr "$big_count" .github/workflows/pr-ci.yml true true true
  # One lane per row: the first line matches only that lane (policy always includes rust).
  assert_big_pr "$big_count" NOTICE true false true
  assert_big_pr "$big_count" clients/web/src/early.ts false true false
  assert_big_pr "$big_count" AGENTS.md false false true
  # Control: a big PR that matches nothing stays false, so the classifier is not match-all.
  assert_big_pr "$big_count" '' false false false
done

# Sabotage 1: put ONE lane line back into the old pipe form (echo and printf are both
# builtins, so the SIGPIPE is the same). Its own big-PR row must come out false.
old_form_lane_mutant() { # <name> <n> -> classifier whose n-th lane line is piped again
  awk -v nth="$2" '
    $0 == "          lane_hit \\" && ++seen == nth { print "          echo \"$files\" | grep -Eq \\"; next }
    { print }
  ' "$WORKFLOW" > "$TMP_DIR/$1.yml"
  if cmp -s "$WORKFLOW" "$TMP_DIR/$1.yml"; then
    echo "$1 mutation did not apply (lane line $2 not found)" >&2
    return 1
  fi
  extract_change_filter "$TMP_DIR/$1.yml" > "$TMP_DIR/$1-filter.sh"
  [ -s "$TMP_DIR/$1-filter.sh" ] || return 1
  printf '%s\n' "$TMP_DIR/$1-filter.sh"
}
expect_lane_lost() { # <classifier script> <lane> <assert_big_pr args...> -> red because that lane is false
  local script="$1" lane="$2" out
  shift 2
  if out="$( ( FILTER_SCRIPT="$script"; assert_big_pr "$@" ) 2>&1 )"; then
    fail "a classifier with the old pipe form for the $lane lane was accepted: $*"
  fi
  grep -Fq "expected $lane=true, got false" <<<"$out" \
    || fail "the old-form $lane mutant went red for another reason: $(tail -c 600 <<<"$out")"
}
mutant="$(old_form_lane_mutant old-form-rust 1)" || fail "old-form-rust"
expect_lane_lost "$mutant" rust 1000 NOTICE true false true
mutant="$(old_form_lane_mutant old-form-node 2)" || fail "old-form-node"
expect_lane_lost "$mutant" node 1000 clients/web/src/early.ts false true false
mutant="$(old_form_lane_mutant old-form-policy 3)" || fail "old-form-policy"
expect_lane_lost "$mutant" policy 1000 AGENTS.md false false true
mutant="$(old_form_lane_mutant old-form-rust-3k 1)" || fail "old-form-rust-3k"
expect_lane_lost "$mutant" rust 2999 .github/workflows/pr-ci.yml true true true

# A grep failure (bad regex after an edit, unreadable file) is neither a match nor "no
# match": the step must fail so the changes job, and with it the gate, goes red. The fault
# is injected with a grep that always exits 2; the caller-visible result is the step's exit
# status and the absence of any lane output.
GREP_FAULT_BIN="$TMP_DIR/grep-fault-bin"
mkdir -p "$GREP_FAULT_BIN"
printf '#!/usr/bin/env bash\nexit 2\n' > "$GREP_FAULT_BIN/grep"
chmod +x "$GREP_FAULT_BIN/grep"
assert_step_fails_on_grep_error() { # <classifier script> <name>
  local script="$1" name="$2" fixture_dir="$TMP_DIR/fixture-grep-fault-$2"
  mkdir -p "$fixture_dir/runner"
  printf '{"changed_files":1}\n' > "$fixture_dir/metadata.json"
  printf '[[{"filename":"docs/a.md","status":"modified"}]]\n' > "$fixture_dir/pages.json"
  : > "$fixture_dir/output"
  if PATH="$GREP_FAULT_BIN:$FAKE_BIN:$PATH" \
    FAKE_GH_METADATA="$fixture_dir/metadata.json" \
    FAKE_GH_FILES="$fixture_dir/pages.json" \
    GITHUB_OUTPUT="$fixture_dir/output" \
    RUNNER_TEMP="$fixture_dir/runner" \
    GH_TOKEN=test REPO=example/oort PR=42 \
    bash -e "$script" > "$fixture_dir/log" 2>&1; then
    fail "$name: the classifier step succeeded although grep failed"
  fi
  if grep -Eq '^(rust|node|policy)=' "$fixture_dir/output"; then
    fail "$name: the classifier wrote lane outputs although grep failed"
  fi
}
assert_step_fails_on_grep_error "$FILTER_SCRIPT" real-classifier
# Sabotage 2: swallow the fault as "no match" (the old behaviour). Red for this reason only.
mutant="$(mutated_classifier grep-error-swallowed \
  's/lane classifier failed: grep exit \$rc"; exit 1; }/lane classifier failed: grep exit $rc"; return 1; }/')" \
  || fail "grep-error-swallowed"
if out="$( ( assert_step_fails_on_grep_error "$mutant" swallowed ) 2>&1 )"; then
  fail "a classifier that reads a grep failure as 'no match' was accepted"
fi
grep -Fq 'the classifier step succeeded although grep failed' <<<"$out" \
  || fail "the grep-error-swallowed mutant went red for another reason: $(tail -c 600 <<<"$out")"

# The gate itself, executed: it must never be green when classification failed or a lane
# output is missing. The gate step is extracted and run under a full environment (every
# variable Actions would set), so these are verdicts, not string checks.
extract_gate_step() { # <workflow> -> the shell script of the gate's check step
  job_block "$1" gate | awk '
    $0 == "      - name: required and selected lanes are green" { saw = 1; next }
    saw && $0 == "        run: |" { in_script = 1; next }
    in_script && $0 == "" { print; next }
    in_script && substr($0, 1, 10) == "          " { print substr($0, 11); next }
    in_script { exit }
  '
}
GATE_STEP="$TMP_DIR/gate-step.sh"
extract_gate_step "$WORKFLOW" > "$GATE_STEP"
[ -s "$GATE_STEP" ] || fail "could not extract the gate step"
gate_verdict() { # <gate script> [VAR=value ...] -> exit status; defaults describe a docs-only PR
  local script="$1"
  shift
  env -i PATH="$PATH" \
    CHANGES_RESULT=success ALIGNMENT_RESULT=success GITLEAKS_RESULT=success ADVISORIES_RESULT=success \
    POLICY_SELECTED=false RUST_SELECTED=false NODE_SELECTED=false \
    POLICY_RESULT=skipped RUST_RESULT=skipped SECURITY_PACK_RESULT=skipped \
    NODE_CORE_RESULT=skipped NODE_WEB_RESULT=skipped NODE_MOBILE_RESULT=skipped \
    "$@" bash -e "$script" > /dev/null 2>&1
}
gate_expect_green() { # <why> [VAR=value ...]
  gate_verdict "$GATE_STEP" "${@:2}" || fail "the gate was red for a legitimate state: $1"
}
gate_expect_red() { # <why> [VAR=value ...]
  if gate_verdict "$GATE_STEP" "${@:2}"; then fail "the gate was green for: $1"; fi
}
all_lanes_green=(
  POLICY_SELECTED=true RUST_SELECTED=true NODE_SELECTED=true
  POLICY_RESULT=success RUST_RESULT=success SECURITY_PACK_RESULT=success
  NODE_CORE_RESULT=success NODE_WEB_RESULT=success NODE_MOBILE_RESULT=success
)
gate_expect_green "docs-only PR, every optional lane unselected and skipped"
gate_expect_green "every lane selected and green" "${all_lanes_green[@]}"
for changes_result in failure cancelled skipped; do
  gate_expect_red "classification $changes_result with lane outputs that look consistent" \
    CHANGES_RESULT="$changes_result"
done
gate_expect_red "classification failed after selecting every lane" CHANGES_RESULT=failure "${all_lanes_green[@]}"
for lane_output in POLICY_SELECTED RUST_SELECTED NODE_SELECTED; do
  gate_expect_red "$lane_output empty (the classifier wrote nothing)" "$lane_output="
  gate_expect_red "$lane_output malformed" "$lane_output=maybe"
done
gate_expect_red "rust selected but its jobs were skipped" RUST_SELECTED=true
gate_expect_red "node selected but its jobs were skipped" NODE_SELECTED=true
gate_expect_red "policy selected but its job was skipped" POLICY_SELECTED=true
gate_expect_red "rust ran although it was not selected" RUST_RESULT=success
gate_expect_red "a selected lane failed" "${all_lanes_green[@]}" NODE_WEB_RESULT=failure
gate_expect_red "alignment skipped" ALIGNMENT_RESULT=skipped
gate_expect_red "gitleaks skipped" GITLEAKS_RESULT=skipped
gate_expect_red "advisories failed" ADVISORIES_RESULT=failure
# Sabotage 3: each mutated gate must turn the matching fixture green, i.e. the fixtures above
# would catch it. (Only the mutated gate is run here, and it must wrongly succeed.)
gate_mutant() { # <name> <sed expression> -> path of the mutated gate step
  sed "$2" "$WORKFLOW" > "$TMP_DIR/$1.yml"
  if cmp -s "$WORKFLOW" "$TMP_DIR/$1.yml"; then
    echo "$1 mutation did not apply (anchor text changed)" >&2
    return 1
  fi
  extract_gate_step "$TMP_DIR/$1.yml" > "$TMP_DIR/$1-gate.sh"
  [ -s "$TMP_DIR/$1-gate.sh" ] || return 1
  printf '%s\n' "$TMP_DIR/$1-gate.sh"
}
mutant="$(gate_mutant gate-ignores-classification 's/^          test "\$CHANGES_RESULT" = success$/          true/')" \
  || fail "gate-ignores-classification"
gate_verdict "$mutant" CHANGES_RESULT=failure \
  || fail "the failed-classification fixture cannot tell a gate that ignores the changes job"
mutant="$(gate_mutant gate-accepts-any-lane-state 's/true:success|false:skipped) ;;/*) ;;/')" \
  || fail "gate-accepts-any-lane-state"
gate_verdict "$mutant" RUST_SELECTED=true \
  || fail "the silent-skip fixture cannot tell a gate that accepts any lane state"
gate_verdict "$mutant" RUST_SELECTED= \
  || fail "the empty-output fixture cannot tell a gate that accepts any lane state"

# --- #4696: REVIEW.md risk table <-> policy_path() <-> the policy lane ----------
# This check reads two files and compares them; the issue asks for exactly that
# lock ("the test locks the table"), so it exists despite the usual rule against
# tests that read source. It still avoids asserting letters: the real policy_path()
# is extracted and CALLED, and the real classifier is executed.
RISK_DOC="$REPO_ROOT/REVIEW.md"
POLICY_VERIFIER="$REPO_ROOT/scripts/verify_policy_integrity.sh"

risk_table_policy_patterns() { # <doc> -> one backticked pattern per list row between the markers
  awk '
    index($0, "<!-- risk-tier:policy-paths:begin -->") { on = 1; next }
    index($0, "<!-- risk-tier:policy-paths:end -->") { on = 0 }
    on
  ' "$1" | sed -n 's/^[[:space:]]*-[[:space:]]*`\([^`][^`]*\)`.*$/\1/p'
}

risk_table_matches_policy_path() { # <doc> <verifier script> -> 0 match, 1 drift (reasons on stdout)
  local doc="$1" verifier="$2" patterns count dups files
  [ -f "$doc" ] || { echo "risk table document is missing: $doc"; return 1; }
  patterns="$(risk_table_policy_patterns "$doc")"
  count="$(printf '%s\n' "$patterns" | grep -c . || true)"
  if [ "$count" -lt 30 ]; then
    echo "risk table lists only $count policy patterns (marker block missing or parser blind)"
    return 1
  fi
  dups="$(printf '%s\n' "$patterns" | sort | uniq -d)"
  if [ -n "$dups" ]; then
    echo "risk table lists a policy pattern twice: $dups"
    return 1
  fi
  files="$(git -C "$REPO_ROOT" ls-files)"
  grep -Fxq AGENTS.md <<<"$files" || { echo "git ls-files did not list AGENTS.md (not a checkout?)"; return 1; }
  (
    src="$(sed -n '/^policy_path() {$/,/^}$/p' "$verifier")"
    [ -n "$src" ] || { echo "policy_path() is not defined in $verifier"; exit 1; }
    eval "$src"
    rc=0
    while IFS= read -r pattern; do
      probe="${pattern//\*/x}"
      if ! policy_path "$probe"; then
        echo "risk table lists '$pattern' but policy_path() does not flag '$probe'"
        rc=1
      fi
    done <<<"$patterns"
    while IFS= read -r file; do
      policy_path "$file" || continue
      matched=0
      while IFS= read -r pattern; do
        # shellcheck disable=SC2254 # the table row is a glob on purpose
        case "$file" in $pattern) matched=1; break ;; esac
      done <<<"$patterns"
      if [ "$matched" != 1 ]; then
        echo "policy_path() flags '$file' but no risk table row covers it"
        rc=1
      fi
    done <<<"$files"
    exit "$rc"
  )
}

risk_table_matches_policy_path "$RISK_DOC" "$POLICY_VERIFIER" > "$TMP_DIR/risk-real.out" 2>&1 \
  || { sed 's/^/[risk-table] /' "$TMP_DIR/risk-real.out" >&2; fail "REVIEW.md risk table and policy_path() disagree"; }

# Every row must also select the policy lane in the real classifier.
risk_rows=0
while IFS= read -r risk_pattern; do
  risk_probe="${risk_pattern//\*/x}"
  assert_filter_fixture "risk-row-$(printf '%s' "$risk_probe" | tr -c 'A-Za-z0-9\n' '_')" \
    '{"changed_files":1}' "$(one_file_pr "$risk_probe")" any any true
  risk_rows=$((risk_rows + 1))
done < <(risk_table_policy_patterns "$RISK_DOC")
[ "$risk_rows" -ge 30 ] || fail "only $risk_rows risk table rows reached the classifier check"

# Mutation proofs: each drift is red AND red for the intended reason.
RISK_MUT="$TMP_DIR/risk-mut"
mkdir -p "$RISK_MUT"
risk_expect_red() { # <name> <doc> <verifier> <expected reason fragment>
  local out
  if out="$(risk_table_matches_policy_path "$2" "$3" 2>&1)"; then
    fail "risk table mutation '$1' was accepted"
  fi
  grep -Fq -- "$4" <<<"$out" || fail "risk table mutation '$1' went red for another reason: $out"
}
risk_mutation_applied() { # <original> <mutated> <name>
  if cmp -s "$1" "$2"; then
    fail "risk table mutation '$3' did not apply (anchor changed)"
  fi
}
grep -vF '`deny.toml`' "$RISK_DOC" > "$RISK_MUT/missing-row.md" || true
risk_mutation_applied "$RISK_DOC" "$RISK_MUT/missing-row.md" missing-row
risk_expect_red missing-row "$RISK_MUT/missing-row.md" "$POLICY_VERIFIER" "policy_path() flags 'deny.toml'"
awk '{ print } index($0, "<!-- risk-tier:policy-paths:begin -->") { print "- `docs/not-a-policy-file.md`" }' \
  "$RISK_DOC" > "$RISK_MUT/extra-row.md"
risk_mutation_applied "$RISK_DOC" "$RISK_MUT/extra-row.md" extra-row
risk_expect_red extra-row "$RISK_MUT/extra-row.md" "$POLICY_VERIFIER" \
  "risk table lists 'docs/not-a-policy-file.md' but policy_path() does not flag"
awk '{ print } index($0, "<!-- risk-tier:policy-paths:begin -->") { print "- `AGENTS.md`" }' \
  "$RISK_DOC" > "$RISK_MUT/duplicate-row.md"
risk_mutation_applied "$RISK_DOC" "$RISK_MUT/duplicate-row.md" duplicate-row
risk_expect_red duplicate-row "$RISK_MUT/duplicate-row.md" "$POLICY_VERIFIER" "lists a policy pattern twice"
grep -vF 'risk-tier:policy-paths:begin' "$RISK_DOC" > "$RISK_MUT/no-marker.md" || true
risk_mutation_applied "$RISK_DOC" "$RISK_MUT/no-marker.md" no-marker
risk_expect_red no-marker "$RISK_MUT/no-marker.md" "$POLICY_VERIFIER" "lists only 0 policy patterns"
# The probe must be a tracked file that the policy lane always has and policy_path()
# does not flag today: REVIEW.md (this very test already requires it, and the lane
# selects it). A probe outside the lane would make the proof depend on a file this
# lane never sees. Pick another probe if REVIEW.md ever becomes a policy file.
awk '{ print } /^    AGENTS\.md\|\\$/ { print "    REVIEW.md|\\" }' \
  "$POLICY_VERIFIER" > "$RISK_MUT/verifier-gains-a-path.sh"
risk_mutation_applied "$POLICY_VERIFIER" "$RISK_MUT/verifier-gains-a-path.sh" verifier-gains-a-path
risk_expect_red verifier-gains-a-path "$RISK_DOC" "$RISK_MUT/verifier-gains-a-path.sh" \
  "policy_path() flags 'REVIEW.md'"
grep -vxF '    deny.toml|\' "$POLICY_VERIFIER" > "$RISK_MUT/verifier-loses-a-path.sh" || true
risk_mutation_applied "$POLICY_VERIFIER" "$RISK_MUT/verifier-loses-a-path.sh" verifier-loses-a-path
risk_expect_red verifier-loses-a-path "$RISK_DOC" "$RISK_MUT/verifier-loses-a-path.sh" \
  "risk table lists 'deny.toml' but policy_path() does not flag 'deny.toml'"
sed 's/^policy_path() {$/policy_path_renamed() {/' "$POLICY_VERIFIER" > "$RISK_MUT/verifier-without-function.sh"
risk_mutation_applied "$POLICY_VERIFIER" "$RISK_MUT/verifier-without-function.sh" verifier-without-function
risk_expect_red verifier-without-function "$RISK_DOC" "$RISK_MUT/verifier-without-function.sh" \
  "policy_path() is not defined in"
# Not a git checkout: `git ls-files` returns nothing, which must be red, not an empty pass.
if out="$( ( REPO_ROOT="$TMP_DIR/not-a-checkout"; mkdir -p "$REPO_ROOT"; \
  risk_table_matches_policy_path "$RISK_DOC" "$POLICY_VERIFIER" ) 2>&1 )"; then
  fail "a risk table check outside a git checkout was accepted"
fi
grep -Fq "git ls-files did not list AGENTS.md" <<<"$out" || fail "not-a-checkout went red for another reason: $out"

for required in \
  '  push:' \
  '  schedule:' \
  '  workflow_dispatch:' \
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' \
  'git show origin/main:scripts/check_track_alignment.sh'; do
  grep -Fq "$required" "$MONITOR" || fail "track monitor missing: $required"
done

echo "[pr-ci-guard-test] PASS targets, complete rename-aware classifier fixtures (rust/node/policy lanes), big-PR lane matching without SIGPIPE, classifier faults failing the step, executed gate verdicts, retired web-legacy lane absence, per-tree node jobs, path-selected policy job, gitleaks PR-range fail-closed lane, stable fail-closed gate, REVIEW.md risk table lock, mutation proofs, and monitor triggers"
