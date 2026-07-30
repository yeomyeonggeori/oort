# 불변식 보존 스펙 — Rust 재작성의 수용 계약 (D2)

> ADR-0145 B안 Phase 0 산출물 D2. **재작성이 이 표를 위반하면 실패다.** D1(`server-rust.md`) crate 배선 위에서 하드 불변식 각각의 강제 지점 + DB 백스톱 + "깨는 red 테스트"를 확정. red 테스트 규율(momo 전통): **모든 불변식은, 되돌리면 이름 붙은 단정이 실패하는 형태로 증명한다.**

## 0. 이 스펙의 논리

실측: 59 마이그레이션 중 ~30개가 RLS 정책, 9개가 트리거, 34개 함수, 224개 CHECK로 **정합성을 DB가 강제**. 따라서 재작성의 임무는 세 가지다 —
1. **마이그레이션을 손대지 않고 재사용**(DB 강제층 그대로 상속).
2. **앱 계층을 DB 강제를 우회할 수 없게 배선**(chokepoint·GUC·타입).
3. **각 불변식을 red 테스트로 고정**(대부분 기존 게이트 픽스처가 이미 제공).

즉 불변식은 "새로 구현"이 아니라 "DB에 이미 있는 걸 앱이 못 깨게 배선 + 증명"이다.

## 1. 하드 불변식 → Rust 강제 지점 (CLAUDE.md 하드룰 기준)

| # | 불변식 | Rust 앱 강제 지점 | DB 백스톱(재사용) | 깨는 red 테스트 (되돌리면 실패) |
|---|---|---|---|---|
| 1 | **Postgres = SoT** | 모든 진실은 PG에만 write. Centrifugo/Redis/캐시는 파생 — 도메인 crate가 진실을 캐시에서 읽지 않음 | outbox durable(재생 가능) | **relay/Centrifugo 콜드 재시작 후** 클라 재구독 시 상태 손실 0 — outbox 재생으로 복원. 캐시에서 진실을 읽으면 실패 |
| 2 | **Centrifugo = 전송전용** | `momo-relay`만 Centrifugo `/api/publish` 호출. 도메인 crate·클라는 Centrifugo에 쓰기 authority 없음 | relay 롤 `momo_relay`만 publish 자격 | 클라가 Centrifugo에 직접 publish → 그 데이터가 **PG/후속 relay에 반영 안 됨**(무권위). Centrifugo 페이로드를 진실로 승격하면 실패 |
| 3 | **단일 쓰기경로**(REST→PG→outbox→relay) | **`momo-outbox::emit_outbox()` 유일 egress** — 이 crate만 `outbox` SQL 소유(컴파일러 벽). 도메인 write는 `with_tenant_tx` 안에서 도메인 row + `emit_outbox`를 **같은 tx** | `outbox_notify_trg`(`001_init.sql:432`) AFTER INSERT `pg_notify` | 브로드캐스트 대상 write의 tx를 **롤백하면 도메인 row와 outbox row가 함께 사라짐**(원자성). 도메인 crate에서 raw `INSERT INTO outbox` 추가 = 빌드/리뷰 차단 |
| 4 | **순서 = `message.seq`**(gapless, PG sequence 금지) | `momo-messaging`가 `channel_seq` **row-lock** `UPDATE...RETURNING`로 채널당 직렬 부여(앱코드) | `message_seq_uniq UNIQUE(channel_id, seq)`(`001_init.sql:184`); **PG sequence·트리거 없음** | 동시 2 write가 같은 seq 노리면 **UNIQUE 위반으로 하나 실패→재시도**, 결과 seq에 gap·중복 0. row-lock을 sequence/`nextval`로 바꾸면(=gap 허용) gapless 단정 실패 |
| 5 | **에이전트 = member** | `momo-messaging`(identity) — 사람·에이전트가 **동일 `member` 테이블**, 채널 멤버십·권한·seq 경로 공유. `kind='agent'`만 분기 | `member` 스키마 단일, 별도 봇 테이블 없음 | 에이전트가 member로서 채널에 write→동일 seq/outbox 경로 탐. 에이전트를 별도 경로로 특례화하면 "동일 경로" 단정 실패 |
| 6 | **RLS FORCE** | `momo-db::with_tenant_tx`가 tx 시작 시 `SET LOCAL app.workspace_id`(유일 배선 지점). api 롤 `momo_app`=`NOBYPASSRLS`. actor는 SQL 파라미터(actor GUC 없음) | `FORCE ROW LEVEL SECURITY` 35회 + `CREATE POLICY` 36회 (신규 테이블마다 추가) | **workspace A 세션에서 workspace B의 row SELECT/UPDATE → 0 rows**(cross-tenant 누출 차단). GUC 세팅을 빼거나 BYPASSRLS 롤로 도메인 쿼리를 돌리면 누출→단정 실패 |
| 7 | **provider 자격증명 비유입**(ADR-0004/0144) | `momo-provider` 어댑터 경계 — provider 자격증명은 서버 PG·로그에 저장 안 됨(sandbox-internal login). 어댑터는 참조/링크만 | 자격증명 원문 컬럼 부재 | provider 등록→세션→종료 smoke 후 **PG dump·서버 로그에 provider 시크릿 문자열 0건**. 자격증명을 서버가 보관하도록 바꾸면 유입 스캔 단정 실패 |

## 2. red 테스트 출처

- 위 대부분은 **기존 게이트/통합 픽스처가 이미 제공** — 동일 마이그레이션 DB에 Rust 서버를 조준(D5 conformance suite)하면 그대로 재사용. 신규 필요분: #3 원자성(tx 롤백 동시성), #6 cross-tenant 누출은 명시 테스트로 승격해 **무회귀 세트 편입**(파이프라인 교훈: 세트 밖 검증기는 언젠가 조용히 red).
- 각 red 테스트는 "이름 붙은 단정 + 되돌리면 실패"를 만족해야 채택(막연한 "non-2xx 통과" 금지 — 파이프라인 교훈).

## 3. 배선 불변(재작성이 바꾸면 안 되는 것)
- `schema_v0.sql`·59 마이그레이션 **수정·이동 금지**(하드룰) — 그대로 실행.
- `outbox` SQL 소유 crate = `momo-outbox` 단 하나.
- RLS GUC 세팅 지점 = `momo-db::with_tenant_tx` 단 하나.
- 롤 분리 유지: `momo_app`(NOBYPASSRLS) / `momo_relay`·`momo_notifier`(BYPASSRLS, 파생·재조정 전용).

## 다음
- **D3**: ADR-0146 provenance 서명 — #3/#6을 하나도 안 건드린다는 걸 이 표에 교차검증(서명은 authenticity만, 순서·격리·쓰기경로 불변).
- **D5**: 위 red 테스트를 conformance suite로 조립(동일 DB, "동일 요청→동일 상태·응답").
