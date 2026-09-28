# ADR-0195: 패스키 로그인 — 비밀번호에 추가, 웹 먼저, 앱은 시스템 브라우저 + 교환권

- Status: **Accepted** (2026-09-28 성재 결재. 근거는 아래 인용)
- Date: 2026-09-28
- Deciders: 성재
- 결재 인용: 성재 2026-09-28 「결재 승인할게」. 패스키 로그인 결재 브리프 §5 Q1~Q10 권장안 전부다. 결재 페이지는 https://claude.ai/artifact/5KRgGFCCsDGRx6hXC9Xy7t 이다. 발제는 성재 2026-09-28 「패스키나 그런거 사용도 고려해주고. 요즘 패스키 로그인도 꽤 유용한 거 같더라고.」(#3031)
- 미정: **팀 인스턴스의 최종 도메인.** 켜기 전에 owner가 정한다(D-12).
- 기안: Opus 5.5 worker(#3044)
- 근거 자료: 브리프 `claudedocs/passkey-login/brief.md`. gitignore 대상이라 로컬에만 있다. 이 ADR이 결정에 필요한 사실과 근거(file:line)를 옮겨 담는다.
- 관계: ADR-0100(공개 API·보안 경계·DB 계약은 Accepted ADR이 머지 조건), ADR-0146 개정 2026-09-28 D-4(R2 기기 키와 역할 분리), ADR-0180(QR 기기 연결, 교환권 모양), ADR-0166(첫 소유자 claim, definer 조회 선례), ADR-0167(same-origin·`--public-origin`), ADR-0187(목표 A), ADR-0004(자격 원문 비유입)
- 표기: [V] 1차 출처 원문 확인 · [S] 검색 결과나 요약으로만 확인 · [?] 확인 못 함 · `runtime-unverified` 실측 안 함. 코드 근거는 main `f3f6f80d` 기준이고, track/engine `09a74aaf`에서 줄 번호가 달라진 곳은 그 값을 적었다.

## 맥락

지금 oort 로그인은 **워크스페이스별 이메일+비밀번호** 하나다. 그 옆에 QR 기기 연결, 초대 가입, 첫 소유자 claim, 운영자가 대역 외로 전달하는 재설정 링크가 있다. 매직링크·메일 발송기·2단계 인증·패스키는 없다.

패스키는 웹에서는 바로 쓸 수 있다. 셀프호스트 웹은 Caddy가 SPA와 API를 같은 오리진으로 서빙하므로 공개 호스트를 그대로 RP ID로 쓰면 된다. 앱 안에서는 쓸 수 없다. 데스크탑은 번들 오리진(`tauri://localhost`)이라 규격상 불가능하고, iOS 네이티브 API는 앱에 미리 적은 도메인에서만 동작하는데 셀프호스트 도메인은 빌드 때 알 수 없다.

### 현재 사실 (코드·문서)

| # | 사실 | 근거 |
|---|---|---|
| F1 | 공개 인증 라우트는 `login`·`refresh`·`logout`이다. 인증 미들웨어 밖에 있다 | `server-rust/bins/momo-server/src/lib.rs:1285-1287` |
| F2 | 로그인은 **워크스페이스 단위** 이메일+비밀번호다. 워크스페이스를 비우면 데모 워크스페이스로 간다. 비밀번호는 Postgres `momo_password_verify`(pgcrypto/bcrypt)로 tenant tx 안에서 검증한다 | `bins/momo-server/src/routes/auth_routes.rs:9-27`, `:339-345`, `:346-383` |
| F3 | access 15분, refresh 30일이다. refresh마다 새 쌍을 발급한다(1회용 회전). 쓰는 동안 재로그인은 드물다 | `crates/momo-auth/src/issue.rs:23`, `:25`, `auth_routes.rs:28-40` |
| F4 | 비밀번호 재설정은 owner/admin이 발급하는 링크다. **메일 발송기가 없어서** 운영자가 대역 외로 전달한다. 본인 변경에는 현재 비밀번호가 필요하다 | `routes/password.rs:1-9` |
| F5 | 첫 소유자는 1회용 claim 토큰으로 비밀번호를 만든다(`POST /v1/claim`) | `routes/claim.rs:1-30`, ADR-0166 |
| F6 | 폰은 로그인된 기기의 QR(120초·1회용·해시 저장·공개 오리진에서만 SAS)로 연결한다. 연결 기기 목록과 폐기가 있다 | `lib.rs:855-874`, `:1381`, ADR-0180 D1~D5 |
| F7 | 공개(비인증) 쓰기 경로는 **EXECUTE 전용 definer 함수로 워크스페이스를 먼저 찾고** 나서 tenant tx를 연다. 클라이언트가 보낸 워크스페이스 id는 믿지 않는다 | `routes/join.rs:20-31`(`momo_join_private.invite_workspace_id`, `server/Migrations/009_workspace_tenant_rls.sql`), `routes/claim.rs:13-20`(`server/Migrations/078_owner_claim.sql:46-66`) |
| F8 | 매직링크·TOTP·MFA·WebAuthn·패스키 흔적은 코드와 문서에 없다(ADR-0146 D-4의 역할 분리 문장 제외) | `git grep -niE 'magic.?link\|totp\|webauthn\|passkey\|mfa\|2fa'` 0건(해시 오탐 제외) |
| F9 | 데스크탑(Tauri)은 **번들된 웹 dist를 로드**한다. 딥링크 스킴은 `oort`·`momo`다 | `clients/desktop/src-tauri/tauri.conf.json:10`, `:37`, `src-tauri/src/deeplink.rs` |
| F10 | 데스크탑 entitlement는 마이크 하나, iOS entitlement는 APNs·App Group·키체인 공유 그룹이다. **둘 다 associated-domains가 없다** | `clients/desktop/src-tauri/Entitlements.plist`, `clients/mobile/ios/MomoMobile/MomoMobile.entitlements` |
| F11 | 셀프호스트 웹은 Caddy가 SPA와 `/v1`을 **같은 오리진**으로 서빙한다(Railway 포함) | `infra/railway/README.md:34`, `:47`, `docs/SELF_HOST.ko.md:514`, `:744-748` |
| F12 | 운영자가 선언하는 공개 주소는 `MOMO_PUBLIC_BASE_URL`(기존 env)이다. 기존 접근자 `ready_public_base_url()`은 절대 https만 받고, 선언이 없으면 초대 링크는 요청 `Host`로 대신 만든다. `--public-origin`은 Caddy 사이트 주소·CSP·Centrifugo를 파생하지만 이 값은 쓰지 않는다. Railway는 `RAILWAY_PUBLIC_DOMAIN`이다 | `bins/momo-server/src/config.rs:1513-1515`, `:1542`, `:1562-1570`, `routes/approvals.rs:1265-1291`, `main.rs:128-142`, `docs/SELF_HOST.ko.md:721-748`, `:797` |
| F13 | 팀 인스턴스는 Railway가 기본이다. `app.oor7.com`은 ADR-0187 작성 시점에 해석되지 않았다 | `docs/adr/0187-goal-a-team-daily-desktop-ios.md:32`, `:55-62` |
| F14 | 라이선스 게이트는 MPL-2.0을 전역으로 허용한다(데스크탑 그래프의 Servo CSS 크레이트 때문). 주석에 **「server-rust has ZERO MPL crates; the backbone stays fully permissive」**라고 적혀 있다. 그래프별 강제는 없고 주석뿐이다 | `deny.toml:80-90` |
| F15 | server-rust에는 OpenSSL이 없다(`Cargo.lock`에 `openssl*` 0개). `ed25519-dalek 2.2`·`ring 0.17`·`rsa 0.9.10`은 이미 있다. `p256`과 CBOR 크레이트는 없다 | `server-rust/Cargo.lock:424`, `:2064`, `:2078` |
| F16 | R2(같은 날 Accepted): 사람 지시 서명은 기기에 묶인 Secure Enclave P-256이고, 웹은 지시하지 않는다. 로그인 패스키는 동기화되는 자격증명이라 R2 키와 같은 키가 아니다. P-256 검증 직접 의존은 R2-E1(#3021)이 들인다 | ADR-0146 개정 2026-09-28 D-1, D-4 |
| F17 | migration은 track/engine에서 093(`provider_default_ai`, #3009)까지 있다. R2가 094(E2 #3022)·095(E3 #3023)를 예약했다 | `server/Migrations/093_provider_default_ai.sql`, ADR-0146 개정 「DB 계약」 |

### 외부 사실 (규격·플랫폼·라이브러리)

| 항목 | 사실 | 확인 | 출처 |
|---|---|---|---|
| RP ID 범위 | RP ID는 오리진의 effective domain과 같거나 그 registrable 접미사여야 한다. **오리진은 `https`이거나, 호스트가 정확히 `localhost`인 `http`여야 한다.** 포트는 상관없다 | [V] | W3C WebAuthn `index.bs:1308-1320` — https://github.com/w3c/webauthn/blob/main/index.bs , https://www.w3.org/TR/webauthn-3/ |
| IP 금지 | create 알고리즘: effective domain이 valid domain이 아니면 SecurityError. **IPv4·IPv6 주소는 허용되지 않는다.** 불투명 오리진은 NotAllowedError다 | [V] | 같은 파일 `:1794-1804` |
| BE/BS 플래그 | 인증기 데이터에 백업 가능(BE)·백업 상태(BS)가 실린다. 서버는 동기화 패스키인지 알 수 있다 | [V] | https://www.w3.org/TR/webauthn-3/ §4 |
| `user.id` | 최대 64바이트, 사용자에게 보이지 않는다. RP ID는 스킴·포트를 담지 않는다 | [V] | https://developer.mozilla.org/en-US/docs/Web/API/PublicKeyCredentialCreationOptions |
| Related Origin Requests | `https://{RP ID}/.well-known/webauthn`에 허용 origin 목록을 두면 다른 도메인에서도 그 패스키를 쓴다. 라벨 5개까지(Chrome), 넘치면 조용히 무시 | [V] | https://web.dev/articles/webauthn-related-origin-requests , https://passkeys.dev/docs/advanced/related-origins/ |
| ROR 지원 | Chrome/Edge 128+, Safari 18+는 [S]. **Firefox는 출처끼리 충돌한다**: web.dev 「2026-01 현재 검토 중」[V] vs 검색 요약 「Firefox 152(2026-05) 탑재」[S] | [V]/[S] 충돌 | 위 web.dev, https://www.corbado.com/blog/webauthn-related-origins-cross-domain-passkeys |
| Public Suffix List | `up.railway.app`·`ts.net`·`trycloudflare.com`·`fly.dev`·`onrender.com`은 공개 접미사다. `<이름>.up.railway.app` 자체가 registrable domain이라 RP ID는 **호스트 전체**여야 한다 | [V] | https://publicsuffix.org/list/public_suffix_list.dat (2026-09-28 받음) |
| iOS/macOS WKWebView | 임베디드 웹뷰는 호출 앱의 맥락에서 돌아서 **앱에 연결된 도메인의 패스키만** 만들고 쓴다 | [V] | https://passkeys.dev/docs/reference/ios/ , https://passkeys.dev/docs/reference/macos/ |
| `ASWebAuthenticationSession` | Safari에서 되는 웹 기능은 WebAuthn을 포함해 모두 된다. macOS에서는 기본 브라우저를 띄운다(macOS 13 기준) | [V] | 같은 두 문서 |
| 커스텀 스킴 콜백 | `ASWebAuthenticationSession`은 빌드 때 정한 스킴으로 돌아온 URL을 호출자에게 직접 건넨다. 서버 설정은 필요 없다. 자체 서명 인증서는 처리하지 못한다 | [S] | https://developer.apple.com/forums/thread/658334 , https://github.com/home-assistant/iOS/issues/4661 |
| 네이티브 패스키 API | `relyingPartyIdentifier`는 Associated Domains `webcredentials:` 항목과 정확히 같아야 한다. 도메인은 AASA를 HTTPS로 리다이렉트 없이 서빙해야 한다 | [S] | https://developer.apple.com/documentation/authenticationservices/asauthorizationplatformpublickeycredentialprovider |
| 브라우저 entitlement | `com.apple.developer.web-browser.public-key-credential`은 웹 브라우저 앱용이고 신청이 필요하다. 메신저 앱은 해당하지 않는다 | [S](Apple 문서 본문 렌더링 실패) | https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.web-browser.public-key-credential |
| Tauri | 「Passkeys auth support in WebView」 이슈가 열려 있다(2023-09). 원격 오리진을 로드하는 창에 Associated Domains를 넣은 사례는 있으나 번들 오리진에는 해당하지 않는다 | [V] 이슈 · [S] PR | https://github.com/tauri-apps/tauri/issues/7926 , https://github.com/dali-lab/dali-os/pull/1806 |
| `webauthn-rs` 0.5.5 | **MPL-2.0**. `webauthn-rs-core`가 `openssl`·`openssl-sys`에 **비선택으로** 의존한다. 2026-04-30 배포, 누적 약 720만 다운로드 | [V] crates.io API | https://crates.io/crates/webauthn-rs |
| `webauthn-rp` 0.3.0 | MIT OR Apache-2.0, RustCrypto 기반 검증 전용. **마지막 배포 2025-04-03, 역의존 0, 관리자 1명** | [V] crates.io API · [S] docs.rs | https://crates.io/crates/webauthn-rp |
| `passkey`(1Password) | MIT OR Apache-2.0, 클라이언트·인증기 쪽이다. RP 검증은 범위 밖 | [V] | https://github.com/1Password/passkey-rs |
| `p256` 0.14.0 | Apache-2.0 OR MIT, 2026-07 배포 | [V] crates.io API | https://crates.io/crates/p256 |
| `ciborium` 0.2.2 | Apache-2.0 CBOR 크레이트 | [V] crates.io API | https://crates.io/crates/ciborium |
| `minicbor` 2.3.0 | **BlueOak-1.0.0**이라 `deny.toml` 허용 목록에 없다 | [V] crates.io API | https://crates.io/crates/minicbor |

### 업계 사례

| 제품 | 사실 | 확인 | 출처 |
|---|---|---|---|
| GitHub | 2023-09-21 GA. 패스키 하나가 **두 인증 요소를 한 번에** 충족해서 2FA를 따로 하지 않는다. 여러 개 등록 | [V] | https://github.blog/changelog/2023-09-21-passkeys-are-generally-available/ |
| Slack | 로그인 도움말에 패스키 로그인과 계정 설정의 패스키 추가·삭제가 있다 | [V] | https://slack.com/help/articles/212681477-Sign-in-to-Slack |
| Linear | 2024-05-30. 이메일·SSO에 **추가**하는 수단, 기기 여러 개 등록, 웹·모바일 먼저 | [S] | https://linear.app/changelog/2024-05-30-passkeys-a-fast-and-secure-way-to-log-in-to-linear |
| Rocket.Chat(셀프호스트) | 모바일 4.74.0(2026-07-01): **시스템 브라우저 세션으로 인증을 열어** 패스키 지원 | [V] | https://docs.rocket.chat/docs/mobile-release-notes |
| Zulip(셀프호스트) | 인증 수단에 패스키·WebAuthn이 없다 | [V] | https://zulip.readthedocs.io/en/latest/production/authentication-methods.html |
| Home Assistant iOS(셀프호스트) | 「셀프호스트 인스턴스에는 Associated Domain이 없어 키체인 패스키가 뜨지 않는다」, `ASWebAuthenticationSession` 전환 제안(2026-05, not planned) | [V](요약 도구 경유) | https://github.com/home-assistant/iOS/issues/4661 |
| Mattermost(셀프호스트) | 모바일 WKWebView에서 `navigator.credentials`를 못 써 WebAuthn 2FA가 막힌다는 이슈. 서버 패스키 로그인은 찾지 못함 | [S] / [?] | https://github.com/mattermost/mattermost-mobile/issues/5122 |

셀프호스트 앱의 공통 걸림돌은 「앱 빌드는 인스턴스 도메인을 모른다」이고, 해법은 모두 시스템 브라우저다.

## 결정

### D-1. 도입과 시점 (Q1-B)

- ADR은 지금 Accepted로 고정한다. **구현(P1~P8)은 목표 A 필수 경로(Railway 팀 인스턴스·실기기 푸시·R2) 뒤에 한 묶음으로** 넣는다.
- 이유: 재로그인이 드물다(F3 refresh 30일 회전, 폰은 QR 연결 F6). 먼저 방향을 고정해 R2·도메인 결정과 충돌하지 않게 한다.

### D-2. 비밀번호에 추가한다 (Q3-A)

- 패스키는 비밀번호를 **대체하지 않고 추가**한다. 비밀번호·재설정 링크(F4)·claim(F5)은 그대로다.
- 「이 계정은 비밀번호 로그인 끄기」(패스키 전용 계정)는 외부 출시 때 따로 결재한다.

### D-3. 표면 — 웹 먼저, 앱은 시스템 브라우저 + 교환권 (Q2-A)

- **1단계 웹.** SPA가 WebAuthn을 직접 부른다(로그인 화면 「패스키로 로그인」 + 조건부 UI 자동완성).
- **2단계 데스크탑·iOS.** 앱은 서버 오리진의 「앱 로그인」 페이지를 시스템 브라우저로 연다(iOS·macOS는 `ASWebAuthenticationSession`, 안 되면 기본 브라우저). 성공하면 1회용 교환권이 `oort://auth?...`로 돌아오고 앱이 교환한다(D-7).
- 앱 네이티브 API + Associated Domains(Q2-B)는 기각한다. 한 도메인에서만 되고 도메인을 바꾸면 앱을 다시 배포해야 한다. 외부 출시 때 「기본 호스팅 도메인」이 생기면 다시 검토한다.
- 앱 경로는 **runtime-unverified**다. 자체 서명 인증서 인스턴스에서는 안 된다[S].

### D-4. RP ID — 운영자가 선언한 공개 오리진의 호스트 전체 (Q4-A)

- RP ID는 **`MOMO_PUBLIC_BASE_URL`(기존 env, F12)의 호스트 전체**다. 새 env는 없다. 기대 origin은 그 값의 스킴·호스트·포트 그대로다.
- 켜지는 조건은 규격 그대로다: `https://<도메인>`이거나 `http://localhost[:port]`. 이 판정은 패스키 전용 해석이다. 기존 `ready_public_base_url()`(https만)의 의미는 바꾸지 않는다.
- **꺼지는 조건:** 공개 오리진 미선언, 호스트가 IP 주소, 그 밖의 http. 이때 서버는 기능 꺼짐을 광고하고 웹은 버튼을 숨기고 이유를 한 줄로 알린다. **요청 `Host`로 추측하지 않는다**(퀵 터널처럼 재시작하면 바뀌는 주소 때문). 초대 링크의 Host 폴백(F12)과 다른 점이다.
- 자격 증명 **행마다 `rp_id`를 저장한다.** 현재 RP ID와 다른 행은 로그인 후보에서 빼고, 조용히 실패하지 않고 「이 주소에서 다시 등록」을 안내한다. 비밀번호가 늘 남아 있다(D-2).
- 운영자가 상위 도메인을 지정하는 방식(Q4-B)은 넣지 않는다. PSL 호스팅(Railway 등)에서 불가능하고 설정 실수가 전부 실패로 이어진다.
- Related Origin Requests(Q4-C)는 기본 기능이 아니다. 도메인을 이전할 때의 선택지로 운영 문서(P8)에만 적는다.

### D-5. 식별자 없는 로그인 + EXECUTE 전용 definer 조회 (Q5-A)

- 로그인은 **discoverable credential**(식별자 없는 로그인, 조건부 UI)이다. 이메일·워크스페이스를 먼저 묻는 방식(Q5-B)은 A가 안 되는 브라우저의 대체 경로로만 둔다.
- 패스키 로그인은 워크스페이스를 모른 채 `credentialId`만 들고 온다. 그래서 **EXECUTE 전용 definer 함수** `momo_join_private.webauthn_credential_workspace_id(credential_id bytea) → uuid`로 워크스페이스를 먼저 찾고, 나머지(공개키 조회·서명 검증·signCount 갱신·세션 발급·감사)는 그 워크스페이스의 tenant tx에서 한다.
- 함수 모양은 078 선례(`server/Migrations/078_owner_claim.sql:46-66`)와 같다: `STABLE STRICT SECURITY DEFINER`, `SET search_path = pg_catalog`, uuid 하나만 돌려주고 행 데이터는 돌려주지 않는다, 삭제된 워크스페이스는 제외, `REVOKE ALL … FROM PUBLIC` 뒤 `momo_app`에만 EXECUTE.
- `webauthn_credential.credential_id`는 **전역 UNIQUE**다(워크스페이스별이 아님). 그래야 definer 조회가 정확히 한 워크스페이스를 가리킨다. 등록 때 충돌하면 거부한다.
- 클라이언트가 보낸 워크스페이스 id는 받지 않는다(F7과 같은 규율). `user.id`는 member uuid(16바이트)이고, `user.name`은 「이메일 · 워크스페이스명」으로 선택 창에서 구분한다.

### D-6. challenge — 테넌트 밖, 짧은 수명, 1회 소비

- 로그인 challenge는 발급할 때 워크스페이스가 없다. 그래서 **테넌트 밖 테이블 `webauthn_challenge`**에 둔다. 서명 상태 토큰 방식은 쓰지 않는다(1회 소비를 DB로 보장하려고).
- 컬럼은 challenge 해시·용도(등록/로그인)·만료·소비 시각뿐이다. **`workspace_id`·`member_id`·자격 원문 등 테넌트 데이터를 담지 않는다.** TTL은 **5분**, 검증 tx에서 `UPDATE … WHERE consumed_at IS NULL AND expires_at > now() RETURNING`으로 1회 소비한다. 만료 행은 주기적으로 지운다.
- 등록 challenge는 로그인된 세션에서 발급되므로 워크스페이스를 안다. 그래도 같은 테이블·같은 규칙을 쓰고, 등록 완료는 tenant tx에서 한다.
- 공개 begin/finish 라우트는 per-IP 레이트리밋을 둔다(`/v1/join`·device-link redeem 선례).

### D-7. 앱 교환권 — ADR-0180 모양 + PKCE 결속 (Q7)

- 교환권은 ADR-0180 D1·D3 토큰 모양을 그대로 따른다: **TTL 120초, 1회 소비, 해시 저장, 원문은 응답(리다이렉트 URL)에만 실리고 로그·감사·진단 번들에 남지 않는다**(ADR-0004). 교환권 자체로는 어떤 API도 부를 수 없다.
- **PKCE식 결속(S256).** 앱이 브라우저를 열기 전에 verifier를 만들고, 그 SHA-256 해시를 「앱 로그인」 URL에 싣는다. 서버는 브라우저 패스키 로그인이 성공하면 그 해시에 결속된 교환권을 발급해 `oort://auth?server=…&code=…`로 돌려준다. 교환할 때 verifier가 맞아야 한다. 그래서 `oort://` 콜백 URL만 가로챈 다른 앱은 교환하지 못한다.
- 교환 라우트는 공개(인증 미들웨어 밖)이고 per-IP 레이트리밋을 둔다. 교환에 성공하면 기존 `issue_and_record_session`(`auth_routes.rs:146`)으로 `LoginResponse`와 같은 모양의 세션을 발급한다. 감사에 로그인 방법 `passkey`를 적는다.
- 발급자는 **브라우저의 패스키 로그인 성공 그 자체**다. 로그인된 세션이 교환권을 따로 찍어 내는 경로는 만들지 않는다(그건 ADR-0180 QR 경로다).
- `oort://auth` 형식은 P6이 `docs/onboarding-deeplink.md`에 절로 더한다.

### D-8. 등록·목록·삭제·감사·운영자 일괄 폐기·복구 (Q6)

- **등록:** 로그인된 사람 세션에서, **최근 5분 안에 재인증(현재 비밀번호 또는 기존 패스키)**한 경우에만 받는다. 세션 bearer만으로 추가하면 탈취 세션이 영구 뒷문을 만든다. user verification은 `required`. 에이전트 세션은 등록할 수 없다(`require_human`).
- **표시·삭제:** 설정 › 보안에 이름·등록일·마지막 사용·동기화 여부(BE/BS)를 보이고 하나씩 삭제한다.
- **감사:** 등록·삭제·로그인을 `audit_event`에 남긴다. 다른 세션에는 앱 안 알림으로 알린다(메일 발송기가 없다, F4).
- **운영자 일괄 폐기:** owner/admin은 멤버의 패스키를 모두 폐기할 수 있다. 권한은 비밀번호 재설정 발급(F4)과 같다.
- **분실·복구:** 비밀번호 로그인 → 운영자 재설정 링크(F4) → 로그인된 다른 기기의 QR(F6) 순서다. 모든 수단을 잃으면 운영자 재설정에 의존한다(현상 유지).
- **동기화 패스키 허용**(iCloud 키체인·1Password). 로그인용이라 동기화는 장점이다. R2와 다른 점이다(D-9).

### D-9. 서버 검증기 — `momo-auth` 안의 자체 최소 검증기 (Q8-C)

- attestation은 **`none`만** 받는다. 알고리즘은 **ES256(-7) 필수, EdDSA(-8)·RS256(-257)** 수용.
- 규격 §7.1(등록)·§7.2(인증) 단계를 그대로 옮긴다: type·challenge·origin·rpIdHash·UP/UV 플래그·signCount·서명.
- **signCount 규칙:** 저장값과 받은 값이 둘 다 0이면 비교를 생략한다(Apple 등 동기화 패스키는 0 고정). 하나라도 0이 아닌데 감소·정체면 거부하고 감사에 남긴다. 규격 §7.2 허용 범위 안의 선택이고 P2가 음성 시험으로 고정한다.
- 새 의존은 `p256`(Apache-2.0 OR MIT)과 `ciborium`(Apache-2.0, COSE 키 해석)이다. `ed25519-dalek`·`rsa`는 이미 트리에 있다(F15). `p256`은 R2-E1(#3021)이 먼저 들이면 그것을 재사용하고, 새 의존은 NOTICE에 반영한다. `minicbor`는 BlueOak라 쓰지 않는다.
- **기각: `webauthn-rs`.** MPL-2.0이고 OpenSSL을 비선택으로 끌어온다. 「server-rust has ZERO MPL crates; the backbone stays fully permissive」(`deny.toml:80-90`) 기록을 깨고, OpenSSL이 없는 서버 빌드(F15)에 C 의존을 들인다. 게이트는 MPL을 전역으로 허용해서 막지 못하지만(F14), 막히지 않는다는 것이 방침을 따른다는 뜻은 아니다.
- **기각: `webauthn-rp`.** permissive지만 마지막 배포 2025-04, 역의존 0, 관리자 1명이다. 보안 경계 의존으로 공급망 위험이 크다.
- 암호 경계 코드를 직접 소유하므로 **규격 단계별 음성 시험, 실기기 픽스처(iPhone Face ID·맥 Touch ID·Chrome·1Password), 독립 보안 검수**가 머지 조건이다.
- 부수: 「server-rust MPL 0개」를 주석이 아니라 게이트로 강제하는 일(그래프별 `cargo deny` 예외)은 별도 엔진 이슈다. 이번 범위가 아니다.

### D-10. 패스키 단독 강한 로그인, TOTP는 범위 밖 (Q9-A)

- 패스키(UV required)는 **단독으로 강한 로그인**이다. 비밀번호와 묶어 2단계로 쓰지 않는다.
- TOTP 등 2FA는 이번 범위에 넣지 않는다. 비밀번호 로그인은 1요소 그대로다(현상 유지). 「비밀번호 로그인에 2단계 강제」는 외부 출시 보안 검수 때 따로 결재한다.

### D-11. R2 기기 키와 분리 (Q10-A)

- 로그인 패스키는 **동기화되는 로그인 수단**이고 결과는 평범한 세션이다. R2 키는 **기기에 묶인 Secure Enclave P-256 지시 서명 키**이고 신뢰의 뿌리는 host 맥 데스크탑 앱이다(ADR-0146 개정 D-1~D-3).
- 패스키로 로그인한 세션도 지시하려면 R2 기기 키가 따로 필요하다. 웹 세션은 여전히 지시하지 않는다(ADR-0146 개정 D-4).
- 패스키로 R2 지시 서명을 대신하는 방식(WebAuthn 거래 확인)은 기각한다. 동기화 패스키는 기기별 폐기와 맞지 않고, clientDataJSON 모양이 `momo.human.control.v1`과 다르다. ADR-0146 D-4가 외부 출시 때 다시 결재하기로 한 항목이다.
- 공유하는 것은 `p256` 검증 의존과 「연결 기기·보안」 설정 화면의 자리뿐이다. 설정에서 「로그인 패스키」와 「지시 기기 키」는 다른 섹션이다.

### D-12. 켜기 전제

- 구현은 목표 A 필수 경로(Railway 팀 인스턴스·실기기 푸시·R2) 뒤에 시작한다(D-1).
- 팀 인스턴스에서 켜기 전에 **owner가 최종 도메인을 정한다**(`*.up.railway.app` 유지 또는 `app.oor7.com` 등, F13). `*.up.railway.app`에서 켠 뒤 커스텀 도메인으로 옮기면 팀 전원이 다시 등록해야 한다(D-4).
- 켤 때 그 인스턴스의 `MOMO_PUBLIC_BASE_URL`을 최종 도메인으로 설정한다. Railway 생성기가 이 값을 내지 않으므로(F12) 설정 방법은 P8 운영 문서에 적는다.

## 불변식과의 관계 (AGENTS.md RLS)

- **「모든 테넌트 경로는 `workspace_id` + RLS FORCE + tx마다 `SET LOCAL app.workspace_id`」는 그대로다.** `webauthn_credential`은 테넌트 테이블이라 RLS FORCE와 `ws_isolation` 정책 대상에 넣는다.
- 워크스페이스를 모르는 로그인 전 단계는 **새 예외가 아니라 기존 선례(009 `invite_workspace_id`, 078 `owner_claim_workspace_id`)와 같은 좁은 문**이다. definer 함수는 `credential_id → workspace_id` 하나만 풀고 행 데이터를 돌려주지 않으며, `momo_app`만 EXECUTE한다. 그 뒤 모든 읽기·쓰기는 `with_tenant_tx` 안이다.
- `webauthn_challenge`는 테넌트 테이블이 아니다. 테넌트 식별자·멤버·자격 원문을 담지 않고 해시·용도·만료·소비만 담는다(D-6). 그래서 RLS 정책 대상 목록에 넣지 않으며, 이 ADR이 그 판단의 근거다. 테넌트 데이터를 이 테이블에 더하려면 이 ADR을 개정해야 한다.
- 쓰기 경로 BYPASSRLS는 쓰지 않는다. 관리자 연결·전 테넌트 폴링 예외(relay·agent-worker)를 늘리지 않는다.
- `schema_v0.sql`은 건드리지 않는다. 모든 스키마는 새 migration이다.

## 새 공개 API 선언 (ADR-0100)

아래 라우트는 이 ADR을 Accepted 근거로 삼는다. 경로 이름·본문 모양·OpenAPI는 각 구현 이슈가 확정한다.

| 표면 | 내용 | 인증 | 이슈 |
|---|---|---|---|
| 기능 광고 | 패스키 사용 가능 여부와 꺼진 이유(미선언·IP·http) | 공개 | P3 #3047 |
| 등록 begin/finish | 5분 재인증 뒤 challenge 발급 → attestation `none` 검증 → 저장 | 사람 세션 | P3 #3047 |
| 로그인 begin/finish | challenge 발급 → definer 조회 → 서명 검증 → 세션 발급 | 공개, per-IP 제한 | P3 #3047 |
| 목록·삭제 | 본인 패스키 목록(이름·등록일·마지막 사용·BE/BS)과 삭제 | 사람 세션 | P3 #3047 |
| 운영자 일괄 폐기 | 멤버의 패스키 전부 폐기 | owner/admin | P3 #3047 |
| 앱 로그인 페이지 | PKCE 해시를 받는 브라우저 로그인 화면 | 공개 | P4 #3048 |
| 교환권 발급·교환 | 브라우저 패스키 로그인 성공 → 교환권 → verifier로 교환 | 발급은 로그인 성공, 교환은 공개·per-IP 제한 | P5 #3049 |

## DB 계약 (새 migration만)

- **P1 #3045**, 번호는 R2 094·095 다음(편성 시점 기준 **096**, 머지 순서에 따라 다시 매길 수 있다).
  - `webauthn_credential`: workspace_id, member_id, rp_id, credential_id(**전역 UNIQUE**), COSE 공개키, alg, sign_count, backup_eligible, backup_state, transports, label, created_at, last_used_at. **RLS FORCE + `ws_isolation` 대상.**
  - `webauthn_challenge`: challenge 해시, 용도, expires_at, consumed_at. 테넌트 밖(위 절).
  - `momo_join_private.webauthn_credential_workspace_id(bytea) → uuid`: 078 모양의 EXECUTE 전용 definer.
  - 교환권 테이블(P5 #3049): ADR-0180 `device_link_token` 모양(해시·만료·소비) + PKCE 해시 + 발급 멤버. 워크스페이스를 알므로 테넌트 테이블(RLS FORCE)이고, 공개 교환은 교환권 해시로 워크스페이스를 푸는 같은 모양의 definer를 쓴다.
- 격리 PG에서 적용 검증한다.

## 이슈 시리즈

| 단계 | 이슈 | 트랙 | 내용 | 의존 |
|---|---|---|---|---|
| P0 | #3044 | planner(docs) | 이 ADR + ADR-0146 개정·ADR-0180 역방향 줄 | 결재 |
| P1 | #3045 | 엔진 | migration — `webauthn_credential`(RLS FORCE)·`webauthn_challenge`·definer 함수 | P0 |
| P2 | #3046 | 엔진 | `momo-auth` 최소 WebAuthn 검증기(attestation none, ES256/EdDSA/RS256) + 단계별 음성 시험 | P0(P1과 병렬) |
| P3 | #3047 | 엔진 | 등록·로그인·목록·삭제·일괄 폐기 라우트(5분 재인증, 요청 제한, 감사, 비공개 오리진·IP면 꺼짐) | P1, P2 |
| P4 | #3048 | 웹 | 「패스키로 로그인」·조건부 UI·설정 › 보안 패스키 목록·앱용 브라우저 로그인 페이지. design-review Blocker 0·High 0 | P3 |
| P5 | #3049 | 엔진 | 앱 교환권 발급·교환(120초·1회·해시·PKCE 결속·요청 제한) | P3 |
| P6 | #3050 | 데스크탑 | 브라우저 경유 패스키 로그인(`ASWebAuthenticationSession` → `oort://auth` → 교환), `onboarding-deeplink.md` `auth` 절 | P4, P5 |
| P7 | #3051 | 폰 | 네이티브 모듈 `ASWebAuthenticationSession` → 교환 → 키체인. 실기기 증거 필요 | P4, P5 |
| P8 | #3052 | 엔진(docs) | 셀프호스트 문서 — 도메인 변경 재등록·ROR 선택지·LAN/IP 비활성 사유·`MOMO_PUBLIC_BASE_URL` 설정 | P3 |

- 순서: P0 → (P1 ∥ P2) → P3 → (P4 ∥ P5 ∥ P8) → (P6 ∥ P7). 한 묶음으로 승격한다.
- R2와 코드 의존은 없다. migration 번호와 `p256` 도입만 먼저 머지하는 쪽을 따른다.

## 기각 대안 (요약)

- 목표 A 안에서 바로 구현(Q1-A), 외부 출시까지 보류(Q1-C).
- 앱 네이티브 API + 팀 도메인 Associated Domains(Q2-B), 웹만(Q2-C).
- 패스키 전용 계정(Q3-B).
- 운영자 지정 상위 도메인 RP ID(Q4-B), ROR 기본 탑재(Q4-C).
- 이메일 먼저 입력(Q5-B, 대체 경로로만 유지).
- `webauthn-rs`(Q8-A), `webauthn-rp`(Q8-B).
- 비밀번호+패스키 2단계(Q9-B), TOTP 동시 도입(Q9-C).
- 패스키로 R2 지시 서명 대신하기(Q10-B).

## 위험과 미검증

- **앱 브라우저 경유 흐름은 runtime-unverified**다. Tauri에서 `ASWebAuthenticationSession`을 부르는 방법(네이티브 플러그인 필요 여부), 폰 시트 안의 iCloud 키체인 패스키 동작, 자체 서명 인증서 인스턴스의 실패 모양은 문서로만 봤다.
- **Firefox ROR 지원은 출처끼리 충돌한다**([V] 「검토 중」 vs [S] 「152 탑재」). 이 ADR은 ROR에 기대지 않는다.
- Apple `web-browser.public-key-credential` 문서 본문을 읽지 못했다[S]. 이 ADR은 그 entitlement를 쓰지 않는다.
- Linear는 changelog 요약만 확인했다[S]. Mattermost 서버의 패스키 지원 여부는 [?]다.
- **자체 검증기는 암호 경계 코드를 새로 소유한다.** 독립 보안 검수와 실기기 픽스처 없이는 머지하지 않는다(D-9).
- **이메일 없는 복구:** 메일 발송기가 없는 한, 모든 수단을 잃은 사용자는 운영자 재설정에 의존한다.
- **팀 도메인 미정(F13, D-12):** 켜기 전 owner 결정이다.
