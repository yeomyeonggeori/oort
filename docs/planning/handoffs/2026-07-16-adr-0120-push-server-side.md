# HANDOFF: ADR-0120 푸시 서버측 배치 — device 등록 + notifier

> Status: `ready`
> Planning ID: `ADR-0120` · Planner owner: `Fable` · Integrator: Fable(엔진/인프라 트랙 momo-main 겸임, 성재 승인 2026-07-15)
> 발급: 2026-07-16 · 기준 커밋: `edb9737` · Supersedes: 없음
> 근거 ADR: `ADR-0120 (Accepted 2026-07-15)` D2/D3/D4 · 대상 goal: MOMO-403, MOMO-404 · 병렬 가능: 아니오 — 403 → 404 직렬(404가 403의 등록 데이터를 소비)
> GitHub binding: 미발급 (Issue 생성 후 metadata-only binding)

## 1. 결정 요약

ADR-0120은 "판정은 서버 한 곳(notifier), 전달은 Dawn 운영 relay, 페이로드는 id-only"를 확정했다. 이 배치는 **iOS 앱·relay 서비스 없이도 선행 가능한 서버측 절반**을 닫는다: ① 기기 등록 REST(P-1 = MOMO-403) ② outbox 소비 notifier worker + 판정 v0 + mock relay 왕복(P-2 = MOMO-404). 실제 APNs 발송(P-3 PushRelay)과 iOS Notification Extension(P-4)은 범위 밖. 스키마(`device`/`push_token`/`push_dispatch_log`)는 day-1부터 존재한다(`server/Migrations/001_init.sql:506-543`).

## 2. Goal 체인과 의존

| 순서 | goal | 이슈 | 의존 | 병렬 |
|---|---|---|---|---|
| 1 | MOMO-403 device/push_token 등록·해지 REST + 수명주기 | (발급 대기) | — | — |
| 2 | MOMO-404 notifier worker(판정 v0 + dispatch_log + mock relay) | (발급 대기) | MOMO-403 | — |

머지 순서: 403 → 404.

## 3. 파일 맵 (기획 시점 @ edb9737)

| 대상 | 위치 | 지금 상태 | 해야 할 변경 |
|---|---|---|---|
| 스키마 | `server/Migrations/001_init.sql:506-543` — `device`(ios/macos)/`push_token`(apns_token/env/topic/invalidated_at)/`push_dispatch_log` | 테이블만 존재, 경로 0 | schema_v0 불변 — 필요 확장(인덱스/제약/outbox kind)은 신규 numbered migration만 |
| 등록 REST | 없음 | — | 신규 `DeviceRoutes.swift`(403). `App.swift` 배선은 최소 줄수 — **UX 트랙과 공유 핫파일이므로 주변 리팩토링 금지** |
| notifier | 없음 | — | 신규 패키지 `workers/NotifierWorker`(404) — `relay/OutboxRelay` 패턴(ServiceLifecycle·SKIP LOCKED·graceful shutdown) 승계 |
| 멘션 판정 원천 | `server/Sources/MomoServer/Routes/MessageRoutes.swift`의 mention projection(서버 재계산) | 존재 | **재사용** — notifier가 멘션을 다시 파싱하지 않는다. MessageRoutes 수정 최소화 |
| APNs 운영 상수 | `docs/DEPLOY.md:447-451` (ES256/1h/429/410→invalidated_at) | 문서 | 410/400 무효화 계약을 dispatch_log·push_token 처리에 반영(실발송은 P-3) |
| e2e | `infra/docker-compose.e2e.yml` | notifier 없음 | 404에서 notifier + **mock relay**(mock-hermes 패턴) 추가, 기본 프로파일 렌더 불변 |
| 게이트 | `scripts/` | — | 403: 신규 registration verifier, 404: 신규 notifier verifier. `LOCAL_PR_GATE.md` 등록 |

## 4. 지켜야 할 계약

- **id-only 불변(ADR-0120 D2)**: relay로 나가는 페이로드(mock 포함)에 메시지 본문·발신자 표시명 등 대화 내용을 절대 싣지 않는다 — `{server_id?, device/push_token ref, badge, channel_id/message_id(또는 그 해시)}` 수준. **mock relay 왕복 검증에 "본문 문자열이 페이로드에 없음" 단정 필수.**
- **판정은 notifier 한 곳(D3)**: API 요청 경로 인라인 발송 금지. 후보 생성→소비는 **같은 tenant 트랜잭션의 내구 기록 + at-least-once 소비 + 멱등 dispatch**로. 구현 형태(신규 outbox kind vs 전용 후보 테이블 vs cursor)는 재량이되 근거를 PR에 기록 — 단 relay의 `kind='broadcast'` 소비와 경합하지 않아야 하고, schema_v0.sql 수정 금지(신규 migration만).
- 등록 REST는 actor binding(자기 device/token만 등록·해지), RLS FORCE, audit_log 기록, 멱등 upsert(재등록=갱신). 401/만료 access 처리 등 인증 문법은 기존 protected 그룹 재사용.
- notifier의 DB role: relay/worker의 BYPASSRLS 패턴 승계 여부 재량 — 신규 role이면 `bootstrap_roles.sql`/검증 스크립트 정합까지(MOMO-383 전례: role 순서 검증). 기존 role 재사용이면 권한 최소성 근거 기록.
- **판정 v0 스코프(D3)**: DM 전건 + 멘션 + 승인 요청만. 채널 전체 알림 설정·DND·mute는 범위 밖 — **UX 트랙 MOMO-395(#401, presence·채널 알림 설정 v0)가 설정 표면을 소유**하므로 notifier는 그 설정의 소비자 자리만 주석으로 남긴다(스키마 선점 금지).
- `clients/**`·`infra/prod/**` 무변경. `docs/api/openapi.yaml` 무변경(웹 v0 표면 아님 — closed-world 게이트는 스펙 내 라우트만 검사하므로 신규 라우트 추가는 무해).
- 이 배치는 브로드캐스트 실시간(Centrifugo)과 무관 — Centrifugo 전송전용 불변식 그대로.

## 5. 알려진 함정 / 컨텍스트

- outbox 테이블은 relay가 `kind='broadcast'`를, AgentWorker 계열이 `agent_job`을 소비 중 — 후보 kind를 추가한다면 두 소비자의 WHERE 절이 서로를 배제하는지 확인(`relay/OutboxRelay/Sources/OutboxRelay/RelayService.swift:11-16`).
- `push_token.invalidated_at` 처리(410/400)는 P-3 실발송의 계약이지만, dispatch_log 기록 형태(apns_status/reason/collapse_id)는 지금 맞춰둔다(`001_init.sql:532-543`).
- 멘션 판정: MessageRoutes가 mention_member_ids를 서버 재계산해 props에 싣는다(#414 리뷰에서 확인) — notifier는 이 산출물 재사용.
- **UX 트랙이 활발히 병렬 머지 중**(직전: PR #418/MOMO-402 — clients/macOS + Dock badge). `App.swift` 배선 충돌 가능성이 유일한 접점 — 배선은 한 블록으로 최소화하고, 머지 시점 rebase는 통합자가 처리.
- e2e의 api 콜드 Swift 빌드는 메모리 압박에 취약 — MOMO-401이 넣은 staggered boot 패턴(`scripts/verify_web_login_smoke.sh` 참조)을 verifier에 승계.
- 시드에는 push 대상 device가 없다 — verifier가 등록 REST로 실제 등록 후 검증(SQL 직삽입 지양, 403의 REST가 정본 경로).

## 6. 검증

- 403: 신규 registration verifier — 등록(멱등 upsert)→조회→해지, cross-tenant/타인 device 거부(403), audit 행, RLS. `runtime-db` 프로파일 + 게이트 등록.
- 404: 신규 notifier verifier — DM/멘션/승인 각 1건 → 후보 생성 → notifier 소비 → `push_dispatch_log` 행 + mock relay 수신(id-only 단정: 본문 문자열 부재) → 중복 소비 없음(재시작 후 재소비 멱등). relay(`broadcast`)·agent_job 소비 무회귀.
- 수용기준 정본: `BUILD_TICKETS.md` `### MOMO-403/404 수용기준`.

## 7. 이탈 보고 의무 · 8. 착수 절차

첫 배치 패킷들과 동일(Fable 에이전트: 라벨 전환 → 브랜치 → 구현 → 게이트 → PR needs-review → 정지, merge 금지).

## 9. 컨텍스트 델타

- 새로 고정: push 후보의 내구 기록·소비 계약(형태는 재량), id-only의 검증 가능한 정의(mock 페이로드 본문 부재 단정), notifier와 MOMO-395 설정 표면의 소비자/소유자 경계.
- 의도적으로 결정하지 않은 것: 후보 기록 형태(kind vs 테이블 vs cursor), notifier DB role 신설 여부, badge 수 계산의 정확도 수준(v0는 근사 허용 — read_state 기반 정밀화는 P-3 전 재검토).
- 재기획 질문: 활성 클라이언트 존재 시 푸시 억제(presence 연동 — ADR-0104 이후), 채널 알림 설정 소비(MOMO-395 랜딩 후), macOS APNs topic 분기.
