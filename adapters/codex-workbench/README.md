# oort codex-workbench gateway adapter

`codex-workbench` is the Work v0 reference BYOA runner from ADR-0111 D5. It
claims oort `agent_job` rows through the scoped gateway REST surface and runs a
host-installed Codex CLI non-interactively. oort remains the execution ledger;
the oort server never starts Codex or receives Codex/provider credentials.

## Runtime contract

1. Claim one durable gateway job with the per-agent `MOMO_AGENT_TOKEN`.
2. Validate the actor-bound `{type:"work", title, brief, repo?, branch?}` payload.
3. Map the configured sandbox policy:
   - `read-only`: run `codex exec --json -s read-only` immediately.
   - `workspace-write`: prepare a read-only plan, preserve the `thread.started`
     session ID in host-local mode-0600 state, request oort approval with
     `tier=workspace_write`, then run `codex exec resume <session-id>` with
     `-s workspace-write` only after an approved resume job.
   - `network-write`, provider credential transfer, `danger-full-access`,
     `--yolo`, and sandbox bypass flags have no configuration or argv path.
4. Translate bounded Codex JSONL events to `/gateway/events` status/streaming
   callbacks. These use MOMO-350's transient `agent.status`/`agent.partial`
   projection; the adapter never calls the durable message endpoint for setup,
   lifecycle, or command notices (MOMO-356).
5. Commit one `/gateway/complete` body using
   `momo.agent_work.result.v0` (`summary`, `diff_summary`,
   `changed_file_count`, `changed_files`, `exit_code`, `links.pull_request`,
   `session_id`, and `sandbox`).

The adapter renews the bounded gateway lease while Codex runs. Completion is
cached in host-local state before the REST callback, so a recovered lease can
retry the callback without rerunning a finished Codex turn.

## Credential boundary

- `MOMO_AGENT_TOKEN` is the only credential read by the adapter. It is used only
  as the oort REST bearer, is removed from the Codex subprocess environment,
  and is redacted from errors/transcript.
- Codex login/OAuth and repository credentials remain in the operator's Codex
  installation. The adapter does not read `CODEX_HOME`, auth files, keychains,
  provider environment variables, or Git credential stores.
- The Codex subprocess inherits the host runtime as a normal local CLI process;
  no credential value is serialized into oort callbacks, local state, argv, or
  result cards.

## Configure and run

Required environment:

| Variable | Meaning |
|---|---|
| `MOMO_API_URL` | oort REST base URL. Non-loopback plaintext requires the explicit private-network opt-in below. |
| `MOMO_WORKSPACE_ID` | Workspace UUID. |
| `MOMO_AGENT_MEMBER_ID` | Active Work-capable agent member UUID. |
| `MOMO_AGENT_TOKEN` | Scoped per-agent oort bearer; never a Codex/provider token. |
| `MOMO_CODEX_WORKSPACE` | Existing local workspace used as Codex `--cd`. The Work payload's `repo` is a label and cannot redirect the filesystem root. |

Optional environment:

| Variable | Default | Meaning |
|---|---:|---|
| `MOMO_CODEX_SANDBOX` | `read-only` | `read-only` or `workspace-write` only. |
| `MOMO_CODEX_BIN` | `codex` | Host Codex executable path/name; invoked with an argv array, never a shell. |
| `MOMO_CODEX_STATE_DIR` | `~/.local/state/momo-codex-workbench` | Mode-0700 directory containing mode-0600 resume/result state. Keep it outside the repository. |
| `MOMO_CODEX_POLL_INTERVAL_SECONDS` | `2` | Idle pending-claim interval. |
| `MOMO_CODEX_HTTP_TIMEOUT_SECONDS` | `15` | oort REST timeout. |
| `MOMO_AGENT_ALLOW_INSECURE_HTTP` | unset | Set to `1` only for a trusted non-loopback private-network HTTP endpoint. |

```sh
adapters/codex-workbench/run.sh
```

`--once` claims at most one job and is useful for an operator-managed service
probe. The adapter does not clone repositories, switch branches, push, deploy,
or enable network access; prepare the intended dedicated workspace/branch before
starting it.

## Login-free contract checks

These tests execute only the repo-local mock Codex binary. They do not connect to
DB, Docker, verifier services, oort, or a real Codex/provider account.

```sh
python3 -m unittest discover \
  -s adapters/codex-workbench/tests \
  -p 'test_*.py'
python3 -m py_compile \
  adapters/codex-workbench/codex_workbench.py \
  adapters/codex-workbench/tests/mock_codex.py \
  adapters/codex-workbench/tests/test_codex_workbench_contract.py
bash -n adapters/codex-workbench/run.sh
```

The real Codex roundtrip, real oort approval resume, and merged
`runtime-agent` gate remain `runtime-unverified` for the worker and are performed
only by the momo-main orchestrator.
