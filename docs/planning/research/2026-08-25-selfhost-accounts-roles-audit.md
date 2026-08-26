# 셀프호스트 운영자 5축 실체 감사 — 계정 발급·패스워드 초기화·채널 권한·role 확장·커스텀 이름

> 2026-08-25 성재 발제("사용자 계정·password 발급, 패스워드 초기화, 채널 권한·권한 추가·권한 이름 변경(owner→master) 가능한지 확인") → Explore 감사(ex-authz) 실측. 정본=server-rust/+clients/web/+packages/momo-core/+server/Migrations/.

## 판정 요약표

| 축 | 판정 | 한 줄 |
|---|---|---|
| 1. 계정 발급 | **실존** | 초대코드(`POST /v1/join`, sha256 저장·1회 노출)+오너 claim(078, TTL 24h 단일사용) 폐곡선. 단 초대 revoke/regenerate REST는 Rust 미이식, 이메일 발송/검증 인프라 0건(out-of-band 전달) |
| 2. 패스워드 초기화 | **부재** | reset/forgot 경로 0. password_hash 쓰는 곳 3(claim·가입·재가입)뿐 — 기존 활성 사용자 비번 변경 불가. 현 복구=DB 직접 UPDATE뿐 |
| 3. 채널 권한 | **부분** | 2층 분리(ADR-0128): 실권한=워크스페이스 role(owner/admin/member/guest, is_admin 단일 술어)·채널 role=사실상 라벨(분기 사용 0건). **역할 변경·정지·추방 REST 10경로는 Swift에만**(Rust 미이식 — 가입 시점 role이 영구) |
| 4. role 추가 | **가능하나 무겁다** | DB ENUM+코드 allowlist 3중 fail-closed(의도 설계). 신규 role=마이그레이션 1+Rust enum/술어 2+allowlist 3+클라 타입·라벨 동시 변경. 런타임 role 생성은 현 설계 불가. RLS는 무관(테넌트 경계 전용) |
| 5. 커스텀 이름(owner→master) | **가능, 가장 쉽다** | wire 값⊥표시명 분리 기존재 — 클라 상수 2곳(`ROLE_LABEL`·`INVITE_ROLES`)이 전부, 서버는 라벨 무지. 운영자 인스턴스별 커스텀=워크스페이스 설정에 라벨 오버라이드+클라가 우선 읽기. 서버 enum·인가 비접촉 |

## 상세 근거

(ex-authz 보고 전문 — 파일:라인 전수)

### 축1 계정 발급
- `lib.rs:1116` POST /v1/join 공개(레이트리밋)·`:1127` /v1/claim 독립 버킷. `invites.rs:82,111` 발급(owner/admin). 생 코드 1회 노출·DB sha256(`003_onboarding.sql:43-92`).
- `join.rs:487-560,867` 원자 가입(+`:908-930` 삭제 계정 재가입). claim 서버측=`078_owner_claim.sql`+`owner_claim.rs:13-175`, 토큰 발행=마이그레이터(`momo-migrate/main.rs:559-690`, `MOMO_CLAIM_PATH` stdout).
- 이메일 발송 0건 — `join.rs:867` email_verified=false 고정. 초대는 링크 수동 전달(`settings/model.ts:355`).
- 갭: 초대 revoke/regenerate/redeem 3경로 Rust 미이식(swift-removal-audit:190).

### 축2 패스워드 초기화
- 라우터 113경로 전수에 reset 계열 0. auth=login/refresh/logout뿐. claim 재발급도 비번 있으면 skip(`main.rs:700`)+ws당 미소비 claim 1 제약.
- 가능화 경로: ①078 일반화한 credential_claim(kind 컬럼)로 운영자 발급 reset 토큰 ②`PATCH .../members/me/password`(현 비번 재확인) — 최소 1개+마이그레이션.

### 축3 채널 권한
- enum 단일(`001_init.sql:14`), 채널층 `membership`·ws층 `workspace_membership` 공유. 인가는 `workspace_authorization.rs:62-84` 단일 권위, 채널 role 분기 사용 0(생성자 owner 라벨·DM member 고정·DTO 투영뿐).
- guest만 roster 쿼리 필터 축소(`roster.rs:121`). RLS=`app.workspace_id` 단일 술어(역할 무관).
- **MemberLifecycleRoutes 10경로(승격/강등/정지/추방/밴) Swift 참조 구현 생존, Rust 0** — 스키마·audit 원장(026 workspace_ban 포함)은 이미 서 있음.

### 축4 role 추가 (6지점)
1. `001_init.sql:14` ENUM(ALTER TYPE 마이그레이션) 2. `workspace_authorization.rs:22-53` Rust enum+from_db_label(모르는 라벨=인가 실패, 테스트 성문) 3. `is_admin()` 술어 4. 자기발급 allowlist 3중(invite.rs:63-71·003:64 CK·join.rs:518-520 의도적 fail-closed) 5. `join.rs:540 role_rank()` 6. 클라 타입·라벨.

### 축5 커스텀 이름
- `directory/model.ts:22-39 ROLE_LABEL/roleLabel()`(agent 행 null 규칙 포함)·`settings/model.ts:249-257 INVITE_ROLES` — 표시명 전부 여기. 서버 응답=DB 라벨 그대로(`roster.rs:71`), display_name 컬럼 0.
- 인스턴스별 커스텀 설계: 워크스페이스 설정 JSON에 role 라벨 오버라이드 + roleLabel/INVITE_ROLES 우선 읽기 — 서버·DB·RLS 무변경.

## 티켓화 후보 (미발급 — 성재 결정 대기)
- **AC-1**: 패스워드 초기화 — credential_claim 일반화(운영자 발급 reset 링크)+`PATCH members/me/password` (engine)
- **AC-2**: 멤버 라이프사이클 10경로 Rust 이식(승격/강등/정지/추방/밴 — Swift 참조) (engine, ADR-0128 D2 완결)
- **AC-3**: 초대 revoke/regenerate REST 이식 (engine 소형)
- **AC-4**: role 표시명 인스턴스 커스텀(워크스페이스 설정 오버라이드) (uxui+core 소형)
- (role 신규 추가는 수요 확정 전 보류 권고 — fail-closed 설계가 의도이며, 커스텀 "이름"이 필요의 대부분을 흡수)
