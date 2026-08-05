# 핸드오프 패킷 U4-4R — 일괄 리뷰 Blocker/High 수리 (2워커, 발사 대기)

- status: **ready(발사 대기 — 성재 시작 신호)** · 기준: `origin/track/engine` 최신 · 새 워크트리 · goal별 PR
- 정본: `docs/planning/research/2026-08-05-u44-design-review.md` (U4-4 병합 결과 FAIL — B3·H3·M5·N3. §6 "제대로 된 것 — 되돌리지 말 것" 먼저 정독. 의도적 트레이드오프 4건은 재지적 아님)
- 증거: 리뷰어 산출 `scratchpad/u44-evidence/` (웹 캡처 재생성 커맨드 포함) · 폰 캡처 축척 **pt=px/3**

## U4-4RW (웹 — #1091, 1-goal)
- **W-1(Blocker)**: `spacing.ts`의 `py-1.5`/`pb-1.5`가 이 레포 고정 스케일(`{0,px,4,8,12,16,24,32}` — tokens.css:150-161이 py-1.5를 "미컴파일 예"로 명시)에서 **미컴파일** → 묶음 안 간격 0px(기준선 8px보다 회귀). 근본 원인 = 코어 공용 상수(`ROW_SPACE` 18/6)가 웹 표현 가능 집합 밖. **해법은 구현자 선택**: ①공용 상수를 양 클라 표현 가능값으로 조정(코어 수정 — 폰 값도 함께 움직임, 이탈 절 기록) ②웹에 이름 붙은 `--spacing-*` 단계 신설(tokens.css 규율 준수 방식 확인). `gate:borders`가 이미 red다 — 그린 만들면 수리 완료의 1차 증명.
- **W-2(Blocker)**: `spacing.test.ts`의 `TAILWIND_SPACE_PX`가 Tailwind **기본** 스케일을 열거 — 이 레포의 표(tokens.css `--spacing-*`)를 읽게 교체. red proof: 미컴파일 클래스를 넣으면 스위트가 붉어야 한다(현재는 초록 — 그게 W-2다).
- **W-3(High)**: 320폭에서 「님」 고아 + lead/tail 분리 이득 미배송. 방향 재량: 꼬리를 동사만("...이 작성 중"의 조사 처리 주의 — 이름 없이 성립하는 문장으로) / 좁은 폭은 집계 문구 폴백(절대 안 잘림). 한국어가 끊어도 되는 자리에서만 자를 것. gate:typing narrow 장면으로 증명.

## U4-4RM (폰 — #1092, 1-goal)
- **M-1(Blocker)**: 시각 칸 예약을 「본문」이 아니라 **「행의 첫 줄」**이 지게 구조화 — 첫 흐름 자식이 인용/답글 표식/승인 카드/아티팩트/tombstone일 때 무예약인 현 구조(자식 종류가 늘 때마다 같은 구멍). 카드 위 시각 가림(불투명 배경이 앞선 형제를 덮음)·상태 칩과 34pt 칸 겹침도 함께. **fixture에 「연속 승인 카드」(startsGroup=false) 신설** — 가장 흔한 미캡처 경로.
- **E-1(High)**: `u44-row.png` 재촬영(2커밋 낡음 — 겹침 인쇄 사진이 증거로 남아 있음). 원칙 명문화: 캡처는 코드와 같은 커밋에서 갱신, 낡으면 삭제.
- **D-1(High)**: `(다시 읽음)` 로컬 접합 제거 — `source`를 `recoveryDividerSegments` **인자로 코어 승격**(core 수정 허용 — 웹도 같은 문장을 렌더하게 웹 호출부 1줄 포함, 레인 예외 명시). 두 클라 문장 동일 단정.

## 공통
전체 스위트+typecheck+**lint 총계 줄**(오독 전례) + red proof ≥2/goal · 웹은 gate:borders/gate:typing 그린, 폰은 lane 1회+하네스 재캡처 · PR "Closes #1091"/"Closes #1092" · 이탈 절 · STOP · 턴 규율. Medium 이하(#1093)는 건드리지 않기.
