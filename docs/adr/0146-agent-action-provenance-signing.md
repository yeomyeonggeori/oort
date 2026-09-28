# ADR-0146: 행동 provenance 서명 (buzz에서 선택 차용)

- Status: **Accepted** (2026-07-31 성재 “권고대로 진행” — 범위=3표면 + 세부 3결정 확정. 기안 Fable)
- **확정된 세부 3결정(2026-07-31)**: ①서명 페이로드 = 정규화 content+author, 서버 부여 seq는 2단계(행위자가 content 서명 → 서버가 seq 부여 후 envelope) ②행위자 단계 = **에이전트·workd 먼저**(키 보유·즉시), 사람은 device 키 결속 후 fast-follow ③UX = **초기 감사 로그·API 전용**(UI 뱃지 없음 — 부분 서명기의 “무서명=미검증” 오독 방지), 사람 서명까지 차면 뱃지 도입.
- 개정: **2026-09-28 Accepted** — 사람 기기 키 서명(R2). 결재 인용: 성재 2026-09-28 「전부 권장대로」(R2 기기 키 서명 결재 Q1~Q11·Q5-b 권장안 전부, 결재 페이지 https://claude.ai/artifact/392wQKGL3SzwfM2zNjhSpZ). 기안 Opus 5.5 worker(#3020). 근거 브리프 `claudedocs/r2-device-signing/brief.md`는 gitignore 대상이라 로컬에만 있다. 아래 「개정 2026-09-28」 절이 필요한 사실과 근거(file:line)를 그대로 옮겨 담는다. 2026-07-31 본문은 역사 기록으로 두고, 미해결 절만 고쳤다.
- 관련: **ADR-0145**(Rust/Axum 재작성 — 이 서명은 그 위에 얹힌다), ADR-0004(자격증명 비유입), ADR-0101(에이전트 신원), ADR-0139/0140(workd — 이미 Ed25519 서명 보유), `docs/architecture/invariants-in-rust.md`(D2 — 이 서명이 불변식을 안 건드림을 교차검증)
- 발단: 서버 스택 재검토에서 "oort가 buzz에서 취할 만한 한 가지 = 에이전트 행동의 암호학적 provenance"로 식별 → 성재가 B안에 포함 지시 + **범위를 "상태 전이까지 넓게"로 결정**.

## 맥락

buzz(Nostr)의 최대 강점은 **모든 행동이 서명된 이벤트 = 위·변조 내성 감사추적**이다. "이 행위자가 정말 이걸 했나"가 서버 로그 신뢰가 아니라 **서명 검증** 문제가 된다. oort는 Nostr 모델 전체(클라-서명-publish·created_at·RLS 부재)를 못 받지만(ADR-0145 스파이크), **이점 조각만 additive하게** 취한다 — oort는 이미 workd가 Ed25519로 서명하므로 신규 암호 스택 불요.

## 결정 (범위 확정)

**서버-authored 단일 쓰기경로·RLS FORCE·gapless seq를 하나도 바꾸지 않고**, 행위자에게 귀속되는 행동에 Ed25519 서명을 **검증 가능한 provenance 메타데이터로 additive하게** 부착한다. 범위 = **세 표면 전부**(성재 결정):

1. **메시지** — 행위자가 보낸 `message` (`momo-messaging`).
2. **작업 이벤트** — workd 실행 결과·작업 이벤트 (`momo-t3`, workd 서명키 재사용).
3. **상태 전이** — 감사 민감 행동: 권한 부여, 리뷰/승인 결정, 위계 변경 등 (`momo-t3`·`momo-integrations`).

## 불변식과의 관계 (D2 교차검증 — 재작성이 못 깨는 것)

| D2 불변식 | 이 서명이 미치는 영향 |
|---|---|
| 단일 쓰기경로 | **불변.** 서명은 서버 우회 publish 권한을 주지 **않는다**(buzz와 정반대 지점). 흐름 = 행위자가 서명 assertion 제출 → 서버가 검증 → **서버가 여전히 유일 저자로 row write** → 서명은 사이드카에 저장 |
| gapless `message.seq` | **불변.** 서명은 authenticity만, 순서 무관. 서버-부여 seq/id는 서명 후 붙으므로 2단계(행위자가 content 서명 → 서버가 seq 부여) |
| RLS FORCE | **불변.** 서명 사이드카도 동일 테넌트 RLS 아래 |
| provider 비유입(ADR-0004) | **불변.** 서명키 = 행위자 신원키(agent/workd/device)이지 provider 자격증명 아님 |

## 설계 (범위 확정에 따른 5개 항목 해소)

1. **대상 범위** → 위 세 표면 전부(넓게).
2. **서명자 모델(행위자 유형별)**:
   - 에이전트 → 에이전트 신원키(member 결속, `AgentCredential`/`AgentCard` 경로 활용).
   - workd → 기존 workd Ed25519 키(`Signing.swift` 포맷 확장).
   - **사람 → device 키**(`DeviceRoutes` 존재) — **유일한 선행 의존**. 사람 행동 서명은 device-key 결속이 필요하므로, **에이전트·workd 행위자는 즉시 적용, 사람 행위자는 device 키 배선 후 fast-follow**(범위는 넓게 확정, 사람분만 단계적). 이 phasing이 "무서명 공존"을 만든다 → nullable.
3. **저장 → 사이드카 테이블 `action_signature`** (신규 마이그레이션 060+, append-only·기존 스키마 불변). 세 표면이 여러 테이블에 걸치므로 표별 nullable 컬럼보다 `(entity_type, entity_id, signer_member_id, signer_pubkey, signature, signed_payload_digest)` 사이드카가 넓은 범위에 확장성 우위. 테넌트 RLS FORCE.
4. **검증 경로 → 쓰기시 chokepoint 검증**. `momo-wire`가 표면별 정규 서명 페이로드 정의, 공유 헬퍼 `record_provenance(tx, entity_ref, signer, signature)`(= provenance판 `emit_outbox` chokepoint)가 서명 검증 후 사이드카 write. 검증 실패 = 거부. 사후 재검증 가능(감사).
5. **UX 표면** → 에이전트/서명된 행동에 "서명됨(검증됨)" 표식 + 감사 로그. **부분 서명 위험**: "서명됨 vs 무서명" 공존이 오히려 신뢰를 흐릴 수 있으므로, 표식 규약을 ux-bible과 조율(무서명이 "미검증"으로 오독되지 않게). D3 상세에서 확정.

## Consequences

- (+) 세 표면 전반의 암호학적 감사추적 — 자체호스팅 조직이 "누가/어느 에이전트가 뭘 했나"를 서버 신뢰 없이 검증.
- (+) Nostr 전체를 받지 않고 이점만 — 불변식 무손상(위 표).
- (+) 공유 chokepoint(`record_provenance`)로 교차 관심사를 구조화 — `emit_outbox`와 대칭.
- (−) **B1 범위 팽창**: provenance가 교차 관심사(messaging·t3·integrations 전부) → 공유 프리미티브는 B1, 각 도메인의 서명 emit은 해당 배치에 분산. 계획 반영 필요.
- (−) 서명/검증 오버헤드, 키 관리 표면(특히 사람 device 키) 추가.
- (−) 무서명 레코드 공존의 UX·신뢰 모델 명확화 부담.

## 미해결 (D3 상세 설계) → 2026-09-28 개정으로 정리
- ~~표면별 정규 서명 페이로드 바이트 정의(재생·위조 경계).~~ **해결(사람 컨트롤 표면).** `momo.human.control.v1`과 재생 방지(개정 절 D-5·D-9). 에이전트·workd 표면의 바이트는 `momo-wire`가 이미 정한 대로다.
- ~~device-key 결속(사람 행위자) 배선 시점(B1 내 vs fast-follow).~~ **해결.** R2에서 인가 조건으로 결속한다(개정 절 D-1~D-3·D-6·D-11). 시리즈 R2-E1~E10(#3021~#3030).
- "서명됨/무서명" UX 표식 규약(ux-bible). **유보(미해결 유지).** 이번 개정은 사람 서명을 인가 조건으로만 쓴다. 사람 메시지 provenance와 「서명됨」 뱃지는 사람 서명이 모든 표면에 퍼진 뒤에 정한다(개정 절 D-8 마지막 행). 머리의 세부 결정 ③(UI 뱃지 없음)은 그대로다.

## 개정 2026-09-28 — 사람 기기 키 서명 (R2)

- Status: **Accepted** (2026-09-28 성재 「전부 권장대로」, 결재 페이지 https://claude.ai/artifact/392wQKGL3SzwfM2zNjhSpZ)
- 발제: 성재 2026-09-28 「R2 서명 먼저」(#3001 차단 코멘트의 선택지 A). ADR-0188 §4 R2 진입 조건 중 「ADR-0146 개정」을 이 절이 채운다. 다른 조건 「R1 보안 재검수 PASS」는 이 절이 풀지 않는다(D-11).
- 역방향 줄: ADR-0188 §4 R2 행과 §8.6, ADR-0192 D3.
- 표기: [S]는 검색 결과·요약으로 확인한 외부 사실(1차 문서를 이번에 열지 않음), [?]는 확인하지 못한 것, `runtime-unverified`는 서명 빌드에서 돌려 보지 않은 것이다. 코드 근거는 main `f3f6f80d`, track/engine `2a178e84` 기준이다.

### 맥락 — 무엇이 막혀 있었나

| # | 사실 | 근거 |
|---|---|---|
| F1 | ADR-0188은 사람 지시·새 작업·허용을 R2 기기 키 서명 뒤에만 연다. 서명 없는 세션 스레드·에이전트 DM 메시지와 잠긴 폰의 알림 답장은 input·spawn이 되지 않는다 | `docs/adr/0188-phone-remote-work-host.md:113`, `:118`, `:220`, `:231`, `:447` |
| F3 | 0188 §6 「host는 서명 없는 사람 컨트롤을 거부한다」. 서버만 검증하면 이 문장을 만족하지 못한다 | `0188:262` |
| F4 | ADR-0192 D3: 설정 묶음 목록은 소유자 기기 키로 서명하고, 서버는 목록과 내용을 함께 바꿀 수 없다 | `docs/adr/0192-remote-host-onboarding.md:55` |
| F6 | `action_signature`(060)는 Ed25519 크기로 고정돼 있다(공개키 `{43}=`, 서명 `{86}==`). 멱등 `UNIQUE (workspace_id, signature)`는 결정적 서명을 전제로 한다 | `server/Migrations/060_action_signature.sql` CHECK, `signature_uniq` |
| F7 | `momo-wire` 서명은 Ed25519 하나다. 스키마 문자열 + 줄바꿈 형식 | `server-rust/crates/momo-wire/src/signing.rs:1-20`, `:44` |
| F8 | P-256 검증 크레이트는 직접 의존에 없다(`ring`은 `jsonwebtoken` 경유 간접, push-relay ES256은 JWT 서명 경로) | `server-rust/Cargo.lock:2064`, `bins/momo-push-relay/src/sender.rs:166`, `:197` |
| F9 | 사람 기기의 서명 공개키를 담는 곳이 서버에 없다. `device`는 APNs용이다 | `server/Migrations/001_init.sql:503-514`, `bins/momo-server/src/routes/devices.rs:1-15` |
| F10 | 「연결 기기」(ADR-0180)는 QR 연결 세션만 보인다. 비밀번호 로그인 데스크탑은 목록에 없다. 세션 계보 `token.session_id`(088)는 모든 로그인 방식에 공통이다 | `crates/momo-auth/src/device_link.rs:512-532`, `:697-722`, `server/Migrations/088_push_session_lineage.sql` |
| F11 | 기기 사이 대역 외 확인은 공개 오리진 QR 연결의 SAS 4자리 하나다 | `server/Migrations/086_device_link_token.sql` `sas_ck` |
| F12 | refresh 재사용은 401로 거부하지만, 재사용 시 계보 전체를 폐기하는 코드는 grep으로 찾지 못했다(0188 R1 진입 조건 미충족으로 보임) | `crates/momo-auth/src/token_store.rs:364-400`, `bins/momo-server/src/routes/auth_routes.rs:515`, `:595`, `:630` |
| F14 | 재생 방지 선례 `work_host_request`(048)는 `host_id NOT NULL`이라 사람 경로에 그대로 쓸 수 없다 | `server/Migrations/048_work_host_request_replay.sql`, `crates/momo-auth/src/work_host_request.rs:99-125` |
| F15 | 컨트롤 생성 라우트는 에이전트 bearer만 받는다. workd는 `requester_member_id == owner_member_id`만 보고 서명은 보지 않는다 | `bins/momo-server/src/routes/work_controls.rs:6`, `:193`, `bins/momo-workd/src/controls.rs:23-28`, `:207-213` |
| F16 | workd host 키는 Ed25519, 데이터 보호 키체인(`keychain-access-groups` 필요). 서명 빌드 동작은 `runtime-unverified` | `bins/momo-workd/src/keystore.rs:1-20`, `clients/desktop/README.md:425-442` |
| F17 | 데스크탑 셸은 refresh 토큰을 파일 기반 키체인에 둔다. entitlement는 마이크뿐, Secure Enclave 코드 없음 | `clients/desktop/src-tauri/src/keychain.rs:1-31`, `clients/desktop/src-tauri/Entitlements.plist` |
| F18 | 폰 키체인 접근 그룹은 NSE와 공유하는 `app.momo.ios.shared` 하나뿐. `LAContext`·Secure Enclave 네이티브 코드 없음 | `clients/mobile/ios/MomoMobile/MomoMobile.entitlements:20-23`, `clients/mobile/src/storage/secureSession.ts:9`, `:103` |
| F19 | 웹 브라우저는 refresh 토큰을 localStorage에 둔다 | `clients/web/src/lib/session.ts:113-135` |

### D-1. 알고리즘 — 사람 기기 키는 P-256(Secure Enclave), host·에이전트는 Ed25519 유지

- 폰·맥은 Secure Enclave에서 P-256 ECDSA 키를 만든다. 비밀키는 칩 밖으로 나오지 않는다[S]. 서명은 raw r‖s 64바이트, 공개키는 압축 SEC1 33바이트다.
- host(workd)·에이전트 키는 지금처럼 Ed25519다.
- 알고리즘은 공개키 행의 **`alg` 컬럼**에 적는다. 나중에 다른 알고리즘(예: 웹 WebAuthn ES256)을 더해도 스키마를 다시 바꾸지 않는다.
- **DB 계약 변경(E2 #3022).** 060 `action_signature`의 공개키·서명 CHECK를 `alg`별로 완화하고 `alg` 컬럼을 더한다(기존 행 `ed25519`). `schema_v0.sql`은 건드리지 않는다.
- ECDSA 서명은 무작위이고 변형 가능하다(s ↔ n−s). 그래서 인가의 1회성은 서명 바이트가 아니라 **nonce**로 막는다(D-9). 감사 사이드카의 「한 행동 = 한 행」은 E3(#3023)에서 low-s 정규화 또는 nonce 유니크로 정한다.
- `momo-wire`에 P-256 검증 경로가 생긴다. 새 직접 의존(`p256` 또는 `ring`)은 permissive 라이선스와 NOTICE 반영이 조건이다(E1 #3021).

### D-2. 폰 — `biometryCurrentSet` + 앱 전용 키체인 그룹

- 폰 키의 접근 제어는 `biometryCurrentSet`이다. 서명마다 Face ID가 필요하고 기기 암호로 대신할 수 없다. Face ID 등록이 바뀌면 키가 무효가 된다[S]. 그러면 뿌리 맥에서 다시 승인한다(D-6).
- 키는 **앱 전용 키체인 접근 그룹**에 둔다. 알림 확장(NSE)과 공유하는 기존 그룹(F18)에는 두지 않는다. 그래서 「잠긴 폰의 알림 답장은 지시가 되지 않는다」(0188:113)가 암호 성질이 된다. NSE는 키에 닿지 못하고 Face ID를 띄울 수도 없다.
- 프로비저닝 프로파일 변경은 owner 손이 필요하다. `scripts/verify_ios_signing.sh`에 새 그룹을 넣는다(E6 #3026).

### D-3. 맥 — Tauri 셸이 SE 키를 들고 `userPresence`, 재사용 창 ≤300초

- 데스크탑 앱의 Tauri 셸(Rust)이 Secure Enclave P-256 키를 든다. 웹뷰는 「이 지시에 서명해 줘」 명령만 부를 수 있다.
- 확인은 `userPresence`다. Touch ID가 없는 맥은 로그인 암호로 확인한다. 재사용 창은 0~300초이며 기본 권장은 300초다(`LAContext` 재사용 창 상한 300초[S]). 값은 구현 이슈(E5 #3025)의 기본값이다.
- 사람 기기 키와 host 키(workd)는 다른 프로세스·다른 키다. workd가 사람 키를 들지 않는다.
- `keychain-access-groups`와 Developer ID 프로비저닝 프로파일이 필요하다(F17). 서명 빌드 전까지 **runtime-unverified**다. 프로파일 발급은 owner 손, 빌드는 건마다 owner 승인(M7)이다.

### D-4. 웹 브라우저는 비지시 표면 — 보기·거부·중단만

- 웹 브라우저는 지시(input·spawn)와 허용을 서명하지 않는다. 보기·거부·중단만 한다. 지시·허용을 누르면 「폰이나 데스크탑 앱에서 보내 주세요」라고 안내한다(E9 #3029). 목표 A의 표면은 데스크탑·iOS다(ADR-0187).
- 이유: 웹의 refresh 토큰이 localStorage에 있고(F19), WebCrypto non-extractable 키는 XSS가 대신 `sign()`을 부를 수 있으며 사용자 확인 게이트가 없다[S].
- **패스키(WebAuthn)는 웹 지시 표면의 후보**로 남기고, **외부 출시 때 다시 결재**한다. `alg` 컬럼(D-1)이 그 길을 열어 둔다. Tauri WKWebView에서 WebAuthn이 되는지는 [?]다.
- **역할 분리.** 로그인용 패스키는 #3031에서 따로 검토한다. 로그인 패스키는 기기 사이에 **동기화**되는 자격증명이고[S], R2 키는 **기기에 결속**되어 기기별로 폐기하는 키다. 둘은 같은 키가 아니다.

### D-5. 페이로드 `momo.human.control.v1`

`momo-wire` 관례(스키마 문자열 + 줄바꿈, F7)를 따른다. 스키마 문자열이 `sshsig` 네임스페이스처럼 용도를 분리한다[S]. 서명 대상 바이트는 아래 13줄(스키마 문자열 + 필드 12개)을 `\n`으로 이은 UTF-8이다.

```
momo.human.control.v1
{instance_id}
{workspace_id}
{member_id}
{device_key_id}
{host_id}
{session_id | "-"}
{kind}
{mode | "-"}
{nonce}
{issued_at_ms}
{expires_at_ms}
{content_sha256}
```

| 필드 | 뜻 |
|---|---|
| `instance_id` | 다른 인스턴스로의 재생 차단. **서버가 내려 준 인스턴스 id를 그대로 되돌린다.** 클라이언트가 URL로 origin 문자열을 만들지 않는다(끝 슬래시·프록시 차이로 서명이 깨지는 것을 막는다) |
| `workspace_id` | 테넌트 |
| `member_id` | 서명자. host 소유자여야 한다 |
| `device_key_id` | 서명한 기기 키 행 id |
| `host_id` | 클라이언트가 본 대상 host. 서버가 도출한 host와 같아야 한다. `host_register`면 host id 후보 |
| `session_id` | 대상 세션. 새 작업(`spawn`)·`bundle_manifest`·`host_register`면 `-` |
| `kind` | `spawn` · `input` · `permission` · `bundle_manifest` · `host_register` 중 하나 |
| `mode` | `input`이면 `queue` 또는 `interrupt`(서버가 예약을 끼어들기로 바꾸지 못한다). 다른 종류면 `-` |
| `nonce` | 128비트 무작위. `input`이면 `client_msg_id`를 그대로 쓴다 |
| `issued_at_ms` · `expires_at_ms` | 발급·만료. 만료는 발급 + 최대 10분 |
| `content_sha256` | 종류별 정규 본문의 SHA-256 소문자 hex |

**종류별 정규 본문(`content`).**

| kind | 정규 본문 |
|---|---|
| `input` | 지시문 UTF-8, NFC 정규화 |
| `spawn` | 에이전트 멤버 id, 폴더 id(0188 D6 불투명 id), 첫 프롬프트(NFC) |
| `permission` | `request_event_id`, `option_id`, `kind`, 범위(「이번 한 번」·「이 세션 동안」). D5 host nonce(`request_event_id`)를 그대로 결속한다 |
| `bundle_manifest` | 설정 묶음 목록 JSON의 정규 직렬화(ADR-0192 D3) |
| `host_register` | host 공개키, host id 후보, 라벨 |

- 여러 필드를 담는 본문의 정확한 직렬화(구분자·순서)와 high-s 처리 규칙은 E1(#3021)이 공유 테스트 벡터로 고정한다. 벡터는 Rust·Swift(CryptoKit)·TS(WebCrypto) 셋이 함께 쓴다(`momo-wire/tests/signing_bytes.rs` 관례). 필드 하나라도 바꾸면 검증이 실패해야 한다.
- 060 `signed_payload_digest`에는 위 1단계 바이트의 해시를 적는다(설계 4의 규율).

**형제 스키마.** 같은 관례로 둘을 더 정한다(E1).
- `momo.human.device_endorse.v1` — 뿌리 키가 다른 기기 키를 지시 기기로 승인한다. 필드: 뿌리 키 id, 승인 대상 공개키·`alg`, 라벨, workspace·member. 만료 없음(폐기로만 끝난다).
- `momo.human.device_revoke.v1` — 뿌리 키가 기기 키를 폐기한다. 필드: 뿌리 키 id, 폐기 대상 키 id, 폐기 시각, workspace·member.

### D-5b. 서명은 별도 서명 지시 라우트에 실린다 — 메시지 원장 불변

- 서명은 메시지 send 요청에 싣지 않는다. **별도 서명 지시 라우트**(#3001의 재범위, E7 #3027)가 컨트롤을 만들고, 같은 tx에서 그 지시문을 세션 스레드 메시지로도 남긴다. 메시지 INSERT는 기존 send 헬퍼를 그 tx 안에서 부른다(channel_seq·message·outbox 단일 tx 그대로).
- 메시지 send 경로(`momo-messaging`)는 바뀌지 않고 work 도메인을 알지 않는다.
- 서명 없는 일반 답장은 채팅으로만 남고 지시가 되지 않는다(0188 D3 그대로). 클라이언트는 「지시로 보내기」와 「채팅만」을 구분해 보인다. 서명이 실패하면 「전달 안 됨」 상태를 보이고 조용히 채팅으로만 남기지 않는다(E8 #3028).
- 멱등은 `client_msg_id`(= `nonce`)다.

### D-6. 신뢰의 뿌리 — host 맥의 데스크탑 앱 키, 다른 기기는 교차 서명 승인

1. **뿌리 고정.** host가 있는 맥의 데스크탑 앱이 SE 키를 만들고, 같은 맥의 workd에 코드서명 확인 Unix 소켓으로 직접 건넨다(`bins/momo-workd/src/control_socket.rs:170`). workd는 이 키를 로컬에 고정한다. 공개키는 서버에도 올라가지만(D-10 서버 검증용), 서버는 workd의 고정을 바꿀 수 없다.
2. **폰 승인.** 폰은 QR 연결(ADR-0180) 때 키를 만들어 올린다. QR 연결이 끝나는 시점에 데스크탑에 승인 단계를 둔다. SAS 유무와 무관하다(SAS는 공개 오리진에만 있어서 루프백·LAN에는 `confirm-sas`가 없다, F11). 데스크탑은 폰 키 지문을 보여 주고 「이 폰을 지시 기기로 승인」에 `device_endorse.v1`로 서명한다.
3. **서버는 나를 뿐.** 서버는 승인서를 저장하고 전달한다. workd는 자기가 고정한 뿌리까지 서명 사슬이 이어진 키만 받아들인다. 서버·DB가 키를 끼워 넣지 못한다. Matrix 교차 서명·Signal 연결 기기와 같은 모양이다[S]. ADR-0192 D3의 전제 조건(서버가 바꿀 수 없는 키)이 여기서 풀린다.
- 맥 여러 대가 서로 승인하는 기능은 다음 단계다. 맥마다 뿌리가 달라서 폰은 맥마다 한 번씩 승인한다. 뿌리 맥을 잃으면 host도 함께 잃는다(host 재등록 = 뿌리 재설정).
- 0188 §4 R2 항목 「host 등록 서명」은 ①과 D-8의 `host_register` 서명이 함께 채운다.

### D-7. 폐기 — 세션 계보 연쇄 폐기 + 뿌리가 서명한 폐기서

- 기기 키 행은 세션 계보(`token.session_id`, 088)를 든다. 계보가 끝나면 서버가 키를 폐기한다. 로그아웃, 연결 기기 해제, refresh 재사용 계보 폐기가 모두 키를 끊는다. 비밀번호 로그인 데스크탑처럼 `device_link_token`에 없는 기기도 포함된다(F10의 구멍).
- 뿌리가 서명한 **폐기서**(`device_revoke.v1`)를 host에 로컬 소켓과 서버 양쪽으로 전달한다. 서버가 폐기를 숨겨도 맥 앞에서 해제하면 workd가 바로 안다.
- 서버 폐기는 `revoked_at`만 쓰고 행을 지우지 않는다. 감사 때 옛 서명을 다시 검증해야 해서다.
- 분실 시나리오:
  - **폰 분실:** 맥에서 「연결 기기 해제」 → 계보 폐기 + 서명된 폐기서 → workd 즉시 거부. 폰이 서버에 닿지 않아도 된다.
  - **맥 분실:** host 키도 함께 잃은 것이다. 다른 기기에서 host revoke를 한다(0188 D7 기존 경로). 끄는 쪽이라 서명이 필요 없다.
  - **Face ID 재등록:** D-2 때문에 키가 무효가 되고, 맥에서 다시 승인한다.
- F12(재사용 시 계보 폐기)는 같은 계보 테이블을 만지므로 E2(#3022)에서 함께 닫는다. 이것은 0188 R1 진입 조건의 한 항목이기도 하다.
- **E2 구현 정정(#3022 보안 검수 H2).** 재사용 계보 폐기는 QR 연결(폰) 계보에 항상 적용한다. 비밀번호 로그인 계보(데스크탑·웹)는 `MOMO_REFRESH_REUSE_SWEEP_ALL_SESSIONS=true`일 때만 적용하고 기본은 꺼 둔다. 웹 탭은 탭 사이 조율 없이 같은 refresh 토큰을 회전해서, 뒤늦게 연 탭이 앞 탭의 토큰을 써 버린 경우를 서버가 도난과 구분하지 못하기 때문이다. 소비 30초 이내 재제시는 두 경우 모두 같은 클라이언트의 재시도로 보고 거부만 한다(요청 기한 15초 × 2). 그래서 0188 §4 R1 「재사용 시 계열 전부 폐기」는 기본값에서 폰에만 성립한다. 뿌리 키를 든 데스크탑 계보도 기본값에서는 폐기 대상이 아니다. 대신 뿌리 등록은 비밀번호를 다시 요구해서, 훔친 데스크탑 토큰으로 뿌리를 만들 수는 없다. **R1 재검수 PASS의 전제:** 웹 클라이언트의 탭 간 회전 조율(UXUI 후속) 뒤 플래그 켜기, 또는 데스크탑·웹을 폐기 대상에서 뺀다는 owner 결정.

### D-8. 서명 범위

0188 D3가 이미 새 작업·input·허용을 R2 서명 대상으로 정했다(`0188:118`). 그 밖은 아래와 같다.

| 행위 | 서명 | 근거 |
|---|---|---|
| 새 작업(`spawn`) · 지시(`input`, queue·interrupt) · 허용(`permission` allow) | **필요** | 0188 D3 |
| 거부(`reject_once`) | 불필요 | 끄는 쪽. 위조돼도 에이전트가 허락받지 못할 뿐이다(닫힌 쪽 실패, 0188 §8.6 L-1과 같은 논리) |
| 중단(`kill`) · host revoke | 불필요 | 에이전트도 `kill`을 할 수 있다(0188 D3). 서명을 요구하면 분실 때 끄지 못한다 |
| 「거부 + 지시」 | **지시 부분만** | 거부는 서명 없이, 지시문은 `input`으로 서명한다. 0188 §8.6의 R2 유보를 푸는 방법이고, E8(#3028)에서 400 `permission_instruction_unsupported`를 해제한다 |
| 「이 세션 동안」 허용 | **필요**, R2에서 폰에도 연다 | R1 동안 폰은 「이번 한 번」만(`0188:117`). 범위 값을 `permission` 본문에 넣는다 |
| 설정 묶음 목록(ADR-0192 D3) | **필요**, `kind=bundle_manifest` | 0192 D3가 같은 키를 요구한다 |
| host 등록(0188 §4 R2 항목) | **필요**, `kind=host_register` | D-6 ①의 로컬 고정은 「이 맥의 host 키 ↔ 뿌리 키」만 묶는다. 훔친 refresh 토큰으로 서버에 가짜 host를 등록하는 위협은 막지 못한다. 서버는 뿌리 키 서명 없는 member-scope host 등록을 거부한다. 폰의 새 작업은 페이로드 `host_id`가 사람이 고른 host를 고정한다 |
| 사람의 일반 메시지(설계 1 표면 1) | **다음 단계** | 이번에는 인가 조건만 다룬다. 메시지 provenance와 「서명됨」 뱃지(세부 결정 ③)는 사람 서명이 모든 표면에 퍼진 뒤다 |

### D-9. 재생 방지 — 서버 1회 소비 + workd 영속

- **서버:** 048과 같은 모양의 새 테이블 `human_control_nonce`(workspace, device_key_id, nonce, expires_at, RLS FORCE)에 검증 tx에서 `INSERT … ON CONFLICT DO NOTHING RETURNING`으로 1회 소비한다(E3 #3023). 048은 `host_id NOT NULL`이라 그대로 쓸 수 없다(F14).
- 시각 창은 서버 시각 기준 **±5분**, 만료는 발급 뒤 **최대 10분**이다. 시계 보정(서버 시각을 한 번 받아 맞추기)은 E3에서 정한다.
- **workd:** 본 nonce 집합을 만료까지 host 상태 폴더에 **영속**한다(재시작해도 유지, E4 #3024). 그렇지 않으면 서버가 재시작 직후 10분 안에 옛 지시를 다시 흘려도 막지 못한다.
- `client_msg_id` 멱등은 재시도 흡수 장치일 뿐, 재생 거부 장치가 아니다. 권한 허용은 D5 host nonce(`request_event_id`)가 이미 1회성이라 이중으로 막힌다.

### D-10. 검증 위치 — 서버와 workd 둘 다. 보안 경계는 workd

**서버 검증은 편의와 감사를 위한 것이고, 보안 경계는 workd다.**

- **서버(E3 #3023):** 쓰기 chokepoint `verify_human_control`에서 검증한다. 거부하면 이름 붙은 오류 `device_signature_required` · `device_signature_invalid` · `device_key_revoked`를 돌려준다. 성공하면 컨트롤 행과 `action_signature`(`record_provenance`, 설계 4의 사람 경로)를 같은 tx에 쓴다.
- **workd(E4 #3024):** 컨트롤에 실려 온 서명 원문과 페이로드를 다시 만들어 검증하고, 키가 자기가 고정한 뿌리까지 이어지는지 보고, nonce를 소비한다. 서버가 서명 없는·위조 키 컨트롤을 넣어도 host가 거부한다. 이것이 0188 §6 「host는 서명 없는 사람 컨트롤을 거부한다」를 채운다.
- 그러려면 `WorkControl`(F15)에 서명 필드가 늘고 `work_control_payload_ck`(029→092)를 한 번 더 바꾼다(migration 095, E3).

### D-11. 착수와 켜기 — 구현은 지금, 사람 지시는 플래그로 닫아 둔다

- 이 개정 뒤 구현은 바로 시작한다. 사람 지시 라우트는 **워크스페이스 플래그로 닫아 둔다**. 플래그는 **R1 보안 재검수 PASS**와 **R2 보안 검수(E10 #3030) PASS** 뒤에만 켠다.
- 이유: 이 개정은 0188 §4 R2 진입 조건 둘 중 하나만 푼다. R1 쪽은 F12와 R0 #2570 OPEN·재검수 PASS 기록 없음이 남아 있다.

### 새 공개 API 선언 (ADR-0100)

아래 라우트는 이 개정을 Accepted 근거로 삼는다. 경로 이름·본문 모양·OpenAPI는 각 구현 이슈가 확정한다.

| 표면 | 내용 | 이슈 |
|---|---|---|
| 기기 키 등록·목록·폐기 | 로그인 세션이 자기 기기의 공개키(`alg`, platform, label)를 올린다. 다른 멤버 키 등록은 거부한다. 폐기는 `revoked_at`만 쓴다. 승인서 없는 폰 키는 「지시 불가」 상태다. **E2 구현 정정(#3022 보안 검수 H1):** 뿌리 후보(`macos`) 키 등록은 현재 비밀번호 재입력을 요구하고, QR 연결 세션에서는 받지 않는다(훔친 refresh 토큰만으로 뿌리를 만들 수 없게) | E2 #3022 |
| 기기 승인(교차 서명) | 뿌리 키의 `device_endorse.v1` 승인서를 저장·전달한다. 폐기서 `device_revoke.v1`도 같은 경로로 전달한다 | E2 #3022 · E4 #3024 |
| host 등록 서명 | member-scope host 등록에 `host_register` 서명을 요구한다. **E2 구현(#3022):** 보낸 서명은 항상 검증하고, 요구는 `MOMO_HOST_REGISTER_SIGNATURE_REQUIRED`(기본 꺼짐, D-11)로 켠다. 서명문의 `instance_id`는 `MOMO_INSTANCE_ID`이며 E3 발급 라우트가 같은 값을 내려 준다 | E2 #3022 |
| 서명 지시 | `input`(queue·interrupt)·`spawn`·`permission` 허용을 서명과 함께 받는다. 오프라인 host는 정직하게 거부한다. `client_msg_id` = nonce 멱등 | E3 #3023 · E7 #3027 |
| 서버 인스턴스 id | 클라이언트가 `instance_id`로 되돌릴 값을 내려 준다 | E1 #3021 · E3 #3023 |

### DB 계약 (새 migration만)

- **094**(E2 #3022): `member_device_key`(workspace, member, session_id, alg, public_key, platform, label, endorsed_by_key_id, endorsement_sig, created_at, revoked_at). RLS FORCE와 `ws_isolation` 정책 대상에 넣는다. `action_signature` CHECK 완화와 `alg` 컬럼(기존 행 `ed25519`).
- **095**(E3 #3023): `human_control_nonce`(048 모양, RLS FORCE) + `work_control` 서명 컬럼·`payload_ck` 변경.
- `schema_v0.sql`은 건드리지 않는다. 093은 #3009(`provider_default_ai`)가 먼저 쓴다. 094·095 번호는 편성 시점 기준이다(머지 순서에 따라 다시 매길 수 있다).

### 이슈 시리즈

| 단계 | 이슈 | 트랙 | 내용 |
|---|---|---|---|
| E0 | #3020 | planner(docs) | 이 개정 + ADR-0188 §4·§8.6·ADR-0192 D3 역방향 줄 |
| E1 | #3021 | 엔진 | `momo-wire` 사람 서명 바이트 3종 + P-256 검증 + 3언어 공유 벡터 |
| E2 | #3022 | 엔진 | migration 094 기기 키 등록·폐기 + 세션 계보 연쇄 폐기 + refresh 재사용 계보 폐기(R1) + host 등록 뿌리 서명 |
| E3 | #3023 | 엔진 | migration 095 `human_control_nonce` + `verify_human_control` + `record_provenance` 사람 경로 |
| E4 | #3024 | 엔진 | workd 뿌리 고정·승인 사슬·컨트롤 서명 재검증·nonce 영속·폐기서 적용 |
| E5 | #3025 | 데스크탑 | Tauri SE 키·Touch ID(재사용 ≤300초)·workd 뿌리 전달·폰 지시 기기 승인 UI |
| E6 | #3026 | 폰 | Expo 네이티브 모듈 SE P-256·`biometryCurrentSet`·앱 전용 키체인 그룹, QR 연결 때 키 등록 |
| E7 | #3027 | 엔진 | #3001 재범위 — 서명 지시 라우트 |
| E8 | #3028 | UXUI | 폰·데스크탑 지시·허용 카드 서명, 「이 세션 동안」 폰 개방, 「거부 + 지시」 개방 |
| E9 | #3029 | 웹 | 지시·허용 버튼 → 「폰이나 데스크탑 앱에서」 안내 |
| E10 | #3030 | planner | R2 보안 검수 + 0188 §4 R2 red proof → R1 재검수 PASS와 함께 플래그 켜기 |
| — | #3031 | planner(research) | 로그인용 패스키 검토(D-4 역할 분리) |

### 위험과 미검증

- **macOS SE entitlement — runtime-unverified.** 데스크탑 앱과 workd 모두 서명 빌드에서 `keychain-access-groups`와 프로파일이 되는지 확인한 적이 없다(F16·F17). Developer ID 앱에 프로파일을 넣는 절차와 Tauri 번들러 지원은 [?]다. 막히면 대안은 Swift 헬퍼 바이너리나 workd 보관이며, 후자는 D-3을 바꾸므로 다시 결재한다.
- **iOS 키체인 그룹 추가.** 지난번 그룹 불일치는 NSE를 조용히 망가뜨렸다(`docs/planning/2026-08-02-rn-push-inheritance-audit.md:157`).
- **웹뷰 XSS와 데스크탑 서명.** 재사용 창 안에서 웹뷰 스크립트가 서명 명령을 부를 수 있다. 서명 전 네이티브 대화상자에 요약(host·종류·첫 줄)을 띄울지는 E5에서 정한다.
- **뿌리 재설정.** 데스크탑 앱을 지웠다 다시 깔면 SE 키가 사라지는지는 [?]다. 사라지면 host 재등록과 폰 재승인이 필요하다.
- **여러 맥** UX는 설계하지 않았다(D-6).
- **R1 미결.** F12, NSE 토큰 축소([?], 이번에 코드를 확인하지 않음), R0 #2570. 이 개정만으로 R2를 켤 수 없다(D-11).

### 외부 출처 ([S])

- Apple, The Secure Enclave: https://support.apple.com/guide/security/the-secure-enclave-sec59b0b31ff/web
- Apple, CryptoKit `SecureEnclave.P256.Signing`: https://developer.apple.com/documentation/cryptokit/secureenclave/p256/signing
- Apple, `SecAccessControlCreateFlags.biometryCurrentSet`: https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/biometrycurrentset
- Apple, `touchIDAuthenticationAllowableReuseDuration`: https://developer.apple.com/documentation/localauthentication/lacontext/touchidauthenticationallowablereuseduration
- Apple, About the security of passkeys: https://support.apple.com/en-us/102195
- W3C, Web Authentication Level 3: https://www.w3.org/TR/webauthn-3/
- Matrix MSC1756 cross-signing: https://github.com/matrix-org/matrix-doc/blob/master/proposals/1756-cross-signing.md
- Signal, Linked Devices: https://support.signal.org/hc/en-us/articles/360007320551-Linked-Devices
- OpenSSH, PROTOCOL.sshsig: https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.sshsig

역방향(2026-09-28): D-4의 「로그인용 패스키는 #3031에서 따로 검토」는 ADR-0195(패스키 로그인, Accepted)로 결정됐다. 로그인 패스키는 동기화되는 로그인 수단이고 이 개정의 기기 키와 분리한다(ADR-0195 D-11). 공유하는 것은 `p256` 검증 의존뿐이다.
