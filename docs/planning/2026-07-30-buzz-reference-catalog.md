# buzz 인용 카탈로그 (D4) — 무엇을 레퍼런스하고 무엇을 거부하나

> ADR-0145 B안 Phase 0 산출물 D4. buzz(block/buzz, Apache 2.0, clone `scratchpad/buzz` `18eef63`)는 **의존이 아니라 코드 레퍼런스**. 이 표가 인용 경계. 라이선스: 인용한 패턴은 파일 헤더에 출처(buzz 경로) 주석 표기(Apache 2.0 attribution).

## 취함 (패턴 인용)
| buzz 패턴 | 근거 | momo 적용 |
|---|---|---|
| **Axum handler 파이프라인** | `buzz-relay` 핸들러 구조 | `momo-server` router·미들웨어 골격 |
| **sqlx 쿼리 스타일** | buzz 전반 | `momo-db` 쿼리 관례(컴파일타임 검증) |
| **connection semaphore 백프레셔** | `state.conn_semaphore.try_acquire_owned()` — 용량 초과 연결 즉시 거부(`ARCHITECTURE.md:181`) | momo relay/게이트웨이 연결 상한 |
| **서브시스템 격리 원칙** | "relay가 오케스트레이터, 서브시스템은 서로 호출 안 함"(`ARCHITECTURE.md:97`) | crate 레이아웃 원칙(D1 §2) |
| **검색 인덱싱 패턴** | buzz FTS | `momo-messaging` search 모듈(단, momo는 pgvector memory도 있음) |
| **워크스페이스 crate 다분할** | buzz 26 crate | D1 crate 골격(단 momo는 굵게 출발) |

## 거부 (momo 불변식과 충돌 — ADR-0145 스파이크)
| buzz 채택분 | 거부 이유 |
|---|---|
| **Nostr 이벤트 모델**(NIP-01 wire, 서명 이벤트 = 진실) | momo는 서버-authored·무서명 message. 단일 쓰기경로와 충돌 |
| **클라-서명-publish**(`["EVENT", ...]`) | 단일 쓰기경로(REST→PG→outbox→relay) 정반대 |
| **`created_at` 순서** | gapless `message.seq`와 충돌 |
| **kind 정수 dispatch**(81 kinds) | momo는 강타입 REST 엔드포인트. 확장 모델 다름 |
| **RLS 부재**(격리=community-key+앱 ctx) | momo RLS FORCE(DB 강제) |
| **NIP-29/42 상호운용**(서드파티 Nostr 클라) | momo는 자체 클라이언트, Nostr 와이어 미채택 |

## 제외 (momo 무관 — 충돌 아님, 그냥 없음)
| buzz 기능 | 사유 |
|---|---|
| **git-over-http** | momo에 네이티브 git 서버 도메인 없음(GitHub은 플러그인 매니페스트). 향후 네이티브 git 도입 시 재검토 |
| huddle voice 등 buzz 고유 UX | momo 자체 설계 있음 |

## 선택 차용 (이점 조각만 — ADR-0146)
- **서명된 행동 = provenance**: buzz의 "모든 행동 서명" 중 momo 도메인에 유효한 조각을 additive로. Nostr 모델 없이 서명 아이디어만. 상세 ADR-0146.
