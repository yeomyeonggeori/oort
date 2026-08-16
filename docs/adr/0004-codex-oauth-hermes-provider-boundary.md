# ADR 0004: Codex OAuth Boundary for Hermes/Kim Intern Provider

> Status: Accepted for MOMO-234
> Date: 2026-07-01

## Decision

oort does not own, store, proxy, log, or persist Codex/OpenAI OAuth access
tokens, refresh tokens, or GPT/OpenAI provider API keys.

When Kim Intern uses a Hermes or provider-hosted Codex runtime, the Codex OAuth
credential boundary is outside the oort app, API, worker, database, diagnostics,
and local gate evidence. oort talks only to the Hermes/Kim Intern provider over
the existing OpenAI-compatible `/v1/chat/completions` SSE boundary by using an
opaque Hermes-facing bearer configured as `HERMES_API_KEY`.

The provider owns any Codex/OpenAI OAuth flow, token exchange, token refresh,
GPT/OpenAI API key storage, provider account unlink, and OAuth storage. oort owns
workspace identity, membership, Context Packet projection, approval, cost, audit,
message ordering, and realtime delivery.

## Boundary

| Item | Owner | Storage | oort visibility |
|---|---|---|---|
| Codex OAuth authorization code | Hermes/Kim Intern provider | Provider-only transient exchange | Never sent to oort |
| Codex OAuth access token | Hermes/Kim Intern provider | Provider secret store or memory, according to provider policy | Never sent to oort |
| Codex OAuth refresh token | Hermes/Kim Intern provider | Provider secret store, encrypted by provider | Never sent to oort |
| GPT/OpenAI API key | Hermes/Kim Intern provider | Provider secret store, encrypted file, local shell, or memory according to provider policy | Never sent to oort |
| Hermes-facing bearer for oort worker | Operator/momo runtime env | Untracked env, SOPS/host secret, or local shell | Used only as Bearer key to Hermes; redacted from evidence |
| oort app access/refresh token | oort API | oort auth tables/JWT boundary | Not accepted as provider credential |
| Context Packet and tool grants | oort | Postgres/source projections | Sent to provider as bounded non-secret work context |
| Agent result, cost, audit | oort | Postgres + outbox + Centrifugo transport | Source of truth for oort user-visible work |

## Rules

1. oort must not introduce `codex_oauth_*`, `codex_access_token`,
   `codex_refresh_token`, `openai_oauth_*`, or equivalent columns.
2. oort app/API/DB must not accept Codex OAuth tokens in request bodies, env
   files, logs, diagnostics, local gate evidence, Context Packets, Memory Plane,
   Capability Cache, or audit payloads.
3. `scripts/verify_external_agent_provider.sh` fails fast when known Codex OAuth
   token or OpenAI API key env var names are present. Those values belong in the
   provider host, not in the oort smoke process.
4. Provider endpoint labels may be shown only after removing userinfo, query,
   fragment, and secrets.
5. Provider secrets are never copied into generated evidence. Redacted artifact
   paths are acceptable; raw provider logs are deleted after sanitization.
6. User-visible messages still enter through oort REST/DB/outbox. The provider
   must never publish directly to Centrifugo or mutate oort DB state.

## Credentialed Smoke

The oort-side credentialed smoke requires only:

- `AGENT_PROVIDER_MODE=external-hermes`
- `HERMES_BASE_URL=https://<provider>/v1`
- `HERMES_API_KEY=<provider-api-key>`
- `AGENT_MODEL=<provider model label>`
- optional `EXTERNAL_AGENT_PROVIDER_ENV_FILE=<untracked provider env file>`

If the provider itself uses Codex OAuth, the provider operator configures that
inside Hermes/Kim Intern. The oort smoke verifies only that the provider exposes
an OpenAI-compatible SSE surface and that oort can complete one Kim Intern
roundtrip without seeing Codex OAuth tokens.

For local-only development, MOMO-238 permits an explicit loopback exception:

- `MOMO_ENV=local`
- `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1`
- `HERMES_BASE_URL=http://127.0.0.1:<port>/v1` or
  `http://localhost:<port>/v1`

This exception is only for a developer-run Hermes process. Non-loopback
`http://` URLs still fail fast, and loopback/mock URLs still fail fast in
`staging`, `prod`, `production`, and `internal-host`.

## Rotation and Revocation

- Rotate `HERMES_API_KEY` in the operator secret store and restart the provider
  consumer processes. oort treats the key as opaque.
- Rotate or revoke Codex OAuth credentials only in the provider control plane.
  oort records provider availability degradation, not token values.
- If provider auth fails with 401/403, AgentWorker must fail the run or retry
  according to worker retry policy, leaving an audit/status reason such as
  `provider_auth_failed` without including credential material.
- If a user unlinks Codex in the provider, future oort runs should degrade or
  fail closed until the provider reports availability again.

## Redaction

Evidence and diagnostics must redact:

- `HERMES_API_KEY`
- `Authorization: Bearer ...`
- database URL passwords
- oort app access/refresh tokens
- any key whose name contains Codex/OpenAI OAuth token or refresh token markers
- any `OPENAI_API_KEY`/`CODEX_API_KEY` style provider key env var

`/v1/agent-runtime/status` may expose `mode`, `availability`, `model`,
`keyConfigured`, and a redacted `endpointLabel`; it must not expose token bodies
or provider account identifiers.

## Failure Modes

| Failure | oort behavior |
|---|---|
| No external provider env | Safe PASS/SKIP with `runtime-unverified(external provider credentials)` evidence |
| Placeholder/local/mock external provider env | Fail fast as misconfigured credentialed smoke |
| Codex/OpenAI OAuth token or API key env passed to oort smoke | Fail fast and tell operator to move it to provider host |
| Local loopback Hermes without explicit opt-in | Fail fast unless `MOMO_ENV=local` and `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1` |
| Non-loopback `http://` provider URL | Fail fast; use HTTPS or a local loopback opt-in |
| Provider SSE unavailable or malformed | Fail with provider/network or provider/protocol category |
| Provider auth rejected | Fail/degrade without printing credential material |
| oort roundtrip timeout | Fail with runtime timeout and redacted server/worker/relay logs |

## Audit

oort audit records must identify the provider mode, redacted endpoint label,
agent run, trigger message, tool/approval decisions, usage ledger, and final
message ids. Audit must not record Codex/OpenAI OAuth subject ids, access tokens,
refresh tokens, authorization codes, GPT/OpenAI provider API keys, or provider
raw account secrets unless a future explicit privacy/security review introduces a
separate encrypted provider-link table.

## References

- `research/11-agent-runtime/11-hermes-adapter-contract-v0.md`
- `docs/external-agent-provider/local-hermes-gpt.md`
- `docs/RUN.md` section "Kim Intern/Hermes provider mode"
- `docs/LOCAL_PR_GATE.md` profile `external-agent-provider`
- `scripts/verify_external_agent_provider.sh`

---

## 증보 1 — provider 연결의 GUI화 + Hermes bearer 암호화 저장 (2026-07-23, 성재 발제)

- Status: **Accepted** (성재 승인 2026-07-23 — D1~D6 전부. P-1~P-3 발급, 0.0.2 목표)
- 발단: 현재 provider는 서버 env(AGENT_PROVIDER_MODE·HERMES_BASE_URL·HERMES_API_KEY)로만 설정된다 — 운영자가 파일/CLI로 붙이는 TUI 경험. 성재는 셀프호스트 배포판에 provider 연결이 **옵션처럼 함께 담겨** 설치 후 **앱 GUI에서 직접 연결·테스트**하는 경험을 원한다. 이는 자격증명 저장 경계 변경이라 본 ADR 증보가 선행한다.

### D1. GUI로 받아 저장 가능한 것의 경계 (불변식 유지)
- oort가 GUI로 입력받아 보관할 수 있는 것은 **오직 Hermes-facing base URL + opaque bearer**뿐이다(기존 §Boundary의 "Hermes-facing bearer for oort worker" 항목 — provider 원본 키가 아닌 게이트웨이 접근 토큰). **Codex/OpenAI OAuth code·access·refresh 토큰, GPT/OpenAI API key는 여전히 provider 소유·oort 비유입**(본 ADR 본문 규칙 불변). GUI에 그 필드를 만들지 않는다.

### D2. bearer 저장 = 암호화 DB (env-only에서 확장)
- 기존 저장 위치(untracked env/SOPS/host secret)에 **암호화 DB 저장을 추가**한다. bearer는 `OUTBOUND_WEBHOOK_MASTER_KEY`와 **분리된 별도 마스터키**로 대칭 암호화해 저장(마이그레이션 신설, 다음=039). 평문 bearer는 로그·Context Packet·audit·gate evidence에 절대 비유입(본문 규칙 승계). 조회 시 **마스킹만**(재노출 금지, 재입력으로만 교체 — 웹훅 one-time secret 규율과 동형).

### D3. 스코프 — instance-level 우선
- 내부 테스트는 **instance-level provider config**(운영자 1회 설정, 전 워크스페이스 공용)를 우선한다. workspace-level 오버라이드는 후속(멀티 테넌트 SaaS 단계). 설정 권한 = 서버 운영자/owner.

### D4. mode 해석 우선순위 + fail-closed 유지
- 유효 provider 해석: **DB config(있으면) > env**. 둘 다 없거나 무효면 strict 환경(staging/prod/internal-host)은 기존대로 **기동/실행 fail-closed**(본문 규칙 승계). GUI에서 연결 전에는 mock/미설정 상태를 명시.

### D5. 연결 테스트 = provider health 왕복
- GUI에 "연결 테스트" — 저장된 base URL+bearer로 provider `/v1` health(또는 최소 chat 왕복)를 쳐 유효성 확인, 상태(연결됨/실패/미설정)를 표시. 실패는 자격증명 원문 노출 없이 사유만.

### D6. Codex work host는 별개 경로
- 로컬 Codex CLI를 work host로 쓰는 경로(ADR-0114/0125 self-register)는 본 증보 범위 밖 — 그건 Codex OAuth를 로컬 CLI가 소유(oort 비유입). 본 증보는 **에이전트 provider(LLM 응답) 연결**의 GUI화만 다룬다. 두 경로의 GUI를 설정에서 구분 표기.

### 파생 배치 후보 (Accepted 후)
| 후보 | 내용 | 트랙 |
|---|---|---|
| P-1 | provider config REST(instance scope, bearer 암호화 저장/마스킹/삭제, mode override) + 마이그레이션 039 + health 테스트 엔드포인트 | 엔진 |
| P-2 | 관리자 설정 "AI 연결" GUI — base URL/bearer 입력·연결 테스트·상태·해제(Codex work host 경로와 구분) | UXUI |
| P-3 | 배포판 문서: 설치 후 GUI 연결 5단계(single image에 이미 포함되므로 코드 랜딩=자동 담김) | docs |

### Consequences
- (+) "실제 codex/hermes 연동"이 CLI/env 편집 없이 앱 GUI에서 — 성재가 원한 셀프호스트 연동 경험. 배포판(single image)에 자동 포함.
- (+) ADR-0004 핵심 불변식(OAuth·원본 키 비유입) 유지 — GUI가 받는 건 게이트웨이 bearer뿐.
- (−) oort가 bearer를 암호화 DB에 보관하는 새 저장 표면 — 마스터키 관리·마스킹·삭제 규율 필요(본 증보가 규정).
- 예약: workspace-level provider, provider 카탈로그(여러 provider 프리셋), Codex work host GUI 연결 심화.

---

## 증보 2 — 관리형 클라우드의 운영자 소유 bundled 키 규율 (2026-08-14, 성재 발제 "크레딧 기반 매니지드 클라우드")

- Status: **Accepted** (성재 승인 2026-08-14 — 일괄 결재)
- 발단: 프로덕트 사용자용 관리형 클라우드(ADR-0164 크레딧 과금)에서는 **oort 운영자가 provider 계약 주체**가 된다. 본 ADR의 "사용자 자격증명 비유입" 불변식은 그대로 두되, 운영자 소유 키의 보유·계량 규율이 명문화돼야 한다.

### D1. 불변식 재서술 (변경 아님 — 명확화)
- 본 ADR이 금지해 온 것은 **사용자의** provider 자격증명(OAuth 토큰·API 키)의 oort 유입이다. 이 불변식은 관리형 클라우드에서도 **불변**이다 — 사용자는 어떤 provider 키도 oort에 내지 않는다(그게 관리형의 존재 이유다).
- **운영자 소유 bundled 키**(oort가 계약한 Anthropic/OpenAI/기타 provider 키)는 사용자 자격증명이 아니라 **서버 시크릿**이다. 기존 `HERMES_API_KEY`와 같은 계급으로, 기존 시크릿 규율(untracked env/SOPS·증보 1 D2의 분리 마스터키 암호화 DB·로그/evidence/Context Packet 비유입·마스킹 조회)을 그대로 승계한다.

### D2. bundled 키의 계량 의무
- bundled 키 경유의 모든 provider 호출은 **workspace/agent/run 단위로 usage ledger에 계량**돼야 과금(ADR-0164)이 성립한다. 계량 없는 bundled 호출 경로는 금지 — 새 provider 경로 추가 시 ledger 결선이 수용기준.
- ledger에는 토큰 수·모델 라벨·단가 스냅샷만 — provider 계정 식별자·키 지문은 비유입(본문 §Audit 승계).

### D3. BYO-key는 이번 파도에 열지 않는다
- 사용자가 자기 provider 키를 등록해 관리형 인프라에서 쓰는 경로(BYO-key)는 **명시적으로 범위 밖** — 그 경로는 "사용자 자격증명 보관"이라는 새 저장 표면이라 별도 ADR 없이 열지 않는다. 셀프호스트(운영자=사용자)와 연동형/다이얼인형(HAP — 키가 사용자 인프라에 잔류)이 그 수요의 정본 경로다.

### D4. 키 계층과 격리
- bundled 키는 instance-level 시크릿이며 워크스페이스에 노출되지 않는다. 향후 테넌트별 키 분리(레이트리밋 격리·남용 봉쇄)가 필요해지면 provider 측 sub-key/조직 기능으로 해결하고, oort DB에 테넌트별 키 사본을 만들지 않는 것을 기본값으로 한다(필요 시 별도 증보).

### Consequences
- (+) 관리형 클라우드가 본 ADR과 충돌 없이 성립 — "비유입"의 주어가 사용자임이 명문화됨.
- (+) 과금(ADR-0164)의 전제인 계량 의무가 경계 규칙이 됨.
- (−) 운영자 키가 고가치 단일 시크릿이 됨 — 회전 절차(본문 §Rotation 승계)와 지출 상한(ADR-0164 공정사용)이 안전판.

---

## 증보 3 — 라이브 세션 control 창의 비관측·사용자 자격 비유입 (2026-08-15, 성재 발제 "채팅 내 VM 직접 조작")

- Status: **Accepted** (성재 승인 2026-08-15 — 형태 결재(신규 ADR 대신 증보)와 문서 Accept 각각 구조화 질의로. owner_only의 owner 예외는 LIVE-3 파도에서 함께 결정하기로 결재됨)
- 발단: Grok Bot의 "채팅 안 VM 화면 + 사용자가 직접 조작해 로그인" 패턴 편입(근거 정본 `docs/planning/research/2026-08-15-in-chat-interactive-vm-takeover.md`). 성재가 마음에 든 핵심 = **에이전트에 비밀번호를 주지 않는** 자격 핸드오프 — 본 ADR 불변식의 라이브 세션 확장이다. 전송 결정은 ADR-0165(WebRTC), 관전 축 자체(view-only)는 경계 변경이 아니라 본 증보를 기다리지 않는다(LIVE-1/2). **본 증보는 control(직접 조작) 개방(LIVE-3/4)의 선행 조건.**
- 현재 상태 근거: attach 기계에 `AttachMode = controller | observer`가 이미 존재(`server-rust/crates/momo-t3/src/terminal_attach.rs:69-92`) · 서버는 스트림 비경유(`bins/momo-server/src/dto.rs:1002`) · 인수 어휘 `HandoffVerb = resume | takeover`(`packages/momo-core/src/features/work/sessionHandoff.ts:87`)는 "원 호스트가 끝난 세션의 계보 재개"라 본 건과 다른 것.

### D1. 어휘 — control은 인수(takeover)가 아니다
라이브 개입 = 기존 `AttachMode::Controller`의 display 적용 = **"control"**. 새 동사를 발명하지 않는다. 세션·호스트는 살아 있고 사람이 잠깐 입력을 얹었다 돌려준다 — 계보 인수(HandoffVerb takeover)와 코드·카피 양쪽에서 구분한다. UI 카피는 "직접 조작"(가칭 — design-review 확정), "인수" 단어 미사용. 판정 주체는 기존 규율대로 서버.

### D2. 사용자 자격 비유입 (본문 불변식의 주어 확장)
control 창에서 사용자가 입력하는 자격증명(비밀번호·2FA·CAPTCHA 응답)은 **에이전트 컨텍스트·전사·audit·스크린샷·Memory Plane·Context Packet 어디에도 비유입**(본문 §Rules 2의 주어를 사용자로 바꾼 같은 불변식 — 증보 2 D1의 명문화를 승계). 채팅에 비밀번호를 붙여넣는 경로는 만들지 않는다 — control 창 직접 입력이 유일 정본 경로.

### D3. control-창 비관측 불변식 (핵심 신규 경계)
control 활성 동안 **에이전트의 프레임 캡처·화면 읽기·입력 관측은 기술적으로 차단**된다(정책 선언이 아니라 강제 — 에이전트의 화면 접근 경로가 control 상태를 확인하고 거부하며, mutation 증명이 수용기준). 에이전트가 아는 것은 **경계 이벤트뿐**: 정지 시각·재개 시각·"사용자 개입 완료" 신호. 그 사이의 픽셀과 키는 사람↔VM 직결. 비관측의 주어는 에이전트다 — 인간 observer의 관전은 기존 `observation(open|owner_only)` 권한 모델 그대로. (업계 원형: OpenAI Operator "사용자 조작 중 스크린샷 미캡처". E2B `view_only`에는 이 계약이 없다 — 우리가 명시하는 것이 본 조항.)

### D4. 재개는 자격이 아니라 세션 상태로
control 종료 후 에이전트는 **VM에 잔류한 인증된 세션 상태(쿠키 등)**로 재개한다(Operator 동형). 세션 영속물은 VM 내부에만 잔류 — oort 서버 비유입, VM 파기 = 잔류물 파기(ADR-0140 수명주기 승계).

### D5. egress 정합 (ADR-0150 증보 1)
T3 default-deny는 control 중에도 유효 — 사용자가 로그인할 목적지 도메인은 **control 시작 시 사용자가 명시 부여하는 grant**로 연다(ADR-0150 증보 1 D1의 발급 심사가 곧 이 UX — 인간이 부여 주체). control 중 사용은 `egress_use` 원장에 human-control 표기 행(채널 사실만 — D2에 따라 내용 비유입). **control이 암묵적으로 grant를 넓히지 않는다** — 종료 후 에이전트 네트워크는 부여된 grant 그대로.

### D6. 수명주기·과금 — VM은 계속 running이다
control 중 **T3 세션 상태기계(ADR-0140 9상태)는 불변** — VM `running` 유지, ADR-0164 running-time 과금 지속. 정지되는 것은 **에이전트 런 층**("사용자 개입 대기" — 토큰 소진 0, 크레딧이 토큰으로 새지 않음). 리서치 정본의 "ADR-0140 pause 재사용" 표현은 부정확해 정정한다: 0140의 `paused`는 VM pause(과금 0)라 다른 상태다.

### D7. 범위
`work_host.type = 'cloud'` **AND** `provider = 'cubesandbox'`(관리형 — momo가 템플릿을 소유해 스트림 producer 탑재를 보장하는 유일한 경우)만. **BYOC fail-closed**(`work_host.capabilities` 광고 없는 호스트에 display capability 발급 거부). HAP 다이얼인 봇은 provider VM이라 비적용(관측 프록시도 provider API 없이는 불가 — 08-12 인바운드 불가 판정과 같은 벽). T1 데스크톱 확장은 별건 결정.

### Consequences
- (+) "에이전트에 비밀번호를 안 주는 직접 로그인"이 기존 불변식(본문 비유입·0150 grant·0164 과금)과 충돌 없이 성립.
- (+) view-only 관전(LIVE-1/2)과 분리 — 그쪽은 display capability의 observer-한정 발급(서버 강제)이 경계의 잠금장치라 본 증보의 Accept를 기다리지 않는다.
- (−) 비관측의 기술적 강제 검증기 필요(에이전트 화면 접근 경로의 control-상태 거부 — mutation 증명 포함).
- (−) UI 어휘 신설("직접 조작")과 기존 "인수" 카피 혼동 방지 규율(design-review 관문).
- 성재 잔여 결정: 본 증보 Accept · T1 확장 여부.
