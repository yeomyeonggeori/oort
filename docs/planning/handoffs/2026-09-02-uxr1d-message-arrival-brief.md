# 워커 브리프 — UX-R1d 메시지 도착 모션 `motion-enter-conversation` (uxui · ADR-0179 D3 · UX-R0 후)

> 워커: grok 4.6 · base=origin/track/uxui · ms 리터럴 금지 · MCP 금지.
> 정본: ADR-0179 D3(새 메시지 행: blur 2px→0·opacity 0→1·translateY(0.75rem)→0, arrival 사다리, **1회만** — animationName 일치로 종료 감지, 재마운트·백필·리플레이 무재생)·D9. 실사: `Timeline.tsx`(react-virtuoso)·`MessageRow.tsx`·`PendingRow.tsx`(낙관 에코 — 도착 시 행 교체가 튀지 않게 같은 grid). 참조(Apache-2.0, 구조만): buzz `MessageRow.tsx:205,889`(`playEntrance` prop + `animationName` 매칭).

## 구현 계약
1. 키프레임 `motion-enter-conversation`(motion.css) + `@utility enter-conversation`. 재생 조건: **실시간 도착 프레임으로 들어온 행**만(REST 백필·리플레이 게이트·초기 로드·가상화 재마운트 제외) — 도착 출처를 행 모델에 1비트로 실어 판단(단일점 함수 momo-core 또는 timeline model).
2. 낙관 전송(PendingRow→실행 교체)은 재생 안 함(이미 보이던 행). 타 사용자 메시지 도착만 재생.
3. `animationend`에서 클래스 제거(1회 보장), 가상화로 언마운트 후 재마운트 시 재생 금지(플래그 소비).
4. reduced-motion: 재생 0. UnreadDivider/Pill 무회귀(BT-6).

## red proof (선행 커밋)
- 실시간 도착 행 1회 재생·백필 행 0·재마운트 0·낙관 교체 0 · 캡처: 도착 정착 프레임(`waitForAnimations`) · gate-seq/gate-resume 그린.

## 완료 절차
vitest·tsc·lint 0·preflight·`CAPTURE_PORT=8633`·`SHELL_GATE_PORT=8635 SHELL_GATE_FOCUS_ONLY=1`·`gate:seq`·`gate:resume`(포트 분리)·`verify_merge_tree.sh` → PR → track/uxui → 정지.
