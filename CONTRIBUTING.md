# Contributing to oort

> 한국어 원문: [CONTRIBUTING.ko.md](CONTRIBUTING.ko.md)

oort is released under Apache-2.0. Contributions are welcome.

Please follow the [Contributor Covenant](CODE_OF_CONDUCT.md). Report security
issues privately per [SECURITY.md](SECURITY.md) — do not open a public issue.
Notable product changes are listed in [CHANGELOG.md](CHANGELOG.md).

## DCO (Developer Certificate of Origin)

Every commit must be signed under [DCO 1.1](https://developercertificate.org/) —
include this trailer in the commit message:

```
Signed-off-by: Your Name <your@email.com>
```

`git commit -s` adds it. A DCO signature confirms you have the right to submit
the contribution under the project license (Apache-2.0). There is no separate
CLA.

## How to contribute

1. Open an issue first (changes that move a design boundary follow the ADR
   process — `docs/adr/0100-*`).
2. Keep pull requests small, with tests or verification scripts.
3. PRs that violate the hard invariants (PostgreSQL is the source of truth,
   single write path, RLS FORCE, provider-credential non-ingress —
   `docs/architecture/overview.md`) are not accepted.
4. UI changes are reviewed against `.claude/skills/momo-design-taste`.

## PR trust gates

Canonical-branch PRs need both the current head `PR CI gate` and the base-only
`Policy integrity gate`. The same GitHub Actions App/context alone does not
prove workflow provenance, so the integrator does not run scripts from the
candidate checkout. Per ADR-0153 D5, immediately before merge they run the
following exact-base wrapper from a checkout whose wrapper bytes match the
PR's exact canonical base branch/HEAD. The wrapper extracts and runs only the
verifier from the base object and ignores worktree/candidate verifier bytes.

```bash
scripts/verify_policy_integrity_from_base.sh \
  --repo yeomyeonggeori/oort --pr <PR-number>
```

Changes to protected policy files must be authored by the designated policy
owner `kwakseongjae` (GitHub user id `87296259`). After an exact
`Policy-Integrity-Audit: <40sha>` comment from that same owner, the same owner
must apply the `policy-change-approved` label. In the GitHub org that account's
`author_association` is `MEMBER`, so the string `OWNER` is not used as proof of
authority. If the head, comment, or label transition changes, the evidence must
be rebuilt. Trust and bootstrap procedure live in `docs/GITHUB_OPS.md` and
`docs/LOCAL_PR_GATE.md`.

## Secrets

The gates check whether credentials landed in a commit. Every profile includes
this check, so you do not have to remember a separate step. To run it alone
right after a commit (~3 seconds):

```bash
scripts/local_gate.sh --profile secrets   # = regression tests + scripts/check_secrets.sh
```

`gitleaks` is required (`brew install gitleaks`). Missing the scanner **fails
closed** — a green result without a scanner cannot tell a clean history from an
unscanned one.

False positives go in `.gitleaksignore` as one fingerprint line
(`<commit>:<file>:<rule>:<line>`) plus the reason for the call. **Do not quote
the detected value in that reason** — the quote itself becomes a new finding.
If it is a real leak, rotate the key before adding a fingerprint. Full rules:
`docs/LOCAL_PR_GATE.md`, "Secret scan gate (#1236)".

## Dependency licenses

oort is a permissive stack. If you add or change a dependency, run the matching
gate before the PR and attach the result.

```bash
scripts/local_gate.sh --profile license   # cargo + npm in one shot
```

Policy is written in two places that **state the same policy** — do not edit
only one of them.

| Target | Policy | Gate |
|---|---|---|
| cargo (`server-rust`, `clients/desktop/src-tauri`) | root `deny.toml` | `scripts/check_cargo_licenses.sh` (needs `cargo-deny`) |
| npm (workspace root = `packages/momo-core`, `clients/web`, `clients/mobile`) | `ALLOWED` in `scripts/check_npm_licenses.mjs` | the same script |
| GHCR redistribution notices (app + postgres images) | generated artifact `legal/generated/` (not policy) | `scripts/check_ghcr_notice_bundle.sh` + `scripts/tests/test_ghcr_notice_bundle.sh` |

- **Allowed**: MIT · Apache-2.0 · ISC · BSD family · 0BSD · Zlib · Unicode-3.0 · Unlicense · CC0-1.0 · CDLA-Permissive-2.0 · BlueOak-1.0.0 · Python-2.0 · CC-BY-4.0 (data) · **MPL-2.0**.
- **Rejected (fail-closed)**: GPL/AGPL/LGPL · SSPL · BUSL · EPL · CDDL · CC-BY-SA/NC and other copyleft or commercially restricted families, and **unknown licenses**.
- SPDX expressions are evaluated **before** name matching. An OR with a
  permissive branch (`MIT OR Apache-2.0 OR LGPL-2.1-or-later`) passes; an AND
  with a copyleft side is rejected.
- **MPL-2.0 is allowed** (corrected 2026-08-10). MPL-2.0 is file-level weak
  copyleft and does not affect Apache-2.0 distribution of a work that only
  links to it (MPL-2.0 §3.3). The current tree already has 30 instances
  (cargo 5 = Servo CSS stack and similar, desktop-only; npm 24 = lightningcss
  and platform binaries — zero on the server backbone). The benchmark target
  block/buzz made the same call in its `deny.toml`. Earlier wording said
  "MPL family fail-closed reject", but the gate never actually enforced that.
- A license not on the list is **rejected by default.** Add the SPDX id to
  both policy files and leave a comment saying *which package, and why it is
  compatible with Apache-2.0 redistribution*. Quiet expansions are reverted
  in review.

## Third-party notices

Two roles, each written in one place.

- **Policy (allow/deny)** — the table above. Do not widen `deny.toml` /
  `check_npm_licenses.mjs` from this section.
- **Attribution** — the Cargo and `clients/web` npm graphs redistributed in
  the two GHCR images. Canonical file:
  `legal/generated/GHCR_THIRD_PARTY_NOTICES.txt`. Index:
  `legal/THIRD_PARTY_NOTICES.md` (current vs historical). The image ships
  four files: `LICENSE` · `NOTICE` · the index · the generated bundle.

If you change `server-rust/Cargo.lock` or `clients/web/package-lock.json`,
regenerate in the same PR:

```bash
python3 scripts/generate_ghcr_notice_bundle.py generate
scripts/check_ghcr_notice_bundle.sh
```

`generate` needs `cargo metadata --offline` and
`npm ci --prefix clients/web`. The stale gate looks only at lockfile hashes
and will still score RED/GREEN if that tree is missing. Missing SPDX or
LICENSE files fail closed. The automation is a reproducible inventory, not a
declaration of legal sufficiency.

**The SwiftPM license gate (`scripts/check_spm_licenses.sh`) is retired**
(2026-08-10, #1201). The SwiftPM section in `legal/THIRD_PARTY_NOTICES.md` is
a **historical snapshot** from that date. If you change SwiftPM dependencies
in the remaining Swift tree, update that historical section by hand and
explain why in the PR.

Desktop Tauri Cargo, mobile npm, and the in-app "Open Source Licenses" UI are
outside this notice bundle (#35).
