# Security Policy

Korean, implementation-evidence-oriented security material (including the
trust-boundary diagram and current limitations) is available in
[`docs/security/README.ko.md`](docs/security/README.ko.md). This policy remains
the authoritative source for supported versions and vulnerability reporting.

## Supported versions

oort is pre-1.0. Security fixes are provided for the latest published `v0.x`
tag only.

| Version | Supported |
|---|---:|
| Latest published `v0.x` tag | Yes |
| Earlier tags, branches, and untagged source snapshots | No |

Operators should upgrade to the latest tag and pin the published immutable image
digest. If a report affects an older version, please reproduce it against the
latest tag when possible.

## Report a vulnerability

Do not open a public issue, discussion, or pull request for a suspected
vulnerability. Use GitHub's private
[Report a vulnerability](https://github.com/yeomyeonggeori/oort/security/advisories/new)
form to create a private Security Advisory. The same private form is the
enforcement contact named by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
There is no separate mailbox.

Include:

- the affected oort tag, image digest, and deployment mode;
- the affected component and configuration, with sensitive values redacted;
- minimal reproduction steps or a proof of concept;
- expected and observed impact;
- relevant sanitized logs, request IDs, or audit event IDs; and
- whether the issue is known to be actively exploited.

Do **not** include passwords, database URLs, bearer tokens, OAuth codes or
tokens, provider API keys, APNs credentials, raw production message content, or
unencrypted secret files. Replace them with clearly marked placeholders. If a
secret may have been exposed, rotate or revoke it first and report only the
secret type and exposure window.

## Response targets

These are targets, not an SLA:

- acknowledgement within 3 business days;
- initial severity and scope assessment within 7 business days; and
- a status update at least every 14 days while the report remains open.

Remediation and disclosure timing depend on severity, exploitability, affected
versions, and operator upgrade needs. We will coordinate an advisory and
release window with the reporter when practical. Please keep the report private
until a coordinated disclosure or explicit permission to publish.

## Security posture

What the code and deployment files enforce today. The Korean document linked
above gives the file, line and test name behind each item. Tests marked (PG)
need a real PostgreSQL and are `#[ignore]`d, so public PR CI does not run them.
Maintainers run them by hand against an isolated PostgreSQL (most test files
carry the command in their header: `cargo test … -- --ignored`) and record the
result in the pull request; only some suites are also wired into
`scripts/verify_*.sh` or a local-gate profile.

- **Forced tenant isolation.** Tenant tables use PostgreSQL RLS with
  `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`; API transactions
  set `app.workspace_id` locally (`server/Migrations/001_init.sql`,
  `server-rust/crates/momo-db/src/tenant.rs`, test
  `with_tenant_tx_sets_the_rls_guc` (PG)). A
  catalog query in the Korean document lists every table that has a
  `workspace_id` column but lacks forced RLS or a policy on `app.workspace_id`;
  it returned no rows on 2026-10-22. No repository test asserts this table by
  table yet: the committed tests check a floor of 30 forced tables and, in
  `scripts/verify_rls.sh`, seven named tables and cross-workspace reads, and a
  few feature suites check their own tables.
- **Separated database roles.** The owner role `momo` creates the schema and
  runs migrations. At runtime the stack connects the API as `momo_app`
  (`NOSUPERUSER NOBYPASSRLS`). Three background consumers that poll across
  tenants connect as `momo_relay` (outbox relay), `momo_worker` (agent worker)
  and `momo_notifier` (push and lifecycle notifier), each `NOSUPERUSER
  BYPASSRLS` (`infra/rust/sql/bootstrap_runtime_roles.sql`). The owner `momo` is
  the database superuser; only the one-shot `runtime-roles` and `migrate` jobs
  log in as it, and every long-running service uses one of the roles above. The
  stack creates no other login role that bypasses RLS; the helper roles that
  migrations add are `NOLOGIN NOBYPASSRLS`.
- **Role posture is checked at deploy time, not when the API starts.** In the
  self-host stack the `runtime-roles` service provisions the roles,
  `momo-migrate` refuses to migrate unless the four runtime roles have exactly
  that posture, and the API, relay, webhook sender and agent worker start only
  after `migrate` has succeeded (`infra/rust/docker-compose.rust.yml`,
  `server-rust/bins/momo-migrate/src/main.rs`). `scripts/oort doctor` reports a
  blocker when the API's database URL does not use `momo_app`. The API's request
  pool does not check which role it connected as. One part of the API process
  does: the scheduled-message tick (ADR-0208) asks its own pool which role it is
  at boot (and again every tick interval while the database could not answer),
  and on a role that skips row-level security it neither ticks nor accepts
  schedules (the routes answer 503 `scheduler_disabled`).
- **Fail-closed configuration.** `momo-server` refuses to start when, in
  `staging`, `prod`, `production` or `internal-host`, the realtime proxy secret
  is missing or a placeholder; when `PROVIDER_LINK_MASTER_KEY` or
  `GITHUB_APP_MASTER_KEY` reuses the JWT secret or another master key; when a
  webhook master key is missing, or the two webhook master keys are the same
  value (unless both are still the legacy copy of the JWT secret, which boots
  with a warning); or when the in-memory `stub` file archive is selected in a
  deployed environment
  (`server-rust/bins/momo-server/src/config.rs`, covered by unit tests that run
  in PR CI).
- **Image provenance.** Published images come from a manually dispatched
  workflow that runs only on `main` and waits for the `release` Environment's
  required reviewer. It builds each architecture with buildx provenance and an
  SBOM, then attests what each build pushed and the final manifest-list digest
  with SLSA v1 provenance (`.github/workflows/publish-images.yml`).
  Verification is manual: the `gh attestation verify` command in
  `releases/latest.json` (`attestation.verify_cmd`) checks the manifest-list
  digest, which is the digest to pin. In digest mode `scripts/oort doctor`
  checks that the image is pinned by digest and that the command exists; it
  does not run it.

Deployment details and verification procedures are in
[`docs/SELF_HOST.md`](docs/SELF_HOST.md).

## Secrets and provider credentials

Keep production secrets out of source, image layers, command-line arguments,
logs, diagnostics, issue reports, and gate evidence. The self-host generator
creates the JWT secret, the database role passwords and each master key as
separate random values for a fresh install, and writes the env file with mode
0600 (`scripts/self_host_env.sh`); an upgrade of an older install backfills the
two webhook keys as copies of the JWT secret and `oort doctor` warns until you
rotate them (ADR-0004 amendment 4). Public PR CI runs gitleaks on every pull
request into `main` or a track branch (`.github/workflows/pr-ci.yml`). Use a
separate value for each trust domain:
the server refuses to start when `PROVIDER_LINK_MASTER_KEY` or
`GITHUB_APP_MASTER_KEY` reuses the JWT secret or another master key.

Model-provider credentials follow
[ADR-0004](docs/adr/0004-codex-oauth-hermes-provider-boundary.md) and its
amendments, by kind:

- **API keys and the Hermes bearer.** A key or bearer you enter in settings, and
  a personal key an admin issues to a member, is stored in PostgreSQL as
  AES-256-GCM ciphertext sealed under `PROVIDER_LINK_MASTER_KEY`, never as
  plaintext; a personal key also keeps a keyed HMAC fingerprint that detects
  reuse. The API shows back at most the last four characters of a team key and
  nothing of a personal key. When a provider echoes a key back in an error, the
  key reaches no stored row (tests
  `anth_3_the_key_never_reaches_a_durable_row_even_when_echoed`, which also
  scans TRACE logs, `b51_4_the_operators_bearer_never_reaches_a_row_a_message_or_an_error`
  and `no_row_carries_the_key`, all (PG)). A bearer you supply through the
  operator environment (`HERMES_API_KEY`) is only as protected as that
  environment.
- **Subscription logins** (ChatGPT/Codex, Claude). These stay outside oort: in
  the operator's Hermes volume, or in the official CLI login on a member's own
  machine.
  oort refuses to create new subscription-token
  (`auth.json`) links (test `a_new_oauth_link_is_refused`). A link of that kind
  that an instance created before 2026-09-27 stays sealed in that instance, and
  is still refreshed, until it is deleted.
- **One-time login codes.** The operator-only login relay passes a one-time code
  through oort once: the code an operator pastes goes on to the Hermes login
  sidecar, and the sidecar's device code and authorization URL come back in the
  start response. oort does not store, log or audit them (test
  `markers_never_cross_oort_in_any_channel` (PG)).

The model provider or Hermes you choose is a separate trust boundary: oort sends
it bounded work context directly.

For deployment, rotation, backup, and incident procedures, follow
[`docs/SELF_HOST.md`](docs/SELF_HOST.md) and
[`docs/runbooks/pgbackrest-pitr.md`](docs/runbooks/pgbackrest-pitr.md).
