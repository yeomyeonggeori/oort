# clients/mobile-spike — 버려질 스파이크 하네스

> **이 디렉터리는 제품 코드가 아니다.** ADR-0137 D6 의 게이트 판정을 받아 내기 위한
> 계측 장치이고, 판정이 끝나면 **삭제된다**. 여기 있는 코드를 momo 모바일 앱의
> 시작점으로 삼지 마라. 품질을 올리려고 손보지도 마라 — 재사용을 전제하는 순간
> 이 배치의 목적(싸게 진실을 알아내기)이 깨진다.
>
> 실제 앱의 출발점은 스파이크 전항 PASS 후의 `packages/momo-core` 추출 티켓이다.
> **지금 모노레포를 만들지 마라.**

담당 게이트: **1(한글 IME) · 2(URL/딥링크) · 3(centrifuge-js) · 5(타임라인 리스트)**
게이트 4(푸시/NSE)와 6(Android)은 다른 배치 소관이다.

- 스택: bare React Native **0.86.2** / React 19.2.3 / New Architecture(기본 ON) / Hermes
- 판정 보고서 정본: `docs/planning/2026-08-02-rn-spike-report.md`

---

## 0. 한 번만 하면 되는 준비

```bash
brew install cocoapods watchman          # 이미 설치됨(1.17.0 / 2026.07.27)
cd clients/mobile-spike
npm install
cd ios && pod install && cd ..
```

## 1. 기기 없이 지금 바로 나오는 판정 (게이트 2)

```bash
cd clients/mobile-spike
npx jest
```

`__tests__/gate2_deeplink.test.ts` 가 **웹의 진짜 `deepLink.ts` 를 그대로 import** 해서
URL 구현 3종(Node 내장 / RN 0.86 코어 / `react-native-url-polyfill`) 위에서 돌린다.
콘솔에 3종 비교표가 찍힌다. 복사본이 아니라 실제 파일이므로 "무수정 통과"가
주장이 아니라 측정이다.

## 2. 앱 띄우기

```bash
cd clients/mobile-spike
npx react-native run-ios                      # 시뮬레이터
npx react-native run-ios --device "성재의 iPhone"   # 실기기
```

상단 탭 4개(`1 · IME` / `2 · URL` / `3 · 실시간` / `5 · 리스트`)로 게이트를 오간다.

> **시뮬레이터로 IME(게이트 1)와 스크롤 보존(게이트 5)을 판정하지 마라.**
> 시뮬레이터는 맥 키보드를 쓰기 때문에 iOS 한글 IME 의 조합 동작을 재현하지
> 않고, 스크롤 보존도 실기기와 다르게 나온다. 그 둘은 **반드시 실기기**다.

---

## 3. 성재가 실기기에서 할 조작 (순서대로)

### 게이트 1 — 한글 IME (최우선)

준비: 설정 → 일반 → 키보드 → 키보드 추가에서 **한국어 2벌식**과 **천지인**을
둘 다 추가해 둔다.

키보드 **하나당 아래를 한 바퀴** 돌고, 마지막에 화면 맨 위 요약 카드가 보이게
**스크린샷 한 장**을 남긴다. (2벌식 / 천지인 / iOS 기본 한글 → 총 3장)

1. 상단에서 지금 쓰는 키보드 버튼을 누른다 (`● 2벌식` 처럼 표시됨).
2. **A~D 카드**: 각 입력칸에 **"안녕하세요"** 를 **한 글자씩 천천히** 친다.
   붙여넣기 금지, 자동완성 후보 탭 금지 — 손으로 조합해야 의미가 있다.
3. **E 카드**: **"한글"** 을 친 뒤 **백스페이스로 전부 지운다**(빈 칸이 될 때까지).
4. 각 카드에서 **조합 중(글자가 완성되기 전) 밑줄이 보였는지**를
   `밑줄 보임` / `안 보임` 버튼으로 답한다. ← **이것만 사람 판단이다.**
5. 화면 맨 위로 올려 요약 카드를 스크린샷.

앱이 스스로 판정하는 것: 최종 값이 "안녕하세요"와 정확히 같은가,
그리고 **조합 불변식 위반**(한 번의 입력이 이전 값의 마지막 글자보다 많은 것을
지우거나 두 글자 이상을 한 번에 만드는 것)이 0건인가. 위반한 전이는 빨간색으로
찍히므로 스크린샷에 그대로 남는다.

### 게이트 2 — URL / 딥링크

1. `2 · URL` 탭을 연다. 케이스 표가 **19/19 통과**인지 본다(스크린샷).
2. 실제 딥링크 왕복까지 보려면: Safari 주소창에
   `oort://join?server=https%3A%2F%2Fapi.example.com&code=TEST-1234`
   를 넣고 이동 → 앱이 열리는지.
   **단 스킴 등록은 이 배치에서 하지 않았다** — 보고서 §게이트 2 "막힌 지점" 참조.

### 게이트 3 — centrifuge-js 리플레이

맥에서 먼저:

```bash
cd clients/mobile-spike/tools/centrifugo-spike
./run.sh up      # Centrifugo + 브로커 기동, 맥의 LAN 주소를 찍어 준다
./run.sh ip      # LAN 주소만 다시 보고 싶을 때
```

기기에서: `3 · 실시간` 탭 → 호스트 칸에 **맥의 LAN 주소**를 넣고
(시뮬레이터면 `127.0.0.1` 그대로) → `리플레이 게이트 실행`.
`missing 0` 이면 PASS. 결과 카드를 스크린샷.

끝나면 **반드시**:

```bash
./run.sh down    # 컨테이너까지 정리한다. 이 레포는 도커 자원이 쌓인 전례가 있다.
```

### 게이트 5 — 타임라인 리스트

`5 · 리스트` 탭. 세 구현(`Animated.FlatList` / `FlashList v2` / `@legendapp/list`)
각각에 대해:

1. 구현 버튼을 누른다.
2. **① 자동 스크롤 + FPS** — 스크립트가 같은 거리를 같은 속도로 민다(손으로 밀면 비교가 안 된다).
3. **② 새 메시지 도착** — 앵커 행이 몇 px 움직였는지 잰다. **0~2px 면 보존, 크면 튄 것.**
4. **③ 과거 20건 위로** — 프리펜드 시 위치 보존.
5. `Animated.FlatList` 에서는 `mVCP: 켬/끔` 을 토글해 **양쪽 다** 재라 — 차이 자체가 데이터다.

세 구현 결과가 한 카드에 누적되므로 **마지막에 스크린샷 한 장**이면 된다.

추가로 UI 스레드 프레임률은 앱 흔들기 → 개발자 메뉴 → **Perf Monitor** 로 읽어야
한다(화면에 찍히는 FPS 는 **JS 스레드** 값이다).

---

## 4. 디렉터리

```
src/gate1_ime/     composition.ts  조합 불변식(순수 로직) · ImeGate.tsx 계측 화면
src/gate2_url/     cases.ts        웹 테스트를 그대로 옮긴 케이스 목록
                   webEnvStub.ts   웹 env.ts 의 RN 대역 (= 실측된 어댑터 비용)
                   UrlGate.tsx
src/gate3_realtime/RealtimeGate.tsx
src/gate5_list/    data.ts         한국어 가변 높이 더미 1k행 · ListGate.tsx
tools/centrifugo-spike/
                   run.sh          로컬 Centrifugo + 브로커 기동/정리
                   broker.mjs      토큰 발급 · 메시지 주입 · seq 백필 (의존성 0)
                   resume-node.mjs 같은 시나리오의 Node 기준선
                   centrifugo.json infra/centrifugo.json 의 ch 네임스페이스 사본
```

`metro.config.js` 와 `jest.config.js` 가 `@/…` 를 `clients/web/src/…` 로 이어 준다.
웹 파일은 **읽기만** 하며 이 배치에서 웹은 한 줄도 고치지 않았다.

## 5. 자격증명

이 하네스는 `.env` 도, 실서버 자격증명도 읽지 않는다. 게이트 3의 시크릿은
`run.sh` 가 **매 기동마다 새로 만들고** 파일에 쓰지 않는다.
**실서버(app.oor7.com) 왕복은 이 배치 범위 밖**이며 오케스트레이터 몫이다.
