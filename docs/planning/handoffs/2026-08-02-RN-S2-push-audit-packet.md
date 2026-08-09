# goal RN-S2 — 푸시 승계 감사 + 라이브러리 실측 선택 (#837 게이트 4)

너는 momo(제품명 oort) 레포의 구현 worker다. 이 문서가 유일한 지시서.
**base = `track/engine`**(`a591bc62`). 워크트리 `~/projects/momo-tracks/momo-worktrees/RN-S2-push-audit`(브랜치 `feat/RN-S2-push-audit`, 생성됨).

발단: ADR-0137 D7 — **"Swift 푸시 391줄과 배포 레인은 살린다"**. #837 게이트 4는 그 주장이 **실제로 성립하는지** 실증하는 것이다. 지금은 주장일 뿐 증명이 아니다.

## 0. 규율
`.env`·자격증명 금지(파일명 출력도) · **PR 후 STOP**(amend/force-push 금지, 머지·close 금지) · 워크트리 밖 파일은 **읽기만** · 서버 코드·`schema_v0.sql` 수정 금지 · **전역 설치 금지**(brew·gem·global npm 전부. 필요하면 보고서에 "필요하다"고 적어라).
**RN 앱 스캐폴드를 만들지 마라** — 그건 병렬로 도는 다른 워커(RN-S1)가 `clients/mobile-spike/`에 만든다. **그 디렉터리를 건드리지 마라.** 충돌한다.

## 1. 맡은 것 = 게이트 4
`MomoiOSPushKit/PushNotification.swift`(**329줄**, import가 `Foundation`·`Security`뿐)와 `NotificationService.swift`(**62줄**) — **ADR-0120 D2-A 구현이 RN 프로젝트에서 그대로 생존하는지** 판정한다.
증명할 한 바퀴: **id-only 페이로드 → NSE가 fetch → 표시 → 알림 액션에서 승인**.

## 2. 할 일

### 2-1. 승계 자산 실측 감사 (코드로)
1. 두 파일을 **직접 읽고** 실제 의존 표면을 적어라(import·프레임워크·entitlement·Info.plist 키·App Group·Keychain 접근 등). ADR이 "import가 Foundation·Security뿐"이라 주장하는데 **사실인지 확인**하고, 사실이면 그게 왜 이식성에 결정적인지 적어라.
2. **RN 프로젝트에 이 NSE 타깃을 붙일 때 무엇이 필요한지**를 단계로 적어라(Xcode 타깃 추가·서명·entitlement·App Group 공유·번들 ID 규칙). bare RN이라 Xcode 프로젝트를 우리가 소유한다는 점이 유리하게 작용하는 지점을 짚어라.
3. **Tauri에서 왜 이게 죽었는지**를 대조로 적어라(ADR-0137 Context 5: Tauri iOS CI 서명에서 NSE entitlement 유실 #15663). 같은 함정을 RN에서 밟지 않으려면 무엇을 지켜야 하는지가 이 감사의 실질 산출이다.
4. 서버 쪽 계약도 읽어라 — id-only 페이로드를 **누가 어떤 모양으로 보내는지**(Rust 서버에 푸시 발송 경로가 이식돼 있는지도 확인. 없으면 "미이식"이라고 정직하게 적어라. 이건 게이트 4의 판정에 영향을 준다).

### 2-2. 푸시 JS 라이브러리 선택 — 실측으로
후보는 **`expo-notifications`** vs **`@react-native-firebase/messaging`** 둘이다.
**`Notifee` 계열은 제외**(레포 archived, README가 이관 권고 — 이미 판정됨).

각 후보에 대해 근거를 대고 비교해라:
- bare RN(EAS 미도입)에서 설치·설정 난이도. **Expo 모듈 낱개 도입 방침(D1)과의 정합.**
- **우리 NSE와 공존 가능한가** — 라이브러리가 자기 NSE/delegate를 강제해 우리 329줄을 밀어내지 않는가. 이게 가장 중요한 축이다.
- iOS **silent push**(content-available) 지원. id-only 설계가 여기 의존한다.
- 알림 **액션(승인)** 지원 — 알림에서 바로 승인하는 우리 흐름이 되는가.
- Android(FCM) 경로가 어떻게 되는가(게이트 6 대비).
- 유지보수 상태(최근 릴리스·이슈 응답·RN New Arch 지원).
- 자격증명이 어디에 사는가 — **ADR-0004(provider 자격증명 비유입)** 와 충돌하는 요구가 있는지.

**애매하면 애매하다고 적고 무엇을 더 재야 결론이 나는지 써라.** 억지로 하나를 고르지 마라.

## 3. 하지 말 것
RN 앱 스캐폴드·`clients/mobile-spike/` 진입(→RN-S1) · IME/리스트/centrifuge 검증(→RN-S1) · Android 실기기(→게이트 6, 2차) · 전역 도구 설치 · 서버 수정.

## 4. 산출물
`docs/planning/2026-08-02-rn-push-inheritance-audit.md` **한 파일**(신규).
구성: ①한 문단 결론(게이트 4가 `PASS/FAIL/기기대기` 중 무엇이고 왜) ②승계 자산 실측표(파일·줄수·의존·이식 시 필요한 것) ③RN 부착 절차 ④Tauri가 실패한 지점과 우리가 지켜야 할 것 ⑤라이브러리 비교표 + **권고 1개**(또는 "더 재야 함"과 그 항목) ⑥서버측 미이식/공백 ⑦위험·미확인.
한국어. 마케팅 어휘 금지. **추측과 실측을 문장에서 구분해라.**

## 5. 검증·PR
문서 배치라 코드 게이트는 없다. 다만 **인용한 줄번호·파일 경로가 실제와 맞는지** 스스로 재확인해라(틀린 근거는 없는 근거보다 나쁘다).
PR `feat/RN-S2-push-audit` → `track/engine`. 본문에 결론 요약과 권고. **PR 후 STOP.**
