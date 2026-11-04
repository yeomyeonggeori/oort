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

What the code and deployment files enforce today. The claims listed in
[`docs/security/claims.yaml`](docs/security/claims.yaml) are each mapped to the
tests that prove them; `scripts/check_security_claims.py` turns a listed claim
with no test, a test selector that matches nothing, or a lane promise the test
does not keep into a red check
([ADR-0214](docs/adr/0214-security-claims-need-tests.md)). **Today that check runs
in the maintainers' local gate, not yet in public PR CI**; wiring it into PR CI is
a follow-up. Only some bullets below name a claim ID (the tenant-isolation bullet
names TEN-1 to TEN-3); the others cite tests by name but are not yet cross-referenced
to the claims file, and the separated-roles and image-provenance bullets have no
automated test at all. Nothing yet checks a sentence in this page against the
claims file. The
Korean document
linked above gives the file, line and test name behind each item. Tests marked
(PG) need a real PostgreSQL and are `#[ignore]`d in a plain `cargo test`. The
tenant-isolation, auth, push, attachment and webhook suites listed in
`infra/security-pack/selection.txt` run in PR CI's "Security pack" job; the other
`#[ignore]`d suites run in the nightly workflow or by hand
(`cargo test … -- --ignored`).

- **Forced tenant isolation.** Tenant tables use PostgreSQL RLS with
  `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`; API transactions
  set `app.workspace_id` locally (`server/Migrations/001_init.sql`,
  `server-rust/crates/momo-db/src/tenant.rs`; test
  `with_tenant_tx_sets_the_rls_guc` (PG) reads the value back inside the
  transaction and does not test that it is gone afterwards). The catalog test `tenant_catalog_pg`
  asserts, table by table, that every table with a `workspace_id` column has forced
  RLS and a policy on `app.workspace_id`; it runs in PR CI's Security pack (claims
  TEN-1 to TEN-3 in `docs/security/claims.yaml`).
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

## What oort does not do

These are limits, not roadmap promises. We state them because a security page that
only lists strengths is not evidence.

- <!-- limit:LIM-1 -->**oort is not end-to-end encrypted.** The server reads message
  content; search, agents and notification previews depend on it. Slack's own
  security page describes TLS in transit and encryption at rest and makes no
  end-to-end claim
  ([slack.com/resources/why-use-slack/security-at-slack](https://slack.com/resources/why-use-slack/security-at-slack)).
- <!-- limit:LIM-2 -->**No external security audit or penetration test** has been
  done. The tests this page cites are the maintainers' own testing, and claims
  with an ID are published with their proof.
- <!-- limit:LIM-3 -->**No SOC 2, ISO 27001 or similar certification.**
- <!-- limit:LIM-4 -->**Whoever operates a server can read its plaintext messages and
  its database.** Zulip's security model says the same of its own servers: anyone
  with root on the application or database server "can read messages, modify
  history, etc."
  ([zulip.readthedocs.io security model](https://zulip.readthedocs.io/en/latest/production/security-model.html)).
  Choose an operator you trust.

## What we do not publish

To keep disclosure from becoming a map for attackers, we publish controls, test
names, CI links and fixed advisories, and we do **not** publish: details of an
unfixed vulnerability; configuration values or secrets of any running instance;
attack-step-level threat models (summaries only); prompt-injection attack corpora
(method and statistics only); or scan results of running environments. The full rule
is in [ADR-0214](docs/adr/0214-security-claims-need-tests.md).

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
  key reaches none of the tables those tests scan (tests
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

One shared-hosted Hermes serves every workspace of an instance and keeps one session
history (`state.db`) and one memory (`MEMORY.md`, `USER.md`) for all of them. Hermes' own
session search reads that whole history, tool-call arguments included, with no workspace,
requester or channel as a filter, and its memory tool writes the file that every later
session loads into its system prompt, so either one would let a run for one workspace read
what a run for another left, or plant text for it. The repository's configs therefore turn
both off: `memory` and `session_search` are denied toolsets, Hermes' memory switches
(`memory.memory_enabled`, `memory.user_profile_enabled`) are false, and the lock gate
refuses to start a Hermes whose config exposes either tool or leaves a switch on (it checks
the tools Hermes would hand the model, and after the start the live tools and config).
This closes the way a model can read that history. It does not stop Hermes from recording
its sessions in its own volume: those records stay readable to whoever can read the volume
or holds the Hermes API key, and a volume that already holds memory files keeps them until
the operator removes them. This describes repository configuration, not a verified live
deployment. See [ADR-0203 R1–R5](docs/adr/0203-cohosted-agent-detection.md#증보-2026-11-01--공동-호스팅-hermes의-세션-검색기억-도구는-끈다-4898),
the [default config](infra/hermes/config.yaml), and the offline
[gate](infra/hermes/test_lockgate_image_guard.py) and
[config](infra/hermes/test_default_config.py) tests.

The repository's shared-hosted Hermes default selects Codex subscription web
search (`web_search`). Search queries can include conversation content and go
to OpenAI's search processing; returned content is untrusted. We do not promise
query redaction or no retention. The configured surface excludes Hermes page
extraction (`web_extract`), and connector configurations disable the whole `web`
toolset. This describes repository configuration, not a verified live deployment.
See [ADR-0203 W1–W4](docs/adr/0203-cohosted-agent-detection.md#증보-2026-10-30--codex-구독-웹-검색만-허용-4794),
the [default config](infra/hermes/config.yaml), and the offline
[gate](infra/hermes/test_default_config.py) and
[connector](infra/hermes/test_lockgate_connectors.py) tests.

The same default also selects Codex subscription image generation
(`image_generate`, provider `openai-codex` only). The image prompt, and any
picture used as a source, go to OpenAI's image processing. Addresses the model
chooses are not accepted: an oort-owned Hermes plugin refuses every
`image_url` / `reference_image_urls` value that is not empty or a small inline
picture before the tool runs, so Hermes never downloads an address the model
chose and never reads a path it wrote. There is one owner-approved exception
(owner decision of 2026-10-30, so that an animated expression can be edited from
the photo its requester attached): `image_url` alone may also be one short-lived
address of that requester's own photo on this oort instance. The address is
single-use, valid for five minutes, bound to the run, the conversation and that one
attachment, and oort serves the bytes itself (no redirect, no Drive address); every
refusal is the same 404, and oort's token table stores only a hash of the token
(that is the table, not every place the token passes: a token the model repeats in
its reply can still end up in a message). The plugin
compares the address as exact bytes against the one origin the operator configured
plus a fixed path and token shape, never parsing or normalizing it. It sees only
the shape, not whether a token was ever issued, so the workspace and token slots the
model fills in can travel as the request path to that one origin, which answers
anything it did not issue with the same constant 404; with no origin
configured the exception is off. The remaining risks of this path are listed in
ADR-0218 G4. The photo's bytes then go to OpenAI's image
processing like the prompt does, faces included. The lock gate requires that plugin (pinned
bytes, enabled, and exercised with refused and accepted examples, including the
one allowed address and its bypass variants, at every start),
refuses the settings and environment variables that turn Hermes' private-address
filter or the plugin off, refuses a malformed origin (and the origin in the
volume's `.env`), and refuses other image providers, code execution and
`web_extract`; connector configurations disable `image_gen` as well. Generated
pictures are untrusted model output. We do not promise prompt redaction or no
retention. This describes repository configuration, not a verified live
deployment: whether the real Hermes downloads that address (its own private-address
filter applies) is not verified. See [ADR-0203 I1–I4](docs/adr/0203-cohosted-agent-detection.md#증보-2026-10-30--codex-구독-그림-생성만-허용-4820),
[ADR-0218 G4·G8](docs/adr/0218-workspace-expressions.md), the offline
[plugin](infra/hermes/test_image_guard.py) and
[gate](infra/hermes/test_lockgate_image_guard.py) tests, and the in-image proof
[`scripts/tests/test_hermes_image_guard_docker.sh`](scripts/tests/test_hermes_image_guard_docker.sh).

For deployment, rotation, backup, and incident procedures, follow
[`docs/SELF_HOST.md`](docs/SELF_HOST.md) and
[`docs/runbooks/pgbackrest-pitr.md`](docs/runbooks/pgbackrest-pitr.md).
