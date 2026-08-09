# 핸드오프 패킷 SRV-B5 — 엔진 소배치 (3-goal 체인)

- status: **ready** · worker: SRV-B3 워커 재기동(맥락 보유) · 기준: `origin/track/engine` 최신 · goal별 브랜치·PR 순차
- 구성: 전부 소형 — 승인 축 잔여 + 카피 정직성 + 스펙 정합.

## Goal 1 — #1019 work run 경로에도 enabled_tools
네 #1018 이탈 1 그대로: `work_job_payload`에 `tools` 키 부재(선존재). `load_eligible_agent_in_tx`가 프로필 동반 읽기 → 멘션 경로와 같은 이름 배선. 검증: work run 턴의 provider 요청에 툴 실림/빈 배열 안 실림 + red proof(멘션 경로 스위트 무회귀).

## Goal 2 — #1032 서버 발신 한국어 조사
`mention.rs:703 paused_mention_body` · `a2a.rs:256` — 받침 판별 소함수(마지막 한글 음절 U+AC00 산술, (code-0xAC00)%28!=0 → 받침 있음) 신설·두 곳 적용. 비한글 끝(영문·숫자)은 현행 병기 유지(정직 폴백). Swift 원본은 미수정(이식 원본 규율 — 주석으로 기록만). 검증: 실DB paused 멘션 단정에 "루나는"/"오르트는" + red proof.

## Goal 3 — openapi 승인 스키마 표기 정합 (배치 1 적립분)
실측된 어긋남: `docs/api/openapi.yaml`의 `ApprovalProjection`·`ApprovalDecisionReceipt`가 snake_case인데 Rust DTO는 camelCase(`#[serde(rename_all)]`) — 클라가 양표기 읽기로 방어 중이나 **스펙이 거짓말**. 스펙을 실제 와이어(camelCase)로 정정 + **계약 게이트가 응답 바디 표기를 실제로 검증하는지** 확인(못 잡았던 사각 — 잡게 만들 수 있으면 한 단정 추가, 크면 이탈 보고). Swift가 살아있는 동안의 이중 표기 사실은 스펙 주석에 명시.

## 공통
수정: server-rust/** + docs/api/openapi.yaml. 클라·core 금지. goal마다 cargo 전체+관련 실DB+red proof → PR("Closes #10XX") → SendMessage 보고. 턴 규율(20분·마일스톤 보고) 유지.
