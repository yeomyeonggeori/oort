# ADR-0117: 멀티 워크스페이스 — 생성·멤버십·권한 경계

- Status: **Accepted** (성재 승인 2026-07-23 — D1-A·D2·D3·D4-A·D5-A. W-1~W-4 발급, 셀프서브·전역identity(D1-B·D5-B)는 공개 단계 예약)
- 관련: ADR-0121(셀프호스팅 온보딩 — 초대 관통), ADR-0128(멤버십 수명주기), ADR-0100(거버넌스), `2026-07-23-internal-test-focus-plan.md` §2, MOMO-524(MemberLifecycleRoutes)·MOMO-560(momo-ops invite).
- 발단: 성재 발제(2026-07-23) — 내부 테스트는 10명이 최대 5개 워크스페이스를 만들고 한 사람이 여러 워크스페이스에 소속되는 형태. 현재 워크스페이스는 **시드로만 생성**(생성 REST 없음)이고 클라 다중 워크스페이스 전환 UX도 없다 → 이 시나리오가 제품 표면으로 불가능하다.

## Context (실측)

1. **스키마는 이미 멀티 워크스페이스 전제**: `member`/`membership`/`channel`이 전부 `workspace_id` 스코프이고 RLS가 `current_setting('app.workspace_id')`로 격리한다. `workspace_membership.role`은 `membership_role` enum(`owner|admin|member|guest`, 001_init.sql:14) 존재. **한 사람(human)이 여러 워크스페이스에 각각 member 행을 갖는 것은 스키마상 이미 가능** — 막는 건 생성/전환 표면의 부재다.
2. **생성 경로 부재**: `WorkspaceRoutes.swift`는 `GET /v1/workspaces/:ws`만 노출. 워크스페이스 행·소유자 membership·기본 채널은 시드 스크립트로만 만들어진다.
3. **인증 경계 질문**: 로그인은 `{email, password, workspace}`로 워크스페이스 바인딩된다(human 행이 workspace별). "한 사람이 여러 WS 소속"은 **동일 이메일의 human 행이 WS마다 별도**인지, **전역 계정 1개가 여러 WS membership**인지 결정이 필요하다 — 이게 이 ADR의 최대 갈림길(D5).

## 결정 항목 (성재 결정 대기)

### D1. 누가 워크스페이스를 만드나 (성재 질문 ①)
- **A (권고, 내부 테스트) — 오퍼레이터 전용 생성**: `momo-ops.sh workspace-create`(migrate 이미지 서브커맨드, momo-560 계보)로 운영자가 WS+초기 owner를 만든다. 셀프서브 가입 없음 = 스팸·정책 표면 0. 내부 10명/5WS에 충분.
- B — 인증 사용자 셀프서브 생성 REST(`POST /v1/workspaces`): 공개 SaaS 경로. 생성자=owner 자동. **레이트리밋·약관 동의·slug 정책 필요**(buzz 계획 결정대기 ④⑤와 연동) — 공개 단계 안건.
- **판정 제안: 내부 테스트=A, 공개 시 B로 승격.** 본 ADR은 A를 티켓화하고 B는 파생 후보로 예약.

### D2. 초대 멤버의 기본 role (성재 질문 ②)
- 초대는 role 바인딩된다(ADR-0121 D3 — admin이 만든 링크도 지정 role로만 가입). **기본 `member`**(enum default와 일치). 초대 생성 시 owner/admin이 `member|guest|admin` 중 선택, **`owner`는 초대로 부여 불가**(오너십 이전은 별도 명시 행위 — ADR-0128 경계).
- 초대 계약: 만료(링크 7일)·사용 횟수 상한·regenerate=일괄 무효화는 momo-560 `invite-create`에 이미 구현. 본 ADR은 role 상한(≤admin)만 추가 명문화.

### D3. role별 가능 행위 (성재 질문 ③ — 능력 매트릭스)
| 행위 | owner | admin | member | guest |
|---|:-:|:-:|:-:|:-:|
| 워크스페이스 설정/삭제·오너십 이전 | ✅ | ❌ | ❌ | ❌ |
| 멤버 초대(≤자기 role)·제거·role 변경 | ✅ | ✅ | ❌ | ❌ |
| 에이전트 생성/관리(ADR-0131)·pause | ✅ | ✅ | ❌ | ❌ |
| 채널 생성·아카이브 | ✅ | ✅ | ✅(정책 토글) | ❌ |
| 메시지·에이전트 멘션·Work 실행 | ✅ | ✅ | ✅ | ✅(초대된 채널만) |
| 감사 로그 열람 | ✅ | ✅ | ❌ | ❌ |
- **guest = 채널 스코프 접근**(D4), member = 워크스페이스 전역 채널 접근. 기존 서버 집행 지점(MemberLifecycleRoutes·AgentProfileRoutes requireEditor 등)이 이 매트릭스와 일치하는지 **감사 후 갭은 티켓화**.

### D4. 채널 스코프 초대 (성재 질문 ④)
- **A (권고) — 2단 초대**: ①워크스페이스 초대(role 부여, member/guest) ②채널별 add(기존 membership.channel_id). member는 공개 채널 자동 가시, guest는 **명시 add된 채널만**. "특정 채널에만" 요구는 guest role+채널 add로 충족.
- 비공개 채널 개념은 현재 membership 유무로 표현 — 별도 visibility 플래그는 후속(과설계 회피).

### D5. 다중 소속 계정 모델 (Context 3 — 최대 갈림길)
- **A (권고, 내부 테스트) — 워크스페이스별 독립 계정**: 현행 구조 유지(human 행이 WS별). 로그인이 `{email,password,workspace}`. 같은 사람이 WS마다 자격을 따로 가짐 — 구현 0, 격리 최강. 단점: 앱이 WS별 로그인을 각각 관리(전환 UX가 "계정 추가"에 가까움).
- B — 전역 identity + WS membership 다건: 공개 SaaS식 즉시 전환 UX. principal/human 재설계 필요(로그인·토큰·RLS 접점 광범위 변경) — **ADR 경계, 공개 단계**.
- **판정 제안: 내부=A(즉시 가능), B는 별도 ADR로 예약.** 클라 전환 UX는 A 위에서 "서버 계정 목록"으로 최소 구현.

## 파생 배치 후보 (Accepted 후)

| 후보 | 내용 | 트랙 | 의존 |
|---|---|---|---|
| W-1 | `momo-ops.sh workspace-create`(WS+owner+기본 채널, env-only) | 엔진 | D1-A |
| W-2 | role 능력 매트릭스 서버 집행 감사 + 갭 티켓화 | 엔진 | D3 |
| W-3 | 초대 role 상한(≤admin, owner 금지) 검증 | 엔진 | D2 |
| W-4 | 클라 다중 워크스페이스 전환 UX(계정 목록·전환) | UXUI | D5-A |
| W-5(예약) | 셀프서브 생성 REST + 전역 identity | — | D1-B·D5-B(공개) |

## Consequences

- (+) 내부 테스트 "10명·5WS·다중 소속"이 **W-1만으로 즉시 가능**(운영자가 5개 파고 초대). 사양 무관.
- (+) 권한 4축이 문서로 고정 — 초대·role·채널 스코프가 명시 계약.
- (−) D5-A는 같은 사람의 WS별 계정 분리 = 전환 UX가 공개 SaaS 대비 투박(공개 시 D5-B로 승격 부담).
- 예약: 셀프서브 생성·전역 identity·비공개 채널 visibility 플래그.

## 증보 2 — 워크스페이스 생성 표면을 앱으로 확장 (2026-07-24, 성재 승인)

- Status: **Accepted** (2026-07-24, 성재 — 셀프서브 운영자 여정 배치 "둘다 진행" 승인. 계획 정본 `docs/planning/2026-07-24-selfserve-operator-journey-plan.md`)
- **정책 불변**: D1-A(운영자 생성)는 유지된다. 바뀌는 것은 표면뿐 — 기존 CLI(momo-ops workspace-create, SQL)에 더해 **인앱 생성**(`POST /v1/workspaces` + "새 워크스페이스 만들기" GUI)을 연다.
- 인가 = **등재 인스턴스 운영자**(MOMO-583 모델 재사용: platform:read OR owner/admin+검증 이메일+PLATFORM_ADMIN_EMAILS). 일반 멤버/비운영자 403. 공개 셀프 가입·셀프 생성은 여전히 공개 단계 결정으로 유보.
- 시딩은 create_workspace.sql과 동일 결과(생성자 owner 멤버십·계정 복제(D5-A)·#general·channel_seq·slug 중복 명시 거부)를 서버 tx로.
- 파생: MOMO-589(REST)·590(GUI). 멀티WS 전환 UX(W-4)는 별도 잔존.
