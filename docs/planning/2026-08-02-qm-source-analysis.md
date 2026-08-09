# qm (yc-software/qm) 소스 분석 — momo/oort 편입 판단 재료

- 작성: 2026-08-02 · 상태: 조사 보고 (결정 아님, ADR 아님)
- 대상: `https://github.com/yc-software/qm` @ `7f2c916` (2026-07-31), MIT
- 방법: 얕은 클론 후 **읽기 전용 분석**. `npm install`·서버 기동·스크립트 실행 일절 없음. 우리 레포는 읽기만 함.
- 대조 기준: `docs/architecture/overview.md`, `docs/adr/0004·0101·0113·0125·0132·0140·0142·0145·0147`, `schema_v0.sql`, 엔진 워크트리 `server-rust/`

---

## ① 요지

qm은 **"조직 1개 = 프로세스 1개"로 도는 단일 에이전트 런타임**이다. 사람·채널마다 `scope`를 만들어 그 scope별로 샌드박스(도커 컨테이너/마이크로VM)·파일·메모리·키체인·크론을 갈라주고, Pi·Codex·Claude·OpenCode 네 harness를 한 인터페이스 뒤에서 갈아끼운다. 코드는 진짜다 — 소스 75k LOC에 테스트 90k LOC(3,347 케이스, assert 13,728개), CI 10잡(샤딩·실 Postgres·프로덕션 이미지 부팅 스모크·knip 데드코드·`--deny-warnings`), 소스트리 전체에 `@ts-ignore`·`eslint-disable` 0건. 데모웨어가 아니다. **그러나 momo와 겹치는 축에서는 우리가 더 나아가 있다**: qm에는 Postgres RLS가 한 줄도 없고(테넌시는 앱 레벨 `scope_id` 술어), 에이전트 정체성은 Slack 봇 1개이며(우리 불변식 ⑤ = 에이전트가 1급 member와 정면 배치), provider API 키가 서버 env/DB에 상주한다(우리 ADR-0004와 배치). 반대로 **우리에게 없고 qm에 있는 것은 "여러 사람이 있는 방에서 에이전트가 무엇을 봐도 되는가"를 데이터 구조로 푼 audience-floor 모델**이며, 이건 우리 Context Packet 조립(`bins/momo-agent-worker/src/context.rs:11-15`, 미구현)이 곧 답해야 하는 바로 그 질문이다. **권고는 C안(조각 차용) — 딱 3조각만.** A안·B안은 기각하고, "메신저·에이전트 멤버십 축에서는 D안이 맞다"는 것을 명시적으로 인정한다.

---

## ② qm이 실제로 하는 일 (코드 근거)

### 2.1 구조 지도

| 영역 | 위치 | 규모 |
|---|---|---|
| headless core | `src/` (52개 하위 디렉터리) | 348 파일 / 75,115 LOC |
| 표면 플러그인 | `plugins/{web-ui,admin,portal,auth,chassis,onboarding}` | 203 파일 / 33,503 LOC |
| Slack 표면 | **`src/slack/`** (플러그인이 아니라 core 내부) | 34 파일 / 6,994 LOC |
| 배포 CLI | `cli/` (`@yc-software/qm`) | 109 파일 / 32,623 LOC |
| 테스트 | `test/` | 401 파일 / 90,262 LOC |

핵심 모듈: `core/orchestrator.ts`(2,841줄, 한 턴의 전체 파이프라인) · `harness/`(9,945줄, 어댑터 4종) · `runs/`(런 큐·리스·리퍼) · `sandbox/`(백엔드 3종 + 라우터) · `resolution/`(scope→정책 해석) · `sessions/`(대화 저장) · `cron/`(pg-boss 스케줄러) · `acl/`·`policy/`·`security/`.

### 2.2 scope 모델 — "격리"의 실체는 3층이고 층마다 강도가 다르다

scope는 `${kind}:${ref}` 문자열이고 kind는 5종(`personal|channel|team|org|group`, `src/types.ts:12`). 대화 하나가 들어오면 `scopeFor()`가 DM→`personal:<사람>`, 채널→`channel:<채널>`로 찍고(`src/resolution/resolution-service.ts:18-23`), 그 scope가 레이어·시스템 프롬프트·명령 정책·보안 자세·egress·ACL 핸들을 한꺼번에 결정한다(`resolution-service.ts:27-98`).

실제 격리는 이렇게 갈린다.

1. **DB — 격리 없음(앱 레벨 술어만).** `grep -rn "ROW LEVEL SECURITY\|CREATE POLICY\|current_setting" src/` → **0건**. `org_id` 컬럼도 없다. 조직 식별자는 프로세스 env 하나(`src/config.ts:375` `process.env.ORG_ID`)이므로 **배포 1개 = 조직 1개**다. 크로스-scope 차단은 전부 애플리케이션 코드가 `scope_id`/`scope_label`을 붙여서 거르는 방식.
2. **파일(core 호스트) — 디렉터리 분리 + 경로탈출 가드.** `createLocalWorkspaceStore`가 `workspaces/<scopeStorageKey>` 밑에 쓰고 `safeJoin`이 `..` 탈출을 막는다(`src/workspace/workspace-store.ts:16-23, 26-33`). 구현체는 이것 **하나뿐**이고 로컬 디스크다(`src/wiring.ts:533`). `deploy/core/fly.toml`에 `[[mounts]]`가 없다.
3. **샌드박스 — 여기만 진짜 OS 경계.** 백엔드 3종:
   - `local-docker`: scope마다 컨테이너 1개 + named volume 1개, 안에 exec 데몬이 `127.0.0.1:랜덤포트`로 대기(`src/sandbox/local-sandbox.ts:243-286, 318-322`). egress 강제 `none`.
   - `sprites`(Fly): `egressEnforcement: "domain"` — egress 프록시 URL이 있을 때만(`src/sandbox/sprites-sandbox.ts:304-308`).
   - `aws-microvm`: `writablePersistence: "snapshot_to_workspace"`, S3 스냅샷(`src/sandbox/aws-sandbox.ts:304-307`).
   
   scope마다 백엔드를 다르게 라우팅하고 이관 시 잃는 능력을 기록한다(`src/sandbox/sandbox-routing.ts:36-66`, `sandbox.ts:207-215` `capabilitiesLostMovingTo`). 읽기전용 레이어(org `global`, `team-*`)는 매 턴 core 쪽 파일을 tar로 말아 넣되 SHA-256 매니페스트가 같으면 건너뛴다(`src/sandbox/ro-layers.ts:23-66`).

**우리 RLS 테넌시와의 개념 차이**: momo는 `workspace_id` 하나로 22개 테이블에 `FORCE ROW LEVEL SECURITY` + `ws_isolation` 정책을 걸고, GUC 설정 지점을 `momo-db/src/tenant.rs:28,53` 한 곳으로 묶었다(`schema_v0.sql:385-400, 551-567`). qm의 scope는 **테넌트 경계가 아니라 "이 턴이 어떤 컴퓨터·어떤 파일·어떤 정책으로 도는가"라는 실행 컨텍스트**다. 둘은 경쟁 관계가 아니라 **직교**한다 — 우리에게 qm식 scope가 있었다면 그것은 workspace 안쪽의 하위 개념이 됐을 것이다.

### 2.3 agent loop — 한 턴을 구동하는 것

`runs` 테이블 + 리스 기반 워커다(`src/runs/postgres-run-store.ts:47-77`).

```sql
CREATE TABLE runs(id, session_id, status, request, result,
  idempotency_key TEXT UNIQUE,           -- 멱등
  attempts INT, error_attempts INT, max_attempts INT DEFAULT 3,
  lease_token, lease_expires_at, worker_id, ...)
CREATE UNIQUE INDEX idx_runs_one_running_per_session ON runs(session_id) WHERE status='running'
```

- **멱등**: `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`, 0행이면 기존 런을 되읽어 `deduped: true` 반환(`postgres-run-store.ts:127-138`).
- **클레임**: `UPDATE ... WHERE id = (SELECT id ... FOR UPDATE SKIP LOCKED LIMIT 1)` + 세션당 running 배제 술어(`:144-153`).
- **중복실행 방지**: 위 **부분 유니크 인덱스**가 "세션당 running 1개"를 DB 불변식으로 못 박는다. 술어가 새더라도 인덱스가 잡는다.
- **재시도/크래시루프**: `attempts`(클레임 횟수)와 `error_attempts`(진짜 실패 횟수)를 **분리**한다. 에러 없이 클레임만 반복되면 `"run parked after N claims without completing (suspected crash loop)"`로 파킹한다(`postgres-run-store.ts:94-121`, `run-store.ts:94-96`).
- **리스 하트비트**: 워커가 TTL/3 간격으로 뛰고, 연속 3회 실패하면 자기 턴을 `AbortController`로 자른다(`src/runs/worker.ts:29-51`, `LEASE_LOST_CONSECUTIVE = 3`).
- **대화 로그 순서**: 세션 엔트리의 `seq`는 `SELECT COALESCE(MAX(seq),-1)+1 ... WHERE session_id=$1` → INSERT, **`session_leases` 행을 `FOR UPDATE`로 잠근 트랜잭션 안에서만** 수행된다(`src/sessions/postgres-session-store.ts:247-258, 380-419`). PK는 `(session_id, seq)`.
- **스케줄**: 크론은 pg-boss(Postgres 큐, MIT) + 리더 리스 + 멱등 스토어(`src/cron/job-queue.ts:28-78`, `src/cron/scheduler.ts:19`).

**우리 `agent_job`/run 상태기계와 대조**: 개념은 같고, 강제 지점이 다르다. 우리는 `outbox`의 `agent_job` kind + `FOR UPDATE OF o SKIP LOCKED` + `NOT EXISTS(... processing ...)` + `row_number()=1` **술어 3개**로 파티션당 1건을 보장한다(`crates/momo-outbox/src/agent_job.rs:138-200`). qm은 같은 성질을 **부분 유니크 인덱스 1개**로 얻는다. 그리고 우리에게 없는 축이 `attempts` vs `error_attempts` 분리다 — 우리는 `attempts`만 올려서 크래시 루프와 진짜 실패를 구분하지 못한다. 반대로 우리가 더 나아간 축은 상태기계 자체다(qm은 `pending|running|done|failed` 4개, 우리는 `awaiting_approval|paused` 포함 8개 + 승인 보류를 리스 검사보다 **먼저** 판정, `crates/momo-agent/src/run.rs:26-92`).

### 2.4 harness 추상화 — README 주장은 사실이나, 값어치는 어댑터가 아니라 profile에 있다

인터페이스는 `src/harness/harness.ts:167-172`, 딱 4필드다.

```ts
export interface Harness {
  profile: HarnessAdapterProfile;   // 능력 선언
  turns:   HarnessTurnController;   // runTurn / close / resetSession
  models:  HarnessModelUtilities;   // shouldRespond, compactHistory, judge, screenSecurity, generateTitle ...
  tools:   HarnessToolPresentation; // coreName -> 어댑터별 표기명
}
```

profile이 **능력을 명시적으로 선언**한다(`harness.ts:151-161`):

| 어댑터 | controlTransport | toolTransport | capabilities | 구현 LOC | 테스트 파일 |
|---|---|---|---|---|---|
| `pi` | in-process | in-process | abort·steer·images·thinking-level·fast-mode·provider-sessions (6/6) | 2,047 | 20 |
| `claude` | sdk | in-process-mcp | provider-sessions **없음** (5/6) | 926 | 2 |
| `codex` | json-rpc | dynamic | thinking-level·fast-mode **없음** (4/6) | 942 | 1 |
| `opencode` | http | plugin | thinking-level·fast-mode **없음** (4/6) | 1,120 | 2 |

라우터는 scope별 승인 harness 목록·모델 지원 여부를 검사하고, **세션 도중 어댑터가 바뀌면 양쪽 provider 세션 상태를 리셋한다**(`src/harness/harness-router.ts:99-104`). 코어 도구 표면은 12개로 고정이다 — `execute · read · write · publish · memory · history · background · cron · guidance · share · stay_silent · finish_silently`(`src/harness/pi-tools.ts:617-2355`).

**자격증명이 어디 사는가 (ADR-0004 대조, 중요)**:
- **모델 provider 키는 qm 서버가 보유한다.** env(`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`OPENROUTER_API_KEY`, `src/config.ts:727-729`) 또는 관리자가 UI로 넣어 DB에 암호화 저장(`src/model/model-credential-store.ts:47-58`, `encryptSecret` + `deriveConnectorKey`). 조직 단위 1세트이며 사용자별 BYOK 개념이 없다. **momo ADR-0004(provider 자격증명 비유입)와 정면 배치.**
- 하위 harness에는 프로세스 env로 흘려보낸다(`src/harness/claude-harness.ts:103-118` `CLAUDE_ENV_PASSTHROUGH`에 `ANTHROPIC_API_KEY`·`CLAUDE_CODE_OAUTH_TOKEN` 포함; `codex-harness.ts:202-205`는 `auth.json`에 `{"auth_mode":"apikey","OPENAI_API_KEY":...}`를 쓴다).
- 서드파티 서비스 자격증명(=우리 ADR-0113 영역)은 별도 **keychain**이고, 여기에는 우리가 참고할 만한 설계가 있다: `delivery: "broker" | "env"`. broker 모드면 샌드박스는 비밀을 보지 못하고, capability 토큰으로 core의 브로커 엔드포인트를 호출해 core가 `Authorization` 헤더를 주입해 대신 나간다(`src/api/credential-broker.ts:60-66`, `src/credentials/keychain.ts:21-32`). 다만 비밀 자체는 qm DB에 있다 — ADR-0113 D1-A("agent host가 MCP 클라이언트, momo는 벤더 토큰을 보관하지 않음")와는 다른 선택지(=우리가 v1에서 기각한 Option B)에 해당한다.

### 2.5 Slack 플러그인 — 어댑터 경계가 두 개고, 품질이 다르다

- **HTTP 플러그인 경계(web-ui/admin/portal/auth): 깨끗하다.** 공용 `plugins/chassis`가 HMAC 서명(`v0=HMAC-SHA256(secret,"v0:${ts}:${canonical}")`, `plugins/chassis/src/source-auth-sign.ts:3-9`)을 만들고, core가 5분 리플레이 윈도우 + 상수시간 비교 + nonce dedupe로 검증한다(`src/auth/source-auth.ts:36-73`). 최종 사용자 신원은 별도 헤더 `x-portal-identity`로 실려온다. 플러그인은 core를 **런타임 import하지 않는다**(런타임 import 0건, 테스트의 타입 전용 1건 예외).
- **메시징 표면 경계: 깨끗하지 않다.** Slack은 `plugins/`가 아니라 `src/slack/`에 in-process로 살고, core 서비스 9개를 감싼 26메서드 전용 facade `SlackCoreClient`를 통해 직접 호출한다(`src/api/slack-core-client.ts:52-79, 153-155`). `src/` 중 `slack/`·`surfaces/`를 뺀 곳에서 "slack" 문자열이 **54개 파일 323줄**에 남아 있다. 구조적 누수 예:
  - `src/index.ts:113-132` — 표면 레지스트리가 없어 새 in-process 표면은 엔트리를 고쳐야 한다.
  - `src/config.ts:13,683` — **core config가 플러그인을 import한다**(의존 방향 역전).
  - `src/core/orchestrator.ts:774, 2084` — `input.surface ?? "slack"`이 도구 이름 기본값.
  - `src/api/routes/context.ts:193` — 공개 HTTP 라우트가 `source`를 `"slack"`으로 기본 처리하고 `dest.type !== "slack"`을 거부.
  - `src/types.ts:252` `slackApiMs`, `src/directory/*` `slackId`(+ core가 `/^[UW][A-Z0-9]{8,}$/` 정규식 소유) — 범용 계약에 Slack 명사가 박혀 있다.

  즉 **HTTP 표면으로서 제3의 메신저를 붙이는 것은 기계적으로 가능**하다(`/v1/turns` + `/v1/deliveries` + `/v1/surface-context` 루프는 표면 중립이고 `surface`는 자유 문자열). 그러나 Slack과 동급의 대우(설치 관리·in-process 감독)를 원하면 `index.ts`·`config.ts`·`wiring.ts`·`api/deps.ts`를 고쳐야 하고, Slack 어투가 박힌 프롬프트(`src/resolution/protocols/mode-*.md`)와 도구 설명(`pi-tools.ts:1381-1489`)을 물려받는다.

### 2.6 DB 스키마 — 마이그레이션 파일이 없다

`.sql` 파일 **0개**. 38개 `CREATE TABLE IF NOT EXISTS`가 각 스토어 TS 파일 안에 문자열 배열로 있고 부팅 시 순차 실행된다. 여기에는 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`뿐 아니라 **파괴적 데이터 마이그레이션도 인라인으로 섞여 있다** — 예: `src/sessions/postgres-session-store.ts:234-238`은 특정 `thread_ref` 패턴의 세션·엔트리·리스·LLM 요청을 부팅 때마다 `DELETE` 한다. 버전 테이블도 롤백도 없다.

- 메시지 순서: §2.3 참조(세션 리스 잠금 + `MAX(seq)+1`).
- 읽음 상태: 전용 read-state 테이블 없음. `participants(session_id, principal_id, valid_from/valid_to, valid_from_seq/valid_to_seq, archived, pinned, ...)`가 "이 사람이 이 세션의 어느 구간을 볼 수 있는가"를 담당한다(`postgres-session-store.ts:177-183`). 미읽음 카운트가 아니라 **가시성 창(window)** 모델이다.
- 멀티테넌시: 없음(§2.2).

**대조**: momo는 59개 버전 마이그레이션 + `schema_v0.sql`이 정본이고, 44/59가 트리거·제약·RLS로 불변식을 DB에 못 박는다(ADR-0145:14). qm은 정반대 축 — 스키마를 코드가 소유하고 불변식은 애플리케이션이 지킨다. **이 차이 때문에 qm 스키마를 우리 쪽으로 들여오는 선택지는 성립하지 않는다.**

### 2.7 권한/승인 — 있고, 조합 규칙이 좋다

- **보안 자세 3종**을 org 바닥값에서 하위 scope가 "조이기만" 가능하도록 합성한다(`src/security/security-posture.ts:36-39` `composeSecurityPosture`, 랭크 `dangerous(0) < auto(1) < strict(2)`).
- **명령 정책**은 org floor 규칙(재귀 삭제·force push·`DROP/TRUNCATE TABLE`·`curl | sh` → `require_approval`, `mkfs`/fork bomb → `deny`)에 scope 규칙을 **덧붙이는** 방식으로만 합성된다(`src/policy/command-policy.ts:5-31`). 셸 난독화 대응이 진지하다 — heredoc 제거·따옴표 해제·`$(...)`/백틱 내부 재귀 스캔을 깊이 8까지 수행한다(`command-policy.ts:66-88`).
- **HiLO 승인**: 승인 대기는 `PendingApprovalRecord`로 남고 라우트가 열려 있다(`GET /v1/approvals/pending`, `GET /v1/approvals/:id`, `GET /v1/sessions/:id/approvals`, `src/api/routes/turns.ts:156-157`, `surface.ts:1126`). Slack에서는 버튼(`hilo_*`), "세션 동안 허용/항상 허용" 표준 승인 모드가 있고 org가 이를 끄면 기존 승인도 정지한다(`src/api/routes/admin-resources.ts:109-120`).
- **사람↔사람 위임**: 공유 채널의 에이전트가 B의 **개인 scope** 에이전트에게 일을 넘기려면 B가 DM에서 승인해야 한다(`src/slack/approvals.ts:790-850`). 이는 우리 A2A(서로 다른 에이전트 member 간 위임)와 다른 것 — qm은 **에이전트가 하나**고 scope만 바뀐다.

### 2.8 성숙도 — 데모웨어가 아니다. 다만 공개 이력은 성숙도 신호가 아니다

| 지표 | 값 |
|---|---|
| 공개 커밋 | 40개 / 2.9일 / 실질 저자 3명 |
| 루트 커밋 | `57b5191` "Fresh repo history" — 스쿼시 export |
| 비공개 이력 증거 | 스쿼시 직후 커밋이 `(#55)` — 공개 전 PR 55건 이상 |
| 테스트 | 392파일 / 90,196 LOC / `test(` 3,347개 / `assert.*` 13,728개 (테스트:소스 ≈ 0.65:1) |
| CI | 10잡 전부 차단형: typecheck, 5-way 샤딩, 실 `postgres:16`, 플러그인 4종 **프로덕션 이미지 부팅 스모크**, knip 데드코드, `oxlint --deny-warnings`, action SHA 핀 |
| TODO/FIXME/HACK | 실질 **0건** / `@ts-ignore`·`@ts-expect-error`·`eslint-disable` **0건** (139k LOC) |
| `as any` | 30건, 전부 `@slack/web-api` 경계 |

주의: **TODO 밀도를 성숙도 지표로 쓰면 안 된다.** `AGENTS.md:18-21`이 "주석 0개" 정책(설명 주석·TODO·린트 억제 전면 금지)을 강제하므로 낮게 나오는 게 당연하다. 진짜 신호는 테스트 내용이다 — `test/orchestrator.test.ts`(3,051줄)의 케이스 이름이 `"a setup-phase failure after the lease is acquired does NOT wedge the thread"`, `"a retried run RESUMES the interrupted turn from the durable ledger instead of restarting it"` 식으로 실패·경합 경로를 겨눈다. 반면 **루트 e2e(`test/e2e/`)와 18개 시나리오 라이브-Slack 인수 테스트(`test/live-slack/`)는 공개 CI 트리거가 없다** — 해당 워크플로가 비공개 레포에 남았다.

판정: **months 규모의 실제 운영 코드 + 3일짜리 공개 표면.**

### 2.9 라이선스·의존성 위생 — 통과

- 본체 MIT 확인(`LICENSE`, "Copyright (c) 2026 QM contributors"), `package.json:5` `"license": "MIT"`.
- 락파일 6개 전수 조사: **AGPL/GPL/LGPL/SSPL/BUSL 0건.** 루트 576패키지 분포 = MIT 414 / Apache-2.0 85 / ISC 21 / BSD-3 20 / BSD-2 7 / BlueOak 5. `plugins/web-ui`의 듀얼 2건(`dompurify` MPL-2.0 OR Apache-2.0, `jszip` MIT OR GPL-3.0-or-later)은 각각 permissive 쪽 선택 가능. **AGPL 백본 금지 조건 충족.**
- 검토가 필요한 항목 2개:
  1. `@anthropic-ai/claude-agent-sdk` 외 9개 플랫폼 바이너리가 SPDX가 아닌 `SEE LICENSE IN README.md`(Anthropic 자체 약관). copyleft 문제는 아니고 재배포 약관 문제.
  2. **`@earendil-works/pi-coding-agent`가 npm 레지스트리가 아니라 GitHub 릴리스 tarball에서 온다** — `https://github.com/yc-software/pi/releases/download/qm-pi-coding-agent-0.82.0-security.2/...`. 기본 harness의 런타임 의존성인데, `SECURITY.md`가 공급망 통제로 내세우는 `.npmrc`의 `min-release-age=7`은 레지스트리 설치만 게이팅하므로 **이 경로에는 적용되지 않는다**(락파일 integrity 해시는 있음). `plugins/web-ui`의 `xlsx@0.20.3`도 `cdn.sheetjs.com`에서 온다.

### 2.10 README가 주장하는 것 vs 코드가 하는 것 — 차이 목록

이 리서치의 핵심 산출이므로 전부 적는다.

| # | 주장 | 코드 | 판정 |
|---|---|---|---|
| 1 | README: "`.env.example` — every knob, documented in place" | 25줄 / 445바이트 / 변수 ~17개, 설명 주석 0개. 실제 코드가 읽는 `process.env.*`는 **133개** | **거짓** |
| 2 | README: "`plugins/` — the surfaces (**Slack**, web UI, admin, portal)" | `plugins/`에 `slack` 없음. Slack은 `src/slack/`에 in-process. 같은 README의 Architecture 절은 반대로 정확히 서술 | **자기모순** |
| 3 | README 보안: "an org picks one security posture, which narrower scopes can only **tighten**" + 랭크 `dangerous<auto<strict` | `strict: { inboundScreening: "off", toolApprovals: "all" }`(`src/security/security-posture.ts:17`). **auto→strict로 "조이면" 프롬프트 인젝션 스크리너가 꺼진다.** 도구 승인과 내용 검사를 맞바꾸는 구조이지 단조 강화가 아니다 | **오해 유발 — 실무상 가장 위험한 항목** |
| 4 | README: Pi·OpenCode·Codex·Claude Code가 "same core"를 구동 | 사실. 단 능력이 어댑터마다 다르고(profile에 선언), 테스트는 pi 20파일 vs codex 1 / opencode 2 / claude 2, 출하 배포 설정은 전부 `HARNESS=pi`(`deploy/core/fly.toml`). `SECURITY.md`도 "the OpenCode adapter currently supplies its provider key to the supervised sidecar"를 자백 | **사실이나 비대칭** |
| 5 | `src/slack/README.md:66-68`: 파일 바이트가 HTTP(`POST /v1/blobs`)로 이동 | `src/api/slack-core-client.ts:127-146`이 `blobTransfer.put/open`을 in-process 호출 | **문서 드리프트** |
| 6 | README: "Each person and each room has its own **isolated** workspace" | DB RLS 0건, 격리는 앱 레벨 술어 + 디렉터리 + (진짜 경계는) 샌드박스뿐. 단 `SECURITY.md`는 "QM is not a hardened public or multi-tenant service boundary"라고 정확히 적음 | **README↔SECURITY.md 드리프트** |
| 7 | README: "Every substrate (harness, session store, sandbox, memory) sits behind an interface" | 문자 그대로는 사실. 단 목록에 **workspace가 빠져 있고**, `WorkspaceStore`는 구현이 로컬 디스크 하나뿐(`wiring.ts:533`)이며 `deploy/core/fly.toml`에 `[[mounts]]`가 없다 | **정확하나 운영 제약 은폐** |
| 8 | README: "`docs/getting-started.md` — first run, end to end" | 해당 문서의 H1은 "Deploy QM for an organization". 로컬 첫 실행 워크스루는 레포 어디에도 없음. `deployment.md`는 9줄 스텁 | **거짓** |
| 9 | `CONTRIBUTING.md`: 기여는 `adrs/`에 산문으로 | `adrs/`에 `.gitkeep` 뿐. 채널 미검증 | 신규 레포 정상 |

반대로 **SECURITY.md는 이례적으로 정직하다.** "Command policy is bypassable", "Sandbox credentials are plaintext while in use", "Audience-floor filtering has known gaps", "secret scanning on file write is not implemented" 등 12개 한계를 명시하고, 표본 검증한 4건 모두 코드와 일치했다(예: "ambient judge가 ModelGateway를 안 쓴다" → `src/wiring.ts:1080`이 `harness.models.judge`로 직결, 확인). **README를 믿지 말고 SECURITY.md를 믿어야 하는 레포다.**

---

## ③ momo와의 겹침·차이

| 축 | momo/oort | qm | 판정 |
|---|---|---|---|
| 멀티테넌시 | `workspace_id` + **RLS FORCE** 22테이블, GUC 단일 시임(`schema_v0.sql:385-400`, `momo-db/src/tenant.rs:28`) | RLS 0건. `ORG_ID` env 하나 = 프로세스당 조직 1개(`src/config.ts:375`) | **momo 압도** |
| 에이전트 정체성 | 에이전트 = 1급 `member`. 사람/에이전트 무분기 REST, per-agent `agent_bearer` + 스코프(ADR-0101) | Slack 봇 유저 1개. `botUserId` 단일. 다중 에이전트 개념 없음 | **momo 압도 (불변식 ⑤)** |
| A2A | 실제 에이전트 간 위임. G1(동시성)·G2(연속발화 3)·G3(step 12)·depth(≤4, DB CHECK)·체인 예산(20만 토큰/$5) 5게이트(`crates/momo-agent/src/a2a.rs:343-399`) | 없음. "agent-to-agent"는 같은 에이전트가 타인의 personal scope에서 도는 것 + 본인 DM 승인(`src/slack/approvals.ts:790-850`) | **momo 압도** |
| provider 자격증명 | ADR-0004: 서버 비유입. 0147은 `provider_link` 봉인 + operator-local 취득, 내부 도그푸드 한정 | env 또는 관리자 입력 → DB 암호화. 조직 1세트. 하위 harness에 env로 전달 | **정면 배치 — 어떤 안이든 여기서 갈린다** |
| 메시지 순서 | 채널별 gapless `message.seq`, `channel_seq` 행 잠금 → INSERT를 **단일 SQL**로, `UNIQUE(channel_id,seq)` 백스톱(`crates/momo-messaging/src/message.rs:360-374`) | 세션별 gapless `seq`, **세션 리스 행 `FOR UPDATE`** 트랜잭션 안에서 `MAX+1`, PK `(session_id,seq)` | 같은 사상, momo 쪽이 조밀 |
| 런 상태기계 | 8상태, 승인보류를 리스검사보다 선판정, `cancelled`는 사람 행위만(`run.rs:26-92, 681-692`) | 4상태(`pending/running/done/failed`) | **momo 압도** |
| 런 큐 하드닝 | 술어 3개로 파티션당 1건(`agent_job.rs:138-200`), 리스 300초 | **부분 유니크 인덱스**로 세션당 running 1건 + **`attempts` vs `error_attempts` 분리**(크래시루프 파킹) | **qm 우위 2점 (작지만 실질)** |
| 스케줄러 | **없음.** `agent_profile.triggers.schedule`는 예약 데이터, 실행기 없음(`036_agent_profile.sql:52`) | pg-boss + 리더 리스 + 멱등 + 크론 도구(`src/cron/`) | **qm 우위** |
| 도구 호출 / 승인 게이트 | Rust 워커에 **미구현**(`bins/momo-agent-worker/src/lib.rs:70-76`). 승인 라우트 미이식 | 12개 고정 도구 + HiLO 3자세 + 명령정책 난독화 대응 | **qm 우위** |
| Context Packet | **미완**(`bins/momo-agent-worker/src/context.rs:11-15`) | `scope_label` 라벨링 + audience-floor 필터 + egress 교집합(`resolution/context-filter.ts:18-28`, `audience-floor.ts:39-49`) | **qm 우위 — 가장 값진 격차** |
| 원격 실행/샌드박스 | T3: BYOC + mock 어댑터만(`crates/momo-t3/src/provider/`), **workd는 여전히 Swift 미이식**(B5 미착수). 3층 L-base/L-cred/L-session은 ADR-0125 설계 | 3백엔드 실동작(docker / Fly sprites / AWS microVM) + scope별 라우팅 + 이관 시 능력손실 기록 | **qm 우위 (구현 진척 기준)** |
| 과금 | `usage_ledger` + `work_host_usage_interval` GENERATED + 단일 정산 프리미티브 | 사용자별 예산 상한 체크만(`src/ratelimit/budget.ts`), 원장 없음 | **momo 압도** |
| 스키마 거버넌스 | 59개 버전 마이그레이션, 44/59가 DB 강제 | `.sql` 0개, 부팅 시 인라인 DDL + 인라인 파괴적 DELETE | **momo 압도** |
| 표면 플러그인 경계 | ADR-0113 미이식 | HTTP 표면은 깨끗(chassis HMAC), 메시징 표면은 54파일 누수 | 절반씩 |
| 메모리 | 마이그레이션 027/028 존재, **Rust 소유자 없음** | scope별 `MEMORY.md` + 리비전 CAS + 4전략(`src/memory/`) | qm 우위(단, 단순 파일 모델) |

---

## ④ 가장 값진 조각 top 3

### 1. audience-floor 컨텍스트 해석 — `src/resolution/context-filter.ts` + `audience-floor.ts` + `scope_label` 컬럼

세 조각이 한 세트다. ①모든 세션 엔트리가 자기가 온 scope를 `scope_label`로 들고 다닌다(`session_entries.scope_label NOT NULL`, `postgres-session-store.ts:172-176`). ②공유 대화에서 모델에게 히스토리를 줄 때 **청중 전원이 자격 있는 행만** 통과시킨다(`context-filter.ts:18-28`, `audience.every(...)`). ③egress 허용 호스트는 청중 전원의 **교집합**, 거부 호스트는 **합집합**(`audience-floor.ts:39-59`).

**왜 값어치가 있나**: momo는 에이전트를 채널 `member`로 두기로 이미 결정했다. 그 결정의 필연적 귀결이 "5명 있는 채널에서 에이전트가 A의 개인 컨텍스트를 참조해 답하면 B가 그걸 읽는다"는 문제다. 우리 Context Packet 조립은 아직 비어 있고(`context.rs:11-15`), 이 질문을 코드로 답한 적이 없다. qm의 답은 **90줄 남짓**이고 개념적으로 우리 RLS 위에 그대로 얹힌다 — `message`/`agent_run` 산출물에 출처 scope 라벨을 붙이고, 패킷 조립 시 채널 membership 전원 교집합으로 거른다. 게다가 **qm 자신이 이 모델의 구멍을 SECURITY.md에 적어놨다**("Model-context entries do not yet carry complete origin labels for every granted read, so mixed-permission filtering is incomplete"). 우리는 그 실패를 처음부터 피해서 설계할 수 있다 — 라벨을 옵션이 아니라 NOT NULL 컬럼 + 삽입 경로 단일화로 강제하면 된다.

### 2. 런 큐의 두 가지 하드닝 — 부분 유니크 인덱스 + `attempts`/`error_attempts` 분리

`CREATE UNIQUE INDEX ... ON runs(session_id) WHERE status='running'`(`postgres-run-store.ts:71`)과 `errorParks()`(`run-store.ts:94-96`).

**왜**: 우리 `claim_agent_job`은 같은 성질을 SELECT 술어 3개로 얻는다. 술어는 쿼리를 고치면 새지만 부분 유니크 인덱스는 안 샌다 — 우리 ADR-0145가 말한 "불변식은 앱이 아니라 DB에 산다"와 정확히 같은 철학이고, 우리는 정작 이 지점에서만 술어에 의존하고 있다. `error_attempts` 분리는 더 작고 더 즉각적이다: 지금 우리는 워커가 세그폴트로 죽어 리스가 만료돼 재클레임되는 경우와 provider가 500을 뱉은 경우를 `attempts` 하나로 뭉쳐서 `max_attempts`를 소모한다. 두 컬럼으로 나누면 "완주 못 하고 N번 클레임된 잡"을 **재시도 소진 없이** 파킹할 수 있다. 마이그레이션 2줄 + 정산 로직 소폭 수정 수준이다.

### 3. harness adapter profile — `src/harness/harness.ts:151-172` + `harness-router.ts:99-104`

어댑터를 4개 베끼자는 게 아니다(각 900~2,000줄, 대부분 남의 CLI/SDK 통역). 가져올 것은 **모양**이다: 어댑터가 자기 능력을 `capabilities: ReadonlySet<"abort"|"steer"|"images"|"thinking-level"|"fast-mode"|"provider-sessions">`로 **선언**하고, 라우터가 세션 중 어댑터 교체 시 양쪽 provider 세션을 리셋한다.

**왜 지금인가**: ADR-0147이 이미 우리 워커를 갈랐다 — ChatGPT 구독 OAuth는 Responses API(`bins/momo-agent-worker/src/responses.rs`), API 키는 chat/completions. 여기에 툴콜·스트리밍(`agent.partial`)·T3 코딩 에이전트(ACP)가 더 붙으면 `if provider == "openai"` 분기가 워커 전역에 번진다. 능력 선언 인터페이스를 **분기가 3개일 때** 넣는 것이 20개일 때 넣는 것보다 싸다. 설계 100~150줄 수준의 일이고, 우리 `ProviderAdapter`에 `capabilities` 필드를 추가하는 형태가 된다. ADR-0142가 T3 어댑터에 이미 같은 사상을 적용해뒀다(`supports_pause`, `resume_semantics`, "policy code may not know provider constants") — 그 패턴을 provider/harness 축으로 확장하는 것이므로 새 개념도 아니다.

**아깝지만 top 3에 못 든 것**: 보안 자세의 tighten-only 합성(`composeSecurityPosture`), 명령 정책의 셸 난독화 해제(`scannableCommand`, heredoc/따옴표/`$()` 깊이 8 재귀), 플러그인 HMAC 서명 스킴(`source-auth-sign.ts` — 우리 ADR-0113 이식 때 참고 가치 높음), 샌드박스 백엔드 라우터의 `capabilitiesLostMovingTo`(T3 provider 이관 설계에 그대로 대응).

---

## ⑤ A/B/C/D 평가와 권고

### A안 — 사용자가 초대하는 에이전트로 편입 (qm을 별도 구동, 우리 워크스페이스에 `member`로 참여)

- **필요 작업**: qm에 momo 표면 플러그인 신규 작성(chassis 위 HTTP 플러그인; Slack 표면이 6,994 LOC인 것을 감안하면 축소해도 2~4k LOC) + momo 디렉터리↔qm `Principal`/`teamIds` 동기화 + 우리 쪽 `agent_bearer` 발급·A2A 게이트 연결 + 워크스페이스마다 qm 프로세스 1개(`ORG_ID` 단일 제약) 프로비저닝·운영.
- **불변식 충돌**: ⑤(에이전트=member)는 **형식적으로는 만족**한다 — qm은 우리 눈에 `agent` 한 명이고 REST/A2A/승인 인박스를 그대로 탄다. 그러나 qm은 내부에 **자기 scope 디렉터리(사람·채널)를 다시 갖는 그림자 신원 체계**를 요구한다. 더 나쁜 건 신뢰 방향이다 — qm의 `/v1/turns`는 **호출자가 `actor`를 body로 주장**하고 core는 HMAC만 검증한다(`src/api/routes/turns.ts:7-9, 31-41`). 즉 우리가 qm에게 "이 턴의 사람은 누구다"를 선언하는 관계가 되고, qm의 개인 scope 격리는 우리 선언의 정확성에 종속된다. ⑦(ADR-0004)은 **누가 qm을 운영하느냐로 갈린다**: 사용자가 자기 인프라에서 qm을 돌리면(=ADR-0142 BYOC 형태) provider 키가 우리 서버에 안 들어오므로 합치, 우리가 매니지드로 돌리면 정면 위반.
- **얻는 것**: 컨테이너/마이크로VM 샌드박스에서 도는 셸 에이전트 1종 + 크론 + 스킬.
- **잃는 것**: 그림자 신원 체계 유지비, 워크스페이스당 프로세스+DB 운영, 우리 승인/과금과 이중 계상되는 qm 내부 승인·예산, "우리 제품 안에 남의 제품이 통째로 들어앉는" 제품 경계 훼손.
- **되돌릴 수 있나**: 예(별도 프로세스, 우리 스키마 무변경).
- **판정: 기각.** 얻는 것이 우리가 T3/workd로 이미 가는 방향과 겹치는데, 그 대가로 신원·승인·과금 축이 전부 이중화된다. "게이트웨이가 잘 되어 있으니 아무거나 붙일 수 있다"는 것이 "아무거나 붙여야 한다"는 뜻은 아니다.

### B안 — 우리가 별도 구동해 백엔드로 사용

- **필요 작업**: qm core를 실행 런타임으로 세우고 우리 서버가 `/v1/turns`를 호출, 결과를 우리 메시지 척추에 기록.
- **불변식 충돌**: **①(Postgres=단일 SoT) 정면 위반**이다. qm은 라이브러리가 아니라 자기 Postgres 38테이블·자기 런 상태기계·자기 세션 로그·자기 신원을 가진 완제품이다. 붙이는 순간 SoT가 둘이 되고, `runs`(qm)와 `agent_run`(우리)이 같은 사실을 두 곳에 쓴다. ③(단일 쓰기경로)도 깨진다 — qm의 답변이 우리 outbox를 거치지 않고 태어나 사후에 복사된다. ⑦은 우리가 운영하는 이상 위반.
- **T3/workd와의 관계**: **보완이 아니라 대체 경쟁**이다. 역할이 정확히 겹친다(scope별 durable 샌드박스, 프로세스 세션, 파일 스테이징, egress 정책). 진척도만 보면 qm이 앞선다(백엔드 3종 실동작 vs 우리 BYOC+mock, workd Swift 미이식). 하지만 qm의 샌드박스는 **qm의 scope 모델에 결박**돼 있다(`sandbox.provision(resolution.layers)` — layers는 `resolution-service.ts`가 만든다). 우리 workspace/member/work_host 모델로 갈아끼우려면 `resolution`을 통째로 대체해야 하는데, 그러면 남는 건 `sandbox/` 3,226줄이고 그건 TypeScript다.
- **과금**: 맞지 않는다. qm에는 원장이 없고 사용자별 윈도 예산 상한만 있다. 우리 `work_host_usage_interval`의 일시정지 중 0-과금 GENERATED 컬럼 같은 구조가 없다.
- **되돌릴 수 있나**: 형식적으로는 예. 실질적으로는 이중 SoT가 몇 달 굴러가면 아니오.
- **판정: 기각.** 불변식 ①·③을 깬다. 하드 룰상 Accepted ADR 없이는 머지 불가이고, 이 경우 그 ADR은 "SoT를 둘로 만든다"를 승인해야 하는데 그건 승인할 수 없는 종류다.

### C안 — 내부 구성요소만 차용 (ADR-0145 B안과 같은 방식)

- **필요 작업**: ④의 3조각 한정. ①audience-floor 라벨링·필터링을 Context Packet 조립 설계에 반영(신규 코드 Rust, 개념 이식) ②`runs` 부분 유니크 인덱스 + `error_attempts` 분리를 `outbox`/`agent_run`에 적용(마이그레이션 소폭) ③provider/harness 능력 선언 인터페이스를 워커에 도입(ADR-0142 어댑터 패턴 확장).
- **불변식 충돌**: **없다.** 세 조각 모두 DB 스키마를 강화하거나(①②) 앱 계층 인터페이스를 정리하는(③) 방향이며, 쓰기 경로·순서·테넌시·자격증명 경계 어느 것도 건드리지 않는다.
- **선례**: ADR-0145가 정확히 이 방법을 승인했다 — "buzz는 fork/의존이 아니라 **코드 레퍼런스로만** 쓴다", 인용 목록을 `docs/planning/2026-07-30-buzz-reference-catalog.md`로 명문화, 선별 차용 1건(provenance 서명)은 별도 ADR-0146으로 분리. qm도 동일 절차를 적용하면 된다: 인용 카탈로그 1건 + (audience-floor는 경계 변경 성격이 있으므로) ADR 1건.
- **얻는 것**: 우리가 지금 설계 중인 Context Packet의 가장 어려운 질문에 검증된 답 1개, 런 큐 하드닝 2개, 어댑터 폭발 예방 1개. MIT이므로 라이선스 마찰 없음(단, 코드 문자열을 그대로 옮기면 저작권 고지 의무 발생 — 개념 이식이면 무관, 카탈로그에 출처를 남길 것).
- **잃는 것**: 조사 시간 이미 소모. 추가 손실 없음.
- **되돌릴 수 있나**: 예. 셋 다 국소적이고, ②는 마이그레이션 되돌리기, ③은 인터페이스 필드 제거로 끝난다.
- **판정: 채택.**

### D안 — 아무것도 안 한다

- **부분적으로 옳다.** 메신저·에이전트 멤버십·테넌시·순서·A2A·과금·자격증명 경계 — 이 7개 축 전부에서 우리가 앞서 있다(③ 표). qm을 "에이전트 네이티브 메신저 경쟁자"로 보고 대응한다면 답은 D다.
- **그러나 전면 D는 틀리다.** ④의 3조각, 특히 audience-floor는 우리가 **아직 안 만든 것**이고, 만들 때 반드시 부딪힐 문제이며, qm은 그걸 만들었고 심지어 실패 지점까지 문서화해놨다. 이걸 안 읽고 처음부터 설계하는 건 낭비다.
- **판정: 축을 나눠서 인정.** 제품·아키텍처 축은 D, 설계 참조 축은 C.

### 권고 — **C안. 조각 3개 한정, 기간 한정.**

1. **audience-floor 모델을 Context Packet 설계에 반영** (가장 중요, 지금 미결정 상태라 반영 비용이 최저). 산출물: ADR 초안 1건 — "에이전트 컨텍스트의 출처 라벨과 청중 하한". 핵심 결정 3개: (a) 에이전트에 들어가는 모든 컨텍스트 행에 출처 scope 라벨을 **NOT NULL로 강제**할 것인가(qm은 옵션으로 두어 구멍이 남았다), (b) 공유 채널에서 라벨 필터는 청중 전원 교집합인가 발화자 기준인가, (c) 툴 egress 허용목록도 같은 하한을 적용할 것인가.
2. **런 큐 하드닝 2건을 티켓으로** — `outbox` 파티션당 1건을 부분 유니크 인덱스로 승격, `attempts`/`error_attempts` 분리. B2 배치에 얹기 적당한 크기.
3. **provider/harness 능력 선언 인터페이스** — ADR-0147로 이미 분기가 생겼으므로, 툴콜 착수 **전에** 넣는다. ADR-0142 어댑터 패턴의 확장이므로 신규 ADR 없이 티켓으로 가능할 수 있음(경계 변경 여부는 판단 필요).
4. **인용 카탈로그 1건** — buzz 선례대로 `docs/planning/`에 `qm-reference-catalog.md`. 무엇을 어디서 봤고 무엇을 안 가져왔는지 남긴다.
5. **A·B는 문서로 기각 기록**하고 재론 금지. 재론 조건은 명시: "qm이 multi-org(RLS 또는 동등물)와 사용자별 BYOK를 도입할 경우에만".

---

## ⑥ 위험 · 미확인 사항

**위험**

1. **`strict` 자세의 스크리너 비활성화**(②-표 #3). 만약 우리가 qm의 3자세 모델을 참고해 승인 정책을 설계한다면 이 함정을 그대로 복제하기 쉽다. 우리 모델에서는 "도구 승인"과 "입력 내용 검사"를 **직교 축 2개**로 두어야 한다.
2. **개념 이식 vs 코드 복사의 경계.** MIT라 복사도 합법이지만 저작권 고지 의무가 붙는다. 3조각 모두 TypeScript→Rust 재작성이므로 실무상 개념 이식이 될 것이나, ADR-0145 선례대로 **인용 카탈로그에 출처를 남기는 절차**를 반드시 밟을 것.
3. **공급망**: qm 자체를 우리 인프라에서 실행할 계획이 없으므로 현재는 무관. 다만 A·B안 재론 시에는 `@earendil-works/pi-coding-agent`의 레지스트리 우회 경로가 차단 사유가 된다.
4. **조사 시점 고착.** 이 레포는 3일 만에 40커밋(하루 13커밋)이 들어왔다. 본 문서의 파일·줄 인용은 `7f2c916` 기준이며 빠르게 낡는다.

**미확인 (실행 금지 제약으로 확인 불가하거나 조사 범위 밖)**

1. **실제 동작 검증 전무.** 서버를 띄우지 않았으므로 "이 코드가 실제로 돈다"는 판단은 전부 **테스트·CI 구성 기반 간접 추론**이다. 특히 AWS microVM / Fly sprites 백엔드는 외부 서비스 의존이라 코드만으로는 동작을 확인할 수 없다(`@fly/sprites`는 버전 `0.0.1`).
2. **오케스트레이터 전체 경로 미독파.** `core/orchestrator.ts` 2,841줄 중 진입부·게이트 순서만 읽었다. 압축(compaction), 재개(turn-resume), 태이프(tape shadow/serve) 모드의 정확한 의미론은 미확인.
3. **`OrchestratorDeps`의 결합도.** 60개 이상 필드를 받는 god object(`src/core/orchestrator/types.ts:88-`). 조각 차용에는 무관하나, 만약 A·B안이 재론된다면 "이 코어를 부분적으로만 쓰는 것"이 불가능하다는 근거가 된다 — 미검증 인상 수준이므로 근거로 쓰려면 추가 확인 필요.
4. **라이브 인수 테스트의 실제 통과 여부.** `test/live-slack/`의 18개 시나리오는 공개 CI에 트리거가 없어 최근 통과 이력을 확인할 수 없다.
5. **momo 쪽 정본 문서 최신성.** `docs/planning/CURRENT_STATE.md`·`JOURNAL.md`가 2026-07-28에 멈춰 있어 Rust 재작성 이후 상태를 반영하지 못한다. 본 문서의 momo 측 서술은 `docs/planning/2026-07-30-rewrite-batch-breakdown.md` + 엔진 워크트리 소스를 1차 근거로 삼았다. **CURRENT_STATE 갱신은 별건으로 필요하다.**
6. **법무 검토 미실시.** Anthropic SDK의 비-SPDX 약관(10패키지)은 재배포 관점 검토 대상이나, 본 조사 범위 밖이며 C안에서는 해당 없음.
