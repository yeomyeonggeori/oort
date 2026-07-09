---
name: momo-planning
description: >
  momo 기획/오케스트레이션 워크플로우 스킬. momo 레포에서 ADR 기안·승인, 티켓 발급(MOMO-NNN),
  핸드오프 패킷 작성, 병렬 worker 오케스트레이션(최대 5), 코드리뷰·순차 머지, 계획 이탈(deviation)
  판정·로드맵 환류 작업을 할 때 사용한다. 트리거: "ADR 기안/결정", "티켓 발급/끊어줘", "핸드오프",
  "Codex에게 넘겨", "머지 사이클/리뷰 돌려", "이탈 판정", "로드맵 반영", "기획 세션 시작".
---

# momo 기획/오케스트레이션 스킬

정본은 `docs/planning/README.md` — 이 스킬은 그 절차의 실행 체크리스트다. 충돌 시 정본 우선.

## A. 기획 세션 시작
1. `docs/planning/JOURNAL.md` 최근 항목 — 직전 세션(Fable/GPT 5.6)이 어디서 멈췄는지.
2. `docs/planning/DEVIATION_LOG.md`에서 `pending` 판정부터 (차기 티켓보다 우선).
3. 읽기 순서: `docs/adr/`(0100·0101 필수 + Proposed 확인) → `docs/architecture/overview.md` → `docs/ux-bible/README.md` → `ROADMAP.md` → `STATUS.md` 최신 → 결정 큐.

## A-2. 기획 세션 종료 (플러시)
- [ ] 이 세션의 결정/티켓/패킷이 전부 정본 파일에 존재하는가 (채팅에만 있으면 손실)
- [ ] `JOURNAL.md` 상단에 항목 추가: 한 일 / 열린 것 / 다음 (5줄 이내)

## B. ADR 기안 체크리스트
- [ ] 번호 = 0100번대 다음 가용 (`ls docs/adr/`)
- [ ] 구조: Status(Proposed)/Date/Context/Options(기각 사유 포함)/Decision/Consequences + **Slack·업계 비교 1절**
- [ ] 성재가 배우면서 결정할 수 있게: 현재 상태의 file:line 근거 + 권고안 명시
- [ ] 승인은 AskUserQuestion으로 옵션 제시 → Accepted 전환 시 Status에 승인 날짜 기록
- [ ] Accepted 후에만 티켓 변환. UI/UX 관련이면 ux-bible 원칙 번호 인용

## C. 티켓 발급 체크리스트
- [ ] 다음 번호: `grep -o 'MOMO-[0-9]*' BUILD_TICKETS.md STATUS.md | sort -t- -k2 -n | tail -1` +1
- [ ] `BUILD_TICKETS.md`: STEPS 표 행 + `### MOMO-NNN 수용기준` 섹션(검증 등급 명시, ADR 링크)
- [ ] GitHub Issue: `## Goal / ## Context(핸드오프 패킷 링크 필수) / ## Acceptance(BUILD_TICKETS 링크) / ## Out of scope` + `status:ready`
- [ ] 수용기준을 이슈에 복사하지 않는다(정본 이중화 금지)

## D. 핸드오프 패킷 체크리스트 (`docs/planning/HANDOFF_TEMPLATE.md` 복사)
- [ ] 결정 요약(ADR 링크) / goal 체인·머지 순서 / **파일 맵(file:line)** / 지켜야 할 계약 / 함정 / 검증 / 이탈 보고 의무 / 착수 명령
- [ ] 합격 기준: worker가 채팅 맥락 없이 패킷+이슈만 읽고 착수 가능한가
- [ ] worker 전달 메시지는 3줄: 레포 경로 + 패킷 경로 + 시작 goal 번호

## E. 오케스트레이션 사이클 (momo-main)
1. `scripts/goal_status.sh` 상태판. 동시 in-progress ≤ 5 유지.
2. needs-review PR: 코드리뷰(보안·정합·스코프·테스트 정직성; UI면 design-review 에이전트 Blocker 0).
3. 머지는 **의존 순서대로 한 번에 하나** + main 게이트 재실행. 머지 후 stale PR은 rebase 요청.
4. PR `## 계획 이탈` 수집 → `DEVIATION_LOG.md` 기록(`pending`) → 필요시 리서치 첨부.
5. 사이클 종료 보고: 머지 내역 / 이탈 요약 / 다음 goal 추천.

## F. 이탈 판정 (기획 레이어)
- `accepted` → 정본(ROADMAP/ADR/architecture) 반영(성재 승인) + 후속 티켓
- `rejected` → 복구 티켓 발급 / `noted` → 기록만
- 판정 결과를 로그 상태 컬럼에 갱신하고, 반영된 정본을 커밋 단위로 남긴다

## 하드 룰
- Fable/GPT 5.6은 구현하지 않는다(핫픽스 포함 — 티켓으로).
- 패킷 없는 핸드오프 금지. 병렬 배치는 같은 파일군 충돌 금지(`docs/MULTI_SESSION_OPS.md` §4).
- 로드맵·ADR 최종 승인은 항상 성재.
