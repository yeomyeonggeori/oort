# 위생 파도 핸드오프 패킷 — #1415 → #1413 → #1414 (관전 표면 위생, 순차)

> 2026-08-15 Fable 발급, 성재 결재("남은 작업 권장 순서 순차 진행"). 워커: 단발 무명 Opus 5, **한 번에 한 goal**.
> base = **`track/engine@fbe49826`**(LIVE-2 랜딩 HEAD). planning ID PLN-20260815-01.
> 공통 규율: 워크트리 `~/projects/momo-tracks/momo-worktrees/<issue>-<slug>` · 로컬 커밋 동결(push/PR/이슈 조작 금지) · 중간 보고 없음 · 미결 경계=동결+이탈 보고 · 결정적 단언만 · UI 카피 규율(momo-design-taste-web).
> 리뷰 폐곡선(공통): 동결 → Fable 기획검수 → grok 리뷰어 C freeze → (#1413만 design-review 추가 — 레이아웃 변경) → push→PR(track/engine)→CI→머지.

## goal 1 — #1415: ObserverTerminal connecting 정리 누수 (LIVE-2 M1 동형 선재)

- **결함**: `clients/web/src/features/work/ObserverTerminal.tsx` — `done()`(:435-438)이 `socket.onopen`(:441)/`socket.onclose`(:482)에서만 호출, `closeSocket`(:249-258)이 핸들러를 먼저 null 후 close → `give()`·`stop()`·원장 회수 effect·`session.id` 전환 경로에서 document `securitypolicyviolation` 리스너 잔류·누적.
- **수리 shape 기성품(그대로 이식)**: LIVE-2 커밋 `0af458b5`의 `DisplayObserver.tsx` — `connectCleanupRef` 소유권 수렴 + 멱등 `done()`(자기 것일 때만 ref 비움) + teardown 최우선 실행 + 중복 clearTimeout 제거. display 쪽 구현을 읽고 동형으로.
- **측정기 기성품**: `clients/web/gates/gate-work-console.mjs`의 `assertDisplayConnectCleanup()` 리스너 카운터(identity Set) — PTY 시나리오(터미널 연결 중 세션 전환)로 재사용.
- **수용기준**: 동형 수리 + **red proof**(수리 전 코드로 리스너 잔류 실측 FAIL→수리 후 0) + `observerStream`/터미널 기존 테스트·게이트 무회귀 + web typecheck·lint·design 프리플라이트 유지. UI 변경 0(동작 불변 정리).

## goal 2 — #1413: gate-work-panel co-open-900 — 컴포저 236px < 240px (선재 red)

- **결함**: 900px 티어에서 패널 co-open 시 컴포저 폭 236px가 240px 바닥 미달. base에서 stash 재현으로 선재 확정(LIVE-2 검수 중 발견). CRUN-2 M1 "900px 티어 생존" 계열 인접 — 그 수리 선례(라디오 토큰·티어 생존) 참조.
- **작업**: 원인 지점(패널 폭/컴포저 min-width 경합) 실측 → 폭 예산 수리(어느 쪽을 줄이는지 근거 1문단 — 임의 픽셀 조정 금지, 토큰 스케일 준수) → `gate:work-panel` 전 시나리오 green.
- **수용기준**: co-open-900 green + 수리 근거 문단 + 다른 티어·시나리오 무회귀 + design 프리플라이트 유지. **레이아웃 변경이므로 design-review 관문 대상**(동결 후 오케스트레이터가 실행) — 900px 전후 스크린샷(라이트·다크) 캡처를 산출물에 포함.

## goal 3 — #1414: display 상태별 픽셀 증거 (design-review M2 후속)

- **작업**: `gate-work-console.mjs` 캡처 확장 — busy(mock `/display-attach` 행잉)·failed(409) 상태 라이트/다크 4장 + watching 스텁(`RTCPeerConnection`/`getStats` 주입 — `DisplayObserver`의 `typeof window.RTCPeerConnection` 체크·500ms stats 폴이 주입 지점) 2장, 각 캡처에 게이트 단언 동반.
- **수용기준**: 신규 캡처 6장 산출 + 단언 + 기존 시나리오 무회귀. 컴포넌트 동작 변경 금지(게이트·스텁만).

## 발사 순서

#1415부터. 각 goal 랜딩 후 다음 발사(오케스트레이터). #1414는 #1413과 게이트 파일(`gate-work-console.mjs` vs `gate-work-panel.mjs`)이 달라 순서 교환 가능하나 기본은 번호 역순 유지.
