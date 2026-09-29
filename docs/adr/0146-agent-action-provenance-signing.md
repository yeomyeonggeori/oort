# ADR-0146: 행동 provenance 서명 (buzz에서 선택 차용)

- Status: **Accepted** (2026-07-31 성재 “권고대로 진행” — 범위=3표면 + 세부 3결정 확정. 기안 Fable)
- **확정된 세부 3결정(2026-07-31)**: ①서명 페이로드 = 정규화 content+author, 서버 부여 seq는 2단계(행위자가 content 서명 → 서버가 seq 부여 후 envelope) ②행위자 단계 = **에이전트·workd 먼저**(키 보유·즉시), 사람은 device 키 결속 후 fast-follow ③UX = **초기 감사 로그·API 전용**(UI 뱃지 없음 — 부분 서명기의 “무서명=미검증” 오독 방지), 사람 서명까지 차면 뱃지 도입.
- 개정: **2026-09-28 Accepted** — 사람 기기 키 서명(R2). 결재 인용: 성재 2026-09-28 「전부 권장대로」(R2 기기 키 서명 결재 Q1~Q11·Q5-b 권장안 전부, 결재 페이지 https://claude.ai/artifact/392wQKGL3SzwfM2zNjhSpZ). 기안 Opus 5.5 worker(#3020). 근거 브리프 `claudedocs/r2-device-signing/brief.md`는 gitignore 대상이라 로컬에만 있다. 아래 「개정 2026-09-28」 절이 필요한 사실과 근거(file:line)를 그대로 옮겨 담는다. 2026-07-31 본문은 역사 기록으로 두고, 미해결 절만 고쳤다.
- 증보: **2026-09-28 (#3027 R2-E7)** — `momo.human.control.v2`(spawn이 도구·채널·재개 세션을 결속)와 서명 지시 라우트·서명 재개의 구현 계약, `momo.human.device_revoke.v2`(뿌리가 폐기 대상 공개키에 서명)와 workd 폐기서 보관(#3068). 개정 절 D-5·D-5b·D-8·D-11 범위 안의 구현 확정이며 결정은 바꾸지 않았다. 아래 「증보 2026-09-28 — R2-E7」 절.
- 증보: **2026-09-28 (#3097)** — refresh 재사용 계보 폐기에서 기기 키 제외, 계보만 끝난 키의 자기 서명 재결속(`momo.human.device_rebind.v1`). D-7 결정 변경이며 결재 인용은 D-7 「증보 #3097」 절에 있다.
- 증보: **2026-09-29 (#3079)** — refresh 토큰 sender-constraint. 계보에 결속한 별도 SE **refresh 키**의 증명(`momo.human.refresh_proof.v1`)으로 응답 유실을 복구하고 증명 없는 재사용만 계보를 끝낸다(migration 096). 결재 인용은 D-7 「증보 #3079」 절에 있다.
- 증보: **2026-09-29 (#3117)** — workd 서명 요구를 켜는 제품 경로(D-10 이행, E10 검수 B1). 서버 신호로 켜지고 서버가 끌 수 없는 래칫. 결재 인용: R2 결재 「전부 권장대로」(2026-09-28)의 D-10 「보안 경계는 workd」 이행. 결정은 바꾸지 않았다. 아래 「증보 2026-09-29 — workd 서명 요구 래칫」 절.
- 증보: **2026-09-29 (#3118, R2 H1)** — 허락 서명이 사람이 본 미리보기를 묶는다. host가 권한 요청의 미리보기와 그 해시를 싣고, `momo.human.control.v3`의 permission 본문이 그 해시를 한 줄 더 서명하며, host는 자기 해시와 대조한다(migration 097, 소유자 전용 미리보기 조회). 결재 인용: R2 결재 성재 2026-09-28 「전부 권장대로」의 D-5 이행 + E10 검수(#3030) H1. 아래 「증보 2026-09-29 — 허락이 미리보기를 묶는다」 절.
- 증보: **2026-09-29 (#3119)** — 폰(`ios`) 키는 QR 연결 계보에서만 등록·승인·재결속한다(E10 검수 H2). D-6 ②를 서버에서 강제하는 결정 변경이다. 결재 인용: 성재 2026-09-29 「QR 연결로만 등록」(이슈 #3119 코멘트). 아래 「증보 2026-09-29 — 폰 키는 QR 연결로만」 절.
- 증보: **2026-09-29 (#3095, R2-E8 후속)** — 「이 세션 동안」 허락의 범위 규칙과 host의 기억. 서버는 서명된 `scope=session` allow를 받고(400 `permission_scope_unsupported` 해제), host는 같은 세션에서 범위 규칙이 덮는 요청만 묻지 않고 허락한다. 결재 인용: R2 결재 성재 2026-09-28 「전부 권장대로」의 D-8 「이 세션 동안 허용은 R2에서 서명과 함께 폰에도 연다」. 범위 규칙 자체는 D-8이 정하지 않아 이 증보가 보수적으로 정한다(결정 변경이 아니라 D-8의 이행). 아래 「증보 2026-09-29 — 이 세션 동안 허락」 절.
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
- 프로비저닝 프로파일 변경은 owner 손이 필요하다. 새 그룹은 두 가드가 지킨다(E6 #3026): 선언 쪽 `clients/mobile/__tests__/deviceKeyContract.test.ts`, 서명 산출물 쪽 `clients/mobile/ios/ci_scripts/ci_post_xcodebuild.sh` §4b. (정정 2026-09-28: 처음 적은 `scripts/verify_ios_signing.sh`는 503d5ee3 W-S1에서 이미 은퇴했다.)

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
- **증보 2026-09-29 (#3119).** ②의 「폰은 QR 연결 때 키를 만들어 올린다」를 서버가 강제한다. QR 연결이 아닌 로그인의 폰 키는 등록되지 않고, 승인 후보도 아니다. 아래 「증보 2026-09-29 — 폰 키는 QR 연결로만」 절.
- **증보 2026-09-28 (#3078).** workd 뿌리 고정의 정체성은 **공개키**다. 재로그인은 옛 키 행을 계보와 함께 폐기하고 같은 공개키에 새 행(새 key id)을 준다(D-7). 같은 공개키의 새 id는 코드서명 확인 로컬 소켓의 `pin_root`로만 재결속하고(로컬 reset 뒤 새 id로 고정해도 같다), 옛 id는 은퇴한다(뿌리·다른 키의 id·폐기 대상이 될 수 없고, 옛 id 아래 승인서는 서버와 같이 무효라 폰은 맥에서 다시 승인한다). 옛 id로 서명된 폐기서는 같은 키의 말이라 계속 받는다. 서버 경로는 재결속할 수 없고, 다른 공개키는 종전대로 `root_already_pinned`다. 서버가 옛 id를 재사용하는 안은 D-7(폐기 행 보존·부활 없음)과 충돌해 택하지 않았다. (#3097: 이것은 키가 **폐기된** 재로그인 — 로그아웃·연결 해제·서명 폐기서·멤버 전체 종료 — 의 모양이다. 재사용·만료로 계보만 끝나 키 행이 살아 있으면 행을 옮기므로 id가 그대로이고 workd 재고정도 없다. D-7 증보 #3097.)

### D-7. 폐기 — 세션 계보 연쇄 폐기 + 뿌리가 서명한 폐기서

- 기기 키 행은 세션 계보(`token.session_id`, 088)를 든다. 계보가 끝나면 서버가 키를 폐기한다. 로그아웃, 연결 기기 해제, refresh 재사용 계보 폐기가 모두 키를 끊는다. (**refresh 재사용은 아래 증보 #3097로 키 폐기에서 빠졌다.**) 비밀번호 로그인 데스크탑처럼 `device_link_token`에 없는 기기도 포함된다(F10의 구멍).
- 뿌리가 서명한 **폐기서**(`device_revoke.v1`)를 host에 로컬 소켓과 서버 양쪽으로 전달한다. 서버가 폐기를 숨겨도 맥 앞에서 해제하면 workd가 바로 안다.
- 서버 폐기는 `revoked_at`만 쓰고 행을 지우지 않는다. 감사 때 옛 서명을 다시 검증해야 해서다.
- 분실 시나리오:
  - **폰 분실:** 맥에서 「연결 기기 해제」 → 계보 폐기 + 서명된 폐기서 → workd 즉시 거부. 폰이 서버에 닿지 않아도 된다.
  - **맥 분실:** host 키도 함께 잃은 것이다. 다른 기기에서 host revoke를 한다(0188 D7 기존 경로). 끄는 쪽이라 서명이 필요 없다.
  - **Face ID 재등록:** D-2 때문에 키가 무효가 되고, 맥에서 다시 승인한다.
- F12(재사용 시 계보 폐기)는 같은 계보 테이블을 만지므로 E2(#3022)에서 함께 닫는다. 이것은 0188 R1 진입 조건의 한 항목이기도 하다.
- **E2 구현 정정(#3022 보안 검수 H2).** 재사용 계보 폐기는 QR 연결(폰) 계보에 항상 적용한다. 비밀번호 로그인 계보(데스크탑·웹)는 `MOMO_REFRESH_REUSE_SWEEP_ALL_SESSIONS=true`일 때만 적용하고 기본은 꺼 둔다. 웹 탭은 탭 사이 조율 없이 같은 refresh 토큰을 회전해서, 뒤늦게 연 탭이 앞 탭의 토큰을 써 버린 경우를 서버가 도난과 구분하지 못하기 때문이다. 소비 30초 이내 재제시는 두 경우 모두 같은 클라이언트의 재시도로 보고 거부만 한다(요청 기한 15초 × 2). 그래서 0188 §4 R1 「재사용 시 계열 전부 폐기」는 기본값에서 폰에만 성립한다. 뿌리 키를 든 데스크탑 계보도 기본값에서는 폐기 대상이 아니다. 대신 뿌리 등록은 비밀번호를 다시 요구해서, 훔친 데스크탑 토큰으로 뿌리를 만들 수는 없다. **R1 재검수 PASS의 전제:** 웹 클라이언트의 탭 간 회전 조율(UXUI 후속) 뒤 플래그 켜기, 또는 데스크탑·웹을 폐기 대상에서 뺀다는 owner 결정.

- **증보 2026-09-28 — 유예 안 재제시는 같은 pair로 답한다(#3074). Accepted.** 결재 인용: 보안 결함 수리 planner 편성 #3074(#3072 보안 검수 발견 — 「30초 유예는 계보 폐기만 막고 401 로그아웃은 막지 못한다」). 기안 Opus 5.5 worker(#3074).
  - **문제.** 회전 응답이 유실되면(요청 중 탭 닫힘·F5·절전·15초 기한을 넘긴 느린 네트워크) 서버는 토큰을 소비했지만 클라이언트는 옛 토큰만 든다. 위 정정의 유예는 폐기만 막고 401을 돌려줘서, 웹은 모든 탭이 로그아웃되고 폰·데스크탑은 다시 로그인해야 했다. 두 탭이 같은 토큰을 동시에 내면 단일 사용 게이트에서 진 쪽도 같은 401을 받았다.
  - **결정.** 소비 30초 이내의 재제시는, 그 회전이 발급한 pair가 **아직 아무도 쓰지 않았으면**(두 반쪽 모두 `token` 행이 살아 있으면) **같은 pair**를 다시 돌려준다. 멱등이며 몇 번이든 같다. 새 행을 쓰지 않는다. 기기 연결 바인딩도 이미 그 pair를 가리킨다. 그 pair를 누가 이미 회전했거나, 로그아웃·계보 폐기로 죽었거나, 유예가 지났으면 종전대로다(유예 안: 401만, 유예 밖: #3022 재사용 → 계보 폐기).
  - **평문을 저장하지 않는 방법 — 결정적 파생.** 회전이 발급하는 pair를 그 회전의 순수 함수로 만든다(`momo_auth::sign_rotation_successor`). `sub`·`ws`·`scopes`는 제시된 토큰에서, `iat`는 제시된 행의 `revoked_at`(Postgres가 쓴 값, 초 단위)에서, `jti`는 제시된 토큰 원문과 `typ`의 UUIDv5에서 온다. HS256은 결정적이므로 재시도에서 같은 바이트가 다시 서명되고, 서버는 그 `sha256`이 기록된 행과 같은지로 확인한다. 서버·DB에는 새 토큰의 원문도 암호문도 남지 않는다. DB는 여전히 `sha256(jwt)`만 든다. `revoked_at`은 한 번만 쓰인다(모든 쓰기가 `COALESCE` 또는 `WHERE revoked_at IS NULL`).
  - **보안 트레이드오프.**
    - 다시 받으려면 소비된 토큰 원문이 있어야 한다. 그것을 가진 쪽은 원래도 그 계보의 소유자이거나 도둑이다. DB 유출만으로는 파생할 수 없다(원문이 없고, 서명에 `jwt_secret`이 필요하다). `jwt_secret`을 가진 쪽은 원래 아무 토큰이나 만들 수 있으므로 이 파생이 더 여는 것은 없다.
    - **받아들인 비용(독립 검수 M1 반영).** 「아직 쓰지 않았다」는 「아직 **회전**하지 않았다」는 뜻이다. 새 access로 API를 부른 것은 쓴 것으로 치지 않는다(세션 access의 사용 기록이 없다). 그래서 소비 뒤 30초 동안은 옛 토큰을 가진 누구든 살아 있는 같은 pair를 받는다. 종전(#3022)에는 창 안의 두 번째 제시자가 401을 받아 로그아웃되었고, 적어도 사용자에게 신호가 보였다.
      - 두 보유자는 같은 토큰을 30초 넘게 벌어져 낼 때만 걸린다. 그때는 늦게 낸 쪽의 제시가 재사용이 되어 계보가 끝난다(폰 계보는 항상, 비밀번호 계보는 플래그가 켜졌을 때).
      - 둘은 같은 access `exp`를 쥔다. 도둑이 클라이언트와 같은 박자로(만료 시점에) 회전하면 매 회전이 30초 안에 겹쳐 **계보가 끝나지 않고 조용히 공존**한다.
      - 서버는 토큰을 공유하는 두 클라이언트를 구별할 수단이 없다. 「다른 클라이언트」의 판정 근거는 후속 pair가 이미 회전되었는지뿐이다.
      - 좁히는 후속 후보: 세션 access 첫 사용 기록(응답을 잃은 클라이언트는 새 access를 쓴 적이 없다 — 요청마다 쓰기와 migration이 든다), 기기 키 기반 sender-constraint(폰·데스크탑). 이 비용의 수용은 owner 확인 대상으로 PR에 올린다.
    - 유예 밖 재제시, 이미 진행된 계보의 옛 토큰, 로그아웃된 토큰은 모두 종전과 같다.
    - `iat`가 서버 프로세스 시계가 아니라 DB 시계를 따른다. 둘 사이 어긋남만큼 만료가 밀리거나 당겨진다(초 단위).
  - **기각한 대안.** 첫 응답을 짧은 수명으로 서버에 암호화해 보관하는 방법(예: `pgp_sym_encrypt(pair, 제시된 토큰 원문)`)은 새 컬럼 migration과 정리 작업이 필요하다. 보호 수준은 파생과 같다(열쇠가 제시된 토큰 원문이다). 새 의존·migration 없이 같은 성질을 얻는 파생을 택했다.
  - 시험: `device_key_conformance_pg`의 `a_lost_rotation_response_is_answered_again_with_the_same_pair` · `a_spent_token_is_not_reissued_once_its_successor_moved_on_or_the_window_closed` · `concurrent_presentations_of_one_token_get_one_pair` · `a_linked_phone_that_lost_a_rotation_response_keeps_its_lineage`. 웹 클라이언트 쪽 서술(`rotationLock.ts` 「30초 유예가 흡수한다」)은 이제 서버 동작과 맞는다. 문구 정리는 UXUI 트랙 몫이다.

- **증보 2026-09-28 — refresh 재사용은 기기 키를 폐기하지 않는다. 계보만 끝난 키는 그 키의 서명으로 새 로그인에 옮긴다(#3097). Accepted.** 결재 인용: 성재 2026-09-28 「ㄱㄱ」(응답 유실 대응 제안 1·2 지금, 3은 E10 전 — 조사 `claudedocs/refresh-loss/research.md`). 기안 Opus 5.5 worker(#3097).
  - **근거.** 업계(Auth0·Okta·RFC 9700·Cognito)는 재사용을 감지하면 토큰 family·세션을 폐기한다. 기기 결속 키까지 폐기하는 사례는 찾지 못했다(조사 §4). 재사용이 증명하는 것은 refresh 토큰이 복제되었다는 사실이지, 추출할 수 없는 SE 키가 복제되었다는 사실이 아니다. 그래서 키를 폐기하면 해를 입는 쪽은 정당한 소유자뿐이다. 뿌리 키는 비밀번호 재등록이 필요하고, 폰은 맥에서 다시 승인해야 한다.
  - **경로별 표**(`server-rust/bins/momo-server/src/session_end.rs`가 한곳에서 정한다).

    | 경로 | 토큰 | 푸시 등록 | 기기 키 |
    |---|---|---|---|
    | 로그아웃 | 폐기 | 폐기 | 폐기 `logout` |
    | 연결 기기 해제 | 폐기 | 폐기 | 폐기 `device_unlinked` |
    | 뿌리의 서명 폐기서 | — | — | 폐기 `signed` |
    | 멤버 전체 세션 종료(비밀번호 변경·재설정, 정지, 제거, 탈퇴, 소유자 인수, 관리자) | 폐기 | 폐기 | 폐기 `member_sessions_ended` |
    | **refresh 재사용 계보 폐기** | 폐기 | 폐기 | **유지** |

    CHECK의 `refresh_reuse` 값은 #3097 이전 행을 위해 남는다. 이제 쓰는 경로는 없다.
  - **계보가 죽은 키 — E3 관문과의 관계.** 키 행은 살아 있지만 계보가 회전할 수 없으면, 모든 서명 검사(E3 `verify_human_control_in_tx`, host_register, 승인·폐기서의 뿌리)가 키의 계보를 잠가 확인하므로 `device_key_revoked`로 거부된다. 그 뿌리가 승인한 폰은 `unendorsed`(지시 불가)로 읽힌다. 새 필드 `lineageLive`가 이 상태를 보인다. 자연 만료로 계보가 끝난 키도 같은 상태다. 전에는 같은 공개키를 다시 올리면 `device_key_already_registered`에 막혀 빠져나갈 길이 없었다.
  - **재결속 규칙.** 소유자가 다시 로그인하면 같은 공개키 등록은 409 `device_key_rebind_required`를 받는다. 기기는 같은 등록 본문에 `rebind`를 실어 다시 보낸다. `rebind`는 **옮겨지는 키 자신**이 서명한 `momo.human.device_rebind.v1` 편지다.

    ```text
    momo.human.device_rebind.v1
    {workspace_id}
    {member_id}
    {key_id}
    {public_key_b64}
    {session_id}      호출자 자신의 계보(signing-context `sessionId`)
    {signed_at_ms}    서버 시각 ±5분
    ```

    서버는 저장된 key id·공개키와 호출자의 워크스페이스·멤버·계보로 바이트를 다시 만들어 그 키로 검증한다. 다음이 모두 성립해야 한다.
    - 호출자의 계보가 살아 있다(토큰 행을 먼저 공유 잠금한다).
    - 키가 살아 있고 호출자의 것이다.
    - 키의 현재 계보가 **회전할 수 없다**. 살아 있는 계보의 키는 옮기지 않는다.
    - 뿌리(`macos`) 키는 QR 연결 세션으로 옮기지 않는다.

    성립하면 행의 `session_id`만 바꾼다. id·승인서·서명 이력이 그대로라 폰의 승인이 유지되고(뿌리가 살아 있으면 곧바로 `endorsed`), 뿌리를 옮기면 그 뿌리가 승인한 폰도 다시 `endorsed`가 된다. workd 고정(D-6, 공개키·id)도 바뀌지 않는다.
  - **보안 성질.**
    - 훔친 refresh 토큰만으로는 재결속할 수 없다. 살아 있는 세션과 공개된 사실을 모두 가져도 키의 서명이 없다. 다른 키의 서명, 빈 서명, 다른 계보를 향한 편지, 오래된 편지는 모두 `device_signature_invalid`다.
    - 뿌리 키도 비밀번호 재확인 없이 옮긴다. #3022 H1의 비밀번호는 **새** 키가 뿌리가 되는 것을 막는 step-up이다. 재결속은 새 키를 들이지 않고, 그 키 자신의 서명이 비밀번호보다 강한 소유 증거다. 이 판단은 보안 검수 대상으로 PR에 명시한다.
    - 편지는 nonce 없이 1회용이다. 목적지 계보가 서명에 들어 있고, 서버는 호출자 자신의 살아 있는 계보로만, 회전할 수 없는 계보에서만 옮긴다. 계보는 되살아나지 않으므로 같은 편지를 다른 로그인에서 다시 내면 다른 계보를 가리키게 되고, 목적지 계보가 끝난 뒤에는 죽은 계보를 가리킨다. 그래서 095의 nonce 표(kind CHECK)를 넓히는 migration이 필요 없다.
    - `session_id`는 더 이상 불변이 아니다. 바뀌는 곳은 이 재결속 한 곳이고, 죽은 계보에서 산 계보로만 바뀐다. 서명 검사는 `session_id`를 잠그지 않고 읽는다. 옛 값을 읽었다면 죽은 계보를 보고 거부한다(fail-closed이고, 기기는 다시 서명하면 된다). 산 값을 읽었다면 그 값은 옮겨지지 않는다. 잠금 순서는 모든 세션 종료와 같다(토큰 행 → 키 행).
  - **폐기된 키는 옮기지 않는다.** 로그아웃·해제·폐기서·멤버 전체 종료 뒤의 재결속은 404 `device_key_not_found`다. 기기는 종전대로 새로 등록한다(새 id, 뿌리는 비밀번호, 폰은 재승인). D-6 증보(#3078)의 workd 재고정이 이 경우에 해당한다.
  - **새 공개 API(ADR-0100).** 등록 본문 `rebind`, 응답 200(재결속), 거부 코드 `device_key_rebind_required`, `DeviceKey.lineageLive`, `signing-context.sessionId`, 편지 스키마 `momo.human.device_rebind.v1`(momo-wire `DeviceRebind`). migration은 없다.
  - **094 주석.** `094_member_device_key.sql` 머리말과 `member_device_key.session_id` 컬럼 주석은 아직 「refresh 재사용이 키를 폐기한다」고 적혀 있다. 094는 고치지 않으며, 이 증보가 그 문장을 대신한다.
  - **클라이언트 계약(보안 검수 L2).** 편지의 `session_id`는 기기가 `signing-context`에서 받는다. 편지는 네이티브 층(Tauri·iOS)이 자기 인증된 `signing-context` 호출로 만들고, webview에 일반 「바이트 서명」을 열지 않는다. 재결속 200의 `current`가 `true`가 아니면 실패로 보고 알린다.
  - **남은 것(클라이언트).** 데스크탑 E5와 폰이 409 `device_key_rebind_required`와 `lineageLive: false`를 받아 편지에 서명하는 흐름은 후속이다. 그 전까지 이 상태의 기기는 서버에서 지시 불가로 남는다. 다만 키는 폐기되지 않으므로, 재결속을 구현한 클라이언트는 비밀번호나 재승인 없이 복구한다.
  - 시험: `device_key_conformance_pg`의 `a_reused_roots_key_is_mute_until_its_own_letter_moves_it` · `a_rebind_letter_is_single_use_and_only_ever_moves_a_dead_lineages_key` · `a_phone_key_moves_to_its_new_link_with_its_approval_and_logout_still_ends_it`, 그리고 재사용 단정을 「키 유지」로 뒤집은 세 시험(`a_reused_refresh_token_ends_the_whole_lineage` 외). momo-wire `device_rebind_bytes_are_fixed_and_bind_the_destination_lineage`, momo-server `session_end` `only_a_reuse_keeps_the_lineages_keys`.

- **증보 2026-09-29 — refresh 토큰 sender-constraint: 계보의 refresh 키가 서명한 증명(#3079). Accepted.** 결재 인용: 성재 2026-09-28 「ㄱㄱ」(응답 유실 대응 제안 1·2 지금, 3은 E10 전 — 조사 `claudedocs/refresh-loss/research.md`). 이 증보가 제안 3이다. 이슈 #3079 결재 코멘트: 「기기 키가 있는 세션의 refresh에 기기 키 증명(DPoP 방식) — 증명 있는 재사용은 정상 재시도로 재발급, 증명 없는 재사용만 계보 폐기. R2-E10(#3030) 전 필수」. 기안 Opus 5.5 worker(#3079).
  - **문제.** #3074의 재발급은 30초 창과 「후속 pair가 아직 살아 있음」에 기댄다. 절전·Cmd+Q(#3098 인계: tao 종료 이벤트는 거부할 수 없다)·끊긴 네트워크로 몇 분~몇 시간 뒤에 돌아온 기기는 둘 다 놓쳐서 로그아웃된다. 반대로 창 안에서는 옛 토큰을 가진 누구든 살아 있는 pair를 받는다(#3074 M1의 받아들인 비용). 서버는 토큰을 공유하는 두 클라이언트를 구별할 수단이 없었다.
  - **근거.** RFC 9449 §5: 공개 클라이언트의 refresh 토큰은 공개키에 결속되고 쓸 때마다 같은 키의 증명을 낸다. RFC 9700 §4.14.2는 sender-constraint를 회전과 나란한 MUST 선택지로 둔다. 결속된 토큰은 키 없이 복제해도 쓸 수 없으므로, 서버는 「증명 있는 재제시 = 그 기기의 재시도」로 읽을 수 있다.
  - **증명 형식 — momo-wire 스키마, DPoP JWT가 아니다.** 폰(Expo 네이티브)과 데스크탑(Tauri 셸)의 서명 경로는 이미 `\n`으로 이은 스키마 바이트에 raw r‖s P-256 서명을 만든다(D-1, low-s 정규화는 서버가 한다). DPoP JWT는 JWS 인코딩·DER↔raw 변환·JWK 썸프린트·`htu` 일치를 세 서명자에 새로 요구하고 얻는 것이 없다. 모양은 RFC 9449를 따르되 전선 형식은 관례를 따른다.

    ```text
    momo.human.refresh_proof.v1
    {workspace_id}
    {member_id}
    {public_key_b64}          refresh 키(33바이트 압축 SEC1, 정준 base64)
    {refresh_token_sha256}    제시한 refresh 토큰 원문의 SHA-256 소문자 hex
    {nonce}                   클라이언트 128비트, 서버 1회 소비
    {signed_at_ms}            서버 시각 ±5분
    ```

    토큰 해시 줄이 sender-constraint다(RFC 9449 `ath`의 역할). 증명은 그 토큰 하나에만 유효하다. 계보(`session_id`)는 넣지 않는다. 토큰이 이미 한 계보에 속하고, access가 만료된 기기는 `signing-context`로 계보를 물을 수 없다. 서버 nonce(DPoP-Nonce)는 왕복이 하나 더 들어 택하지 않았다. 재생은 시각 창과 nonce 1회 소비로 막는다(D-9와 같은 모양).
  - **별도 refresh 키가 필요하다.** 폰 키는 `biometryCurrentSet`(D-2)이라 서명마다 Face ID가 뜨고, 맥 키는 `userPresence`(D-3, 재사용 창 ≤300초)라 15분마다 도는 백그라운드 refresh에 쓸 수 없다. 그래서 기기는 **refresh 전용 SE P-256 키**를 따로 만든다. 접근 제어는 `privateKeyUsage`만(생체·암호 없음), 보관은 `ThisDeviceOnly`(백업·이전 불가), 폰은 백그라운드 refresh를 위해 `AfterFirstUnlockThisDeviceOnly`이고 NSE와 공유하지 않는 앱 전용 그룹이다.
    - 이 키는 **신뢰 역할이 없다.** 뿌리가 아니고, 승인되지 않고, 목록에 나오지 않고, 지시를 인가하지 않는다. refresh 토큰이 이미 주는 것 말고는 아무것도 열지 않고 refresh를 **좁히기만** 한다. 그래서 결재 범위(「기기 키 증명」) 안이다.
    - **`member_device_key`에 넣지 않는다.** 그 표의 행은 전부 신뢰 행위자다. 뿌리 후보는 「승인 없는 살아 있는 `macos` 키」로 정해지고, 공개키는 워크스페이스에서 살아 있는 동안 하나이며, #3097에 따라 재사용 뒤에도 살아서 다음 로그인에서 `device_key_rebind_required`로 재결속 편지를 요구한다. 거기에 종류 컬럼을 더하면 뿌리 판정·승인 CHECK·목록·세션 종료 경로 다섯 곳에 필터를 더해야 하고, 하나라도 빠지면 비밀번호 없이 올린 refresh 키가 뿌리가 된다. 대신 **새 표 `session_refresh_key`**(migration 096)를 둔다.
  - **결속(DB 계약, migration 096).** `session_refresh_key(workspace_id, session_id PK, member_id, alg, public_key)`: 계보당 키 하나. **첫 증명이 결속한다** — 살아 있는 토큰으로 온 첫 refresh의 증명이 자기 키로 서명이 맞으면 그 키를 계보에 묶고(`INSERT … ON CONFLICT DO NOTHING`), 이후 바뀌지 않는다. 새 로그인은 새 계보라 다시 결속한다(같은 공개키여도 된다). 행은 폐기하지 않는다. 계보가 끝나면 증명할 것이 없다. `refresh_proof_nonce(workspace_id, nonce PK, session_id, expires_at)`: 095 모양, 창이 닫힐 때(`signed_at_ms`+5분)까지 보관, 소비 전에 지난 행을 지운다. 두 표 모두 RLS ENABLE + FORCE + `ws_isolation`.
    - **TOFU 창 — 첫 토큰, 10분(보안 검수 M1).** 첫 증명 결속은 신뢰-첫-사용이다. 아무 계보에나 열어 두면 살아 있는 토큰을 한 번 복사한 쪽(웹 탭, 옛 클라이언트 계보)이 자기 키를 결속하고, 그 뒤로 「복구」로 계보를 마음대로 빼앗는다. 그래서 결속은 **그 계보가 한 번도 회전하지 않았고**(refresh 행이 로그인·QR 교환이 발급한 하나뿐) **그 행이 10분 안**일 때만 된다. 네이티브 클라이언트는 **로그인 직후 증명을 실은 refresh를 반드시 한 번** 한다(클라이언트 계약 MUST — 10분을 넘기면 그 로그인은 다음 로그인까지 결속되지 않고 `require`의 보호를 받지 못한다). 이 조건 밖의 계보는 다음 로그인까지 결속되지 않는다(종전 규칙 그대로). 로그인·QR 교환 자체에 키를 싣는 방법은 증명할 토큰이 아직 없어 다른 문장이 필요하다. 후속으로 둔다.
  - **검사 순서.** 서명(계보의 키인가) → 시각 창 → nonce 소비. 계보의 키로 서명이 맞지 않는 증명은 nonce를 쓰지 않는다. 진짜 기기가 아직 보낼 수 있기 때문이다.
  - **판정 표**(`momo-server` `auth_routes::answer_spent`가 한곳에서 정한다).

    | 제시 | 증명 | `observe`(기본) | `require` |
    |---|---|---|---|
    | 살아 있는 토큰 | 계보의 키, 검증됨 | 회전 | 회전 |
    | 살아 있는 토큰 | 없음 / 다른 키 / 시각 밖 / nonce 재사용 | 회전(종전) | 401 `refresh_proof_required`·`_invalid`·`_stale`·`_replayed`, **소비 안 함**, 계보 유지 |
    | 소비된 토큰 | 계보의 키, 검증됨 | 30초 안이고 후속 pair가 살아 있으면 그 pair(#3074), 아니면 **계보 복구**(시간 제한 없음) | 같음 |
    | 소비된 토큰 | 계보의 키지만 시각 밖·nonce 재사용 | 401 `_stale`·`_replayed`, 계보 유지 | 같음 |
    | 소비된 토큰 | 없음 / 다른 키 | 종전(#3074 재발급 → #3022) | **계보 종료**, 30초 안이어도, 비밀번호 로그인이어도 |
    | 결속 없는 계보(웹·옛 클라이언트) | — | 종전 | 종전 |

    - **계보 복구.** 계보가 아직 회전할 수 있으면(살아 있는 refresh 행이 있으면) 그 계보의 살아 있는 행을 **id 순서로 잠그고**(모든 계보 폐기와 같은 순서 — 꼬리를 먼저 잠그면 로그아웃과 교착한다, 재검수 M) 꼬리가 그 안에 살아 있을 때만 진행한 뒤(복구의 단일 사용 게이트 — 그 사이 커밋된 로그아웃·해제·폐기가 이기고 복구는 아무것도 발급하지 않는다, 보안 검수 H1) 그 계보의 살아 있는 토큰을 모두 폐기하고 **같은 계보**에 새 pair를 발급한다. 푸시 등록·기기 키·refresh 키는 그대로다. QR 연결이면 연결 행을 새 pair로 다시 묶는다. 멤버가 활성이 아니면 403이다. 로그아웃·해제·폐기·만료로 끝난 계보는 되살리지 않는다. #3074의 결정적 파생을 이어 가지 않고 새로 발급하는 이유: 파생은 `revoked_at`에 기대고 체인이 길어질수록 깨지기 쉽다. 증명이 있으면 서버가 기기를 알아보므로 같은 바이트를 재현할 필요가 없다.
    - **시각 밖·nonce 재사용은 복제가 아니다.** 서명이 계보의 키로 맞았으므로 제시자는 키를 가졌다. 복제로 보면 같은 본문을 다시 보낸 기기나 시계가 틀린 기기가 로그아웃된다(이 이슈가 막으려는 일). 클라이언트는 이 두 코드를 로그아웃으로 다루지 않고 새 nonce와 서버 시각(응답 `Date` 헤더)으로 다시 서명한다.
    - **`require`의 계보 종료는 30초 유예와 #3022 H2의 「비밀번호 로그인 제외」를 적용하지 않는다.** 유예는 웹 탭과 응답 유실을 위한 것인데, 키가 결속된 계보는 네이티브 한 프로세스이고 응답 유실은 증명으로 복구된다. 끝낼 때는 #3097 표의 「refresh 재사용」 행과 같다(토큰·푸시 폐기, 기기 키 유지).
  - **단계 도입 — `MOMO_REFRESH_PROOF_MODE=off|observe|require`, 기본 `observe`.** `observe`는 증명을 결속하고 검증된 증명을 복구에 쓰지만, 증명이 없거나 틀려도 결과를 바꾸지 않고 판정을 로그(`auth.refresh proof`)로 남긴다. 결속은 모드와 무관하게 남으므로 `require`로 바꾸는 순간 그동안 결속된 계보가 강제된다. `off`는 증명을 무시한다. 다른 값은 부팅 오류다. `require`는 폰·데스크탑이 증명을 싣는 빌드가 퍼진 뒤, R2 보안 검수(E10 #3030)와 함께 owner가 켠다.
  - **보안 성질과 남는 것.**
    - 복제된 refresh 토큰만으로는 결속된 계보를 회전할 수 없다(`require`). 창 안 공존(#3074 M1)도 닫힌다. 증명 없는 제시는 곧바로 계보를 끝낸다.
    - 키는 SE에서 나오지 않는다[S]. 기기에서 코드를 실행하는 공격자는 키로 서명을 **요청**할 수 있다. 그 경우는 이 설계가 막지 않는다(기기 침해는 D-10의 범위).
    - 캡처한 증명은 그 토큰, ±5분, 한 번에만 유효하다. 캡처한 요청 전체를 다시 보내면 `refresh_proof_replayed`로 거부되고 계보는 유지된다(탐지 신호 대신 오탐 없는 쪽을 택했다).
    - 모양이 틀린 `deviceProof`(형식 오류 JSON)는 본문 해석에서 4xx로 끝나고 아무것도 소비·종료하지 않는다.
    - **동시 복구.** 같은 기기가 복구를 두 번 동시에 보내면 진 쪽은 일반 401을 받는다. 클라이언트는 증명을 실은 refresh가 일반 401을 받으면 **새 증명으로 한 번 다시 시도**한 뒤에만 로그아웃한다(클라이언트 계약).
    - **받아들인 비용(보안 검수 L1~L3).** `require`에서는 결속된 계보의 소비된 토큰을 가진 누구든 그 계보를 끝낼 수 있다(#3022의 서비스 거부가 30초 창 안과 비 QR 계보로 넓어진다. 소비된 토큰도 JWT 만료 30일 뒤에는 1단계 검증에서 거부되므로 그 기간이 상한이다). 캡처한 요청을 그대로 재전송하면 계보 종료 대신 `refresh_proof_replayed`다. 결속은 판정 시점에 써서, 같은 요청이 멤버 비활성 등으로 거부돼도 남는다(첫 토큰·10분 조건 안에서만 가능하다).
  - **새 공개 API(ADR-0100).** `RefreshRequest.deviceProof`(`publicKey`·`nonce`·`signedAtMs`·`signature`), 401 코드 `refresh_proof_required`·`refresh_proof_invalid`·`refresh_proof_stale`·`refresh_proof_replayed`, 스키마 `momo.human.refresh_proof.v1`(momo-wire `RefreshProof`), 환경 변수 `MOMO_REFRESH_PROOF_MODE`, migration 096.
  - **클라이언트(후속, UXUI).** 폰·데스크탑이 refresh 키를 만들고, 로그인 직후 결속하고, 모든 refresh에 증명을 싣고, 네 코드를 다루는 일은 후속 이슈다. 데스크탑은 회전을 웹뷰에서 **Tauri 셸(Rust)로 옮긴다** — 키가 셸에 있고(D-3), 셸이 회전을 들면 Cmd+Q 중 회전이 끊겨도 다음 실행에서 증명으로 복구된다(#3098 인계). 그 전까지 이 서버 변경은 결속이 없는 모든 계보에 종전과 같다.
  - 시험: `refresh_proof_conformance_pg` 13건(응답 유실 1시간 뒤 복구 — 수리 전 RED, QR 연결 복구와 연결 재결속, 창 안 복제 → 종료, 다른 키 → 거부·종료, 재사용·시각 밖 → 거부·유지, `require` 미증명 → 소비 없음, `observe` 종전 유지, 웹 불변, 끝난 계보 불부활, 복구 중 로그아웃 경합, 결속은 새 로그인 첫 토큰만, 정지 멤버, 096 재적용·RLS), momo-wire `refresh_proof_bytes_are_fixed_and_bind_the_presented_token`, momo-auth `only_a_missing_or_foreign_proof_is_a_copy`.

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
| host 등록 서명 | member-scope host 등록에 `host_register` 서명을 요구한다. **E2 구현(#3022):** 보낸 서명은 항상 검증하고, 요구는 `MOMO_HOST_REGISTER_SIGNATURE_REQUIRED`(기본 꺼짐, D-11)로 켠다. 서명문의 `instance_id`는 `MOMO_INSTANCE_ID`이며 E3 발급 라우트가 같은 값을 내려 준다. **클라이언트 배선(#3120):** `momo-workd register --sign-stdin`이 host 키를 만든 뒤 자기 부모(데스크탑 셸)에게 표준입출력 한 줄로 서명을 청한다. 셸은 워크스페이스와 라벨을 자기 값으로 채우고, 자식이 준 host 공개키만 받는다. 네이티브 확인 창이 host 키 지문·키 전체·host id 전체·라벨을 모두 보일 때만(하나라도 빠지면 `device_key_dialog_incomplete`) Touch ID로 서명한다. 웹뷰의 `device_key_sign_control`은 `host_register`를 계속 거부한다. 뿌리 키가 묶이지 않은 맥은 서명 없이 등록하므로, 플래그를 켠 서버는 그 맥의 등록을 403으로 거부한다 | E2 #3022, 배선 #3120 |
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

## 증보 2026-09-28 — R2-E7 서명 지시 라우트와 `momo.human.control.v2` (#3027, #3068)

개정 절의 결정(D-5 페이로드, D-5b 별도 서명 지시 라우트, D-8 범위, D-9 재생 방지, D-10 검증 위치, D-11 플래그)을 코드 계약으로 옮긴다. 결정은 바꾸지 않았다. E4(#3063)·E3(#3075)가 남긴 인계 셋을 여기서 닫는다.

### v2 — 13줄 틀은 그대로, spawn만 달라진다

- 첫 줄이 `momo.human.control.v2`다. 줄 수와 순서는 v1과 같다. 줄 수를 세는 서명기(폰 네이티브 모듈, #3066)는 허용 스키마 문자열만 바꾸면 된다.
- **spawn 본문**은 `{agent_member_id}\n{folder_id}\n{tool}\n{channel_id}\n{NFC(first_prompt)}`다. v1은 도구와 채널을 서명하지 않아서, 서버가 유효한 서명 아래에서 둘을 바꿀 수 있었다(E4 인계 ①).
- **spawn 세션 줄**은 재개일 때 후속 세션 id를 담는다. 새 작업은 `-`다. 소유자가 후속 id를 정해 서명하고, 서버는 그 id로 세션을 만든다. 그래서 서버가 「소유자의 말이 붙을 세션」을 고르지 못한다(#3024 M2). 이것으로 R2를 켜면 재개가 403이 되던 문제가 풀린다(E3 인계 ③).
- **v1 수용 범위.** input·permission·bundle_manifest·host_register의 v1 바이트는 첫 줄만 다르고 뜻이 같다. 그래서 서버와 workd는 이 종류에 한해 v1 문장도 받는다(`HumanControl::verify_any`). v1 spawn은 받지 않는다. 폰이 지금 v1만 서명하므로 input·permission은 폰 허용 목록을 바꾸기 전에도 동작한다.
- agent·folder는 v1부터 본문에 서명돼 있다(E3 인계 ②). host는 지금 폴더 id를 실행에 쓰지 않는다(허용 폴더 하나). 여러 폴더를 받게 되면 host가 이 id로 폴더를 고른다.
- 공유 벡터: v1 `docs/api/human-control-signing.vectors.json`은 폰이 바이트 동일 사본을 두므로 고치지 않는다. v2 사례는 `docs/api/human-control-signing-v2.vectors.json`에 있다. WebCrypto·CryptoKit(소프트웨어 키 + Secure Enclave 임시 키) 서명을 Rust가 다시 검증한다.
- 서명 맥락 응답(`GET …/device-keys/signing-context`)에 `humanControlSchema: momo.human.control.v2`가 더해진다.

### 서명 지시 라우트 — `POST /v1/workspaces/{ws}/work-sessions/{session}/instructions`

- **닫힘.** `MOMO_HUMAN_CONTROL_SIGNATURE_REQUIRED`가 꺼져 있으면 403 `signed_instructions_disabled`로 거부한다(D-11).
- **주체.** 사람 bearer, 세션 소유자이자 member host 소유자만 된다(0188 D3). 세션 채널의 활성 멤버여야 한다(지시는 그 채널의 메시지이기도 하다, 403 `instruction_channel_member_only`). 에이전트 scope 목록과 host 서명 허용 목록에 넣지 않았다.
- **서명 필수.** `kind=input` 문장이 세션·host·NFC(text)·mode를 묶는다. `clientMsgId`는 nonce와 같아야 하고 본문 `mode`는 서명된 mode와 같아야 한다(400 `instruction_signature_mismatch`). 서버는 예약(queue)을 끼어들기(interrupt)로 바꾸지 못한다.
- **한 tx.** `input` 컨트롤(서명 컬럼, `action_signature`, 디스패치 이벤트), 세션 스레드 메시지, 감사 행 `work.instruction.sent`를 함께 쓴다. 메시지는 기존 send 헬퍼(`send_thread_notice_in_tx`)가 쓴다. root는 세션 루트 메시지, `client_msg_id`는 nonce, props `momo.instruction`에는 컨트롤 id와 mode가 들어간다. channel_seq·message·outbox가 한 tx인 것은 그대로다. `momo-messaging`은 바뀌지 않았다. 멘션 처리와 호스티드 에이전트 알림은 하지 않는다. 지시가 가는 곳은 ACP 세션이고, 다른 런타임을 깨우지 않는다.
- **재시도는 재생이 아니다.** 서명을 보기 전에 이 nonce를 단 컨트롤을 찾는다. 같은 지시면 200으로 같은 컨트롤과 메시지를 돌려준다(`replayed: true`). 다른 지시에 쓰인 nonce, 또는 이미 일반 메시지의 `clientMsgId`로 쓰인 nonce면 409 `instruction_nonce_reused`다(E3 인계 ①). props 키 `momo.instruction`은 서버 소유 키라 일반 메시지 전송에서는 지워진다.
- **정직한 거부.** 세션이 running·idle이 아니면 409 `work_session_not_accepting`, host가 폐기됐으면 409 `work_host_revoked`, 90초 안에 heartbeat가 없으면 409 `work_host_offline`이다. 모두 nonce를 쓰기 전에 판정한다. 그래서 같은 서명 지시를 나중에 다시 보낼 수 있다.
- **순서(#3001 계약).** queue는 진행 중인 턴과 이미 쌓인 지시 뒤에 간다. interrupt는 host가 진행 중인 턴을 ACP `session/cancel`로 취소한 뒤 큐 맨 앞에서 보낸다. 앞선 interrupt가 있으면 그 뒤, 모든 queue 앞이다(보낸 순서 유지). 턴이 없으면 바로 시작한다. 취소하는 턴이 기다리던 권한 요청은 `cancelled`로 답하고 서버에서 거둔다. 큐가 가득 차도 interrupt는 8개까지 더 받는다(서버가 이미 기록하고 nonce를 쓴 신호이므로). mode는 host가 검증한 서명 문장에서만 읽는다(R2 켠 host). 서명 없는 input, R2를 끈 host의 input은 queue다.
- 계약 골든: `docs/api/work-instruction.golden.json`.

### 서명 재개 — `POST …/work-sessions/{session}/resume`

- 본문에 `sessionId`(후속 세션 id)와 `humanSignature`(v2 spawn 문장)를 함께 싣는다. 하나만 오면 400 `resume_signature_incomplete`다. 이미 있는 id면 409 `resume_session_id_taken`이다.
- 서버는 원본 세션의 도구·채널·라벨과 후속 id로 문장을 다시 만들어 검증한다. member host 대상이고 플래그가 켜져 있으면 서명이 필수다(403 `device_signature_required`). 보낸 서명은 플래그와 무관하게 검증한다.

### 폐기서 v2와 workd 보관 (#3068)

- **`momo.human.device_revoke.v2`.** v1 줄들에 폐기 대상 공개키(압축 SEC1 33바이트의 base64) 한 줄을 시각 앞에 더한다. 승인서는 공개키를, v1 폐기서는 key id만 서명해서, 이 host가 본 적 없는 키는 뿌리가 어느 키를 폐기했는지 알 수 없었다. v2에서는 뿌리가 공개키에 서명한다. 서버의 폐기 라우트는 v2를 저장된 키 행의 공개키로 검증하고, 데스크탑 앱(E5, track/uxui #3076)이 지금 서명하는 v1도 받는다. 데스크탑이 v2로 옮기면 전달 경로도 공개키를 결속한다(UXUI 후속).
- **workd가 공개키를 받는 조건.** v2 폐기서(뿌리의 말)이거나, 로컬 소켓(코드서명 확인된 데스크탑 앱의 말)일 때만 받는다. 서버가 전달한 v1 폐기서의 공개키는 서명 밖 값이라 받지 않는다. 서명된 key id와, 이 host가 그 id로 이미 본 키만 폐기하고 `revocation_key_unsigned`로 답한다. 전에는 키 A의 진짜 폐기서에 키 B의 공개키를 붙이면 B까지 폐기됐고, 미끼 키를 붙이면 A의 진짜 키가 새 id로 돌아올 수 있었다(보안 검수 High). v2 폐기서의 공개키를 서버가 바꾸면 서명이 맞지 않아 폐기서 전체가 거부된다. 서버가 폐기를 숨기는 것과 같고, 그 경우는 로컬 소켓이 막는다(D-7).
- **영구 보관.** 적용한 폐기서는 모두 `human-trust.json`의 `revocations`(폐기된 key id별, 스키마·받은 공개키 포함)에 남는다. 서버는 최신 256개만 전달하므로, 전달 목록에서 빠진 폐기도 재시작 뒤까지 유지되어야 한다.

### 버전 정합

| 표면 | 서명하는 control 스키마 | 비고 |
|---|---|---|
| 서버(momo-auth `verify_human_control_in_tx`) | v2, 그리고 spawn 외 v1 | 이 증보 |
| workd(`human_trust::check_control`) | v2, 그리고 spawn 외 v1 | 이 증보 |
| 폰 네이티브 모듈(#3066) | v1만 허용 | spawn(새 작업·재개)을 서명하려면 허용 목록을 `momo.human.control.v2`로 옮겨야 한다(UXUI 후속). input·permission은 지금도 받는다 |
| 데스크탑 Tauri(E5 #3025, track/uxui #3076) | control.v1(다섯 종류 모두), device_endorse.v1, device_revoke.v1 | spawn(새 작업·재개)은 control.v2로 옮겨야 서버·host가 받는다. 폐기서는 v1도 받지만(전달되면 id만 폐기), 공개키 결속을 위해 device_revoke.v2로 옮긴다(UXUI 후속). input·permission·host_register는 v1 그대로 받는다 |

### 남은 것

- 플래그 켜기는 R1 재검수와 R2 보안 검수(E10 #3030) PASS 뒤다(D-11 그대로).
- 뿌리를 고정하기 전에 받은 폐기서는 지금처럼 버린다(`root_not_pinned`). 고정 뒤 256개 창 안의 폐기서는 다음 poll에 다시 온다.
- 재개 봉투의 `agentMemberId`·`folderId`는 서명에 들어가지만 서버가 원본 세션과 대조하지는 않는다. host가 폴더 id를 실행에 쓰기 시작할 때 함께 묶는다.
- 서명 재개의 후속 세션 id가 다른 워크스페이스의 세션 id와 겹치면(전역 PK) 이름 없는 500이 난다. 무작위 UUID라 우연히는 일어나지 않고, 알려진 id를 일부러 넣어도 권한 이득은 없다(보안 검수 Low).
- 서버에서 새 작업 spawn을 서명과 함께 만드는 경로는 아직 없다. 재개만 서명된 spawn을 만든다. 폰의 새 작업(0188 D4 DM → spawn)은 E8 이후다.

## 증보 2026-09-29 — workd 서명 요구 래칫 (#3117)

E10 검수(B1)는 D-10의 보안 경계인 workd 검증을 켜는 길이 제품에 없다고 판정했다. workd의 `require_human_signatures`는 기본 꺼짐이고 데스크탑 설정 작성이 이 키를 쓰지 않는다. 서버 플래그를 모두 켜도 서버·DB 관리자가 서명 없는 행을 넣거나 봉투를 떼면 소유자 맥에서 실행된다. 이 증보는 D-10을 이행하는 구현 계약이며 결정은 바꾸지 않는다. 결재 인용: R2 결재 「전부 권장대로」(성재 2026-09-28)의 D-10.

- **켜는 원천은 둘이다.**
  - 소유자 설정 `require_human_signatures: true`: 파일이 그렇게 말하는 동안 켜져 있다(종전 그대로).
  - **서버 신호의 래칫.** `GET …/work-hosts/{host}/pending-controls` 응답에 `humanControlSignatureRequired`(= `MOMO_HUMAN_CONTROL_SIGNATURE_REQUIRED`, `signing-context`와 같은 값)를 싣는다. workd는 이 값이 `true`이고 **이 맥에 뿌리가 고정돼 있을 때** host 상태 폴더의 `human-required.json`(0600)에 기록한다. 기록은 같은 응답의 컨트롤을 적용하기 **전에** 끝난다. 그 뒤로는 서버가 무엇을 보내든 서명을 요구한다.
- **서버는 켜기만 한다(D-6).** 서버의 `false`는 보고에만 쓰이고 래칫을 내리지 않는다. 켜는 쪽은 서버가 이미 할 수 있는 일(컨트롤을 보내지 않기)보다 더 주지 않는다. 뿌리 고정과 신뢰는 종전처럼 로컬 소켓만 바꾼다.
- **뿌리가 없으면 켜지 않는다.** 뿌리 없이 켜면 서명된 지시까지 모두 `device_root_not_pinned`로 거부해 작업이 멈춘다(E10 M4의 역순서 위험). 이때 workd는 서버 신호를 메모리에만 두고 보고한다. 데스크탑 앱이 `pin_root`를 하면 다음 poll에서 래칫이 걸린다. 그래서 E10 「켜는 순서」 6은 서버 `MOMO_HUMAN_CONTROL_SIGNATURE_REQUIRED=true` 하나로 끝난다. 뿌리가 고정된 host는 다음 poll(기본 2초)에 따라 켜진다.
- **반쯤 상태를 정직하게 보인다.** 제어 소켓 `status.humanSignatures`에 `required`(유효값), `requiredBy`(`config` · `server` · `unreadable`), `latchedSinceMs`, `serverRequired`(서버의 마지막 말)를 싣는다. 데스크탑 `device_key_status`의 `host.signatureEnforcement`가 `enforced` · `server_only` · `off`로 옮긴다. `server_only`는 「서버는 요구하는데 이 맥은 아직 강제하지 않음(뿌리 없음)」이다. 이 값을 그리는 화면은 UXUI 후속이다.
- **끄기는 로컬에서만.** 코드서명 확인 제어 소켓의 새 op `reset_signature_requirement`가 래칫 파일을 지운다. 설정의 `true`는 지우지 않는다. `forget`·`register`(새 등록 = 새 host)도 지운다. `reset-root`는 지우지 않는다. 래칫이 걸린 채 뿌리를 재설정하면 다시 고정할 때까지 거부하는데, 이것이 의도한 순서다. 이 op를 부르는 데스크탑 명령은 이번에 만들지 않았다. 웹뷰에서 부를 수 있는 명령으로 열려면 서명 명령처럼 네이티브 확인 창(`confirm.rs`) 뒤에 둔다(후속).
- **읽을 수 없으면 켜진 것으로 본다.** 래칫 파일이 있는데 읽거나 해석할 수 없으면 켜진 것으로 본다. 이때 신뢰 상태도 읽을 수 없으면 시동을 거부한다. 설정 `true`와 같은 규칙이다. 래칫 파일을 쓰지 못해도 메모리에서는 켜고, 다음 poll에서 다시 쓴다. 쓰기 전까지 `status.humanSignatures.latchSaved`가 `false`다.
- **「R2 켜짐」은 요구 상태다.** 서명 입력의 `mode`(interrupt)도 요구가 켜져 검증을 거친 봉투에서만 읽는다. 신뢰 상태가 늘 붙는다고 해서 검증 안 된 봉투를 믿지 않는다(보안 검수 Low-1).
- **남는 위험: 래칫 전의 서버.** 켜는 계기가 서버의 첫 `true`다. 래칫이 걸리기 전에 이미 탈취된 서버, 또는 `forget`·`register` 뒤 새 host의 서버가 계속 `false`를 보내면 host는 켜지지 않는다. 걸린 래칫을 서버가 내릴 수는 없다. 소유자가 서버와 무관하게 켜는 길은 설정 `true`다. 데스크탑이 `pin_root` 때 소유자 의사로 래칫을 거는 안은 서버 플래그가 꺼진 동안 서명 없는 클라이언트의 허락·재개를 모두 막는다(E10 M4). 그래서 이번에는 택하지 않았고 후속 검토로 둔다.
- **옛 버전.** 이 필드를 모르는 workd는 무시하고 종전처럼 동작한다. 이 필드를 보내지 않는 서버는 `false`와 같다. 플래그가 꺼져 있으면 응답 바이트가 종전과 같다(필드 생략).

### 새 공개 API 선언 (ADR-0100)

| 표면 | 변경 | 이슈 |
|---|---|---|
| `GET /v1/workspaces/{ws}/work-hosts/{host}/pending-controls` | 응답에 `humanControlSignatureRequired: true`를 더한다. `false`이면 생략한다 | #3117 |
| workd 제어 소켓 | `status.humanSignatures`에 `requiredBy`·`latchedSinceMs`·`serverRequired`를 더한다. op `reset_signature_requirement`를 더한다 | #3117 |
| workd 상태 폴더 | `human-required.json`(래칫, 0600) | #3117 |

### 시험

- `momo-workd` `workd_conformance_pg::wdc_8_r2_the_product_path_latches_the_host_and_the_server_cannot_undo_it`: 실제 바이너리와 실제 서버 라우터를 쓴다. 설정은 데스크탑 `build_config`가 쓰는 모양이고 `require_human_signatures`가 없다. 소켓 `pin_root` 뒤 래칫이 걸린다. 그 뒤 서명 없는 삽입 행과 봉투를 뗀 서명 지시가 거부된다. 서버를 플래그 꺼짐으로 재시작해도, host를 재시작해도 거부된다. 로컬 op로만 풀린다.
- `invariants::inv_35_r2_the_servers_word_latches_the_host_with_a_root_and_never_lowers_it`: 같은 규칙을 DB 없이 확인한다. 래칫이 같은 응답의 컨트롤보다 먼저 걸리는지도 본다.

## 증보 2026-09-29 — 허락이 미리보기를 묶는다: `momo.human.control.v3` (#3118, R2 H1)

결재 인용: 성재 2026-09-28 「전부 권장대로」(R2 결재, D-5 「서명은 사람이 본 것을 묶는다」의 이행) + E10 보안 검수(#3030, `claudedocs/resume-2026-09-23/review-r2-e10.md`) H1. D-5·D-10의 결정을 바꾸지 않고, v2가 빠뜨린 한 줄을 더한다.

### 무엇이 열려 있었나 (H1)

- v2까지 permission 본문은 `{request_event_id}\n{option_id}\n{option_kind}\n{scope}`였다. host는 이 넷만 대조했다.
- 카드의 미리보기는 요청 직전에 **서버가 전달한** `agent.status`에서 추론했다(`agentPane.ts` `pendingPermission`). workd의 `approval.requested`에는 선택지만 실렸다.
- 그래서 악의적 서버가 샌드박스 밖 명령 요청 앞의 이벤트를 「파일을 읽어도 될까요? README.md」로 바꾸면, 소유자의 Face ID 허락이 유효한 서명이 되어 host가 실제 명령을 허락했다.

### 결정

- **host가 원천이다.** workd가 ACP `session/request_permission`의 도구 호출(요청의 `toolCall`에, 에이전트가 앞서 알린 같은 `toolCallId`의 필드를 합친 것)에서 미리보기를 만든다.
  - 닫힌 객체 `momo.work_permission.preview.v1`: `schema`, `kind`(ACP ToolKind 닫힌 어휘, 그 밖은 `other`), `title`, `locations`(경로, 줄마다 하나), `input`(원 입력의 압축 JSON), `truncated`.
  - 정화는 0188 D5 규칙 그대로다. 보이지 않는 문자·방향 제어·줄/문단 구분자를 지우고(릴레이 집합 ∪ 자격 스캔의 보이지 않는 집합 ∪ U+2028/2029), 자격 문자열을 가리고, 필드당 3,500자에서 앞뒤를 남기고 자른다. 하나라도 자르면 `truncated`가 참이다.
  - 자격 문자열은 host 가림(`redact_credentials`)에 더해, 앱 표시 정화(`agentPane.ts` `CREDENTIAL_PATTERNS`)가 가리는 모양을 모두 같거나 더 넓게 가린다(`mask_display_shapes`, 보안 검수 M1). 그래야 정직한 `Authorization: Bearer …` 요청도 앱이 바꾸지 않고 보여 주어 허락할 수 있다.
  - 정규 바이트는 그 객체의 `canonical_json`(bundle_manifest와 같은 함수)이다. 해시는 그 SHA-256 소문자 hex다(`momo_wire::permission_preview`).
- **host는 요청을 올리기 전에** 해시를 세션의 원장(`SessionManager::permission_preview_sha256`)에 적는다. `approval.requested`에 `preview`와 `preview_sha256`을 싣는다.
- **서버는 그대로 중계한다.**
  - 수신 때 둘이 함께 오고 서로 맞는지만 확인한다(정직한 행의 일관성).
  - 요청 행(`work_permission_request.preview`·`preview_sha256`, migration 097)에 저장한다.
  - 세션 스레드 메시지와 실시간 방송에서는 `preview`를 빼고 해시만 남긴다(0188 D5 「채널로 방송하지 않는다」).
  - 미리보기는 소유자 조회 `GET /v1/workspaces/{ws}/work-sessions/{session}/permission-requests/{requestEventId}`로만 준다. 사람 bearer이고 세션 소유자이자 host 소유자여야 한다. 그 밖은 없는 요청과 같은 404다. 에이전트 scope 목록과 host 서명 허용 목록에 넣지 않았다.
- **`momo.human.control.v3`.** v2의 13줄 틀 그대로이고 첫 줄만 v3다. permission 본문에 다섯째 줄 `{preview_sha256}`이 붙는다. 다른 kind의 본문은 v2와 같다.
  - `ControlContent::Permission.preview_sha256`이 어떤 본문이 있는지 정한다. `Some`이면 v3 본문만 만들어지고(v1·v2로는 만들 수 없다), `None`(미리보기 없이 기록된 옛 요청)이면 v1·v2 본문만 만들어진다.
  - 그래서 `verify_any`는 미리보기가 있는 요청에 v1·v2 허락을 받지 않는다. 다른 kind는 v2를, input·bundle_manifest·host_register는 v1도 전처럼 받는다.
- **앱은 자기가 렌더한 미리보기로 해시를 다시 계산한다**(`@momo/core` `checkPermissionPreview`, 폰·데스크탑·웹 공용). 서명하는 조건은 넷이다.
  - 닫힌 객체다.
  - 표시 정화(`sanitizeDisplayText`)가 어느 필드도 바꾸지 않는다. 가림·무력화·자름이 없어 본 것이 곧 서명할 바이트다. host 정화가 코어 정화의 상위 집합이라 정직한 미리보기에서는 일어나지 않는다.
  - 다시 계산한 해시가 요청의 `preview_sha256`과 같다.
  - `truncated`가 거짓이다(0188 D5 「잘린 미리보기는 펼치기 전에는 허용할 수 없다」).
  - 서명에는 **다시 계산한** 해시를 싣는다.
- **서버의 검증**(`verify_human_control_in_tx`)은 저장된 해시로 문장을 다시 만든다. 클라이언트의 말은 쓰지 않는다. **host의 검증**(`check_control_with_preview`)은 자기 원장의 해시로 다시 만든다. 원장에 없는 요청(이미 답했거나, 거둬졌거나, 이 host가 올린 적 없는 요청)의 permission은 `permission_request_unknown`이다.
- **결과.** 서버는 앱이 보여 주는 것을 바꿀 수 있다. 그러나 허락이 뜻하는 바는 바꾸지 못한다.
  - 미리보기만 바꾸면 앱이 해시 불일치로 서명하지 않는다.
  - 미리보기와 해시를 함께 바꾸면 앱은 바꾼 미리보기의 해시에 서명한다. host가 자기 해시와 달라 거부한다(`device_signature_invalid`). 에이전트는 계속 기다린다.

### 호환 — 실패 쪽으로 닫는다

- 이 PR 뒤 host는 모든 권한 요청에 미리보기를 싣는다. 그래서 workd R2를 켠 host에서는 permission 허락이 사실상 v3만 된다.
- 폰 네이티브 서명기(#3066)와 데스크탑 셸(E5)은 아직 v1/v2 permission 본문을 서명한다. **workd R2 스위치(#3117)를 켜기 전에 두 서명기의 v3 전환(uxui 후속)이 먼저 배포되어야 한다.** 그 전에 켜면 서명한 허락이 host에서 `device_signature_invalid`가 된다. 거부·중단은 서명이 필요 없어 그대로 된다.
- v2 허락을 경고만 하고 받는 선택은 버렸다. 받으면 H1이 그대로 열려 있다.
- 서버도 미리보기가 저장된 요청에는 v2 허락을 403 `device_signature_invalid`로 거부한다. 미리보기 없이 기록된 요청(097 이전 행, 옛 host)은 v2 허락을 전처럼 받는다.

### 버전 정합 (갱신)

| 표면 | control 스키마 | 비고 |
|---|---|---|
| 서버 | v3; v2(미리보기 있는 permission 제외); v1(spawn·미리보기 있는 permission 제외) | 이 증보 |
| workd | 같음. permission은 자기 원장의 해시로만 다시 만든다 | 이 증보 |
| 폰 네이티브 모듈 | v1만 허용 | permission 허락을 v3로 옮겨야 한다(uxui 후속, #3117 켜기 전 필수) |
| 데스크탑 Tauri | control.v1 | 같음. 확인 창에 미리보기를 보여야 한다(#3076 잔여, uxui 후속) |

- 공유 벡터: `docs/api/human-control-signing-v3.vectors.json`(permission 두 사례는 미리보기 객체·정규 바이트·해시를 함께 싣는다). WebCrypto·CryptoKit(소프트웨어 + Secure Enclave) 서명을 Rust가 다시 검증한다. 코어의 사본 `packages/momo-core/src/features/workbench/__fixtures__/permission-preview.vectors.json`은 Rust가 벡터와 같은지 확인한다.

### 남은 것 (uxui 후속)

- 폰·데스크탑 서명기의 v3 permission 본문. 폰 Swift 허용 목록과 `humanControl.ts`, 데스크탑 `payload.rs`를 옮긴다.
- 폰 권한 카드와 데스크탑 칸이 미리보기를 소유자 조회로 받는다. `checkPermissionPreview`가 통과할 때만 허락 버튼을 연다.
- 데스크탑 네이티브 확인 창에 같은 미리보기를 보인다(#3076·#3094 잔여).
- 잘린 미리보기를 펼칠 전체 미리보기 조회는 없다. 잘린 요청은 거부하거나 맥 앞에서 결정한다.

## 증보 2026-09-29 — 폰 키는 QR 연결로만 (#3119)

E10 검수(H2)는 D-6 ②의 전제가 서버에서 강제되지 않는다고 판정했다. `ios` 키는 웹·비밀번호 로그인을 포함한 어느 세션에서나 등록됐고, 데스크탑의 승인 목록은 폐기되지 않은 모든 `ios` 키를 후보로 보였다. 웹 refresh 토큰을 훔친 공격자는 자기 P-256 키를 「성재의 iPhone」으로 올리고, 소유자가 한 번 승인하면 Face ID 없이 지시·허락을 서명한다. 결재 인용: 성재 2026-09-29 「QR 연결로만 등록」(이슈 #3119 코멘트: 「ios 기기 키 등록은 QR 연결(device_link) 세션에서만 허용, 그 외 세션(웹·주소/비밀번호 로그인 폰)은 거부(이름 있는 오류) … 기존 비QR 세션에서 등록된 ios 키는 승인 후보에서 빼고(또는 폐기) 이관 규칙을 ADR-0146 증보에」). 기안 Opus 5.5 worker(#3119).

- **기원 판정.** 「QR 연결 계보」는 그 계보(`token.session_id`)가 `device_link_token`을 교환해 생긴 것이다. 근거는 행 자체다. 교환된 행의 `redeemed_access_token_id`·`redeemed_refresh_token_id`가 그 계보의 token 행을 가리킨다. 회전하면 이 두 id가 새 짝으로 옮겨지고 계보 id는 그대로다. 교환된 행은 지워지지 않는다(지우는 것은 교환 전 만료 행뿐이다). 이 행을 만드는 길은 `consume_device_link_in_tx` 하나이고, 요청이 이 사실을 지어낼 필드는 없다. 판정은 `momo_auth::device_key::session_is_device_linked_in_tx`와 목록 열 `linked_session`이 같은 SQL(`linked_lineage_sql!`)로 한다. 뿌리 거부(`device_root_linked_session`)도 이 판정으로 옮겼다. 종전의 `token.device_label IS NOT NULL`과 결과는 같지만, 두 방향(폰은 연결 계보여야, 뿌리는 연결 계보가 아니어야)이 한 정의를 쓴다.
- **등록.** `ios` 키는 연결 계보에서만 등록한다. 그 밖(웹, 비밀번호·주소 로그인 폰, 데스크탑)은 403 `device_key_requires_linked_session`이고 아무것도 쓰지 않는다. 뿌리 키가 아직 없어도 등록은 된다(#3088 「QR 직후 자동 등록」 순서).
- **자가 QR을 막는 승인 조건.** QR 발급은 사람 bearer 하나면 된다. 그래서 훔친 웹 토큰은 QR을 스스로 발급하고 교환해 연결 계보를 얻을 수 있다. 등록만 막으면 H2는 두 요청으로 다시 열린다. 그래서 승인(`device_endorse`)에 둘을 더 요구한다.
  1. 대상 키가 연결 계보다(아니면 403 `device_key_requires_linked_session`).
  2. 그 QR을 발급한 로그인 계보(`device_link_token.issued_session_token_id`의 `session_id`)에 같은 멤버의 `macos` 키 행이 있다. 폐기된 행도 센다(아니면 403 `device_key_link_not_from_mac`). 뿌리는 비밀번호 재입력이 필요하다(개정 D-6 ①, 검수 H1). 그래서 훔친 웹 토큰의 계보에는 `macos` 키가 생기지 않는다. 폐기된 행을 세는 이유는 데스크탑이 로그아웃·재로그인해도 그 폰들을 다시 승인할 수 있게 하기 위해서다. 로그아웃은 키 행을 지우지 않는다. 단 #3097 재결속은 맥 키 행 자체를 새 계보로 옮긴다. 그래서 맥 계보가 재사용·만료로 끝나 키가 옮겨지면, 옛 계보가 발급한 QR로 연결됐고 아직 승인 전인 폰은 `device_key_link_not_from_mac`가 된다. 그 폰은 맥에서 QR로 다시 연결한다. 이미 승인된 폰은 승인이 그대로이고 목록에서만 `linkedFromMac: false`로 읽힌다. 발급 계보를 이력으로 남기는 보강은 후속이다.
- **재결속(#3097).** `ios` 키는 연결 계보에서 연결 계보로만 옮긴다. 호출자 계보와 키의 현재 계보가 모두 연결 계보여야 한다(아니면 403 `device_key_requires_linked_session`). 키 자신의 `device_rebind.v1` 서명 요구는 그대로다. 뿌리 키는 종전대로 연결 계보로 옮길 수 없다. 옮겨 갈 계보의 QR 발급자(`linkedFromMac`)는 보지 않는다. 옮기려면 키 자신의 서명이 필요해서 공격자가 쓸 수 없는 경로이기 때문이다.
- **규칙 이전에 등록된 키(이관).**
  - **승인 전 키는 후보에서 뺀다.** 서버가 승인을 거부한다. 클라이언트 필터에 맡기지 않는다. 옛 데스크탑·웹도 우회하지 못한다. 목록에는 남아 있고 `linkedSession: false`다. 공유 코어 `phoneKeys`도 이 키를 후보로 보이지 않는다.
  - **승인된 키는 유지하고 「QR 아님」으로 표시한다.** 자동 폐기는 택하지 않았다. 근거는 셋이다. 첫째, 소유자가 지문을 대조해 승인한 키를 서버가 일방적으로 끊으면 폰 지시가 예고 없이 멈춘다. 이 규칙이 막으려는 것은 앞으로의 심기다. 둘째, R2 플래그는 R1·R2 PASS 전까지 닫혀 있다(D-11). 닫힌 동안에는 폰 키의 승인이 권한을 더하지 않는다. 그래서 소유자는 플래그를 켜기 전에 목록을 보고 정리할 수 있다. 셋째, 소유자는 목록의 「QR 아님」 표시를 보고 맥에서 서명 폐기서(D-7)로 끊을 수 있다. 목록 DTO의 `linkedSession`·`linkedFromMac`이 표시의 근거다. 표시 화면은 UXUI 후속이다.
  - 규칙 이전 키는 재결속으로 옮길 수 없다(위 규칙). 계보가 끝나면 그 키도 멈춘다. 그 폰은 맥에서 QR로 연결해 새로 등록하고 다시 승인받는다.
- **UX 비용.** 주소(비밀번호)로 로그인한 폰은 지시 기기가 되려면 맥에서 QR로 한 번 연결해야 한다. 웹에서 발급한 QR로 연결한 폰도 승인할 수 없다. 이것은 D-4(웹은 비지시 표면)와 맞는다. 폰 안내 문구 한 줄은 이 PR에 있다. 폰 화면 흐름과 데스크탑 목록의 「QR 아님」 표시는 UXUI 후속 이슈다.
- **남는 위험.** 데스크탑 계보의 refresh 토큰을 훔치면 그 계보에서 QR을 발급할 수 있다. 이 경우는 승인 조건 2를 통과한다. 맥이 연 QR로 연결된 **폰 계보**의 refresh 토큰을 훔쳐도 같다. 한 계보에 폰 키가 몇 개인지 제한하지 않으므로, 그 계보에 두 번째 `ios` 키를 임의 이름으로 올리면 승인 후보가 된다. 계보당 살아 있는 폰 키를 하나로 묶는 안은 아래 「증보 2026-09-29 — 계보당 폰 키 1개 (#3127)」로 닫았다(독립 보안 검수 Medium). 이 위협은 #3079의 refresh 증명(`require`)이 막는다. `observe`인 동안은 E10 위협표의 「결속된 계보」 행과 같다. 서버는 조언자이고 보안 경계는 workd다(D-10). workd는 뿌리가 서명한 승인서만 받는다. 이 증보는 소유자가 속아 승인하는 경로를 좁힌다.

### 새 공개 API 선언 (ADR-0100)

| 표면 | 변경 | 이슈 |
|---|---|---|
| `POST /v1/workspaces/{ws}/device-keys` | `ios` 등록과 `ios` rebind는 QR 연결 계보에서만. 그 밖은 403 `device_key_requires_linked_session` | #3119 |
| `POST /v1/workspaces/{ws}/device-keys/{key}/endorsement` | 403 `device_key_requires_linked_session`, 403 `device_key_link_not_from_mac` | #3119 |
| `DeviceKey`(목록·응답) | `linkedSession`, `linkedFromMac`(필수 bool)을 더한다 | #3119 |

새 migration은 없다. 판정은 기존 `device_link_token`·`token`·`member_device_key` 행에서 읽기마다 유도한다.

### 시험

- `momo-server` `device_key_conformance_pg::h2_a_phone_key_is_registered_only_on_a_qr_linked_sign_in`: 비밀번호 로그인과 그 회전(훔친 refresh 토큰의 모양)의 `ios` 등록이 403이고 행을 쓰지 않는다. QR 연결 폰은 뿌리가 생기기 전에도 등록된다. 훔친 토큰이 스스로 연 QR 계보의 키는 등록되지만 승인이 `device_key_link_not_from_mac`이다. 맥이 연 폰은 승인된다.
- `h2_a_pre_rule_phone_key_is_never_a_candidate_and_an_approved_one_is_marked`: 규칙 이전 모양의 행(비밀번호 계보의 `ios` 키)은 승인이 거부된다. 이미 승인된 행은 `endorsed`·`canInstruct`를 유지하고 `linkedSession: false`로 읽힌다. 계보가 끝나면 연결 계보로도 옮길 수 없다.
- `h2_a_phone_key_moves_only_from_a_link_to_a_link`: 비밀번호 로그인은 키의 유효한 재결속 서명을 들고도 옮길 수 없다. 새 QR 연결로는 옮긴다.
- 사보타주 6종(등록 검사, 승인의 두 검사, 재결속 규칙, 기원 SQL의 계보 대조, 발급자 계보 대조를 각각 뺌)은 모두 위 셋 중 하나를 빨갛게 만든다. 원문은 PR 본문에 있다.

## 증보 2026-09-29 — 계보당 폰 키 1개 (#3127)

#3119 검수 Medium: 맥 QR로 정상 연결된 폰의 refresh 토큰을 훔치면 그 계보에 두 번째 `ios` 키를 임의 이름으로 올려 승인 후보를 만들 수 있다. 결재 인용: R2 결재 「전부 권장대로」(성재 2026-09-28) + E10 후속 planner 편성(#3127). 기안 worker(#3127).

- **규칙.** 한 로그인 계보(`token.session_id`)에 살아 있는(미폐기) `ios` 키는 하나다. 같은 계보의 두 번째 등록은 409 `device_key_lineage_has_phone_key`이고 아무것도 쓰지 않는다. 재결속(#3097)으로 다른 계보의 키를 이미 폰 키가 있는 계보로 옮기는 것도 같은 코드로 거부한다. 승인(`device_endorse`)도 대상과 같은 계보에 다른 살아 있는 `ios` 키가 있으면 같은 코드로 거부한다. 규칙 이전에 생겼거나 경합이 남긴 중복이 후보가 되지 못하게 하려는 것이다. 맥이 한 키를 서명 폐기서(D-7)로 끊으면 나머지를 승인할 수 있다.
- **교체는 (b) 맥이 개입해야 한다.** 두 안을 비교했다.
  - (a) 교체 시 옛 키를 자동 폐기하고 새 키를 승인 전 상태로 시작한다. 훔친 토큰이 정상 키를 밀어내고 자기 키를 후보로 세울 수 있다. 소유자가 맥에서 거부하면 끝나지만, 공격자가 만든 후보가 매번 목록에 나타나 「키가 바뀌었어요」 표시에 의존하게 된다. 정상 폰의 지시도 예고 없이 멈춘다.
  - (b) 옛 키가 폐기되기 전에는 새 키를 받지 않는다. 옛 키는 Face ID 재등록으로 서명 불가지만 서버 행은 살아 있다. 그래서 폰의 「새 키로 다시 등록」은 (1) 맥이 옛 키를 서명 폐기서로 끊은 뒤 등록하거나 (2) 폰을 맥 QR로 다시 연결해(새 계보) 등록한다. 어느 쪽이든 새 키는 승인 전(`unendorsed`, 지시 불가)으로 시작하고 맥 승인이 필요하다. 같은 공개키의 재시도(응답 유실)는 종전대로 `device_key_already_registered`다.
  - 택한 것은 (b)다. 근거: 훔친 토큰은 서명 폐기서를 만들 수 없고(뿌리 키 서명 필요), 새 QR 연결은 맥 앞에서 일어나므로 이미 자리를 잡은 정상 키 곁에 도둑이 후보를 **더 만들 수는** 없다. 승인 필요라는 성질을 (a)보다 한 겹 앞에서 지킨다. 비용은 폰 단독으로 교체를 끝낼 수 없다는 점이다. UX 문구·흐름(409를 받은 「새 키로 다시 등록」이 「맥에서 이전 키를 끊거나 QR로 다시 연결」을 안내)은 UXUI 후속이다. 서버는 `device_key_lineage_has_phone_key`를 이름 있는 오류로 준다.
- **경합.** 같은 계보의 동시 등록·재결속·승인은 계보 단위 트랜잭션 advisory lock(`pg_advisory_xact_lock`)으로 직렬화한다. 토큰 행(계보) 잠금과 키 행 잠금 뒤에 잡고 그 밖의 대기를 하지 않아 잠금 순서(#3109)를 바꾸지 않는다.
- **남는 위험: 먼저 등록하는 쪽이 자리를 잡는다.** QR 교환 직후 정상 폰이 등록하기 전(#3088의 자동 등록이 즉시 이어지므로 창은 짧다), 또는 맥이 옛 키를 폐기한 직후 새 키가 오기 전에 그 계보의 refresh 토큰을 가진 도둑이 먼저 등록하면 그 키가 유일한 후보가 되고 정상 폰은 409를 받는다. 후보는 여전히 맥 승인 없이 지시할 수 없고, 맥 목록에 키 하나가 도둑이 정한 이름으로 보인다. 이전보다 나빠지지 않는다(그때는 두 키가 후보였다). 닫는 것은 #3079 refresh 증명(`require`)이고, 맥 승인 화면이 등록 시각·이름 출처를 보이는 것은 UXUI 후속이다. 폰이 409를 받으면 도난 신호로 안내하는 것도 같다.
- **범위 밖.** `macos` 키에는 적용하지 않는다(뿌리는 비밀번호 재입력이 이미 문턱이다). 이 규칙은 QR 계보의 도난 refresh 토큰이 후보를 만드는 길을 닫을 뿐, 도난 토큰이 이미 승인된 그 폰 키를 대신해 서명하는 것을 막지 않는다(그 키는 기기 안 Secure Enclave에 있다).

### 새 공개 API 선언 (ADR-0100)

| 표면 | 변경 | 이슈 |
|---|---|---|
| `POST /v1/workspaces/{ws}/device-keys` | 같은 계보의 두 번째 살아 있는 `ios` 키·그 계보로의 `ios` rebind는 409 `device_key_lineage_has_phone_key` | #3127 |
| `POST /v1/workspaces/{ws}/device-keys/{key}/endorsement` | 대상 계보에 다른 살아 있는 `ios` 키가 있으면 409 같은 코드 | #3127 |

새 migration은 없다(잠금은 advisory lock, 판정은 기존 행에서 읽기마다 유도).

### 시험 (#3127)

- `device_key_conformance_pg::r3127_a_lineage_holds_one_phone_key_and_a_replacement_needs_the_mac`: 승인된 폰 계보(회전 후 토큰 포함)에 두 번째 `ios` 키 409·행 미기록, 승인된 키는 그대로. 옛 키가 폐기되기 전에는 새 키도 409. 맥이 서명 폐기서로 끊으면 새 키가 등록되고 `unendorsed`이며 맥 승인 뒤 지시 가능. QR 재연결은 새 계보라 등록된다.
- `r3127_a_second_live_phone_key_is_never_a_candidate_and_a_rebind_cannot_add_one`: 중복 두 키 모두 승인 409, 하나를 폐기하면 나머지가 승인된다. 이미 폰 키가 있는 계보로의 rebind는 409.
- `r3127_concurrent_registrations_on_one_lineage_leave_one_key`: 동시 4건 × 6회에서 정확히 1건만 201.

## 증보 2026-09-29 — 이 세션 동안 허락 (#3095, R2-E8 후속)

결재 인용: 성재 2026-09-28 「전부 권장대로」(R2 결재) — D-8 표의 「「이 세션 동안」 허용 | 필요, R2에서 폰에도 연다 | 범위 값을 `permission` 본문에 넣는다」의 이행. D-8은 범위가 서명 본문에 들어간다는 것과 서명이 필요하다는 것만 정했다. 「무엇을 덮는가」는 정하지 않았으므로 이 절이 좁게 정한다. 넓히려면 별도 결재가 필요하다.

### 결정

- **서명 필수, 서명 없는 길 없음.** 범위 값은 서명된 문장(`momo.human.control.v3` permission 본문의 `scope` 줄)에만 있다. 서버는 검증에 통과한 서명의 범위를 쓰고 요청 본문이나 payload의 말을 쓰지 않는다. host도 자기가 검증한 봉투의 `scope`만 읽는다(R2가 켜져 있고 `check_signature`가 통과했을 때). 검증하지 않은 봉투, R2가 켜지지 않은 host, payload의 `scope`, 거부(`reject_once`) 결정은 모두 「이번 한 번」이다.
- **서버 수용.** allow(`allow_once`) + 서명 `scope=session` + **member host**일 때만 받는다. `reject_*`에 session 범위 서명이 붙으면 400 `permission_kind_refused`, member host가 아닌 host면 400 `permission_scope_unsupported`이고 서명은 소비되지 않는다. 검증된 범위는 `work_control.human_scope` 열, host가 받는 봉투, 소유자 기기에 가는 `approval.decided`의 `scope`, 감사 `work.permission.decided`의 `scope`에 남는다. `permission` 컨트롤의 payload는 닫힌 세 키 그대로다(migration 092). 새 migration은 없다.
- **범위 규칙(host).** 허락은 그 세션의 작업 안에서만 산다. 이후 같은 세션의 `session/request_permission`을 묻지 않고 `allow_once`로 답하는 조건은 도구 종류별로 다르다.

| 도구 종류 | 이후 요청이 덮이는 조건 |
|---|---|
| `execute` | 제목과 입력(명령)이 바이트 단위로 같다 |
| `read`, `search` | 모든 위치가 허락된 요청이 건드린 디렉터리(위치들의 가장 깊은 공통 디렉터리. 루트를 세어 다섯 성분 이상이어야 하고 — `/Users/me/project/src`부터이며 `~/Documents`나 홈은 안 된다 — 그 디렉터리 자체에 숨김·민감 성분이 없어야 한다) 아래다 |
| `edit` | 위치 집합이 허락된 파일들과 정확히 같다 |
| `delete`, `move`, `fetch`, `think`, `switch_mode`, `other` | 일반화하지 않는다. 허락은 소유자가 본 그 요청 하나에만 쓰인다 |

  - 경로는 `canonicalize`(심볼릭 링크 해소, `..` 제거)한 뒤 비교한다. 상대 경로, `..` 성분, 해소되지 않는 경로는 다시 묻는다. 허락된 디렉터리 아래의 숨김 성분(`.ssh`, `.env`, `.git`)과 이름이 비밀을 말하는 성분(부분 문자열 일치: `secret`, `credential`, `password`, `token`, `key`, `pem`, `cookie`, `wallet`, `keychain`, `auth`, `id_rsa` …)은 다시 묻는다. 잘린 미리보기(`truncated`)는 만들지도 덮지도 않는다.
  - 자동 허락은 에이전트가 제시한 `allow_once` 선택지로만 답한다. `allow_always`는 고르지 않는다. 그 선택지가 없으면 묻는다.
  - 한 세션은 허락을 여덟 개까지 기억한다(가장 오래된 것이 밀린다).
- **미리보기 해시와의 관계.** 첫 허락은 v3 서명이 그 요청의 미리보기 해시를 묶는다(#3118 그대로). 이후 자동 허락은 그 요청 하나를 묶은 해시가 아니라 위 범위 규칙으로 판단한다. 해시를 범위 규칙의 열쇠로 쓰지 않은 이유는 같은 명령이 매번 같은 해시를 갖지 않을 수 있고(제목·위치 변화), 해시는 「본 것」의 동일성이지 「같은 종류」의 판정이 아니기 때문이다. 자동 허락마다 덮은 요청의 미리보기 해시를 기록한다.
- **소멸.** 아래 어느 하나로 사라진다. 기억은 세션 태스크에 있으므로 세션이 끝나면(에이전트 종료, `kill`, 서버 종료, host 해지·401) 함께 사라지고, 나머지는 host 전체의 세대 번호(`GrantEpoch`)를 올려 모든 허락을 무효로 한다.
  - 세션 종료(모든 원인)와 host 해지.
  - 로컬 앱의 `pin_root`(뿌리 재결속), `revoke_device`(기기 폐기), `reset_signature_requirement`(래칫 재설정)와 서버가 중계한 기기 폐기서의 적용. 해지된 키의 「이 세션 동안」이 살아 남지 않는다.
  - `reset-root`는 host 프로세스가 없을 때 하는 명령이라 기억도 이미 없다.
- **사람에게 알림과 감사.** 자동 허락은 host가 세션 스트림에 `approval.auto_allowed`(`scope`, `tool_kind`, `preview_sha256`) 이벤트를 **먼저** 올리고, 서버가 기록에 성공한 뒤에만 에이전트에게 답한다(기록 없는 자동 허락은 없다. 기록이 실패하면 소유자에게 묻는 길로 간다). 서버는 그 이벤트를 세션 스레드에 남기고 감사 `work.permission.auto_allowed`(`momo.work_permission.auto_allowed.v1`)를 쓴다. `approval.decided`를 쓰지 않는 이유는 모든 클라이언트가 그 이벤트를 「대기 중 카드가 답을 받았다」로 읽어 다른 도구 종류의 대기 카드를 닫기 때문이다. 알 수 없는 이벤트 종류는 공유 코어가 무시한다(`KNOWN_TYPES`·`ACP_TYPES`). 앱의 자동 허락 표시는 UXUI 후속이다.

### 새 공개 API 선언 (ADR-0100)

| 표면 | 변경 | 이슈 |
|---|---|---|
| `POST …/work-sessions/{session}/permission-decisions` | 서명 `scope=session` allow를 member host에서 받는다. reject에 붙으면 400 `permission_kind_refused`, member host가 아니면 400 `permission_scope_unsupported`(뜻이 「서버가 아직 받지 않는다」에서 「이 host는 받지 않는다」로 좁아졌다) | #3095 |
| 세션 이벤트 | 새 종류 `approval.auto_allowed`(host → 서버). `approval.decided`는 서버 발행 이벤트에 `scope`를 더한다 | #3095 |
| 감사 | `work.permission.auto_allowed`, `work.permission.decided`의 `scope` | #3095 |

새 migration은 없다. 공유 코어 `SCOPE_UNSUPPORTED_LINE`의 문장은 옛 뜻이라 UXUI 후속에서 고친다.

### 남는 위험

- **범위 규칙은 에이전트가 신고한 미리보기를 본다(독립 검수 M2).** ACP 권한 요청은 협조적인 에이전트의 신고다. 악의적 에이전트가 `read`로 신고하고 다른 일을 하면 세션 내내 묻지 않고 허락된다. 이 한계는 한 번짜리 허락에도 있었으나 세션 허락은 그것을 「본 요청 하나」에서 「세션 내내」로 넓힌다. 그래서 일반화를 `execute` 동일 명령·`read`/`search` 디렉터리·`edit` 동일 파일로 좁혔고, 실제 동작의 격리는 D6(host의 격리)이 맡는다.
- 세션 허락에는 시간 제한이 없다(세션이 끝나거나 세대가 오르면 끝난다). 오래 사는 세션의 시간 제한은 후속에서 소유자에게 묻고 정한다.
- 서명 검증과 기억 사이(마이크로초)에 로컬 앱의 폐기가 끼어들면 그 허락이 폐기 뒤 세대로 찍힐 수 있다. 다음 폐기나 세션 종료가 끊는다.
- 경로 판정은 host가 본 파일 시스템을 기준으로 하는 최선의 노력이다. 판정과 에이전트의 실제 접근 사이의 경합(TOCTOU)은 막지 못한다. 그래서 `read`/`search` 범위는 디렉터리 아래로, `edit`은 정확한 파일로 좁혔고, 파괴적·외부 종류는 일반화하지 않았다.
- `execute`의 「같은 명령」은 명령 문자열의 동일성이다. 같은 문자열이 다른 작업 디렉터리나 환경에서 다른 효과를 낼 수 있다는 점은 D6(host의 격리)이 막는 범위이지 이 규칙이 막지 않는다.

### 시험

- `momo-workd` `session_grant`(단위 10건): 종류별 범위 규칙, `..`·심볼릭 링크·상대 경로, 얕은 디렉터리, 파괴적 종류, 잘린 미리보기, 세대 무효화, 개수 한도.
- `momo-workd` `invariants` inv_38(같은 명령 자동 허락·다른 명령 재질문·거부 후 유지·세대 올림 뒤 재질문·`approval.decided` 미사용), inv_39(once 서명·session 봉투 바꿔치기·거부, 모두 기억 없음), inv_40(R2 미고정 host의 미검증 봉투), inv_41(중계된 폐기서가 허락을 끊고 위조 폐기서는 끊지 않음), `control_socket` 단위 시험(`pin_root`·`reset_signature_requirement`가 세대를 올리고 거부된 op는 올리지 않음).
- `momo-server` `human_control_conformance_pg::a_signed_session_allow_is_accepted_and_carries_its_scope`와 `every_misplaced_signed_allow_is_refused_by_name`의 범위 바꿔치기 두 건·거부에 붙은 session.

## 증보 2026-09-29 — control.v1 폐기, 서명 재개의 agent 대조·재전송, 호스트 등록 후속 (#3154)

#3153(폰·데스크탑이 v2 input·spawn과 v3 permission만 서명)과 #3155(호스트 등록 서명 흐름)의 검수가 남긴 엔진 쪽 후속이다. 새 공개 표면은 없다. 결정 한 가지(v1 폐기)와 이미 있는 라우트의 거절·멱등 규칙만 바뀐다. 위 「버전 정합」 표들과 「남은 것」의 해당 줄은 이 증보로 대체한다.

### control.v1을 받지 않는다

- **서버와 workd 모두 v1을 거절한다.** 두 곳이 같은 `HumanControl::verify_any`를 쓰므로 한 곳을 고쳤다. 이제 받는 것은 v3, 그리고 v2(미리보기 있는 permission 제외)다. 어느 종류든 v1이면 `device_signature_invalid`고 nonce는 쓰이지 않는다. `ControlSchema::V1`은 남긴다. 공유 벡터가 v1 바이트를 만들어 「거절됨」을 증명해야 하기 때문이다.
- **근거(팀 기기 빌드).** v1은 R2 서명기가 처음 들어간 2026-09-28 하루 동안만 데스크탑(E5 #3025)과 폰 네이티브(#3066)에 있었고, 같은 날 두 서명기가 v2로 옮겼다(데스크탑 `99ca020c2`, 폰 `bbb0ea488`, #3028). permission은 2026-09-29 #3128에서 v3로 갔고, 폰 허용 목록과 `humanControl.ts`의 v1은 #3153에서 지웠다. 기록된 증거 빌드는 데스크탑 0.1.12(2026-09-27, 서명기 이전)와 iOS 3026이며 어느 쪽도 서명을 보내지 않는다. 서버 0.1.14는 서명 검증을 켜지 않은 채(`MOMO_HUMAN_CONTROL_SIGNATURE_REQUIRED` 꺼짐) 배포됐다.
- **남는 위험.** 2026-09-28~29 사이 owner 기기에 직접 깐 개발 빌드가 v1로 input·permission을 서명하면, 보낸 서명은 플래그와 무관하게 검증되므로 그 요청이 403이 된다. 해당 기기는 v2/v3 서명기가 든 빌드로 다시 깔면 된다. 플래그로 v1을 남기는 안은 택하지 않았다: v1은 서명기가 없는 표면이라 「받을 이유」가 남아 있지 않고, 플래그는 결국 보안 규칙을 설정 뒤에 숨긴다.

### 서명 재개(`POST …/work-sessions/{session}/resume`)

- **agent 대조.** 서명된 spawn의 `agentMemberId`가 재개되는 세션의 agent와 같아야 한다. 아니면 403 `resume_agent_mismatch`이고 슬롯도 nonce도 쓰지 않는다. 세션 행에는 agent 열이 없어서 서버가 아는 기록을 신뢰 순서로 읽는다.
  1. 그 세션의 이전 **서명된 spawn**(`work_control.human_spawn_agent_member_id`). 재개의 재개다. 소유자 자신의 서명이라 host의 말보다 앞선다.
  2. 아니면 세션 스레드의 가장 최근 ACP 이벤트가 실은 `agent_member_id`(host가 보고한 값. 데스크탑이 서명할 agent를 읽는 곳과 같다).
  - 어느 쪽이든 그 id는 이 워크스페이스의 살아 있는 `agent` 멤버여야 한다. 기록이 없는 세션은 거절한다(fail-closed). 서명 재개를 만드는 유일한 클라이언트가 이미 이벤트에서 agent를 읽지 못하면 서명을 거부(`RESUME_AGENT_UNKNOWN_LINE`)하므로 지금 동작하는 흐름은 깨지지 않는다. 서명 없는 재개(플래그 꺼짐)는 이 검사를 받지 않는다.
- **후속 세션 id 재전송은 멱등이다.** 응답이 유실돼 클라이언트가 같은 `sessionId`·서명을 다시 보내면(#3153) 원본은 이미 `ended`라서 「only an orphaned work session can resume」 409가 났고, 성공한 재개가 실패로 보였다. 이제 다음을 모두 만족할 때만 이미 만든 후속 세션을 그대로 돌려준다(201, 쓰기 없음, nonce 재사용 없음): 후속 세션이 있고, 호출자의 것이고, 같은 대상 host이며, 이 원본에서 재개됐고(`resumed_from_session_id`), 호출자가 그 채널의 활성 멤버이며, 그 세션의 spawn 컨트롤이 이 요청과 **같은 nonce**를 실었다. 다른 nonce나 다른 사람의 같은 id는 종전대로 409/403이다.
- **받아들인 위험(보안 검수 M1).** 서명된 spawn이 없는 원본은 host가 보고한 마지막 `agent_member_id`가 기준이다. 그 세션의 host(소유자 자신의 Mac, D-10의 신뢰 뿌리)가 거짓 id를 보고하면 데스크탑이 그 agent로 서명하고 서버도 통과시킨다. 보고를 위조할 수 있는 것은 그 host뿐이고(일반 멤버는 중첩 props를 보낼 수 없다), 그 host는 세션의 다른 모든 보고도 좌우한다. 이벤트 수신 시 agent id 검증이나 spawn 시 서버 기록은 후속이다. 기록이 아예 없는 세션(첫 이벤트 전에 끊긴 것)은 서명 재개가 거절되는 종단 상태다(서명 없는 재개는 플래그 꺼짐일 때 가능).
- **남은 것.** 후속 세션 id가 다른 워크스페이스의 세션 id와 겹치면(전역 PK) 이름 없는 500이 나는 것은 그대로다(무작위 UUID, 권한 이득 없음).

### 호스트 등록(`momo-workd register --sign-stdin`, #3155 검수 Low)

- **503을 조용히 무서명으로 받지 않는다.** signing-context가 없는 것으로 보는 응답은 404(라우트 이전 서버)와 **이름 있는** 503 `instance_id_unconfigured`뿐이다. 그 밖의 503·5xx·연결 오류는 등록을 멈춘다. 이름 있는 503으로 무서명 등록을 진행할 때는 부모 앱에 `signingContext: "unconfigured"`를 알리고 workd 로그에 경고를 남긴다(서버가 서명을 요구하면 어차피 403이다).
- **서버 행이 고아가 되지 않는다.** 등록 POST가 성공한 뒤의 어떤 실패도(서명한 host id와 다른 행, 다른 키·워크스페이스·scope의 행, 상태 파일 쓰기 실패) 같은 소유자 토큰으로 그 행을 `DELETE …/work-hosts/{id}`로 거두고, 키와 상태 파일도 지운다. 거두지 못하면 경고로 남는다(소유자가 목록에서 직접 끊는다).
- **타임아웃 뒤에 host 키가 남지 않는다.** 데스크탑 셸이 등록 자식을 기한에 죽이면 자식의 정리가 돌지 못한다. 셸이 `momo-workd forget`으로 키·상태를, 그 호출이 쓴 설정을 지운다. 죽기 직전 서버에 행이 생겼다면 그 행은 키 없는 행으로 남으므로 소유자가 목록에서 끊는다(잔여 위험).
- **지문을 비교할 곳이 생긴다.** 확인 창의 host 키 지문은 그 자리에서 대조할 대상이 없었다. workd가 같은 지문(SHA-256 앞 10바이트, 4글자 5묶음)을 등록 요청 줄(`hostKeyFingerprint`)과 등록 완료 줄에 싣고 로그에도 남긴다. 서버의 host 목록은 공개키 전체를 이미 주므로 웹은 같은 함수로 계산해 보일 수 있다(UXUI 후속). 창의 지문은 「그 순간 서명하는 키」의 고정이고, 실시간 대조는 등록 뒤 이 값들 사이에서 한다.
- **시계 5분.** 서명 시각은 이 Mac의 시계인데 서버는 자기 시계 ±5분만 받는다. 셸이 signing-context의 `serverTimeMs`와 비교해 5분을 넘으면 창을 띄우기 전에 `device_clock_skew`로 거절하고 「날짜·시간을 자동으로 맞춘 뒤 다시 등록」을 안내한다(방향과 분 포함). 문구의 화면 노출 위계는 UXUI 몫이다.

### 시험

- `work_instruction_conformance_pg`: `a_signed_resume_must_name_the_agent_the_session_ran`, `a_retried_signed_resume_answers_with_the_successor_it_made`, v1 input 거절. `human_control_vectors`: `verify_any_refuses_every_v1_statement`. `momo-workd` `register_cleanup`(모의 서버, 실제 바이너리). 데스크탑 `a_register_that_times_out_takes_its_key_and_config_with_it`, `a_mac_more_than_five_minutes_off_the_server_is_told_before_the_dialog`.
