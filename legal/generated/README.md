# GHCR third-party notice bundle

Canonical generated attribution for the two GHCR images (`oort` app +
`oort-postgres`). Produced from `server-rust/Cargo.lock` and
`clients/web/package-lock.json`. This is a reproducible inventory of license
files, not legal advice and not a claim of legal sufficiency.

## Files

| Path | Role |
|---|---|
| `GHCR_THIRD_PARTY_NOTICES.txt` | Canonical generated bundle (deduped license/NOTICE blobs + package index) |
| `GHCR_NOTICE_MANIFEST.json` | Input lockfile hashes, per-package SPDX/copyright/file hashes, image-file hashes |
| `GHCR_NOTICE_BUNDLE.sha256` | `sha256sum` manifest of the four files Docker copies |
| `license-file-clarify.json` | Reviewed fallbacks for packages whose tarball has SPDX but no LICENSE file |
| `spdx-texts/` | SPDX license texts used only by those fallbacks and optional-not-installed npm packages |
| `DEBIAN_COPYRIGHT_INVENTORY.txt` | Evidence from an image dpkg copyright scan (regenerated inside Docker) |

Hand-maintained index: `legal/THIRD_PARTY_NOTICES.md` (current vs historical).
Project files: repo-root `LICENSE`, `NOTICE`.

## Regenerate

```sh
python3 scripts/generate_ghcr_notice_bundle.py generate
scripts/check_ghcr_notice_bundle.sh
```

`generate` needs `cargo metadata --offline` (crates in the local registry) and
`clients/web/node_modules` (`npm ci --prefix clients/web`). The stale gate
itself hashes the lockfiles and the committed bundle and does not need those
trees.

Policy (allow/deny) is a different gate: `scripts/check_cargo_licenses.sh` and
`scripts/check_npm_licenses.mjs`. Do not widen `deny.toml` here.
