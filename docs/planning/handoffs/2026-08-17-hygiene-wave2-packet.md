# 위생 파도 2 핸드오프 패킷 — #1465·#1443·#1464·#1467 (4 goal 병렬)

> 2026-08-17 Fable 발급 · Status: `ready` · 워커: 단발 무명 Opus 5 ×4 (goal당 1기).
> planning ID: **PLN-20260815-01** (owner: Fable · integrator: momo-main) · supersedes: 없음
> 정본 goal: GitHub Issues **#1465·#1443·#1464·#1467**(각 이슈 본문이 1차 정본 — 본 패킷은 공통 계약+goal별 좌표 보강). 수용기준 정본 = 각 이슈 Acceptance + 본 패킷 §goal별 절.
> 근거: ADR 불요 4건 전부(표시 규칙/레이아웃/스크립트/테스트 픽스처 — 경계 무변경).
> 병렬: **4 goal 파일군 완전 분리** — #1465=clients/web(timeline)·#1443=clients/mobile+momo-core(chat)·#1464=scripts/·#1467=server-rust(tests만). 머지 순서 무관(먼저 그린 것 먼저, momo-main이 순차 집행).
> 기준 커밋: **origin/track/engine 최신**(#1470 sync 이후 — 착수 시 `git fetch origin track/engine` 후 그 HEAD. `scripts/goal_claim.sh <issue> --base track/engine`으로 claim — #1464가 고치기 전까지 이 플래그가 수동 필수임을 각 워커가 명심).

## 공통 계약 (전 goal)

- 패킷 §8 표준 절차: `goal_status.sh` → `goal_claim.sh <n> --base track/engine` → 구현 → 검증 → PR(`## 계획 이탈` 필수) → `goal_release.sh <n> --review --pr <URL>` → 정지. merge/close 금지.
- ADR-0132 정직 규율·schema_v0 비접촉·시크릿 비유입. 계약과 다르면 임의 재설계 대신 이탈 보고.
- **공유 계약 파일 변경 시 소비 테스트+typecheck까지**(2026-08-17 저널 교훈). 게이트 후 `momo-docker-reclaim.sh`.
- 템플릿 §5.1 공통 함정 전항 적용(`docs/planning/HANDOFF_TEMPLATE.md`).

## #1465 — 웹: body=null 완료 리포트 카드의 빈 본문 문단 (폰 패리티)

- 좌표: `clients/web/src/features/timeline/MessageRow.tsx:572-619`(keepsBody면 `body ?? ""`를 MessageBody에 무조건 전달 — 빈 `<p>` 한 줄) · `packages/momo-core/src/features/timeline/agentCardModel.ts:678-681`(`keepsBody` 판정 — summary 없으면 true) · 폰 대조: `clients/mobile/src/features/conversation/MessageRow.tsx`(`body !== ''`로 칸 생략).
- 방향: 웹도 빈/공백 body에서 본문 칸을 생략(폰과 같은 판정). **코어 keepsBody 시맨틱은 비접촉**(그건 "본문을 살릴 자격" — 살릴 본문이 없을 때의 렌더 생략은 표면 판정).
- 검증: 계약 테스트(null·""·공백 body → 본문 노드 부재, 실본문 → 존재)+기존 스위트+`npm run typecheck`. UI 변경이므로 momo-design-taste-web 프리플라이트, design-review는 오케스트레이터 몫.
- 재현 픽스처: PR #1460 H-2가 만드는 모양(산문·summary·title 전무, gates만) — `completion_report` 봉투로 body null.

## #1443 — 폰: 동적 타입 컴포저 성장 상한 (이슈 본문이 정본)

- 좌표: 이슈 Context의 grep 두 곳(`packages/momo-core/src/features/chat/composerCopy.ts`·`clients/mobile/.../Composer.tsx` — #1422가 이 이슈 번호를 스탬프해 둠). `MAX_HEIGHT = MAX_ROWS · line.body + …` 고정 토큰이 동적 타입 미비례.
- 방향: 성장 상한을 실제 행높이(폰트 스케일 반영)에 비례로 + 상한 재정의 근거 1문단. 라틴 낱말 절단 축도 함께(hangul-word가 못 잡는 케이스).
- 검증: AX 캡처 전후(accessibility-extra-extra-large 206pt — measure.sh 계열)+타이핑 텍스트 검증+폰 스위트 무회귀. 폰 표면 — design-review는 오케스트레이터가 정본(`docs/design-system/README.md`) 기준으로.

## #1464 — goal_claim.sh 트랙 base 인지

- 좌표: `scripts/goal_claim.sh:6`(`BASE_BRANCH="${BASE_BRANCH:-main}"`)·`:31`(`--base` 플래그 기존재). 결함: 트랙 goal(엔진 파도 전부)이 기본값 main에서 분기 — 이번 파도 워커 2기가 수동 재지정.
- 방향(워커 설계·1문단 PR 상신): 자동 인지 소스 후보 — ①이슈 라벨(track:engine류 존재 여부 실사) ②`docs/TRACKS.md` 파싱 ③환경 기본값 전환+명시 안내. **기존 `--base` 명시 사용과 비트랙 goal의 main 분기는 무회귀**가 계약.
- 검증: `--dry-run` 실측(트랙 goal·비트랙 goal 각 1)+bash 3.2 호환(§5.1-3)+`bash -n`.

## #1467 — PG conformance 픽스처 재실행 내성

- 좌표: `server-rust/bins/momo-agent-worker/tests/agent_worker_conformance_pg.rs`의 `hosted_identities_never_enter_worker_claim_or_a2a_delivery` — 고정 토큰 해시가 `token_hash_uniq` 충돌(같은 DB 2회째 실패, 신선 DB 그린 — PR #1460 D-4 실측).
- 방향: 실행별 유일값(예: 실행 시각/uuid 파생 해시) 또는 사전 정리 — **테스트 시맨틱(호스티드 자격이 워커 claim·A2A에 못 들어감) 비접촉**.
- 검증: 같은 DB 연속 2회 그린 실측 로그 첨부 + fresh DB 그린.

## 이탈 보고·착수 (공통)

수용기준·계약과 다르면 PR `## 계획 이탈` 기록, 판단 필요 시 `goal_release.sh <n> --blocked` 정지. 최종 보고: PR URL·게이트 실측(정직)·이탈 요약.

## 컨텍스트 델타

- 새로 고정: 위생 후속은 goal당 워커 1기·이슈 본문을 1차 정본으로 하는 경량 패킷 방식(대형 축 패킷과 구분).
- 의도적 미결정: #1464 자동 인지 소스(워커 상신) · #1443 상한 재정의 값(워커 근거 제시).
- 재기획 트리거: #1465에서 코어 keepsBody 수정이 필요해 보이면 정지+이탈(카드 가족 전체 파급).
