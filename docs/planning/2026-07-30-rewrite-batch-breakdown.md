# 재작성 배치 분할 (D6) — 핸드오프 패킷 골격

> ADR-0145 B안 Phase 0 산출물 D6. Phase 0 승인 후 각 배치를 `docs/planning/handoffs/`의 핸드오프 패킷으로 전개(수용기준·red-proof·오케스트레이터 게이트 명시). 워커 모델 Opus 5, Workflow/이름없는 서브에이전트.

## 의존 순서
`B0(골격) → B1(메신저 코어) → {B2(T3), B3(workstream)} → B4(클라 재배선) → B5(workd)`
- B2·B3는 B1 후 병렬 가능(workstream은 work_session 위 읽기 프로젝션이라 B2와 스키마 공유하나 표면 독립).
- provenance(ADR-0146)는 **교차 관심사** — 공유 프리미티브는 B0/B1, 서명 emit은 각 배치에 분산(아래).

## B0 — 워크스페이스 골격 (신규, 최우선)
- Cargo 워크스페이스 + 공유 인프라 5 crate 스켈레톤: `momo-db`(pool·`with_tenant_tx` GUC·마이그레이션 러너=기존 59 SQL 그대로)·`momo-outbox`(`emit_outbox` chokepoint + relay 소비자)·`momo-wire`(서명 포맷·페이로드)·`momo-auth`(JWT·principal·WorkHost 검증)·`momo-provider`(CloudProviderKit 이식).
- provenance 프리미티브 착수: `momo-wire` 서명 페이로드 정의 + `record_provenance` chokepoint 골격 + `action_signature` 마이그레이션(060+).
- 수용: 마이그레이션 러너가 기존 DB를 손대지 않고 세움 + `with_tenant_tx`가 RLS GUC 세팅(D2 #6 red 통과) + `emit_outbox`가 유일 outbox 소유(D2 #3 골격).
- **랜딩됨(PR #927, track/engine `d1e51ddf`)**. 게이트 교훈: **러너는 psql 경유 정본**(시드 마이그레이션 `\if` 조건부 → `sqlx::raw_sql` 불가). B1+ 준수.

## B1 — 메신저 코어 (`momo-messaging`)
- identity(member/agent·workspace·roster·profile/card/credential) · channels(channel·DM·read-state·mention) · message(seq row-lock + `emit_outbox`) · huddle · search/memory.
- **provenance emit: 에이전트 메시지 서명**(ADR-0146 표면 1) — `record_provenance` 사용.
- 수용: D2 red 7개 중 #1~#6 green(#7은 provider=B2) + 에이전트 메시지 서명 검증 + 웹 표면 design-review Blocker 0.
- **랜딩됨(PR #928, track/engine `2cc97bb4`)** — 척추만(identity·channel·message+seq+emit_outbox). conformance #1/#3/#4/#5/#6 green(#2·#7·provenance·HTTP·huddle/search/DM/read-state/mention은 후속). 교훈: message insert가 011 push_candidate 트리거 발화 → outbox 계수는 kind 필터.

## B2 — T3 work runtime (`momo-t3` work-runtime·provisioner·billing 모듈)
- work_session·agent_run·work_control·approval·hosts·terminal·tier·pool + provisioner(`momo-provider` 계약) + billing 원장. ADR-0140/0139/0142/0144 이식(로직·설계는 ADR에 있음, Swift→Rust 번역).
- **provenance emit: workd 작업 이벤트 서명**(표면 2) + **상태 전이 서명**(표면 3 — 승인/위계 결정).
- 수용: D2 #7(provider 비유입) green + T3 수명주기 saga parity + 과금 정밀도 parity.

## B3 — workstream (`momo-t3` workstream 모듈)
- ADR-0143 actor-독립 연속성·목표층(work_session 위 읽기 프로젝션).
- **provenance emit: 상태 전이 서명** 잔여.
- 수용: workstream 표면 parity + 웹 design-review Blocker 0.

## B4 — 클라이언트 재배선
- Tauri/React 클라이언트를 Rust 서버 API에 맞춤. 계약 diff만(대개 동일 — 스키마·응답 보존이 parity 목표).
- `momo-integrations`(plugin·webhook·mcp·admin) 마무리.
- 수용: 클라 E2E parity + design-review.

## B5 — workd Rust (`workd` 바이너리)
- WorkHostDaemon(6.1k Swift) → Rust, `momo-wire` 서명 공유. ACP/Codex/OpenCode 어댑터·PTY attach.
- 동시/후행 결정(D1 §4 미해결): `momo-wire` 공유 이득 크면 조기.
- 수용: workd 계약(UTF-8 바이트 서명) parity + 재부착 실왕복(ADR-0139) 재검증.

## 컷 (D5)
- B0~B5 + parity green → **빅뱅 단일 컷**. Swift 태그 보존(롤백). 상세 D5.
