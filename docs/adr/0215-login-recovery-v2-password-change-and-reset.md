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

- Status: **Accepted** (2026-10-27, owner 승인 — planner가 「#4636·#4617 승인」을 물어 「재개 및 승」). 새 결정은 없다. ADR-0128 D3의 「정지는 즉시 모든 세션을 끝낸다」를 증보 1(J3)이 join에 한 방식 그대로 세션을 만드는 나머지 문(로그인·claim·비밀번호 변경)에 넓힌다. 다만 **공개 응답이 늘어서**(로그인·join의 503과 `Retry-After`, 활성이 아닌 멤버의 claim이 문서화된 404로 답하는 것) ADR-0100에 따라 이 증보의 승인이 구현 PR(#4636)의 머지 조건이었고, 이 승인으로 충족된다. 이 ADR의 D1~D10과 증보 1의 J1~J7(J3에서 join이 잠금을 기다리는 부분 제외, 아래 K5)은 바뀌지 않았다.
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

배타를 잡는 문(claim·비밀번호 변경)은 **기다린다.** 시도 잠금으로 바꾸면 로그인 폭주가 공유 보유자를 끊임없이 두어 이 문들이 계속 거절된다. 대신 기다림이 길어질 수 없게 두 가지를 둔다. 비밀번호 변경은 인증된 멤버의 요청이고 멤버당·주소당 한도가 있다. claim은 **잠금 없이 거절할 수 있는 토큰**(없는 토큰, 이미 쓴 토큰, 만료된 토큰, 비밀번호가 이미 있는 계정의 최초 설정 토큰, 활성이 아닌 멤버의 토큰)을 배타 잠금 앞에서 거절한다(응답은 소비가 내던 것과 같고, 활성이 아닌 멤버의 토큰만 위험 절의 404다). 이 거절은 잠금 없이 읽어도 안전하다: 살아 있다고 읽힌 토큰은 잠금 안에서 다시 읽고, 죽었다고 읽힌 토큰은 거절하는 쪽이라 틀려도 안전한 방향이다. 같은 원칙으로, 이 잠금을 쥐는 변경 요청(정지·복권·추방·역할 변경·채널 역할 변경, 관리자 재발급)은 권한이 없는 호출자를 **잠금 앞에서 잠금 없는 읽기로** 거절한다. 거절될 요청이 잠금을 쥐면 안 되기 때문이다. 정본 판정(계급, 마지막 owner, 이미 그 상태인지)은 이전처럼 잠금 안에서 같은 함수로 다시 한다.

### K6. 응답 어휘

- 로그인·join: 잠금이 잡혀 있으면 503, 문장 `the server is busy; retry shortly`, `Retry-After: 1`, 코드 없음. 다른 응답은 그대로다.
- claim·비밀번호 변경: 응답 모양이 그대로다. 비밀번호 변경이 잠금 안에서 비활성 멤버를 만나면 403 `member is not active`(활성 멤버가 아니라는 기존 403의 한 경우)다.
- 클라이언트: 5xx를 「다시 시도」로 보여 주는 기존 처리(`signInFailureCopy`·`joinFailureCopy`)가 그대로 맞는다. 코드 변경이 필요 없다.

### K7. 잠금 순서

로그인·claim·비밀번호 변경·관리자 재발급은 모두 「멤버십 잠금 → (claim 행 →) 멤버·`human` 행 → 멤버 단위 sweep 잠금 → `token` 행」 순서다. 멤버십 잠금은 항상 첫 잠금이라 이 잠금을 기다리는 트랜잭션은 아직 다른 잠금을 쥐고 있지 않고, 그래서 사이클이 이 잠금을 지나 닫히지 않는다. 정지·복권·추방·탈퇴·역할 변경도 같은 잠금을 첫 문장으로 잡으므로, **배타로 잡는 트랜잭션끼리, 그리고 배타와 공유 사이는 이 잠금이 직렬화한다**(공유끼리는 서로 기다리지 않는다). 로그인과 join은 이 잠금을 기다리지 않고 잡는다(K5).

**이 순서에 들지 않는 것**: `audit_log`나 `token`에 쓰는 INSERT의 외래 키가 거는 멤버 행의 공유 잠금(KEY SHARE)이다. 멤버십 잠금을 첫 문장으로 잡지 않는 두 트랜잭션이 행을 반대 순서로 잡으면 이 때문에 서로 기다린다. 관리자 재발급이 그랬다: 멤버 행을 잠근 뒤 그 멤버의 열린 링크를 잠그는데, 그 링크를 쓰는 claim은 링크를 쥔 채 멤버 행이 필요했고(감사 행), 정지는 운영자 행을 쥔 채 멤버 행으로 갔다. 재발급이 멤버십 잠금을 첫 문장으로 잡아 닫았고, 시험이 세 만남을 결정적으로 세운다. 멤버십 잠금을 잡지 않는 다른 경로와의 행 잠금 순환은 이 증보가 닫지 않는다. claim의 잠금 앞 거절과 변경 요청의 잠금 앞 권한 거절(K5)은 읽기뿐이라 이 순서에 들지 않는다.

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
8. 관리자 재발급: 멤버 행을 잠글 때 이미 멤버십 잠금을 배타로 쥐고 있다(`pg_locks`). 링크를 쓰는 claim과 만나도, 정지와 만나도 서로 기다리지 않고 둘 다 답한다(재발급이 잠금에 줄 서는 것을 단정하고, 풀면 claim 200·재발급 201, 정지 200·재발급 201). 운영자가 아닌 멤버의 재발급은 잠금이 잡혀 있어도 기다리지 않고 403이다.
9. 권한 없는 변경 요청: 정지·복권·추방·역할 변경·채널 역할 변경을 일반 멤버와 게스트가 보내면 잠금이 잡혀 있어도 기다리지 않고 기존과 같은 답(403 또는 404)을 받는다. 그런 요청이 계속 와도 같은 워크스페이스의 로그인·join은 503이 되지 않는다.

사보타주 결과는 PR 본문 표가 정본이다.

### 위험과 미검증

- **기다리지 않는 문은 정상 변경과 겹쳐도 503이 날 수 있다.** 잠금에 닿는 것은 권한이 있는 호출자의 변경뿐이고(권한 없는 요청은 잠금 앞에서 거절된다, K5) 변경은 ms 단위라 드물며 클라이언트가 다시 시도하면 된다. 배타 잠금을 쥐는 시간은 비밀번호 비교(해시 비용)와 그 멤버의 살아 있는 세션 수에 비례한다.
- **비밀번호 확인이 잠금 안에 있어** 비교 시간이 보유 시간에 든다. 앱이 만드는 해시는 비용이 낮고, 다른 시스템에서 들여온 높은 비용의 해시는 그만큼 길다.
- **claim의 거절 응답**은 기존 그대로이고 한 가지만 다르다: 활성이 아닌 멤버의 토큰은 이제 문서화된 404 `claim token is invalid`로 답한다(상태는 404 그대로, 전에는 소비가 끝에서 실패하며 다른 문구가 나갔다). 잠금 앞의 읽기와 잠금 안의 읽기가 둘 다 이 답을 낸다.
- **이 증보가 닫는 문은 위 표의 문들(과 증보 1의 join)이다.** 세션을 만드는 그 밖의 문에 같은 점검을 하는 일은 별도 후속이다.
- `runtime-unverified`: 운영 서버·실기기·멀티 레플리카. 격리 PG와 단위 시험만 돌렸다. 잠금은 PG 인스턴스 안의 것이라 레플리카가 여럿이어도 같은 DB를 보는 한 유효하다.

## 증보 3 (2026-11-05, #5228) — 비밀번호 복구 코드: 혼자 다시 정하는 일회용 코드

- Status: **Proposed** (2026-11-05, 수리판). 독립 보안 검수 1회차는 FAIL(Blocker 0·High 1·Medium 3·Low 6·Info 5)이었고 이 판은 그 지적을 반영한 수리판이다. 수리한 부분(L6의 소각 규칙과 Q4, L5·L7의 토큰 폐기와 멤버 단위 상한, 수용 기준 보강, Low 반영)을 검수자가 다시 확인해야 하고 owner 결정은 아직이다. **로그인 전에 부르는 새 공개 엔드포인트를 만들고 새 테넌트 테이블·새 EXECUTE 전용 definer 함수를 더하므로** ADR-0100에 따라 이 증보의 Accepted가 구현 PR의 머지 조건이다. 코드·migration은 이 증보에 없다.
- 기안: Sonnet 5.5 설계 워커 (#5228). 이전 증보와 달리 D1을 **바꾼다**: Accepted되면 D1의 「새 공개(비인증) 엔드포인트는 0개다」에 「증보 3이 1개를 더한다(복구 코드 사용, L5)」 역방향 줄을 단다. 그때까지 D1~D10과 증보 1·2는 그대로다.
- 근거 결정: owner 2026-11-03 요청(#5228). 요지는 비밀번호를 잊었을 때 관리자에게 요청하는 길 말고, **복구 코드로 혼자 되돌리는 길**도 있으면 좋겠다는 것이다. 관리자 요청 쪽은 D6·U-4(#4596·#4603)가 이미 닫았다. 복구 코드는 ADR-0215에 없던 새 계정 복구 경계라서 이 증보가 먼저다.
- 관계: D1(범위) · D4(변경·재설정이 끝내는 것 — 코드가 따르는 소각 규칙) · D5(안내 화면 — 항목 하나를 더한다) · D6(관리자 재발급 — 재확인 모양을 빌린다) · D7(기기 서명 재설정) · D9(감사) · D10·E-5(시도 제한 — **한 묶음에서 일부 이탈**, L8) · 증보 1 J5(계정 축 예산) · 증보 2 K1~K7(세션을 만드는 문은 멤버십 잠금 아래 한 트랜잭션) · ADR-0166(claim 토큰) · ADR-0195 D-8(복구 순서에 한 칸) · ADR-0185(제로베이스 온보딩, 가입 직후 화면) · ADR-0214(보안 주장은 시험이 없으면 공개하지 않는다) · ADR-0100.
- 표기: [V] 코드·문서·1차 출처를 이번에 직접 열어 확인(웹 문서는 가져오기 도구가 돌려준 짧은 원문 인용이고 전문 대조는 하지 않았다) · [S] 검색 요약으로만 확인 · [추정] 해석 · **[권장]** 설계 워커가 정한 결정 · `runtime-unverified` 실행해 보지 않음. 이 증보는 문서만 바꾸고 어떤 시험도 새로 돌리지 않았다. 코드 사실은 track/engine 선두(2026-11-05)를 읽어 얻었다.
- 용어: **복구 코드**는 이 증보의 일회용 비밀이다. **공개 경로**는 로그인 전에 부르는 `POST /v1/auth/password-recovery`(L5)다. **소각**은 코드를 죽은 행으로 만드는 것이다.

### 이슈의 「정할 것」과 답

| 정할 것 | 답 | 절 |
|---|---|---|
| 코드 수와 형식 | **멤버당 한 개**. 24자 Crockford base32(0-9와 I·L·O·U를 뺀 영문 대문자), 4자씩 6묶음, CSPRNG 120비트. 한 번만 보여 준다 | L2 |
| 해시 보관 | `sha256`만 새 테넌트 테이블에 둔다(소금·후추 없음 — 120비트라 필요 없다). 평문·일부 문자·끝 글자도 두지 않는다. 코드→워크스페이스 조회는 078과 같은 EXECUTE 전용 definer 함수 | L3 |
| 한 번 쓰면 폐기 | 쓰는 문장이 `consumed_at`을 찍는 원자적 단일 사용 관문. 복구에 성공하면 같은 응답에 **새 코드를 한 번** 싣는다(NIST §4.2.1.1) | L5·L6 |
| 재설정 때 다른 세션 | **모두 끝낸다**. 호출이 둘이다: ① `revoke_member_session_tokens`(세션 토큰·개발자 토큰·대기 중인 개발자 로그인 코드) ② `end_member_sessions_in_tx`(푸시·기기 키·예약 메시지 보류·대기 중인 관리자 링크·코드 소각, D4). ②는 토큰을 폐기하지 않으므로 새 경로가 ①을 직접 부른다 | L5·L7 |
| 시도 제한(E-5 한 묶음) | 공개 경로는 계정을 모르므로 **계정 축 예산이 닿지 않는다**. 120비트 코드 공간이 추측 방어이고, IP 예산 하나는 예의 한도이며, 코드가 확인된 뒤에만 쓰는 **멤버 단위 상한**이 배타 잠금의 반복을 막는다. 만들기의 비밀번호 재확인은 E-5 계정 축 묶음에 넣는다 | L8 |
| D6·D7과의 우선순위 | 화면 순서는 쉬운 순(코드 → 로그인된 기기 → 관리자), 보안 강도는 D7 ≥ D6 > 코드. **어느 재설정이든 성공하면 코드가 소각**되고, 본인 비밀번호 변경도 코드를 소각한다(대기 중인 관리자 링크는 건드리지 않는다) [Q4 추천] | L6·L9 |
| 코드를 다시 만들 때 본인 확인 | **현재 비밀번호 필수**(D6 재확인 모양). 바꾸면 이전 코드는 즉시 무효. 코드를 다시 볼 수는 없고 바꾸기만 있다 | L4 |
| 감사 | 새 행 넷: `member.recovery_code.created`·`.revoked`·`.refused`, `member.password_reset.recovery_code`. 공개 경로의 실패는 계정에 귀속되지 않아 행 없이 WARN 한 줄 | L10 |

### 업계 조사

조사는 2026-11-05에 웹으로 했다. 「영향」 칸이 이 증보의 결정 번호다.

| 대상 | 확인한 사실 | 영향 | 출처 | 표기 |
|---|---|---|---|---|
| GitHub (2단계 인증 복구 코드) | 코드 목록은 16개(「If you've used all 16 recovery codes, you can generate another list」). 한 번 쓰면 재사용 불가. 새 목록을 만들면 이전 코드 전부 무효. 비밀번호 관리자 저장을 권한다. **복구 코드를 비밀번호 재설정에 쓸 수 있는지, 보기·재생성에 재인증이 필요한지는 이 페이지에 없다**(못 찾음) | L2·L4 | https://docs.github.com/en/authentication/securing-your-account-with-two-factor-authentication-2fa/configuring-two-factor-authentication-recovery-methods | [V] |
| Google (백업 코드) | 「a new set of 10 backup codes」, 8자리, 한 번 쓰면 비활성, 새 세트를 만들면 이전 세트가 자동으로 비활성. 여권 같은 곳에 보관·인쇄를 권한다. 2단계 인증이 켜져 있을 때의 수단이다 | L2·L4 | https://support.google.com/accounts/answer/1187538 | [V] |
| Slack (백업 코드) | 「each code can only be used once」. 코드가 없으면 Workspace Owner·Admin이 2단계 인증을 꺼 줄 수 있다. **코드 개수·재생성 절차·재생성 때 이전 코드 처리는 공식 페이지에서 못 찾았다** | L9(관리자 경로가 마지막 방어) | https://slack.com/help/articles/204509068 | [V] |
| Microsoft 계정 (복구 코드) | 「25-digit code」, 비밀번호를 잊거나 계정이 도용됐을 때 되찾는 용도. 새로 만들면 이전 코드는 즉시 무효. **기존 코드를 다시 가져오거나 내려받을 수 없다.** 대소문자 구분 없고 공백·하이픈이 필요 없다. 로그인에 쓰는 기기에 두지 말라고 한다 | L2·L4 | https://support.microsoft.com/en-us/accounts-billing/manage/how-to-get-a-microsoft-account-recovery-code | [V] |
| Apple 계정 (복구 키) | 「a 28-character code」. 신뢰하는 전화번호·Apple 기기와 **함께** 쓴다. 잃고 다른 수단도 없으면 「locked out … permanently」. 교체 방법은 있으나 **이전 키가 무효가 되는지는 이 페이지에 없다**(못 찾음) | L2 | https://support.apple.com/en-us/109345 | [V] |
| 1Password (복구 코드) | 개인·가족 계정만(팀·비즈니스 불가). 코드는 **재사용 가능**하고 쓴 뒤에도 유효하다. 만든 직후 1시간은 쓰지 말라 하고 최근 로그인 뒤 시도하면 24시간 못 쓴다. 쓸 때 계정 이메일로 본인 확인을 한다. 교체하면 이전 코드 무효. **코드 형식·길이는 못 찾음** | L6·기각 대안 | https://support.1password.com/recovery-codes/ | [V] |
| Bitwarden (2단계 로그인 복구 코드) | 쓰면 새 코드가 생성된다. 보기는 마스터 비밀번호 입력이 필요하다. 「changing your master password does not impact the recovery code」. 마스터 비밀번호 재설정 용도는 페이지에 없다(이 코드는 2단계 인증 복구용이라 비밀번호 변경과 독립인 것이 자연스럽고, 비밀번호 자체를 대신하는 oort 코드가 같은 규칙을 따를 근거는 아니다, L6). **길이는 못 찾음** | L4·L5·L6 | https://bitwarden.com/help/two-step-recovery-code/ | [V] |
| Discord (백업 코드) | 공식 도움말이 403으로 열리지 않았다. **조사하지 못했다** | — | — | 못 찾음 |
| NIST SP 800-63B-4 | §4.2.1.1 저장 복구 코드: 승인된 난수 발생기에서 **64비트 이상**(「at least 64 bits」), 계정에 해시로 보관, 시도는 §3.2.2 제한, 쓴 뒤에는 무효화하고 **새 코드를 발급**(「SHALL」), 교체 발급도 복구 알림을 낳는다. §4.2.3: 복구는 **알림**을 보낸다(「SHALL」). §3.1.2.2 룩업 비밀: 최소 보안 강도(**112비트**) 미만이면 소금+해시, 시도 제한. 복구 뒤 세션 처리는 §4.2에 없다 | L2·L3·L5·L8·위험 | https://pages.nist.gov/800-63-4/sp800-63b/events/ , https://pages.nist.gov/800-63-4/sp800-63b/authenticators/ | [V] |
| OWASP Passkey Security Cheat Sheet | 복구 코드는 「authentication secrets」로 보호하고 단일 사용으로 하고 사용자가 재생성하게 한다. 복구 시도에 속도 제한·알림, 복구 뒤 세션 교체와 알림 | L4·L7·L8 | https://cheatsheetseries.owasp.org/cheatsheets/Passkey_Security_Cheat_Sheet.html | [V] |

**관례를 둘로 나눠 읽는다.** GitHub 16개·Google 10개·Slack은 **2단계 인증 우회 코드**다. 비밀번호를 아는 상태에서 쓰는 두 번째 요소이므로 여러 개·짧게 나눠 주는 것이 합리적이다. Microsoft 25자·Apple 28자·1Password·Bitwarden은 **계정 복구 등급**의 코드이고 한 개다. oort 코드는 **비밀번호를 대신해 계정을 넘겨주는** 코드라 뒤쪽이다. 이것이 「왜 10개가 아니라 한 개인가」의 답이다(L2). 못 찾은 것(Discord, Slack 재생성, Apple 이전 키 무효, GitHub 재인증·비밀번호 재설정 용도, 1Password·Bitwarden 코드 길이)은 위 표에 그대로 적었고 이 결정의 근거로 쓰지 않았다.

### L1. 범위와 경계

- 이 증보가 정하는 것: 복구 코드의 모양(L2)·보관(L3)·만들기(L4)·쓰기(L5)·폐기와 소각(L6)·세션 처리(L7)·시도 제한(L8)·다른 복구 길과의 우선순위(L9)·감사(L10)·사용자 흐름(L11)·위협(L12).
- **새 공개(비인증) 엔드포인트가 1개 생긴다**: `POST /v1/auth/password-recovery`(L5). D1의 「0개」를 깨는 첫 예외라서 owner 질문 Q1로 올린다. 코드를 만들고 상태를 보는 문(L4)은 인증된 경로이고 공개가 아니다.
- **서버 스위치 `MOMO_PASSWORD_RECOVERY_CODE`(기본 꺼짐)**가 켜져 있을 때만 세 경로(만들기·바꾸기 겸용 POST, 상태 GET, 공개 쓰기)가 열린다. 꺼져 있으면 모두 404다. 「구현 머지 ≠ 켜기」(D7과 같은 규율).
  - **값 해석**: 기존 기본 꺼짐 스위치와 같이 `trim() == "true"`일 때만 켜진다(`MOMO_HUMAN_CONTROL_SIGNATURE_REQUIRED`·`MOMO_REFRESH_REUSE_SWEEP_ALL_SESSIONS`와 같은 해석, `config.rs`의 `DeviceKeySettings::from_env`). `True`·`1`·`yes`·빈 값·오타는 모두 꺼짐이다. 오타에도 닫히는 쪽이 안전한 방향이다.
  - **꺼짐 응답은 추출기 앞에서 나온다**: 공개 경로가 claim처럼 `Json<T>` 추출기를 쓰면 꺼짐 상태에서도 잘못된 `Content-Type`·깨진 본문이 핸들러 전에 415·422로 거절되어 「라우트가 없다」와 달라진다. 스위치 확인을 `route_layer`로 추출기 앞에 두거나 본문을 직접 읽는다(D6의 `Bytes` 선례).
  - 켜는 조건: ① 독립 보안 검수 Blocker 0·High 0 ② owner 승인(운영 값 변경 전 판단, #4488과 같은 절차) ③ 격리 스택에서 만들기 → 복구 → 이전 세션·개발자 토큰 거절 → 새 코드까지의 e2e 증거(O-1). `MOMO_INSTANCE_ID`는 필요 없다(서명이 없다).
- 메일·알림·워크스페이스별 정책(관리자가 끄는 스위치)은 이 증보가 만들지 않는다(후속).
- 이 증보의 코드는 **비밀번호가 있는 사람 멤버**만 갖는다. 에이전트 멤버, 비밀번호가 없는 계정(D3의 409)은 코드를 만들 수 없다.

### L2. 코드의 모양 [권장]

- **한 개**: 멤버당 live 코드는 최대 하나다(L3의 부분 유일 인덱스). 세트(8~10개)는 만들지 않는다. 위 관례 구분 때문이다: 세트는 2단계 인증 우회 코드의 모양이고, 비밀번호를 대신하는 코드에서 세트는 유출 표면만 열 배로 키운다. 한 개를 쓰면 복구가 끝나면서 새 한 개가 나오므로(L5) 「남은 개수」를 셀 일도 없다. owner 질문 Q3.
- **길이·알파벳**: 24자, Crockford base32(`0-9`와 `A-Z`에서 `I`·`L`·`O`·`U`를 뺀 32자). 한 글자가 5비트라 **120비트**다. 서버가 CSPRNG(`getrandom`, claim 토큰과 같은 방식) 15바이트를 받아 5비트씩 24개로 자른다. 15바이트(120비트)를 그대로 5비트씩 자르므로 나머지(모듈로) 연산이 없고 편향이 없다. 엔트로피를 못 얻으면 500이고 다른 난수로 대신하지 않는다.
  - 120비트를 고른 이유: 복구 코드 규정(§4.2.1.1)의 하한은 64비트이고 소금 기준이 없다. 가장 가까운 기준은 룩업 비밀이다: §3.1.2.2는 최소 보안 강도(112비트) **미만**의 룩업 비밀에 소금+해시와 시도 제한을 요구한다 [V]. 그 기준을 빌려 120비트로 잡으면 **소금 없는 SHA-256**을 쓸 수 있고, 소금이 없어야 코드만으로 행을 찾는 조회(L3)가 된다. 비밀번호를 대신하는 일회용이라는 쓰임에도 64비트는 낮다. 80비트(16자)는 입력은 쉽지만 이 기준 아래라서 소금과 계정 단위 제한을 끌고 와 L5의 구조를 깬다.
  - 입력 부담: 24자는 길다(Apple 28자·Microsoft 25자리와 같은 부류). 종이에서 치는 일은 드물고 대부분 비밀번호 관리자에서 붙여 넣는다. 4자 묶음과 자동 대문자·하이픈이 오타를 줄인다.
- **표시 형태**: 대문자, 4자씩 6묶음, 하이픈으로 잇는다. 예시용 자리 표시: `ABCD-EFGH-JKMN-PQRS-TVWX-YZ01`.
- **정규형**(서버가 해시하고 비교하는 값): 하이픈을 뺀 24자 대문자. 입력 정규화는 Microsoft 선례처럼 관대하게 한다: 공백·하이픈류(`-`·`‐`·`‑`·`–`·`—`)를 지우고, 소문자를 대문자로, `O`→`0`, `I`·`L`→`1`로 바꾼다. 그 뒤 24자가 아니거나 알파벳 밖 문자가 있으면 **모양 불일치**다. 모양 불일치는 DB를 부르지 않고 400 `recovery_code_malformed`로 끝난다(claim의 malformed 400과 같다). 정규화 표는 Rust·TS가 같은 공유 벡터 파일을 읽는다.
- **한 번만 보여 준다**: 서버는 평문을 만든 응답 한 번에만 내보내고 보관하지 않으므로 **다시 볼 수 없고 바꾸기만 있다**(Microsoft와 같다). 문구에 그대로 쓴다.
- **만료 없음** [권장]: 필요한 순간은 몇 년 뒤일 수 있다(서랍 속 종이). 대신 어떤 재설정이든 소각하고(L6) 설정 행이 만든 날짜를 보인다.
- **코드는 서버만 만든다** [불변식]: 사용자가 고른 문자열을 코드로 받는 경로·필드·가져오기는 만들지 않는다. L8의 「계정 축 없이도 안전하다」는 코드가 서버가 만든 균일한 120비트라는 전제에 기댄다. 나중에 「내가 고른 코드」가 생기면 그 논거가 깨지므로 그때는 이 증보를 다시 연다. 만들기 요청 본문은 `currentPassword` 하나뿐이다(수용 3i).

### L3. 보관 [권장]

- **해시만**: `code_hash` = 정규형의 SHA-256(32바이트, 078·081의 claim 토큰과 같은 알고리즘). 평문·평문의 일부(끝 4자 같은 힌트)·코드에서 파생한 다른 값을 열로 두지 않는다. 힌트를 두면 120비트 중 그만큼이 평문 열에 남는다. 해시를 어디서 하나는 구현이 고른다. **[권장]** 앱(Rust)에서 SHA-256을 계산해 32바이트만 definer와 조회·소비 SQL에 넘긴다(workspace에 이미 `sha2`가 있어 `momo-auth`가 `sha2.workspace = true`를 더하면 되고 새 외부 의존이 아니다). 그러면 평문 코드가 DB 서버의 바인드 매개변수·문장 로그·`auto_explain`에 닿지 않는다. 078·081식(평문을 매개변수로 넘기고 DB 안 `digest`)을 택해도 비밀번호가 이미 같은 방식으로 DB에 닿으므로 새 신뢰 영역은 아니지만, 코드는 24시간 토큰과 달리 오래 산다. 선택에 따라 definer 인자 종류(`bytea`/`text`)와 수용 2a의 범위가 따라간다.
- **새 테넌트 테이블** `member_recovery_code`(이름은 구현이 확정): 워크스페이스·멤버(복합 FK)·`code_hash`(32바이트 CHECK)·`created_at`·`consumed_at`·`revoked_at`·`revoked_reason`(열거). RLS FORCE·`ws_isolation`·`momo_app`만 권한.
  - `code_hash` **전역 유일**(조회 색인 겸용). 코드 한 개의 평문이 두 행에 닿을 수 없다.
  - **멤버당 live 한 행**: `WHERE consumed_at IS NULL AND revoked_at IS NULL`인 부분 유일 인덱스. 한 행은 소비됐거나 소각됐거나 둘 다 아니다(둘 다는 CHECK로 막는다).
  - **죽은 행은 멤버당 가장 최근 한 개만** 남긴다. 만들거나 바꿀 때 같은 트랜잭션에서 더 오래된 죽은 행을 지운다. 이유: 죽은 행이 「이미 쓴 코드」·「바뀐 코드」 안내(L5)를 가능하게 하는데, 세션을 가진 쪽이 분당 5번 바꿔(L4) 행을 무한히 늘리지 못하게 한다.
- **코드→워크스페이스 조회**: `momo_join_private.recovery_code_workspace_id(…)`(이름과 인자 종류는 구현이 확정: 앱 해시면 `bytea`, DB 해시면 `text`). 078의 `owner_claim_workspace_id`와 같은 모양이다: `SECURITY DEFINER`·`STRICT`·`search_path = pg_catalog`, 호출자가 정규형 코드만 쥐고 있어 테넌트 GUC를 못 정하는 닭-달걀 때문이다. **uuid 하나만** 돌려주고 테넌트 행을 돌려주지 않는다. 쓴 행·소각된 행도 찾는다(L5가 「이미 썼다」·「바뀌었다」를 409로 답하려면 죽은 행을 알아봐야 한다). EXECUTE는 `momo_app`만이고 `momo_relay`·`momo_worker`·`momo_platform_admin`·`momo_notifier`는 078처럼 명시적으로 뺀다. 삭제된 워크스페이스는 돌려주지 않는다. **R-1은 `momo-db` 시험의 카탈로그 두 목록을 갱신한다**: `APP_EXECUTABLE_DEFINERS`(`crates/momo-db/tests/common/mod.rs`, 정확한 서명)와 `PG_CATALOG_ONLY_DEFINERS`(같은 파일, `md5(prosrc)` 고정)에 새 함수를 더하고, 「새 definer를 `momo_app`에 주는 것은 테넌트 경계 결정」이라는 그 주석에 맞춰 근거를 PR에 적는다. 다른 역할(relay·worker·platform_admin·notifier)이 실행하지 못한다는 음성 시험은 claim 선례 `only_momo_app_can_execute_the_locked_claim_lookup`(`claim_conformance_pg.rs`)을 따른다.
- **해시 조회가 타이밍 오라클이 아닌 이유**: 공격자는 입력을 고르지만 색인이 보는 것은 SHA-256 출력이다. 입력을 한 글자 바꾸면 출력 전체가 바뀌므로 색인 탐색 시간의 차이로 다음 글자를 좁힐 수 없다. 세션 토큰·claim 토큰이 해시로 조회되는 것과 같은 논거다.
- **오프라인 추측**: DB가 통째로 새도 120비트는 SHA-256 반복으로 풀리지 않는다(초당 10^11번을 하는 장비로도 2^120번은 10^17년 규모) [추정].

### L4. 만들기·바꾸기·상태 (로그인한 상태) [권장]

- 라우트: `POST /v1/workspaces/{ws}/members/me/recovery-code`(만들기·바꾸기 겸용)와 `GET …/members/me/recovery-code`(상태). 스위치가 꺼져 있으면 404이고 클라이언트는 설정 행을 숨긴다. 사람 멤버만(`require_human`). **개발자 토큰과 에이전트 bearer는 부르지 못한다**: 에이전트는 `require_human`에서 거절되고, 개발자 토큰이 닿는 REST는 닫힌 표 `required_dev_scope` 하나뿐이며 표에 없으면 403 `dev_route_not_allowed`다(ADR-0216 D4: `require_human`은 개발자 토큰에 방벽이 아니고 그 표가 유일한 방벽이다). 구현은 이 두 경로를 그 표에 넣지 않는다(수용 3j).
- **현재 비밀번호를 다시 받는다**(D6 재확인 모양). 본문 `{ currentPassword }`(`normalized_current_password`: 옛 규칙의 짧은 비밀번호도 된다)를 **필수**로 한다. 없거나 비면 400 `current_password_required`, 틀리면 403 `current_password_incorrect`, 비밀번호가 없는 계정은 409(D3과 같은 안내). 본문 없음·필드 누락은 axum 기본(415·422)이 아니라 핸들러가 400으로 판정한다.
  - 위협: 세션 하나를 훔친 쪽이 코드를 만들어 영구 뒷문을 얻는 것(L12 T4). 세션만으로는 모자라야 한다. 선례: D6 재확인, ADR-0195 D-8, Bitwarden의 코드 보기(마스터 비밀번호 입력).
  - 순서는 D6과 같다: 속도 제한 → 비밀번호 확인(잠금 없이) → 멤버십 잠금(**배타**) → 잠금 안에서 멤버가 활성인지 다시 읽기(증보 2 K4) → 쓰기. 거절될 요청이 멤버십 잠금을 쥐지 않는다(증보 2 K5). 배타로 잡는 이유는 D6 재발급과 같다: 정지·제거와 겹쳐도 정지 뒤에 새 live 코드가 남아 복권 때 되살아나지 않게 한다(L6).
- **속도**: 멤버 단위 기본 5회 / 60초, 노브 `RATE_LIMIT_RECOVERY_CODE_ISSUE_PER_MEMBER`. 맞는 비밀번호도 센다. 0·파싱 불가는 끄는 값이 아니라 기본값이다. 계보를 키에 넣지 않는다(D6과 같은 이유). **이 재확인은 비밀번호 추측 오라클이므로 E-5의 계정 축 묶음에 넣는다**(L8).
- **바꾸기는 즉시 교체**다: 이전 live 코드를 `revoked`(사유 `replaced`)로 만들고 새 행을 넣는 것이 **한 트랜잭션**이다. 업계 관례와 같다(Google·Microsoft·1Password·GitHub). 이전 코드를 보여 달라는 요구는 두지 않는다(분실이 주된 사유다).
- **응답**: 201 `{ code, createdAt, replaced }`에 `Cache-Control: no-store`. 평문은 이 응답에만 있다. 상태 GET은 `{ exists, createdAt }`만 돌려주고 해시·글자·마지막 사용 같은 것은 없다.
- **비밀번호가 새로 정해진 뒤에는 코드를 새로 만들어야 한다**: 관리자 링크(claim)·기기 서명(D7)·본인 변경(PATCH)은 코드를 소각하므로(L6) 클라이언트는 방금 정한 비밀번호를 **메모리에만** 들고 있다가 바로 이 경로를 불러 새 코드를 제안한다(L11 E). 비밀번호를 저장하지 않는다. 코드 사용으로 복구한 경우는 응답에 새 코드가 실려 오므로 제외한다(L5).
- 알림은 없다(L12 T4, 위험 절).

### L5. 쓰기 (로그인 전) — 새 공개 경로 [권장]

한 줄: **코드와 새 비밀번호를 한 번에 보내면, 코드가 맞을 때만 비밀번호를 정하고 새 세션과 새 코드를 돌려준다.**

`POST /v1/auth/password-recovery`, 본문 `{ code, newPassword }`. 인증 헤더 없음. 이메일·워크스페이스·계정을 받지 않는다(코드가 워크스페이스와 멤버를 정한다). 이유는 L8·기각 대안에 있다: 계정 열거와 계정 잠금 DoS가 구조적으로 없어진다.

**순서**(각 단계는 다음 단계가 안전한 이유다):
0. 스위치(L1: `trim() == "true"`일 때만 켜짐)가 꺼져 있으면 404. **오류 코드가 없는 404**여서 「라우트가 없다」와 같고, 아래 3·4단계의 `recovery_code_invalid` 404(오류 코드가 있다)와 클라이언트가 구별한다. 이 판정은 **본문 추출기 앞**에서 나와서(L1) 꺼짐 상태에서는 잘못된 `Content-Type`·깨진 본문도 같은 404다.
1. 요청 본문 상한을 건다(작게, 4 KiB 안팎. 코드 24자와 새 비밀번호 72바이트만 들어오므로 axum 기본 2 MiB가 필요 없다. 초과는 413). 그리고 IP 예의 한도를 쓴다(모든 요청, 맞는 코드도 센다. L8).
2. 본문을 읽는다: 모양 불일치 → 400 `recovery_code_malformed`(DB 없음). 새 비밀번호 규칙(D2의 `normalized_new_password`) 위반 → 400 `password_too_short`·`password_too_long`·`password_invalid_char`. **둘 다 코드를 소비하기 전이다**: 오타로 코드를 태우지 않는다.
3. definer 함수로 워크스페이스를 찾는다. 없으면 404 `recovery_code_invalid`.
4. 테넌트 트랜잭션에서 **멤버십 잠금 없이** 읽는다(claim의 `claim_refusal_in_tx` 모양): 활성이 아닌 멤버·삭제된 워크스페이스 → 404 `recovery_code_invalid`(없는 코드와 **같은 본문**). 쓴 코드 → 409 `recovery_code_used`. 소각된 코드(바뀜·재설정·정지 등) → 409 `recovery_code_replaced`. 잠금 없이 거절되는 요청이 공개 경로의 배타 잠금 앞에 줄 서지 않게 한다(증보 2 K5). **판정 순서: 멤버 활성 확인이 죽은 코드 판정보다 앞이다**(정지된 멤버의 소각된 코드는 404이고 복권된 뒤에야 409 `replaced`로 보인다. 수용 4c·4c′). **살아 있고 멤버가 활성으로 읽힌 요청만** 여기서 **멤버 단위 예산**(키는 멤버 id, L8)을 쓴다. 초과는 429와 `Retry-After`이고 소비·잠금·쓰기가 없다.
5. 멤버십 잠금을 **배타**로 잡고(claim과 같다: 쓰는 문, K3) 다시 읽은 뒤, 코드 행을 소비한다: `UPDATE … SET consumed_at = now() WHERE … AND consumed_at IS NULL AND revoked_at IS NULL`이 **단일 사용 관문**이다. 같은 코드를 동시에 두 번 보내면 하나만 행을 얻고 다른 하나는 409 `recovery_code_used`다.
6. 비밀번호 설정 → **`revoke_member_session_tokens`**(세션 토큰·개발자 토큰·대기 중인 개발자 로그인 코드. 안에서 멤버 단위 sweep 잠금을 잡는다) → `end_member_sessions_in_tx(…, PasswordReset)`(푸시·기기 키·예약 메시지 보류·대기 중인 관리자 링크, D4. **이 함수는 토큰을 폐기하지 않는다**, L7) → 같은 호출 안의 코드 소각 규칙(L6)은 이미 소비된 행에 영향이 없다 → **새 코드 발급**(L4와 같은 함수. 소각 호출 **뒤**에 한다. 앞에 두면 방금 만든 행이 소각된다) → 감사 `member.password_reset.recovery_code` → 새 세션 쌍(`mint_and_record_session_in_tx`). 이 전부가 **한 트랜잭션**이다(수용 4a″).
7. 200: `LoginResponse`와 같은 본문에 새 코드 `{ code, createdAt }` 하나를 더한다. `Cache-Control: no-store`.

**잠금 순서**(증보 2 K7 그대로): 멤버십 잠금 → **코드 행** → `human` 행 → 멤버 단위 sweep 잠금 → `token` 행. 멤버십 잠금이 항상 첫 잠금이라 claim·PATCH·정지·제거·탈퇴와 이 잠금에서 직렬화된다. D7(E-3)이 멤버십 잠금을 쓰지 않는 경우(`human` 행 → sweep)는 코드 행 소각이 `FOR UPDATE SKIP LOCKED`라 기다림이 없다. 그 소비가 롤백하는 드문 경우 코드가 남는 틈은 D4의 대기 링크와 같고 같은 이유로 받아들인다. E-3 착륙 시 이 순서를 다시 본다. `SKIP LOCKED`가 건너뛰는 행은 「소비 중」뿐 아니라 「동시에 바뀌는 중인 행(만들기·바꾸기)」일 수도 있다. 정지·제거·탈퇴·claim·본인 변경·공개 사용·만들기는 모두 배타 멤버십 잠금에서 직렬화되어 건너뜀이 일어날 수 없다. 틈은 멤버십 잠금을 쓰지 않는 D7과 겹칠 때뿐이고, D7(E-3)이 쓰기 단계에서 멤버십 잠금을 잡으면 사라진다.

**새 코드를 응답에 싣는 이유** [권장]: NIST §4.2.1.1은 쓴 코드를 무효화하고 **새 코드를 발급**하라고 한다 [V]. 방금 비밀번호를 정한 그 사람이 만들기 경로를 부르는 것과 결과가 같으므로 보안상 더 여는 것이 없고, 클라이언트가 비밀번호를 들고 다음 요청을 하는 단계가 없어진다. 응답이 중간에 끊기면 새 코드를 못 본 채 행만 남는다. 설정 행이 「있음」으로 보이므로 **「새 코드로 바꾸기」가 그 복구**다(문구에 적는다). claim·D7 재설정은 응답 계약을 바꾸지 않는다(소각만 하고 클라이언트가 만들기를 제안한다, L4).

**오류 어휘**: 400 `recovery_code_malformed` / 400 D2 코드 셋 / 404 `recovery_code_invalid`(없음·비활성 멤버·삭제된 워크스페이스, 한 본문) / 404 코드 없음(스위치 꺼짐) / 409 `recovery_code_used` / 409 `recovery_code_replaced` / 413(본문 상한 초과) / 429(`Retry-After`, IP 예의 한도 또는 멤버 단위 상한). 409 둘은 **한 번이라도 유효했던 120비트 코드를 쥔 사람**만 보므로 오라클이 되지 않는다(claim의 `claimKind`와 같은 논거). 로그인 오류처럼 한 버킷으로 합치지 않는 것은 사용자가 「이미 썼다」와 「바뀌었다」를 알아야 다음 행동이 갈리기 때문이다.

**소비 뒤**: 로그인 세션을 그대로 받는다(D6과 같다. 코드를 쥔 사람은 비밀번호를 정하는 순간 이미 로그인할 수 있어 자동 로그인이 더 여는 것이 없다).

### L6. 일회용 폐기와 소각 규칙 [권장]

- 코드는 **두 가지로 죽는다**: 쓰여서(`consumed_at`) 또는 소각돼서(`revoked_at` + 사유 `replaced`·`password_changed`·`password_reset`·`suspended`·`removed`·`left`). 공개 경로는 앞의 것을 409 `recovery_code_used`로, 뒤의 것을 409 `recovery_code_replaced`로 답한다(L5).
- **코드는 비밀번호가 새로 정해지거나 멤버가 빠지는 곳에서 끝난다.** `end_member_sessions_in_tx` 안에서 대기 중인 재설정 링크 소각(`ends_pending_reset_links`) 옆에 **둘째 술어** `ends_recovery_code(cause)`를 둔다. 둘 다 `_` 갈래 없는 `match`라서 새 원인이 생기면 컴파일이 멈추고 각 술어가 자기 쪽을 정하도록 강제한다. 두 술어가 갈라지는 원인은 **정확히 둘**이다: `PasswordChanged`(코드 소각·링크 유지)와 `DeviceUnlinked`(코드 유지·링크 종료). 갈라지는 이유가 아래 표에 있다. 아래는 Q4 추천안 기준이고, 1안을 고르면 바뀌는 줄은 「owner 질문」 아래 한 단락이다.

| 원인 | 코드 | 이유 |
|---|---|---|
| `PasswordReset` (claim 소비·D7·코드 사용) | 소각 | 정상 복구 뒤에 새어 나간 코드가 살아 있으면 계정을 다시 가져간다(D4가 대기 링크에 한 말과 같다) |
| `PasswordChanged` (본인 변경) | **소각** [Q4 추천] | 코드를 만들거나 바꾸는 데도 현재 비밀번호만 있으면 되므로(L4) 비밀번호를 아는 쪽은 변경 없이도 소유자의 코드를 죽이고 자기 코드를 심을 수 있다. 소유자가 비밀번호를 바꾸는 표준 대응이 남이 심은 코드를 함께 지워야 한다. 대기 링크를 끊지 않게 한 D4의 이유(도둑은 링크를 새로 만들 수 없다)가 코드에는 서지 않는다: 도둑도 코드는 만들 수 있다. Bitwarden의 「비밀번호를 바꿔도 코드는 그대로」는 2단계 인증 복구 코드의 규칙이라 비밀번호를 대신하는 코드의 근거가 되지 않는다 |
| `Suspended`·`Removed`·`Left` | 소각 | 정지 뒤 복권으로 옛 코드가 되살아나면 안 된다 |
| `DeviceUnlinked`·`RefreshReuse`와 로그아웃(계보 단위 종료) | **유지** | 세션 하나만 있으면 일으킬 수 있는 일이다(기기 연결 해제는 비밀번호를 묻지 않는다). 코드를 만들려면 현재 비밀번호가 필요한데(L4) 세션만 가진 쪽이 코드를 죽일 수 있다면 그 원칙이 깨진다. 이 원인들은 오늘 멤버 전체 종료 함수에 닿지 않고, 닿게 되더라도 술어는 유지로 둔다. 사유 열거에도 넣지 않는다 |

- 소각은 `end_member_sessions_in_tx` 안에서 같은 트랜잭션으로 한다(세션만큼 사는 것은 호출처마다가 아니라 여기에 더한다는 그 파일의 규칙). `FOR UPDATE SKIP LOCKED`로 쓴다(L5 잠금 순서). 계보 단위 종료(`end_session_lineage_in_tx`)에는 소각을 달지 않는다. **스위치가 꺼져 있어도 소각한다**(데이터 위생). 실제로 소각한 행이 있을 때만 감사 `member.recovery_code.revoked`를 쓴다(L10).
- **남는 위험**: ① 소유자가 비밀번호를 바꾸면 소유자 자신의 종이 코드도 죽어서 새로 만들어야 한다. 변경 성공 화면이 방금 정한 비밀번호로 새 코드를 만들게 이끈다(L11 E). ② 혼자 쓰는 서버(관리자·지시 키 기기 없음, E-6 미착륙)에서 비밀번호만 아는 쪽이 변경만 해도 소유자의 종이 코드가 죽고 소유자에게 남는 길이 없다. 다만 비밀번호를 아는 쪽은 변경 없이도 코드를 바꿔 같은 결과를 낼 수 있어서(L4) 변경 소각이 더하는 것은 「코드를 건드릴 줄 모르는 단순한 쪽」에게도 종이 코드가 죽는다는 점뿐이다. 이 비용을 받아들이고 「남이 심은 코드가 표준 대응 한 번에 사라진다」를 얻는 것이 Q4의 추천이다.

### L7. 재설정 때 다른 세션 [권장 — D4 유지]

- 공개 경로는 호출 세션이 없으므로 「이 기기를 남길지」 문제가 없다. 코드로 복구하면 그 멤버의 **모든** 세션이 끝나고 새 세션 하나만 남는다. 호출은 둘이고 순서가 있다. ① `revoke_member_session_tokens`: 세션 토큰·**개발자 토큰**(ADR-0216 D2: 기본 30일·최대 90일, 로그인 계보 포함)·교환을 기다리는 **개발자 로그인 코드**를 끝낸다. 안에서 멤버 단위 sweep 잠금을 잡고 개발자 행과 세션 행을 id 순으로 잡는다. ② `end_member_sessions_in_tx(PasswordReset)`: 푸시 등록·기기 키·예약 메시지 보류·대기 중인 관리자 링크·코드 소각. **②는 토큰을 폐기하지 않는다**(그 함수의 본문에 토큰 폐기 호출이 없다). claim은 ①을 `consume_claim_in_tx`가, 본인 변경은 `change_own_password_in_tx`가 부르는데 새 경로에는 그 두 함수가 없으므로 **새 경로가 ①을 직접 불러야 한다**. 빠뜨리면 접근·갱신 토큰, 개발자 토큰, 대기 로그인 코드가 복구 뒤에도 남는다(수용 4g′).
- 이유: OWASP는 복구 뒤 세션 교체를 권하고(위 표), NIST §4.2에는 세션 규정이 없다 [V]. 코드가 새어 나갔을 수 있는 복구라서 이전 세션을 남기면 안 된다.
- 결과: 맥 뿌리 키·승인된 폰 키는 다시 만들어야 한다(D4). 성공 화면이 말한다(L11 D).

### L8. 시도 제한 — 이슈의 「E-5와 한 묶음」에서 일부 이탈 [권장]

**이탈 기록**: 이슈는 시도 제한을 E-5(#4597)와 한 묶음으로 정하라고 했다. 공개 경로는 **계정을 모르고 코드만 받으므로** E-5의 계정 축 예산(`pwguess:{workspace}:{email}`)이 걸릴 자리가 없다. 그래서 둘을 가른다.

| 문 | 걸리는 것 | 이유 |
|---|---|---|
| 공개 경로 `POST /v1/auth/password-recovery` | **120비트 코드 공간**이 추측 방어, **IP 예산 하나**는 예의 한도(방어가 아니다, 증보 1 J5와 같은 말), 코드가 확인된 뒤의 **멤버 단위 상한**이 배타 잠금의 반복을 막음 | 계정 단위 상한을 세려면 요청이 계정을 가리켜야 한다. 가리키게 하면(이메일을 함께 받으면) 계정 열거와 잠금 DoS가 생긴다(기각 대안). 멤버 단위 상한은 코드를 맞힌 요청만 쓰므로 이 문제가 없다(아래) |
| 만들기·바꾸기의 비밀번호 재확인(L4) | 멤버 단위 예산(기본 5/60초) + **E-5 계정 축 묶음에 편입** | 이 재확인은 비밀번호 추측 오라클이다. E-5의 범위(로그인·본인 변경·D6 재확인)에 이것을 더한다 |

- **추측 확률** [추정]: 서버에 live 코드가 백만 개 있어도 한 번의 추측이 맞을 확률은 10^6/2^120, 곧 10^-30 규모다. IP 하나가 1년 내내 분당 10번(5×10^6번) 두드려도 어느 계정이든 하나가 맞을 확률은 10^-24 규모다. 이는 NIST §3.2.2의 「계정당 연속 실패 100회 이하」를 **글자 그대로 세지는 않지만**(계정이 없어서 셀 수 없다) 그 규정이 막으려는 것, 곧 한 계정에 100번 추측했을 때의 성공 확률을 10^-34 아래(100/2^120)로 둔다. 어긋남 목록에 올린다(위험 절).
- **IP 예산(예의 한도)**: 노브 `RATE_LIMIT_RECOVERY_CODE_PER_IP`, 기본 10회 / 창(`RATE_LIMIT_WINDOW_SECONDS`). 맞는 코드도 센다. 0·파싱 불가는 끄는 값이 아니라 **기본값**이다. claim의 IP 한도와 **다른 버킷**이다(서로 굶기지 않는다). 첫 `X-Forwarded-For` 홉을 믿는 한계(F10) 때문에 IP 키는 우회될 수 있고, 그래서 이 예산은 추측 방어도 부하 방어도 아니라고 못 박는다. **전역 예산을 새로 만들지 않는다**(D10·E-5 몫이고, 전역 상한은 거절 가능 상태 자체가 서비스 거부 표면이다). 기존 IP 한도 문(`rate_limit.rs`의 `gate_per_ip`)은 한도 0을 「끔」으로 읽고 요청의 주소를 알 수 없으면 통과시킨다. 새 노브는 0을 기본값으로 읽는다고 했으므로 그 미들웨어를 그대로 재사용하지 않고 해석 차이(0·파싱 불가 → 기본값)를 시험한다(수용 6a). 주소를 알 수 없는 요청이 통과하는 것은 기존 문과 같고 예의 한도라는 성격에 맞는다.
- **멤버 단위 상한(코드가 확인된 뒤에만)** [증보 2 K5의 요구]: 코드가 살아 있고 멤버가 활성으로 읽힌 요청만 배타 멤버십 잠금 앞(L5 4단계)에서 멤버 id 키의 예산을 쓴다. 노브 `RATE_LIMIT_RECOVERY_CODE_USE_PER_MEMBER`(기본 5회 / 창, 이름은 구현이 확정), 0·파싱 불가는 기본값이다. 초과는 429와 `Retry-After`이고 소비·잠금·쓰기가 없다. 이유: 공개 경로의 유효한 코드를 든 요청은 잠금 앞 거절을 통과해 배타 잠금에 줄을 서는데, 한도가 위조 가능한 IP 키 하나뿐이면 한 멤버가 「사용 → 새 코드(L5 7단계) → 사용」을 한도 없이 이어 갈 수 있다. 한 번마다 그 워크스페이스의 로그인·join이 503이 되는 구간(증보 2 K5·K6)과 `audit_log`·`token` 행이 생기므로 일반 멤버가 배타 잠금을 한도 없이 반복해서 잡는 첫 경로가 된다. 본인 변경(PATCH)은 멤버당 10회 / 창이다(D3). **L8이 기각한 계정 축 예산의 문제가 없다**: 이 예산은 코드를 맞힌 요청만 쓰고(틀린 코드·없는 코드·쓴 코드·죽은 코드는 닿지 않는다) 그 결과는 그 코드를 쥔 사람에게만 보이므로, 코드를 못 맞힌 쪽은 예산을 쓰거나 관찰하거나 소진시킬 수 없다(잠금 DoS·열거 오라클 없음). 코드를 맞힌 쪽은 어차피 그 계정을 가져갈 수 있는 사람이다.
- **틀린 요청의 비용**: 모양 검사와 새 비밀번호 규칙은 DB 없이, 없는 코드는 색인 한 번이다. bcrypt 같은 비싼 해시는 코드가 맞고 소비가 끝난 뒤의 새 비밀번호 해시 한 번뿐이다. 틀린 요청이 CPU를 태우지 않는다.
- **계정 축이 없는 득실**: 득 — 남의 계정을 겨냥한 틀린 시도로 그 사람의 복구를 막을 수 없다(증보 1 J5의 「예산 소진」 대가가 없다), 응답이 계정의 존재를 알리지 않는다. 실 — 위 NIST 문구와의 글자 어긋남과, 서버 전체 IP 헤더 우회 시 예의 한도가 우회되는 것(배타 잠금 쪽은 멤버 단위 상한이 막는다).
- **E-5와의 선후**: 공개 경로(R-2)는 E-5 없이 낼 수 있다. 검수자나 owner가 E-5 선행을 원하면 슬라이스 표의 선행만 바꾼다. E-5가 해시 방식을 바꾸면(72바이트 해제 등) 코드로 정하는 새 비밀번호도 같은 해시 함수를 지나므로 그대로 따라간다.

### L9. 관리자 재발급(D6)·기기 서명 재설정(D7)과의 우선순위 [권장]

| 길 | 증명하는 것 | 필요한 것 | 켜기 |
|---|---|---|---|
| D7 기기 서명 | 하드웨어 키 + 현장 확인 | 지시 키가 있는 로그인된 맥·폰 | 스위치 기본 꺼짐, 키가 드묾(위험 절) |
| D6 관리자 재발급 | 사람의 본인 확인 + 관리자 비밀번호 재확인 | 다른 owner·admin | 켜짐(E-4 착륙) |
| **복구 코드** | **종이(비밀)를 가졌다는 것** | 만들어 둔 코드 | 스위치 기본 꺼짐 |
| E-6 운영자 명령 | 서버 운영자 | 서버 접근 | 미착륙 |

- **보안 강도 순서는 D7 ≥ D6 > 코드**다. 코드는 소지 증명이라 사람이 본인을 확인하지 않는다.
- **화면 순서는 쉬운 순**이다: ① 복구 코드가 있어요 ② 로그인된 기기가 있다면(D7) ③ 관리자에게 요청(D6) ④ 서버를 직접 운영한다면(E-6이 머지될 때까지 숨김, D5). D7은 스위치가 꺼져 있고 지시 키가 있는 기기가 드물어 대부분의 사용자에게 비활성이다(「가용성」 위험). 코드는 있으면 바로 되므로 1번에 둔다. 보안 순서와 다르다는 것을 숨기지 않는다: 코드 항목 아래에 「없다면 관리자에게 요청하세요」 길을 항상 같이 보인다.
- **경합 규칙**(전부 `end_member_sessions_in_tx`의 한 술어가 한다):
  1. 어느 재설정이든 성공하면 다른 길의 자격이 소각된다: 코드 사용은 대기 중인 관리자 링크를 끝내고(D4 기존), 관리자 링크 소비와 D7은 코드를 소각한다(L6).
  2. 관리자 링크를 **발급**하는 것은 코드를 건드리지 않는다(발급은 재설정이 아니다). **소비**가 끝낸다.
  3. 본인 변경은 대기 중인 관리자 링크를 끝내지 않고(D4) 코드는 소각한다(L6, Q4 추천).
  4. 코드 길은 기기 서명도 관리자도 요구하지 않는다. 그 둘이 없는 상황(혼자 쓰는 셀프호스트의 owner, F18)이 이 길의 존재 이유다. D5 3번 항목(E-6 전까지 숨김)이 비워 둔 자리를 코드가 먼저 닫는다.
  5. 코드는 D6의 「본인 확인은 관리자가 한다」를 **우회한다**. 의도된 것이고 막는 곳은 서버 스위치(운영자)뿐이다. 워크스페이스 관리자가 개별 멤버의 코드를 끄는 정책은 열지 않는다(기각 대안, 후속).
- 이 길의 스위치는 D7의 스위치와 **독립**이다.

### L10. 감사 [권장]

| action | schema | detail | 비고 |
|---|---|---|---|
| `member.recovery_code.created` | `momo.member.recovery_code.created.v1` | `replaced`(참/거짓) | 만들기·바꾸기 |
| `member.recovery_code.revoked` | `momo.member.recovery_code.revoked.v1` | `cause`(`RevocationCause::as_code`) | `end_member_sessions_in_tx`가 **실제로 소각한 행이 있을 때만**. 주체는 대상 멤버 |
| `member.password_reset.recovery_code` | `momo.member.password_reset.recovery_code.v1` | 없음(`{}`) | 공개 경로 성공. claim 재설정(`member.password_reset`)과 같은 모양 |
| `member.recovery_code.refused` | `momo.member.recovery_code.refused.v1` | `via`(`session`), `reason`(`current_password_incorrect`)뿐 | 만들기 재확인 실패. 멤버·윈도당 1행(D9의 `RefusalAuditSlot`) |

- **공개 경로의 실패는 행을 남기지 않는다**: 코드가 맞기 전에는 어느 멤버의 일인지 알 수 없고, 인증 없는 요청이 테넌트 감사 테이블을 채우게 두면 안 된다. 대신 **버스트당 WARN 한 줄**(고정 문구와 사유 코드, IP·코드·본문 없음)을 낸다. WARN의 키는 **라우트 단위 하나**다(IP 키면 위조된 주소마다 줄이 생겨 로그가 불어난다).
- 새 코드·평문·해시·정규형·비밀번호는 감사 detail과 로그에 들어가지 않는다. 증명은 서버 시험이다(수용 9).
- **푸시·아웃박스·실시간 없음** [불변식]: 만들기·바꾸기·사용은 아웃박스 이벤트를 만들지 않고 푸시·실시간(Centrifugo) 발행도 하지 않는다. 코드의 존재와 교체는 어디에도 방송되지 않는다. 후속 N-1의 알림 본문도 코드·해시·끝 글자를 담지 않는다. 수용 9가 아웃박스 행 0과 푸시 0을 단정한다.

### L11. 사용자 흐름과 문구 초안

문구는 초안이다. 실제 사전은 UXUI 슬라이스가 `catalogs/*/recovery.json`의 관련 키 옆에 더하고 7개 언어로 옮긴다(`recovery.code.*` 가칭). 화면에 서버 호스트 외의 이름·이메일을 넣지 않는다.

**A. 가입 직후**(새 계정만: 첫 owner의 claim 직후, 초대로 합류한 새 멤버의 `createdMember: true` 직후). 방금 입력한 비밀번호를 **메모리에만** 들고 있다가 만들기 경로에 보내고 화면을 떠나면 지운다. 메모리에 없으면(앱 재시작) 설정에서 만든다.
- 제목: 「복구 코드를 만들어 둘까요?」
- 본문: 「비밀번호를 잊어도 이 코드로 혼자 다시 정할 수 있어요. 코드는 지금 한 번만 보여 드려요.」
- 보조: 「관리자도, 로그인된 기기도 없을 때 쓰는 마지막 길이에요.」
- 버튼: 「코드 만들기」 / 「나중에 할게요」

**B. 코드 한 번 보기**(A·C·D 공통)
- 제목: 「복구 코드예요」
- 경고: 「이 코드를 아는 사람은 누구나 비밀번호를 바꿀 수 있어요. 비밀번호처럼 조심해서 보관하세요.」
- 안내: 「이 화면을 닫으면 다시 볼 수 없어요. 잃어버리면 새 코드로 바꿀 수 있어요.」
- 보조: 「로그인에 쓰는 기기 말고 비밀번호 관리자나 종이에 적어 두세요.」
- 버튼: 「복사」 · 「파일로 저장」 · 「인쇄」(폰은 「공유·저장」). 체크 「안전한 곳에 적어 두었어요」를 켜야 「완료」가 열린다.
- 저장 파일의 내용: 「oort 복구 코드 · 서버 {host} · {date}에 만들었어요」 한 줄과 코드, 「한 번만 쓸 수 있어요」. **이메일·이름·비밀번호를 담지 않는다.**

**C. 설정 › 보안 › 복구 코드**
- 없음: 「복구 코드가 없어요」 / 「만들어 두면 비밀번호를 잊어도 혼자 다시 정할 수 있어요.」 / 「만들기」
- 있음: 「복구 코드가 있어요」 / 「{date}에 만들었어요. 코드는 다시 볼 수 없어요.」 / 「새 코드로 바꾸기」
- 확인창: (바꾸기일 때) 「새 코드를 만들면 이전 코드는 바로 못 쓰게 돼요.」 + 칸 「현재 비밀번호」 + 「만들기」
- 오류: 403 「비밀번호가 맞지 않아요. 다시 입력하세요.」 · 429 「요청이 너무 잦아요. 잠시 뒤에 다시 시도하세요.」 · 409 「이 계정은 비밀번호가 없어서 복구 코드를 만들 수 없어요.」
- 서버에서 꺼짐(404): 행을 숨긴다(기능이 없는 서버와 구별되지 않는다).

**D. 로그인 화면 「비밀번호를 잊으셨나요?」**(D5 안내 화면의 1번 항목)
- 제목: 「복구 코드가 있어요」 / 안내: 「만들어 둔 복구 코드로 새 비밀번호를 정해요.」 화면을 여닫는 동안 서버 호출은 0건이고 **제출할 때만** 부른다(D5 유지).
- 순서: 서버 호스트 칩 확인(기존 `ClaimHostGate`, D8) → 코드 칸(자리표시 `ABCD-EFGH-JKMN-PQRS-TVWX-YZ01`, 힌트 「영문과 숫자 24자예요. 대소문자와 하이픈은 신경 쓰지 않아도 돼요.」) → 새 비밀번호 + 한 번 더(D2 규칙 힌트) → 「비밀번호 다시 정하기」
- 오류: malformed 「코드는 영문과 숫자 24자예요. 다시 확인하세요.」 · invalid 「이 코드는 쓸 수 없어요. 코드를 다시 확인하거나 다른 방법으로 요청하세요.」 · used 「이 코드는 이미 썼어요. 비밀번호를 이미 정했다면 로그인하세요.」 · replaced 「이 코드는 새 코드로 바뀌었거나, 다른 방법으로 비밀번호를 정하면서 못 쓰게 됐어요.」 · 코드 없는 404 「이 서버에서는 복구 코드를 쓸 수 없어요. 관리자에게 재설정 링크를 요청하세요.」 · 429 「요청이 너무 잦아요. 잠시 뒤에 다시 시도하세요.」
- 성공: 「비밀번호를 다시 정했어요」 / 「다른 기기는 모두 로그아웃됐어요. 맥의 지시 키와 폰 승인은 다시 만들어야 해요. 방금 쓴 코드는 이제 쓸 수 없어요.」 → 응답의 **새 코드를 B 화면으로** 보인다(「새 복구 코드예요」). 이 화면에는 건너뛰기를 두지 않는다(이미 만들어진 코드를 못 본 채 닫으면 쓸 수 없는 코드가 「있음」으로 남기 때문이다).

**E. 그 밖의 한 줄**
- D3 비밀번호 변경 확인창: 「다른 기기는 모두 로그아웃돼요」 줄 아래에 「복구 코드도 못 쓰게 돼요. 바꾼 뒤 새 코드를 만들 수 있어요.」를 더한다(변경 전 코드가 「있음」일 때만 보인다).
- D3 비밀번호 변경 성공 화면(변경 전 코드가 「있음」이었을 때): 「복구 코드를 새로 만들어 둘까요?」 / 「비밀번호를 바꾸면 이전 복구 코드는 못 쓰게 돼요.」 / 「새 코드 만들기」 · 「나중에 할게요」. 방금 정한 비밀번호를 **메모리에만** 들고 있다가 만들기 경로의 `currentPassword`로 쓰고 화면을 떠나면 지운다(저장하지 않는다).
- 관리자 링크(D6)나 기기 서명(D7)으로 재설정한 직후 화면: 새 세션으로 상태를 읽어 「없음」이면 「복구 코드를 새로 만들어 둘까요?」(재설정이 옛 코드를 못 쓰게 만든다).

### L12. 위협표

| # | 위협 | 막는 곳 | 남는 위험 |
|---|---|---|---|
| T1 | **코드 유출**(종이 사진·파일·클립보드·화면 공유·어깨너머) → 계정 탈취 | 한 번만 보여 줌(L2), 쓰면 소각(L6), 소유자가 바꾸면 즉시 무효(L4), 어느 재설정·본인 변경·정지도 소각(L6), 문구 「비밀번호처럼」(L11 B), 저장 파일에 이메일·이름 없음 | **코드를 가진 쪽이 먼저 쓰면 계정을 가져간다.** 유출을 소유자가 모르면 쓰인 뒤에야 안다(알림 없음, T11). 이 길의 본질적 비용이다 |
| T2 | **온라인 추측**(공개 경로) | 120비트(L2·L8), 모양 불일치는 DB 없이 400, IP 예산 하나(L8) | 이론상 0에 수렴한다 [추정]. IP 예산은 헤더 신뢰로 우회될 수 있어 방어가 아니다 |
| T3 | **오프라인 추측**(DB·백업 유출) | 해시만, 평문·힌트 열 없음, 120비트라 SHA-256 반복으로 못 푼다(L3) | DB를 쓸 수 있는 쪽이 `code_hash`를 바꿔 끼울 수 있다. 그 권한이면 비밀번호 해시도 바꿀 수 있어서 이 증보가 새로 여는 것은 아니다 |
| T4 | **계정 탈취 뒤 코드 재발급·심기**: ⓐ 세션만 훔친 쪽 ⓑ 비밀번호와 세션을 둘 다 가진 쪽(로그인에 시도 제한이 아직 없어 비현실적인 전제가 아니다, F9) | ⓐ 만들기는 **현재 비밀번호 필수**(L4) + 멤버 단위 예산 + E-5 편입. ⓑ 도둑이 코드를 심어도 **소유자가 비밀번호를 바꾸는 표준 대응 한 번에, 또는 어느 길로든 복구하면 도둑의 코드가 소각된다**(본인 변경 포함, L6 [Q4 추천]). 감사 `created`(`replaced` 여부)·설정 행의 만든 날짜 | ⓑ 도둑이 코드를 **바꾸면** 소유자의 종이 코드가 죽는다. 소유자에게 관리자·기기 길이 없는 혼자 쓰는 서버면 복구 수단이 없다(E-6 필요). 이는 도둑이 비밀번호를 바꾸기만 해도 소유자가 잠기는 기존 위험에 「종이 코드 길을 닫는」 만큼만 더한다. **소유자가 비밀번호도 바꾸지 않고 설정 행도 보지 않으면** 심긴 코드가 남는다(알림 없음, T11. N-1이 후속). 1Password식 대기(만든 뒤 1시간·최근 로그인 뒤 24시간)는 알림 채널 없이는 방어가 못 돼 기각했다 |
| T5 | **정상 복구·변경 뒤에도 남은 코드**(유출되거나 남이 심은 코드가 살아남음) | 재설정·**본인 변경**·정지·제거·탈퇴 소각(L6), 쓰면 새 코드로 교체(L5) | 변경 뒤 소유자 자신의 종이 코드도 죽는다(새로 만들게 이끈다, L11 E). Q4에서 1안을 고르면 변경은 코드를 소각하지 않고 건너뛸 수 없는 상태 단계에 기댄다 |
| T6 | **로그·응답·감사 노출** | 코드는 본문에만(URL·쿼리·헤더 아님), 요청 DTO의 `Debug`가 값을 찍지 않음(수동 `Debug`: 현행 `ClaimRequest`는 `#[derive(Debug)]`에 평문 `String`이라 그대로 따르면 안 되고 `CreateDevCredentialRequest`처럼 손으로 쓴다), 공개 200과 만들기 201의 `Cache-Control: no-store`(claim·로그인 응답에는 없는 헤더라 새로 단다, 수용 3d·4a′), 감사 detail·로그에 평문·해시·정규형 없음(수용 9), 상태 GET은 존재와 날짜뿐, 클라이언트는 코드를 저장소·URL·진단에 남기지 않음(수용 12) | 본문을 기록하도록 설정한 프록시·CDN(운영 규율이고 시험 밖). 폰 클립보드가 범용 클립보드로 다른 기기에 보일 수 있다 [확인 필요, 구현 슬라이스가 확인]. 화면 녹화·스크린샷. 평문을 바인드 매개변수로 DB에 넘기는 해시 방식이면 DB 서버 로그에 닿을 수 있다(L3의 권장은 앱 해시) |
| T7 | **동시 제출·교착** | 단일 사용 관문(`consumed_at IS NULL` 조건의 UPDATE), 멤버십 잠금 → 코드 행 → `human` → sweep 순서(K7), 소각은 `SKIP LOCKED`, 결정적 간섭 시험(수용 4f·4i·4j) | D7(E-3)이 멤버십 잠금을 쓰지 않는 모양으로 착륙하면 순서를 다시 본다 [추정]. 소비가 롤백하는 드문 경우 코드가 남는 틈은 D4의 대기 링크와 같다. `SKIP LOCKED`의 건너뜀은 멤버십 잠금을 쓰지 않는 D7과 겹칠 때만 가능하다(L5) |
| T8 | **피싱**(가짜 서버가 코드를 받아 진짜 서버로 쓴다) | 서버 호스트 칩을 확인해야 입력 칸이 열림(`ClaimHostGate`, D8), 안내 문구 | 사용자가 가짜 서버에 입력하면 막지 못한다(비밀번호 피싱과 같다). 코드를 안내 화면 1번에 두면 로그인 화면에 코드를 입력하는 습관이 생겨 표면이 는다. 호스트 칩 확인이 유일한 방어라서 수용 12b가 중요하다 |
| T9 | **공개 경로 남용**(계정 열거·부하) | 계정을 받지 않아 열거 오라클이 없음, 없는 코드와 비활성 멤버가 **같은 본문**, 거절은 색인 한 번, 비싼 해시는 맞은 뒤에만, IP 예의 한도, 본문 상한, 코드가 확인된 뒤의 멤버 단위 상한(L8) | 응답 차이는 「한 번 유효했던 코드」(409)뿐이고 그것은 코드를 쥔 사람에게만 보인다 |
| T10 | **관리자 통제 우회·사회공학**(코드로 D6의 본인 확인을 건너뜀) | 서버 스위치(운영자), 정지·제거가 코드를 소각(L6) | 팀 서버의 관리자가 개별 멤버의 코드를 끌 수 없다(워크스페이스 정책은 후속). 코드를 동료에게 넘기는 것은 비밀번호를 넘기는 것과 같다 |
| T11 | **알림 부재**(코드를 만들거나 쓴 사실을 소유자가 모름) | 감사 행(L10)과 설정 행의 만든 날짜로 시작 | NIST §4.2.3의 「복구는 알림을 보낸다(SHALL)」와 어긋난다. 메일이 없고 복구 뒤에는 세션이 모두 끝나 소유자는 로그인이 안 되는 것으로 알게 된다. 후속 N-1(다른 기기 푸시), D10과 같은 결정이다 |

### 기각 대안 (증보 3)

| 대안 | 기각 이유 |
|---|---|
| 코드 세트(8~10개) | 2단계 인증 우회 코드의 모양이다. 비밀번호를 대신하는 코드에서는 유출 표면만 열 배가 된다. 한 개를 쓰면 새 한 개가 나오므로 남은 개수를 셀 필요가 없다(업계 표 아래 구분) |
| 80비트(16자) 이하 + 소금 + 계정 단위 제한 | NIST 112비트 기준 아래라 소금과 계정 축 상한이 필요하고, 소금은 코드만으로 행을 찾는 조회(L3)를 깨며, 계정 축은 열거·잠금 DoS를 부른다. 입력 몇 글자를 아끼는 값보다 크다 |
| 이메일(또는 워크스페이스+이메일)을 함께 받아 계정 축 예산으로 지킨다 | 이메일은 비밀이 아니라 보안을 더하지 않는다. 계정 축 예산은 남이 틀린 시도를 보내 정당한 소유자의 복구를 막는 잠금 DoS와, 응답·시간 차이로 계정 존재를 알리는 오라클을 만든다. E-5(미착륙)가 선행으로 묶인다. **다시 열 조건**: 입력 부담 때문에 코드를 112비트 아래로 줄여야 할 때 |
| `POST /v1/claim`의 세 번째 kind로 태운다 | `credential_claim.expires_at`이 `NOT NULL`이고 `CHECK (expires_at > created_at)`이라 만료 없는 행이 못 들어가며, TTL 24시간은 ADR-0166이 봉인했고 두 kind가 공유한다(「두 번째 시계를 만들지 말 것」). 운영자가 발급하는 짧은 링크(24시간·재발급이 취소)와 본인이 만들어 오래 두는 비밀(만료 없음·바꾸기가 취소)은 수명과 소각 규칙이 반대다. 토큰 모양 검사(`normalized_claim_token`, 정확히 43자)·`claimKind` 어휘·감사·스위치를 한 라우트에서 가를 수 없다 |
| `POST /v1/auth/login`에 `recoveryCode` 필드를 더한다 | 로그인 응답·로그·예산 표면에 코드가 섞이고 스위치를 가를 수 없다. 로그인의 계정 축 예산(E-5)이 이 코드에는 맞지 않는다 |
| 응답에 새 코드를 싣지 않고 클라이언트가 만들기 경로를 이어 부른다 | 클라이언트가 방금 정한 비밀번호를 다음 요청까지 더 들고 있어야 하고, 중간에 끊기면 코드가 없는 채로 남으며, NIST §4.2.1.1(사용 뒤 새 코드 발급)의 모양에서 벗어난다. claim·D7 뒤에서만 이 방식을 쓴다 |
| 바꿀 때 이전 코드를 요구 | 분실이 바꾸는 주된 이유다 |
| 만든 뒤 대기·최근 로그인 뒤 사용 불가(1Password식) | 알림 채널이 없으면 기다리는 동안 소유자가 알 수단이 없어 방어가 못 된다(D7이 Telegram·Apple식 지연을 기각한 이유와 같다). **다시 열 조건**: N-1 알림이 생길 때 |
| 만료 기한을 둔다 | 필요한 순간이 몇 년 뒤일 수 있다. 소각 규칙과 설정 행의 날짜로 갈음한다 |
| 끝 4자 같은 힌트를 평문으로 보관 | 120비트 중 그만큼이 평문 열에 남는다. 설정 행은 만든 날짜만 보인다 |
| 코드 해시에 후추(HMAC) | 120비트라 필요 없고 후추 보관·회전이 부담이다. **다시 열 조건**: 코드를 112비트 아래로 줄일 때 |
| 본인 변경(PATCH)은 코드를 건드리지 않는다(Q4의 1안) | 코드를 만들거나 바꾸는 데도 현재 비밀번호만 있으면 되므로(L4) 비밀번호를 아는 쪽은 변경 없이도 소유자의 코드를 죽일 수 있어, 면제가 소유자의 코드를 지켜 주지 못한다. 대신 남이 심은 코드가 표준 대응(비밀번호 변경)을 견딘다. 이를 막으려면 변경 직후 코드 상태를 건너뛸 수 없게 보여 줘야 하는데 소유자가 날짜를 읽어야만 닫힌다. **owner 결정 Q4의 대안**으로 남긴다 |
| 코드로 복구해도 로그인된 다른 세션 유지 | D4가 이미 기각했고, 코드가 새어 나갔을 수 있는 복구라 더 그렇다 |
| 관리자가 멤버의 코드를 끄거나 존재를 본다 | 개인 비밀의 존재가 관리 화면에 보이고 정책 표면이 늘어난다. v1은 서버 스위치만. **다시 열 조건**: 팀 서버에서 요청이 올 때 |
| 공개 경로에 IP 예의 한도만 두고 멤버 단위 상한은 두지 않는다 | 한도가 위조 가능한 IP 키 하나뿐이면 한 멤버가 「사용 → 새 코드 → 사용」으로 배타 멤버십 잠금을 한도 없이 반복해서 잡고, 그때마다 워크스페이스의 로그인·join이 503이 된다(증보 2 K5). 일반 멤버가 닿는 첫 무한 경로가 된다(L8) |
| 사용 경로가 `end_member_sessions_in_tx`만 부른다 | 그 함수는 토큰을 폐기하지 않는다. 접근·갱신 토큰, 개발자 토큰, 대기 로그인 코드가 복구 뒤에도 남는다(L7) |
| 계보 단위 종료(로그아웃·기기 연결 해제·refresh 재사용)도 코드를 소각 | 기기 연결 해제는 세션만 있으면 되므로 세션만 가진 쪽이 소유자의 코드를 죽일 수 있게 된다. 코드를 만들 때 비밀번호를 묻는 원칙(L4)과 부딪힌다(L6) |

### owner 결정으로 덮이는가 (증보 3)

| 결정 | owner 결정 | 표기 |
|---|---|---|
| 복구 코드로 혼자 비밀번호를 다시 정하는 길을 둔다 | **덮임**(owner 2026-11-03 요청, #5228) | owner |
| 로그인 전에 부르는 새 공개 경로 하나, 스위치 기본 꺼짐 | 덮이지 않음 → **Q1** | [권장] |
| 한 개·24자·120비트·해시 보관·만료 없음 | 덮이지 않음(한 개 대 세트는 **Q3**) | [권장] |
| 재설정 뒤 전체 종료(토큰 폐기 포함), 관리자 링크·기기 서명·코드 사용이 코드를 소각 | 덮이지 않음(D4 연장) | [권장] |
| 본인 비밀번호 변경이 코드를 소각하는가 | 덮이지 않음 → **Q4** | [권장] |
| 만들기·바꾸기에 현재 비밀번호 재확인 | 덮이지 않음(D6 연장) | [권장] |
| 공개 경로는 계정 축 예산을 쓰지 않고 E-5와 한 묶음에서 이탈, 코드 확인 뒤 멤버 단위 상한 | 덮이지 않음(이슈의 「E-5 한 묶음」에서 이탈) | [권장] |
| 가입 직후 안내의 강도 | 덮이지 않음 → **Q2** | [권장] |
| 알림은 후속 | D10과 같은 결정 | [권장] |

### owner 질문 (4개, 추천 먼저)

1. **Q1. 로그인 전에 부르는 새 공개 경로 하나를 허용할까요?** 추천 **예**(스위치 기본 꺼짐, 보안 검수와 owner 승인 뒤에 켬). 아니오면 복구 코드를 못 만들고, 관리자도 기기도 없는 혼자 쓰는 서버는 E-6 착륙 전까지 복구 수단이 없어요.
2. **Q2. 가입 직후 안내를 얼마나 세게 할까요?** 추천 **건너뛸 수 있는 카드**(새 계정에 한 번, 처음 연 owner에게는 설정에 「복구 코드 없음」 점). 필수는 형식적 확인이 되기 쉽고, 설정에서만은 대부분이 안 만들어 길이 있어도 쓸 수 없어요.
3. **Q3. 코드는 한 개일까요, 여러 개 세트일까요?** 추천 **한 개**(비밀번호를 대신하는 코드의 업계 관례, 쓰면 새 한 개가 나와요). 세트는 2단계 인증 우회 코드의 모양이라 보관할 비밀만 늘어요.
4. **Q4. 비밀번호를 바꿀 때 복구 코드를 어떻게 할까요?** 추천 **2안 — 코드도 함께 못 쓰게 하고 성공 화면에서 바로 새 코드를 만들게 안내**(남이 심은 코드가 표준 대응 한 번에 사라져요. 대가는 비밀번호만 바꾸는 단순한 공격에도 소유자의 종이 코드가 죽는 것). 대안 **1안 — 코드는 두고 변경 직후 코드 상태와 날짜를 건너뛸 수 없게 보여 주기**(단순한 공격에는 종이 코드가 남지만 심긴 코드는 소유자가 알아채야만 사라져요). 어느 쪽이든 N-1 알림은 켜기 조건이 아니라 후속이에요.

**Q4에서 1안(코드 유지 + 건너뛸 수 없는 상태 단계)을 고르면 바뀌는 줄**: L6 표의 `PasswordChanged` 행은 **유지**로 바뀌고 둘째 술어에서 `PasswordChanged => false`가 된다(두 술어가 갈라지는 원인은 `DeviceUnlinked` 하나만 남고, 사유 열거에서 `password_changed`가 빠진다). 본인 변경(PATCH) 성공 응답에 `recoveryCode: { exists, createdAt }`를 가산하고(스위치가 꺼져 있으면 필드 없음), D3 성공 화면은 이를 건너뛸 수 없는 한 단계로 보인다(「복구 코드가 {날짜}에 만들어져 있어요. 이 날짜에 만든 적이 없다면 지금 새 코드로 바꾸세요」 / 「내가 만든 거예요」·「새 코드로 바꾸기」). 수용 기준은 5b를 「변경을 반복해도 코드가 살아 있다」로 되돌리고 5f를 「두 술어가 갈라지는 원인은 `DeviceUnlinked` 하나다」로 고치며, 「PATCH 성공 응답에 코드 상태가 있다」·「성공 화면이 상태를 보이고 확인 전에는 닫히지 않는다」와 그 사보타주(상태 필드 제거, 확인 단계 건너뛰기)를 더하고 12g를 이 단계 시험으로 바꾼다. 7d는 「변경이 링크와 코드를 모두 살려 둔다」로 바뀐다. T4ⓑ·T5와 L6 「남는 위험」은 「소유자가 날짜를 읽지 않거나 넘기면 심긴 코드가 남는다」로 되돌리고, L11 E의 문구는 위 단계로 대체하며, 기각 대안 표의 「본인 변경은 코드를 건드리지 않는다」 행은 채택으로 옮긴다.

### 새 공개 API 선언 (증보 3, ADR-0100)

아래 표면은 이 증보를 Accepted 근거로 삼는다. 필드 이름·OpenAPI는 각 구현 이슈가 확정한다.

| 표면 | 내용 | 이슈 |
|---|---|---|
| `POST /v1/auth/password-recovery` | **새 공개(비인증) 라우트**. 본문 `{ code, newPassword }`. 200은 `LoginResponse`와 같은 본문에 새 코드 `{ code, createdAt }` 하나를 더한다. `Cache-Control: no-store`. 스위치가 꺼져 있으면 추출기 앞에서 오류 코드 없는 404. 요청 본문 상한 작게(초과는 413) | R-2 |
| `POST /v1/workspaces/{ws}/members/me/recovery-code` | 새 라우트. 본문 `{ currentPassword }` 필수. 201 `{ code, createdAt, replaced }`, `Cache-Control: no-store`. 스위치가 꺼져 있으면 404. 개발자 토큰(`required_dev_scope` 표 밖 → 403 `dev_route_not_allowed`)과 에이전트 bearer는 거절 | R-1 |
| `GET /v1/workspaces/{ws}/members/me/recovery-code` | 새 라우트. 200 `{ exists, createdAt }`뿐. 스위치가 꺼져 있으면 404. 개발자 토큰과 에이전트 bearer는 거절 | R-1 |
| `PATCH …/members/me/password` | 요청·응답 계약은 **그대로**다. 부작용 한 줄이 가산된다: 성공한 변경이 그 멤버의 복구 코드를 소각한다(Q4 추천안. 1안이면 계약이 바뀌어 응답에 `recoveryCode` 상태가 가산된다) | R-1 |
| 오류 코드 | 새: `recovery_code_malformed`(400), `recovery_code_invalid`(404), `recovery_code_used`(409), `recovery_code_replaced`(409). 재사용: `current_password_required`(400)·`current_password_incorrect`(403)·`password_too_short`·`password_too_long`·`password_invalid_char`(400) | R-1·R-2 |
| 환경 변수 | `MOMO_PASSWORD_RECOVERY_CODE`(기본 **꺼짐**, `trim() == "true"`만 켜짐), `RATE_LIMIT_RECOVERY_CODE_PER_IP`(10, 예의 한도), `RATE_LIMIT_RECOVERY_CODE_USE_PER_MEMBER`(5, 코드 확인 뒤), `RATE_LIMIT_RECOVERY_CODE_ISSUE_PER_MEMBER`(5, 만들기). 속도 노브의 0·파싱 불가는 기본값(끄는 값 없음) | R-1·R-2 |
| 감사 action | `member.recovery_code.created`·`.revoked`·`.refused`, `member.password_reset.recovery_code`(L10) | R-1·R-2 |
| 공유 규칙 | 정규형·표시 형태·정규화 표(공유 벡터 파일, Rust·TS 공용) | R-1·C-1 |

### DB 계약 (증보 3, 새 migration만)

- 번호: 구현 시점의 다음 번호이고 **planner가 구현 이슈를 시작할 때 배정한다**. `schema_v0.sql`은 건드리지 않는다. 번호 연속성 시험(`discovers_contiguous_migrations_001_to_<N>`)을 자기 번호로 갱신하는 것은 구현의 몫이다.
- 이 증보는 본문의 DB 계약(「새 테넌트 테이블은 없고」·「새 definer 함수가 없다」)과 **다르게** 둘을 더한다:
  1. **새 테넌트 테이블** `member_recovery_code`(이름은 구현이 확정) — L3의 열·제약. RLS FORCE·`ws_isolation`·권한은 `momo_app`만. 새 테넌트 테이블이므로 RLS 정책 대상에 포함한다.
  2. **새 EXECUTE 전용 definer 함수** `momo_join_private.recovery_code_workspace_id(…)`(인자는 앱 해시면 `bytea`, DB 해시면 `text`, L3) — 078의 `owner_claim_workspace_id`와 같은 모양(`SECURITY DEFINER`·`STRICT`·`search_path = pg_catalog`, uuid 하나만 반환, `momo_app`만 EXECUTE, 다른 역할은 명시적으로 REVOKE). **카탈로그 시험 목록 갱신이 R-1의 몫이다**: `APP_EXECUTABLE_DEFINERS`·`PG_CATALOG_ONLY_DEFINERS`(L3, 수용 11).
- 이 증보 몫의 제약: `code_hash` 32바이트 CHECK · 전역 유일 · 멤버당 live 한 행(부분 유일 인덱스) · `consumed_at`과 `revoked_at`이 둘 다 찬 행 금지 · `revoked_reason` 열거 CHECK(`replaced`·`password_changed`·`password_reset`·`suspended`·`removed`·`left`. 계보 단위 원인은 도달 불가라 넣지 않는다, L6).

### 수용 기준 (증보 3, red proof)

규칙은 본문 「수용 기준」과 같다(조건 하나만 거짓인 입력, 사보타주는 구현 PR이 해당 줄을 실제로 바꿔 시험이 빨개지는지 확인하고 결과를 PR 본문에 적는다. 방어층이 겹치면 두 층을 함께 지우거나 층마다 오류 코드를 구별한다. 동시성·교착은 반복 횟수나 결정적 간섭을 쓴다). 새 보안 문장을 `docs/security/claims.yaml`에 올릴 때의 증명 선택자와 저장소 안 음성 대조(ADR-0214 D4)는 R-1·R-2의 몫이고, 새·바뀐 서버 PG 시험은 `infra/security-pack/selection.txt`에 올린다. 이 증보는 어떤 시험도 실행하지 않았다(`runtime-unverified`).

1. **모양·정규화(L2)** — 공유 벡터 파일을 Rust·TS가 같이 읽는다.
   - 1a 만든 코드 10,000개가 모두 24자(하이픈 제외)·알파벳 안·서로 다름이고 표시 형태는 4자 6묶음이다. 사보타주: 알파벳에 `I`·`O`를 넣는다, 길이를 23으로 한다.
   - 1b 고정 바이트 15개가 고정 24자로 바뀐다. 엔트로피를 직접 잴 수 없으므로 「15바이트 → 5비트 24개」 구조를 단정한다. 사보타주: 14바이트만 읽고 나머지를 0으로 채운다.
   - 1b′ **난수 배선**(실제 생성 진입점, 난수원은 `getrandom`): 만든 코드 10,000개에서 120비트 각각의 1 비율이 50% ± 6σ(표본 10,000이면 4,700~5,300) 안이고 24개 글자 자리마다 32기호가 모두 나온다(6σ라 정상 난수의 거짓 경보는 실행 수백만 번에 한 번 안팎이다). 1a와 1b는 이 결함에 초록이다. 사보타주: 15바이트 버퍼에 8바이트만 채우고 나머지를 0으로 둔다(10,000개가 서로 다르므로 1a는 통과하고 1b는 고정 바이트만 보므로 통과한다) / 한 글자 자리를 고정 기호로 둔다.
   - 1c 정규화 표를 한 행씩: 소문자·공백·하이픈류 다섯 종류·`O`→`0`·`I`와 `L`→`1`이 같은 정규형(= 같은 해시)이 된다. 사보타주: `O`→`0`을 뺀다(그 행만 빨개진다).
   - 1d 모양 불일치(23자·25자·`U`·이모지·빈 문자열)는 400 `recovery_code_malformed`이고 **DB 문이 하나도 실행되지 않는다**(쿼리 카운터 0). 사보타주: 길이 검사를 지운다.
2. **보관(L3)**
   - 2a 만든 코드(평문·정규형·URL 인코딩·base64)가 **모든 테넌트 테이블의 text·bytea·jsonb 열**(감사 `detail`·`token`·아웃박스 포함, 카탈로그에서 열을 열거해 훑는다)에서 0건이고 `code_hash`는 정규형의 SHA-256과 같다. **음성 대조**: 일부러 한 열(감사 `detail`)에 코드를 심은 변이에서 빨개져야 한다(수용 9의 모양). 사보타주: 평문을 한 열에 저장한다.
   - 2b 같은 멤버로 연속 두 번 만들면 live 1행·이전 행은 `replaced`로 죽는다. 동시에 두 번 만들어도 live 1행이다. 사보타주: 부분 유일 인덱스를 지운다.
   - 2c 스무 번 바꾼 뒤 그 멤버의 행은 최대 둘(live 하나 + 가장 최근 죽은 하나)이다. 사보타주: 오래된 죽은 행 정리를 지운다.
   - 2d 다른 워크스페이스 GUC에서 이 행이 0건으로 보이고, definer 함수의 EXECUTE는 `momo_app`만이며(카탈로그 시험), A 워크스페이스의 코드로 B 워크스페이스의 멤버를 재설정할 수 없다(AUTH-4의 「자기 워크스페이스에 한정」 모양). 방어층이 겹치므로 결과를 단정하고 사보타주는 `ws_isolation` 정책과 코드의 워크스페이스 비교를 **함께** 지운다. 함수 권한을 `PUBLIC`에 열면 카탈로그 시험이 빨개진다.
3. **만들기·바꾸기·상태(L4)** — 사람 멤버, 스위치 켜짐.
   - 3a 본문 없음·`currentPassword` 없음 → **400** `current_password_required`(axum의 415·422가 아님). 사보타주: 추출기 기본 오류가 나게 둔다.
   - 3b 틀림 → 403 `current_password_incorrect`, live 코드는 그대로, `refused` 감사 1행. 사보타주: 비밀번호 검사를 지운다.
   - 3c 9자 현재 비밀번호(새 규칙 이전)로도 201이다(본문 수용 1f의 짝). 사보타주: 현재 칸에 새 규칙을 건다.
   - 3d 맞음 → 201 `{ code, createdAt, replaced: false }`, `Cache-Control: no-store`, 감사 `created`(`replaced: false`) 1행. 사보타주: 헤더를 뺀다.
   - 3e 바꾸기 → 이전 코드로 공개 경로 409 `recovery_code_replaced`, 새 코드로 200. 사보타주: 이전 행 소각을 지운다.
   - 3f 비밀번호 없는 계정 → 409이고 행 0개, 에이전트 멤버 → 403. 사보타주: 검사를 지운다.
   - 3g 속도: 같은 멤버의 6번째는 맞는 비밀번호여도 429이고 다른 멤버는 영향이 없다. 0·파싱 불가 설정은 기본값이다. 사보타주: 맞는 요청을 세지 않게 한다 / 키에서 멤버를 뺀다.
   - 3h 상태 GET의 본문 키 집합이 정확히 `exists`·`createdAt`이다. 사보타주: 코드의 끝 글자를 더한다.
   - 3i 만들기 요청 본문의 필드 집합이 `currentPassword` 하나뿐이다: 본문에 `code`를 실어 보내도 응답의 코드는 서버가 만든 값이고 저장된 해시도 그 값의 것이다(코드를 고르는 길이 없다, L2). 사보타주: 본문의 `code`를 받아 쓰게 한다.
   - 3j 개발자 토큰은 만들기·상태 경로에서 403 `dev_route_not_allowed`이고 에이전트 bearer도 거절된다. 사보타주: 두 경로를 `required_dev_scope` 표에 넣는다.
4. **공개 경로(L5)**
   - 4a 정상 → 200, 새 비밀번호로 로그인되고 이전 refresh는 401, 응답에 이전과 **다른** 새 코드가 있고, DB에 live 1행(새 해시)과 `consumed_at`이 찍힌 이전 행, 감사 `member.password_reset.recovery_code` 1행이다. 사보타주: 새 코드 발급을 `end_member_sessions_in_tx` **앞**으로 옮기면 방금 만든 행이 소각돼 live 0행이 되어 빨개진다(L5의 순서를 시험에 박는다).
   - 4a′ 응답과 재시도: 공개 200 응답에 `Cache-Control: no-store`가 있다(3d의 짝. claim·로그인 응답에는 없던 헤더라 새로 단다). 재설정 직후 30초 안(유예 창)에 이전 refresh를 내밀어도 401이고 쌍을 되돌려 주지 않는다. 사보타주: 헤더를 뺀다 / 토큰 폐기 호출을 지운다(이 행과 4g′가 빨개진다).
   - 4a″ **한 트랜잭션**: 코드 소비·비밀번호 변경·토큰 폐기·새 코드 행·감사 행·새 세션 두 행의 `xmin`이 한 값이다(증보 2 수용 7의 모양). 한 문이 자기 트랜잭션을 따로 열면(코드만 소비되고 비밀번호는 안 바뀌는 상태가 가능해진다) 빨개진다. 사보타주: 새 코드 발급을 별도 트랜잭션으로 옮긴다.
   - 4b 9자 새 비밀번호 → 400 `password_too_short`이고 **코드는 소비되지 않는다**(같은 코드로 다음 요청이 200). 사보타주: 규칙 검사를 소비 뒤로 옮긴다.
   - 4c 없는 코드·**정지된 멤버의(정지가 소각한) 코드**·삭제된 워크스페이스의 코드가 **바이트까지 같은** 404 `recovery_code_invalid`다. 정상 흐름에서 정지는 코드를 소각하므로 「정지된 멤버의 live 코드」는 만들 수 없는 상태이고, 이 행은 도달 가능한 상태만 쓴다. 사보타주: 정지 멤버에게 409나 403을 낸다.
   - 4c′ **복권된** 멤버 + 같은 코드 → 409 `recovery_code_replaced`. 4단계의 순서(멤버 활성 확인이 죽은 코드 판정보다 앞)를 4c와 함께 박는다. 사보타주: 죽은 코드 판정을 멤버 확인 앞으로 옮기면 4c의 정지 멤버 쪽이 409가 되어 빨개진다.
   - 4d 쓴 코드 → 409 `recovery_code_used`, 소각된 코드 → 409 `recovery_code_replaced`, 순차 재전송 → used. 사보타주: 소각된 행도 live로 읽게 한다.
   - 4e 스위치 꺼짐 → 404이고 본문에 오류 코드가 없다(4c의 404와 구별된다). **꺼짐 상태에서 잘못된 `Content-Type`·깨진 JSON·빈 본문도 같은 404**다(추출기 앞에서 나온다, L1). 사보타주: 항상 연다 / 꺼진 404에 코드를 단다 / 스위치 확인을 `Json<T>` 추출기 뒤로 옮긴다(잘못된 `Content-Type`이 415·422가 되어 빨개진다).
   - 4f **동시 이중 제출**(같은 코드, 다른 새 비밀번호): 정확히 하나가 200, 다른 하나는 409 `recovery_code_used`이고 **40P01이 없다**(반복 100회). 사보타주: 소비 UPDATE의 `consumed_at IS NULL` 조건을 지운다(둘 다 200이 된다).
   - 4g 효과: 푸시 무효, 기기 키 `member_sessions_ended` 폐기, 예약 메시지 보류, **대기 중인 관리자 링크 소비**(그 링크로 claim → 409). 사보타주: `end_member_sessions_in_tx` 호출만 지운다.
   - 4g′ **토큰 폐기**(L7 ①): 복구 직전에 만들어 둔 세션 접근 토큰·**개발자 토큰**(카드 토큰과 로그인 계보)·교환을 기다리는 **개발자 로그인 코드**가 복구 직후 다음 요청에서 모두 거절된다(접근 토큰은 즉시 401). 4g의 사보타주는 이 행을 겨누지 못한다(그 함수는 토큰을 폐기하지 않는다). 사보타주: `revoke_member_session_tokens` 호출만 지운다(이 행과 4a′가 함께 빨개진다).
   - 4h 잠금 앞 거절: 배타 멤버십 잠금이 잡혀 있어도 없는 코드·쓴 코드는 기다리지 않고 즉시 답한다(`pg_locks`, 증보 2 수용 6의 모양). 사보타주: 잠금 앞 읽기를 지운다.
   - 4i 교착 없음 — 쌍마다 한 행, 두 연결 모두 40P01 없이 커밋: 코드 사용 × claim 소비, × 정지, × 본인 변경(PATCH), × **만들기·바꾸기**, (E-3 착륙 뒤) × D7. 끼어드는 지점은 시험 훅으로 고정한다. 사보타주: 코드 행 잠금을 `human` 행 뒤로 옮긴다 / 소각의 `SKIP LOCKED`를 지운다.
   - 4j **만들기 × 정지 경합**(정지 뒤 복권에서 되살아나지 않는다는 경합 쪽 증거): 만들기가 비밀번호 확인 뒤·멤버십 잠금 앞에서 멈추고 정지가 커밋된 뒤 이어지면 403 `member is not active`이고 그 멤버의 live 행이 0이다(5c의 순차 시험을 경합으로 확인한다). 사보타주: 잠금 안의 활성 재확인을 지운다.
5. **소각(L6)** — 원인마다 한 행.
   - 5a `PasswordReset`(claim 소비·코드 사용·E-3 뒤 D7)·**`PasswordChanged`(본인 변경)**·`Suspended`·`Removed`·`Left`마다 live 코드가 사유(원인 코드)와 함께 죽고 `member.recovery_code.revoked` 1행이 남는다. 사보타주: 원인별 소각을 지우면 그 행만 빨개진다.
   - 5b **본인 변경이 코드를 소각한다**(H-1의 닫힘): 성공한 변경 뒤 그 코드로 공개 경로 → 409 `recovery_code_replaced`. 틀린 현재 비밀번호의 변경(403)과 새 비밀번호 규칙 위반(400)은 코드를 건드리지 않는다. **심긴 코드 시나리오**: 비밀번호를 아는 쪽이 로그인해 소유자의 코드를 바꿔 자기 코드를 심음 → 소유자가 비밀번호를 변경 → 심긴 코드로 공개 경로 → 409(비밀번호·세션 없이 쓸 수 있는 남의 코드가 변경 뒤에 남지 않는다). 사보타주: `PasswordChanged`의 소각을 지운다(심긴 코드 시나리오가 200이 되어 빨개진다) / 실패한 변경도 소각하게 한다(앞 문장이 빨개진다).
   - 5c 정지 후 복권하면 코드가 없다(되살아나지 않는다). 사보타주: 정지의 소각을 지운다.
   - 5d 코드가 없는 멤버의 재설정은 `revoked` 감사 행을 쓰지 않는다. 사보타주: 항상 쓴다.
   - 5e 스위치가 꺼져 있어도 재설정이 코드를 소각한다. 사보타주: 소각을 스위치 안에 둔다.
   - 5f 단위: 두 술어의 표를 모든 `RevocationCause` 7개에 대해 박는다(코드/링크): `PasswordChanged` 소각/유지, `PasswordReset`·`Suspended`·`Removed`·`Left` 소각/종료, `DeviceUnlinked` 유지/종료, `RefreshReuse` 유지/유지. 두 술어가 갈라지는 원인은 정확히 `PasswordChanged`와 `DeviceUnlinked`다. 사보타주: 표의 한 행을 뒤집으면 그 행만 빨개진다. 둘 다 `_` 갈래 없는 `match`다(새 원인이 생기면 컴파일이 멈춘다).
   - 5g **계보 단위 종료는 코드를 건드리지 않는다**(L6): 로그아웃·기기 연결 해제(`DELETE /v1/auth/devices/{id}`, 세션만 있으면 된다)·refresh 재사용 뒤에도 코드가 살아 있고 공개 경로가 200이다. 사보타주: 계보 종료 경로(`end_session_lineage_in_tx`)에 소각을 단다.
6. **시도 제한(L8)**
   - 6a 같은 IP의 11번째(기본 10)는 맞는 코드여도 429이고 다른 IP는 영향이 없다. claim의 IP 한도와 다른 버킷이다. 노브 0·파싱 불가는 기본값이다(기존 IP 한도 문 `gate_per_ip`의 「0 = 끔」과 해석이 다르므로, 그 미들웨어를 그대로 쓰지 않았음을 이 단정이 박는다). 사보타주: 한도를 지운다 / 두 버킷을 합친다 / 0을 끔으로 읽게 한다.
   - 6b **계정 축이 없다**: 예산 키 모양에 멤버·이메일이 들어가지 않는다(단위). 한 계정을 겨냥해 다른 IP로 틀린 코드를 100번 보내도 그 계정의 정당한 코드 사용은 200이다(잠금 DoS 없음). 사보타주: 멤버 키를 만든다.
   - 6c **멤버 단위 상한**: 같은 멤버의 코드를 이어 N+1번 쓰면(사용 → 새 코드 → 사용 …, 창 안) N+1번째는 429이고 소비·잠금·쓰기가 없다(코드 행·비밀번호가 그대로이고 배타 멤버십 잠금을 한 번도 잡지 않았음을 `pg_locks`로 단정). 다른 멤버는 영향이 없다. 노브 0·파싱 불가는 기본값이다. 사보타주: 예산을 지운다 / 키에서 멤버를 뺀다.
   - 6d **틀린 코드는 그 예산을 쓰지 못한다**: 다른 주소에서 틀린 코드를 100번 보내도 그 멤버의 정당한 코드 사용은 200이다(잠금 DoS 없음). 사보타주: 예산을 코드 확인 앞으로 옮긴다(틀린 코드가 예산을 태워 이 행이 429가 된다).
   - 6e 본문 상한: 상한을 넘는 본문(예: 1 MiB)은 413이고 DB 문이 0개다. 사보타주: 상한을 지운다.
7. **우선순위(L9)**
   - 7a 관리자 링크 발급 → 코드 사용 → 그 링크로 claim → 409. 사보타주: 대기 링크 소비를 지운다(본문 수용 2d의 짝).
   - 7b 코드 만들기 → 관리자 링크 소비 → 코드 사용 → 409 `recovery_code_replaced`. 사보타주: claim 경로의 소각을 지운다.
   - 7c 링크 **발급**만으로는 코드가 살아 있다. 사보타주: 발급이 코드를 소각하게 한다.
   - 7d **술어가 갈라진 자리**(Q4 추천안): 관리자 링크 발급 + 코드 만들기 → 본인 변경 → 그 링크로 claim은 200(링크가 살아 있다)이고 그 코드로 공개 경로는 409(코드가 죽었다). 사보타주: 변경이 링크도 끊게 한다(D4 위반, 본문 수용 2e도 빨개진다) / 변경이 코드를 살려 둔다(5b가 빨개진다).
8. **감사(L10)** — 표의 action·schema·detail 키 집합이 정확하다. `refused`는 멤버·윈도당 1행이다(요청을 바꿔 보내도). 공개 경로의 실패는 행 0과 버스트당 WARN 한 줄이다. 사보타주: 공개 경로의 실패도 행을 쓰게 한다 / detail에 입력 값을 넣는다.
9. **비유입(서버 시험)** — AUTH-4와 같은 방식(`tracing` 가로채기 + `audit_log.detail` 전수)으로 만들기(성공·실패) → 공개 경로(성공·모든 실패) → 소각 전 경로를 돌려, 코드(평문·정규형·URL 인코딩·base64)·해시(hex·base64)·비밀번호가 로그와 감사에 0건임을 단정한다. **음성 대조**: 일부러 로그에 코드를 찍는 변이에서 빨개져야 한다. 요청 DTO의 `Debug` 출력에 값이 없다. **아웃박스 행 0, 푸시 0, 실시간 발행 0**(만들기·바꾸기·사용 전 경로에서, L10). 사보타주: 만들기가 아웃박스 이벤트를 쓰게 한다.
10. **스위치(L1)** — 기본값은 꺼짐(설정 단위 시험). 꺼짐 → 만들기·상태·공개 경로가 모두 404, 켜짐 → 열린다. 사보타주: 한 경로만 스위치 밖에 둔다. **값 해석**: `true`·` true `(앞뒤 공백)만 켜짐이고 `True`·`TRUE`·`1`·`yes`·빈 값·`tru`는 모두 꺼짐이다(기존 스위치와 같은 `trim() == "true"`). 사보타주: 대소문자를 무시하도록 바꾼다 / `1`을 켜짐으로 읽게 한다.
11. **마이그레이션·권한(DB 계약)** — 새 테이블에 RLS FORCE·`ws_isolation`이 있고(카탈로그 시험), 번호 연속성 시험이 새 번호로 갱신되며, 새 definer 함수가 `momo-db` 시험의 `APP_EXECUTABLE_DEFINERS`(정확한 서명)와 `PG_CATALOG_ONLY_DEFINERS`(`md5(prosrc)` 고정)에 올라 있고, relay·worker·platform_admin·notifier 역할이 실행하지 못한다(claim 선례 `only_momo_app_can_execute_the_locked_claim_lookup` 모양의 음성 시험). 사보타주: 함수를 목록에 올리지 않으면 카탈로그 시험이 빨개지고, `PUBLIC`에 EXECUTE를 열면 음성 시험이 빨개진다.
12. **화면(웹·데스크탑)**
    - 12a 안내 화면에서 「복구 코드가 있어요」를 열고 닫는 동안 네트워크 호출 0건(spy), 제출할 때만 부른다. 사보타주: 열 때 상태 호출을 넣는다.
    - 12b 호스트 칩을 확인하기 전에는 코드·비밀번호 칸이 닫혀 있고, 요청이 가는 호스트는 칩의 호스트다. 사보타주: 확인을 건너뛰게 한다.
    - 12c 소문자·하이픈·공백이 섞인 코드를 붙여 넣으면 화면은 4자 6묶음 대문자로 보이고 전송 본문은 정규형이다. 사보타주: 정규화를 지운다.
    - 12d 코드는 `localStorage`·`sessionStorage`·URL·히스토리·진단 보고에 남지 않는다(저장소 spy). 닫으면 다시 볼 수 없고 「적어 두었어요」 전에는 「완료」가 닫혀 있다. 사보타주: 상태를 저장소에 쓴다 / 체크를 건너뛴다.
    - 12e 복구 성공 화면이 응답의 새 코드를 B 화면으로 보이고 건너뛰기가 없다. 가입 직후 카드는 새 계정에만 보이고 「나중에 할게요」 뒤에는 다시 묻지 않는다. 사보타주: 새 코드를 버린다 / 기존 계정에도 보인다.
    - 12f 설정 행의 세 상태(없음·있음·꺼짐=숨김). 문구 장부(`direct-copy`) 통과.
    - 12g **D3 변경 흐름**(Q4 추천안): 확인창에 「복구 코드도 못 쓰게 돼요」 줄이 있고(변경 전 코드가 「있음」일 때), 성공 화면에 「새 코드 만들기」 단계가 보이며, 만들기 호출에 쓰는 비밀번호는 메모리에만 있다가 화면을 떠나면 지워진다(저장소 spy 0). 사보타주: 줄·단계를 지운다 / 비밀번호를 저장소에 쓴다.
13. **폰** — 12와 같은 단정을 폰 화면에서(U-6·U-7 착륙 뒤). 클립보드 복사가 범용 클립보드로 다른 기기에 보이는지는 구현이 확인해 기록한다.

### 구현 슬라이스 (증보 3)

이슈 번호가 없는 것은 PR 본문 「새 이슈 초안」에 적고 발행은 planner가 한다. 크기 L은 증거 상한이 이슈 계약이다. 등급 2는 보안 경계라서 실 PG 증거와 착륙 전 독립 보안 검수 Blocker 0·High 0이 머지 조건이고 **켜기는 별도**(L1)다. 등급 1은 화면 슬라이스이고 검증 줄의 design-review Blocker 0·High 0을 받는다.

| 슬라이스 | 표면 | 내용 | 크기 | 등급 | 선행 |
|---|---|---|---|---|---|
| **R-1** | 서버 | migration(새 테이블·definer 함수)·`momo-auth` 코드 모듈(만들기·정규화·해시·저장)·`POST/GET …/me/recovery-code`·비밀번호 재확인·멤버 예산·감사·스위치(`trim() == "true"`)·`end_member_sessions_in_tx` 소각 훅(둘째 술어 `ends_recovery_code`, 본인 변경 포함)·`momo-db` 카탈로그 목록 갱신·개발자 토큰/에이전트 거절 시험·OpenAPI·공유 벡터(Rust 몫)·`claims.yaml` 새 항목과 음성 대조·PG 시험을 `selection.txt`에 | L | 2 | 증보 3 Accepted **+ Q4 결정**(E-1·E-4 착륙됨) |
| **R-2** | 서버 | `POST /v1/auth/password-recovery`: 추출기 앞 스위치 404·본문 상한·잠금 앞 거절·**코드 확인 뒤 멤버 단위 상한**·잠금·소비·**토큰 폐기 호출(`revoke_member_session_tokens`)**·`end_member_sessions_in_tx`·새 코드 응답·IP 예의 한도·오류 어휘·비유입·교착 시험·OpenAPI | L | 2 | R-1 (E-5는 선행 아님, L8) |
| **C-1** | 공유 코어 | `packages/momo-core`: 정규화·표시 형태·모양 검사·API 클라이언트·오류→문구 분류·공유 벡터(TS 몫) | S | 1 | 이 증보 Accepted + R-1의 OpenAPI 초안 (R-1과 병행) |
| **W-1** | 웹·데스크탑 | 설정 › 보안 › 복구 코드 행·만들기/바꾸기 대화상자·한 번 보기(L11 B)·가입 직후 카드(L11 A)·D3 변경 확인창 문구와 성공 화면의 「새 코드 만들기」 단계(L11 E, Q4 추천안) | M | 1 | R-1, C-1, U-1(#4600)과 「보안」 섹션 선점 순서 조율(먼저 머지되는 쪽이 섹션을 만든다) |
| **W-2** | 웹·데스크탑 | `PasswordHelpScreen`에 「복구 코드가 있어요」 항목·재설정 폼(`ClaimHostGate` 재사용)·성공 뒤 새 코드 화면(L11 D) | M | 1 | R-2, C-1 (U-2 #4601은 착륙됨) |
| **P-1** | 폰 | 설정 비밀번호 영역의 복구 코드 행·한 번 보기(공유·저장)·가입 직후 카드 | M | 1 | R-1, C-1, **U-6(#4605)** |
| **P-2** | 폰 | 로그인 폼 안내의 코드 항목·재설정 폼·성공 뒤 새 코드 화면 | M | 1 | R-2, C-1, **U-7(#4606)** |
| **O-1** | ops | 켜기 절차: 스위치 값 확인(oort-team)·셀프호스트 env 예시·운영자 문서 한 줄. 「구현 머지 ≠ 켜기」 | S | 2 | R-2 검수 PASS + **격리 스택 e2e 증거(만들기 → 복구 → 이전 세션·개발자 토큰 거절 → 새 코드)** + owner 승인(#4488과 같은 절차) |
| **N-1** (후속) | 서버+화면 | 코드를 만들거나 바꿀 때 그 멤버의 **다른 기기**에 알림(NIST §4.2.3, T4·T11) | M | 2 | R-1. 켜기 조건에 넣을지는 owner |

- **병행**: R-1과 C-1은 병행한다. R-2는 R-1 뒤다(같은 migration과 `end_member_sessions_in_tx`를 만진다). W-1·W-2는 R·C 뒤에 병행한다. 폰은 U-6·U-7이 착륙한 뒤에만 시작한다(그 화면이 아직 없다). **Q4 결정은 R-1 시작 전에 받는다**(2안이면 소각 술어의 모양이, 1안이면 PATCH 응답 계약과 D3 성공 화면이 달라진다).
- **범위 제안**: 첫 승격에는 R-1·R-2·C-1·W-1·W-2까지가 현실적이고 폰(P-1·P-2)은 U-6·U-7 착륙 뒤 다음 판이다. 폰 사용자는 그동안 서버 웹 화면에서 코드를 쓸 수 있다 [추정, 서버가 웹을 서빙하는 구성 한정].
- **다른 이슈에 전할 것**: E-5(#4597)에 「계정 축 쓰로틀 범위에 복구 코드 만들기의 비밀번호 재확인을 더한다」(L8). #3048(PK-P4)·#4600(U-1)에 「보안」 섹션에 복구 코드 행이 들어온다. #4598(E-6)에 D5 3번 항목이 이 증보로 부분적으로 닫혔다는 점. #4600(U-1)·#4605(U-6)에는 「비밀번호 변경 확인창·성공 화면에 복구 코드 문구가 더해진다」(Q4 추천안).
- **Accepted 뒤 문서 변경**(작은 문서 PR): D1에 역방향 줄, D5 목록에 코드 항목, D10에 「알림은 N-1」과 「E-5 범위에 재확인 추가」, ADR-0195 D-8의 복구 순서에 한 칸, `docs/security/claims.yaml`의 새 항목은 R-1·R-2가 올린다. D3의 변경 확인창·성공 화면에 복구 코드 문구(Q4 추천안), D4의 「변경·재설정이 끝내는 것」에 코드 소각 한 줄.

### 위험과 미검증 (증보 3)

- **가용성 [추정].** 코드를 만들어 두지 않은 멤버는 이 길이 없다. 도달률은 가입 직후 안내(Q2)가 좌우한다. 혼자 쓰는 셀프호스트의 owner가 가장 필요한 사람이므로 그 사람에게 안내가 닿아야 이 증보의 존재 이유가 선다.
- **코드 유출은 곧 계정 탈취다**(T1). 소지 증명이라 사람의 확인이 없다. 알림이 없어(T11) 유출을 소유자가 모르면 쓰인 뒤에야 안다.
- **탈취 뒤 교체와 심기**(T4). 비밀번호와 세션을 둘 다 가진 쪽이 코드를 바꾸면 소유자의 종이 코드가 죽고 자기 코드를 심을 수 있다. 소유자가 비밀번호를 바꾸거나(본인 변경 포함) 다른 길(관리자·기기)로 복구하면 심긴 코드가 소각된다(L6, Q4 추천안). 소유자가 비밀번호도 바꾸지 않고 설정 행도 보지 않으면 남는다(알림 없음).
- **NIST와 어긋나는 곳** 둘(이 증보는 NIST 준수를 주장하지 않는다): ① §3.2.2의 계정당 연속 실패 상한을 글자 그대로 세지 않는다(L8: 계정이 없어서 세지 못한다. 목적은 코드 공간으로 채운다). 인용한 §3.1.2.2의 시도 제한 요구는 112비트 **미만**의 룩업 비밀에 거는 것이라 120비트 코드에는 해당하지 않을 수 있다(보수적 표기, 원문 재대조는 하지 않았다). ② §4.2.3의 복구 알림이 없다(T11, N-1).
- **IP 예산은 예의 한도일 뿐이다**(L8): 첫 `X-Forwarded-For` 홉을 믿어(F10) 우회될 수 있고 프로세스 안이라 레플리카가 N개면 N배다. 추측 방어는 코드 공간이고 배타 잠금 반복의 방어는 코드 확인 뒤의 멤버 단위 상한이다. 프록시가 첫 홉을 덮는지 덧붙이는지는 확인하지 못했다(`runtime-unverified`).
- **응답이 중간에 끊기면** 새 코드를 못 본 채 행만 남는다. 설정 행이 「있음」으로 보이므로 「새 코드로 바꾸기」가 복구다(L5).
- **잠금 순서 [추정].** 코드 행 → `human` 행 → sweep 순서가 D7(E-3)과 정합한다는 것은 코드 읽기로만 확인했다. E-3 착륙 때 다시 본다(수용 4i의 D7 쌍).
- **입력 부담**: 24자는 길다. 실제로 종이에서 치는 비율은 모른다 [추정]. 보고가 쌓이면 코드 길이를 다시 본다(후속 2).
- `runtime-unverified`: 이 증보의 모든 시험, 24자 입력의 실제 부담, 폰 클립보드의 범용 노출, 확률 수치([추정] 표시), 서버가 웹 화면을 서빙하는 구성에서의 폰 우회, 프록시의 `X-Forwarded-For` 처리, 실시간(Centrifugo) 연결 토큰의 수명(복구 뒤 이미 발급된 연결 토큰이 얼마나 남는지).

### 후속 (증보 3)

1. N-1 알림이 생기면 1Password식 대기(만든 뒤·최근 로그인 뒤)와 쓴 사실의 알림을 다시 본다.
2. 입력 부담 보고가 쌓이면 코드 길이를 다시 본다. 112비트 아래로는 내리지 않고, 내려야 한다면 이메일 + 계정 축(E-5)과 소금·후추를 함께 연다(기각 대안).
3. 팀 서버 관리자가 멤버의 코드를 끄는 워크스페이스 정책은 요청이 올 때 연다.
4. E-5가 착륙하면 L8의 NIST 어긋남을 다시 본다. D7(E-3)이 착륙하면 L5의 잠금 순서를 다시 본다.
5. 패스키 전용 계정(비밀번호 없음)의 복구는 ADR-0195의 별도 결재다. 이 증보의 코드는 비밀번호가 있는 계정만 갖는다.
6. Q4에서 2안을 고른 뒤 변경마다 코드가 죽는 불편이 보고되면 1안(코드 유지 + 건너뛸 수 없는 상태 단계)을 다시 본다.
