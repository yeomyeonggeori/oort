# 위생 파도 4 핸드오프 패킷 — #1476·#1488·#1489·#1490·#1491 (5 goal 병렬)

> 2026-08-17 Fable 발급 · Status: `ready` · 워커: 단발 무명 Opus 5 ×5.
> planning ID: **PLN-20260815-01** (owner: Fable · integrator: momo-main) · supersedes: 없음
> 정본 goal: 각 GitHub Issue 본문(1차 정본 — 파도 3까지의 폐곡선 산물이라 좌표가 정확함) + 본 패킷 공통 계약. ADR 불요 5건 전부(#1491은 전권 위임 결정 기집행 — 이슈 본문에 결정 근거 3항).
> 병렬: 파일군 완전 분리 — #1476=momo-core(timeline/artifacts)·#1488=web(hostedAgents CleanupArtifactRow)+core(disconnect 카피)·#1489=mobile(MessageRow)·#1490=web(settings SettingsFields)·#1491=core(work/workSessionFormat)+웹/폰 캡처. **momo-core 3-goal(#1476·#1488·#1491)은 서로 다른 파일 — 교차 수정 금지가 계약.**
> 기준 커밋: **origin/track/engine 최신**(#1493 sync 이후 — 착수 시 fetch). claim은 `scripts/goal_claim.sh <n> --base track/engine` 명시(#1489는 폰 goal이지만 파일이 engine 트랙 정본).

## 공통 계약

- 표준 절차: claim → 구현 → 검증 → PR(`## 계획 이탈`) → `goal_release.sh <n> --review` → 정지. merge/close 금지.
- ADR-0132 정직 규율·schema 비접촉·공유 계약 파일 변경 시 소비 테스트+typecheck·템플릿 §5.1 공통 함정·UI/카피 goal은 웹 프리플라이트 자가 수행(design-review는 오케스트레이터).
- red proof 문화: 수리 무력화 시 새 테스트가 빨개짐을 1회 실측·복구.

## goal별 핵심 (이슈 본문이 상세 정본)

- **#1476**: `packages/momo-core/src/features/timeline/artifacts.ts:570` `body === undefined` 방어를 null-포함으로 — runtime null이 `looksLikeUnifiedDiff(null)` TypeError→타임라인 백지화(#1465 워커 재현 절차가 이슈에). 3태(null/undefined/'') 안전+재현 픽스처 red→green. 힌트: #1478이 랜딩한 코어 `bodySlot.ts`의 `hasRenderableBody`가 같은 물음 — 재사용 검토(새 판정 발명 금지).
- **#1488**: `CleanupArtifactRow.tsx` AcknowledgeForm의 `!ready && choice===null` 도달 불가 카피 — 코어 `acknowledgeReady` 실측 후 결정 1문단(그 문장이 필요한 상태 실재 여부)+해소. #1403 랜딩분(`1be4b087`)·#1486 회전과 같은 파일이므로 최신 HEAD 기준 재실측 필수.
- **#1489**: `clients/mobile/src/features/conversation/MessageRow.tsx:842` `` `작업 시간 ${elapsed}` `` 리터럴 → 코어 `WORKED_ELAPSED_LABEL`(#1487 신설) 소비+폰 계약 테스트. 낱말 불변이므로 렌더 무변경이 계약.
- **#1490**: `SettingsFields.tsx` ConfirmButton에 SaveButton식 `busyLabel` 이식 — 처분 확정 saving의 가시 진행 신호(#1486 회전이 남긴 한 폼 두 갈래 불일치). 겸: 진행 낱말꼴(「저장 중」 vs 「~하는 중」) 정렬 검토 1문단. 소비처(CleanupArtifactRow 등)는 #1488과 파일 겹침 주의 — **ConfirmButton 내부+SettingsFields만 접촉**, 소비처 배선이 필요하면 이탈 보고로 momo-main에 넘겨라.
- **#1491**: `SESSION_STATUS_CLASS.done` ok→muted(결정 기집행 — 이슈 근거 3항). 웹/폰 소비 정합+캡처 재실측(#1441 캡처 레인 재사용)+계약 테스트. 통과 세션에서 검증 칩(ok)만 초록이 되는 그림이 목표.

## 이탈·착수 (공통)

계약과 다르면 PR `## 계획 이탈`, 판단 필요 시 `--blocked` 정지. 최종 보고: PR URL·게이트 실측(정직)·이탈 요약.

## 컨텍스트 델타

- 새로 고정: 위임 결정(#1491)은 이슈에 결정 근거를 싣고 구현 goal로 발급하는 방식.
- 의도적 미결정: #1488 카피 처치(워커 결정 1문단)·#1490 낱말꼴 정렬 범위(검토 1문단, 실행은 별도 판단).
