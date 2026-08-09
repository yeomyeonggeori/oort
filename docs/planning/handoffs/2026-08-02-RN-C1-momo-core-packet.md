# goal RN-C1 — `packages/momo-core` 추출 (웹이 먼저 소비해 회귀 0 증명)

너는 momo(제품명 oort) 레포의 구현 worker다. 이 문서가 유일한 지시서.
**base = `track/engine`**. 워크트리 `~/projects/momo-tracks/momo-worktrees/RN-C1-momo-core`(브랜치 `feat/RN-C1-momo-core`, 생성됨).

발단: **#837 스파이크 5개 게이트 전항 통과**(보고서 `docs/planning/2026-08-02-rn-spike-report.md`). ADR-0137 이행 순서 2번이 이 배치다: **`packages/momo-core` 추출 — 웹이 먼저 소비해 회귀 0을 증명한 뒤** 모바일이 붙는다(D3 검증 규율).

## 0. 이 배치의 성패는 하나로 판정된다
**웹이 코어를 소비한 뒤에도 회귀가 0인가.** 새 기능 0, 동작 변화 0이 목표다.
리팩터링이지 재설계가 아니다. "겸사겸사 개선"은 **금지** — 회귀 원인을 가릴 수 없게 만든다.

## 1. 규율
`.env`·자격증명 금지 · **서버 코드(`server-rust/`, `server/`) 수정 금지** · `schema_v0.sql` 금지 · **docker 실행 금지** · 커밋은 새 커밋만(amend·force-push 금지) · **PR 후 STOP**(머지·close 금지).
**`clients/mobile-spike/` 는 건드리지 마라** — 버려질 스파이크다. 단 그 안의 `__tests__/gate2_deeplink.test.ts` 가 웹 소스를 직접 import 하므로, 경로가 바뀌면 **깨지지 않게 매핑만 맞춰라**(그 테스트가 계속 돌아야 한다).

## 2. 범위 — A군 전량 + B군은 **인터페이스만**

ADR-0137 D3의 실측 분류(`clients/web/src` 120파일 33,293줄 전수)를 그대로 쓴다.

**A. 그대로 이식 (7,516줄 / 23파일) — 이번 배치의 본체**
`lib/api.ts`(935) · `work/workSessionModel.ts`(721) · `settings/usageModel.ts`(682) · `timeline/artifacts.ts`(593) · `agentCardModel.ts`(503) · `timeline/model.ts`(410, seq 순서 병합) · `inbox/model.ts`(323) · `notifications/model.ts`(300) · `auth/deepLink.ts`(138) 외.
**E. 테스트 (7,728줄 / 24파일)** 는 A를 따라 함께 옮긴다 — **이식의 안전망이다.**

**B. 얇은 어댑터 (2,108줄 / 8파일) — 인터페이스만 코어에, 구현은 웹에 남긴다**
`realtime.ts` · `observerStream.ts` · `session.ts` · `serverBase.ts` · `inbox/anchor.ts` 등.
코어에는 `Storage` · `RealtimeTransport` 같은 **인터페이스만** 두고 구현을 주입받는다.
(스파이크 실측: `serverBase.ts` 는 `localStorage`/`window` 를 직접 만진다 — B군 분류가 맞았다.)

**C. 훅(1,820줄) · F. UI(13,346줄) 는 이번 범위가 아니다.** 웹에 남긴다.

## 3. 구조 규율
- **npm workspaces.** `Nx`/`Turborepo` 도입 금지(현 규모에 과하다 — D3).
- **코어에 UI·플랫폼 API 금지.** `window`·`document`·`localStorage`·`navigator`·React 컴포넌트·RN 임포트가 코어에 한 줄도 없어야 한다. **이걸 기계로 강제하는 검사를 넣어라**(lint 룰이든 스크립트든). 사람이 지키는 규율은 다음 배치에서 깨진다.
- 이게 가능한 이유는 이 코드베이스가 **결정 함수에 플랫폼 사실을 파라미터로 넘기기** 때문이다(`notifications/model.ts` 가 `window.focus` 를 읽지 않고 `windowFocused: boolean` 을 인자로 받는다). 그 성질을 깨지 마라.

## 4. 스파이크가 남긴 규율을 **코어에 문서로 박아라**
실기기 실측으로 얻은 제약이다. 다음 사람이 모르고 어길 자리라 코어 README(또는 해당 모듈 주석)에 남긴다.
1. **컴포저 `value` 를 비동기로 반영하면 한글이 깨진다.** 입력 value 가 네트워크·스토어·큐를 거쳐 되돌아오는 구조 금지. 낙관적 로컬 상태는 **동기**로 유지하고 서버 왕복은 별도 경로. (게이트 1 D 실측)
2. **타임라인에 `inverted` 를 쓰지 않는다.** 인버티드에서 새 메시지 도착 시 읽던 위치가 46~91px 튀었고, 정방향에서는 0px 이었다. (게이트 5 실측)
3. **커스텀 스킴 URL 은 RN 코어 `URL` 로 파싱 못 한다** — `react-native-url-polyfill` 선결. `deepLink.ts` 자체는 무수정 통과했다. (게이트 2 실측)

## 5. 검증 — 이 배치의 판정 기준
- **웹 게이트가 추출 전과 동일해야 한다**: `npm run typecheck` · `lint` · `test` · `build` · design preflight · **`npm run capture:design` exit 0**.
- **테스트 수가 줄면 안 된다.** 옮긴 테스트가 코어 쪽에서 돌든 웹에서 돌든, **합계가 유지되거나 늘어야** 한다. 줄었다면 어디서 사라졌는지 밝혀라.
- 기존 게이트 스크립트(`gate:shell`·`gate:wire`·`gate:csp` 등)가 계속 통과해야 한다.
- `clients/mobile-spike` 의 `npx jest` 가 계속 통과해야 한다(경로 매핑).
- **PR 본문에 전후 대조표**: 파일별 이동 경로, 테스트 수 전/후, 웹 번들 크기 전/후.

## 6. 하지 말 것
새 기능 · 동작 변경 · C군(훅)·F군(UI) 이동 · RN 쪽 소비(**다음 배치**) · 서버 수정 · `clients/mobile-spike` 로직 수정 · 모노레포 도구(Nx/Turborepo) 도입.

## 7. PR
`feat/RN-C1-momo-core` → `track/engine`. 본문에 §5의 대조표와 이탈. **PR 후 STOP.**
