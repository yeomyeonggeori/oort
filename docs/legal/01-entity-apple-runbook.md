# momo — L0/L1 등록 준비 런북: 등록주체, D-U-N-S, Apple Developer Program

> **법률 자문 아님.** 이 문서는 Apple 배포를 시작하기 전의 운영 런북/체크리스트다. 법인 설립, 세무, 계약, 개인정보/EULA 문구는 외부 변호사 또는 세무 전문가의 1회 검토가 필요하다.
> 확인일: 2026-06-26. Apple/D&B 정책과 금액은 바뀔 수 있으므로 실제 등록 직전에 1차 출처를 다시 확인한다.
> 비밀값(D-U-N-S, Team ID, API Key, 인증서, `.p8`)은 **리포 평문 금지**. 보관 위치만 `docs/cicd/02-secrets-inventory.md` 방식으로 기록한다.

## 0. 범위와 원칙

이 런북은 `MOMO-080`의 L0/L1만 다룬다.

| 단계 | 목적 | 실행 주체 | repo 산출물 |
|---|---|---|---|
| `L0-entity-decision` | 개인/법인 중 Apple 등록 주체 결정 | 사람 `[decision]` | 이 문서의 결정 기록 템플릿 |
| `L0-duns` | 법인 선택 시 D-U-N-S 조회/신청 | 사람 `[manual]` | 필요정보 체크리스트와 handoff 기록 |
| `L1-apple-enroll` | Apple Developer Program 등록과 $99/년 결제 | 사람 `[manual]` | 등록 후 Team ID/App Store Connect handoff 기록 |
| `L1-handoff` | CI/CD, Bundle ID, ASC API Key 준비로 넘김 | Codex + 사람 | `docs/cicd/01-setup-runbook.md`, `docs/cicd/02-secrets-inventory.md` 연결 |

Codex는 절차, 체크리스트, 템플릿, 링크, secret inventory 항목을 준비한다. Apple 계정 로그인, D&B 제출, Apple 계약 동의, 결제, 인증서/API Key 발급은 사람이 수행한다.

## 1. 현재 권장 흐름

현재 momo는 GitHub Actions가 disabled/manual-only이고, M7 QA 게이트 PASS 전에는 external TestFlight/App Store/공증 배포를 하지 않는다. 따라서 L0/L1의 목적은 "즉시 출시"가 아니라 M4/M5/M6에서 막히지 않도록 행정 선결을 준비하는 것이다.

권장 기본값(추정):

| 결정 | 기본값 | 이유 |
|---|---|---|
| 초기 개발/내부 검증 | 개인 등록 가능 | D-U-N-S 없이 빠르게 Team ID, Bundle ID, APNs, TestFlight 내부 검증 준비 가능 |
| B2B/상용/조직 명의 배포 | 조직 등록 권장 | App Store 판매자명이 법인명으로 표시되고 팀원/권한 운영이 자연스러움 |
| 법인 미설립 상태 | 개인으로 시작 후 전환 검토 | 조직 등록은 법적 실체, D-U-N-S, 업무 이메일, 공개 웹사이트, 구속 권한 검증이 필요 |

최종 선택은 사람이 한다. 선택 결과는 아래 §6 결정 로그에 한 줄로만 기록하고, 개인 식별값이나 번호는 기록하지 않는다.

## 2. 개인 vs 조직 등록 결정표 (`L0-entity-decision`)

| 항목 | 개인 / sole proprietor | 조직 / company, non-profit, partnership 등 |
|---|---|---|
| App Store 판매자명 | 개인의 법적 실명 | 법적 실체명 |
| D-U-N-S | 불필요 | 필수. 정부기관은 예외적으로 optional |
| 법적 실체 | 개인 본인 확인 | Apple과 계약 가능한 법적 실체 필요. DBA, fictitious business, trade name, branch는 불가 |
| 등록자 권한 | 본인 | 소유자/창업자/임원/시니어 리드 또는 법적 구속 권한을 위임받은 직원 |
| 이메일/웹사이트 | Apple Account 중심 | 조직 도메인 업무 이메일과 공개 동작 웹사이트 필요 |
| 팀 운영 | 제한적 시작에 적합 | 멤버 초대와 App Store Connect 역할 운영에 적합 |
| momo 판단 | 빠른 내부 검증에 적합(추정) | 정식 상용/B2B/조직 명의 배포에 적합(추정) |

공식 근거:
- Apple Program Enrollment: https://developer.apple.com/help/account/membership/program-enrollment/
- Apple D-U-N-S: https://developer.apple.com/help/account/membership/D-U-N-S/

사람 handoff:
- [ ] 등록 주체를 `개인` 또는 `조직`으로 결정한다.
- [ ] 조직 선택 시 법적 실체명, 대표/권한자, 조직 도메인 이메일, 공개 웹사이트가 준비됐는지 확인한다.
- [ ] 외부 변호사/세무 검토가 필요한 쟁점(법인 설립, 계약 주체, 세금계산/인보이스)을 별도 문서나 사내 위키에 기록한다.

Codex repo 산출물:
- [x] 이 결정표와 handoff 체크리스트를 유지한다.
- [x] `docs/legal/00-prelaunch-admin-legal-checklist.md`와 `docs/cicd/01-setup-runbook.md`에서 이 런북을 참조한다.
- [ ] 결정 완료 후 §6의 `결정 로그`에 날짜, 선택, 근거 1줄, 기록자만 남긴다.

## 3. D-U-N-S 준비 (`L0-duns`, 조직 선택 시만)

공식 사실:
- D-U-N-S는 D&B가 부여/관리하는 9자리 사업자 식별번호다.
- Apple은 조직 등록 시 D-U-N-S로 조직 신원과 법적 실체 상태를 확인한다.
- Apple 등록에서 회사/교육기관은 법적 실체에 등록된 D-U-N-S가 필요하다. 개인 등록에는 필요 없다.
- 조회/신청 시 법적 실체명, 본사 주소, 우편 주소, 업무 연락처가 필요하다.
- D&B가 사업 형태, 직원 수, 사업자등록 서류 등 추가 정보를 요청할 수 있다.
- 신청 후 D&B 번호 수령까지 최대 5영업일, Apple 반영까지 추가 최대 2영업일이 걸린다. expedited 처리는 이 대기기간을 줄이지 않는다.

공식 근거:
- Apple D-U-N-S: https://developer.apple.com/help/account/membership/D-U-N-S/
- Apple/D&B 조회 도구: https://support.dnb.com/?CUST=APPLEDEV

사람 handoff:
- [ ] Apple/D&B 조회 도구에서 기존 D-U-N-S 보유 여부를 확인한다.
- [ ] 없으면 무료 신청을 제출한다.
- [ ] D&B 연락에 답할 담당자 1명을 지정한다.
- [ ] 사업자등록/법인 등기/주소 증빙 등 D&B가 요청할 수 있는 증빙을 준비한다.
- [ ] 번호 수령 후 Apple 반영까지 최대 2영업일 대기한다.
- [ ] D-U-N-S 번호는 password manager/사내 secret store에 저장하고 리포에는 저장하지 않는다.

Codex repo 산출물:
- [x] 필요정보와 증빙 체크리스트를 문서화한다.
- [x] `docs/legal/02-cost-ledger.md`에는 D-U-N-S 비용을 `$0`으로 둔다.
- [ ] 완료 시 §6의 `수동 절차 로그`에 "D-U-N-S 확보 완료", 날짜, 보관 위치 alias만 기록한다.

필요정보 체크리스트:

| 정보 | 예시/주의 | 리포 기록 가능 여부 |
|---|---|---|
| 법적 실체명 | Apple/D&B/등기 문서의 표기와 일치 | 가능 |
| 본사 주소 | 영문 주소 표기까지 준비 | 가능 |
| 우편 주소 | 본사와 다르면 별도 | 가능 |
| 업무 연락처 | 담당자 이름, 업무 이메일, 전화 | 보관 위치만 권장 |
| 사업자/법인 증빙 | D&B 요청 시 제출 | 리포 금지 |
| D-U-N-S 번호 | 9자리 번호 | 리포 금지 |

## 4. Apple Developer Program 등록 (`L1-apple-enroll`)

공식 사실:
- 등록 시작에는 2FA가 켜진 Apple Account와 거주 지역 기준 성년 요건이 필요하다.
- 조직 등록은 법적 실체명과 D-U-N-S를 제출하고, 등록자가 조직을 Apple 계약에 구속할 권한을 갖고 있어야 한다.
- 조직 등록자는 업무 이메일이 조직 도메인과 연결되어야 하며, 조직 웹사이트는 공개적으로 접근 가능하고 동작해야 한다.
- Apple Developer Program 연회비는 99 USD다. 지역별 현지 통화와 세금은 결제 단계에서 달라질 수 있다.
- 개인/sole proprietor는 등록 시 개인 법적 실명이 App Store 판매자명으로 표시된다.
- 조직은 Apple 검증 후 멤버십 구매 단계로 이어진다.

공식 근거:
- Apple Program Enrollment: https://developer.apple.com/help/account/membership/program-enrollment/
- Apple Developer Program Membership: https://developer.apple.com/programs/whats-included/
- Apple Enroll: https://developer.apple.com/programs/enroll/

사람 handoff:
- [ ] Account Holder로 쓸 Apple Account의 2FA를 켠다.
- [ ] `개인`이면 법적 실명과 결제수단을 준비한다.
- [ ] `조직`이면 D-U-N-S, 법적 실체명, 조직 도메인 업무 이메일, 공개 웹사이트, 구속 권한 증빙을 준비한다.
- [ ] Apple Developer 앱 또는 웹에서 등록한다.
- [ ] Program License Agreement를 검토/동의한다.
- [ ] 연회비 $99 USD를 결제한다.
- [ ] Team ID와 Account Holder 정보를 secret store에 보관한다.
- [ ] App Store Connect 접근과 Certificates, Identifiers & Profiles 접근을 확인한다.

Codex repo 산출물:
- [x] 등록 전 체크리스트와 등록 후 handoff 항목을 문서화한다.
- [x] `docs/cicd/01-setup-runbook.md`가 이 등록 완료를 사전 요건으로 가리키게 한다.
- [ ] 등록 완료 후 §6의 `수동 절차 로그`에 Team ID 보관 위치 alias만 기록한다.
- [ ] 등록 완료 후 `docs/cicd/02-secrets-inventory.md`에 ASC/API/signing secret 보관 상태를 맞춘다.

## 5. 등록 후 CI/CD handoff (`L1-handoff`)

Apple Developer Program 등록이 완료되면 다음 단계로 넘긴다. 단, release workflow 실행과 external TestFlight/App Store 제출은 M7 QA 게이트 PASS 전까지 금지다.

| 후속 항목 | 담당 | 연결 문서 | 비고 |
|---|---|---|---|
| Bundle ID / App ID 등록 | 사람 | `docs/cicd/01-setup-runbook.md` | `com.dawnkim.momo` 또는 최종 bundle 전략 결정 필요 |
| App Store Connect App 레코드 | 사람 | `docs/cicd/01-setup-runbook.md` | 이름, primary language, SKU 등 |
| ASC API Key 발급 | 사람 | `docs/cicd/01-setup-runbook.md`, `docs/cicd/02-secrets-inventory.md` | `.p8`는 1회 다운로드, 리포 금지 |
| signing repo/match 준비 | 사람 + Codex 문서 | `docs/cicd/01-setup-runbook.md` | GitHub Actions는 현재 disabled/manual-only |
| local gate evidence | Codex | `docs/LOCAL_PR_GATE.md` | 현재 PR merge 기준 |
| release workflow 실행 | momo-main/사람 | `docs/cicd/03-store-readiness-gate.md` | M7 PASS 전 실행 금지 |

## 6. 결정 및 수동 절차 로그

리포에 적어도 되는 것은 상태와 보관 위치 alias뿐이다. 식별번호, key, 인증서, 결제정보는 남기지 않는다.

| 날짜 | 항목 | 상태 | 기록 |
|---|---|---|---|
| YYYY-MM-DD | L0 등록 주체 | 미정 | 결정자/근거 1줄 |
| YYYY-MM-DD | L0 D-U-N-S | 해당 없음 또는 위임/완료 | 보관 위치 alias만 |
| YYYY-MM-DD | L1 Apple Developer Program | 위임/완료 | Team ID 보관 위치 alias만 |

## 7. MOMO-080 완료 기준

- [x] 개인/조직 결정 기준과 handoff 절차를 문서화했다.
- [x] 조직 선택 시 D-U-N-S 조회/신청, 필요정보/증빙, 대기기간, 비밀값 보관 원칙을 문서화했다.
- [x] Apple Developer Program 등록 사전조건, 결제, 등록 후 Team ID/App Store Connect handoff를 문서화했다.
- [x] 실제 D&B/Apple 제출, 계약 동의, 결제, 인증서/API Key 발급은 사람 `[manual]`로 분리했다.
- [x] 이 문서는 법률 자문이 아니며 출시 전 외부 전문가 검토가 필요하다고 명시했다.

완료 후 `docs/legal/00-prelaunch-admin-legal-checklist.md`와 `STATUS.md`에는 L0/L1 런북 준비 완료만 기록한다. 실제 외부 등록 완료 여부는 사람이 별도로 갱신한다.
