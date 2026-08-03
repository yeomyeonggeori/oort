# goal RN-P3 — 중간에서 보낸 내 메시지가 안 보이는 결함 + 키보드 점화 네이티브화

너는 momo(제품명 oort) 레포의 구현 worker다. 이 문서가 유일한 지시서.
**base = `track/engine`**. 워크트리 `~/projects/momo-tracks/momo-worktrees/RN-P3-selfsend`(브랜치 `feat/RN-P3-selfsend`, 생성됨).

**결함 수정 배치다. UI 고도화가 아니다** — 성재가 "UXUI 고도화는 지금 당장 안 해도 된다"고 했다. 범위를 넓히지 마라.

## 0. 규율
`.env`·자격증명 금지 · **서버 코드·`schema_v0.sql` 금지** · **docker 금지** · **실서버 접속 금지** · **`clients/web`·`clients/iOS`·`clients/mobile-spike`·`packages/momo-core` 수정 금지**(코어는 읽기 우선, 고치면 최소+사유) · `expo prebuild`·EAS·`android/` 금지 · 커밋은 새 커밋만 · **PR 후 STOP**.

---

## 결함 1 — 중간에서 보낸 내 메시지가 여전히 안 보인다
직전 배치가 **"이 배치 전부터 FAIL"** 이라고 범위 밖으로 남긴 항목이다(RN-C5 캡처에 「가려짐」으로 기록, RN-P2 가 회귀 아님을 확인). **이제 그게 이 배치다.**

성립해야 하는 규칙은 이미 정해져 있다:
- **남이 말하면** 읽던 위치를 뺏지 않는다(≤2px). — 유지
- **내가 말하면** 따라간다. — 지금은 **꼬리 근처에서만** 성립하고, **중간에서 보내면 내 메시지가 접힌 아래로 숨는다.**

`selfSendToken` 경로가 이미 있으니(RN-C5) 그것이 **중간 스크롤 위치에서도** 작동하도록 고쳐라. 키보드가 올라오며 리스트 높이가 주는 순간과 겹치는 것이 원인일 가능성이 높다 — **확인하고 고쳐라.**

**측정으로 증명해라**: 타임라인 중간(꼬리에서 충분히 떨어진 지점)에서 전송했을 때 **내 메시지가 화면 안에 있는가**. 지난 배치가 이 항목을 "실패가 아니라 **미측정**"으로 남긴 이유가 측정 seam 이 새 행에 안 붙어서였다 — **그 seam 부터 붙여라.** 측정 못 하는 성질은 지켜지지 않는다.

---

## 결함 2 — 키보드 점화가 아직 JS 에 있다
직전 배치가 이동은 네이티브로 뗐다(도착 353ms → 228/245ms, JS 75% 점유에서도). **점화는 못 뗐다** — `keyboardWillShow` 가 JS 콜백이고 NativeAnimated 큐가 `setImmediate` 로 플러시된다. 그때는 **`ios/*.xcodeproj` 가 다른 배치 소유라 못 건드렸다. 지금은 비었다.**

- 첫 이동 **≤17ms**(한 프레임)를 달성해라. 네이티브 모듈로 키보드 프레임 알림을 받아 애니메이션을 네이티브에서 점화하는 방향이 유력하되, **네 판단으로 하고 근거를 대라.**
- **NSE 타깃을 깨뜨리지 마라.** `ios/MomoMobile.xcodeproj` 에는 방금 두 번째 타깃(`MomoMobileNotificationService`)이 들어왔다. `scripts/verify_ios_signing.sh` 와 `scripts/verify_push_kit_inheritance.sh` 가 **계속 통과**해야 한다.
- **못 달성하면 기준을 늘리지 말고 FAIL 로 남겨라.** 지난 두 배치가 그렇게 한 것은 옳았다. 다만 이번엔 **계측 한계와 실제 미달을 반드시 구분**해서 적어라 — 지난 배치가 "계측기로는 17ms 를 증명할 수 없다"고 했으니, 필요하면 **계측기부터 고쳐라.**

---

## 지키던 성질 (되돌리지 마라)
입력 상태 **동기**(한글) · **`inverted` 금지** · 남이 말하면 위치 안 뺏김(≤2px) · 길게 누르기가 스크롤과 안 싸움(page 좌표) · 상태코드→한국어 문장 · 낙관적 되돌림은 그 행에 · 답글 표식과 롤업 즉시 반영 · 오프라인 시작이 로그인 화면이 아님.

## 검증
`npx tsc --noEmit` · `npx jest` · `gate:project-shape` · **`gate:session`** · `scripts/verify_ios_signing.sh` · `scripts/verify_push_kit_inheritance.sh` · **iOS 시뮬레이터 빌드 성공(두 타깃)**.
**회귀 0**: `packages/momo-core`·`clients/web` 수치 불변.
측정: 중간 전송 가시성(px 또는 화면 내/외) · 키보드 첫 이동/도착 ms(**JS 부하 있는 상태 포함**).

## PR
`feat/RN-P3-selfsend` → `track/engine`. 본문에 결함별 **원인 → 방법 → 수치**, 못 달성한 건 못 달성했다고, 계측 한계와 실제 미달의 구분. **PR 후 STOP.**
