# Third-party notices

<!-- BEGIN GENERATED: SPM LICENSES (scripts/check_spm_licenses.sh) -->
## Swift Package Manager dependencies

> Generated from 10 Package.resolved graphs and checkout LICENSE files. Do not edit this section manually.

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

## npm (web 런타임 의존)
| react | MIT
|  react-dom | MIT
|  centrifuge | MIT |

## 웹 클라이언트 npm 의존성 (clients/web-legacy, MOMO-391)
> 브라우저 번들에 포함되는 런타임 의존성만 표기. dev 도구(vite/eslint/
> typescript/openapi-typescript/playwright 등)는 배포물 미포함 — 전이 포함
> 전체 인벤토리는 `clients/web-legacy/scripts/check-licenses.mjs`가 게이트마다 생성.
> (ADR-0119 v0 — MOMO-596이 `clients/web`에서 `clients/web-legacy`로 이동. 새
> `clients/web`(ADR-0133) 의존성은 배포물에 아직 포함되지 않아 미표기.)

| 패키지 | URL | 라이선스(lockfile 검증) | 사용처 |
|---|---|---|---|
| react / react-dom / scheduler | https://github.com/facebook/react | MIT | 웹 UI |
| centrifuge (centrifuge-js) | https://github.com/centrifugal/centrifuge-js | MIT | 웹 Centrifugo live subscription |
| @xterm/xterm (xterm.js) | https://github.com/xtermjs/xterm.js | MIT | 웹 Work observer 터미널 read-only 렌더러 |
| protobufjs + @protobufjs/* | https://github.com/protobufjs/protobuf.js | BSD-3-Clause | centrifuge-js 전이(protobuf 코덱; JSON 사용이라 번들에서 tree-shake 대상) |
| long | https://github.com/dcodeIO/long.js | Apache-2.0 | protobufjs 전이 |
| events | https://github.com/browserify/events | MIT | centrifuge-js 전이 |

## 런타임 인프라(앱 번들 외 — 서버 배포물)
| 컴포넌트 | 라이선스(검증) | 메모 |
|---|---|---|
| Centrifugo v6 | MIT/OSS(검증) | 메시지 전송계층(셀프호스트) |
| PostgreSQL 18 | PostgreSQL License(permissive) | DB |
| pgvector 0.8.5 | PostgreSQL License(검증됨, upstream LICENSE) | PostgreSQL 벡터 타입·HNSW 검색 확장 |
| Node.js 24.4.1 | MIT(검증됨, upstream LICENSE) | 선택적 eve profile 런타임 베이스 |
| eve 0.27.0 | Apache-2.0(검증됨, npm package metadata/NOTICE) | 선택적 커스텀 에이전트 런타임 + momo 채널 |
| @workflow/world-postgres 5.0.0-beta.27 | Apache-2.0(검증됨, npm package metadata/LICENSE) | eve durable workflow state용 별도 PostgreSQL world |
| LiveKit Egress 1.9.1 | Apache-2.0(검증됨, upstream LICENSE) | 선택적 `transcription` profile 참가자 Track 녹음 |
| faster-whisper 1.2.1 | MIT(검증됨, upstream LICENSE) | 개발/운영자용 사후 전사 실측 하니스 |

`examples/eve-momo-channel/package-lock.json`의 eve world 런타임 그래프는
Apache-2.0, MIT, ISC, BSD-2/3-Clause, 0BSD, BlueOak-1.0.0, Python-2.0 및
`(AFL-2.1 OR BSD-3-Clause)`로만 구성됨을 MOMO-538에서 확인했다. GPL/AGPL/
SSPL/BUSL 항목은 없다.

## 워크 호스트 사이드카 동봉 엔진 (WH-1 / MOMO-579, ADR-0114 증보1)
> `infra/prod/docker/workhost.Dockerfile`로 빌드하는 opt-in 사이드카 이미지에만
> 동봉된다(기본 스택 미포함, `--profile workhost`). 각 엔진 바이너리는 별도
> 이미지 레이어로 분리하고 upstream LICENSE를 `/usr/share/licenses/<engine>/`에
> 함께 동봉한다. **Codex는 미동봉** — `codex-local` 엔진은 사용자 호스트의 자체
> Codex 설치에 연결하며 ChatGPT/OAuth 자격증명 경계는 momo 밖에 남는다(ADR-0004).

| 엔진 | 라이선스 | 배포 | 사용처 |
|---|---|---|---|
| opencode | MIT | GitHub release 단일 바이너리 (`sst/opencode`) | 기본 엔진, HTTP+SSE(`opencode serve`) — OpenCodeHTTPAdapter |
| goose | Apache-2.0 | GitHub release 단일 바이너리 (`block/goose`) | ACP 엔진(stdio) — ACPEngineAdapter |
| Codex CLI | (미동봉) | 사용자 호스트 설치 | 로컬 연결 전용(app-server JSON-RPC/stdio) — CodexJSONRPCAdapter. 이미지에 포함하지 않음 |

opencode(MIT)·goose(Apache-2.0) 모두 permissive이며 AGPL/SSPL/BUSL 백본 금지
원칙에 부합한다. 이미지 빌드 시 엔진 버전/자산 URL·per-arch 체크섬은 오케스트레이터가
확정하여 핀(supply-chain 하드닝)한다.

## Apache 2.0 NOTICE 집계
- 각 Apache-2.0 의존성의 NOTICE 파일 내용을 리포 루트 `NOTICE`에 집계(있는 것만).
- goose(Apache-2.0) 사이드카 동봉 시 upstream NOTICE(있으면)를
  `/usr/share/licenses/goose/`에 함께 포함한다.
