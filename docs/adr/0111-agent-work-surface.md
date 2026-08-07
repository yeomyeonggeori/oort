# ADR-0111: Agent Work Surface — 메신저 안의 업무·터미널·코드 실행

- Status: **Accepted** (2026-07-13, 성재 — **Option A: BYOA 실행** 확정. 착수는 UI W1+Phase A 랜딩 후, MOMO-362..365는 그 시점에 발급)
- 관련: ADR-0102(실행 경로 이중화 — gateway=BYOA), ADR-0004(provider 자격증명 비유입), ADR-0101(per-agent bearer), MOMO-349(승인 왕복)·350(status/partial 스트림)·341(lease), ROADMAP §1.2(Agentic Work OS: "채널 타임라인을 context/approval/cost/audit execution ledger로"), `research/12-agentic-work-os/`(plugin manifest·positioning)
- 제안자 맥락: 성재 제안(2026-07-13) — "메신저 안에서 Codex/Claude처럼 업무(Work)·터미널·코드 작업을, 초대한 에이전트 중 특화 에이전트의 도움으로. Codex 오픈소스 접근 권한을 설계에 적극 포함."

## Context

1. oort의 차별화 문장은 이미 "채널 타임라인 = 실행 원장(execution ledger)"이다(ROADMAP §1.2, MOMO-184). 그러나 현재 사용자가 체감하는 것은 채팅+승인 카드까지다. **"에이전트에게 실제 업무를 시키고, 그 실행 과정 전체가 채널에 남는"** 표면이 없다.
2. 필요한 백엔드 뼈대는 이번 두 배치로 이미 랜딩됐다:
   - 실행 개체: `agent_run` (trigger message, parent/depth 루프가드, idempotency, input/output jsonb)
   - 위험 작업 게이트: 승인 왕복 (`approval_request` → awaiting → resume, MOMO-349)
   - 과정 가시화: status/partial 브로드캐스트 (MOMO-350)
   - 중복 실행 방지: lease claim/takeover (MOMO-341)
   - 실행 위치: ADR-0102 Option C — gateway(BYOA, 에이전트가 자기 호스트에서 실행) / worker(managed)
3. **Codex 오픈소스 자산**: `openai/codex` CLI는 Apache-2.0(permissive — 스택 규칙 부합)이고, 우리는 이미 codex-fleet 파이프라인으로 실전 검증했다: headless `codex exec`, `resume <session-id>` 왕복, sandbox 정책(read-only / workspace-write / network 토글), `--output-last-message` 구조화 출력. **oort가 터미널/실행기를 새로 만들 필요가 없다** — 에이전트 호스트에서 codex CLI가 엔진이 되고, oort는 원장·승인·스트림만 담당하면 된다.
4. 반례 경계: oort 서버가 임의 코드를 실행하게 만들면 RCE 표면 + provider 자격증명 유입(ADR-0004 위반) 위험. 실행은 서버 밖이어야 한다.

## Options

### Option A — BYOA 실행 (권장): 에이전트 호스트에서 실행, oort는 원장·승인·스트림만
- Work run은 `agent_run`의 확장이다(새 실행 개체 금지). gateway 경로의 에이전트(Hermes처럼 자기 머신/컨테이너에서 도는 BYOA)가 실행 주체.
- 터미널/코드 실행 = 에이전트 호스트에서 codex CLI(또는 동급 로컬 러너)가 수행, 명령·diff·결과가 oort 타임라인에 스트림/커밋됨. oort 서버는 어떤 코드도 실행하지 않는다.
- 장점: ADR-0004/보안 경계 그대로, 기존 349/350/341 재사용, 구현 최소. 단점: Work 가능 에이전트는 BYOA 게이트웨이 필요(초대만 하면 되는 managed 에이전트는 v1+).

### Option B — oort 서버측 관리 러너(sandboxed executor 서비스 신설)
- oort compose에 실행 컨테이너를 추가하고 서버가 직접 잡을 실행.
- 장점: 에이전트 호스트 불필요. 단점: RCE 표면·리소스 격리·비용 폭주 관리가 전부 oort 몫, ADR-0004 경계 재설계 필요, v0 규모에 과함. **기각 권장** (v1+에서 Option A 위에 "oort가 호스팅하는 BYOA 노드"로 재검토 가능).

### Option C — 외부 SaaS 연동(Codex cloud 등)으로 위임
- 장점: 구현 최소. 단점: self-hosted trust boundary 포지셔닝(§1.2)과 정면 충돌, 자격증명 경계 복잡. **기각 권장.**

## Decision (Accepted = Option A)

### D1. Work는 `agent_run`의 1급 사용례다 — 새 실행 개체를 만들지 않는다
v0는 `agent_run.input`에 work 계약(`{type:"work", title, repo?, branch?, brief}`)을 싣는 convention + 서버 검증으로 시작한다. `schema_v0.sql` 불변, 필요 시 신규 numbered migration만. 타임라인이 원장: 시작 카드 → 진행(partial) → 승인 카드 → 결과 카드가 전부 채널 메시지/이벤트로 남는다.

### D2. 실행은 항상 에이전트 호스트에서 — oort 서버는 코드를 실행하지 않는다
터미널·코드 작업의 프로세스는 BYOA gateway 에이전트의 호스트에서 돈다. oort에는 명령 텍스트·출력 transcript·diff·exit code 같은 **기록**만 들어온다(REST 단일 쓰기 경로). provider/OAuth/레포 자격증명은 에이전트 호스트에 남는다(ADR-0004 유지).

### D3. 위험 등급은 codex sandbox 정책을 승인 티어에 매핑한다
- read-only 실행(조회·검색·빌드 dry-run): 자동 진행, 결과만 기록.
- workspace-write(파일 수정·테스트 실행·커밋): **승인 왕복 필수**(349 재사용) — 승인 카드에 명령/대상 요약.
- network 동반 쓰기·자격증명 사용(push, 배포): 승인 + 감사 로그 필수.
- danger-full-access 상당: oort 표면에서 요청 자체 불가(fail-closed).

### D4. 특화 에이전트 라우팅 v0 = 명시 선택 + capability 배지
`agent.config`의 `capabilities` convention(예: `["code","terminal","docs"]`, 스키마 무변경)을 서버가 표면화하고, 클라이언트는 Work 시작 시 **채널에 초대된 에이전트 중** 해당 capability 보유자를 배지와 함께 제시한다(초대 게이팅 원칙 그대로). 자동 라우팅/오케스트레이션은 명시적 v1+ (decision ledger·autonomy_level 트랙과 합류 지점).

### D5. 코드 특화 에이전트의 v0 레퍼런스 구현 = codex CLI 기반 gateway adapter
hermes adapter 패턴을 승계한 `adapters/codex-workbench/`: oort run을 받아 에이전트 호스트에서 `codex exec`(sandbox 정책은 D3 티어)로 수행, 세션 resume으로 후속 지시 왕복, transcript는 partial 스트림, 최종 diff/PR 링크/exit 요약은 결과 카드로 커밋. Apache-2.0 재사용은 어댑터 의존성으로만(oort 백본 비유입).

### Non-goals (v0)
사람이 직접 치는 인터랙티브 raw PTY, oort 서버측 실행 컨테이너, 자동 에이전트 선택, 멀티 에이전트 협업 오케스트레이션, 대형 산출물 스토리지(파일은 Drive 트랙 기확정), iOS 표면.

## Consequences

- (+) "메신저에서 에이전트에게 일 시키기"가 데모 가능한 1급 플로우가 된다 — 10인 내부 테스트의 킬러 데모이자 §1.2 포지셔닝의 첫 체감 구현.
- (+) 신규 인프라 0: 실행 경로·승인·스트림·lease 전부 기존 랜딩분 재사용. 스키마 변경도 v0는 0.
- (+) codex-fleet에서 이미 검증한 운영 계약(exec/resume/sandbox/exit-code)을 제품으로 승격.
- (−) Work 가능 에이전트는 gateway 상시 프로세스가 필요 — 내부 테스트에선 운영자(성재) 머신의 codex-workbench 1기로 시작.
- (−) transcript가 타임라인에 쌓이면 노이즈 위험 — 카드 접기/상세 페인으로 UI에서 해결(파생 티켓), 정책은 P8(알림 예산) 준수.
- 후속 결정 예약: managed 실행 노드(Option B 재검토), 자동 라우팅, momo-plugin-github(PR 표면)와의 합류, A2A/Agent Card 정렬.

## 파생 배치 (완료 — MOMO-362..365)

| 티켓 | 내용 | 프로파일 | 의존 |
|---|---|---|---|
| `MOMO-362` | work run 계약 v0 — input 검증·시작/조회 REST·승인 티어 서버 가드 | swift/runtime-agent | 없음 |
| `MOMO-363` | codex-workbench gateway adapter (exec/resume/sandbox 티어/partial/결과 카드) | python/runtime-agent | MOMO-362 |
| `MOMO-364` | Work 표면 UI — 시작 컴포저·타임라인 work 카드(라이브 테일+인라인 승인)·상세 페인 | swift/macos-ui | MOMO-362, UI W1 |
| `MOMO-365` | capability 배지·Work 대상 선택 UX (config.capabilities 표면화) | swift/macos-ui | MOMO-362 |

실행 결과: 362→363 직렬, 364/365 병렬 순서로 2026-07-13 main에 랜딩했다. 실제 interactive Codex app-server approval relay는 ADR-0114에서 별도 결정한다.
