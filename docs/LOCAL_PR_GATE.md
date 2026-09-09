# Local PR Gate

> Purpose: keep PR quality high while GitHub Actions are not the primary merge gate.
> Scope: local developer / 워커 레인(`docs/planning/PIPELINE.md` §1) validation before PR, after review, and after merge to a track branch.
> **Command canon:** `scripts/local_gate.sh --help`. This page is the profile menu and evidence contract, not a second copy of the script.

## 0. Current Status

Public-repository `pr-ci` is active for PRs into `main`, `track/engine`, and `track/uxui`; `track-alignment` watches canonical topology. Release and paid macOS workflows remain manual and owner-gated.

- `PR CI gate` and base-trusted `Policy integrity gate` are the two stable branch-protection contexts (ADR-0153 D5).
- Local evidence remains the primary runtime merge gate because PR CI does not boot PostgreSQL/Centrifugo/Docker e2e or external providers.
- Workers open a PR and hand it off; workers do not merge. `momo-main` owns review, final local gate, merge, issue close, and post-merge verification.

## 1. Rule

Every PR needs local evidence in the PR body: date and machine/toolchain, commands executed, pass/fail, runtime scope actually exercised, and anything intentionally not covered. Do not mark runtime work complete if the runtime script was not run.

```bash
scripts/local_gate.sh --profile docs
scripts/local_gate.sh --auto
scripts/local_gate.sh --help
```

`--auto` picks the profile from changed paths (`git diff --name-only <base>...HEAD` + uncommitted changes). An explicit `--profile` always wins. Evidence Markdown, log, and SHA-256 manifest land under `${TMPDIR:-/tmp}/momo-local-gate` unless `--output-dir` / `LOCAL_GATE_OUT_DIR` is set.

Every profile also runs canonical local track wiring (`check_track_alignment.sh --local-existing`), branch-skew, migration-number uniqueness, and `cargo fmt --all --check` over both cargo workspaces.

## 2. Profiles

The live name list is `scripts/local_gate.sh --help`. Snapshot:

| Profile | Use when |
|---|---|
| `docs` | docs/spec/script-only changes (static + public-edge contract + SH tests + platform template contract `scripts/tests/test_railway_template.sh` (#2297, ADR-0184 D5) — local/docs-profile only; `pr-ci` has no docs lane, its rust/node lanes skip on infra/scripts-only paths) |
| `diagnostics` | diagnostics bundle changes |
| `staging-smoke` | staging/self-host config without real VPS secrets |
| `backup` | pgBackRest PITR / migrate-gate changes |
| `host-runtime` | internal single-node host-runtime smoke |
| `local-alpha` / `internal-alpha` | internal test evidence packet |
| `runtime-db` | migrations/server/RLS |
| `runtime-relay` | outbox/relay/realtime |
| `runtime-live` | WebSocket live subscribe (run separately from `all`) |
| `runtime-agent` | agent-worker / hermes |
| `external-agent-provider` | credentialed external-runtime smoke, opt-in |
| `m3-dbc` | D/B/C exit evidence |
| `web` | `clients/web` lint/typecheck/test/build |
| `license` | cargo/npm lock or `deny.toml` / GHCR notice bundle |
| `secrets` | standalone gitleaks lane |
| `all` | merge-critical/runtime-wide (does not include `runtime-live` or `web`) |

```bash
scripts/local_gate.sh --profile web
scripts/local_gate.sh --profile runtime-db
scripts/local_gate.sh --profile secrets
```

Host load(1min) > 12 stops `runtime-*` unless `LOCAL_GATE_FORCE=1`. `--keep-stack` leaves Compose up after a runtime profile.

Optional maintainer pre-push hook: `scripts/install_branch_skew_hook.sh`.

## 3. PR Body Evidence

Paste the `## Local Gate` block the script prints (result, profile, run id, commands, coverage, not-covered). UI PRs also need design-review evidence (Blocker 0) per `AGENTS.md`.

## 4. Worker Handoff And Merge Cycle

1. Worker runs the matching profile, opens 1 PR = 1 issue, pastes evidence.
2. `scripts/goal_release.sh <issue> --review --pr <url>` → `status:needs-review`.
3. Worker does **not** merge, close, or retarget ROADMAP.
4. `momo-main` reviews, re-runs the local gate, checks PR CI + Policy integrity, then merges to the track branch.

Cross-client landings also need `scripts/verify_merge_tree.sh` green (merged tree, not branch-alone).
