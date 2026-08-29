# 워커 브리프 — BF-A1(#1884) 리액션 칩 이름 툴팁 (uxui)

> 워커: grok build CLI grok-4.6 · base=origin/track/uxui
> 정지 조건: 머지·이슈 close 금지. MCP 금지. 서버 무접촉.
> 참조: `~/projects/reference/buzz`(Apache-2.0) `desktop/src/features/messages/ui/MessageReactions.tsx:106-116` — 이름 자연어 접기.

## 근거
- `packages/momo-core/src/features/timeline/reactions.ts:179` `ReactionMap`이 **memberIds 배열을 이미 보유** — `chipsFor()`가 count로 접을 뿐. 서버 0으로 "누가 눌렀는지"를 보여줄 수 있다.
- 현 `clients/web/src/features/timeline/ReactionChips.tsx` 접근명: "👍 반응 3개, 나도 반응하기" — 이름 정보 없음.

## 구현 계약
1. momo-core에 이름 접기 헬퍼 신설(모델 층 — 테스트 동반): memberIds+directory(+내 memberId) → 자연어 한 문장. 규칙: 나 포함 시 「나」를 맨 앞(+해제 힌트는 칩 접근명 관례에 맞게), 3명까지 이름 나열, 초과는 「외 N명」. 이름 해석 실패(명부 미로딩·탈퇴)는 그 수만큼 「외 N명」으로 접기 — 실명 불명 표기 금지.
2. ReactionChips: 칩 호버/포커스 시 툴팁으로 그 문장 노출 — 기존 툴팁 관례 조사 후 재사용(전용 프리미티브가 없으면 기존에 툴팁을 쓰는 표면의 방식을 따르고 신설 시 한 줄 사유 주석). 접근명(aria-label)도 같은 정보로 갱신(카운트+이름 요약).
3. 로빙 포커스·행당 탭 스톱 1개 계약(hoverToolbarModel) 무변경. 리액션 토글 동작 무변경.
4. 성능: 툴팁 문장은 렌더마다 재계산하지 않게 메모(기존 관례 따름).

## red proof (선행 커밋)
- 모델: 나/1명/2명/3명/4+명/이름 미해석 분기 각각.
- 칩: 호버·키보드 포커스에서 툴팁 노출, 접근명 갱신, 토글 회귀 그린.
- 기존 timeline 테스트 전부 그린.

## 완료 절차
web vitest·tsc·design_preflight_web.sh·CAPTURE_PORT=7477 capture:design·SHELL_GATE_PORT=7479 SHELL_GATE_FOCUS_ONLY=1 gate:shell 그린 실측 → 커밋(#1884) → git push -u origin feat/1884-bfa1-reaction-names → gh pr create --base track/uxui → 정지.
