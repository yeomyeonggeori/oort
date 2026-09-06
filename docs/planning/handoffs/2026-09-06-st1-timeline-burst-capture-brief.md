# 워커 브리프 — ST-1 UXUI 안정화: `Timeline.burst` CI 플레이크 결정성 + #2050 결정 집행(바닥 동시 상한 3·백로그 캡 렌더 가드) + capture 레인 intro 장면 정착(#2057 N-4) (uxui · ADR-0179 D3 정오표)

> 워커: grok 4.6 · base=origin/track/uxui · ms 리터럴 금지 · MCP 금지 · 서버 무접촉 · `scripts/**`·`gates/**` 무접촉(장면·시험·제품 코드만).
> 근거: #2050(플레이크 원장 — CI 2/3 실패[#2097·#2099], 로컬 10/10 PASS → 러너 부하 민감 · M-1 백로그 캡 렌더 가드 부재[P5 뮤테이션 초록] · **성재 결정 N-2 = 바닥 동시 상한 3**[초과분 즉시 정착, stagger 기각; ADR-0179 D3 정오표 반영됨] · N-1·N-4~N-7) · #2057 R5-N4(`capture:design`이 `message-channel-intro` nonempty 장면 「자리가 멎지 않았다」로 중단 — 이번 파도 3브랜치·검수 2/2 재발, `capture-screens.mjs:12357-12370`이 이를 「pre-existing」으로 특별 취급). 정본 `docs/design-system/README.md` §2.6·§5.3·§5.5② · ADR-0179 D3. 재료: `clients/web/src/features/timeline/Timeline.burst.test.tsx`(실 virtuoso 하네스, `flushVirtuosoMount`·rAF stub) · `useTimeline.ts`(`MAX_PENDING_ARRIVAL_GRANTS`·`capUnmountedArrivals`·`playOnMountRef`) · `conversationEntrance.ts` · `Timeline.tsx` sweep effect · `capture-screens.mjs` 스크롤 헬퍼(「③ 찾았는데 자리가 멎지 않았다」) · 검수 프로브 `claudedocs/design-review-2042/r3-burst-probe.mjs`.

## 구현 계약
1. **결정성**: `Timeline.burst.test.tsx`의 「같은 틱」은 프레임 스케줄(rAF·virtuoso 마운트 타이밍)에 기대지 않고 제품의 신호(도착 grant 소비·마운트 완료)를 기다린다. 부하 아래 30회 연속(다른 vitest 워커를 병렬로 돌려 CPU 경합) 30/30. 시험이 재는 것(3/3 재생)은 그대로 — 완화 금지.
2. **N-2 집행**: 바닥에서 같은 틱 도착 N건 → 재생 **≤3**, 초과분 즉시 정착(`enter-conversation` 없이 최종 상태). 상한은 토큰/상수 하나(`MAX_SIMULTANEOUS_ARRIVALS = 3`, 이름은 정본 문구와 맞춤), `MAX_PENDING_ARRIVAL_GRANTS`(스크롤업 1)와 짝으로 문서화. 가상화 `Timeline` 하네스에서 10건 → 재생 3·정착 7 **숫자로 단정**; 50건 → 3·47.
3. **M-1 렌더 가드**: 백로그 캡(스크롤업 중 0, 바닥 점프 시 정확히 1)을 가상화 `Timeline` 하네스에서 **렌더 경로로** 단정(소스 텍스트 grep·손호출 금지). RED = `Timeline.tsx` sweep effect deps를 `[]`로(P5) → 빨강.
4. **#2050 Nit**: N-1(죽은 결속 `false ? … : undefined` 탐지 — AST 결속 카운트가 조건식의 상수 분기를 본다) · N-4(`waitForAnimations(login)` 삭제 시 빨강이 되는 장면 단정 또는 삭제) · N-5(`MAX_CONSUMED_ARRIVAL_IDS` 64→4 측정: 어느 값에서 재재생이 생기는지 숫자) · N-6(`isPlayEntrance` `.toLowerCase()` 읽기 쪽 단정) · N-7 원장에 이번 CI 2건 추가.
5. **#2057 N-4 capture 레인**: `message-channel-intro` nonempty 장면의 「자리가 멎지 않았다」 원인을 **측정**(무엇이 계속 움직이는가: virtuoso 재측정·인트로 애니·이미지 로드 — 프레임별 bounding box 로그) → 제품의 정착 신호를 기다리는 **표적 대기**로 교체(재시도 루프·sleep 금지). 그 뒤 `capture-screens.mjs`의 「pre-existing intro-scroll flake (#2057 N-4)」 특별 취급(12357-12370)을 **삭제** — 레인이 그 중단을 정상으로 보지 않는다. 전체 `capture:design` **5회 연속 exit 0**, 전 장면 sha 5회 동일(표).
6. 범위 밖: #2057 본항(R5-M1 이징 기반 단일 상한)·#2076·#2095 — 건드리지 않는다.

## red proof (선행 커밋)
- 상한 삭제 → 10/10 재생(빨강) · P5 → 빨강 · 결정성: 수리 전 부하 30회 중 실패 수(숫자)와 수리 후 30/30 · 표적 대기 제거 → capture 장면 중단 재현(로그 인용).

## 완료 절차
vitest·tsc·lint 0·preflight 14/14+core 5/5·`CAPTURE_PORT=8641 capture:design` **5회**·`SHELL_GATE_PORT=8643 SHELL_GATE_FOCUS_ONLY=1 gate:shell`·`verify_merge_tree.sh` → PR → track/uxui → 정지. STATUS.md 최상단에 측정값(30회·5회·3/7·1/0)만.

## 규율
숫자로 재고, 하네스에서만 참인 단정 금지, 가드는 렌더 경로. 막히면 우회 말고 보고 후 정지.
