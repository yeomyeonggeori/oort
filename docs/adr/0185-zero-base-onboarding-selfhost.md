# ADR-0185: 제로베이스 온보딩 — 셀프호스트 첫 소유자가 「내 워크스페이스·내 이름」으로 시작한다

- Status: **Proposed** (2026-09-09 기안 Fable · **결재 대기 — 성재**. 결정 항목 D-A·D-B·D-C는 선택지와 planner 권고만 적혀 있고 채택은 §10 결재 기록에 남긴다. ADR-0100 규칙대로 Proposed 상태에서는 구현 티켓으로 변환하지 않는다 — 유일한 예외는 본 ADR과 독립인 결함 수리 SH-12a(#2301, §9))
- Date: 2026-09-09
- Deciders: 성재
- 발제: 성재 2026-09-09 「데모 사용자로 momo 워크스페이스로 접근하는 것보다 워크스페이스 생성·프로필 등록·팀 규모·팀원 초대(skip 포함)를 포함해 실제 처음 온보딩을 하는 것처럼 설계해야. v0.1.5는 가능하다면 실제 온보딩을 경험하는 구조로 작업하고 발행」 · ADR-0184 결재 기록 「데모 사용자/데모 워크스페이스 경유 E2E는 제로베이스 E2E가 아님(별도 계획 SH-12)」
- Consumes: ADR-0166(claim token — §6 범위 경계 개정 대상) · ADR-0180(기기 연결 — first-run phone-link) · ADR-0181(웰컴 킥오프 — D2 트리거·D3 「없으면 조용히」 개정 대상) · ADR-0184(플랫폼 중립 셀프호스트 — D6 「첫 에이전트 합류까지」 수용 문장) · UX 바이블 P5 · `docs/planning/research/2026-07-25-reference-ux-survey.md` §1-A
- 근거 조사: `claudedocs/resume-2026-09-07/brief-sh12.md`(브리프 SH-12 — 코드 조사 정제본) · `docs/planning/research/2026-09-09-e2e-b-selfhost-run.md`(E2E-B 실측). 본문에 인용한 파일은 기안 시점(2026-09-09)에 전부 열어 확인했다.
- 제품 문장: **첫 소유자는 남의 이름표를 달고 들어오지 않는다.** claim 링크를 연 사람이 첫 화면에서 자기 워크스페이스 이름과 자기 이름·핸들을 정하고, 팀원 초대는 건너뛸 수 있으며, 그 다음에 에이전트가 말을 건다 — 에이전트가 아직 없으면 「첫 에이전트 연결」이 그 자리를 잇는다.

## 1. 문제

### 1.1 실측 — claim의 정상 종점이 데모다
E2E-A/B(2026-09-09, 1차 목표 두 케이스 G1'-4)에서 셀프호스트 claim(`/claim/<token>` → 비밀번호 설정)을 완주하면 사용자는 워크스페이스 **`momo Demo Workspace`**(slug `demo`, 고정 id `00000000-0000-7000-8000-000000000001`)에 **「데모 사용자」@demo**(`…0101`)로 착륙한다. 이것은 버그가 아니라 현행 설계의 정상 종점이다(§1.2). 성재는 이 화면을 보고 「실제 처음 온보딩」이 아니라고 판정했고, ADR-0184 결재에서 데모 경유 E2E를 제로베이스 E2E로 인정하지 않았다.

### 1.2 코드가 말하는 것
- **데모 시드는 끌 수 없다.** `server/Migrations/002_seed.sql`은 워크스페이스 `momo Demo Workspace`·사람 「데모 사용자」@demo·채널 `#general`/`#agent-lab`·membership을 **무조건** 심는다. psql 변수 `MOMO_AGENT_SEED_ENABLED`(`MOMO_AGENT_SEED_MODE` → `scripts/migrate.sh`·`server-rust/crates/momo-db/src/migrate.rs`가 `none`→0, `demo`/`e2e`→1로 변환)는 **김인턴(`…0102`) 픽스처만** 게이트한다. `server-rust/Dockerfile`이 `server/Migrations` 전체를 `/opt/momo/migrations`로 COPY하므로 셀프호스트 이미지에도 그대로 출하된다.
- **claim은 시드 워크스페이스의 시드 오너에 바인딩된다.** `infra/rust/sql/bootstrap_owner_if_absent.sql`·`bootstrap_owner_claim_if_absent.sql`은 `…0001`/`…0101`을 하드코딩하고, claim 판은 `email`·`email_verified`만 갱신한다 — 표시명 「데모 사용자」·핸들 `demo`는 남는다. `server-rust/bins/momo-server/src/routes/claim.rs`는 토큰→워크스페이스를 정의자 함수(`momo_join_private.owner_claim_workspace_id`, 마이그레이션 078/081)로 풀어 **기존** 워크스페이스에 세션을 발급하고, `owner_bootstrap` 종류면 같은 tx에서 웰컴 킥오프를 enqueue한다. ADR-0166 §6은 워크스페이스 생성을 명시적으로 범위 밖에 두었다. (ADR-0166 본문과 `docs/SELF_HOST_FIRST_DAY.ko.md`가 인용하는 `infra/prod/bootstrap_owner_if_absent.sql` 좌표는 드리프트 — 파일은 `infra/rust/sql/`에 있다.)
- **claim 직후 first-run 퍼널이 전부 스킵된다(결함, SH-12a #2301).** `clients/web/src/features/auth/ClaimPage.tsx`는 `markFreshSignup` 하나만 찍는다. invite-join(`clients/web/src/features/auth/ConnectPage.tsx:333-342`)은 `markPhoneLinkFirstRunPending`·`markFirstAgentPending`·`markFreshSignup`·`holdKickoffForFreshSignup` 네 마커를 찍는다. `clients/web/src/features/welcome/firstRunGate.ts`의 `decideFirstRun`은 hold·first-agent·phone 셋이 다 비면 곧장 `"app"`이므로 claim 경로에서는 kickoff-hold·first-agent(UX-R2c)·phone-link(ADR-0180) 어느 것도 재생되지 않는다.
- **덮어쓸 쓰기 경로가 없다.** `routes/workspaces.rs` 헤더가 「Still absent: `PATCH /v1/workspaces/{ws}` (the rename write)」를 명시한다. 있는 것은 `workspace_settings.rs`(settings JSON)·`workspace_avatar.rs`뿐. `POST /v1/workspaces`는 `require_instance_operator`(`routes/shared.rs`: 사람 + `platform:read` 스코프 또는 admin+`PLATFORM_ADMIN_EMAILS`)라 **기존 워크스페이스 세션이 전제** — 워크스페이스 0개 상태에서는 구조적으로 호출할 수 없다. 멤버 자기 이름은 `routes/self_profile.rs` `PATCH /v1/workspaces/{ws}/members/me {"displayName"}`(BZ-4e #1873)로 **표시명만** 바꿀 수 있고, **핸들 변경 라우트는 `routes/` 어디에도 없다**(서버 크레이트 전수 grep `SET handle` 0건). 핸들은 join 시 `normalized_requested_handle`/`fallback_handle(email)`로 1회 정해지고 `member_handle_uniq UNIQUE (workspace_id, handle)`(`server/Migrations/001_init.sql`)로 묶인다. 「팀 규모」는 칼럼·화면·문구 어디에도 없다.
- **셀프호스트는 에이전트 0명 → 킥오프가 항상 no-op.** 생성기 env는 `MOMO_AGENT_SEED_MODE=none`(`scripts/self_host_env.sh:952`·`:1642`; FIRST_DAY.ko가 인용하는 `:658`은 드리프트). `routes/welcome.rs` `enqueue_welcome_kickoff_in_tx`는 `momo-agent/src/welcome.rs` `resolve_welcome_target_in_tx`가 활성 에이전트를 못 찾으면 `None` → `Ok(())`로 **조용히 끝난다**(ADR-0181 D3 「없으면 조용히」). 클라 마운트 게이트 `clients/web/src/features/welcome/welcomeKickoff.ts` `decideWelcomeMount`의 거부 사유에는 「에이전트 없음」이 없어서, hold가 살아 있는 경로에서는 스테이지 「팀이 준비하고 있어요」가 오지 않을 `agent.partial`을 기다리다 `WELCOME_BACKSTOP_MS = 120_000` 뒤 「아직 준비하고 있어요…」 카드로 끝난다. 결과: ADR-0181 「첫 화면에서 에이전트가 말한다」가 셀프호스트에서 **한 번도 재생된 적이 없다**(E2E-B에서 킥오프가 뛴 것은 에이전트가 생긴 뒤 합류한 2인째뿐 — `2026-09-09-e2e-b-selfhost-run.md` 「사람 합류 킥오프 seq 5」).

### 1.3 캐논 충돌
- `docs/ux-bible/README.md` **P5**: 「온보딩은 제품이 제품 안에서 스스로를 가르치는 것 — 첫 실행 = 에이전트와의 첫 대화(Slackbot 패턴). 활성화 매직넘버 1개를 정해 소유」.
- survey **§1-A**(buzz 실코드): 커뮤니티 온보딩은 **2스텝**(「Build your profile」→「Meet your starter team」, 테스트 `totalSteps_is_2`가 못박음). 「Skip for now」는 기본 버튼이 아니라 스타터 채널 생성이 2회 실패했을 때만 나타나는 **탈출구**. 진짜 와우는 온보딩이 아니라 직후의 **Welcome Kickoff**(120s 백스톱, 멱등 마커) — 이것이 ADR-0181의 원천이다.
- 성재 발제(워크스페이스 이름 → 프로필 → 팀 규모 → 초대(skip))는 Slack **웹 가입 퍼널** 형태 = 정본과 **다른 노선**이고, 「팀 규모」는 레포에 전례가 없는 **신규 결정**이다. 두 캐논을 어떻게 겹칠지가 D-A, 「제로베이스」를 어디까지로 정의할지가 D-B, 에이전트 0명인 셀프호스트에서 P5를 어떻게 지킬지가 D-C다.

## 2. 결정 항목 — 전부 「결재 대기」

### D-A 온보딩 노선 — 「결재 대기」
| 선택지 | 내용 | 평가 |
|---|---|---|
| (1) buzz 2스텝 유지 + 셀프호스트 전용 최소 선행 1스텝 | 「워크스페이스 이름·오너 프로필」 1화면을 앞에 붙이고 기존 「프로필 → 팀 소개」를 그대로 | 합계 3스텝이 되어 `totalSteps_is_2` 정신이 깨지고, 「팀 소개」는 에이전트 0명인 셀프호스트에서 **보여줄 팀이 없다**(D-C가 이 자리를 대체). 프로필을 두 번 묻는다 |
| (2) 성재 5스텝 | 워크스페이스 이름 → 프로필 → 팀 규모 → 초대 → 첫 채널 | 「실제 처음 온보딩」 체감은 가장 직접적. 그러나 「팀 규모」는 저장할 곳도 소비처도 없고(§1.2), 「첫 채널」은 `#general`이 이미 시드·생성되어 있어(ADR-0181 D3 v1 기본 채널) 중복 질문이며, 질문 하나가 이탈 지점 하나다. Slack 웹 퍼널의 목적(데스크탑에 들어오기 전 그릇 만들기)은 claim 링크가 이미 채운다 |
| **(3) 절충** | **필수 = 「내 워크스페이스·내 이름」 1화면**(워크스페이스 이름 · 표시명 · 핸들) → **선택 = 「팀원 초대」 1화면**(초대 링크 발급·복사, 「나중에」 skip 상시 — 탈출구 문장은 어디서 이어갈 수 있는지를 말한다: 설정 › 멤버와 초대) → 로그인 뒤 first-run(킥오프-hold → 첫 에이전트 → 폰 연결). **팀 규모는 질문이 아니라 추론**: 초대 수(0 = 솔로)와 이후 멤버 수로 충분하며, 저장 칼럼을 만들지 않는다 | 스텝 수 2 유지(§1-A), 첫 실행의 절정은 여전히 에이전트의 첫 발화(P5·ADR-0181), 성재 발제의 네 요소(생성·프로필·초대·skip)를 전부 담는다. 「생성」은 (b)에서는 이름 확정, (a)에서는 실제 생성으로 같은 화면이 두 정의를 다 받는다 |

**planner 권고: (3).** 이유: P5·§1-A 정본을 깨지 않으면서 성재의 「처음 온보딩」 체감을 채운다. 「팀 규모」의 유일한 쓸모는 「다음에 무엇을 보여줄까」인데 그 판단은 초대 수로 충분하다. 스텝 카운터는 2/2로 고정하고 `totalSteps_is_2` 동형 단정을 둔다(§5-2).

### D-B 제로베이스 정의 — 「결재 대기」
| 선택지 | 내용 |
|---|---|
| (a) 시드 제거 + claim이 워크스페이스를 생성 | 진짜 제로베이스. 아래 비용 전부 지불 |
| **(b) 시드 유지 + 온보딩이 이름·오너 프로필을 덮어쓴다** | 시드 행은 남되 사용자가 보는 이름은 전부 자기 것. 신규 쓰기 경로 2개(§4.1 E1·E2) |

(a)의 구체 비용(전부 확인된 좌표):
1. `server/Migrations/002_seed.sql`이 무조건 시드 → 조건부화. 새 psql 변수(예: `MOMO_TENANT_SEED_ENABLED` — 현재 레포에 없음)를 `scripts/migrate.sh`·`momo-db/src/migrate.rs` 양쪽에 배선하고 `MIGRATE_IDEMPOTENCY_CHECK` 게이트와 정합시켜야 한다. 마이그레이션 002 자체의 수정·이동은 하드 룰 위반이라 후속 마이그레이션으로 풀어야 한다.
2. `infra/rust/sql/bootstrap_owner_if_absent.sql`·`bootstrap_owner_claim_if_absent.sql`의 `…0001`/`…0101` 하드코딩 해소 — 「시드 오너 입양」이 아니라 「워크스페이스+오너 생성」으로 재작성, `momo-migrate`의 계획표(`plan_owner_bootstrap`·`claim_plan_sql`)도 함께.
3. `routes/claim.rs`: 「토큰 → 기존 워크스페이스 uuid」 → 「토큰 → 워크스페이스 생성 + 오너 생성 + 세션」 전면 개편. `POST /v1/workspaces`의 `create_workspace_in_tx`는 운영자 홈 워크스페이스 전제라 그대로 재사용할 수 없다.
4. e2e 하네스 4개 이관: `scripts/verify_owner_claim.sh`(`…0001`/`…0101` 직접 SQL 단정) · `scripts/verify_openapi_contract_rust.sh`(`DEMO_WORKSPACE_ID`, `MOMO_AGENT_SEED_MODE=e2e`) · `clients/mobile/scripts/lane-phone.sh`(`DEMO_WORKSPACE_ID`·`AGENT_MEMBER_ID …0102`, e2e 시드 필수) · `scripts/local_gate.sh`(`MOMO_AGENT_SEED_MODE=e2e make migrate` 멱등 검사).
5. 기존 설치 업그레이드 정책: 이미 `momo Demo Workspace`로 살고 있는 설치(E2E-B·그록봇 VM·v0.1.4 사용자)를 자동 개명할 수 없으므로 어차피 (b)의 rename 경로가 필요하다.

**planner 권고: v0.1.5 = (b), (a)는 후속 ADR(SH-12z).** 이유: 시간·회귀 위험(위 1~5)이 v0.1.5 창을 넘고, 사용자 체감은 (b)로도 「내 워크스페이스·내 이름」이 된다. (b)의 잔여 — slug `demo`·고정 UUID·`#agent-lab` 시드 채널 — 는 §6에 명시하고 (a)에서 해소한다.

### D-C 셀프호스트 킥오프 — 「결재 대기」
| 선택지 | 내용 |
|---|---|
| (i) 현행 유지 | 에이전트 0명이면 조용한 no-op + 클라 120s 백스톱 카드 |
| (ii) 서버가 시스템 라인으로 오프너 대체 | ADR-0181 기각 대안(봇 래핑·ADR-0101 위반) — 재기각 |
| **(iii) 「첫 에이전트 연결」이 그 자리를 잇고, 킥오프는 첫 에이전트가 생길 때 재생** | (c1) 웹: `decideWelcomeMount`에 `no-active-agent` 사유를 추가해 hold를 즉시 풀고 UX-R2c `FirstAgentStage`(`FIRST_AGENT_TITLE` 「첫 에이전트 연결」, 순서 `kickoff → first-agent → phone-link`는 이미 그대로)로 진입 — 120s 대기 0 · (c2) 엔진: ADR-0181 D2 개정 — `resolve_welcome_target_in_tx`가 **처음으로 Some을 돌려주게 되는 전이**(네이티브 에이전트 생성 또는 hosted connection `active`)에서 오프너 마커가 없는 오너에게 킥오프를 enqueue. 멱등 키 D4(`welcome:{workspace}:{member}:opener:v1`) 그대로라 중복 0 · (c3) 연결 완료 → `#general` 착지 → 오프너 `arrival` 모션(ADR-0181 D7) — 와우가 「연결 직후」로 이동 |

**planner 권고: (iii) — 예.** 이유: P5의 「첫 대화」를 셀프호스트에서 처음으로 실재하게 만들고, ADR-0184 D6의 수용 문장(「첫 에이전트 합류까지」)과 같은 종점을 가리킨다. (c1)은 새 API 없이 클라가 이미 가진 디렉터리로 판정한다. (c2)는 사람 첫 합류 tx 트리거(D2)를 유지한 채 트리거 하나를 더하는 것이며, 어떤 전이를 훅으로 삼을지는 §8 봉인 파라미터다.

## 3. Slack·업계 비교
- **Slack** 웹 가입 퍼널은 팀(회사) 이름 → 본인 이름 → 동료 초대(건너뛸 수 있음) → 「지금 무슨 일을 하고 있나요」(첫 채널) 순이고, 앱에 들어간 뒤 Slackbot이 첫 DM으로 가르친다. 앞 절반이 성재 발제의 원형, 뒤 절반이 P5의 원형이다. Slack의 퍼널이 긴 이유는 **워크스페이스라는 그릇이 아직 없기** 때문인데, 우리는 claim 링크가 그릇(설치)을 이미 증명하므로 이름 확정 이상을 물을 이유가 약하다.
- **buzz**(§1-A)는 2스텝 뒤 킥오프에 와우를 몰아넣고, skip을 기본이 아니라 실패 시 탈출구로 둔다 — (3)이 따르는 규율.
- **셀프호스트 제품군**(Home Assistant·Mattermost·Discourse류)의 첫 관리자 마법사는 「관리자 계정 + 인스턴스/팀 이름」 1~2화면이 상한이고, 팀 규모류의 세그먼트 질문은 SaaS 성장팀의 문법이지 설치형 제품의 문법이 아니다. 설치형에서 세그먼트가 필요하면 사용 데이터로 추론한다 — (3)의 「팀 규모 = 추론」 근거.

## 4. 결과·영향

### 4.1 엔진 쓰기 경로(SH-12b engine·SH-12d)
- **E1 워크스페이스 이름 변경** `PATCH /v1/workspaces/{ws}` — `workspaces.rs` 헤더가 예약해 둔 자리. owner/admin(`require_human`), `normalized_workspace_name`(`momo-settings/src/workspace.rs`, 1~80자·제어문자 금지) 재사용, `GET`이 이미 주는 `updatedAtMs`로 낙관적 동시성(stale → 409), 감사 `workspace.renamed`. 스키마 변경 없음(기존 `workspace.name`).
- **E2 오너 자기 핸들 변경** — 현재 **존재하지 않는** 경로. `PATCH …/members/me`에 `handle`을 확장하거나 별도 라우트로. `normalized_requested_handle` 재사용, `member_handle_uniq` 충돌 409(join의 `HandleTaken` 문장 동형), `require_human`, 감사 `member.handle_changed`. **과거 메시지 본문의 `@demo`는 텍스트라 소급 변경하지 않는다**(정책 명시). 표시명은 기존 E0(`self_profile.rs`) 그대로.
- **E3 D-C (c2)** 첫 에이전트 활성 전이에서 오너 킥오프 enqueue — ADR-0181 D2 개정 항목. 스키마 변경 없음(`idempotency_key`·outbox 재사용).
- 단일 쓰기경로(REST→PG→outbox→relay)·RLS FORCE·`member` 모델 불변. 신규 시크릿 0. ADR-0004 동형(온보딩 화면은 자격을 만지지 않는다).

### 4.2 웹 스테이지(SH-12a·12b web·12c)
claim 비밀번호(현행) → S1 「내 워크스페이스·내 이름」(E1+E2+E0 호출) → S2 「팀원 초대」(`POST /v1/workspaces/{ws}/invites` 재사용, 설정 › 멤버와 초대 `InviteSection`과 같은 코드·카피, 「나중에」 skip 상시) → first-run 4마커(SH-12a) → kickoff-hold(에이전트 있음) 또는 first-agent(없음, D-C c1) → phone-link. 데스크탑은 같은 web 번들이라 별도 작업 없음. design-review Blocker 0.

### 4.3 문서(SH-12e)
- `docs/SELF_HOST_FIRST_DAY.md`/`.ko.md` §2~§4 재작성 — §2 제목·본문(「로그인 — 시드 워크스페이스에 들어간다」/「Sign in — enter the seed workspace」)이 데모 착륙을 정본으로 서술하고 있고, §3 「워크스페이스 만들기」는 `require_instance_operator` 경로라 첫 하루 흐름에서 빠진다. 좌표 드리프트 수정(`infra/prod/…` → `infra/rust/sql/…`, `self_host_env.sh:658` → 현행).
- ADR-0166 §6 개정: 「claim 뒤 워크스페이스 이름·오너 프로필 확정」은 범위 안(워크스페이스 생성은 여전히 밖 — SH-12z까지).
- ADR-0181 D2·D3 개정 주석(D-C 채택 시). P5 주석: 「셀프호스트에서 첫 대화 상대가 아직 없으면 『첫 에이전트 연결』이 첫 대화의 문이다」.

### 4.4 테스트
red proof는 §5로 갈음. 하네스 4본(§D-B 4)은 시드 무접촉이므로 (b)에서 이관 없음.

### 4.5 비용
- (−) 무인증 표면 증가 0, 인증 쓰기 라우트 +2(E1·E2) — 각각 403/400/409 단정.
- (−) 핸들 변경은 멘션 UX의 안정 가정을 하나 깬다 — v1은 오너 자기 자신·온보딩 창구 한정으로 두고 일반 설정 노출은 §8에서 봉인.
- (−) (b)의 잔여(slug·UUID·`#agent-lab`)는 문서에 정직하게 남긴다.

## 5. 수용기준(Accepted 뒤 티켓 수용기준의 골자 — 전부 단정)
1. 새 설치(`MOMO_BOOTSTRAP_CLAIM=1`) claim 완주 → 온보딩 완료 뒤, 사이드바·설정·프로필에 `momo Demo Workspace`·「데모 사용자」·`@demo` 문자열 노출 **0회**(E2E-B 하네스 DOM grep) — 사용자가 입력한 값으로 표시.
2. claim 비밀번호 화면을 제외한 온보딩 필수 화면 **≤ 1**, 전체 스텝 **= 2**(`totalSteps_is_2` 동형 단정).
3. 초대 화면에 skip 탈출구 **1개 상시 노출**, skip 시 초대 코드 발급 **0건**, 탈출구 문장이 재진입 위치(설정 › 멤버와 초대)를 말한다.
4. 팀 규모 질문 **0개**(웹 문구 grep 단정, 저장 칼럼 0).
5. claim 성공 직후 `decideFirstRun` ≠ `"app"`(SH-12a) — **사보타주**: 네 마커 중 하나를 빼면 RED.
6. 에이전트 0명 워크스페이스: claim 뒤 킥오프 스테이지 대기 없이 **≤ 2s** 안에 「첫 에이전트 연결」 스테이지 진입(120s 백스톱 카드 0회).
7. 첫 에이전트 활성 뒤 오프너 **정확히 1회**(멱등 키 UNIQUE) — 에이전트 2개 연속 연결·재로그인·재설치에도 1회, 원장 행 1.
8. E1: 비오너 403 · 에이전트 bearer 403 · 빈 이름/81자 400 · stale `updatedAtMs` 409 · 성공 시 감사 행 1 · `GET`이 새 이름을 돌려준다.
9. E2: 중복 핸들 409 · 형식 400 · 성공 시 세션 `member.handle` 갱신 + 감사 행 1 · 기존 메시지 본문 diff 0.
10. 기존 설치 업그레이드: 이미 이름을 바꾼 워크스페이스·오너가 `up -d` 재기동 뒤 무변경(`MOMO_BOOTSTRAP_OWNER=skipped`/`MOMO_BOOTSTRAP_CLAIM` 멱등 유지).
11. `scripts/verify_owner_claim.sh`·`verify_openapi_contract_rust.sh`·`clients/mobile/scripts/lane-phone.sh`·`scripts/local_gate.sh` 4본 PASS 유지.
12. `schema_v0.sql` diff 0 · 시크릿 게이트 PASS · 병합 트리 8레인 PASS · design-review Blocker 0.

## 6. 하지 않는 것
- 시드 제거·claim의 워크스페이스 생성(D-B (a)) — SH-12z 별도 ADR. 따라서 slug `demo`·고정 UUID·`#agent-lab`은 v0.1.5에 남는다.
- 「팀 규모」 칼럼·질문·세그먼트.
- 서버 시스템 라인으로 오프너 대체(ADR-0181 기각 유지).
- `POST /v1/workspaces`의 `require_instance_operator` 게이트 완화.
- 핸들 변경에 따른 과거 메시지 본문 재작성·리다이렉트.
- 초대 경로 신설 — 기존 `invites` 라우트·`InviteSection` 재사용.
- 폰·데스크탑 별도 온보딩 — 같은 web 번들, 폰은 ADR-0180 phone-link 그대로.
- `002_seed.sql` 수정·이동, `schema_v0.sql` 접촉, 신규 시크릿.

## 7. 관련 ADR
ADR-0100(거버넌스 — Proposed는 티켓 불가) · **ADR-0166**(claim — §6 개정) · **ADR-0180**(기기 연결 — first-run 순서) · **ADR-0181**(웰컴 킥오프 — D2·D3 개정) · **ADR-0184**(플랫폼 중립 — 결재 기록이 본 ADR의 발제, D6 종점 동일) · ADR-0121(배포판·온보딩) · ADR-0101(에이전트=멤버, 봇 래핑 금지).

## 8. Accepted 뒤 티켓에서 봉인할 파라미터
E1 라우트 경로·요청 본문 필드명 · E2가 `members/me` 확장인지 별도 라우트인지, 핸들 변경 허용 범위(온보딩 창구 한정 vs 설정 상시)와 쿨다운 유무 · S1 기본값(표시명 빈칸/핸들 제안값 규칙 = `fallback_handle` 동형) · S2 초대 링크 TTL·개수 · D-C (c2) 훅 전이(네이티브 생성 tx / hosted `active` 전이 / 둘 다)와 대상(오너 1인 v1) · `no-active-agent` 판정 소스(디렉터리 vs 별도 조회) · 온보딩 완료 마커 키·버전.

## 9. 패킷 지도
| ID | 내용 | 결재 의존 | 트랙 |
|---|---|---|---|
| **SH-12a** | claim 뒤 first-run 퍼널 복원 — `ClaimPage`가 invite-join과 동형으로 4개 마커 기록(§5-5) | **없음 — 결함 수리, 발급 완료 #2301**(본 ADR과 독립) | uxui |
| SH-12b | E1 workspace rename + E2 오너 핸들 변경(+E0 표시명) 엔진 쓰기 경로 → S1 「내 워크스페이스·내 이름」 스테이지 | D-A·D-B(b) | engine → uxui |
| SH-12c | S2 「팀원 초대」 스테이지(초대 발급·복사·skip 탈출구, §1-A 규율) | D-A | uxui |
| SH-12d | D-C: (c1) `no-active-agent` hold 해제 → first-agent · (c2) 첫 에이전트 활성 전이 킥오프(ADR-0181 D2 개정) | D-C | engine(+uxui c1) |
| SH-12e | 문서: `SELF_HOST_FIRST_DAY(.ko)` §2~§4 · 좌표 드리프트 · ADR-0166 §6·ADR-0181 D2/D3·P5 주석 | D-A·D-B·D-C | docs |
| SH-12z(후속) | 시드 제거형 제로베이스(D-B (a)): 시드 게이트 변수·bootstrap UUID 의존 해소·claim 워크스페이스 생성·하네스 4본 이관·업그레이드 정책 | 별도 ADR | engine |

순서: 12a(즉시) → 12b-engine(E1·E2) → 12b-web ∥ 12c → 12d → 12e. v0.1.5 포함 목표: 12a 확정 + 12b·12c(결재 즉시 시) — 발행은 성재(RELEASING 절차 그대로).

## 10. 결재 기록
- (비어 있음) D-A: ☐(1) ☐(2) ☐(3) · D-B: ☐(a) ☐(b, v0.1.5) · D-C: ☐(i) ☐(iii) — 채택·수정 지시·봉인 파라미터(§8) 결정은 여기에 날짜와 함께 남긴다.
