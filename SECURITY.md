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
[Report a vulnerability](https://github.com/Dawn-kim-official/momo/security/advisories/new)
form to create a private Security Advisory.

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

oort's production hardening includes:

- **Forced tenant isolation.** Tenant tables use PostgreSQL RLS with
  `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`; API transactions
  set `app.workspace_id` locally.
- **Four separated database roles.** The bootstrap/migration owner `momo` is not
  used by the API. Runtime access is split into `momo_app` (API,
  `NOBYPASSRLS`), `momo_relay` (outbox consumer, `BYPASSRLS`), and
  `momo_worker` (agent job consumer, `BYPASSRLS`).
- **Boot guard.** Production API startup refuses to continue unless
  `current_user` is exactly `momo_app`, is not a superuser, and cannot bypass
  RLS.
- **Fail-closed deployment gates.** Production preflight rejects placeholders,
  unsafe URLs, mutable or inconsistent image references, missing owner
  credentials, unsafe database-role posture, and invalid Compose configuration
  before starting the application.
- **Image provenance.** Release verification uses
  `MOMO_ATTESTATION_POLICY=required` to verify the pinned image's GitHub SLSA
  provenance before pull. The general installer defaults to `warn` so an
  unavailable GitHub CLI or not-yet-published attestation is visible without
  being misrepresented as verified.

Deployment details and verification procedures are in
[`docs/DEPLOY.md`](docs/DEPLOY.md).

## Secrets and provider credentials

Production secrets belong in SOPS/age or a mode-0600 host-local environment,
never in source, image layers, command-line arguments, logs, diagnostics, issue
reports, or gate evidence. Rotate credentials by trust domain rather than
reusing values across JWT, database, relay, webhook, or provider boundaries.

Under [ADR-0004](docs/adr/0004-codex-oauth-hermes-provider-boundary.md), oort
does not own, store, proxy, log, or persist Codex/OpenAI OAuth authorization
codes, access or refresh tokens, or provider API keys. Those remain in the
operator-selected Hermes/provider runtime. oort may hold only the opaque
Hermes-facing bearer required to call that runtime, injected through the
operator's secret environment and redacted from evidence.

For deployment, rotation, backup, and incident procedures, follow
[`docs/DEPLOY.md`](docs/DEPLOY.md) and
[`docs/SECRETS_BACKUP_RUNBOOK.md`](docs/SECRETS_BACKUP_RUNBOOK.md).
