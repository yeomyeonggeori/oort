# Third-party notices (자동 생성 — scripts 없이 Package.resolved+checkouts 실측, 2026-07-22)

| 패키지 | 버전 | 라이선스 | 출처 |
|---|---|---|---|
| async-http-client | 1.34.0 | Apache-2.0 | https://github.com/swift-server/async-http-client |
| centrifuge-swift | 0.9.0 | MIT | https://github.com/centrifugal/centrifuge-swift |
| client-sdk-swift | 2.15.2 | Apache-2.0 | https://github.com/livekit/client-sdk-swift |
| hummingbird | 2.25.0 | Apache-2.0 | https://github.com/hummingbird-project/hummingbird |
| jwt-kit | 5.2.0 | MIT | https://github.com/vapor/jwt-kit |
| livekit-uniffi-xcframework | 0.0.6 | Apache-2.0 | https://github.com/livekit/livekit-uniffi-xcframework |
| postgres-nio | 1.33.0 | MIT | https://github.com/vapor/postgres-nio |
| swift-algorithms | 1.2.1 | Apache-2.0 | https://github.com/apple/swift-algorithms |
| swift-argument-parser | 1.8.2 | Apache-2.0 | https://github.com/apple/swift-argument-parser |
| swift-asn1 | 1.7.1 | Apache-2.0 | https://github.com/apple/swift-asn1 |
| swift-async-algorithms | 1.1.4 | Apache-2.0 | https://github.com/apple/swift-async-algorithms |
| swift-atomics | 1.3.0 | Apache-2.0 | https://github.com/apple/swift-atomics |
| swift-certificates | 1.19.1 | Apache-2.0 | https://github.com/apple/swift-certificates |
| swift-collections | 1.6.0 | Apache-2.0 | https://github.com/apple/swift-collections |
| swift-configuration | 1.2.0 | Apache-2.0 | https://github.com/apple/swift-configuration |
| swift-crypto | 4.5.0 | Apache-2.0 | https://github.com/apple/swift-crypto |
| swift-custom-dump | 1.6.1 | MIT | https://github.com/pointfreeco/swift-custom-dump |
| swift-distributed-tracing | 1.4.1 | Apache-2.0 | https://github.com/apple/swift-distributed-tracing |
| swift-http-structured-headers | 1.7.0 | Apache-2.0 | https://github.com/apple/swift-http-structured-headers |
| swift-http-types | 1.6.0 | Apache-2.0 | https://github.com/apple/swift-http-types |
| swift-log | 1.13.2 | Apache-2.0 | https://github.com/apple/swift-log |
| swift-metrics | 2.11.0 | Apache-2.0 | https://github.com/apple/swift-metrics |
| swift-nio | 2.101.0 | Apache-2.0 | https://github.com/apple/swift-nio |
| swift-nio-extras | 1.34.1 | Apache-2.0 | https://github.com/apple/swift-nio-extras |
| swift-nio-http2 | 1.44.0 | Apache-2.0 | https://github.com/apple/swift-nio-http2 |
| swift-nio-ssl | 2.37.1 | Apache-2.0 | https://github.com/apple/swift-nio-ssl |
| swift-nio-transport-services | 1.28.0 | Apache-2.0 | https://github.com/apple/swift-nio-transport-services |
| swift-numerics | 1.1.1 | Apache-2.0 | https://github.com/apple/swift-numerics |
| swift-protobuf | 1.38.1 | Apache-2.0 | https://github.com/apple/swift-protobuf |
| swift-service-context | 1.3.0 | Apache-2.0 | https://github.com/apple/swift-service-context |
| swift-service-lifecycle | 2.11.0 | Apache-2.0 | https://github.com/swift-server/swift-service-lifecycle |
| swift-snapshot-testing | 1.19.2 | MIT | https://github.com/pointfreeco/swift-snapshot-testing |
| swift-syntax | 603.0.2 | Apache-2.0 | https://github.com/swiftlang/swift-syntax |
| swift-system | 1.7.2 | Apache-2.0 | https://github.com/apple/swift-system |
| swiftterm | 1.14.0 | MIT | https://github.com/migueldeicaza/SwiftTerm |
| webrtc-xcframework | 144.7559.11 | MIT | https://github.com/livekit/webrtc-xcframework |
| xctest-dynamic-overlay | 1.10.1 | MIT | https://github.com/pointfreeco/xctest-dynamic-overlay |

## npm (web 런타임 의존)
| react | MIT
|  react-dom | MIT
|  centrifuge | MIT |

## 웹 클라이언트 npm 의존성 (clients/web, MOMO-391)
> 브라우저 번들에 포함되는 런타임 의존성만 표기. dev 도구(vite/eslint/
> typescript/openapi-typescript/playwright 등)는 배포물 미포함 — 전이 포함
> 전체 인벤토리는 `clients/web/scripts/check-licenses.mjs`가 게이트마다 생성.

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

`examples/eve-momo-channel/package-lock.json`의 eve world 런타임 그래프는
Apache-2.0, MIT, ISC, BSD-2/3-Clause, 0BSD, BlueOak-1.0.0, Python-2.0 및
`(AFL-2.1 OR BSD-3-Clause)`로만 구성됨을 MOMO-538에서 확인했다. GPL/AGPL/
SSPL/BUSL 항목은 없다.

## Apache 2.0 NOTICE 집계
- 각 Apache-2.0 의존성의 NOTICE 파일 내용을 리포 루트 `NOTICE`에 집계(있는 것만).

---
> TODO(Codex): `Package.resolved`로 전이 의존성 전체를 자동 수집하는 스크립트(`scripts/gen-notices.sh`)로 이 표를 생성·갱신.
> 각 라이선스는 저장소 LICENSE 파일로 SPDX 확정. permissive 외(GPL/AGPL 등) 발견 시 즉시 보고(AGENTS.md §9).
