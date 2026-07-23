# ADR 0004: Codex OAuth Boundary for Hermes/Kim Intern Provider

> Status: Accepted for MOMO-234
> Date: 2026-07-01

## Decision

momo does not own, store, proxy, log, or persist Codex/OpenAI OAuth access
tokens, refresh tokens, or GPT/OpenAI provider API keys.

When Kim Intern uses a Hermes or provider-hosted Codex runtime, the Codex OAuth
credential boundary is outside the momo app, API, worker, database, diagnostics,
and local gate evidence. momo talks only to the Hermes/Kim Intern provider over
the existing OpenAI-compatible `/v1/chat/completions` SSE boundary by using an
opaque Hermes-facing bearer configured as `HERMES_API_KEY`.

The provider owns any Codex/OpenAI OAuth flow, token exchange, token refresh,
GPT/OpenAI API key storage, provider account unlink, and OAuth storage. momo owns
workspace identity, membership, Context Packet projection, approval, cost, audit,
message ordering, and realtime delivery.

## Boundary

| Item | Owner | Storage | momo visibility |
|---|---|---|---|
| Codex OAuth authorization code | Hermes/Kim Intern provider | Provider-only transient exchange | Never sent to momo |
| Codex OAuth access token | Hermes/Kim Intern provider | Provider secret store or memory, according to provider policy | Never sent to momo |
| Codex OAuth refresh token | Hermes/Kim Intern provider | Provider secret store, encrypted by provider | Never sent to momo |
| GPT/OpenAI API key | Hermes/Kim Intern provider | Provider secret store, encrypted file, local shell, or memory according to provider policy | Never sent to momo |
| Hermes-facing bearer for momo worker | Operator/momo runtime env | Untracked env, SOPS/host secret, or local shell | Used only as Bearer key to Hermes; redacted from evidence |
| momo app access/refresh token | momo API | momo auth tables/JWT boundary | Not accepted as provider credential |
| Context Packet and tool grants | momo | Postgres/source projections | Sent to provider as bounded non-secret work context |
| Agent result, cost, audit | momo | Postgres + outbox + Centrifugo transport | Source of truth for momo user-visible work |

## Rules

1. momo must not introduce `codex_oauth_*`, `codex_access_token`,
   `codex_refresh_token`, `openai_oauth_*`, or equivalent columns.
2. momo app/API/DB must not accept Codex OAuth tokens in request bodies, env
   files, logs, diagnostics, local gate evidence, Context Packets, Memory Plane,
   Capability Cache, or audit payloads.
3. `scripts/verify_external_agent_provider.sh` fails fast when known Codex OAuth
   token or OpenAI API key env var names are present. Those values belong in the
   provider host, not in the momo smoke process.
4. Provider endpoint labels may be shown only after removing userinfo, query,
   fragment, and secrets.
5. Provider secrets are never copied into generated evidence. Redacted artifact
   paths are acceptable; raw provider logs are deleted after sanitization.
6. User-visible messages still enter through momo REST/DB/outbox. The provider
   must never publish directly to Centrifugo or mutate momo DB state.

## Credentialed Smoke

The momo-side credentialed smoke requires only:

- `AGENT_PROVIDER_MODE=external-hermes`
- `HERMES_BASE_URL=https://<provider>/v1`
- `HERMES_API_KEY=<provider-api-key>`
- `AGENT_MODEL=<provider model label>`
- optional `EXTERNAL_AGENT_PROVIDER_ENV_FILE=<untracked provider env file>`

If the provider itself uses Codex OAuth, the provider operator configures that
inside Hermes/Kim Intern. The momo smoke verifies only that the provider exposes
an OpenAI-compatible SSE surface and that momo can complete one Kim Intern
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
  consumer processes. momo treats the key as opaque.
- Rotate or revoke Codex OAuth credentials only in the provider control plane.
  momo records provider availability degradation, not token values.
- If provider auth fails with 401/403, AgentWorker must fail the run or retry
  according to worker retry policy, leaving an audit/status reason such as
  `provider_auth_failed` without including credential material.
- If a user unlinks Codex in the provider, future momo runs should degrade or
  fail closed until the provider reports availability again.

## Redaction

Evidence and diagnostics must redact:

- `HERMES_API_KEY`
- `Authorization: Bearer ...`
- database URL passwords
- momo app access/refresh tokens
- any key whose name contains Codex/OpenAI OAuth token or refresh token markers
- any `OPENAI_API_KEY`/`CODEX_API_KEY` style provider key env var

`/v1/agent-runtime/status` may expose `mode`, `availability`, `model`,
`keyConfigured`, and a redacted `endpointLabel`; it must not expose token bodies
or provider account identifiers.

## Failure Modes

| Failure | momo behavior |
|---|---|
| No external provider env | Safe PASS/SKIP with `runtime-unverified(external provider credentials)` evidence |
| Placeholder/local/mock external provider env | Fail fast as misconfigured credentialed smoke |
| Codex/OpenAI OAuth token or API key env passed to momo smoke | Fail fast and tell operator to move it to provider host |
| Local loopback Hermes without explicit opt-in | Fail fast unless `MOMO_ENV=local` and `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1` |
| Non-loopback `http://` provider URL | Fail fast; use HTTPS or a local loopback opt-in |
| Provider SSE unavailable or malformed | Fail with provider/network or provider/protocol category |
| Provider auth rejected | Fail/degrade without printing credential material |
| momo roundtrip timeout | Fail with runtime timeout and redacted server/worker/relay logs |

## Audit

momo audit records must identify the provider mode, redacted endpoint label,
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
- momo가 GUI로 입력받아 보관할 수 있는 것은 **오직 Hermes-facing base URL + opaque bearer**뿐이다(기존 §Boundary의 "Hermes-facing bearer for momo worker" 항목 — provider 원본 키가 아닌 게이트웨이 접근 토큰). **Codex/OpenAI OAuth code·access·refresh 토큰, GPT/OpenAI API key는 여전히 provider 소유·momo 비유입**(본 ADR 본문 규칙 불변). GUI에 그 필드를 만들지 않는다.

### D2. bearer 저장 = 암호화 DB (env-only에서 확장)
- 기존 저장 위치(untracked env/SOPS/host secret)에 **암호화 DB 저장을 추가**한다. bearer는 `OUTBOUND_WEBHOOK_MASTER_KEY`와 **분리된 별도 마스터키**로 대칭 암호화해 저장(마이그레이션 신설, 다음=039). 평문 bearer는 로그·Context Packet·audit·gate evidence에 절대 비유입(본문 규칙 승계). 조회 시 **마스킹만**(재노출 금지, 재입력으로만 교체 — 웹훅 one-time secret 규율과 동형).

### D3. 스코프 — instance-level 우선
- 내부 테스트는 **instance-level provider config**(운영자 1회 설정, 전 워크스페이스 공용)를 우선한다. workspace-level 오버라이드는 후속(멀티 테넌트 SaaS 단계). 설정 권한 = 서버 운영자/owner.

### D4. mode 해석 우선순위 + fail-closed 유지
- 유효 provider 해석: **DB config(있으면) > env**. 둘 다 없거나 무효면 strict 환경(staging/prod/internal-host)은 기존대로 **기동/실행 fail-closed**(본문 규칙 승계). GUI에서 연결 전에는 mock/미설정 상태를 명시.

### D5. 연결 테스트 = provider health 왕복
- GUI에 "연결 테스트" — 저장된 base URL+bearer로 provider `/v1` health(또는 최소 chat 왕복)를 쳐 유효성 확인, 상태(연결됨/실패/미설정)를 표시. 실패는 자격증명 원문 노출 없이 사유만.

### D6. Codex work host는 별개 경로
- 로컬 Codex CLI를 work host로 쓰는 경로(ADR-0114/0125 self-register)는 본 증보 범위 밖 — 그건 Codex OAuth를 로컬 CLI가 소유(momo 비유입). 본 증보는 **에이전트 provider(LLM 응답) 연결**의 GUI화만 다룬다. 두 경로의 GUI를 설정에서 구분 표기.

### 파생 배치 후보 (Accepted 후)
| 후보 | 내용 | 트랙 |
|---|---|---|
| P-1 | provider config REST(instance scope, bearer 암호화 저장/마스킹/삭제, mode override) + 마이그레이션 039 + health 테스트 엔드포인트 | 엔진 |
| P-2 | 관리자 설정 "AI 연결" GUI — base URL/bearer 입력·연결 테스트·상태·해제(Codex work host 경로와 구분) | UXUI |
| P-3 | 배포판 문서: 설치 후 GUI 연결 5단계(single image에 이미 포함되므로 코드 랜딩=자동 담김) | docs |

### Consequences
- (+) "실제 codex/hermes 연동"이 CLI/env 편집 없이 앱 GUI에서 — 성재가 원한 셀프호스트 연동 경험. 배포판(single image)에 자동 포함.
- (+) ADR-0004 핵심 불변식(OAuth·원본 키 비유입) 유지 — GUI가 받는 건 게이트웨이 bearer뿐.
- (−) momo가 bearer를 암호화 DB에 보관하는 새 저장 표면 — 마스터키 관리·마스킹·삭제 규율 필요(본 증보가 규정).
- 예약: workspace-level provider, provider 카탈로그(여러 provider 프리셋), Codex work host GUI 연결 심화.
