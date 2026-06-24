# momo — 법인결정 → D-U-N-S → Apple 등록 런북 (사람 1회 절차)

> **법률 자문 아님.** `[manual]`/`[decision]` 단계의 사람 실행 절차. Codex는 이 문서 유지·플레이스홀더 채움만.
> 비밀값(D-U-N-S, Team ID, API Key)은 **리포 평문 금지** — `docs/cicd/02-secrets-inventory.md` 규칙 따름.

## 단계 0 — 등록 주체 결정 (`L0-entity-decision`)
- [ ] 개인 vs 법인 선택(체크리스트 §1 표 참조). 결정: ____________ (사유: ____________)
- 개인 선택 → D-U-N-S 스킵, 단계 2로.
- 법인 선택 → 단계 1.

## 단계 1 — D-U-N-S (법인만, `L0-duns`)
- 사실: 무료 / 신청 후 최대 5영업일 수령 + Apple 반영 2영업일 = 약 7영업일. expedite로 단축 불가.
  출처: https://developer.apple.com/help/account/membership/D-U-N-S/
- [ ] 조회: https://support.dnb.com/?CUST=APPLEDEV (법적실체명·본사주소·우편주소·연락처)
- [ ] 미보유 시 무료 신청 → 대기.
- [ ] 번호 수령 → Apple 반영 2영업일 대기.
- [ ] 확보 완료(날짜): __________ / 보관 위치(시크릿): __________

## 단계 2 — Apple Developer Program 등록 (`L1-apple-enroll`)
- 사실: 연 $99 USD. 2FA 필수. 조직 등록자는 법적 구속 권한 보유.
  출처: https://developer.apple.com/programs/enroll/ , https://developer.apple.com/programs/whats-included/
- [ ] Apple Account 2FA 활성.
- [ ] Apple Developer 앱/웹에서 등록(개인 또는 조직+D-U-N-S).
- [ ] $99 결제.
- [ ] Team ID 확보: __________ (보관 위치: __________)
- [ ] App Store Connect 접근 확인.

## 단계 3 — App 레코드 / Bundle ID (게이트 03 G-3 연계)
- [ ] Bundle ID `com.dawnkim.momo`(macOS/iOS 공유 또는 `.ios`/`.mac` 분리) 등록.
- [ ] ASC App 레코드 생성(이름 "momo", 1차 언어).
- [ ] 이후 `docs/cicd/01-setup-runbook.md` M1(API Key)·M2(match 서명)로 진행.

## 단계 4 — 후속(법무·세무, 사람)
- [ ] 한국 정식 상용 시 법인화/부가통신·세무 검토(체크리스트 §8).
- [ ] 변호사 1회 검토(개인정보처리방침·EULA·에이전트 고지).

> 완료 시 체크리스트(00) 상단에 "행정/법무 게이트 진행상황" 갱신.
