# momo — 출시 전 행정/법무 선결 체크리스트 (2026)

> **법률 자문이 아님 (Not legal advice).** 정식 변호사/노무·세무사 검토를 대체하지 않는다.
> 모든 "사실"은 2026 기준 1차 출처 링크로 표기했다. 변동 가능 항목은 출시 직전 재확인.
> 실행 주체: **Codex(goal 자율)**. `[doc]`/`[file]`은 Codex가 산출, `[manual]`은 사람(Apple/D&B/관계기관) 1회.
> 선후관계: 이 문서의 **L-0(법인/식별자)** → **L-1(Apple 등록)** 은 스토어/CI 마일스톤(03·04)보다 **앞선다**.
> 단, 실제 스토어 제출은 `docs/cicd/03-store-readiness-gate.md` PASS 후. 이 문서는 그 게이트의 **G-3 정책/법무 행을 상세화**한다.

---

## 등급 정의
- `[doc]` = Codex가 이 리포에 마크다운/텍스트 산출(템플릿 채움). 검증 = 파일 존재 + 플레이스홀더 0.
- `[file]` = Codex가 리포에 실제 산출물 생성(NOTICE, LICENSE, Info.plist 키 등). 검증 = 파일 존재 + 빌드 정합.
- `[manual]` = 사람이 외부 기관/콘솔에서 1회 수행(D&B, Apple, 관계기관). Codex는 절차 문서/플레이스홀더만.
- `[decision]` = 사람이 사실 확인 후 선택해야 하는 분기(법무·세무 검토 권장).

## 다음 티켓 선택법 (Codex)
1. `dep`가 전부 done인 가장 낮은 order를 고른다.
2. `[manual]`/`[decision]`은 Codex가 **파일·절차·플레이스홀더만** 준비하고 사람에게 위임 표시(이 문서 + `01-` 런북).
3. 각 티켓 끝 DoD 충족 시 STATUS.md 또는 본 문서 상단에 날짜+커밋 기록.

| order | id | 등급 | 한줄 | dep |
|---|---|---|---|---|
| 1 | `L0-entity-decision` | decision | 개인 vs 법인 등록 결정(아래 §1) | — |
| 2 | `L0-duns` | manual | (법인 선택 시) D-U-N-S 발급/조회 | L0-entity-decision |
| 3 | `L1-apple-enroll` | manual | Apple Developer Program 등록($99/yr) | L0-duns |
| 4 | `L2-cost-ledger` | doc | 총비용 원장(이 리포 `docs/legal/02-cost-ledger.md`) | — |
| 5 | `L3-privacy-policy` | doc | 개인정보처리방침 본문 + 호스팅 URL | L1-apple-enroll |
| 6 | `L4-eula` | decision | EULA(표준 Apple vs 커스텀) 결정·링크 | L1-apple-enroll |
| 7 | `L5-app-privacy` | doc | App Privacy(데이터 수집) 신고표 작성 | L3-privacy-policy |
| 8 | `L6-kr-compliance` | decision | 한국 출시 법규(개인정보·부가통신·위치) 검토 | L3-privacy-policy |
| 9 | `L7-oss-notice` | file | permissive 의존성 NOTICE/오픈소스 고지 | — |
| 10 | `L8-agent-consent` | doc | 에이전트 대행 동의/고지 문구 | L3-privacy-policy |
| 11 | `L9-export-encryption` | decision | 암호화 수출규제(ITSAppUsesNonExemptEncryption) | L1-apple-enroll |

---

## §1. 법인 vs 개인 — Apple 등록 주체 결정 `L0-entity-decision` `[decision]`

| 항목 | 개인(Individual) | 조직(Organization) |
|---|---|---|
| D-U-N-S 필요 | **불필요** | **필수**(정부기관 제외) |
| 법인 등기 필요 | 불필요(개인 본인 확인) | 법적 실체(법인/유한책임회사 등) 필요. DBA·상호·지점·개인사업자 **불가** |
| App Store 표시명 | 개인 실명 | 조직(법인)명 |
| 팀 멤버 초대 | 제한적 | App Store Connect 다중 역할 가능 |
| 등록 소요 | 즉시~수일 | D-U-N-S(최대 7영업일) + Apple 검증 |

- **사실**: D-U-N-S는 정부기관 외 **회사·교육기관에 필수**, 개인 등록 시 불필요. 법적 실체만 인정(DBA/상호/지점/개인사업자 제외).
  ([Apple — D-U-N-S Number](https://developer.apple.com/help/account/membership/D-U-N-S/), [Apple — Enroll](https://developer.apple.com/programs/enroll/))
- **momo 맥락(추정)**: "플랫폼 관리자 전체 추적 + 멀티팀 워크스페이스 격리"는 조직 운영 색채가 강하나, App Store 등록 주체는 **법인 설립 여부와 별개**다. 초기 검증·TestFlight 단계는 개인 등록으로 충분(추정). 정식 상용·계약(B2B 워크스페이스 판매) 단계에서 법인 전환 검토.
- **DoD**: 이 문서에 "개인" 또는 "법인" 선택 + 근거 1줄 기록. 법인이면 `L0-duns`로, 개인이면 `L1-apple-enroll`로(D-U-N-S 스킵).

---

## §2. D-U-N-S 발급 (법인 선택 시) `L0-duns` `[manual]`

- **사실 — 기간**: D&B에 요청 후 번호 수령까지 **최대 5영업일**, 수령 후 Apple이 갱신정보 반영까지 **최대 2영업일** → **합계 약 7영업일**. 신속처리(expedite)로 단축 안 됨.
- **사실 — 비용**: **무료**(대부분 관할). 이미 부여돼 있을 수 있음 → 조회 먼저.
- **사실 — 조회**: Apple D-U-N-S 조회 도구(D&B, `support.dnb.com/?CUST=APPLEDEV`). 필요정보: 법적 실체명·본사 주소·우편 주소·업무 연락처. D&B가 사업자등록 서류를 요청할 수 있음.
  ([Apple — D-U-N-S Number](https://developer.apple.com/help/account/membership/D-U-N-S/))
- **절차(사람)**:
  1. 조회 도구에서 법인 D-U-N-S 보유 여부 확인.
  2. 없으면 무료 신청 → 최대 5영업일 대기.
  3. 번호 수령 후 Apple 반영 2영업일 대기 → 그 뒤 §3 등록.
- **DoD**: D-U-N-S 9자리 확보(시크릿/사내 위키에 보관, **리포에 평문 금지**). 이 문서엔 "확보 완료(YYYY-MM-DD)"만 기록.

---

## §3. Apple Developer Program 등록 `L1-apple-enroll` `[manual]`

- **사실 — 비용**: **연 $99 USD**(현지통화 환산, 멤버십 연 단위). 비영리/교육기관/정부는 요건 충족 시 수수료 면제 신청 가능.
  ([Apple — Membership Details](https://developer.apple.com/programs/whats-included/), [Apple — Fee Waivers](https://developer.apple.com/help/account/membership/fee-waivers/))
- **사실 — 요건**: 2단계 인증(2FA) 켠 Apple Account. 조직 등록 시 등록자가 Account Holder이며 **법적 구속 권한** 보유해야.
  ([Apple — Program Enrollment](https://developer.apple.com/help/account/membership/program-enrollment/))
- **절차(사람)**: Apple Developer 앱 또는 웹 등록 → (조직)D-U-N-S·법적실체명 입력 → Apple 검증 → $99 결제.
- **연계**: 등록 완료 후 `docs/cicd/01-setup-runbook.md`의 ASC API Key(M1)·서명(M2)으로 이어짐.
- **DoD**: Team ID 확보 + App Store Connect 접근. Bundle ID `com.dawnkim.momo` 등록(게이트 03 G-3). 이 문서에 "등록 완료(YYYY-MM-DD), Team ID 보관 위치" 기록.

---

## §4. 총비용 원장 `L2-cost-ledger` `[doc]`

> 상세 표는 별도 파일 `docs/legal/02-cost-ledger.md`. 요약:

| 항목 | 금액(2026, 추정/사실) | 주기 | 출처 |
|---|---|---|---|
| Apple Developer Program | **$99 USD** (사실) | 연 | Apple |
| D-U-N-S | **$0** (사실, 법인만 필요) | 1회 | Apple/D&B |
| `.com` 도메인 | 약 **$10~20/yr** (등록), 갱신 $15~40/yr (추정·시장가) | 연 | 시장 비교 |
| VPS 서버(서버+relay+worker) | 약 **$4~80/mo** (추정, 사양 의존) | 월 | 시장 비교 |
| Managed PostgreSQL 18 | 약 **$15~25/mo** (추정) 또는 VPS 셀프호스트 시 $0 추가 | 월 | 시장 비교 |
| (선택) Centrifugo 호스팅 | VPS 동거 시 추가 0 (추정) | — | 셀프호스트 |

- **소규모 합계(추정)**: 월 약 $20~25(도메인 연 $10~15 별도). 셀프호스트 단일 VPS로 묶으면 더 낮출 수 있음.
  ([도메인 비용](https://www.hostinger.com/tutorials/domain-name-cost), [VPS](https://www.digitalocean.com/solutions/vps-hosting), [PG 호스팅](https://northflank.com/blog/best-postgresql-hosting-providers))
- **DoD**: `02-cost-ledger.md`에 실제 선택한 벤더·플랜·실금액으로 갱신(플레이스홀더 0).

---

## §5. 개인정보처리방침 (필수) `L3-privacy-policy` `[doc]`

- **사실 — Apple**: **모든 앱**은 App Store Connect 메타데이터에 개인정보처리방침 **URL 필수**, 앱 내에서도 접근 가능해야. 데이터 미수집 앱도 그 사실을 적은 방침 필요. 수집 데이터·수집 방법·이용목적·제3자 동등보호·보존/삭제정책·동의철회/삭제요청 방법을 명시.
  ([App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) §5.1.1, [User Privacy and Data Use](https://developer.apple.com/app-store/user-privacy-and-data-use/))
- **사실 — 한국**: 개인정보보호법(PIPA, 정보통신망법 통합)상 개인정보처리방침은 **필수**. 위반 시 최대 매출 3% 과징금·형사처벌 가능. 필수동의/선택동의 분리, 선택동의 거부 시 불이익 금지.
  ([개인정보보호법 - 국가법령정보센터](https://www.law.go.kr/lsEfInfoP.do?lsiSeq=195062), [개인정보보호 포털](https://www.privacy.go.kr/front/main/main.do))
- **momo가 수집하는 데이터(스키마 기반, 검토 필요)**: 계정(이메일/표시명), 메시지 본문, 워크스페이스/멤버십, 비용·감사 로그, 에이전트 작업 기록(decision_ledger 등). APNs 토큰. → 방침에 메시지/대화 콘텐츠 처리, 에이전트(김인턴/OpenAI 호환 hermes)로의 **제3자 전송(LLM 제공자)** 고지가 핵심.
- **산출물**: `legal/privacy-policy.md`(원문) → 호스팅(도메인 `/privacy` 또는 GitHub Pages). URL을 App Store Connect·앱 설정화면·방침 링크에 연결.
- **DoD**: `legal/privacy-policy.md` 플레이스홀더 0 + 공개 URL 1개 + 앱 내 링크 위치 명시. (실제 법률 검토는 사람.)

---

## §6. EULA 결정 `L4-eula` `[decision]`

- **사실**: Apple 표준 EULA(LAEULA)가 자동 적용 — 커스텀 미제공 시 표준 적용되고 제품페이지에 라이선스 링크 미표시. 구독(자동갱신, 가이드라인 3.1.2) 포함 앱은 **EULA·개인정보처리방침 기능 링크** 제공이 요구됨.
  ([Apple 표준 EULA](https://www.apple.com/legal/internet-services/itunes/dev/stdeula/), [커스텀 EULA 제공](https://developer.apple.com/help/app-store-connect/manage-app-information/provide-a-custom-license-agreement/))
- **momo 맥락(추정)**: 초기엔 **표준 Apple EULA**로 충분(구독/결제 없음 가정). 워크스페이스 유료 판매·B2B 계약 도입 시 커스텀 EULA(이용약관/SLA) 검토.
- **DoD**: "표준" 또는 "커스텀" 선택 기록. 커스텀이면 `legal/eula.md` 산출 + ASC App Information에 등록.

---

## §7. App Privacy 데이터 신고 (Nutrition Label) `L5-app-privacy` `[doc]`

- **사실**: App Privacy 상세(영양성분표)는 **신규 앱·업데이트 제출 시 필수**. 통합한 **제3자 SDK/코드의 수집까지** 포함해 모든 수집 데이터 식별(선택공개 기준 전부 충족 시만 제외).
  ([App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/), [Manage app privacy](https://developer.apple.com/help/account/membership/program-enrollment/))
- **사실 — 2026 SDK 게이트**: 2026-04-28부터 App Store Connect 업로드는 최소요건 충족 필요(iOS/iPadOS 앱은 **iOS/iPadOS 26 SDK 이상** 빌드). → C2 Xcode 프로젝트 타깃 SDK 확인.
  ([Apple — Submitting](https://developer.apple.com/app-store/submitting/))
- **momo 신고표 초안(검토 필요)**: 식별자(계정), 사용자 콘텐츠(메시지), 진단/사용현황(있으면), 연락처(이메일). LLM 제3자 전송은 "데이터 사용 목적: 앱 기능" + 제3자 처리 고지로 매핑.
- **DoD**: `docs/legal/03-app-privacy-datamap.md`에 (데이터유형 × 수집여부 × 목적 × 연결/추적 여부) 표 작성 → ASC 입력값과 1:1 매칭.

---

## §8. 한국 출시 법규 검토 `L6-kr-compliance` `[decision]`

> **법률 자문 아님.** 아래는 사실 기반 분기 가이드. 실제 신고 요부는 변호사/관할 기관 확인.

### 8-1. 개인정보처리방침·동의 (필수)
- §5와 동일. PIPA 준수, 필수/선택동의 분리, 14세 미만 법정대리인 동의 등 검토.

### 8-2. 부가통신사업자 신고 (전기통신사업법 §22)
- **사실 — 면제 기준**: 인터넷 이용 부가통신역무 제공자 중 **자본금 1억원 이하**는 신고 면제(전기통신사업법 시행령 §30). 자본금이 1억원 초과 시 발생일로부터 **1개월 내 신고**. 신고기관은 중앙전파관리소 산하 지방 전파관리소.
  ([전기통신사업법 시행령 §30](https://lbox.kr/v2/statute/전기통신사업법시행령), [중앙전파관리소 부가통신](https://www.crms.go.kr/lay1/S1T54C59/contents.do), [전기통신사업법 - 국가법령정보센터](https://law.go.kr/LSW/lsLinkProc.do?lsNm=전기통신사업법&chrClsCd=010202&mode=20))
- **momo 맥락(추정)**: 메신저는 부가통신역무에 해당할 소지가 크나, **개인/소자본(자본금 1억원 이하)** 단계는 신고 면제 가능(추정). 법인화·증자 시 재검토.

### 8-3. 위치기반서비스사업자 신고
- **사실**: 위치정보를 수집·이용하는 앱은 위치정보사업자/위치기반서비스사업자 신고 필요.
  ([앱 창업 법적 체크리스트](https://ratregistry.org/앱-서비스-창업-시-필요한-법적-사항-체크리스트/))
- **momo 맥락(추정)**: momo는 **위치정보 미수집**(스키마에 위치 없음) → **해당 없음(추정)**. 향후 위치 기능 추가 시에만 신고 검토.

### 8-4. 기타
- 청소년 보호(연령 등급), 전자상거래법(유료 결제 도입 시), 표시광고법(마케팅 문구) — **유료/광고 도입 시점에** 검토.
- **DoD**: 위 4항 각각 "해당/비해당/보류" + 근거 1줄 기록. "해당"은 사람 후속 액션(신고) 위임 표시.

---

## §9. permissive 의존성 NOTICE / 오픈소스 고지 `L7-oss-notice` `[file]`

- **사실 — Apache 2.0**: 배포 시 라이선스 사본 포함 + 원저작권/특허/상표/귀속 고지 보존. 원본에 `NOTICE` 파일이 있으면 파생물 배포 시 그 귀속 고지를 (NOTICE 파일 / 문서 / 앱 화면) 중 1곳 이상에 포함해야. NOTICE 내용은 정보 제공용(라이선스 미변경). Apache 2.0은 permissive → 독점 소프트웨어에 포함 가능하나 귀속 의무는 유지.
  ([Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0), [Applying the license](https://www.apache.org/legal/apply-license.html))
- **사실 — MIT**: 저작권 고지 + 라이선스 전문을 사본/실질부분에 포함.
- **momo 의존성(확인 필요)**: Hummingbird/SwiftNIO/PostgresNIO/JWTKit/AsyncHTTPClient(대개 Apache 2.0), Centrifugo(MIT), 기타 SwiftPM. 각 라이선스 SPDX 확인.
- **산출물(Codex)**:
  1. `NOTICE`(리포 루트) — Apache 2.0 의존성 귀속 고지 집계.
  2. `legal/THIRD_PARTY_NOTICES.md` — 의존성별 (이름·버전·라이선스·URL·고지) 표. SwiftPM `Package.resolved` 기반 생성.
  3. **앱 내 "오픈소스 라이선스" 화면**(설정 → 라이선스)에 `THIRD_PARTY_NOTICES` 노출(C1/C2 UI 티켓 연계) — Apache NOTICE "앱 화면 표시" 옵션 충족.
- **DoD**: `NOTICE` + `legal/THIRD_PARTY_NOTICES.md` 존재 + 모든 직접 의존성 1행 이상 + 앱 라이선스 화면 연결(또는 후속 UI 티켓 명시). 생성 스크립트는 `scripts/`에.

---

## §10. 에이전트 대행 동의/고지 `L8-agent-consent` `[doc]`

> momo의 핵심 차별점: 에이전트(김인턴 등)가 **1급 멤버**로 사람 대신 행동. 사용자에게 (1) 에이전트가 대화/작업을 처리한다는 사실, (2) 메시지가 **제3자 LLM(OpenAI 호환 hermes 등)** 으로 전송될 수 있음, (3) 자율 수준/되돌림(autonomy_level·reversibility_tier·decision_ledger) 고지가 필요.

- **고지 위치(권장)**:
  1. 가입/온보딩 동의 화면 — "에이전트가 워크스페이스 멤버로 동작, 입력은 LLM 제공자로 전송될 수 있음" 명시 동의.
  2. 개인정보처리방침(§5)의 제3자 전송 항목에 LLM 제공자·전송 데이터·목적 기재.
  3. 에이전트 행동 전 승인 인박스(C 경험) — 비가역(reversibility_tier) 작업은 사전 승인.
- **사실 근거**: PIPA 제3자 제공/처리위탁 고지·동의 의무(§5 출처). Apple 5.1.1 — 제3자 공유 시 동등보호 보장 명시.
- **DoD**: `legal/agent-disclosure.md`에 (온보딩 동의문 · 방침 제3자 항목 · 승인 UX 고지문) 3개 문구 초안. UI 연결은 C 경험 티켓에 의존 표시.

---

## §11. 암호화 수출규제 `L9-export-encryption` `[decision]`

- **사실**: iOS Info.plist `ITSAppUsesNonExemptEncryption` 키로 비면제 암호화 사용 여부 신고. 표준 HTTPS/TLS만 쓰면 대개 면제(`false`)로 처리 가능하나 케이스별 확인 필요. (CI 티켓 C2에 이미 "법무 확인" 표시됨.)
  ([App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/), 수출규제는 미국 BIS/한국 전략물자 별도)
- **momo 맥락(추정)**: JWT/TLS 표준 암호화만 사용 시 `ITSAppUsesNonExemptEncryption=false` 가능(추정). 독자 암호화 도입 시 재검토.
- **DoD**: Info.plist 키 값 결정 + 근거 기록. C2 Xcode 티켓과 동기화.

---

## 부록 A. 산출 파일 매핑 (Codex가 만들 것)
```
docs/legal/
  00-prelaunch-admin-legal-checklist.md   (이 파일 — 마스터 체크리스트)
  01-entity-apple-runbook.md              [manual 절차: 법인결정→D-U-N-S→Apple 등록]
  02-cost-ledger.md                       [총비용 원장 — 실벤더/실금액]
  03-app-privacy-datamap.md               [App Privacy 데이터유형×목적 표]
legal/
  privacy-policy.md                       [개인정보처리방침 원문 → 호스팅]
  eula.md                                 [커스텀 선택 시만]
  agent-disclosure.md                     [에이전트 대행 동의/고지 문구]
  THIRD_PARTY_NOTICES.md                  [의존성별 라이선스 고지]
NOTICE                                    [리포 루트 — Apache 2.0 귀속 집계]
```

## 부록 B. PASS 판정
- 스토어 제출 선행 게이트(`docs/cicd/03`)의 **G-3** 행 = 이 문서 §5·§6·§7·§9·§11 완료.
- 한국 정식 상용(§8)은 법인화·매출 발생 시점에 사람 후속.
- 이 문서 §1~§11 전부 "완료/비해당/위임" 처리 시 본 행정·법무 게이트 **PASS**(상단에 날짜+커밋 기록).

> 재확인 트리거(2026 변동성 항목): Apple 가이드라인 개정, iOS 26 SDK 게이트(2026-04-28), PIPA/전기통신사업법 시행령 개정, D&B/도메인/호스팅 가격. 출시 직전 1차 출처 재방문.
