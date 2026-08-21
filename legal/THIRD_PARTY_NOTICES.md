# Third-party notices

This file is an **index**. It is not the complete attribution record and it
is not legal advice.

| Role | Path |
|---|---|
| Current generated bundle (Cargo + `clients/web` npm) | [`legal/generated/GHCR_THIRD_PARTY_NOTICES.txt`](generated/GHCR_THIRD_PARTY_NOTICES.txt) |
| Input hashes / per-package SPDX | [`legal/generated/GHCR_NOTICE_MANIFEST.json`](generated/GHCR_NOTICE_MANIFEST.json) |
| Image `sha256sum` of the four bundled files | [`legal/generated/GHCR_NOTICE_BUNDLE.sha256`](generated/GHCR_NOTICE_BUNDLE.sha256) |
| Project license | [`LICENSE`](../LICENSE) |
| Project notice | [`NOTICE`](../NOTICE) |

Two gates, two jobs (do not collapse them):

- **Policy (allow/deny):** `deny.toml` + `scripts/check_cargo_licenses.sh` and
  `scripts/check_npm_licenses.mjs`.
- **Attribution freshness:** `scripts/check_ghcr_notice_bundle.sh` (lockfile
  hashes, committed bundle bytes, Docker COPY of the four files).

Regenerate the current bundle:

```sh
python3 scripts/generate_ghcr_notice_bundle.py generate
scripts/check_ghcr_notice_bundle.sh
```

`generate` needs `cargo metadata --offline` and `npm ci --prefix clients/web`.
The stale check hashes lockfiles and does not need those trees.

## Current (GHCR images)

The two images published by `.github/workflows/publish-images.yml` are the
Rust multi-command app (`server-rust/Dockerfile`) and PostgreSQL 18 +
pgBackRest (`infra/rust/postgres-pgbackrest/Dockerfile`). Both copy:

1. `LICENSE`
2. `NOTICE`
3. this index
4. `legal/generated/GHCR_THIRD_PARTY_NOTICES.txt`

App image paths:

- `/usr/share/licenses/momo-rust/`
- `/opt/momo/web/legal/` (staged onto the web-assets volume, so Caddy can
  serve the same bytes at `/legal/…`)

Postgres image path: `/usr/share/licenses/oort-postgres/` (in addition to
the pgBackRest/libssh2 copyright copies from #1330).

Debian OS-layer packages are **not** in the Cargo/npm bundle. Each image
build runs `scripts/check_debian_copyrights.sh` and writes
`DEBIAN_COPYRIGHT_INVENTORY.txt` next to the four files. GPL/LGPL/AGPL in
that inventory are classified `copyleft`, never `permissive`. The inventory
is file-existence evidence, not a legal-sufficiency declaration.

**Not in the current bundle** (out of this goal / other trees):

- `clients/desktop/src-tauri` Cargo graph (Tauri shell, not the GHCR app image)
- `clients/mobile` npm graph
- `clients/web-legacy` (not the SPA the Rust image copies)
- in-app “Open Source Licenses” UI (#35)

## Historical (frozen snapshots)

The sections below are **not regenerated**. They record what earlier trees
shipped. Do not read them as the GHCR attribution record.

<!-- BEGIN GENERATED: SPM LICENSES (generator retired 2026-08-10, #1201) -->
## Swift Package Manager dependencies

> Generated from 10 Package.resolved graphs and checkout LICENSE files.
>
> **Frozen snapshot.** The generator `scripts/check_spm_licenses.sh` retired with
> the Swift client trees (#1201 — it had been red at base and was blocking every
> gate profile). Nothing regenerates or drift-checks this section any more, and
> the two rows below that came from `clients/Core`/`clients/macOS` graphs are
> kept as the historical record of what those trees shipped. If you change a
> SwiftPM dependency in a surviving Swift tree (`server`, `relay/*`,
> `workers/*`, `services/*`), edit this table by hand and say so in the PR.
> cargo and npm licenses are gated separately by `--profile license` (#1225).

| Package | Version | License | Source |
|---|---|---|---|
| async-http-client | 1.35.0 | Apache-2.0 | https://github.com/swift-server/async-http-client.git |
| centrifuge-swift | 0.9.0 | MIT | https://github.com/centrifugal/centrifuge-swift.git |
| client-sdk-swift | 2.15.2 | Apache-2.0 | https://github.com/livekit/client-sdk-swift.git |
| hummingbird | 2.25.1 | Apache-2.0 | https://github.com/hummingbird-project/hummingbird.git |
| jwt-kit | 5.2.0 | MIT | https://github.com/vapor/jwt-kit.git |
| livekit-uniffi-xcframework | 0.0.6 | Apache-2.0 | https://github.com/livekit/livekit-uniffi-xcframework.git |
| postgres-nio | 1.33.1 | MIT | https://github.com/vapor/postgres-nio.git |
| swift-algorithms | 1.2.1 | Apache-2.0 | https://github.com/apple/swift-algorithms.git |
| swift-argument-parser | 1.8.2 | Apache-2.0 | https://github.com/apple/swift-argument-parser |
| swift-asn1 | 1.7.1 | Apache-2.0 | https://github.com/apple/swift-asn1.git |
| swift-async-algorithms | 1.1.5 | Apache-2.0 | https://github.com/apple/swift-async-algorithms.git |
| swift-atomics | 1.3.1 | Apache-2.0 | https://github.com/apple/swift-atomics.git |
| swift-certificates | 1.19.3 | Apache-2.0 | https://github.com/apple/swift-certificates.git |
| swift-collections | 1.6.0 | Apache-2.0 | https://github.com/apple/swift-collections.git |
| swift-configuration | 1.2.0 | Apache-2.0 | https://github.com/apple/swift-configuration.git |
| swift-crypto | 3.15.1, 4.5.1 | Apache-2.0 | https://github.com/apple/swift-crypto.git |
| swift-custom-dump | 1.6.1 | MIT | https://github.com/pointfreeco/swift-custom-dump |
| swift-distributed-tracing | 1.4.1 | Apache-2.0 | https://github.com/apple/swift-distributed-tracing.git |
| swift-http-structured-headers | 1.7.0 | Apache-2.0 | https://github.com/apple/swift-http-structured-headers.git |
| swift-http-types | 1.6.0 | Apache-2.0 | https://github.com/apple/swift-http-types.git |
| swift-log | 1.14.0 | Apache-2.0 | https://github.com/apple/swift-log.git |
| swift-metrics | 2.11.0 | Apache-2.0 | https://github.com/apple/swift-metrics.git |
| swift-nio | 2.101.3 | Apache-2.0 | https://github.com/apple/swift-nio.git |
| swift-nio-extras | 1.34.3 | Apache-2.0 | https://github.com/apple/swift-nio-extras.git |
| swift-nio-http2 | 1.45.0 | Apache-2.0 | https://github.com/apple/swift-nio-http2.git |
| swift-nio-ssl | 2.37.2 | Apache-2.0 | https://github.com/apple/swift-nio-ssl.git |
| swift-nio-transport-services | 1.28.0 | Apache-2.0 | https://github.com/apple/swift-nio-transport-services.git |
| swift-numerics | 1.1.1 | Apache-2.0 | https://github.com/apple/swift-numerics.git |
| swift-protobuf | 1.38.1 | Apache-2.0 | https://github.com/apple/swift-protobuf.git |
| swift-service-context | 1.3.0 | Apache-2.0 | https://github.com/apple/swift-service-context.git |
| swift-service-lifecycle | 2.11.0 | Apache-2.0 | https://github.com/swift-server/swift-service-lifecycle.git |
| swift-snapshot-testing | 1.19.3 | MIT | https://github.com/pointfreeco/swift-snapshot-testing.git |
| swift-syntax | 603.0.2 | Apache-2.0 | https://github.com/swiftlang/swift-syntax |
| swift-system | 1.7.5 | Apache-2.0 | https://github.com/apple/swift-system |
| swiftterm | 1.14.0 | MIT | https://github.com/migueldeicaza/SwiftTerm.git |
| webrtc-xcframework | 144.7559.11 | MIT | https://github.com/livekit/webrtc-xcframework.git |
| xctest-dynamic-overlay | 1.11.0 | MIT | https://github.com/pointfreeco/xctest-dynamic-overlay |
<!-- END GENERATED: SPM LICENSES -->

### Hand-written npm (web-legacy / pre-#1332 partial list)

These rows described `clients/web-legacy` runtime deps and a partial npm
list. They are not the GHCR SPA graph. Current web attribution is the
generated bundle above.

| 패키지 | URL | 라이선스(lockfile 검증) | 사용처 |
|---|---|---|---|
| react / react-dom / scheduler | https://github.com/facebook/react | MIT | 웹 UI |
| centrifuge (centrifuge-js) | https://github.com/centrifugal/centrifuge-js | MIT | 웹 Centrifugo live subscription |
| @xterm/xterm (xterm.js) | https://github.com/xtermjs/xterm.js | MIT | 웹 Work observer 터미널 read-only 렌더러 |
| livekit-client | https://github.com/livekit/client-sdk-js | Apache-2.0 | 웹 허들 오디오 연결 |
| protobufjs + @protobufjs/* | https://github.com/protobufjs/protobuf.js | BSD-3-Clause | centrifuge-js 전이(protobuf 코덱; JSON 사용이라 번들에서 tree-shake 대상) |
| long | https://github.com/dcodeIO/long.js | Apache-2.0 | protobufjs 전이 |
| events | https://github.com/browserify/events | MIT | centrifuge-js 전이 |

### Runtime companions (not inside the two GHCR images as source trees)

Hand-written operator notes. OS-layer bytes in the two GHCR images are
covered by each image's Debian copyright inventory, not this table.

| 컴포넌트 | 라이선스(검증) | 메모 |
|---|---|---|
| Centrifugo v6 | MIT/OSS(검증) | 메시지 전송계층(셀프호스트) — companion service, not baked into the app image |
| PostgreSQL 18 | PostgreSQL License | DB (oort-postgres image) |
| pgvector 0.8.5 | PostgreSQL License | PostgreSQL 벡터 타입·HNSW 검색 확장 |
| pgBackRest 2.59.0 | MIT | PostgreSQL 연속 WAL archive·암호화 backup/PITR |
| libssh2 1.11.1 | BSD-3-Clause/ISC | pgBackRest S3-compatible transport |
| Node.js | MIT | web-build stage only; not a runtime package of the app image |
| eve | Apache-2.0 | optional custom-agent runtime, not the GHCR app image |
| LiveKit Egress | Apache-2.0 | optional transcription profile |
| faster-whisper | MIT | operator transcription harness |

### Work-host sidecar engines (WH-1 / MOMO-579, ADR-0114)

> `infra/prod/docker/workhost.Dockerfile` opt-in sidecar only (not the GHCR
> app/postgres images). **Codex is not bundled.**

| 엔진 | 라이선스 | 배포 | 사용처 |
|---|---|---|---|
| opencode | MIT | GitHub release 단일 바이너리 (`sst/opencode`) | 기본 엔진 |
| goose | Apache-2.0 | GitHub release 단일 바이너리 (`block/goose`) | ACP 엔진 |
| Codex CLI | (미동봉) | 사용자 호스트 설치 | 로컬 연결 전용 |
