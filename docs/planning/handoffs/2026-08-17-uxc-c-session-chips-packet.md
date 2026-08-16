# UXC-C 핸드오프 패킷 — 세션 경과 성과 단위 표기 + 게이트 상태 칩

> 2026-08-17 Fable 발급 · Status: `ready` · 워커: 단발 무명 Opus 5.
> planning ID: **PLN-20260815-01** (owner: Fable · integrator: momo-main) · supersedes: 없음
> 정본 goal: GitHub Issue **#1441**(status:ready — metadata-only binding). 수용기준 정본 = 본 패킷 §4.
> 근거: ADR 불요(리서치 정본 `docs/planning/research/2026-08-16-cursor-ade-web-ux-benchmark.md` §3-C — 규모 S·표시 규칙만, 경계 무변경). 병렬: **#1454(서버 프로듀서)와 병렬 — 파일군 분리(웹/코어 vs server-rust), 머지 순서 무관(먼저 그린 쪽 먼저)**.
> 기준 커밋: **`track/engine@54f5d2dc`**(#1440 완료 리포트 카드 랜딩 HEAD).

## 1. 미션 요약 (왜 이 작업인가)

커서 웹 ADE 차용 후보 C(리서치 §3-C): 경과 시간을 타이머가 아니라 **성과의 단위**로("Worked for 24m 28s" — 24분의 일이 흘러가버리지 않고 성과로 읽히게), 검증 상태를 **정직 칩**으로 사용자-대면화한다. #1440이 완료 리포트 카드 안에서는 이미 해냈다(`elapsedMs`+게이트 표). 이 goal은 그 문법을 **세션 표면**(WorkPanel 세션 행·WorkSessionDetail)으로 확장한다 — 우리 정직 라벨 문화(ADR-0132)의 사용자-대면화이지 새 데이터 축이 아니다.

두 조각:
1. **경과 성과 단위**: 끝난 세션의 경과를 "몇 m 몇 s **동안 작업**" 격(성과 서술)으로. 진행 중 세션은 지금처럼 살아있는 시계 유지. 시작 시각이 관측되지 않았으면 시계를 짓지 않는다(workingSignal 규율 — "0s"는 우리가 눈치챈 순간이지 시작이 아니다).
2. **게이트/검증 상태 칩**: 세션 표면에 그 세션의 검증 상태를 칩으로. 어휘·톤은 **완료 리포트 카드의 것을 재사용**(`CompletionCheckOutcome`·`COMPLETION_CHECK_TONE`·`completionOutcome`/`completionCheckCounts`) — 새 어휘·새 색 발명 금지. **설계 1문단 선행**: 칩의 데이터 원천(세션에 결부된 completion_report 메시지의 집계인가, 다른 원장인가)과 "데이터가 없는 세션"의 표기(칩 부재 — 부재를 '미검증'이라는 이야기로 승격하지 않는다)를 PR 본문 첫 절에 1문단으로 밝히고 구현과 일치시켜라.

## 2. 필독 코드 좌표 (기준 커밋에서 재확인 — 다르면 코드가 진실, 계약이 다르면 정지+이탈 보고)

- 경과 렌더 현행: `clients/web/src/features/work/WorkPanel.tsx:176`(세션 행 `elapsedLabel`·`work-session-elapsed`) · `clients/web/src/features/work/WorkSessionDetail.tsx:747,799-805,904`(`work-detail-elapsed`).
- 경과 포맷 정본: `packages/momo-core/src/features/agents/workingSignal.ts:298`(`elapsedLabel` — "24m 28s") · 웹 re-export `clients/web/src/features/agents/agentWorkingSignal.ts`.
- 칩 어휘·톤 정본: `packages/momo-core/src/features/timeline/completionReportCard.ts`(`COMPLETION_CHECK_OUTCOME_LABEL`·`COMPLETION_CHECK_TONE`·`completionOutcome`·`completionCheckCounts`·`formatElapsed:395`) · 웹 칩 렌더 선례 `clients/web/src/features/timeline/StatusChip.tsx`(`CompletionReportChip`)·`clients/web/src/features/timeline/completionTone.ts`(톤→토큰 다리·`completionTone.test.ts`가 tokens.css 실측).
- 세션 표면의 기존 정직 장치: `WorkSessionDetail.tsx:1054-1077`(unverified-host 배너 — 빈 스트림을 이야기로 읽지 않는 규율)·`:220`(`work-row-chip`)·`:1022`(`work-control-chip`)·`clients/web/src/features/common/chip.ts`(`CHIP_CLASS`).

## 3. 지켜야 할 계약

- **완료 리포트 카드 본체 비접촉**: `AgentCard.tsx`의 CompletionReportBody·카드 렌더는 #1440 랜딩분 그대로. 코어 `completionReportCard.ts`는 **재사용(import)이 기본**, 필요 시 **가산적 export 추가만** 허용 — 파싱·집계·톤 계약의 의미 변경 금지(#1454 서버 프로듀서가 이 봉투에 conformance 중).
- ADR-0132 정직 규율: fail만 danger·skip/pending은 실패색 아님·unknown은 남긴다·없는 숫자 짓지 않기·부재를 이야기로 승격 금지. `awaiting_approval`을 작업 중으로 그리지 않는다(workingSignal 머리말).
- 톤은 역할→팔레트 2단 계약 유지(코어가 역할, `completionTone.ts`류가 토큰) — 컴포넌트에 색 하드코딩 금지.
- momo-design-taste-web 프리플라이트 + 네 상태(loading/empty/error/성공) 규율. 신규 사용자-가시 문자열은 카피 단일 소스 규율.
- 단일 쓰기경로·스키마 비접촉(이 goal은 표시 규칙만 — 서버/DB 변경이 필요해 보이면 그건 이탈).

## 4. 수용기준 (정본)

1. 끝난 세션의 경과가 성과 단위 서술로 렌더(세션 행+상세, testid 유지·계약 테스트 동반), 진행 중=시계 유지, 시작 미관측=시계 부재.
2. 세션 표면 게이트/검증 상태 칩 — 코어 어휘·톤 재사용, 데이터 원천 설계 1문단이 PR 본문에 있고 구현과 일치, 데이터 없는 세션은 칩 부재.
3. 계약 테스트: 칩 톤이 코어 역할 계약과 일치(completionTone.test.ts 동형), 경과 서술 규칙(끝남/진행/미관측 3분기) 테스트.
4. `pnpm typecheck` + 웹 스위트 그린(§5 교훈), design-review PASS(Blocker 0).

## 5. 알려진 함정 / 컨텍스트

- **사각지대 교훈(2026-08-17 성문화, JOURNAL)**: 공유 계약 파일(코어 계약·토큰 등)을 바꾸면 **그걸 소비하는 테스트+타입까지** 로컬 `typecheck`+해당 스위트로 확인하라. #1456이 template.spec만 바꾸고 displayStream.test.ts를 안 고쳐 track에 잠복 red를 남겼다.
- `elapsedLabel`은 h/m/s 3단 포맷 — 성과 서술 문구를 만들 때 포맷 로직을 복제하지 말고 기존 함수를 감싸라(코어 `formatElapsed`와 웹 `elapsedLabel` 두 계보가 이미 있다 — **어느 쪽을 정본으로 삼는지 설계 1문단에 포함**, 세 번째 계보 발명 금지).
- WorkSessionDetail은 "정직 배너" 위계가 이미 정교하다(:930 근방 주석) — 칩을 배너 위계와 충돌시키지 말 것.
- 세션 행 칩(`work-row-chip`)은 상태 텍스트-우선 계약(:158-165 주석) — 기존 칩을 대체하지 말고 공존 설계.
- 공통 함정은 템플릿 §5.1 전항 적용(특히 게이트 후 `momo-docker-reclaim.sh`).

## 6. 검증

- `scripts/local_gate.sh --profile swift` + `pnpm --filter web test` + `pnpm typecheck`(워크스페이스 루트) — 셋 다.
- design-review 에이전트(오케스트레이터가 실행) 전 momo-design-taste-web 프리플라이트 자가 수행.

## 7. 이탈 보고 의무

수용기준·계약과 다르게 구현하게 되면 PR `## 계획 이탈` 섹션에 기록. 판단 필요 시 `scripts/goal_release.sh 1441 --blocked "<사유>"`로 정지. 임의 재설계 금지.

## 8. 착수 절차

```bash
scripts/goal_status.sh
scripts/goal_claim.sh 1441
# 구현 → 게이트 → PR(이슈 1개, ## 계획 이탈 섹션 포함) →
scripts/goal_release.sh 1441 --review --pr <PR URL>
# 여기서 정지. merge/close/로드맵은 momo-main 몫.
```

## 9. 컨텍스트 델타 (오케스트레이터/다음 planner용)

- 새로 고정: 세션 표면 검증 칩의 어휘=완료 리포트 카드 어휘 재사용(별도 어휘 신설 금지).
- 의도적 미결정: 칩 데이터 원천(워커 설계 1문단으로 상신) · 폰 세션 표면 패리티(#1449 계열로 후속 — 이 goal은 웹만).
- 구현 결과에 따라 재기획: 데이터 원천이 read-model 신설을 요구하면 티켓 분리(이탈 보고로 올릴 것).
