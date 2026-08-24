# 그록봇 도어벨 파도 패킷 — WD-1~WD-3

> Status: `ready` (2026-08-24 성재 승인 — ADR-0171 Accepted·발사 신호 수령) · Planning ID: `PLN-20260822-01` 연장 · Planner owner: Fable · Integrator: momo-main
> 발급: 2026-08-24 · 기준 커밋: `d66ca97a`(main) · Supersedes: 없음
> 근거 ADR: WD-1=**ADR-0171 (Proposed — 성재 Accept 필요)** · WD-2=ADR-0171 범위 내 UI · WD-3=문서
> 근거 리서치: `research/2026-08-24-grokbot-webhook-doorbell.md`(웹훅 트리거 실측) · `research/2026-08-24-realtime-autonomous-mention-research.md`(업계 3축)
> **라이브 실측(2026-08-24)**: 그록봇 루틴 webhook — `POST https://api2.cursor.sh/automations/webhook/<uuid>` + `Authorization: Bearer crsr_…` → **HTTP 200 `{"success":true,"runUuid":…}` 0.95s · POST→봇 ACK 총 지연 9s**(08:51:35Z→08:51:44Z). 스파이크 루틴 `oort-doorbell-spike` 성재 계정에 생성됨.
> GitHub binding: WD-1=#1734 · WD-2=#1735 · WD-3=#1736 (2026-08-24 발급) · 워커: grok 4.6 병렬 1 · 발사 신호 수령(2026-08-24 성재)

## 0. 전제 (기결 사항 승계)

- Q-STRUCT(2026-08-22): 본인 그록봇 계정/VM 전용 — 도어벨 등록도 사용자가 자기 루틴의 URL/key를 자기 oort 인스턴스에 넣는 구조. 공용 대행 없음.
- Q-CDP(2026-08-22): 그록봇 앱 프로그램 제어 금지 유지 — 도어벨은 앱이 아니라 **제품 제공 webhook endpoint**로의 서버 발신이라 저촉 없음(ADR-0171 판정).
- 스파이크 2단계(Agent Port 폐곡선)는 이 파도의 E2E 수용과 동일 — 별도 선행 불요, WD-3 지시문으로 흡수.

## 1. Goal 체인·순서

| 순서 | goal | 트랙 | 파일군 | 게이트 |
|---|---|---|---|---|
| G1 | WD-1 서버 도어벨 (등록 REST·봉인 저장·sender dispatch·쿨다운·projection·audit) | engine | `server-rust/crates/momo-webhook/`·`momo-auth/`·`bins/momo-webhook-sender/`·마이그레이션 | **ADR-0171 Accept** |
| G2 | WD-2 Agent Hub 도어벨 등록 UI | uxui | `clients/web/src/features/hostedAgents/`·`agentHub/` | WD-1 계약 확정 후 · design-review B0 |
| G3 | WD-3 SELF_HOST_AGENT.md 증보 + 프로덕션 루틴 지시문 | engine(docs) | `docs/SELF_HOST_AGENT.md`·`llms.txt` | WD-1 계약 확정 후 |

머지 순서 G1→G3 순차. E2E 수용(성재)은 G3 후 자연어 릴레이로.

## 2. 티켓별 계약

### WD-1 서버 도어벨 — `[server]` ADR-0171 D1~D7

**사실**: 송신 체계는 `momo-webhook` crate + `bins/momo-webhook-sender`가 기존재 — `subscriptions.rs`(닫힌 event kind 집합 `event_subscription_event_kinds_ck`, 493L)·`outbound.rs`(Swift OutboundHTTPPolicy 이식본, 454L — SSRF 가드 재사용 지점)·`crypto.rs`(시크릿 봉인, 246L). hosted connection 원장은 `momo-auth/src/hosted_connection.rs`(1044L, create/get/list `_in_tx` 계열). inbox append는 원본 tx 내(HAP-E5).
**작업**: ①커넥션 도어벨 등록/해제 tenant REST(AEAD 봉인·write-only 마스킹·audit — `crypto.rs` 재사용) ②sender에 "doorbell" 대상 유형 편입: hosted inbox append 파생 소비→커넥션당 leading-edge+60s 쿨다운 코얼레싱→상수 페이로드 `{"kind":"oort.doorbell.v1"}` Bearer POST(타임아웃 10s·retry ≤2) ③`doorbell_last_fired_at/-status` projection ④disconnect/cleanup 시 같은 tx 소거 ⑤`MOMO_DOORBELL_ENABLED` 기본 off.
**AC(red proofs 필수)**: 시크릿 응답·로그 비출현 / OutboundHTTPPolicy 사설망 거부 / 쿨다운 창 내 burst→발화 ≤2(leading+trailing) / disconnect 후 발화 0 / 에이전트 자기 발화→도어벨 0(Q-LOOP) / flag off에서 라우트·동작 byte-동일 / 신규 outbox 생산자 트리거 0(하드 룰). openapi 동기화.
**함정**: outbox 생산자 트리거 신설 금지 — 반드시 기존 sender 소비 경로로. 페이로드에 어떤 식별자도 넣지 말 것(D2).

### WD-2 Agent Hub 도어벨 UI — `[web]` design-review 필수

**사실**: 커넥션 위저드 `clients/web/src/features/hostedAgents/HostedAgentWizard.tsx`·허브 `agentHub/AgentHubRoute.tsx`·첫멘션 온보딩 `FirstMentionOnboarding.tsx`(T-5/T-6 파도 산출).
**작업**: 커넥션 상세 패널에 도어벨 섹션 — URL/key 입력(key는 저장 후 마스킹)·"벨 테스트" 버튼(서버 경유 시험 발화+결과 표시)·last-fired 상태. 4상태(빈/로딩/성공/실패) 필수, momo-design-taste-web 준수.
**AC**: 등록→마스킹 표시→테스트 발화→상태 갱신 폐곡선 E2E · design-review Blocker 0.

### WD-3 플레이북·루틴 지시문 — `[docs=제품]`

**작업**: SELF_HOST_AGENT.md에 ⓐ그록봇 쪽 webhook 루틴 생성 절차(자연어 지시문 표준 — 스파이크 실증 문안 승계) ⓑoort 쪽 도어벨 등록 절차(WD-2 UI) ⓒ**프로덕션 루틴 지시문**: "도어벨 수신 → `oort_inbox_read` → 처리 → `oort_message_post` → 새 정보 없으면 침묵(ADR-0132 발화 규약)" ⓓ15분 스윕 폴백 루틴 지시문 ⓔ약관·usage 고지(도어벨 1회=run 1회=allowance 소모).
**AC**: 플레이북만으로 도어벨 폐곡선 재현 가능 · `check_docs_commands` 그린.

## 3. E2E 수용 (성재 검수 절차)

1. WD-3 프로덕션 지시문을 스파이크 루틴에 교체 적용(자연어 릴레이 — 성재 Enter).
2. oort 데스크탑에서 `@grokbot` 멘션 발화.
3. 관측: 도어벨 발화(projection) → 루틴 run → 에이전트 명의 응답 랜딩. **목표 p50 ≤ 90s**.
4. 부정 경로: flag off 상태 무발화 · 도어벨 실패 시 15분 스윕이 회수.

## 4. 검수 후 정리

- 스파이크 루틴 `oort-doorbell-spike`의 sender key는 실측에 사용됨(세션 한정, repo 비유입) — E2E 후 **루틴 삭제 또는 key 재발급**으로 무효화.
- 기준선 문서(`2026-08-16-grok-ecosystem-2026.md`) 각주 갱신은 momo-main 통합 시.
