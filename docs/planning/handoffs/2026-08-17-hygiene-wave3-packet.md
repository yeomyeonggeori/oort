# 위생 파도 3 핸드오프 패킷 — #1466·#1468·#1478·#1403 (4 goal 병렬)

> 2026-08-17 Fable 발급 · Status: `ready` · 워커: 단발 무명 Opus 5 ×4.
> planning ID: **PLN-20260815-01** (owner: Fable · integrator: momo-main) · supersedes: 없음
> 정본 goal: 각 GitHub Issue 본문(1차 정본) + 본 패킷 goal별 절. ADR 불요 4건 전부.
> 병렬: 파일군 분리 — #1466=server-rust config·#1468=momo-core(chat/work copy)+웹 소비·#1478=momo-core(timeline)+웹/폰 소비·#1403=clients/web(hostedAgents). #1468과 #1478은 둘 다 momo-core지만 **다른 파일**(경과 카피 vs bodySlot 판정) — 교차 수정 금지가 계약.
> 기준 커밋: **origin/track/engine 최신**(`1852aa62` 이후 — 착수 시 fetch). **전 goal `scripts/goal_claim.sh <n> --base track/engine` 명시** — 특히 #1403은 제목 `[uxui]` 태그가 title-tag 소스에 걸려 track/uxui로 오분기하는데 그 파일은 engine에만 있다(#1464 랜딩분의 flag 우선순위가 이를 이긴다).

## 공통 계약

- 표준 절차: claim → 구현 → 검증 → PR(`## 계획 이탈`) → `goal_release.sh <n> --review` → 정지. merge/close 금지.
- ADR-0132 정직 규율·schema 비접촉·시크릿 비유입·공유 계약 파일 변경 시 소비 테스트+typecheck(저널 교훈)·템플릿 §5.1 공통 함정.
- UI/카피 변경 goal(#1468·#1478·#1403)은 momo-design-taste-web(웹) 프리플라이트 자가 수행 — design-review는 오케스트레이터 몫.

## #1466 — REPORT_PROTOCOL config 플래그 (server-rust만)

- 좌표: `server-rust/bins/momo-agent-worker/src/lib.rs`(assemble 호출부의 `SystemBlocks.report_protocol` — #1454 랜딩분)·`config.rs`(기존 config 패턴 준수).
- 계약: 기본 on. off 시 컨텍스트 바이트 동일(기존 `no_protocol_means_the_context_is_exactly_what_it_was` 동형 테스트). 클라 비접촉.
- 검증: cargo clippy·test+관련 스위트.

## #1468 — 경과 낱말 3종 정렬 + 「1초 미만 동안 작업」 카피

- 좌표: `packages/momo-core/src/features/work/workSessionFormat.ts`(`SESSION_WORKED_SUFFIX`·`sessionElapsedReadout`)·`WorkSessionDetail.tsx` MetaRow 「실행 시간」·`completionReportCard.ts`의 카드 「작업 시간」 라벨(#1440).
- 임무: 같은 측정값의 세 낱말(「~동안 작업」/「실행 시간」/「작업 시간」)을 정렬하는 **낱말 결정 1문단**(전부 통일이 정답이 아닐 수 있다 — 자리의 격이 다르면 그 근거를 적고 유지도 유효한 결정) + `formatElapsed(0)` 경로의 「1초 미만 동안 작업」 어색함 처치. 카피 단일 소스 규율.
- 계약: 코어 판정 로직 비접촉(카피만)·기존 testid 유지·#1478의 bodySlot 파일 비접촉.
- 검증: 코어+웹 스위트·typecheck·(카피 변경 시) 캡처 재실측.

## #1478 — 공백-본문 판정 core 이관 (웹/폰 패리티)

- 좌표: `clients/web/src/features/timeline/bodySlot.ts`(#1465 — 현 웹 로컬 `hasRenderableBody`)·`clients/mobile/src/features/conversation/MessageRow.tsx`(`body !== ''` 갈래)·이관처=`packages/momo-core/src/features/timeline/`(적절한 기존 파일 또는 신설 — agentCardModel 시맨틱 비접촉).
- 임무: trim 판정을 core 단일 소스로, 웹·폰이 같은 답 소비. 폰의 공백-본문 빈 줄 해소. 웹 계약 테스트(#1465분) 이관 정합.
- 계약: `keepsBody` 비접촉·묘비/편집기 전치 유지(웹 기존 테스트가 지킴)·#1468의 카피 파일 비접촉.
- 검증: 코어+웹+폰 스위트·typecheck 전부(3소비자).

## #1403 — CleanupArtifactRow 트리거 native disabled → aria-disabled

- 좌표: `clients/web/src/features/hostedAgents/CleanupArtifactRow.tsx`(이슈 제목의 그 트리거). 이슈 본문·E7 리뷰 맥락 참조.
- 임무: native `disabled`를 `aria-disabled`+동작 차단으로 — 포커스 도달·AT 인지 가능하게(디자인 시스템 키보드/포커스 규율). 동일 패턴이 그 파일군에 더 있으면 같은 PR에서 일관 처리(범위는 hostedAgents 내로 한정, 초과는 이탈 보고).
- 검증: 웹 스위트·typecheck·프리플라이트·키보드 실측(포커스 링·Enter/Space 무동작 확인).

## 이탈·착수 (공통)

계약과 다르면 PR `## 계획 이탈`, 판단 필요 시 `--blocked` 정지. 최종 보고: PR URL·게이트 실측(정직)·이탈 요약.

## 컨텍스트 델타

- 새로 고정: #1464 랜딩 후에도 [uxui] 제목 태그 잔존 이슈는 명시 `--base`가 필요(라벨 정비 전까지). 파도 내 momo-core 병렬은 파일 단위 배타로 성립.
- 의도적 미결정: #1468 낱말 통일 여부(워커 결정 1문단) · #1478 이관처 파일(워커 판단).
