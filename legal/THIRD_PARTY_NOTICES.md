# momo — 제3자 오픈소스 고지 (Third-Party Notices)

> permissive 의존성 귀속 고지. 배포물(앱 내 "오픈소스 라이선스" 화면)에 노출.
> 근거: Apache 2.0 §4(d) 귀속 보존(NOTICE를 파일/문서/앱 화면 중 1곳 이상), MIT 저작권+라이선스 전문 포함.
> 출처: https://www.apache.org/licenses/LICENSE-2.0
> **라이선스 표기는 각 저장소 LICENSE로 검증할 것(아래는 통상값, TODO 검증).**

## 직접 SwiftPM 의존성 (Package.swift 추출)
| 패키지 | URL | 통상 라이선스(검증 필요) | 사용처 |
|---|---|---|---|
| swift-log | https://github.com/apple/swift-log | Apache-2.0 | 전 패키지 로깅 |
| hummingbird | https://github.com/hummingbird-project/hummingbird | Apache-2.0 | server(HTTP) |
| async-http-client | https://github.com/swift-server/async-http-client | Apache-2.0 | worker/relay HTTP |
| swift-service-lifecycle | https://github.com/swift-server/swift-service-lifecycle | Apache-2.0 | 서비스 수명주기 |
| jwt-kit | https://github.com/vapor/jwt-kit | MIT | server 인증 |
| postgres-nio | https://github.com/vapor/postgres-nio | Apache-2.0 | DB 드라이버 |
| centrifuge-swift / SwiftCentrifuge | https://github.com/centrifugal/centrifuge-swift | MIT(검증됨, 0.9.0 LICENSE) | macOS Centrifugo live subscription |
| SwiftTerm | https://github.com/migueldeicaza/SwiftTerm | MIT(검증됨, 1.14.0 LICENSE) | macOS Interactive Work Console 로컬 PTY |
| swift-protobuf | https://github.com/apple/swift-protobuf | Apache-2.0(검증 필요) | SwiftCentrifuge 전이 의존성 |
| swift-snapshot-testing / SnapshotTesting | https://github.com/pointfreeco/swift-snapshot-testing | MIT(검증됨, 1.19.2 LICENSE) | **테스트 전용** — macOS MessageBubble light/dark 스냅샷(MOMO-318). 배포 앱 번들 미포함 |

## 전이 의존성(주요, 자동 생성 권장)
- SwiftNIO 계열(apple/swift-nio*) — Apache-2.0 (대부분).
- swift-crypto, swift-collections, swift-atomics 등 — 각 LICENSE 확인.
- **테스트 전용(배포 앱 번들 미포함)** — swift-snapshot-testing이 resolve하는 swift-custom-dump·xctest-dynamic-overlay(둘 다 MIT, Point-Free), swift-syntax(Apache-2.0). `SnapshotTesting` product만 import하므로 이 전이 타깃들은 컴파일되지 않는다(단, `Package.resolved`에는 등장).

## 웹 클라이언트 npm 의존성 (clients/web, MOMO-391)
> 브라우저 번들에 포함되는 런타임 의존성만 표기. dev 도구(vite/eslint/
> typescript/openapi-typescript/playwright 등)는 배포물 미포함 — 전이 포함
> 전체 인벤토리는 `clients/web/scripts/check-licenses.mjs`가 게이트마다 생성.

| 패키지 | URL | 라이선스(lockfile 검증) | 사용처 |
|---|---|---|---|
| react / react-dom / scheduler | https://github.com/facebook/react | MIT | 웹 UI |
| centrifuge (centrifuge-js) | https://github.com/centrifugal/centrifuge-js | MIT | 웹 Centrifugo live subscription |
| protobufjs + @protobufjs/* | https://github.com/protobufjs/protobuf.js | BSD-3-Clause | centrifuge-js 전이(protobuf 코덱; JSON 사용이라 번들에서 tree-shake 대상) |
| long | https://github.com/dcodeIO/long.js | Apache-2.0 | protobufjs 전이 |
| events | https://github.com/browserify/events | MIT | centrifuge-js 전이 |

## 런타임 인프라(앱 번들 외 — 서버 배포물)
| 컴포넌트 | 라이선스(검증) | 메모 |
|---|---|---|
| Centrifugo v6 | MIT/OSS(검증) | 메시지 전송계층(셀프호스트) |
| PostgreSQL 18 | PostgreSQL License(permissive) | DB |

## Apache 2.0 NOTICE 집계
- 각 Apache-2.0 의존성의 NOTICE 파일 내용을 리포 루트 `NOTICE`에 집계(있는 것만).

---
> TODO(Codex): `Package.resolved`로 전이 의존성 전체를 자동 수집하는 스크립트(`scripts/gen-notices.sh`)로 이 표를 생성·갱신.
> 각 라이선스는 저장소 LICENSE 파일로 SPDX 확정. permissive 외(GPL/AGPL 등) 발견 시 즉시 보고(AGENTS.md §9).
