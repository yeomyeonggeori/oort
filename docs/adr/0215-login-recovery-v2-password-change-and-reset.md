# ADR-0215: 로그인·복구 v2 — 비밀번호 변경·찾기·재설정 (관리자 재발급 + 로그인된 기기 서명 재설정, 메일은 나중)

- Status: **Accepted** (2026-10-26, planner 위임 결정 — owner 10-22 「결정 부탁드릴 것은 너가 권장으로 진행해봐」 · owner 10-26 「관리자 재발급 + 로그인된 기기에서 재설정」 결정)
- Date: 2026-10-26
- Deciders: 성재
- 기안: Sonnet 5.5 엔진 워커 (#4574)
- 독립 설계 검토: 1회차 FAIL(Blocker 0·High 6·Medium 16·Low 11), 2회차 FAIL(Blocker 0·High 2·Medium 7·Low 13), **3회차 PASS(Blocker 0·High 0·Medium 2·Low 14)**. 3회차 뒤에 검토자의 Medium·Low 권고를 문장으로 반영했다(그 반영분은 다시 검토받지 않았다. 이 PR의 첫 커밋이 3회차 검토 대상 그대로의 판이다). 지적 요약은 PR 본문에 있다.
- 증보 짝: ADR-0180 「증보 (2026-10-26, #4574) — QR 없는 연결」(같은 PR). 기기 연결은 그쪽에서, 비밀번호 변경·찾기·재설정은 이 ADR에서 정한다.
- 근거 결정
  - owner 2026-10-26(데스크탑 「폰 연결」 QR 카드 캡처와 함께): 「모바일앱에서 비밀번호 찾기 부분이 제한된다는 리포트가 있어. 이 부분 확인해주고, … 비밀번호 재설정 기능(로그인한 상태에서도)도 포함해줘. 비밀번호 찾기 -> 비밀번호 재설정인거 알지 ? 그리고 비밀번호 찾기에서 뭘로 찾게 하지? 우리 메일 등록이나 발송 관련된 부분은 없지 않나 ? 보통 어떻게 해 ? 관리자한테 재발급 요청을 하나 ?」
  - owner 2026-10-26(planner 질문에 답): 「**비밀번호 찾기 = 관리자 재발급 + 로그인된 기기에서 재설정. 메일은 나중에.**」
  - 위임 2026-10-22: 「결정 부탁드릴 것은 너가 권장으로 진행해봐.」 아래 [권장]이 이 위임으로 정한 것이다. PR 본문 「권장으로 정한 것」 표에 모두 적는다.
- 관계: ADR-0100(공개 API·보안 경계·DB 계약은 Accepted ADR이 머지 조건) · ADR-0180(기기 연결 — 이 ADR의 짝) · ADR-0146 개정 2026-09-28(기기 키·`momo.human.*` 서명 — D4·D7이 사용하고 머리 증보 줄·D-8 표·끝 절(D-7 역방향 줄 포함)에 역방향 줄을 둔다) · ADR-0166(claim 토큰 — 재설정 링크가 같은 테이블·라우트를 쓴다) · ADR-0195(패스키 — 복구 순서 D-8을 이 ADR이 한 칸 늘린다) · ADR-0128 D2(관리자 사다리) · ADR-0185(제로베이스 온보딩) · ADR-0186 부록 C(링크의 공개 origin) · ADR-0208 D14(예약 메시지 보류) · ADR-0214(보안 주장은 시험이 없으면 공개하지 않는다)
- 번호 확인 [V, 2026-10-26]: `origin/main`·`track/engine`·`track/uxui`와 모든 원격 브랜치의 `docs/adr/`는 0214가 마지막이다. 열린 이슈 본문은 0207(#4512), 0209(#4240의 「멀티 계정」), 0211(#4238), 0212(#4239), 0213(#4240)을 예약했고 0215 이상은 어디에도 없다. 이 ADR은 **0215**만 쓴다.
- 표기: [V] 코드·문서·1차 출처를 이번에 직접 열어 확인 · [S] 검색 결과·요약으로만 확인(1차 본문을 열지 못함) · [추정] 해석 · **[권장]** planner 위임으로 정한 결정 · `runtime-unverified` 실행해 보지 않음. 이 PR은 문서만 바꾼다. 코드 사실은 track/engine `b5affda6b`를 읽어 얻었고(내용), 병합 시점 선두 `cda32e691`로 바뀐 파일(`lib.rs`·`config.rs`·`main.rs`·`.env.example`)은 줄 번호만 그 기준으로 갱신했다(밀린 줄의 내용 일치를 줄마다 확인). 어떤 시험도 새로 돌리지 않았다.
- 용어: **R2**는 ADR-0146 개정의 「사람 기기 키 서명」이다. **지시 키**는 그 키(맥 뿌리 키, 맥이 승인한 폰 키)다. **계보**(lineage)는 한 번의 로그인이 낳은 토큰 묶음(`token.session_id`)이다.

## 맥락

폰·웹·데스크탑 어디에도 「비밀번호 찾기」와 「비밀번호 변경」 화면이 없다. 서버에는 #1767이 만든 API 둘이 이미 있지만 부르는 제품 클라이언트가 없다. 「비밀번호 찾기 제한」 리포트는 이 공백이다. 그런데 이 공백은 단순한 화면 누락이 아니다. 로그인 쪽이 아직 약하고(시도 제한 없음·해시 비용 낮음·비밀번호 규칙 없음), 복구 수단 중 하나(로그인된 기기)가 쓰는 기기 키가 맥·아이폰에만 있다. 화면만 만들면 약한 쪽을 그대로 노출한다. 그래서 ADR을 먼저 쓴다.

### 확인한 사실 [V]

| # | 사실 | 근거 |
|---|---|---|
| F1 | 시험 파일을 뺀 `clients/web`·`clients/mobile`·`clients/desktop/src`·`packages/momo-core`에서 `password-reset`·`members/me/password`·`changePassword` 같은 호출은 0건이다. 「비밀번호 찾기」·「변경」 화면이 없다. 같은 라우트를 부르는 **제품 밖** 호출자는 있다(F21) | grep 0건(2026-10-26) |
| F2 | 로그인은 **워크스페이스 단위 이메일+비밀번호**다. 워크스페이스를 비우면 시드 워크스페이스로 간다 | `bins/momo-server/src/routes/auth_routes.rs:9-27`, `:320-361`, `dto.rs:124-131` |
| F3 | #1767 API 둘: owner/admin이 멤버의 1회용 재설정 링크를 발급(`POST …/members/{member}/password-reset`), 본인이 현재 비밀번호로 변경(`PATCH …/members/me/password`) | `lib.rs:918`, `:924`, `routes/password.rs:1-9` |
| F4 | **메일 발송기는 없다**. 링크는 초대처럼 다른 경로로 전한다 | `password.rs:8-9` |
| F5 | 발급 사다리: owner는 자기 외 누구나(다른 owner 포함), admin은 member·guest만, 자기 자신은 403, 사람·활성 멤버만. 재발급은 이전 미소비 토큰을 소비한다. TTL은 24시간(ADR-0166 봉인 상수 — 「두 번째 시계를 만들지 말 것」) | `crates/momo-auth/src/owner_claim.rs:17-19`, `:241-328`, `workspace_authorization.rs:107-115` |
| F6 | 소비는 공개 `POST /v1/claim`이다. owner 부트스트랩과 같은 라우트·같은 `credential_claim` 테이블이고 `kind`만 다르다. 재설정 소비는 비밀번호를 정하고 그 멤버의 모든 세션·푸시·기기 키를 끝내고 새 세션을 돌려준다 | `routes/claim.rs:67-175`, `owner_claim.rs:205-207`, `lib.rs:2010-2016` |
| F7 | 본인 변경은 현재 비밀번호를 확인하고 모든 세션 토큰을 폐기한 뒤 호출자에게 새 세션 쌍을 준다. 같은 트랜잭션에서 푸시 등록·**기기 키**·예약 메시지(보류)를 함께 끝낸다. 현재 비밀번호와 새 비밀번호를 **같은 검증기**(`spec_password` → `normalized_claim_password`)로 거른다 | `password.rs:37-39`, `:161-261`(검증 `:174-175`), `owner_claim.rs:332-379`, `bins/momo-server/src/session_end.rs:12-18`, `:101-115` |
| F8 | 새 비밀번호 규칙은 「비어 있지 않음, 1024자 이하」뿐이다(join·claim 같은 규칙). 해시는 `crypt(pw, gen_salt('bf'))`라 pgcrypto 기본 반복 6이고 `bf`의 최대 비밀번호 길이는 72다(pgcrypto 문서 [V]). 72 넘는 부분이 해시에 쓰이지 않는다는 것은 bcrypt의 알려진 성질이고 이 저장소에서 실행해 확인하지는 않았다 [S, `runtime-unverified`]. 클라이언트에도 최소 길이가 없다(웹 `maxLength={1024}`뿐) | `owner_claim.rs:108-116`, `crates/momo-settings/src/join.rs:250-258`, `server/Migrations/005_auth_password_hash.sql:10-16`, `clients/web/src/features/auth/ClaimPage.tsx:252`, `:269` |
| F9 | `/v1/auth/login`에는 per-IP 게이트도 시도 제한도 잠금도 없다. join·claim·device-link redeem에는 per-IP 게이트가 있다 | `lib.rs:1924` 대 `:2001-2028`, `crates/momo-messaging/src/identity.rs:366-410` |
| F10 | per-IP 게이트는 첫 `X-Forwarded-For` 홉을 그대로 믿는다. 직접 노출된 서버나 값을 덧붙이는 프록시 뒤에서는 IP 키 예산을 우회할 수 있다(주석이 이미 v0 한계로 적는다) | `rate_limit.rs:310-332` |
| F11 | 웹 claim 화면의 실패 문구는 owner 부트스트랩 전제다(410 「설치를 실행한 쪽에 새 링크를 요청하세요」, 400 「비어 있거나 너무 깁니다」). 재설정 링크가 와도 같은 문구가 뜬다 | `packages/momo-core/src/features/auth/claimModel.ts:48-52`, `:63-69` |
| F12 | `oort://claim`은 계약이 아니다. 웹 입력 파서가 `invalid`로 돌려보내고, #2812(OPEN, **데스크탑 앱** 이슈)는 서버 없는 `oort://claim/<token>`을 말한다 | `clients/web/src/features/auth/entryInput.ts:21-22`, `:93`, `entryInput.test.ts:27`, #2812 |
| F13 | 기기 키는 맥(뿌리 후보, **로그인 비밀번호로 등록**, QR 연결 세션에서는 못 만든다)과 폰(QR 연결 + 맥의 승인) 둘뿐이고 웹은 비지시 표면이다. 키는 세션 계보에 묶이고 변경·재설정이 전부 폐기한다. 승인 안 된 폰 키는 「지시 불가」이고, 승인된 폰 키도 **승인한 맥의 계보가 살아 있어야** 지시 가능하다 | `routes/device_keys.rs:1-41`, `:272-315`, `momo-auth/src/device_key.rs:93-143`, `momo-auth/src/human_control.rs:278`, ADR-0146 D-4·D-6·D-7 |
| F14 | 서명 검증 몸통이 있다: 키 → 사슬 → 서명문 재구성 → 시간창(±5분, 수명 ≤ 10분 상수) → nonce 1회 소비(맨 끝). 형제 스키마 선례(`device_endorse.v1`·`device_rebind.v1`·`refresh_proof.v1`)와 nonce 테이블이 있다. nonce 테이블의 `kind` CHECK는 5종(`spawn`·`input`·`permission`·`bundle_manifest`·`host_register`)이고 ADR-0210 HO-10이 같은 CHECK에 `ops_session`·`ops_box`를 더할 예정이다(`0210-…md:285`). 거절된 요청도 트랜잭션이 커밋된다 | `momo-auth/src/human_control.rs:1-60`, `crates/momo-wire/src/human_control.rs:147-175`, `:984-986`, `server/Migrations/095_human_control_nonce.sql:56-61` |
| F15 | `MOMO_HUMAN_CONTROL_SIGNATURE_REQUIRED`는 기본 꺼짐이고 **host 지시**를 겨냥한다. `signing-context`는 `MOMO_INSTANCE_ID`가 없으면 503 `instance_id_unconfigured`로 「서명한 것은 아무것도 검증되지 않는다」고 답하고, 응답에 호출 세션의 계보 `sessionId`를 싣는다. refresh sender-constraint 모드 기본은 `observe`다: **비밀번호 로그인(웹·데스크탑) 계보는 훔친 refresh 토큰으로 계속 갱신된다.** QR 연결(폰) 계보는 재사용이 감지되면 기본값에서도 끝난다 | `config.rs:1490-1514`, `:3001`, `routes/device_keys.rs:166-215`, `dto.rs:1050-1053`, `momo-auth/src/refresh_proof.rs:42-52` |
| F16 | 패스키(ADR-0195)는 비밀번호에 **추가**한다. 등록은 「최근 5분 안 재인증」이 조건이고, 복구 순서를 「비밀번호 로그인 → 운영자 재설정 링크 → 로그인된 다른 기기의 QR」로 적는다 | ADR-0195 D-2·D-8 |
| F17 | 멤버 관리 표면은 웹·데스크탑 `MemberProfileDialog`이고 역할 변경(`RoleChangeField`)이 이미 있다. 보이는 조건은 코어 `canChangeWorkspaceRole`이다. 폰에는 멤버 관리 화면이 없다 | `clients/web/src/features/directory/MemberProfileDialog.tsx:83-140`, `:230-250`, `momo-core/src/features/directory/model.ts:90-98`, `clients/mobile/src/screens/`(14개 화면) |
| F18 | 마지막 owner 잠김: owner 재설정은 **다른** owner가 할 수 있다. 일반 운영자 경로는 없고, `migrate set-owner`가 시드 워크스페이스 owner 한정으로 있다 | `owner_claim.rs:248-250`, `bins/momo-migrate/src/main.rs:760-777`, `infra/rust/sql/set_initial_owner.sql` |
| F19 | 사람이 다른 곳으로 전하는 1회용 링크는 **설정된 공개 주소**(`MOMO_PUBLIC_BASE_URL`, https만)를 요청의 `Host`보다 먼저 쓴다. 이유가 이미 적혀 있다: 링크가 사람에게 닿는 동안 서버는 그 링크를 보지 못하므로 `Host` 헤더가 가리킬 곳을 정하게 두지 않는다. 기기 연결의 `deepLink`는 요청 헤더로만 도출한다(발급자와 수신자가 같은 자리) | `routes/agent_port_tools.rs:2744-2749`, `main.rs:192-205`, `config.rs:2300-2308`, `routes/device_link.rs:93-102`, `realtime_advert.rs:265-282` |
| F20 | `MOMO_INSTANCE_ID`는 설치 스크립트·`infra/`·셀프호스트 문서 어디에서도 값이 정해지지 않는다. `infra/.env.example`에 주석 처리된 한 줄만 있다. 그래서 설치 기본값에서는 `signing-context`가 503이고 서명 경로가 모두 닫혀 있다 | `infra/.env.example:287-298`, grep 0건(`scripts/`·`infra/`·`docs/SELF_HOST*.md`) |
| F21 | 재설정 발급 라우트를 **본문 없이** 부르는 저장소 안 호출자: OpenAPI 계약 게이트(본문 없이 201 기대), `password_reset_conformance_pg.rs`(발급 호출 여러 곳), `verify_owner_claim.sh`, OpenAPI 문서(요청 본문 없음), `docs/security/claims.yaml`의 AUTH-4 증명 | `scripts/verify_openapi_contract_rust.sh:1985-2001`, `server-rust/bins/momo-server/tests/password_reset_conformance_pg.rs`, `scripts/verify_owner_claim.sh:247`, `docs/api/openapi.yaml:1782-1830`, `docs/security/claims.yaml:98` |
| F22 | `credential_claim` 행을 바꾸는 코드는 소비와 「재발급 때 이전 토큰 소비」 둘뿐이다. 본인 변경과 `end_member_sessions_in_tx`는 대기 중인 `password_reset` 행을 건드리지 않는다. 소비는 대상의 비밀번호 상태를 보지 않고(owner 부트스트랩만 보호) 비밀번호를 덮어쓴다 | `owner_claim.rs:128-233`(`:165-167`), `:292-303`, `:332-379`, `session_end.rs:101-115` |
| F23 | 멤버 전체 세션 sweep은 토큰 행을 먼저 잡은 호출자가 **먼저** `lock_member_wide_sweep_in_tx`를 불러야 한다(#3109 규칙). `verify_human_control_in_tx`는 요청 계보·키 행을 끝까지 `FOR SHARE`로 잡는다 | `momo-auth/src/token_store.rs:596-620`, `human_control.rs:12-21` |
| F24 | 기기 연결 **발급**(`POST /v1/auth/device-link`)에는 속도 제한이 없고, redeem이 새 계보(`session_id`)를 만든다. 세션 하나를 훔친 쪽이 계보를 얼마든지 늘릴 수 있다 | `lib.rs:1181-1185`, `momo-auth/src/device_link.rs:288-290` |

### 업계 조사

조사는 2026-10-26에 웹으로 했다. 「영향」 칸이 이 ADR의 결정 번호다.

| 대상 | 확인한 사실 | 영향 | 출처 | 표기 |
|---|---|---|---|---|
| Apple | 비밀번호는 로그인된 신뢰 기기에서 바꾸는 것이 「가장 쉽고 안전하다」. 맥은 맥의 잠금 해제 암호를 묻는다. 끝나면 「다른 기기 모두 로그아웃」과 「로그인 유지」를 고르게 한다. 도난 보호 때는 1시간 대기가 있을 수 있다. 「이미 로그인된 기기에서 바꿔 보라」는 안내는 102656에 있다 | D4·D7 | https://support.apple.com/en-us/101567 , https://support.apple.com/en-us/102656 | [V] |
| Apple iPhone | iPhone이 현재 비밀번호 대신 기기 암호를 묻는다는 부분은 검색 요약으로만 봤다(101567의 iPhone 단계는 「화면 안내를 따른다」뿐) | D7 | https://support.apple.com/en-us/101567 | [S] |
| Telegram 2FA | 이메일 복구는 로그인 안 된 세션도 된다. **로그인된 세션만** `account.resetPassword`를 시작할 수 있고 7일 서버 타이머가 돌며 그동안 중단할 수 있다. 다른 세션이 없고 이메일도 없으면 계정 삭제뿐이다 | D7(기각: 대기) | https://core.telegram.org/api/srp | [V] |
| Slack | 비밀번호 대신 이메일 확인 코드·패스키·SSO. 비밀번호를 잊으면 「비밀번호 없는 로그인」으로 코드를 받는다. 메일이 선행하는 길이라 oort에는 같은 길이 없다 | D1 | https://slack.com/help/articles/212681477 | [V] |
| Mattermost | `mmctl user change-password`는 **현재 비밀번호를 본인 변경에만** 요구하고 관리자는 없이 바꾼다 | D6·D10 | https://github.com/mattermost/mattermost/blob/master/server/cmd/mmctl/docs/mmctl_user_change-password.rst | [V] |
| Mattermost 로컬 모드 | SMTP 없이는 관리자가 로컬 모드 mmctl로 재설정한다 | D10 | https://forum.mattermost.com/t/solved-password-reset-without-email/2230 | [S] |
| Gitea | 관리자가 `gitea admin user change-password --username … --password …`로 바꾼다. `--must-change-password`(기본 true)로 다음 로그인에 변경을 강제한다 | D6·D10 | https://docs.gitea.com/administration/command-line | [V] |
| Synapse | 관리자 API `POST /_synapse/admin/v1/reset_password/<user_id>`. 모든 기기를 로그아웃시키는 `logout_devices`의 기본이 true | D4 | https://element-hq.github.io/synapse/latest/admin_api/user_admin_api.html | [V] |
| Google | 복구는 「평소 로그인하던 기기·브라우저·장소」에서 시도하라고 권한다 | D5 안내 문구 | https://support.google.com/accounts/answer/7299973 | [S] |
| NIST SP 800-63B-4 | 단일 요소 비밀번호는 **최소 15자**(SHALL, 다요소의 일부면 최소 8자), 최대 **64자 이상 허용**(SHOULD), 구성 규칙 금지, 주기적 변경 금지, 차단 목록 비교(SHALL), 연속 실패 시도 제한(§3.2.2: 100회 이하) | D2·D10 | https://pages.nist.gov/800-63-4/sp800-63b.html | [V] |
| OWASP Forgot Password | 계정 존재 여부를 응답·시간으로 드러내지 않는다. 토큰은 CSPRNG·1회·만료. 재설정 뒤 사용자에게 알린다. 재설정 뒤 자동 로그인은 권하지 않고, 세션을 모두 끝낼지는 결정 사항이다 | D5·D6 | https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html | [V] |
| PostgreSQL pgcrypto | `gen_salt('bf')`의 기본 반복 횟수는 6(허용 4~31). `bf`의 비밀번호 최대 길이 72 | D2·D10 | https://www.postgresql.org/docs/current/pgcrypto.html | [V] |

기기 연결 쪽 조사(RFC 8628·GitHub·WhatsApp·Steam·Telegram QR·Discord·Slack·Expo 클립보드)는 ADR-0180 증보에 있다.

## 결정

### D1. 범위와 경계

- 이 ADR이 정하는 것: 새 비밀번호 규칙(D2), 로그인 상태 변경(D3·D4), 「비밀번호를 잊으셨나요?」 화면(D5), 관리자 재발급(D6), 로그인된 기기 서명 재설정(D7), 재설정 링크의 앱 입력(D8), 감사(D9).
- **새 공개(비인증) 엔드포인트는 0개다.** 찾기 화면은 서버를 부르지 않는다(D5). 재설정은 이미 로그인된 기기의 서명(D7)이거나, 이미 있는 공개 `POST /v1/claim`(D6)이다.
- **메일 재설정은 범위 밖이다**(owner 「나중에」). 메일 발송기·메일 인증·메일 기반 복구는 이 ADR이 만들지 않는다.
- 보안 경계를 바꾸는 결정과 owner 결정의 관계는 아래 「owner 결정으로 덮이는가」 표에 있다. 덮이지 않는 것은 [권장]이고 PR 본문 표에 올린다.

### D2. 새 비밀번호 규칙 [권장 · 길이는 owner 결정]

- **두 검증기를 나눈다.** 지금은 `spec_password` 하나가 현재 비밀번호와 새 비밀번호를 같은 함수로 거른다(F7). 규칙을 그 함수에 걸면 10자 미만의 **기존** 비밀번호를 가진 계정이 변경도, 관리자 발급도 못 한다(변경이 가장 필요한 사람이 막힌다).
  - `normalized_new_password`: 새로 **정하는** 값에만 건다 — join·claim(owner 부트스트랩과 재설정 공통)·본인 변경의 `newPassword`·D7의 `newPassword`.
  - `normalized_current_password`: 현행 `normalized_claim_password`와 같은 검증(비어 있지 않음·1024자 이하)만 본다 — `PATCH …/me/password`의 `currentPassword`와 D6 발급의 `currentPassword`. 로그인은 비어 있음만 거르고 1024자 상한이 없다(`identity.rs:371-385`). 이 상한은 해시 CPU를 묶으려는 현행 규칙을 유지하는 것이다.
- 길이: **10자 이상**(owner 결정 2026-10-26 「비밀번호는 10자 이상으로 하자」, 입력 그대로의 유니코드 스칼라 값 수), **72바이트 이하**(입력 그대로의 UTF-8). 구성 규칙(대소문자·숫자·기호 강제) 없음, 공백·붙여넣기 허용, 주기적 변경 요구 없음.
  - **정규화하지 않는다.** 로그인이 입력 바이트를 그대로 비교하므로(`identity.rs:371-385`) 정규화하면 로그인과 어긋난다. NFD로 입력된 한글은 바이트가 늘어 상한에 먼저 닿는다. 거절은 안전한 쪽이다.
  - 72바이트 이하인 이유: 72를 넘는 부분이 해시에 쓰이지 않으므로(F8) 그 뒤가 다른 두 비밀번호가 같아진다. 새로 정할 때는 **자르지 않고 거절**하고 이유를 말한다(한글 NFC는 한 글자 3바이트라 24자가 상한이다. 문구에 쓴다).
- **NIST와의 관계.** SP 800-63B-4 §3.1.1.2의 단일 요소 기준은 15자 최소다(oort 비밀번호는 1요소다: ADR-0195 D-10). planner 초안은 15자였지만 **owner가 사용성을 이유로 10자로 정했다(2026-10-26)**. 남는 위험은 시도 제한·해시 비용(E-5)과 패스키(ADR-0195)로 덮는다. 이 ADR은 NIST 준수를 주장하지 않는다. **어긋나는 곳** 넷: ⓪ 최소 길이(15 → 10, owner 결정). ① 최대 길이 「64자 이상 허용」(SHOULD)을 한글 비밀번호가 지키지 못한다(24자). 이유는 bcrypt 72바이트이고, 풀려면 해시 방식을 바꿔야 한다(사전 해시 후 bcrypt 또는 argon2) — E-5(해시 묶음)가 다룬다. ② 「NFC 정규화를 적용한다」(SHOULD)를 따르지 않는다: 로그인이 입력 바이트를 그대로 비교하므로 정규화하면 기존 비밀번호가 깨진다. NFD로 입력된 한글은 자모가 각각 스칼라 값이라 10자 **최소**는 더 쉽게 넘고(다섯 음절 ≈ 15) 72바이트 **최대**에는 더 일찍 닿는다. ③ 차단 목록 비교(SHALL)도 하지 않는다(D10).
- 적용: 새로 정하는 서버 경로 **넷**(join·claim·본인 변경·D7)이 한 함수를 쓴다. 오류는 400과 이름 붙은 코드 `password_too_short`·`password_too_long`이다.
  - 새 비밀번호의 NUL(U+0000)은 400 `password_invalid_char`로 거절한다. 구성 규칙이 아니라 스택이 실을 수 없는 문자다(PG `text`가 NUL을 담지 못해 검사가 없으면 join·claim·본인 변경이 500이 된다 [V, 2026-10-26, #4593]). 길이 판정 뒤에 보며, 현재 비밀번호 칸·로그인은 대상이 아니다.
  - claim에는 **첫 owner의 부트스트랩도 들어간다.** ADR-0185 제로베이스 온보딩의 첫 비밀번호가 이 규칙을 받는다(셀프호스트 E2E fixture 갱신이 E-1 몫이다).
  - **로그인은 이 규칙을 보지 않는다.** 이미 있는 계정은 그대로 로그인한다. `MOMO_INITIAL_OWNER_PASSWORD`(env·SQL 경로)는 서버 경로가 아니라 대상 밖이다.
  - 현행 claim 400 문구(「비어 있거나 너무 깁니다」)는 새 코드별 문구로 바꾼다(F11).
- 이유: 로그인에 시도 제한이 없고(F9) 해시 반복이 낮아(F8) 지금 길이가 유일한 방어선이다. 시도 제한과 해시 비용은 이 ADR이 열지 않는다(D10).
- 비용: 폰에서 긴 비밀번호를 치는 것은 부담이다(10자로 줄인 이유). 클라이언트는 새 비밀번호 칸에 시스템의 강력한 비밀번호 제안(`textContentType="newPassword"`·`autoComplete="new-password"`)을 켜고 「보이기」 토글을 둔다.

### D3. 로그인 상태 비밀번호 변경

- API는 그대로다(#1767): `PATCH /v1/workspaces/{ws}/members/me/password {currentPassword, newPassword}` → 200 `LoginResponse`(새 세션 쌍), 403 현재 비밀번호 불일치, 409 비밀번호 없음, 400(같은 비밀번호·D2 규칙), 429(멤버 10회·IP 30회 / 60초, `password.rs:41-73`, `config.rs:368-373`). `currentPassword`는 `normalized_current_password`로 거른다(D2).
- 클라이언트가 해야 할 일(웹·데스크탑·폰 공통):
  - 응답의 새 쌍을 **즉시 저장**한다. 기존 refresh는 이미 폐기됐다.
  - 확인 전에 결과를 말한다: 「다른 기기는 모두 로그아웃돼요. 맥의 지시 키와 폰 승인은 다시 만들어야 해요.」(D4)
  - 칸: 현재 비밀번호, 새 비밀번호, 한 번 더. 보이기 토글. 붙여넣기 허용. 429·403·400 코드별 문구.
  - 변경 성공 화면에 한 줄을 둔다: 「관리자에게 받은 재설정 링크가 있다면 그 링크도 24시간 안에는 쓸 수 있어요. 필요 없다면 관리자에게 새 링크로 바꿔 달라고 하세요」(본인 변경은 대기 중인 링크를 끝내지 않는다, D4).
  - 비밀번호가 **없는** 계정(409)에는 「변경」 대신 안내를 둔다(패스키 전용 계정은 ADR-0195 D-2가 외부 출시 때 따로 결재).
- 표면: 웹·데스크탑 설정 › **보안**(개인 그룹의 새 섹션). PK-P4(#3048)가 같은 섹션에 패스키 목록을 둔다. **먼저 머지되는 쪽이 섹션을 만들고** 뒤 쪽은 행만 더한다. 두 이슈는 서로 코멘트로 조율한다. 폰은 설정 페이지(#4457)의 계정 묶음.
- 감사는 기존 그대로 `member.password_changed`(`password.rs:203-216`)다.

### D4. 변경·재설정이 끝내는 것 — 전체 종료를 유지하고, 대기 중인 재설정 링크는 본인 변경을 뺀 경로에서 끝낸다 [권장]

- [V] 본인 변경(`password.rs:196-202`)과 관리자 링크 소비(`claim.rs:111-119`)는 `end_member_sessions_in_tx`를 부른다(`session_end.rs:101-115`). 푸시 등록 무효화, **기기 키 폐기**(`member_sessions_ended`), 예약 메시지 보류(ADR-0208 D14)가 한 커밋에 일어난다. 새 서명 재설정(D7)도 같게 한다. 이 함수의 호출처는 다섯이다: 정지·제거(`member_lifecycle.rs:250`·`:324`), 본인 변경(`password.rs:196`), 탈퇴(`workspaces.rs:351`), claim 소비(`claim.rs:112`). 호출 원인은 `RevocationCause`(`PasswordChanged`·`PasswordReset`·`Suspended`·`Removed`·`Left`)로 구별된다.
- 그래서 변경·재설정 뒤에는 R2 사슬을 다시 만들어야 한다: 맥 뿌리 키(재등록은 비밀번호 재입력 — 새 비밀번호다), 승인된 폰 키(폰을 QR로 다시 연결하고 맥이 다시 승인). 호출한 기기도 같다(새 계보를 받고 키는 폐기된다).
- **대기 중인 재설정 링크.** 지금은 어느 경로도 대기 중인 `password_reset` 링크를 끝내지 않아서(F22) 이런 일이 생긴다: 관리자가 보낸 링크 L이 새어 나갔는데 멤버가 D7로 먼저 안전하게 복구해도, 공격자가 24시간 안에 L로 `POST /v1/claim`을 해서 새 비밀번호를 정하고 계정을 가져간다. 그래서 `end_member_sessions_in_tx` **안에서** 그 멤버의 미소비 `password_reset` claim을 같은 트랜잭션에서 소비한다(`owner_bootstrap`은 `kind` 필터로 건드리지 않는다). 한 곳에 두는 이유는 그 파일 머리 주석의 규칙이다(세션만큼 사는 새로운 것은 호출처마다가 아니라 여기에 더한다. 주석이 세는 「호출처 일곱 곳」은 옛 숫자이고 지금 호출처는 위의 다섯이다). **단, 원인이 `PasswordChanged`(본인 변경)이면 하지 않는다.**
  - 이유: 본인 변경은 「현재 비밀번호를 아는 자」의 행위라 소유자와 공격자를 구별하지 못한다. 변경이 대기 링크를 끝내면, 비밀번호를 아는 공격자가 변경을 반복해(멤버당 분당 10회 한도 안, `config.rs:369-371`) 관리자가 발급하는 링크를 계속 끊을 수 있다. 변경은 그 멤버의 세션과 기기 키도 모두 끝내므로(D7도 사라진다) 소유자에게 남은 복구 길이 링크 하나뿐인데 그 길을 공격자가 끊게 된다. 정지로 공격자를 끊어도 정지된 멤버에게는 발급이 되지 않는다(`owner_claim.rs:281-283`). 서명 재설정(D7, 하드웨어 키)·정지·제거·탈퇴·claim 소비·관리자 재발급은 비밀번호만 아는 쪽이 흉내 낼 수 없거나 관리자 권한이다.
  - 소비하는 원인: `PasswordReset`(D7·claim 소비)·`Suspended`·`Removed`·`Left`. 정지·제거·탈퇴에도 걸리는 것은 의도한 결과다(정지된 멤버의 링크가 살아 있으면 안 된다). 대신 순서가 있다: **세션을 끝낸 뒤에 링크를 발급한다**(발급 뒤에 세션을 끝내면 링크도 죽는다). 관리자 화면 문구에 쓴다.
  - **남는 위험**: 본인 변경 뒤에도 대기 링크가 최대 24시간 산다. 새어 나간 링크에 대한 대응은 **재발급(=취소)**이고, 변경 성공 화면이 이를 알린다(D3).
  - **잠금 순서.** claim 소비는 claim 행 → `human` 행 → 멤버 전체 sweep 잠금 순으로 잡고(`owner_claim.rs:134-145`, `:173-199`, `:205-207`), 본인 변경은 `human` 행 → sweep 순이다(`:339-345`, `:377`). **D7도 같은 순서(`human` 행 → sweep)를 따른다**(D7 순서 1): sweep을 먼저 잡으면 같은 멤버의 claim·PATCH와 `human` 행에서 순환한다(3회차 검토 지적). 정지·제거·탈퇴는 `member`·멤버십 행을 쓰고 `human` 행은 잡지 않는다(`membership_lifecycle.rs:416-`, `workspace.rs:432-`). 새 소비 UPDATE가 claim 행을 기다리면 이 순환에 claim 행이 끼어 교착(40P01)이 날 수 있으므로 `FOR UPDATE SKIP LOCKED`로 쓴다: 잠겨 있는 claim은 지금 소비되는 중이라 건너뛰어도 안전하다. 그 소비가 롤백하는 드문 경우에는 그 링크가 남고, 커밋하는 경우에는 링크 소지자의 새 비밀번호가 D7·재설정 뒤에 덮어쓴다. 이 틈은 링크가 유출됐고 두 트랜잭션이 정확히 겹칠 때뿐이며, 링크 소지자가 먼저 움직였다는 점에서 D7 이전에 claim한 것과 같다.
- [권장] **전체 종료는 현행 유지**: 전체 종료 + 호출자에게 새 계보. 근거: Synapse 기본(`logout_devices` true), OWASP(세션 정리는 결정 사항 — 침해 의심 때 바꾸는 일이 많다), 변경 한 번에 「남은 계보」라는 새 경계를 만들지 않는다.
- 기각: Apple식 「이 기기는 로그인 유지」. 호출 계보와 그 기기 키를 살리려면 `end_member_sessions_in_tx`를 「나머지 계보만 종료」로 쪼개고 키를 새 계보로 재결속하는 규칙(ADR-0146 D-7 증보 #3097의 rebind 모양)이 필요하다. 변경·재설정은 드문 사건이라 재등록 비용이 실제로 문제인지 본 뒤에 연다. 열 조건: 재등록 불편이 보고될 때.
- 기각: 본인 변경도 대기 링크를 끝낸다(1회차 검토 지적의 첫 해법). 위 이유로 공격자가 복구 경로를 끊는다.
- 역방향 줄: ADR-0146의 머리 증보 줄·D-8 표·끝 절(D-7 역방향 줄 포함)에 이 ADR의 D4·D7을 단다(같은 PR).

### D5. 「비밀번호를 잊으셨나요?」 = 안내 화면, 서버를 부르지 않는다 [권장]

- 자리: 웹·데스크탑 `ConnectPage` 로그인 폼의 비밀번호 칸 아래(`ConnectPage.tsx:603-618`), 폰 로그인 폼(M-b, `ConnectScreen.tsx:1057-1075`)의 같은 자리.
- 내용(구조 고정, 문장은 UXUI 슬라이스가 쓴다):
  1. 「로그인된 기기가 있다면」 — 맥 앱이나 아이폰에서 설정 › 보안 › 「비밀번호 다시 정하기」(D7). **이 길이 되는 조건을 숨기지 않는다**: 그 기기에 지시 키가 만들어져 있어야 하고, 폰은 승인한 맥의 로그인이 살아 있어야 하고, 서버에서 이 기능이 켜져 있어야 한다(D7). 웹 브라우저에서는 안 된다.
  2. 「관리자에게 요청」 — 복사할 요청 문구(입력해 둔 이메일과 서버 호스트만 담는다)와 「링크를 받았어요」 입력(D6·D8의 `https` 링크를 붙여넣는다. 붙여넣은 링크는 호스트 확인을 거친다, D8).
  3. 「서버를 직접 운영한다면」 — 운영자 복구 문서 링크(D10). **E-6이 머지될 때까지 이 항목은 숨긴다.** 혼자 쓰는 셀프호스트 owner는 D6(다른 owner·admin 없음)도 D7(키 없음, F20)도 없어서 E-6 없이는 이 화면이 줄 수 있는 것이 없다. 화면은 그 사실을 감추지 않고 1·2의 조건을 보인다.
- **owner·admin 목록은 로그인 전에 보여 주지 않는다.** 이슈 Goal 3(b)의 「owner·admin 목록」은 이렇게 바꾼다(이탈 기록, **owner 확인 권장**: 사용자에게 보이는 결과가 「누구에게 요청하죠?」로 바뀐다). 이유: 목록을 보이려면 공개 엔드포인트가 필요하고 그것은 멤버 이름·핸들 열거다(OWASP는 존재 여부를 드러내지 않는 응답을 요구한다 [V]). 셀프호스트 서버는 Railway·터널 같은 **공개 주소**에 서므로 위험이 실재한다. 대안(그 기기의 이전 세션이 알던 명단 캐시, 운영자가 선언하는 문의처 문구)은 열지 않는다(D10).
- 서버 호출이 없으므로 계정 열거, 메일 폭탄, 응답 시간 오라클이 구조적으로 없다.

### D6. 관리자 재발급

- **권한·수명은 그대로다**(F5): owner는 자기 외 누구나, admin은 member·guest, 자기 자신 403, 사람·활성만, 재발급은 이전 미소비 토큰을 소비, TTL 24시간(ADR-0166 봉인 상수), 원문은 201에 한 번. 발급한 링크를 **취소하는 길은 재발급**이다. 별도 취소 라우트는 만들지 않는다.
- **발급은 관리자 본인의 현재 비밀번호를 다시 받는다 [권장].**
  - 위협: D7과 같은 종류인데 더 크다. 관리자 세션 하나를 훔친 사람이 재설정 링크로 **어느 멤버의 계정이든** 가져가 그 사람으로 로그인한다. 현행 API는 세션만 본다(F3·F5). 선례: ADR-0195 D-8(「세션 bearer만으로는 탈취 세션이 영구 뒷문을 만든다 → 최근 재인증」), ADR-0146 D-7(뿌리 키 등록 때 비밀번호 재입력).
  - 계약: 본문 `{ currentPassword }`(발급하는 **관리자 본인**의 것, `normalized_current_password`)를 **필수**로 한다. 없거나 비면 400 `current_password_required`, 틀리면 403 `current_password_incorrect`이고, 이전 live 토큰은 그대로이며 발급 감사 행은 쓰지 않는다(실패는 D9의 `refused` 행이 남긴다).
  - 순서: 속도 제한 → `require_admin` → **관리자 비밀번호 확인** → 대상 조회·사다리. 틀린 비밀번호로는 대상의 존재·상태를 알아내지 못한다(존재하지 않는 멤버와 있는 멤버가 같은 403).
  - 속도: 본인 변경과 **다른 버킷**이다. 키는 **관리자 멤버 하나**, 기본 5회 / 60초(`RATE_LIMIT_PASSWORD_RESET_ISSUE_PER_ADMIN`), 비밀번호가 맞아도 요청마다 센다. 0·파싱 불가는 끄는 값이 아니라 기본값으로 되돌린다(추측 가능한 표면의 노브는 끄기를 두지 않는다). **계보를 키에 넣지 않는다**: 계보는 훔친 세션 하나로 무한히 만들 수 있어서(F24) 계보 키로는 비밀번호 추측을 막지 못한다. 대가는 세션을 훔친 쪽이 그 관리자의 발급을 막을 수 있다는 것이다(다른 owner·admin이 발급한다). 추측 방어를 계정 축으로 묶는 일(로그인·본인 변경·이 재확인을 한 한도로)은 E-5가 맡는다.
  - 기기 키 서명(D7 모양)은 요구하지 않는다 — 웹 브라우저의 관리자가 발급하지 못하게 된다.
- **파괴적 API 변경이다.** 필수 필드 추가는 지금 본문 없이 부르는 호출자를 모두 깬다. 제품 클라이언트는 없지만(F1) 저장소 안에 있다(F21): OpenAPI 계약 게이트의 샘플, `password_reset_conformance_pg`, `verify_owner_claim.sh`, `docs/api/openapi.yaml`, AUTH-4 증명. E-4가 이를 전부 갱신하고, 자체 호스팅 운영자의 스크립트에는 공개 변경으로 알린다(CHANGELOG). 본문 없음·필드 누락은 axum 기본(415·422)이 아니라 **400**으로 핸들러가 판정한다.
- **표면**: 웹·데스크탑 `MemberProfileDialog`의 관리 블록(역할 변경 옆, F17). 보이는 조건은 코어에 `canChangeWorkspaceRole` 옆으로 `canIssuePasswordReset(viewerRole, viewerMemberId, target)`을 둔다(서버 사다리의 UX 거울이고 권위는 서버다). 폰은 v1 범위 밖이다(멤버 관리 화면이 없다, F17).
- **흐름**: 「재설정 링크 만들기」 → 확인 대화상자(내 비밀번호 입력 칸 포함) → 201 → 발급 카드(`IssuedInviteCard` 모양)에 링크·복사·QR·만료 시각을 한 번 보인다. 닫으면 다시 볼 수 없다. 확인 문구에 넣을 것:
  - 이전 링크는 못 쓰게 된다.
  - 24시간 안에 한 번만 쓸 수 있다.
  - 받는 사람이 정하면 그 사람의 모든 기기가 로그아웃된다.
  - **본인 확인은 관리자가 한다**: 대면·통화로 확인한 사람에게만 보낸다. 계정이 도용됐을 수 있는 같은 채팅으로 보내지 않는다.
  - 세션을 끝낼 일이 있으면 **끝낸 뒤에** 발급한다(D4).
- **링크 모양 [권장].** 발급 응답에 `claimUrl` 하나를 **더한다**(절대 URL, `claimPath`는 그대로 둔다). 앱 전용 스킴 링크는 만들지 않는다(D8).
  - 출처 origin: **설정된 공개 주소**(`ready_public_base_url()`, https만)가 있으면 그것을 쓰고, 없을 때만 요청 헤더로 도출한다. 선례: 승인이 내는 초대 링크(ADR-0186 부록 C, F19). 이 링크는 다른 시간·장소로 전달되므로 관리자가 접속한 주소(LAN·loopback일 수 있다)가 수신자에게 닿는 주소라고 가정하지 않는다.
  - 요청 헤더로 도출했는데 `http://`이거나 loopback·사설 주소이면 응답이 이를 알리고(`claimUrlSecure: false`), 관리자 화면이 「이 주소는 이 컴퓨터(같은 네트워크)에서만 열릴 수 있어요」를 띄운다. 「절대 https」는 보장하지 않는다.
- **claim 화면 문구 [권장].** `POST /v1/claim`의 200·409·410 본문에 `claimKind`(`owner_bootstrap`|`password_reset`)를 **더한다**. 404·400·429에는 넣지 않는다. 토큰을 쥔 사람만 보는 값이고 토큰이 256비트라 오라클이 되지 않는다. 입력 전 폼 머리는 두 kind에 중립이다(「새 비밀번호를 정해요」). 실패 문구는 kind별이다(재설정이면 「관리자에게 새 링크를 요청하세요」, F11).
- **소비 뒤**: 로그인 세션을 그대로 받는다(현행 `claim.rs:154-174`). OWASP가 권하는 「재설정 뒤 다시 로그인」은 따르지 않는다. 링크를 쥔 사람은 비밀번호를 정하는 순간 이미 로그인할 수 있어서 자동 로그인이 더 여는 것이 없다.
- **감사**: 발급 `member.password_reset.issued`, 소비 `member.password_reset`은 기존 그대로다(`password.rs:113-126`, `claim.rs:101-128`). 실패는 D9.

### D7. 로그인된 기기 서명 재설정 (새 보안 경계) [권장]

한 줄: **이미 로그인된 맥 앱·아이폰이 자기 지시 키로 서명해서, 현재 비밀번호 없이 새 비밀번호를 정한다.**

- 이슈 Goal 3(a)의 「기기 서명」은 planner의 해석이고 owner 문장은 「로그인된 기기에서 재설정」이다. 서명을 **요구**하는 것은 보안 경계라 [권장]이고, 아래 위협으로 정한다.
- 위협: 비밀번호 없이 새 비밀번호를 정할 수 있게 하면 **세션 하나를 훔친 사람이 계정을 영구히 가져간다**. 훔치는 대상은 access(15분)만이 아니다. 비밀번호 로그인 계보의 refresh 토큰은 기본 모드 `observe`에서 증명 없이도 계속 갱신된다(F15). 웹 세션은 localStorage에 있다(ADR-0146 F19). 그래서 세션 보유만으로는 모자라고, **기기에 묶인 키의 서명 + 사람의 현장 확인**이 필요하다.
- **자리는 로그인된 기기의 설정 › 보안이다.** 로그인 화면은 안내만 한다(D5). 그래서 새 공개 엔드포인트는 없다.

**켜기 [권장].** 이 라우트는 `MOMO_PASSWORD_RESET_SIGNED`(기본 **꺼짐**)가 켜져 있을 때만 열린다. 꺼져 있으면 404이고 `signing-context`는 `passwordResetSchema`를 내리지 않는다(클라이언트가 「다시 정하기」 행을 숨긴다). **스위치가 켜졌는데 `MOMO_INSTANCE_ID`가 없으면 기동을 거부한다**(기존 서명 플래그와 같은 규율, `config.rs:1563-1571`·`infra/.env.example:291`).
- 켜는 조건: ① E-3의 독립 보안 검수 PASS ② ADR-0146 D-11의 조건(R1 보안 재검수 PASS·R2 검수 #3030 PASS)이 충족돼 있거나, E-3 검수가 그 키 사슬의 재검수를 포함한다고 적을 것(D7이 기대는 것이 R2의 사슬 — 승인·계보 결속·QR 연결 전용 폰 키·뿌리 키 비밀번호 등록 — 이라서다) ③ `MOMO_INSTANCE_ID`가 설정돼 있을 것(셀프호스트 설치 기본값에는 없다, F20 → E-7이 설치 스크립트가 값을 만들게 한다) ④ 운영 값 변경 전 owner 판단(#4488·#3593과 같은 절차).
- ADR-0146 D-11이 「R2 서명 라우트는 R1·R2 검수 PASS 뒤에만 켠다」고 닫아 둔 것은 **host 지시**의 규칙이다. D7은 지시가 아니라 복구 라우트지만 같은 키·같은 nonce 표를 쓰는 새 경계라 D-11의 켜기 규율을 따른다. 「구현 머지 ≠ 켜기」다. ADR-0146의 D-8 서명 범위 표에 한 행(「비밀번호 재설정 — 필요, 서버 검증」)을 더한다(같은 PR).

**라우트.** `POST /v1/workspaces/{ws}/members/me/password/reset`. bearer·`require_human`. 본문 `{ newPassword, signature: { deviceKeyId, nonce, issuedAtMs, expiresAtMs, signature } }`(`HumanSignatureInput` 모양). 200 `LoginResponse`(새 세션).

**서명문 — 형제 스키마 `momo.human.password_reset.v1`.** (`signing-context`가 지금 내리는 `maxLifetimeMs`는 10분이라(`device_keys.rs:207`) D7에는 맞지 않는다. 같은 응답에 `passwordResetMaxLifetimeMs`(300000)를 `passwordResetSchema`와 함께 가산하고 클라이언트는 이 값으로 `expiresAtMs`를 정한다.) `device_endorse.v1`·`device_rebind.v1`·`refresh_proof.v1`과 같은 줄바꿈 관례다(F14). 서명 대상 바이트는 아래 9줄을 `\n`으로 이은 UTF-8이다.

```
momo.human.password_reset.v1
{instance_id}      서버가 내려 준 값(`MOMO_INSTANCE_ID`). 클라이언트가 만들지 않는다
{workspace_id}
{member_id}
{device_key_id}
{session_id}       요청 세션의 계보(`token.session_id`). 클라이언트는 `signing-context`의 `sessionId`를 쓴다
{nonce}            128비트. 서버가 1회 소비
{issued_at_ms}
{expires_at_ms}    발급 + 최대 5분
```

- 서명문은 서버가 자기 행으로 **재구성**하고(인스턴스 id는 요청이 아니라 서버 설정), 요청이 들고 오는 것은 키 id·nonce·시각·서명뿐이다(`device_endorse`의 「편지는 저장된 행으로 다시 만든다」와 같은 규율).
- **서명·서명문을 저장하지 않는다.** `action_signature` 행을 쓰지 않는다. 남는 것은 nonce 행(키 id·종류·시각)과 감사 행(키 id·플랫폼·종료한 세션 수)뿐이다.
- **새 비밀번호도 그 해시도 약속(commitment)도 서명문에 넣지 않는다.** 이유와 득실:
  - 서버는 같은 요청으로 새 비밀번호를 받는다. 서명에 묶어도 TLS를 끝내는 쪽에게는 아무것도 막지 못한다.
  - 비밀번호에서 파생한 값이 서명문에 들어가면 서명문이 흘러간 모든 곳(데스크탑 셸의 확인 창 입력, 진단·충돌 보고)이 오프라인 추측의 표적이 된다.
  - **남는 위험을 적는다**: 서명은 수명 동안(5분. 서명하는 쪽 시계가 앞서면 서버 시계로 최대 10분) 「이 계보에서 **어떤** 비밀번호로든 재설정해도 된다」는 허락이다. 서명을 받는 쪽은 웹뷰 스크립트이고(`confirm.rs:1-8`이 스스로 「웹뷰 스크립트가 서명 명령을 부를 수 있다」고 적는다) 비밀번호를 그 스크립트가 고른다. 막는 것은 네이티브 확인 창(웹뷰가 닿지 못한다, 사용자의 의도적인 클릭 필요)·재사용 창 0·5분 수명·1회 nonce·계보 결속이다.
  - 약속(`H(salt‖비밀번호)`)을 서명문에 묶는 설계는 이 위험을 줄이지 못한다(스크립트가 비밀번호를 먼저 골라 약속을 계산한 뒤 서명을 청하면 된다). 막으려면 비밀번호를 네이티브 창에서 받아 셸이 직접 서버로 보내야 한다(웹뷰를 거치지 않는 입력). 이것은 구조가 다른 후속 강화이고 v1에서 열지 않는다(기각 대안 표).

**검증 — 새 함수 `verify_password_reset_in_tx`.** 키·사슬 단계는 `verify_human_control_in_tx`에서 공용 헬퍼로 뽑아 재사용하고, 서명문과 수명 상수는 새로 둔다(`check_control_window`의 10분 상한 상수를 그대로 부르면 10분이 되므로 새 상수 `PASSWORD_RESET_MAX_LIFETIME_MS` = 5분을 `momo-wire`에 둔다). 순서:
0. 본문·**`signature` 객체 유무**·새 비밀번호 규칙(D2)·**계보별 속도 소진 확인**(서명 객체가 있는 요청만, 소진이면 429. 아래 속도 제한). DB를 쓰지 않는다. 서명 객체가 없으면 여기서 403 `device_signature_required`로 끝난다(키 없는 세션의 요청이 잠금·DB에 닿지 않는다). **여기서 거절하면 nonce를 쓰지 않는다**(사용자가 다시 서명하지 않아도 된다).
1. **잠금 순서: `human` 행 `FOR UPDATE` → `lock_member_wide_sweep_in_tx`**(F23). 둘 다 토큰 행을 잡기 전에 한다.
   - `human` 행: 효과 단계의 비밀번호 UPDATE가 이 행을 쓰는데 claim 소비와 본인 변경은 `human` 행 → sweep 순으로 잡는다(D4 잠금 순서). D7이 sweep을 먼저 잡으면 같은 멤버의 claim·PATCH와 순환한다. 같은 서명의 이중 제출도 이 행에서 먼저 직렬화된다.
   - sweep 잠금: 이 라우트는 계보·키 행을 `FOR SHARE`로 잡고 효과 단계가 멤버의 세션 행을 `FOR UPDATE`로 잡는다. 멤버 전체 sweep(정지·제거·하향 회전)은 sweep 잠금을 쥔 채 그 행들을 기다리므로, 이 잠금을 먼저 잡지 않으면 그 sweep과 순환(40P01)할 수 있다(#3109의 규칙, `token_store.rs:596-620`).
2. 키 행: 이 워크스페이스·이 멤버, `alg=p256`, 폐기 아님, 계보가 살아 있음. **층마다 오류 코드를 구별한다**(시험이 층을 가르게): 키 행이 없거나 다른 멤버·워크스페이스의 것이면 403 `device_signature_invalid`, **같은 멤버의 다른 계보 키(키의 계보 ≠ 요청 세션의 계보 — 서명한 기기가 요청한 기기여야 한다)면 403 `device_key_lineage_mismatch`**(새 코드), 폐기됐거나 계보가 끝났으면 `device_key_revoked`.
3. 사슬: `can_instruct` — 뿌리 맥 키 또는 **지금 다시 검증되는** 승인서가 붙은 폰 키. 승인 안 된 폰 키는 `device_key_not_endorsed`다(ADR-0146 D-6). 승인한 맥의 계보가 끝났으면 폰 키도 같은 코드다(F13).
4. 서명문 재구성과 P-256 검증.
5. 시간창: 서버 시각 ±5분, 수명 ≤ **5분**. 서명하는 쪽 시계가 서버보다 앞서면(발급이 +5분, 수명 5분) 서버 시계로는 최대 10분까지 유효하다. 이 폭은 서명문이 허락하는 시간이고 새 위험이 아니다(수용 6l이 세 경계를 단정한다).
6. nonce 1회 소비 — **맨 끝**(`human_control_nonce`). 이 코드베이스에서는 거절된 요청도 트랜잭션이 커밋되므로(`human_control.rs:43-46`), nonce를 앞에 두면 거절된 요청이 nonce를 태운다. **nonce는 이중 방어다.** 성공한 요청의 재전송은 계보 폐기가 먼저 막는다(키·계보 검사가 nonce보다 앞이고 폐기는 같은 트랜잭션이다). nonce가 닿는 것은 계보가 아직 살아 있는데 같은 nonce가 다시 오는 경우뿐이다.

**서버가 경계다.** ADR-0146 D-10은 「보안 경계는 workd」라 했다. 재설정에는 workd가 없다. 서버가 유일한 검증자이므로 `MOMO_HUMAN_CONTROL_SIGNATURE_REQUIRED`의 값과 **무관하게**(켜져 있는 동안은 항상) 검증한다(그 플래그는 host 지시 요구용이다, F15). 서명이 없거나 틀린 재설정은 존재하지 않는다.

**어떤 키가 서명하나 [권장]**: 뿌리 맥 키와 승인된 폰 키 **둘 다**.
- 폰 키는 `biometryCurrentSet`이라 Face ID 없이 서명하지 못한다(ADR-0146 D-2). 맥 키는 `userPresence`(Touch ID 또는 로그인 암호)다(D-3).
- 폰 단독 재설정은 맥을 잠글 수 있다(결과로 모든 세션이 끝난다, D4). 소유자 본인의 행위이고 결과가 모든 기기에 즉시 보이므로 받아들인다.
- **폰 경로는 승인한 맥의 로그인이 살아 있을 때만 된다**(F13). 맥이 로그아웃·만료되면 폰의 승인도 풀린다. 비밀번호를 잊은 때는 로그아웃된 뒤인 경우가 많으니, 폰 경로의 실제 쓰임(맥 앞이 아닐 때)은 좁다. 가용성에 넣는다(위험 절).
- 지연(Telegram 7일·Apple 1시간)은 기각한다. 기다리는 동안 소유자에게 알릴 대역 외 수단(메일)이 지금 없어서 지연이 방어가 되지 못하고, 필요한 순간에만 쓸 수 없게 만든다.

**확인 규율(데스크탑·폰 구현 요구).**
- 이 서명은 `LAContext` 재사용 창(최대 300초, `enclave.rs:92-94`)을 쓰지 않고 **매번 새로 확인**한다(창 0).
- 맥은 네이티브 확인 창(`device_key/confirm.rs`, 웹뷰가 닿지 못한다)이 「oort 비밀번호를 다시 정해요 · 이 서버 · 이 계정」을 보인 뒤에만 서명한다. 웹뷰가 부르는 일반 서명 명령(`device_key_sign_control`)은 이 스키마를 거부한다(`host_register` 거부와 같은 모양). 전용 명령을 둔다.
- 폰은 Face ID 화면이 같은 문장을 보인다.

**효과.** 비밀번호 설정 → `end_member_sessions_in_tx(PasswordReset)`(세션·푸시·키·예약 보류·**대기 중인 재설정 링크**, D4) → 새 세션 발급 → 감사 `member.password_reset.device_signed`. 서명한 기기도 새 계보를 받고 **키는 폐기된다**(D4): 서명자가 돌려받는 것은 새 세션이다. 키는 새 비밀번호로 다시 등록한다.

**키가 없는 세션에는 이 길이 없다.** 웹 브라우저(항상), R2 이전에 로그인한 세션, 뿌리를 등록하지 않은 맥, 승인 전 폰, **승인한 맥의 로그인이 끝난 폰**, 이 기능이 꺼진 서버. 설정 › 보안의 「복구 준비」 행이 사실대로 말한다. 판단은 `GET …/device-keys`의 `current`·`canInstruct`·`lineageLive`와 `signing-context`의 `passwordResetSchema`로 한다. 이 기기에서 가능한지, 불가라면 **이유 하나**(「이 서버에서 켜져 있지 않아요」·「지시 키가 없어요 — 맥에서 만들 수 있어요(비밀번호가 필요해요)」·「맥 로그인이 끝나서 승인이 풀렸어요」)와 「관리자에게 요청」(D5) 안내를 보인다.

**속도 제한.** 본인 변경(`admit_password_change`)·뿌리 키 등록과 **다른 버킷**이다. 키는 (멤버, 계보), 기본 5회 / 60초(`RATE_LIMIT_PASSWORD_RESET_SIGNED_PER_LINEAGE`), 0·파싱 불가는 기본값이다. **서명이 없는 요청은 이 버킷을 쓰지 않는다**(키 없는 세션은 즉시 403). 세션을 훔친 쪽이 서명 없는 요청으로 정당한 소유자의 복구 예산을 소진하지 못하게 하려는 것이다. 서명을 들고 온 요청의 실패만 센다. 계보 키는 DoS 격리용이고 추측 방어가 아니다(서명은 추측할 수 없다). 계보를 늘려도 `refused` 감사 행은 늘지 않는다(D9의 멤버 단위 슬롯).

**열어 두는 확장.** ADR-0195 PK 구현 뒤 「최근 5분 안 패스키 재인증」을 같은 라우트의 두 번째 증명으로 허용할지는 별도 결정이다(웹 세션이 길을 얻는다). 이 ADR은 응답·요청에 `proof` 필드를 만들지 않는다.

### D8. 재설정 링크의 앱 입력 — 새 스킴을 만들지 않는다 [권장]

- 사람이 전하는 산출물은 **https `claimUrl` 하나**다(D6). `oort://claim` 스킴 문법은 만들지 않는다. 이유: 24시간 동안 계정 비밀번호를 정할 수 있는 토큰이 사용자 지정 스킴으로 오가면, 다른 앱이 같은 스킴을 열어 가로챌 수 있다는 위협에 노출된다 [S, 알려진 성질 — Apple 문서는 열지 않았다]. ADR-0195 D-7이 120초짜리 교환권에도 PKCE 결속을 붙인 이유와 같은 전제다.
- 앱은 `https://<origin>/claim/<token>`을 **로그인 화면 QR 스캐너**와 **「링크를 받았어요」 붙여넣기**로 받는다. 코어에 이 형태에서 `{server, token}`을 뽑는 함수 하나를 둔다(웹 `entryInput.ts`의 claim 분기를 코어로 올린다. 웹·폰·데스크탑이 같은 것을 쓴다). `server`는 `normalizeServerUrl`로 재검증하고 토큰 길이·문자 집합이 틀리면 `null`이다. 폰에서 https 링크를 탭하면 Safari의 웹 claim 화면이 열린다(앱이 없어도 된다).
- **claim 화면은 서버 호스트를 칩으로 보이고 사용자가 확인한 뒤에만 비밀번호 칸을 연다.** 폰은 링크의 서버로 새 비밀번호를 보내므로, 공격자가 `https://evil.example/claim/<아무 값>`을 「관리자가 보낸 링크」라며 보내면 사용자가 다른 곳에서도 쓰는 비밀번호를 공격자 서버에 입력한다. 웹 브라우저는 주소창이 이 역할을 하고, 주소창이 없는 **데스크탑(Tauri)과 폰**에는 칩이 필요하다. `join` 링크가 주소·코드를 한 칩으로 보이는 선례를 따른다(`ConnectScreen.tsx:236-237`).
- #2812(OPEN, **데스크탑** `oort://claim/<token>`)는 그 이슈의 계약이다. 이 ADR은 그 이슈에 두 가지를 요구한다: ① 호스트 확인(위와 같다) ② 서버가 없는 경로형이므로 앱이 저장한 서버를 쓴다는 점을 본문에 적는다(저장된 서버가 없으면 거절). 폰은 이 스킴을 쓰지 않는다.

### D9. 감사

| action | schema | 비고 |
|---|---|---|
| `member.password_reset.issued` | 기존 | 관리자 발급(`password.rs:113-126`) |
| `member.password_reset` | 기존 | claim 소비(`claim.rs:101-128`) |
| `member.password_changed` | 기존 | 본인 변경(`password.rs:203-216`) |
| `member.password_reset.device_signed` | `momo.member.password_reset.device_signed.v1` | **새 것**. detail은 `device_key_id`·`platform`·`sessions_revoked`뿐이다 |
| `member.password_reset.refused` | `momo.member.password_reset.refused.v1` | **새 것**. 관리자 재확인 실패(D6)와 서명을 들고 온 D7 요청의 거절. detail은 `via`(`admin`\|`device`)와 `reason`(`current_password_incorrect`·`device_signature_invalid`·`device_key_lineage_mismatch`·`device_signature_expired`·`device_nonce_replayed`·`device_key_revoked`·`device_key_not_endorsed`)뿐이다 |

- **실패도 흔적을 남긴다.** 새 경계(발급·서명)에서는 실패의 흔적이 탐지의 거의 유일한 신호다. 행의 증가는 **멤버 단위 윈도 슬롯**(`audit:` 키, 윈도당 한 행)으로 묶는다. `audit_denial_once`(`rate_limit.rs:850-916`)와 같은 모양이다. 계보를 바꿔 가며 보내도 행은 멤버·윈도당 하나이고 초과분은 WARN이다. 서명이 없는 요청과 속도 제한에 걸린 요청은 감사 행 대신 버스트당 WARN 한 줄(멤버 id·사유 코드만)을 낸다.
- 새 비밀번호·현재 비밀번호·서명·nonce·링크·토큰 원문은 감사 detail과 로그에 들어가지 않는다. 증명은 **서버 시험**이다(수용 기준 10).

### D10. 이 ADR이 열지 않는 것

- **로그인 시도 제한·잠금이 없다**(F9). ADR-0214가 시험 없는 「레이트 리밋」 문장을 목록에서 뺀 것과 같은 사정이다. 이 ADR의 복구 길은 토큰·서명이 지키므로 온라인 추측 표면을 새로 만들지 않지만, 로그인 쪽의 약점은 그대로다. 새 이슈 초안(엔진·보안): **계정 축** 쓰로틀 + 전역 쓰로틀(F10 때문에 IP 키는 보조). 범위에 로그인뿐 아니라 본인 변경(PATCH)과 D6의 관리자 재확인을 넣는다(계보를 늘려도 한도가 늘지 않게, F24).
- **해시 비용·방식.** `gen_salt('bf')`의 기본 반복 6(F8)을 올리는 일과 72바이트 한계를 푸는 일(사전 해시·argon2, D2)은 위 쓰로틀과 **한 묶음**(E-5)으로 한다. 비용만 올리면 제한 없는 로그인 시도가 CPU를 태운다.
- 메일 재설정·확인, 대기 시간 기반 복구, 재설정·발급 알림(대상 멤버의 다른 세션이나 다음 로그인에 안내), 비밀번호 차단 목록(NIST SHALL), 2단계 인증(ADR-0195 D-10).
- **마지막 owner 잠김**의 일반 운영자 경로(F18). `migrate set-owner`는 시드 워크스페이스 한정이다. 새 이슈 초안(E-6, 엔진): 운영자가 서버에서 owner용 24시간 재설정 링크를 발급하는 명령과 운영자 복구 문서. D5의 3번 항목이 이 이슈에 달려 있다.
- 공개 관리자 명단·문의처 문구(D5), 패스키 재인증 증명(D7), 「호출 계보 유지」 변형(D4), 폰의 멤버 관리 표면(D6), 관리자 발급에 기기 키 서명을 요구하는 변형(D6 — 웹 관리자가 막힌다), 네이티브 창에서 비밀번호를 받아 셸이 직접 보내는 입력(D7 — 서명이 받는 비밀번호에 결속되는 유일한 길).
- 딥링크·QR로 연결할 때의 호스트 확인(ADR-0180 증보 C8의 비대칭)은 별도 이슈(U-9)다.

## 기각 대안

| 대안 | 기각 이유 |
|---|---|
| 메일 재설정 | 발송기가 없고(F4) owner가 「나중에」라 했다. Slack 같은 길은 메일이 선행한다 |
| 서명 대신 「최근 로그인」을 요구 | 비밀번호를 잊은 사람은 최근 로그인을 만들 수 없다. 비밀번호 로그인 계보는 refresh 탈취도 기본값에서는 막지 못한다(F15) |
| 대기 기간(Telegram 7일·Apple 1시간) | 알릴 대역 외 수단이 없다. 필요한 순간에 쓸 수 없게 만든다 |
| 티켓 방식 — 로그인된 기기가 자기용 재설정 링크를 만들고 잠긴 기기가 쓴다 | 새 베어러(링크)·claim 분기가 늘고 서명은 토큰 발급에만 쓰인다. 로그인된 기기에서 새 비밀번호를 바로 정하면 잠긴 기기는 새 비밀번호로 로그인하면 끝난다 |
| 공개 「비밀번호 찾기」 요청(관리자에게 알림) | 계정 열거·스팸 표면. 수신자가 열려 있는 세션이어야 하는데 잠긴 사용자는 보낼 수도 없다 |
| 로그인 화면의 공개 관리자 명단 | 공개 주소에서 멤버 열거(D5) |
| 키 없는 웹 세션에 재설정 허용 | localStorage 세션 하나로 계정을 영구히 가져간다. ADR-0146 D-4가 웹을 비지시 표면으로 둔 이유와 같다 |
| 변경에도 서명 요구 | 변경은 현재 비밀번호가 증명이다 |
| Apple식 「호출 계보 유지」 | D4 |
| 최소 길이 8 | NIST는 8을 다요소의 일부일 때만 허용한다. oort 비밀번호는 1요소다 |
| 새 입력 두 곳(변경·재설정)에만 규칙 | join·claim으로 약한 비밀번호가 계속 생기고 한 함수로 모으는 비용이 작다(D2) |
| 현재 비밀번호에도 새 규칙(검증기 하나) | 10자 미만의 기존 비밀번호를 가진 계정이 변경·관리자 발급을 못 한다(D2) |
| 새 비밀번호(해시)를 서명문에 묶기 | 서명문이 흘러간 곳이 추측 표적이 된다(D7) |
| 새 비밀번호의 약속(commitment)을 서명문에 묶기 | 비밀번호를 고르는 스크립트가 약속을 먼저 계산하면 되므로 위험을 줄이지 못한다. 막으려면 네이티브 입력이 필요하다(D10) |
| `oort://claim` 앱 스킴 링크를 발급 응답에 싣기 | 24시간짜리 비밀번호 설정권이 스킴 가로채기에 노출된다. https 링크를 스캐너·붙여넣기로 받으면 앱 전용 스킴이 필요 없다(D8) |
| 관리자 발급에 기기 키 서명 요구 | 웹 브라우저의 관리자가 발급하지 못한다. 본인 비밀번호 재확인이 같은 위협을 막는다(D6) |
| D7을 상시 켜짐으로 | ADR-0146 D-11의 닫힘 규칙을 말없이 우회한다. 스위치로 닫고 검수 뒤에 켠다(D7) |
| 본인 변경(PATCH)도 대기 링크를 끝낸다 | 비밀번호를 아는 공격자가 변경을 반복해 관리자가 발급하는 링크를 계속 끊는다. 변경이 세션·키도 끝내므로 소유자의 복구 길이 링크 하나뿐인데 공격자가 끊는다(D4) |
| D6 속도 키에 계보를 넣는다 | 계보는 훔친 세션 하나로 무한히 만들 수 있어 비밀번호 추측을 막지 못한다. 관리자 멤버 단위로 센다(D6) |

## owner 결정으로 덮이는가

| 결정 | owner 결정 | 표기 |
|---|---|---|
| 찾기 = 관리자 재발급 + 로그인된 기기에서 재설정, 메일은 나중 | **덮임**(10-26 원문) | owner |
| 로그인한 상태에서도 비밀번호 변경·재설정 | **덮임**(10-26 「로그인한 상태에서도」) | owner |
| 서명을 **요구**하는 재설정(키 없는 기기는 불가), 키 종류, 확인 규율, 스위치(기본 꺼짐) | **덮임**(owner 10-26 확인 「그러쇼」) | owner |
| 10자·72바이트 규칙과 네 경로 일괄 적용, 두 검증기 분리 | **길이 10자는 덮임**(owner 10-26 「비밀번호는 10자 이상으로 하자」), 나머지는 덮이지 않음 | owner(길이) · [권장] |
| 변경·재설정 뒤 전체 종료 유지, 대기 중인 링크 종료 | 덮이지 않음(현행 유지 + 틈 막기) | [권장] |
| 로그인 화면에 관리자 목록 대신 문구 | **덮임**(owner 10-26 확인 「ㅇㅋ」) — 이슈 Goal 3(b)에서 이탈한 것을 owner가 받아들임 | owner |
| 관리자 발급에 본인 비밀번호 재확인(파괴적 API 변경) | 덮이지 않음 — 「관리자 재발급」 자체는 덮이고 재확인은 위협으로 더한 것 | [권장] |
| `claimUrl`·`claimKind` 가산, 새 앱 스킴을 만들지 않음, claim 화면 호스트 확인 | 덮이지 않음 | [권장] |
| TTL 24시간 유지(관리자 링크) | 덮이지 않음(ADR-0166 봉인) | 현행 |

## 새 공개 API 선언 (ADR-0100)

아래 표면은 이 ADR을 Accepted 근거로 삼는다. 기기 연결(ADR-0180 증보)의 표면은 그쪽 「새 공개 API 선언」에 있다. 필드 이름·OpenAPI는 각 구현 이슈가 확정한다.

| 표면 | 내용 | 이슈 |
|---|---|---|
| `POST /v1/workspaces/{ws}/members/me/password/reset` | **새 라우트**. D7. `MOMO_PASSWORD_RESET_SIGNED`가 꺼져 있으면 404 | E-3 |
| `GET …/device-keys/signing-context` | `passwordResetSchema`·`passwordResetMaxLifetimeMs`(300000) 가산(스위치가 켜졌을 때만) | E-3 |
| `POST …/members/{member}/password-reset` | **파괴적 변경**: 요청 본문에 `currentPassword`(관리자 본인) **필수**. 응답에 `claimUrl`·`claimUrlSecure` 가산(기존 필드 유지). 저장소 안 호출자 갱신(F21) | E-4 |
| `POST /v1/claim` | 200·409·410 본문에 `claimKind` 가산 | E-4 |
| join·claim·`PATCH …/me/password`·D7 라우트 | 400 코드 `password_too_short`·`password_too_long`, 현재 비밀번호 칸은 완화된 검증 | E-1 |
| 오류 코드 | D7 라우트의 `device_key_lineage_mismatch`(새, 403). D6 발급의 `current_password_required`(400)·`current_password_incorrect`(403)(새). 나머지는 R2의 기존 코드 | E-3·E-4 |
| 환경 변수 | `MOMO_PASSWORD_RESET_SIGNED`(기본 꺼짐, 켜졌는데 `MOMO_INSTANCE_ID`가 없으면 기동 거부), `RATE_LIMIT_PASSWORD_RESET_SIGNED_PER_LINEAGE`(5), `RATE_LIMIT_PASSWORD_RESET_ISSUE_PER_ADMIN`(5). 속도 노브의 0·파싱 불가는 기본값 | E-3·E-4 |

## DB 계약 (새 migration만)

- 번호: main·track/uxui는 149, track/engine은 151(`150_attachment_reclaim.sql`·`151_audit_attachment_name_scrub.sql`, #4443)이 마지막이다 [V, 2026-10-26]. 실제 번호는 구현 시점의 다음 번호다. `schema_v0.sql`은 건드리지 않는다.
- 이 ADR(D6·D7) 몫: `human_control_nonce_kind_ck`에 `'password_reset'`을 더한다(DROP 후 ADD, 재실행 가능한 모양, F14). **허용 목록은 그 시점의 전체 목록에 더한다**: ADR-0210 HO-10이 같은 CHECK에 `ops_session`·`ops_box`를 더하므로, 두 마이그레이션이 각자 목록을 다시 쓰면 나중 것이 먼저 것의 kind를 지운다. 마이그레이션 시험은 기존 kind가 모두 허용됨을 단정한다. 새 테넌트 테이블은 없고 기존 테이블의 RLS FORCE·`ws_isolation`은 그대로다.
- **이 PR 전체로는** 새 EXECUTE 전용 definer 함수가 하나 있고 새 열이 있다: ADR-0180 증보 C3의 `momo_join_private.device_link_workspace_id_by_code`, `device_link_token`의 새 열, `token`의 폐기 사유 열. 이 ADR 단독으로는 새 definer 함수가 없다(D7은 인증된 요청이고 D6은 기존 `owner_claim_workspace_id`를 쓴다).

## 수용 기준 (red proof)

각 항목은 **조건 하나만 거짓**인 입력으로 쓰고, 조건을 지우면 빨개지는 사보타주를 둔다. **사보타주**는 구현 PR이 해당 줄을 실제로 바꿔 그 시험이 빨개지는지 손으로 확인하고 결과를 PR 본문에 적는 변이다. 규칙 셋이 있다.
- ① 그 줄 하나만 바꿨을 때 **지정한 시험은 반드시 빨개져야** 한다. 같은 기능을 공유해서 함께 빨개지는 다른 시험이 있으면 PR 본문에 적는다(어느 시험이 그 조건을 증명하는지 손으로 확인하려는 것이다).
- ② 방어층이 겹쳐 있으면 줄 하나로는 격리되지 않는다. 결과를 단정하고 **두 층을 함께** 지우거나, 층마다 오류 코드를 구별해 줄 하나가 한 층만 가르게 한다.
- ③ 동시성·교착 시험은 반복 횟수(예: 100회)나 결정적 간섭(`pg_sleep`, 두 연결 사이의 순서 고정)을 쓴다.

새 보안 문장을 `docs/security/claims.yaml`·SECURITY.md에 올릴 때는 그 항목의 증명 선택자와 저장소 안 음성 대조(ADR-0214 D4)가 구현 이슈의 몫이다. 새·바뀐 서버 PG 시험은 `infra/security-pack/selection.txt`에 올려 PR CI 레인으로 편입한다(구현 이슈의 몫. 이 파일은 정책 경로가 아니다). 이 ADR은 어떤 시험도 실행하지 않았다(`runtime-unverified`).

1. **규칙(D2).**
   - 1a~1d 새 비밀번호: 9자 → 400 `password_too_short`, 10자 → 통과, 72바이트 → 통과, 73바이트(한글 24자 + 1바이트) → 400 `password_too_long`. 네 경로(join·claim·변경·D7)를 **경로별로** 시험한다. 사보타주: 한 경로에서 `normalized_new_password`를 빼면 그 경로만 빨개진다.
   - 1e 경계: 이모지(4바이트)·한글 NFD 입력이 **바이트로** 센다(NFD 한글은 NFC보다 일찍 상한에 닿는다). 사보타주: 상한을 글자 수로 세게 바꾸면 73바이트 입력이 통과해 빨개진다.
   - **1f 현재 비밀번호**: 9자 현재 비밀번호로 `PATCH …/me/password`가 200이고 D6 발급이 201이다. 사보타주: 현재 칸에 새 규칙을 걸면 빨개진다.
   - 1g 로그인은 규칙보다 앞선 기존 비밀번호로 성공한다 — 9자(최소 미달)와 100자(72바이트 초과) 둘 다. 14자는 10자 이상이라 로그인에 규칙을 걸어도 초록이므로 단정이 되지 못한다. 사보타주: 로그인에 규칙을 걸면 빨개진다.
2. **전체 종료와 대기 링크(D4).** 한 호출이 여러 일을 하므로 단정을 나눈다.
   - 2a 그 멤버의 기기 키 행이 모두 `member_sessions_ended`로 폐기. 사보타주: `revoke_member_device_keys_in_tx` 호출만 지운다.
   - 2b 푸시 등록 무효. 사보타주: `invalidate_member_push_tokens_in_tx` 호출만 지운다.
   - 2c 옛 refresh 401·응답의 새 쌍 유효. 사보타주: 세션 토큰 폐기만 지운다.
   - **2d 대기 링크가 끝나는 경로**: 발급 → **D7·정지·제거·탈퇴** 각각 → 이전 링크로 `POST /v1/claim` → 409. 사보타주: 새 소비 UPDATE를 지운다. (claim 소비 경로는 소비되는 행이 곧 그 링크이고 멤버당 live 링크는 하나라서 이 행의 증거가 되지 못한다.)
   - **2e 본인 변경은 링크를 끝내지 않는다**: 발급 → PATCH를 반복(P↔P2) → 그 링크로 claim → 200(링크가 살아 있다). 사보타주: 원인 `PasswordChanged`에서도 소비하게 하면 빨개진다.
   - 2f `owner_bootstrap` claim은 어느 경로에서도 그대로 살아 있다. 사보타주: `kind` 필터를 지운다.
   - **2g 교착 없음 — 쌍마다 한 행이고 단정은 두 연결 모두 40P01 없이 커밋이다**(교착의 희생자는 보통 먼저 기다린 쪽이라 한쪽만 단정하면 사보타주에서도 초록일 수 있다). 끼어드는 지점은 시험 훅으로 고정한다(규칙 ③).
     - 2g-1 claim 소비(T1: sweep 잠금 직전에 멈춘다. claim 행·`human` 행을 쥔 상태)와 **정지·제거·탈퇴**(T2: sweep을 쥐고 새 소비 UPDATE로 같은 claim 행에 닿는다). 사보타주: `SKIP LOCKED`를 지운다.
     - 2g-2 claim 소비(T1: `human` 행을 쥐고 sweep 직전에 멈춘다)와 **D7**, 본인 변경(PATCH)과 **D7**(두 쌍). 사보타주: D7이 `human` 행 잠금을 sweep 잠금 뒤로 옮긴다.
3. **찾기 화면(D5).** 화면을 열고 닫는 동안 네트워크 호출 0건(웹·폰 spy). 화면 어디에도 멤버 이름·핸들이 없다(fixture에 owner·admin을 둔 상태에서). 사보타주: 명단 호출을 넣으면 spy가, 이름을 렌더하면 두 번째 단정이 빨개진다.
4. **관리자 사다리와 재확인(D6).**
   - 4a 기존 20칸 표(`password_reset_ladder_matches_adr_0128_d2`, `password_reset_conformance_pg`)를 유지한다. 사보타주: `Admin => true`(기존 증거 `docs/planning/handoffs/2026-08-27-fable-resume-checkpoint.md:17-18`).
   - 4b 본문 없음·`currentPassword` 없음 → **400** `current_password_required`. 사보타주: 본문 추출 실패를 axum 기본(415·422)으로 두면 빨개진다.
   - 4b′ 틀림 → 403이고 이전 live 토큰이 살아 있고 발급 감사 행이 0개이고 `refused` 행이 1개다. 사보타주: 비밀번호 검사를 지운다.
   - 4c 틀린 비밀번호로 존재하지 않는 멤버와 있는 멤버가 같은 403이다. 사보타주: 검사를 대상 조회 뒤로 옮긴다.
   - 4d 14자 관리자 비밀번호로 201(1f와 짝).
   - 4e 파괴적 변경에 맞춰 OpenAPI 계약 게이트·`password_reset_conformance_pg`·`verify_owner_claim.sh`·AUTH-4 증명이 새 계약으로 초록이다.
   - 4f 속도: 같은 관리자의 6번째 요청이 비밀번호가 맞아도 429. **다른 관리자의 요청은 영향이 없다**. 사보타주: 키에서 멤버를 빼(전역 버킷) 두 번째가 빨개지게 하거나, 맞는 비밀번호를 세지 않게 해 첫 번째가 빨개지게 한다.
5. **claim(D6).**
   - 5a `claimKind`는 200·409·410 본문에 있고 404·400·429에는 없다. 사보타주: 404 본문에 넣으면 오라클 시험이 빨개진다.
   - 5b `claimUrl`의 origin은 설정된 공개 주소가 있으면 그것이다(요청 `Host`가 달라도). 사보타주: `Host`를 우선한다.
   - 5b′ 설정이 없고 요청이 `http://`이거나 loopback·사설 주소이면 `claimUrlSecure: false`다. 사보타주: 항상 `true`로 둔다.
   - 5c `claimPath`가 남는다.
6. **서명 재설정(D7) — 조건마다 한 행.**
   - 6a 유효한 서명(뿌리 맥 키 / 승인된 폰 키) → 200, 이전 세션 전부 401, 감사 `device_signed` 1행, nonce 1행, **`action_signature` 행 0개**(서명 비저장).
   - 6b 서명 없음 → 403 `device_signature_required`. `MOMO_HUMAN_CONTROL_SIGNATURE_REQUIRED=false`(기본)에서도 그렇다. 사보타주: 플래그가 꺼져 있으면 서명을 건너뛰게 하면 빨개진다.
   - 6c 같은 워크스페이스 다른 멤버의 키 → `device_signature_invalid`. 사보타주: 키 조회의 멤버 비교를 지우면 같은 요청이 다음 층(계보 검사 등)에 걸려 코드가 `device_signature_invalid`가 아닌 다른 코드로 바뀌어 빨개진다(층마다 코드를 구별했다).
   - 6d 다른 워크스페이스의 키 id → `device_signature_invalid`. 방어층이 겹친다(RLS로 조회가 비는 것, 코드의 워크스페이스 비교). 결과를 단정하고 사보타주는 **두 층을 함께** 지운다.
   - 6e **`instance_id` 줄이 빠진 8줄 서명문**(다른 인스턴스용으로 만든 서명은 서버가 자기 `instance_id`로 재구성하는 9줄과 맞지 않아 거절되고, 이 8줄은 인스턴스를 가리지 않는 서명이다)에 서명해 보낸다 → 403 `device_signature_invalid`. 사보타주: 서버의 서명문 재구성이 `instance_id` 줄을 뺀다(8줄). 이때 8줄 서명이 통과해 6e가, 정상 9줄 서명이 거절돼 6a가 **함께** 빨개진다. 같은 행에서 다른 `instance_id` 값으로 만든 9줄 서명의 거절도 단정한다(서버가 그 값을 요청에서 받지 않아 지울 줄이 없으므로 사보타주는 8줄 변이가 맡는다). 줄 목록 자체는 6n의 공유 벡터가 고정한다.
   - 6f 같은 멤버의 **다른 계보** 키로, **요청 세션의 계보를 담은 서명문**에 서명 → 403 `device_key_lineage_mismatch`. 사보타주: 키-세션 계보 비교를 지운다(서명문의 session 줄을 요청 세션으로 만들어야 이 행이 비교만 겨냥한다).
   - 6g 승인 안 된 폰 키 → `device_key_not_endorsed`. 사보타주: 승인 검사를 지운다.
   - 6h 폐기된 키 → `device_key_revoked`. 사보타주: 폐기 검사를 지운다. 6h′ 끝난 계보의 키 → `device_key_revoked`. 사보타주: 계보 검사를 지운다(두 조건이라 두 행이다).
   - 6i 승인한 맥의 계보가 끝난 뒤의 폰 키 → `device_key_not_endorsed`. 거절하는 층이 둘이고 같은 코드를 낸다(키를 읽을 때 SQL이 파생하는 `endorser_live`의 계보 절, 잠금 아래 `endorser_lineage_live`, `device_key.rs:318-333`·`human_control.rs:271-278`). 결과를 단정하고 사보타주는 **두 층을 함께** 지운다. 픽스처: 승인자 키는 폐기되지 않은 채 승인자 계보의 refresh 행만 끝난 상태(refresh 재사용 감지는 키를 남긴다 — `session_end.rs:42-52`, #3097 — 또는 만료). 맥 로그아웃은 승인자 키도 폐기해서(`LineageEnd::Logout`) 다른 층이 같은 코드를 내므로 이 행의 픽스처가 아니다.
   - 6j 순차 재전송(같은 bearer) → 401. 이미 폐기된 세션이라 서명 검증에 오지 못한다(이 행은 nonce를 증명하지 않는다).
   - **6k 동시 이중 제출**(같은 서명, 같은 bearer): 정확히 하나가 200이고 다른 하나는 401 또는 `device_key_revoked`이며 **40P01이 없다**. 1단계의 `human` 행 잠금이 둘을 직렬화하고 늦은 쪽은 앞선 쪽이 폐기한 계보를 만난다. 사보타주: 1단계의 두 잠금(`human` 행·sweep)을 **함께** 지운다(`human` 행 잠금만으로도 직렬화되므로 한 층만 지우면 이 행은 초록이다. 반복 100회 또는 두 연결 사이 `pg_sleep`으로 40P01을 낸다). 이 행은 nonce를 증명하지 않는다.
   - **6k″ sweep 잠금**: D7과 같은 멤버의 멤버 전체 sweep(정지)이 겹쳐도 40P01 없이 둘 다 끝난다. 간섭 지점은 `member_sweep_lock_order_pg.rs`의 결정적 모양을 따른다(D7이 키·계보 행을 잡은 채 멈추고, 정지가 sweep 잠금을 쥔 채 그 행들을 기다리게 한다). 정지는 `human` 행을 잡지 않아서 이 행에서는 sweep 잠금이 유일한 방어다. 사보타주: `lock_member_wide_sweep_in_tx`만 지운다.
   - **6k′ nonce 소비**: `human_control_nonce`에 `(워크스페이스, nonce)` 행을 먼저 심어 둔 상태에서, 새로 서명한 **유효** 요청(키·계보 정상) → 403 `device_nonce_replayed`이고 비밀번호·세션은 그대로다. 사보타주: nonce 소비 INSERT를 지운다(요청이 200이 되어 빨개진다).
   - 6l 시간창 세 경계, 경계마다 한 단정이다. **미래 쪽**: `issued = 서버 시각 + 6분`, 수명 2분 → `device_signature_expired`(사보타주: `|now−issued|` 검사를 지운다. 과거로 6분 전의 서명은 `now ≥ expires` 검사가 먼저 거절하므로 이 검사만 겨냥하려면 미래로 만든다). **만료**: `issued = now−4분`, `expires = now−1분` → 같은 코드(사보타주: `now < expires` 검사를 지운다. skew와 수명은 통과하는 값이다). **수명**: `issued = now`, `expires − issued = 6분` → 같은 코드(사보타주: 수명 상수를 control의 10분으로 둔다). 서명하는 쪽 시계가 앞서면 서버 시계로 최대 10분 유효하다는 것은 D7 문장이다.
   - 6m **0단계 거절은 nonce를 쓰지 않는다**: 14자 새 비밀번호로 서명한 요청이 400이고 nonce 행이 0개다. 사보타주: 규칙 검사를 nonce 뒤로 옮긴다.
   - 6n 서명문 바이트 고정: 공유 벡터(Rust·Swift·TS)가 줄 목록을 고정한다. 사보타주: 비밀번호나 그 해시·약속 줄을 더하면 빨개진다.
   - 6o **스위치**: `MOMO_PASSWORD_RESET_SIGNED`가 꺼져 있으면 라우트 404이고 `signing-context`에 `passwordResetSchema`가 없다(사보타주: 항상 연다). **켜졌는데 `MOMO_INSTANCE_ID`가 없으면 기동이 거부된다**(사보타주: 그 검사를 지운다).
   - 6p 속도: 서명을 든 요청이 같은 (멤버, 계보)에서 6번째면(앞선 다섯이 모두 거절됐을 때) 429. 사보타주: 한도를 지운다. **서명 없는 요청 100개가 정당한 계보의 예산을 쓰지 않는다.** 다른 계보는 영향이 없다. 사보타주: 서명 없는 요청도 세게 하면 두 번째가, 키에서 계보를 빼면 세 번째가 빨개진다.
   - 6q **nonce CHECK 마이그레이션**: 새 migration 뒤 `human_control_nonce`가 그 시점의 기존 kind 전부와 `password_reset`을 모두 받아들인다(kind마다 INSERT가 성공하는 시험). 사보타주: 새 목록에서 기존 kind 하나를 뺀다.
7. **복구 준비 표시(D7).** 서버가 `passwordResetSchema`를 안 내림 / `instance_id_unconfigured` / 승인한 맥의 로그인이 끝난 폰이 각각 **다른 이유 한 줄**로 「다시 정하기」 행을 숨긴다(웹 시험). 사보타주: 해당 분기를 지우면 그 행만 빨개진다.
8. **데스크탑 확인 규율(D7).** 전용 명령이 네이티브 확인 창 문장에 서버·계정·「비밀번호를 다시 정해요」를 담는다(사보타주: 서버를 문장에서 뺀다). 재사용 창 0으로 서명한다(사보타주: 300초로 바꾼다). 웹뷰의 `device_key_sign_control`이 이 스키마를 서명하려 하면 거부된다(사보타주: 거부를 지운다).
9. **claim 입력(D8).**
   - 9a `https://<host>/claim/<token>` → `{server, token}`. 불량 server·토큰 길이 오류·`oort://` 형태는 `null`. 사보타주: `oort://claim`을 받아들이면 빨개진다.
   - **9b 호스트 칩**: claim 화면은 서버 호스트를 보이고 사용자가 확인하기 전에는 비밀번호 칸이 닫혀 있다. `POST /v1/claim`이 가는 호스트는 칩의 호스트다. 사보타주: 칩을 지우거나 확인을 건너뛰게 하면 빨개진다. 웹 브라우저는 주소창이 대신해서 이 행의 대상이 데스크탑(Tauri)·폰이다.
10. **비유입(서버 시험, D9).** `claim_conformance_pg.rs:274-357`의 모양(`tracing_subscriber`로 로그를 가로챔)으로 발급 → 소비 → 실패(틀린 관리자 비밀번호·틀린 서명) 전 경로를 돌리고, 링크·토큰·현재·새 비밀번호·서명(원문과 base64url·URL 인코딩 파생)이 로그와 `audit_log.detail`에 0건임을 단정한다. **음성 대조**: 일부러 로그에 토큰을 찍는 변이에서 빨개져야 한다. 웹의 `deviceLinkSecrets.gate.test.ts` 모양은 캡처 파일 이름 위생에만 쓰고 이 기준의 증명이 아니다.
11. **실패의 흔적(D9).**
    - 11a 틀린 관리자 비밀번호·서명 거절이 `refused` 행 1개를 남기고 detail에 값이 없다. 사보타주: detail에 입력 값을 넣는다.
    - 11b 서명 없는 요청은 행을 남기지 않고 WARN 한 줄이다. 사보타주: 서명 없는 요청도 `refused` 행을 쓰게 한다.
    - 11c 계보를 바꿔 가며 거절 요청을 보내도 `refused` 행은 멤버·윈도당 1개다. 사보타주: 멤버 슬롯을 계보 슬롯으로 바꾼다.
12. **안내 문구(UI 시험, D3·D5·D6).** 문구가 사라지면 화면 시험이 빨개진다.
    - 12a D3 변경 성공 화면에 「관리자에게 받은 재설정 링크가 있다면 24시간 안에는 쓸 수 있어요」 취지의 한 줄이 있다. 사보타주: 문구를 지운다.
    - 12b D5의 「서버를 직접 운영한다면」 항목은 E-6이 머지되기 전에는 보이지 않는다. 사보타주: 항상 보이게 한다.
    - 12c D6 확인 대화상자가 다섯 줄(이전 링크 무효·24시간 1회·받는 사람이 정하면 모든 기기 로그아웃·본인 확인은 관리자가 한다·세션을 끝낸 뒤 발급)을 모두 보인다. 사보타주: 「본인 확인은 관리자가 한다」 줄을 지운다.

## 구현 슬라이스

이슈 번호가 없는 것은 PR 본문 「새 이슈 초안」에 적고 발행은 planner가 한다. 기존 이슈와의 대조는 PR 본문에 있다. `docs/planning/ENGINE_HANDOFF.md`의 A-36(「비밀번호 재설정/변경 웹 표면」, 이슈 없음)은 U-1·U-2·U-4가 대체한다.

- **E-1 (engine)** 새 비밀번호 규칙·두 검증기 분리·오류 코드·시험 fixture 전수 갱신(D2).
- **E-3 (engine·security)** 로그인된 기기 서명 재설정(D7): `momo.human.password_reset.v1`(momo-wire·공유 벡터), 새 함수 `verify_password_reset_in_tx`와 공용 헬퍼, 잠금 순서, 라우트, migration(nonce CHECK — 그 시점의 전체 목록에 더한다), 스위치와 부팅 거부, 계보별 속도 버킷, 감사, `signing-context` 가산. **E-4의 D4 변경(대기 링크 소비)에 의존한다.** 독립 보안 검수 Blocker 0·High 0이 머지 조건이고 **켜기는 별도**(D7)다. 서버 PG 시험을 `selection.txt`에 올린다.
- **E-4 (engine)** 관리자 재발급(D6): 본인 비밀번호 재확인, 응답 `claimUrl`·`claimUrlSecure`, 설정된 공개 origin 우선, claim `claimKind`, `end_member_sessions_in_tx`의 대기 링크 소비(D4: 본인 변경 제외·`SKIP LOCKED`), 저장소 안 호출자(OpenAPI·계약 게이트·conformance·AUTH-4) 갱신, 서버 비유입 시험.
- **E-5 (engine·security)** **계정 축** 로그인 시도 제한(로그인·본인 변경·D6 재확인) + 해시 비용·방식(72바이트 해제 포함) 한 묶음(D10). 별도 ADR이 필요한지 그 이슈가 먼저 판단한다.
- **E-6 (engine·ops)** 운영자 owner 복구 명령(24시간 재설정 링크)과 운영자 복구 문서. **D5의 3번 항목이 이것에 달려 있고**, 혼자 쓰는 셀프호스트 owner의 잠김을 닫는다.
- **E-7 (engine·ops)** 셀프호스트 설치가 `MOMO_INSTANCE_ID`를 만들어 env에 넣는다(`self_host_env.sh`). D7·R2 서명이 설치 기본값에서 열리는 전제다(F20).
- **U-1 (uxui)** 웹·데스크탑 설정 › 보안: 비밀번호 변경·복구 준비 행·「비밀번호 다시 정하기」(D3·D7). #3048(PK-P4)과 섹션 선점 순서를 맞춘다.
- **U-2 (uxui)** 웹·데스크탑 로그인 폼 「비밀번호를 잊으셨나요?」 안내 + claim 화면 kind별 문구·링크 붙여넣기. **데스크탑(Tauri)에는 호스트 칩이 필요하고 웹 브라우저는 주소창이 대신한다**(D5·D6·D8).
- **U-4 (uxui)** `MemberProfileDialog` 「재설정 링크 만들기」(내 비밀번호 입력 포함)·발급 카드·`canIssuePasswordReset`(D6).
- **U-6 (uxui·phone)** 폰 설정 페이지(#4457)의 비밀번호 변경·다시 정하기(D3·D7).
- **U-7 (uxui·phone)** 폰 로그인 폼 「비밀번호를 잊으셨나요?」·claim 화면(호스트 칩)·QR 스캐너 확장(https claim 링크)(D5·D8). 붙여넣기 칸은 U-5의 기기 연결 링크 칸과 **한 칸으로 합치고** 한 판별 함수(코어, 웹 `entryInput.ts` 모양)가 두 종류(`oort://link`·https claim 링크)를 가른다.
- **U-8 (desktop)** Tauri 전용 서명 명령·네이티브 확인 창(D7).
- **#2812 (OPEN)** 데스크탑 `oort://claim/<token>`에 호스트 확인과 저장된 서버 사용을 요구한다(D8).
- **#4488 (OPEN, ops)** `MOMO_INSTANCE_ID`·서명 요구 플래그 켜기. D7의 켜기 전제 ②~④가 같은 절차다.
- 기기 연결 슬라이스(E-2·U-3·U-5·U-9)는 ADR-0180 증보에 있다.

## 위험과 미검증

- **가용성 [추정].** 지시 키를 가진 기기는 맥 지시 키를 만든 사용자와 그 맥이 승인한 폰뿐이다. 폰은 승인한 맥의 로그인이 살아 있을 때만 서명할 수 있고, 비밀번호를 잊은 때는 로그아웃된 뒤인 경우가 많다. 설치 기본값에는 `MOMO_INSTANCE_ID`가 없어 서명 경로가 닫혀 있고(F20), D7은 스위치로도 닫혀 있다. 그래서 대부분의 멤버는 D7 길이 없고 관리자 경로(D6)만 있다. 완화: 「복구 준비」 행이 키를 만들도록 이끈다(비밀번호를 아는 지금), E-7, 패스키 증명 확장(D7), owner가 원하면 「서명 없는 변형」을 별도 결재로 연다. 지금 서버가 키 등록을 받는지는 [확인 필요]이고 #3138·#3593·#4488이 다룬다.
- **사회공학.** 관리자 경로는 「관리자가 본인임을 확인한다」에 기댄다(D6 문구). 서버는 이를 강제하지 못한다. 알림(D10)이 후속이다.
- **서명이 수명 동안 임의 비밀번호를 허락한다**(D7). 막는 것은 네이티브 확인 창·창 0·5분 수명·1회 nonce·계보 결속이고, 확인 창이 새 비밀번호를 보이지 못하는 구조는 남는다. 강화는 네이티브 입력(D10)이다.
- **관리자 비밀번호가 새면** 재확인(D6)이 막지 못한다. 비밀번호와 세션을 둘 다 가진 쪽은 막을 수 없고, 시도 제한 없는 로그인(D10)이 그 비밀번호를 얻는 길이다. D6의 멤버 단위 한도(분당 5회)는 이 추측을 늦출 뿐이고 계정 축 쓰로틀(E-5)이 닫는다. 대가로 세션을 훔친 쪽이 그 관리자의 발급을 막을 수 있다(다른 owner·admin이 발급한다).
- **본인 변경 뒤에도 대기 링크가 24시간 산다**(D4). 링크가 새어 나간 경우의 대응은 재발급(=취소)이다.
- **잠금 순서 [추정].** D7이 잡는 행과 순서(`human` 행 → sweep → 키·계보 …)가 claim·PATCH·정지·제거와 모두 정합한다는 것은 코드 읽기로만 확인했다(3회차 검토가 `human` 행 순환 하나를 잡았다). E-3은 새 잠금 쌍마다 결정적 간섭 시험(수용 2g·6k″)을 쓰고 독립 보안 검수가 이 순서를 다시 본다.
- **로그인 약점 노출.** D2의 10자 규칙은 새로 정하는 비밀번호만 막는다. 기존 약한 비밀번호와 시도 제한 없는 로그인은 남는다(D10, E-5). 한국어 비밀번호 상한 24자는 NIST 권고와 어긋난다(D2).
- `runtime-unverified`: 네이티브 확인 창 문장·재사용 창 0·Face ID 화면(D7), 전체 종료 뒤 키 재등록 흐름(D4), 72바이트 초과분이 해시에 쓰이지 않는다는 성질(F8, 특성화 시험 한 줄이면 [V]가 된다), 이 ADR의 모든 시험(수용 기준).

## 후속

1. 키 있는 기기의 비율을 본 뒤 「서명 없는 변형」·「호출 계보 유지」(D4)·패스키 증명(D7)·네이티브 입력(D10)을 다시 본다.
2. 메일 발송기가 생기면 D7의 지연 복구와 재설정 알림(D10)을 다시 본다.
3. 로그인 쓰로틀·해시(E-5)가 끝나면 D2의 길이 규칙과 NIST 차단 목록을 한 번 더 본다.

## 증보 1 (2026-10-27, #4625) — join의 기존 계정 처리: 본인 확인 뒤에만 이어 쓴다

- Status: **Accepted** (2026-10-27, owner 승인 — planner가 상태별 규칙을 물어 「승인」). `POST /v1/join`의 공개 오류 어휘(401·409 코드와 429)와 보안 경계(기존 계정을 이어 쓰는 조건)를 바꾸므로 ADR-0100에 따라 이 증보가 구현 PR(#4625)의 머지 조건이었고, 이 승인으로 충족된다. 이 ADR의 D1~D10은 바뀌지 않았다.
- 결재 기록: owner 승인 2026-10-27(planner가 상태별 규칙을 물어 「승인」). planner가 전한 질문 요지는 넷이다: `active`는 그 계정의 비밀번호가 있어야 이어 쓴다 · `invited`는 막는다 · `deleted`는 일반 초대로 되살리지 않는다 · 「돌아온 사람」 흐름은 #4627로 분리한다. 시도 제한의 수치와 키(J5: 계정당 창마다 5회)는 그 요지에 없고, 미션의 「로그인과 같은 시도 제한」 틀 안에서 워커가 제안한 값이다. 조정은 이 증보를 고쳐서 한다.
- 근거: #4593(E-1) 독립 보안 검수의 범위 밖 메모 O-1의 후속이다. 공개 저장소라 재현 절차는 쓰지 않는다. 상태별 규칙은 planner가 정했다(#4625 미션).
- 관계: D2(join은 비밀번호를 정하는 경로 넷 중 하나) · F9·D10·E-5(로그인 시도 제한 없음, #4597) · [ADR-0128](0128-membership-permission-lifecycle.md) D3(추방=`deleted`, 재합류를 막는 차단) · ADR-0100.
- 왜 이 ADR인가: 후보였던 0121(배포·온보딩 배경)·0166(claim 토큰)·0186(에이전트 초대 링크)·0128은 join의 기존 계정 처리를 정하지 않는다. 0128 D3은 join의 차단 검사만 말한다. join이 비밀번호를 다루는 경로라는 사실(D2)과 로그인 시도 제한의 부재(F9)를 이미 적은 곳이 이 ADR이라 여기에 두고, 0128 D3에는 결과 한 줄만 상호 참조로 더한다.

### J1. 원칙

초대 코드는 워크스페이스와 역할을 가리키고 **사람을 가리키지 않는다.** 그래서 이미 계정이 있는 이메일로 온 `POST /v1/join`은 그 계정을 이어 쓰기 전에 본인 확인을 거친다. 확인 없이는 세션을 발급하지 않고, 계정을 되살리지 않고, 비밀번호·이름·시간대를 쓰지 않는다.

### J2. 상태별 규칙

| 이메일에 있는 계정 | 응답 | 남는 일 |
|---|---|---|
| 없음 | 201 새 계정 (그대로) | 새 계정·웰컴 킥오프 (그대로) |
| `active` | 요청의 비밀번호가 그 계정 것이면 200 `createdMember:false`, 아니면 401 `invalid_credentials` | 맞을 때만 세션·사용 1회·`invite.join` 감사·워크스페이스와 공개 채널 멤버십. 비밀번호·이름·시간대는 쓰지 않는다 |
| `suspended` | 403 `human is not eligible to join` (기존 규칙 그대로, 비밀번호 비교 없이) | 없음 |
| `invited` | 409 `join_email_unavailable` | 없음 |
| `deleted` | 409 `join_email_unavailable` | 없음. 일반 초대 코드와 새 비밀번호로 되살리지 않는다 |
| 위에 없는 상태 | 409 `join_email_unavailable` | 없음(실패 닫힘) |

새 사람 가입과 그 밖의 거절 규칙(초대 상태, 차단, 중복 사용, 역할 상승, 핸들 충돌, 공개 채널 없음)은 그대로다. 모든 거절은 트랜잭션을 되돌린다. 세션·사용 횟수·상환 기록·감사 행·계정 변경이 하나도 남지 않는다. 거절은 새 감사 행을 만들지 않는다(로그인의 실패와 같다).

### J3. 본인 확인과 순서

- **판정은 로그인과 같다.** SQL 술어는 `momo_password_verify(보낸 값, human.password_hash)`로, 로그인(`momo_messaging::verify_password_login`)이 부르는 함수 그대로다. `momo-settings`는 `momo-messaging`에 의존할 수 없어(반대 방향 의존) 술어를 다시 적었고, 적합 시험이 두 문의 판정을 같게 고정한다. 저장된 비밀번호가 없는 계정·빈 문자열·bcrypt가 아닌 값은 어느 문에서도 맞지 않는다. **문서화된 차이 하나**: `suspended`는 join이 비교 전에 403을 내고, 로그인은 비교한 뒤 맞으면 403·틀리면 401이다.
- **순서.** 초대 자체의 상태와 차단이 먼저, 그다음 이 관문, 그다음 이미 쓴 코드·역할 상승 검사다. 뒤의 두 검사는 계정에 관한 답이라 계정을 가졌음을 보인 사람에게만 한다. 앞의 순서(초대 상태·차단 → 관문)가 뒤집히면 이미 죽은 초대 링크 하나로 계정 유무와 상태가 새므로 시험이 고정한다.
- **비교는 `active` 계정에만 한다.** 다른 상태는 비교 없이 위 표대로 끝난다.
- **예산 → 비교의 순서는 타입이 고정한다.** 비교 함수는 예산에서 쓴 증표(`guess::Permit`)를 받아야만 돌고 증표는 모듈 밖에서 만들 수 없다. 「비교하고 나서 센다」는 컴파일되지 않는다(결과가 같아 결과만 보는 시험은 못 잡는 순서라서 구조로 막았다). 시험은 비용 14 해시의 비교 시간으로 「예산이 찬 요청은 비교를 하지 않는다」를 따로 확인한다.
- **멤버십 변경과 줄을 선다.** join 트랜잭션의 첫 문장이 워크스페이스의 멤버십 잠금을 공유 모드로 잡는다(`try_share_membership_state`, 기다리지 않는 형태로 증보 2 K5가 바꿨다). 정지·복권·추방·자진 탈퇴·역할 변경이 각자의 첫 문장으로 배타 모드로 잡는 바로 그 잠금(`lock_membership_mutation`)이다. join은 워크스페이스를 어떤 변경의 앞 또는 뒤로만 본다. 변경이 먼저면 join이 새 상태를 읽어 거절하고, join이 먼저면 변경이 기다렸다가 자기 일을 한다: 추방·탈퇴는 join이 쓴 행과 세션까지 지우고, 정지는 세션을 폐기하고, 강등은 역할을 바꾼다. 잠금이 없을 때는 추방이 관문과 역할 상승 검사 사이에 끼면 검사가 「역할 없음」을 보고 지나가 추방된 멤버에게 초대의 역할이 되살아났다. 공유 모드인 것은 join끼리 서로 기다리지 않게 하려는 것이다.
- **세션은 같은 트랜잭션 안에서 기록한다.** 라우트가 토큰 쌍을 만들어 join과 같은 연결로 기록한다(`mint_and_record_session_in_tx`). 변경이 join 뒤에 줄을 서므로 그 변경의 세션 폐기가 이 쌍을 포함한다. 쌍을 커밋 뒤에 별도 트랜잭션으로 만들면 그 사이에 도착한 변경의 폐기를 비껴갈 수 있다. 기록이 실패하면 join 전체가 되돌아가서 멤버나 사용 횟수가 남지 않는다. 시험은 상환·감사·세션 행의 트랜잭션 id(`xmin`)가 한 값임을 직접 단정한다.

### J4. 오류 어휘

- 401 `invalid_credentials`: 문장은 로그인의 것(`invalid credentials`)이다. 로그인의 401에는 아직 `error.code`가 없다. 로그인에 같은 코드를 다는 일은 이 증보 밖이다(E-5).
- 409 `join_email_unavailable`: 문장은 `email is unavailable for this invite`다.
- 429: 문장 `rate limit exceeded`, `Retry-After` 포함, 코드 없음(다른 한도와 같다).
- `docs/api/openapi.yaml`의 join 응답과 `ErrorResponse.code` 목록이 이 어휘를 적는다.

### J5. 시도 제한: 로그인과 「같은 한도」는 아직 만들 수 없다

로그인에는 시도 제한이 없다(F9). 이 증보는 (a) 로그인과 같은 **판정**을 쓰고 (b) join 문의 **비교에 계정 축 예산**을 새로 건다. 로그인의 동작은 바꾸지 않는다.

- **키**: 워크스페이스와 **저장된** 이메일(`pwguess:{workspace}:{email}`). 초대 코드·접속 주소·멤버 id가 아니다. 코드나 `X-Forwarded-For`를 바꿔도 새 예산이 생기지 않는다(문 앞의 per-IP 한도는 그 헤더를 그대로 믿으므로 추측 방어가 아니다). 이메일은 로그인도 비교 전에 아는 계정 손잡이라, E-5가 같은 키를 로그인에 걸면 **한 계정에 한 예산**이 된다. 키를 만드는 함수는 하나(`rate_limit::password_guess_key`)다.
- **값**: 창(기본 60초)마다 5회, `RATE_LIMIT_PASSWORD_GUESS_PER_ACCOUNT`. **끄는 값이 없다.** 0과 숫자가 아닌 값은 기본값이다(D6의 규칙과 같다). 창은 다른 한도와 공유하는 `RATE_LIMIT_WINDOW_SECONDS`다. 창을 1초로 줄이면 이 예산도 초당 5회가 된다(그 노브가 모든 한도를 함께 움직인다). 상한을 따로 두지 않았다.
- **세는 때**: 비교 **직전**에 쓰고, 맞는 비밀번호도 센다. 판정은 원자적이라 병렬 추측 여럿이 모두 「아직 안 찼다」를 보고 통과할 수 없다. 예산이 찬 요청은 비교(bcrypt)를 하지 않고 429를 낸다. 맞는 비밀번호여도 같다.
- **세지 않는 것**: 계정이 없는 새 가입, `suspended`·`invited`·`deleted`(비교가 없다), 초대·차단 단계에서 끝난 요청.
- **상태**: 프로세스 안이다. 재시작하면 초기화되고 레플리카끼리 공유하지 않아 N개면 N배다(다른 한도와 같은 계약).
- **흔적**: 예산이 찬 첫 요청마다 로그 한 줄(워크스페이스·멤버 id, 이메일은 아님)을 남긴다. 감사 행은 만들지 않는다.

### J6. 왜 상태를 구분해 주지 않나, 그리고 구분되는 것

- `invited`·`deleted`·알 수 없는 상태는 한 코드·한 문장·한 응답이고 어떤 비밀번호가 와도 같다. 거절이 계정의 상태를 말해 주면 초대 코드 하나로 상태 목록을 훑을 수 있다.
- **한계(숨기지 않는다).** 이 문은 새 이메일이면 계정을 만든다. 「만들어졌다」와 「거절됐다」가 이미 어떤 주소가 쓰였는지 알려 주므로 이 증보는 존재를 숨기지 않는다. 구분되는 것은 새 사람(201)·`active`(200 또는 401)·`suspended`(403)·이어 쓸 수 없는 상태(409)다. 문장과 코드로 더 구분해 주지 않는 것이 이 증보의 몫이다. `suspended`의 403은 기존 규칙을 그대로 둔 것이고, 로그인처럼 비교 뒤로 옮기는 일은 E-5가 로그인과 맞출 때 같이 본다.

### J7. `deleted`·`invited`의 결과와 후속

- `deleted`를 되살리는 길은 이 문에서 닫혔고 **관리자 복원 경로는 지금 없다** [V]. `reinstate`는 `suspended → active`만 받는다(`StatusTransition::Reinstate`). 추방(`remove`)과 자진 탈퇴(`DELETE …/members/me`)는 상태만 `deleted`로 바꾸고 채널과 워크스페이스 역할을 지운다(`terminate_workspace_membership_in_tx`). 그래서 차단 없이 나간 사람도 새 초대로 돌아올 수 없다. 「돌아온 사람」 흐름은 owner가 정한다. 후속 #4627.
- `invited`는 **상태를 만드는 코드 경로가 없다** [V]. 열거형 값만 있고 `member`에 `invited`를 쓰는 곳은 서버 크레이트 전수 grep에서 0건이다. 개인 claim 링크는 `owner_bootstrap`·`password_reset` 두 종류이고 둘 다 `active` 멤버만 대상이다(`consume_claim_in_tx`의 마지막 조회, `issue_password_reset_in_tx`의 상태 검사). 그래서 `invited`의 정식 경로는 지금 없다. #4627이 같이 본다.
- ADR-0128 D3의 「차단은 invite redeem·join 시 재합류를 막는다」는 그대로다. 이 증보로 `deleted` 계정의 재합류는 기본 동작에서도 닫혔고, 차단은 새 이메일·핸들까지 막는 도구로 남는다.

### 기각 대안

| 대안 | 기각 이유 |
|---|---|
| 기존 이메일은 모두 409 「이미 가입했어요, 로그인하세요」 | 맞는 비밀번호를 가진 기존 멤버가 새 초대를 받는 정상 경로를 막고, 이메일이 가입돼 있다는 사실을 증명 없이 알려 준다 |
| 초대가 그 이메일에 묶였을 때만 허용 | 초대에 이메일 칸이 없다. 초대 발급 화면과 DB가 바뀌는 새 설계이고 이 증보의 범위 밖이다 |
| 확인을 라우트에서 하고 도메인은 그대로 | `redeem_invite_in_tx`는 공개 함수라 다른 호출자가 확인 없이 같은 효과를 낸다. 도메인이 판정하고 라우트는 번역만 한다 |
| 실패만 세는 한도(비교 뒤에 센다) | 병렬 요청이 「아직 안 찼다」를 동시에 보고 모두 비교한다 |
| 한도 키에 초대 코드나 접속 주소를 넣는다 | 코드·주소를 바꿔 새 예산을 얻는다 |
| 이 증보에서 로그인 한도와 한 예산으로 합치기 | 로그인에 잠금 동작을 더하는 일이고 D10·E-5가 먼저 정한다 |
| 관문 읽기에 잠금을 걸지 않는다 | 읽은 뒤 커밋 전에 끼어든 정지·추방을 join이 모르고 끝까지 가서 추방된 멤버에게 초대의 역할이 되살아난다 |
| 멤버 행에 `FOR SHARE`를 건다 | 추방·정지는 멤버 행을 먼저 잡아 안전하지만 자진 탈퇴는 멤버십 행을 먼저 지우고 멤버 행을 나중에 잡아서 join과 교착한다(독립 검수 r2, 40P01). `FOR KEY SHARE`는 교착은 없애도 자진 탈퇴와 줄 서지 않아 행이 되살아난다. 모든 변경이 첫 문장으로 잡는 워크스페이스 멤버십 잠금을 공유 모드로 쓰면 행 잠금 순서에 기대지 않는다 |
| 세션을 커밋 뒤에 별도 트랜잭션에서 만든다 | 위 「세션은 같은 트랜잭션 안에서 기록한다」: 몇 ms 사이에 도착한 정지·추방의 폐기를 비껴갈 수 있다 |

### 수용 기준 (red proof)

시험은 `server-rust/bins/momo-server/tests/join_conformance_pg.rs` 7절과 단위 시험에 있다. 모두 격리 PG(또는 DB 없음)에서 돈다.

1. `existing_account_requires_proof`: 소유자·관리자·멤버 각각, 틀린 비밀번호(주소 철자 둘)는 401 `invalid_credentials`이고 세션·계정 변경·사용 횟수·상환·감사가 하나도 늘지 않는다. 맞는 비밀번호는 200이고 계정(해시·이름·시간대·상태·역할)이 그대로이며 세션이 그 계정의 권한으로 동작한다.
2. `existing_account_states_other_than_active_are_refused`: `invited`·`deleted`는 어떤 비밀번호에도 같은 409 응답이고 아무것도 바뀌지 않는다. `suspended`는 기존 403이다.
3. `wrong_guesses_are_budgeted_per_account`: 예산 3에서 다른 코드·다른 주소로 세 번 추측하면 네 번째는 맞는 비밀번호여도 429와 `Retry-After`다. 다른 계정과 새 가입은 영향이 없다. 병렬 열두 개는 정확히 3개가 비교되고 9개가 429다.
4. `join_judges_a_password_the_way_login_does`: 저장 비밀번호 네 모양과 비밀번호 철자 네 개에서 두 문의 판정이 같다. 비밀번호 없는 계정에 비밀번호가 생기지 않는다.
5. `an_existing_account_is_not_discussed_before_the_proof`: 이미 쓴 코드·역할 상승은 틀린 비밀번호에 401, 맞는 비밀번호에 기존 409·403이다.
6. `the_guess_budget_is_spent_once_per_comparison_and_before_it`: 예산은 `active` 계정에만, 비교마다 한 번, 저장된 이메일로, 비교 전에 쓴다.
7. `the_invite_and_the_ban_are_judged_before_the_account`: 회수·만료·소진·모르는 초대와 차단은 계정 유무·상태와 무관하게 같은 답이다(계정 4상태 × 죽은 초대 4종, 차단된 계정 대 차단된 새 주소). 죽은 초대를 차단된 주소에 쓰면 초대의 답이 난다(초대 상태가 차단보다 먼저).
8. `a_spent_budget_runs_no_comparison`: 비용 14 해시의 계정에서 예산이 찬 요청은 비교 시간의 5분의 1 안에 429로 끝난다(같은 실행 안에서 잰 둘을 견준다).
9. `a_membership_change_that_meets_a_join_waits_for_it_and_has_the_last_word`: join을 관문 바로 뒤에서 세워 두고(상환 원장 테이블 잠금) 추방(멤버 링크·관리자 링크)·정지·자진 탈퇴·강등을 겹친다. join이 멤버십 잠금을 **공유**로 쥐고 변경이 **배타로 기다리는 것**을 `pg_locks`로 단정하고(기다리지 않고 끝나 버리면 실패), join은 혼자일 때처럼 답하며(200, 관리자 링크는 403), 변경이 마지막 말이다: 추방·탈퇴는 역할·채널·살아 있는 토큰이 0(join이 만든 쌍 포함), 정지는 토큰 0, 강등은 역할 guest.
10. `a_joins_rows_and_session_are_written_by_one_transaction`: 기존 계정 이어 쓰기와 새 계정 가입에서 상환·감사·세션 두 행의 `xmin`이 한 값이다(변경 시험은 경쟁에 기대지만 이 시험은 원인을 단정한다).
11. 단위: 거절표 15행, `error.code`는 두 거절에만 붙는다, 키 모양, 0은 기본값이다, 환경 변수 이름.

사보타주 결과는 PR 본문 표가 정본이다.

### 위험과 미검증

- **새 비밀번호 규칙과 겹친다.** `POST /v1/join`의 `password` 한 칸은 새 계정에서는 「정하는 비밀번호」(D2 규칙), 기존 계정에서는 「증명」이다. D2의 10자·72바이트 규칙(E-1)은 모양 검사 단계에서 먼저 적용되므로 그 규칙에 못 미치는 옛 비밀번호의 주인은 이 문으로 이어 쓸 수 없고 로그인으로 들어가야 한다. 단계 순서를 바꾸면 초대 존재 오라클(E-1 검수 L-1)과 부딪히므로 이 증보가 열지 않는다.
- **예산 소진.** 초대 코드를 가진 사람이 한 계정의 이 문 예산을 소진시켜 그 계정이 새 초대를 받는 것을 분당 5회 아래로 막을 수 있다. 로그인에는 닿지 않는다(지금). E-5가 로그인과 한 예산으로 합칠 때 이 대가를 다시 정한다.
- **프로세스 로컬 한도**: 레플리카가 N개면 N배다.
- **범위 밖이던 로그인·claim·비밀번호 변경은 증보 2(#4636)가 닫았다.**
- **공유 잠금을 기다리는 join은 풀 연결을 쥐었다.** 증보 2 K5가 기다리지 않는 시도 잠금과 503으로 바꿨다.
- **존재 노출**은 J6대로 남는다.
- `runtime-unverified`: 운영 서버·실기기. 격리 PG와 단위 시험만 돌렸다.

## 증보 2 (2026-10-27, #4636) — 로그인·claim·비밀번호 변경: 세션 발급을 멤버십 잠금 아래 같은 트랜잭션으로

- Status: **Proposed** (2026-10-27). 새 결정은 없다. ADR-0128 D3의 「정지는 즉시 모든 세션을 끝낸다」를 증보 1(J3)이 join에 한 방식 그대로 세션을 만드는 나머지 문(로그인·claim·비밀번호 변경)에 넓힌다. 다만 **공개 응답이 늘어서**(로그인·join의 503과 `Retry-After`, 활성이 아닌 멤버의 claim이 문서화된 404로 답하는 것) ADR-0100에 따라 이 증보의 승인이 구현 PR(#4636)의 머지 조건이다. 이 ADR의 D1~D10과 증보 1의 J1~J7(J3에서 join이 잠금을 기다리는 부분 제외, 아래 K5)은 바뀌지 않았다.
- 근거: 증보 1의 「범위 밖: 로그인·claim·비밀번호 변경」과 #4625 독립 검수의 후속 권고. 공개 저장소라 영향 크기와 재현 절차는 쓰지 않는다.
- 관계: ADR-0128 D3 · 증보 1 J3 · D4(변경·재설정이 끝내는 것) · D10·E-5(로그인 시도 제한, #4597 — 이 증보가 먼저 닫는다) · ADR-0100.

### K1. 원칙

세션을 만드는 문은 둘을 지킨다.

1. 판정(비밀번호·계정 상태·claim 토큰)과 기록(세션 행)을 **같은 트랜잭션**에서 한다.
2. 그 트랜잭션은 **워크스페이스 멤버십 잠금 아래**에서 돈다. 잠금은 트랜잭션의 첫 잠금이고, 계정에 관한 읽기는 그 뒤에 한다(claim의 잠금 앞 거절은 거절만 하는 읽기라 예외다, K5).

그러면 계정 상태가 바뀌는 순간(정지·추방·탈퇴·비밀번호 변경·재설정)과 겹친 요청도 바뀐 상태를 따른다. 세션을 기록하는 함수는 `mint_and_record_session_in_tx` 하나이고 자기 트랜잭션을 여는 변형은 없앴다.

### K2. 문별 규칙

| 문 | 멤버십 잠금 | 한 트랜잭션에서 하는 일 |
|---|---|---|
| `POST /v1/auth/login` | 공유, **기다리지 않는다** | 비밀번호 확인 · 상태 판정 · 세션 기록 |
| `POST /v1/join` (증보 1) | 공유, **기다리지 않는다** (증보 1은 기다렸다, K5) | 증보 1 그대로 |
| `POST /v1/claim` (`owner_bootstrap`·`password_reset`) | 배타 (그 앞에서 잠금 없는 거절, K5) | claim 소비 · (재설정이면) 그 멤버의 다른 세션 폐기 · 감사 · 세션 기록 |
| `PATCH …/members/me/password` | 배타 | 멤버 상태 확인 · 현재 비밀번호 확인 · 새 해시 · 세션 폐기 · 감사 · 세션 기록 |
| `POST …/members/{member}/password-reset` (관리자 재발급, D6) | 배타 | 열린 링크 소비 · 새 링크 · 감사. 세션은 만들지 않는다. K7 |

### K3. 쓰는 문은 배타로 잡는다

로그인과 join은 계정을 읽고 세션을 쓴다. claim과 비밀번호 변경은 **자격 증명을 쓰고 그 멤버의 다른 세션을 모두 끝낸다.** 공유 잠금끼리는 서로 줄을 서지 않으므로, 쓰는 문이 공유로 잡으면 같은 순간 만들어지던 로그인·join의 쌍이 그 폐기를 비껴간다. 쓰는 문이 배타로 잡으면 진행 중인 발급은 폐기의 앞이나 뒤로만 선다: 앞이면 그 쌍도 같이 폐기되고, 뒤면 새 비밀번호를 읽는다. 정지·추방·탈퇴가 이미 잡는 바로 그 잠금이다(`lock_membership_mutation`). 한 핸들러는 한 모드만 쓴다: claim은 두 종류 모두 배타다. `owner_bootstrap`은 폐기할 세션이 없지만 워크스페이스마다 한 번뿐인 문이라 배타의 비용이 없고, 종류에 따라 모드를 가르면 모드가 토큰을 읽은 결과에 달리게 된다.

### K4. 비밀번호 변경은 잠금 안에서 멤버 상태를 다시 읽는다

미들웨어는 요청이 들어올 때 토큰을 본다. 그 뒤 잠금을 기다리는 동안 정지·추방이 커밋될 수 있어서, 변경은 잠금을 잡은 뒤 **첫 쓰기 전에** 멤버가 활성인지 다시 읽고 아니면 403으로 거절한다. claim은 잠금을 잡은 뒤 쓰기 전에 같은 읽기(`claim_refusal_in_tx`)를 한 번 더 해서, 기다리는 사이 정지된 멤버나 먼저 쓰인 링크를 문서화된 말로 거절한다(아무것도 쓰지 않고 토큰도 쓰이지 않는다).

### K5. 누구나 두드릴 수 있는 문은 잠금을 기다리지 않는다

로그인과 join은 인증 없이 닿는다. 공유 잠금을 **기다리면** 기다리는 동안 풀 연결 하나를 쥐므로, 배타 잠금이 길어지는 순간(큰 멤버의 정지·추방, 이 증보로 배타를 잡게 된 claim·비밀번호 변경의 세션 폐기) 기다리는 호출자가 연결 풀을 채워 무관한 요청까지 늦어진다. 그래서 두 문은 기다리지 않는 시도 잠금(`try_share_membership_state`)을 쓴다. 잠금을 얻지 못하면(배타 보유자가 있거나 배타 대기자가 줄에 서 있으면) **503과 `Retry-After: 1`**로 답하고, 아무것도 읽거나 쓰지 않았다. 증보 1 J3의 「join은 워크스페이스를 어떤 변경의 앞 또는 뒤로만 본다」는 그대로다. 달라지는 것은 변경이 **아직 끝나지 않았을 때** join이 기다렸다가 새 상태를 읽는 대신 503으로 답한다는 점이다(끝난 변경은 전과 같이 새 상태를 읽어 거절한다. join이 먼저면 변경이 기다리는 것도 그대로다).

배타를 잡는 문(claim·비밀번호 변경)은 **기다린다.** 시도 잠금으로 바꾸면 로그인 폭주가 공유 보유자를 끊임없이 두어 이 문들이 계속 거절된다. 대신 기다림이 길어질 수 없게 두 가지를 둔다. 비밀번호 변경은 인증된 멤버의 요청이고 멤버당·주소당 한도가 있다. claim은 **잠금 없이 거절할 수 있는 토큰**(없는 토큰, 이미 쓴 토큰, 만료된 토큰, 비밀번호가 이미 있는 계정의 최초 설정 토큰, 활성이 아닌 멤버의 토큰)을 배타 잠금 앞에서 거절한다(응답은 소비가 내던 것과 같고, 활성이 아닌 멤버의 토큰만 위험 절의 404다). 이 거절은 잠금 없이 읽어도 안전하다: 살아 있다고 읽힌 토큰은 잠금 안에서 다시 읽고, 죽었다고 읽힌 토큰은 거절하는 쪽이라 틀려도 안전한 방향이다.

### K6. 응답 어휘

- 로그인·join: 잠금이 잡혀 있으면 503, 문장 `the server is busy; retry shortly`, `Retry-After: 1`, 코드 없음. 다른 응답은 그대로다.
- claim·비밀번호 변경: 응답 모양이 그대로다. 비밀번호 변경이 잠금 안에서 비활성 멤버를 만나면 403 `member is not active`(활성 멤버가 아니라는 기존 403의 한 경우)다.
- 클라이언트: 5xx를 「다시 시도」로 보여 주는 기존 처리(`signInFailureCopy`·`joinFailureCopy`)가 그대로 맞는다. 코드 변경이 필요 없다.

### K7. 잠금 순서

로그인·claim·비밀번호 변경·관리자 재발급은 모두 「멤버십 잠금 → (claim 행 →) 멤버·`human` 행 → 멤버 단위 sweep 잠금 → `token` 행」 순서다. 멤버십 잠금은 항상 첫 잠금이라 이 잠금을 기다리는 트랜잭션은 아직 다른 잠금을 쥐고 있지 않고, 그래서 사이클이 이 잠금을 지나 닫히지 않는다. 정지·복권·추방·탈퇴·역할 변경도 같은 잠금을 첫 문장으로 잡으므로, **배타로 잡는 트랜잭션끼리, 그리고 배타와 공유 사이는 이 잠금이 직렬화한다**(공유끼리는 서로 기다리지 않는다). 로그인과 join은 이 잠금을 기다리지 않고 잡는다(K5).

**이 순서에 들지 않는 것**: `audit_log`나 `token`에 쓰는 INSERT의 외래 키가 거는 멤버 행의 공유 잠금(KEY SHARE)이다. 멤버십 잠금을 첫 문장으로 잡지 않는 두 트랜잭션이 행을 반대 순서로 잡으면 이 때문에 서로 기다린다. 관리자 재발급이 그랬다: 멤버 행을 잠근 뒤 그 멤버의 열린 링크를 잠그는데, 그 링크를 쓰는 claim은 링크를 쥔 채 멤버 행이 필요했고(감사 행), 정지는 운영자 행을 쥔 채 멤버 행으로 갔다. 재발급이 멤버십 잠금을 첫 문장으로 잡아 닫았고, 시험이 세 만남을 결정적으로 세운다. 멤버십 잠금을 잡지 않는 다른 경로와의 행 잠금 순환은 이 증보가 닫지 않는다. claim의 잠금 앞 거절(K5)은 읽기뿐이라 이 순서에 들지 않는다.

### 기각 대안

| 대안 | 기각 이유 |
|---|---|
| 쓰는 문(claim·비밀번호 변경)도 공유로 잡는다 | 공유끼리는 줄을 서지 않아 같은 순간 만들어지던 로그인·join의 쌍을 폐기가 못 쓸어 담는다(K3) |
| 로그인도 배타로 잡는다 | 로그인끼리 줄을 서고 처리량이 떨어진다. 공유로도 폐기와의 순서는 같다 |
| 세션을 커밋 뒤에 별도 트랜잭션에서 만든다 | 그 사이에 도착한 정지·추방·변경의 폐기를 비껴갈 수 있다(증보 1 J3와 같다) |
| 기다리되 `lock_timeout`으로 끊는다 | 기다림의 상한만 자르고 풀 연결을 쥐는 것은 그대로다. 시도 잠금은 쥐지 않는다 |
| 멤버 단위 잠금(멤버 행 `FOR SHARE`·sweep 잠금)으로 발급과 폐기를 맞춘다 | 정지·추방·탈퇴와의 순서는 워크스페이스 잠금이어야 맞고(자진 탈퇴는 멤버 행을 나중에 잡아 교착한다, 증보 1), 한 문에 잠금이 둘이면 순서 문서가 늘어난다 |
| claim을 시도 배타 잠금 + 503으로 한다 | 로그인 폭주가 공유 보유자를 계속 두어 정당한 재설정이 막힌다(K5) |

### 수용 기준 (red proof)

시험은 `server-rust/bins/momo-server/tests/session_issue_conformance_pg.rs`에 있다(Security pack `auth`). 모두 격리 PG에서 돈다.

1. 문(로그인·join·비밀번호 변경·재설정 claim·최초 claim)을 세션 기록 직전에 세워 두고 변경(정지·추방·탈퇴·비밀번호 변경·재설정)을 보낸다. 문이 멤버십 잠금을 해당 모드로 **쥐고 있는 것**과 변경이 **그 잠금에 줄 서 있는 것**을 `pg_locks`로 단정하고(기다리지 않고 끝나면 실패), 문은 혼자일 때처럼 답하며, 변경이 마지막 말이다: 문이 만든 쌍은 폐기되고(그 토큰으로 읽으면 401), 쓸어 담는 변경 뒤에는 변경 자신의 새 쌍만 남는다. 열여섯 장면.
2. 대조: 변경 없이 세웠다 놓은 문은 모두 동작하는 세션을 낸다(다섯 문).
3. 잠금은 계정에 관한 첫 읽기 앞이다: 로그인·claim·비밀번호 변경을 그 읽기에서 세워 두고 이미 잠금을 쥐고 있음을 단정한다.
4. 잠금 안의 상태 확인: 정지나 추방이 커밋되는 동안 잠금을 기다린 비밀번호 변경은 403이고 아무것도 쓰지 않으며(비밀번호·세션·감사), 같은 상황의 재설정 claim은 404 `claim token is invalid`로 거절되고 토큰이 쓰이지 않는다.
5. 기다리지 않는다: 변경이 열려 있는 동안 로그인은 503 + `Retry-After`로 즉시 답하고 아무것도 쓰지 않으며, 로그인과 join의 폭주 속에서도 무관한 요청이 정상으로 끝나고 거절된 join은 계정도 사용 횟수도 남기지 않는다. 변경이 커밋된 뒤 같은 요청은 새 상태를 따른다. 잠금에 줄 선 변경을 새 로그인이 앞지르지 않는다(진행 중 로그인 뒤에 정지가 서 있으면 다른 로그인은 503).
6. 잠금 없이 거절되는 claim 토큰(쓴 것·만료·비밀번호가 있는 계정의 최초 설정 토큰·활성이 아닌 멤버의 것)은 배타 잠금이 잡혀 있어도 기다리지 않고 기존과 같은 응답을 받는다. 아직 쓸 수 있는 토큰은 줄을 선다.
7. 한 트랜잭션: claim 행·비밀번호·감사 행·폐기된 이전 세션·새 세션 두 행의 `xmin`이 한 값이다(비밀번호 변경은 `human` 행·감사 행·폐기·새 세션). 경쟁 시험은 타이밍에 기대지만 이 시험은 원인을 단정한다.
8. 관리자 재발급: 멤버 행을 잠글 때 이미 멤버십 잠금을 배타로 쥐고 있다(`pg_locks`). 링크를 쓰는 claim과 만나도, 정지와 만나도 서로 기다리지 않고 둘 다 답한다(재발급이 잠금에 줄 서는 것을 단정하고, 풀면 claim 200·재발급 201, 정지 200·재발급 201).

사보타주 결과는 PR 본문 표가 정본이다.

### 위험과 미검증

- **기다리지 않는 문은 정상 변경과 겹쳐도 503이 날 수 있다.** 변경은 ms 단위라 드물고 클라이언트가 다시 시도하면 된다. 배타 잠금을 쥐는 시간은 비밀번호 비교(해시 비용)와 그 멤버의 살아 있는 세션 수에 비례한다.
- **비밀번호 확인이 잠금 안에 있어** 비교 시간이 보유 시간에 든다. 앱이 만드는 해시는 비용이 낮고, 다른 시스템에서 들여온 높은 비용의 해시는 그만큼 길다.
- **claim의 거절 응답**은 기존 그대로이고 한 가지만 다르다: 활성이 아닌 멤버의 토큰은 이제 문서화된 404 `claim token is invalid`로 답한다(상태는 404 그대로, 전에는 소비가 끝에서 실패하며 다른 문구가 나갔다). 잠금 앞의 읽기와 잠금 안의 읽기가 둘 다 이 답을 낸다.
- **이 증보가 닫는 문은 위 표의 문들(과 증보 1의 join)이다.** 세션을 만드는 그 밖의 문에 같은 점검을 하는 일은 별도 후속이다.
- `runtime-unverified`: 운영 서버·실기기·멀티 레플리카. 격리 PG와 단위 시험만 돌렸다. 잠금은 PG 인스턴스 안의 것이라 레플리카가 여럿이어도 같은 DB를 보는 한 유효하다.
