# goal HYG-1 — 후속 잔여 정리 (검수 전 마지막 청소)

너는 momo(제품명 oort) 레포의 구현 worker다. 이 문서가 유일한 지시서.
**base = `track/engine`**. 워크트리 `~/projects/momo-tracks/momo-worktrees/HYG-1-followups`(브랜치 `feat/HYG-1-followups`, 생성됨).

발단: RN v0·푸시 파이프라인이 다 섰고, 곧 **성재 실기기 검수**(대화 → 푸시 → TestFlight)를 한 번에 돈다. 그 전에 **여러 배치가 "범위 밖"으로 남겨 둔 티켓들**을 닫는다. 작지만 전부 실측으로 확인된 것들이다.

## 0. 규율
`.env`·자격증명 금지 · **docker 금지** · **실서버 접속 금지** · **`clients/mobile`·`clients/web`·`packages/momo-core` 수정 금지**(안정화 구간이다 — 검수 직전에 흔들지 마라) · 커밋은 새 커밋만 · **PR 후 STOP**.
**와이어 계약을 바꾸지 마라** — 아래 1번은 **분석과 제안**이지 변경이 아니다.

---

## 1. `work_session_idle` 푸시가 조용히 폐기된다 — **분석 + ADR 부록 제안**
**실측(오케스트레이터 확인)**: relay 의 dispatch 검증이 허용하는 `reason` 은 **`dm` · `mention` · `approval_request` · `resume_offer`** 넷뿐이다(`relay/PushRelay/Sources/PushRelay/PushDispatch.swift:70`). 그런데 서버 판정은 `work_session_idle` 을 낸다(`server-rust/crates/momo-push/src/dispatch.rs:55`) → relay 400 → notifier 가 **영구 실패로 정산하고 조용히 폐기**한다. e2e 게이트가 못 보는 이유는 `mock_push_relay.py` 가 **어휘 검증을 전혀 안 하기** 때문이다.

**할 일**
1. 체인을 끝까지 확인해라: 서버 판정 → relay 어휘 → **iOS NSE/클라가 받는 category·reason**. 어디까지가 4종만 아는지 정확히 적어라.
2. **ADR-0120 에 붙일 부록 초안**을 써라(`docs/adr/` 에 신규 파일 말고 **ADR-0120 본문에 「미결」 절 추가** 또는 별도 제안 문서 — 판단해라). 담을 것: 증상·영향 범위(T3 작업 세션 알림이 통째로 안 감)·선택지 셋(어휘 확장 / 판정에서 제거 / `resume_offer` 로 접기)과 각각의 대가·권고 1개.
3. **Accept 는 성재 몫**이므로 **코드는 바꾸지 마라.** 단 `mock_push_relay.py` 가 어휘를 검증하지 않아 이 결함을 숨긴다는 사실은 **테스트로 못박아도 좋다**(현행 동작을 고정하는 방향으로).

---

## 2. macOS `DEVELOPMENT_TEAM` 이 비어 있다
`scripts/verify_ios_signing.sh` 가 매 실행 **WARN** 을 낸다: `clients/macOS/MomoMac.xcodeproj/project.pbxproj` 의 `DEVELOPMENT_TEAM` 이 빈 문자열 → 자동 서명 CI 가 팀을 못 고른다.
- iOS 프로젝트는 `YWQQFQM38J` 로 박혀 있고 mac 번들 ID 는 `com.dawnkim.momo`(같은 팀).
- **채워라.** 그리고 WARN 이 사라지는지 확인해라. 채운 뒤에도 WARN 이 남으면 검사 쪽 문제이니 그것도 고쳐라.
- macOS 빌드가 이 변경으로 깨지지 않는지 확인(`swift build`/`xcodebuild -list` 수준이면 충분, 서명 실행은 금지).

## 3. `docs/RELEASE_PLAYBOOK.md` 의 옛 iOS 푸시 App ID 서술
`:213` 과 `:290` 근처가 옛 값이다(감사가 지목). **현재 정본**은: 앱 `app.momo.ios`, 확장 `app.momo.ios.NotificationService`, App Group `group.app.momo.ios`, keychain group `$(AppIdentifierPrefix)app.momo.ios.shared`, 팀 `YWQQFQM38J`. 문서를 현재로 맞추고, **`docs/cicd/10-ios-signing-identity-runbook.md`·`11-ios-push-device-check.md`·`12-push-relay-deploy-runbook.md` 와 어긋나지 않게** 상호 참조를 걸어라.

## 4. Swift 대문자 vs Rust 소문자 메시지 id — **결론을 문서에 고정**
실측: Swift 는 `id.uuidString`(대문자), Rust 는 `to_string()`(소문자). **살아 있는 결함은 아니다** — 웹은 `api.ts` 의 `uuidEq` 가 *"UUIDs cross the wire in mixed case by design"* 주석까지 달고 처리하고, mac/iOS 는 `UUID` 파싱이라 면역이며, 현 배포는 Rust 단독이라 자기정합이다. 드리프트 게이트 정규식이 `[0-9a-fA-F]` 라 양쪽 다 통과해 **아무도 못 잡는다**.
- **고치지 마라.** 대신 이 판단을 **한 곳에 문서로 고정**해라(왜 안 고치는지, 언제 문제가 되는지 = Swift·Rust 혼합 배포가 생기는 날).
- 관련: 반응 DTO 의 대문자 id 도 같은 계열이고 **이미 "현행 재현 유지"로 판단**됐다(`openapi.yaml` 이 비준한 계약). 두 판단을 같은 자리에 모아라.

---

## 5. 검증
- `scripts/verify_ios_signing.sh` **WARN 0**.
- 문서 변경은 인용한 경로·줄이 실제와 맞는지 스스로 재확인(**틀린 근거는 없는 근거보다 나쁘다**).
- 무회귀: `cargo check/test/fmt/clippy`(서버 안 건드렸어도 확인), `packages/momo-core`·`clients/web` 수치 불변.
- 1번에서 테스트를 추가했다면 그것도 green.

## 6. PR
`feat/HYG-1-followups` → `track/engine`. 본문에: 항목별 처리·1번의 권고와 근거·확인한 게이트. **PR 후 STOP.**
