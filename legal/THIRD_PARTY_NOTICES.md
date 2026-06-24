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

## 전이 의존성(주요, 자동 생성 권장)
- SwiftNIO 계열(apple/swift-nio*) — Apache-2.0 (대부분).
- swift-crypto, swift-collections, swift-atomics 등 — 각 LICENSE 확인.

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
