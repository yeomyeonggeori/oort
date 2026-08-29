# 워커 브리프 — BF-A2(#1885) 상단 "↑ N개 안읽음" 점프 필 (uxui)

> 워커: grok build CLI grok-4.6 · base=origin/track/uxui (A1 랜딩 포함 최신)
> 정지 조건: 머지·이슈 close 금지. MCP 금지. 서버 무접촉.
> 참조: `~/projects/reference/buzz`(Apache-2.0) `desktop/src/shared/ui/UnreadPill.tsx`(방향·강조 파라미터 단일 부품) + `features/messages/ui/MessageTimeline.tsx:489-512`(상단 필 소멸 규칙).

## 근거
- oort는 하단 jump-latest 필(Timeline.tsx:595, "새 메시지 N개 보기/최신 메시지로 이동")과 읽음 구분선(dividerTone, "새 메시지 N개, 여기까지 읽음")은 있으나, **위쪽에 쌓인 안읽음으로 되돌아가는 진입점이 없다** — 오래 자리 비운 뒤 복귀 동선 공백.

## 구현 계약
1. **상단 부유 필**: 읽음 구분선(가장 오래된 안읽음 위치)이 뷰포트 **위쪽 밖**에 있을 때만 타임라인 상단 중앙에 부유 필 표시 — 라벨 「새 메시지 N개」+위 화살표(기존 lucide). N은 기존 카운트 어휘(navigation.ts — 내 확정 전송 제외 규칙) 재사용.
2. **동작**: 클릭/Enter → 구분선 위치로 스크롤(reduced-motion이면 auto). 구분선이 뷰포트에 들어오면 소멸. 채널 전환 시 리셋. 하단 필과 동시 표시 가능(상=과거로, 하=최신으로 — 역할 충돌 없음).
3. **부품**: 하단 필과 시각 문법 통일 — 기존 jump-latest 필의 클래스/토큰을 공유 부품으로 추출(buzz UnreadPill 동형, direction 파라미터). 하단 필 회귀 0.
4. 포커스·로빙: 필은 타임라인 탭 순서에 1 스톱으로 합류(기존 하단 필 관례 따름), aria-label 문장형.

## red proof (선행 커밋)
- 구분선 뷰포트 밖(위)일 때만 표시·클릭 시 구분선 도달·진입 후 소멸·채널 전환 리셋.
- 하단 필·구분선 기존 테스트 전부 그린.
- reduced-motion 분기.

## 완료 절차
web vitest·tsc·design_preflight_web.sh·CAPTURE_PORT=7577 capture:design·SHELL_GATE_PORT=7579 SHELL_GATE_FOCUS_ONLY=1 gate:shell 그린 실측 → 커밋(#1885) → git push -u origin feat/1885-bfa2-unread-pill → gh pr create --base track/uxui → 정지.
