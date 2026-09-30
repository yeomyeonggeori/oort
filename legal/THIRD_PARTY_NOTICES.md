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
- `clients/mobile` npm graph (license-gated in full by
  `scripts/check_npm_licenses.mjs --root clients/mobile`; not bundled)
- `clients/web-legacy` (not the SPA the Rust image copies)
- in-app “Open Source Licenses” UI (#35)

### Server direct additions

Direct `server-rust` dependencies an ADR introduced. Their full license texts
are already in the generated bundle above (they are in `server-rust/Cargo.lock`);
this table only records why they are there.

| Component | Version | License | Where | Introduced by |
|---|---|---|---|---|
| p256 (RustCrypto; brings ecdsa, elliptic-curve, primeorder, sec1 and their RustCrypto deps) | 0.14.0 | Apache-2.0 OR MIT | `server-rust/crates/momo-wire` (human device-key P-256 verification) | ADR-0146 개정 2026-09-28 D-1, #3021 |
| unicode-normalization | 0.1.25 | MIT OR Apache-2.0 | `server-rust/crates/momo-wire` (NFC of signed human text; was already transitive via sqlx) | ADR-0146 개정 2026-09-28 D-5, #3021 |
| fastembed (fastembed-rs; `default-features = false`, no hf-hub / image models) | 7.1.0 | Apache-2.0 | `server-rust/crates/momo-embed` (loads the int8 ONNX sentence model and runs it) | ADR-0196 D8 증보 2026-09-30, #3173 |
| ort / ort-sys (pykeio/ort, ONNX Runtime bindings; `load-dynamic`: no ONNX Runtime binary is downloaded or linked at cargo build time) | 2.0.0-rc.13 | MIT OR Apache-2.0 | via fastembed, `momo-embed` | same |
| libloading (nagisa/rust_libloading; already in the graph via ort, now also a direct dependency that checks `ORT_DYLIB_PATH` before ort sees it) | 0.9.0 | ISC | `server-rust/crates/momo-embed` | same |
| tokenizers (Hugging Face) | 0.23.2 | Apache-2.0 | via fastembed, `momo-embed` | same |

### Embedded model and ONNX Runtime (worker image; not Cargo crates)

The agent-worker embeds team-memory items locally (ADR-0196 D8 증보, #3173). Two artifacts ride in
the app image that the generated Cargo bundle cannot list, because they are not crates. Neither is
committed to git: the model is downloaded at image build from a pinned Hugging Face revision and
verified by sha256 (`server-rust/model/e5-small-int8.sha256`, `server-rust/Dockerfile` stage
`model-payload`); the ONNX Runtime shared library is Microsoft's own release
(`onnxruntime-linux-<arch>-1.28.2.tgz` from github.com/microsoft/onnxruntime, sha256-pinned per
architecture in the Dockerfile stage `ort-payload`) and is loaded at run time by `momo-agent-worker`
through `ORT_DYLIB_PATH`.

| Component | Version / revision | License | Where it lives | Attribution |
|---|---|---|---|---|
| `intfloat/multilingual-e5-small` model weights (int8 ONNX file `onnx/model_qint8_avx512_vnni.onnx` and tokenizer files) | Hugging Face revision `614241f622f53c4eeff9890bdc4f31cfecc418b3` | MIT (Hugging Face model-card metadata `license: mit`; the repository ships no separate LICENSE file) | `/opt/momo/models/e5-small-int8/` in the app image | Wang, Yang, Huang, Yang, Majumder, Wei: “Multilingual E5 Text Embeddings: A Technical Report” (arXiv:2402.05672, 2024); model card https://huggingface.co/intfloat/multilingual-e5-small. The training-data licences were not audited (only the model's declared licence was checked). |
| ONNX Runtime (shared library `libonnxruntime.so`, unmodified Microsoft release) | 1.28.2 | MIT | `/opt/momo/lib/libonnxruntime.so` in the app image; its LICENSE and ThirdPartyNotices.txt (the notices of what ONNX Runtime itself bundles) are copied to `/usr/share/licenses/momo-rust/onnxruntime/` | Copyright (c) Microsoft Corporation, https://github.com/microsoft/onnxruntime (LICENSE text below) |

ONNX Runtime licence text (MIT), reproduced because a binary redistribution must carry it:

```
MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The model weights are MIT as declared by their authors; the same permission notice applies to them.
Weights are used unmodified apart from the int8 quantisation the upstream repository publishes.

### Adapted designs and prompts (no code copied)

Team memory v2 (ADR-0196 D2) adapts ideas and wording from Apache-2.0 and MIT projects. Nothing below is a
dependency and no upstream source file is redistributed; the prompts are rewritten in Korean for
oort. They are listed because ADR-0196 D2 requires attribution for translated or reworked prompts.

| Upstream | License | What was adapted | Where in oort | Introduced by |
|---|---|---|---|---|
| company-brain (Supermemory Inc., https://github.com/supermemoryai/company-brain, commit ef8a45e) | Apache-2.0 | Collection policy: what to keep permanently vs let decay, never store the state of a system a connected tool owns, no chit-chat or secrets (`src/brain/memory/profile-config.ts`, `BRAIN_CAPTURE_POLICY`); curation prompt: agent and bot statements are not facts, keep the original wording and dates, at most six items per batch (`src/brain/slack/channel-observe.ts`, `DISTILL_SYSTEM`) | `server-rust/bins/momo-agent-worker/src/extract.rs` (`SYSTEM_WINDOW_ITEMS`) | ADR-0196 D2, #3168 |
| mem0 (Mem0, Inc., https://github.com/mem0ai/mem0, v3) | Apache-2.0 | Add-only, single-pass extraction: one model call returns new memories and never edits existing ones (`mem0/configs/prompts.py`, `ADDITIVE_EXTRACTION_PROMPT`) | same prompt; the add-only write path `mem_add_item` (`server/Migrations/104_mem_item.sql`) | ADR-0196 D2/D4, #3168 |
| Hindsight (Vectorize AI, Inc., https://github.com/vectorize-io/hindsight, commit eb021da, MIT, Copyright (c) 2025 Vectorize AI, Inc.) | MIT | Consolidation flow: candidate observations → judge whether they say the same thing → fold the losing one into the winner keeping time bounds and evidence, every step logged (`hindsight-api-slim/hindsight_api/engine/consolidation/consolidator.py`, `prompts.py`; the code lived under `hindsight_api/engine/consolidation/` when ADR-0196 was written). Re-implemented over PostgreSQL functions; the Korean judging prompt is written for oort and is not a translation | `server/Migrations/107_mem_consolidate.sql` (`mem_cons_pairs`, `mem_cons_apply`, `mem_cons_merge_items`), `server-rust/bins/momo-agent-worker/src/consolidate.rs`, `server-rust/crates/momo-agent/src/memory_cons.rs` | ADR-0196 D2/D4, #3172 |
| Graphiti (Zep Software, Inc., https://github.com/getzep/graphiti, commit 852ca40, Apache-2.0; no NOTICE file upstream) | Apache-2.0 | Contradiction resolution over a bi-temporal fact: when a newer fact contradicts an older one whose validity is still open, the older one's validity ends where the newer begins (`invalid_at = new valid_at`) instead of being deleted (`graphiti_core/utils/maintenance/edge_operations.py`, `resolve_edge_contradictions`). Only the interval rule is adapted; the graph database is not used | `server/Migrations/107_mem_consolidate.sql` (`mem_cons_close_item`, `mem_item.valid_to` / `closed_by_id`), `server-rust/bins/momo-agent-worker/src/consolidate.rs` (`SYSTEM_JUDGE_DECISION`) | ADR-0196 D2/D3, #3172 |

### Phone client direct additions

Direct phone dependencies or copied assets that an ADR or design issue introduced. The
full transitive graph is still only license-gated, not bundled.

| Component | Version | License | Where | Introduced by |
|---|---|---|---|---|
| expo-blur | 57.0.3 | MIT | `clients/mobile` (npm + CocoaPods `ExpoBlur`) | ADR-0189 D6, #2714 (tab bar glass) |
| Lucide icon paths `home`·`inbox`·`search`·`plus` | via design mockup A | ISC | `clients/mobile/src/design/icons/*.png` (rasterized) | #2714 (shell icons; same set the web uses as `lucide-react`) |

### Desktop client direct additions

Direct desktop (Tauri shell) dependencies an ADR introduced. The full
`clients/desktop/src-tauri` Cargo graph is license-gated by
`scripts/check_cargo_licenses.sh`, not bundled.

| Component | Version | License | Where | Introduced by |
|---|---|---|---|---|
| portable-pty | 0.9.0 | MIT | `clients/desktop/src-tauri` (local terminal PTY) | ADR-0190 D1, #2772 |
| libc | 0.2 | MIT OR Apache-2.0 | `clients/desktop/src-tauri` (process-group signals for PTY sessions) | ADR-0190 D1, #2772 |
| p256 | 0.13.2 | Apache-2.0 OR MIT | `clients/desktop/src-tauri` (device key: compressed SEC1, DER→raw low-s, self-verify) | ADR-0146 개정 2026-09-28 D-1, #3025 |
| unicode-normalization | 0.1.25 | MIT OR Apache-2.0 | `clients/desktop/src-tauri` (NFC for signed human text, same as `momo-wire`) | ADR-0146 개정 2026-09-28 D-5, #3025 |
| security-framework / -sys, core-foundation, objc2, objc2-foundation, objc2-app-kit | 3 / 2, 0.10, 0.6, 0.3, 0.3 | MIT OR Apache-2.0 (objc2*: also Zlib) | `clients/desktop/src-tauri` (Secure Enclave key, LAContext, NSAlert); already in the graph via keyring/tauri, now direct | ADR-0146 개정 2026-09-28 D-3, #3025 |
| reqwest | 0.13.4 | MIT OR Apache-2.0 | `clients/desktop/src-tauri` (the shell's own `/v1/auth/refresh` rotation with the refresh-key proof); already in the graph via tauri-plugin-updater, now direct, no crate added | ADR-0146 D-7 증보 #3079, #3106 |

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
| motion | https://github.com/motiondivision/motion | MIT | 웹 UX-R1b AnimatePresence (⌘K·스레드 패널·390 드로어 exit). 직접 의존 1개 |
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
