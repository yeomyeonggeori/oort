# goal RN-C2 — RN 실앱 스캐폴드 + 배선 (ADR-0137 이행 순서 3)

너는 momo(제품명 oort) 레포의 구현 worker다. 이 문서가 유일한 지시서.
**base = `track/engine`**. 워크트리 `~/projects/momo-tracks/momo-worktrees/RN-C2-app-scaffold`(브랜치 `feat/RN-C2-app-scaffold`, 생성됨).

발단: #837 스파이크 **전항 통과**, `packages/momo-core` 추출 랜딩(PR #964). ADR-0137 이행 순서 **3번**이 이 배치다 — RN 스캐폴드 + URL 폴리필 + react-query 배선. UI(순서 4)는 다음 배치다.

## 0. 먼저 읽어라
- `docs/adr/0137-mobile-react-native-migration.md` — 특히 **D1**(bare RN + Expo 모듈 낱개, EAS 미도입) · **D3**(코어 규율) · **D4**(centrifuge-js 유지, 백그라운드 정책) · **D7**(승계 자산·저장소 분리 규율) · **§성재 결정 6**(Android 보류).
- `docs/planning/2026-08-02-rn-spike-report.md` — **실측으로 얻은 제약 3개**가 여기 있다. 어기면 한글이 깨지거나 스크롤이 튄다.
- `packages/momo-core/README.md` — 코어 규율과 순수성 게이트.

## 1. 규율
`.env`·자격증명 금지 · **서버 코드·`schema_v0.sql` 수정 금지** · **docker 실행 금지** · **실서버(app.oor7.com) 접속 시도 금지**(자격증명이 필요하다 — 실왕복은 오케스트레이터 몫) · 커밋은 새 커밋만(amend·force-push 금지) · **PR 후 STOP**.
**`clients/mobile-spike/` 는 건드리지 마라**(버려질 스파이크, 별개다). **`clients/web` 은 읽기만** — 웹 게이트가 깨지면 이 배치는 실패다.
**`clients/iOS`(기존 SwiftUI 킷)도 수정 금지** — ADR-0137 D8상 **동결**이다.

## 2. 놓을 자리와 정체성
- `clients/mobile/` — **버려지지 않는 실제 앱.** 스파이크(`clients/mobile-spike`)와 혼동하지 마라.
- **번들 ID = `app.momo.ios`**, NSE = `app.momo.ios.NotificationService`.
  - 이유: ADR-0137 D7의 푸시 승계가 **식별자 일치에 걸려 있다.** 오케스트레이터 실측으로 Developer Portal에 두 App ID가 이미 있고 capability도 켜져 있다(App Group `group.app.momo.ios`, `aps-environment`, keychain group `YWQQFQM38J.*`). 다른 ID를 쓰면 그 자산을 통째로 버린다.
  - `DEVELOPMENT_TEAM = YWQQFQM38J`.
  - **이번 배치에서 NSE 타깃을 추가하지는 마라**(순서 5). 식별자와 팀만 맞춰 둔다.
- **Android는 보류**(성재 결정 6). `expo prebuild` 를 **절대 실행하지 마라** — `--platform android` 없이 한 번만 돌려도 `ios/` 가 재생성돼 나중에 붙일 NSE 자리가 날아간다. `android/` 디렉터리를 만들지 않는다.

## 3. 스택 (D1)
bare React Native (스파이크에서 검증된 0.86.x 계열) · React 19 · **New Architecture ON** · Hermes · **Expo 모듈은 낱개로만** · **EAS 미도입**(`eas.json` 만들지 마라).

## 4. 배선 — 이 배치의 본체

### 4-1. `@momo/core` 소비
앱이 코어를 import 해서 쓴다. 웹이 이미 소비 중이므로 **같은 소스를 두 소비자가 쓰는 것**이 이 배치로 증명된다.
- Metro resolver가 모노레포 밖 패키지를 찾도록 배선(`watchFolders`·`nodeModulesPaths`).
- **코어 순수성 게이트(`packages/momo-core` 의 `gate:purity`)가 계속 green** 이어야 한다. 코어에 RN 임포트를 넣어 해결하려 하지 마라 — 그건 이 구조를 죽이는 길이다.

### 4-2. URL 폴리필 (게이트 2 실측)
`react-native-url-polyfill` 을 엔트리에서 선결 적용. **RN 코어 `URL` 은 정규식 래퍼라 커스텀 스킴을 구조적으로 파싱 못 한다**(`oort://join` 이 `null` 이 된다). 스파이크가 19/19 로 증명했으니 같은 케이스가 앱에서도 도는지 테스트로 고정해라.

### 4-3. react-query 배선 (D3 C군)
표준 2가지만: `focusManager` ← `AppState`, `onlineManager` ← `NetInfo`. 그 이상 만들지 마라.

### 4-4. 저장소 분리 (D7 규율 — 지켜라)
- **세션 토큰·자격증명 = `react-native-keychain`**(iOS 키체인).
- **MMKV 는 시크릿 저장소가 아니다** — 옵션 암호화의 `encryptionKey` 를 다시 어딘가 안전히 둬야 하는 순환이 생긴다. MMKV 는 `serverBase` 같은 **비시크릿 로컬 캐시 한정**.
- 코어의 `Storage` 인터페이스에 이 둘을 **주입**한다(코어가 플랫폼을 모르게 유지).

### 4-5. 실시간 (D4) — 배선만, 접속 증명은 오케스트레이터
centrifuge-js 를 코어 인터페이스에 주입할 수 있게 배선한다. 백그라운드 정책도 D4대로: **백그라운드 진입 시 즉시 끊지 않고 15초 유예**, 포그라운드 복귀 시 재개, 네트워크 타입 전환은 강제 재연결.
**주의(게이트 3 실측)**: **RN 의 WebSocket 은 `Origin` 헤더를 보낸다.** 레포의 Centrifugo `allowed_origins` 그대로면 셀프호스팅 LAN·로컬 접속이 전부 거절된다. **서버 설정 변경은 이 배치 범위가 아니다** — 앱 쪽 배선만 하고, 무엇이 막히는지 PR 본문에 적어라.

## 5. 스파이크가 실측으로 얻은 제약 — 배선 단계에서 이미 지켜라
1. **컴포저 `value` 를 비동기로 반영하면 한글이 깨진다.** 입력 상태가 네트워크·스토어·큐를 거쳐 되돌아오는 구조를 만들지 마라. 낙관적 로컬 상태는 **동기**로 유지한다.
2. **타임라인에 `inverted` 를 쓰지 않는다.** 인버티드에서 새 메시지 도착 시 46~91px 튀었고 정방향은 0px 이었다. 정방향 + 명시적 앵커 보존(웹 `Timeline.tsx` 가 `firstItemIndex` 로 푼 것과 같은 종류)이 정본이다.
3. 커스텀 스킴 URL 은 폴리필 선결(§4-2).

## 6. 이 배치의 완료 조건 — "떴다"가 아니라 "붙었다"
- **앱이 시뮬레이터에서 부팅**되고, **코어를 실제로 호출**하는 화면이 하나 있다(예: 서버 주소 입력 → `normalizeServerUrl` 등 코어 함수 결과를 화면에 표시). UI 완성도는 이번 범위가 **아니다** — 배선이 도는 증거면 된다.
- **로그인 왕복은 목(mock)으로 증명**해라(실서버 금지). 코어의 API 계층이 RN fetch 위에서 동작하는지, 401/네트워크 오류가 코어 규약대로 표면화되는지.
- 딥링크 파싱이 앱에서 동작(§4-2 테스트).

## 7. 검증
- 앱: `npx tsc --noEmit` · 테스트(배선 테스트를 새로 붙여라) · **iOS 시뮬레이터 빌드 성공**.
- **웹 무회귀**: `clients/web` 에서 `typecheck` · `test` · `build` 통과(수치를 PR에 적어라).
- **코어**: `typecheck` · `test` · **`gate:purity`** 통과.
- `clients/mobile-spike` 의 `npx jest` 계속 통과.
- **하지 마라**: `expo prebuild`, EAS, Android 디렉터리 생성, 실기기 설치(오케스트레이터가 한다).

## 8. PR
`feat/RN-C2-app-scaffold` → `track/engine`. 본문에: 배선 항목별 근거·코어를 실제로 호출한 지점·저장소 분리 구현·Origin 이슈 메모·웹/코어 게이트 수치·이탈. **PR 후 STOP.**
