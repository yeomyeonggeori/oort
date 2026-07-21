# 핸드오프 패킷 — 에이전트-네이티브 패브릭 배치 (ADR-0129·0130 + 0126 D2 승격)

- **status: ready** · Planning ID: `PLN-20260721-01` · Owner: Fable(기획 세션) · Integrator: `momo-main`(현행 오케스트레이터 세션 — 티켓 발급·정본 통합·검수 소유)
- 기준 커밋: main `0c2eb79` 이후(이 패킷이 포함된 docs(planning) 커밋). supersedes: 없음.
- 결정 정본: **ADR-0129**(Memory Plane & Context Fabric 런타임 — Accepted 2026-07-21) · **ADR-0130**(외부 코딩 에이전트 멤버십·ACP — Accepted 2026-07-21) · ADR-0126 D2(diff 카드 — 기예약 MOMO-518 승격) · 진단 `2026-07-21-agent-native-vision-diagnosis.md` · 트랙 진단 `2026-07-21-track-structure-diagnosis.md` · 리서치 `research/19-agent-native-fabric/00~05`
- 성재 결정(2026-07-21): ①0129 D1~D6 전부 A ②0130 D1·D2·D3·D5 A, D4는 v0 수동 유지+Agent Card 2단계 ③**Blaxel 콜라보 캔슬, E2B 베이스 확정** ④트랙은 현행 2트랙 유지(+함정 규율 승격·정비 배치 정례화·공개 시 한시 release 트랙 — 트랙 진단 §3)

## 0. 이 배치가 만드는 것 (한 단락)

메신저가 에이전트의 컨텍스트 매니저가 된다: 워크스페이스 메모리(추출→저장→하이브리드 검색→packet 서빙→가시화)가 PG-native로 서고(Wave M), 임의의 코딩 에이전트가 ACP로 momo 세션에 들어오며(Wave A), 팀은 diff 카드·메모리 브라우저·도구 카탈로그로 그것을 보고 다룬다(Wave U). 전 과정에서 기존 불변식(PG=SoT·RLS FORCE·단일 쓰기경로·자격증명 비유입·서버 raw 비경유·승인 원장)은 무변경.

## 1. Goal 체인·머지 순서

```
Wave M (엔진, 순차):   MOMO-526(memory 스키마+추출 워커) → MOMO-527(pgvector/FTS/RRF) → MOMO-528(Context Packet v0 승격)
Wave A (엔진, 순차):   MOMO-530(gateway work tool 노출) → MOMO-533(work_tool_profile 원장) → MOMO-531(momo-acp-host v0)
Wave U (UXUI):        MOMO-518(diff 카드 — 즉시 가능) → MOMO-529(메모리 브라우저+인스펙터 — 527·528 랜딩 후) → MOMO-532(도구 관리+ACP 카드 — 533·531 랜딩 후)
```

- **M과 A는 병렬 가능**(파일군: M=MessageRoutes/AgentJobPayload/신규 Memory* vs A=WorkControl/Gateway/workd — 비충돌). M 내부·A 내부는 순차.
- 530→533 순차 이유: 둘 다 `WorkControlRoutes.swift` 접촉. 531은 533의 launch_template 소비.
- 528은 527의 검색을 memory_refs로 소비, 529는 527 REST+528 packet 저장을 소비.
- 기존 진행 중 배치(iOS·웹·UXUI 순차 9항목)와의 슬롯 편성은 오케스트레이터 재량 — 단 518은 의존 0이라 UXUI 다음 슬롯 후보.

## 2. 티켓 계약 (BUILD_TICKETS 수용기준의 원문 — 발급 시 이 절을 이관)

### MOMO-526 (엔진) — Memory Plane 스키마 + 수명주기 원장 + 추출 워커 v0
- **Goal**: `memory_item`/`memory_source_ref`/`memory_lifecycle_event`/`memory_candidate` migration(027+) + 추출 파이프라인 v0 + 메모리 CRUD/무효화 REST.
- **계약**:
  - 스키마(research/11 `05-memory-plane-v0.md` §15 승계): `memory_item(id uuidv7, workspace_id, scope ∈ workspace|member|agent|conversation, subject_member_id?, agent_member_id?, channel_id?, kind ∈ profile|fact|episode|procedure, body, confidence, valid_at, invalid_at?, invalidated_by_memory_id?, created_by_kind, created_at)`. **전 테이블 RLS ENABLE+FORCE+ws_isolation**(선례 `013_plugin_registry.sql:106-120`). `schema_v0.sql` 수정 금지 — 신규 마이그레이션만.
  - **삭제 대신 무효화**: DELETE 라우트는 admin 정책 스위치(워크스페이스 메모리 off 시 일괄 삭제 — ChatGPT Enterprise 문법)만. 통상 경로는 `invalid_at` + lifecycle_event.
  - 추출 워커: 채널별 처리 워터마크(last_extracted_seq) 기반 주기 배치 → 2-phase(후보 추출→기존 유사 대조→ADD/UPDATE/무효화/NOOP, mem0 논문 문법) → 반영은 단일 쓰기경로(트랜잭션+outbox 이벤트 `memory.updated`). LLM 호출은 **기존 BYOA 경로 재사용**(AgentWorker Hermes transport 또는 워크스페이스 지정 에이전트) — provider 자격증명 비유입 불변. dev/verifier는 mock 추출기 허용.
  - 원문 본문 중복 저장 금지 — `memory_source_ref(memory_id, message_id, channel_id)` 링크만(출처 역링크의 데이터 기반).
- **파일 맵**: `server/Migrations/`(신규), `server/Sources/MomoServer/Routes/`(신규 MemoryRoutes), 워커는 `workers/AgentWorker` 내 신규 서비스 또는 별도 타깃(worker claim 패턴 `WorkerService.swift:150-174` 참조), openapi.yaml 가산.
- **검증**: `verify_memory_plane.sh` — 시드 대화→mock 추출→item 생성/갱신/무효화/NOOP 4분기·source_ref 무결성·cross-workspace RLS 거부·정책 off 일괄 삭제·audit/lifecycle 단정. docker 실런.

### MOMO-527 (엔진) — pgvector + FTS + RRF 하이브리드 검색
- **Goal**: PG 이미지에 pgvector v0.8.x 도입, memory_item에 embedding/tsvector 인덱스, RRF 하이브리드 검색 REST.
- **계약**:
  - **infra**: e2e/dev/prod compose의 PG 이미지를 pgvector 포함 이미지로 통일(pgvector/pgvector:pg18 계열 digest 고정) + `CREATE EXTENSION IF NOT EXISTS vector` 마이그레이션. **compose 3종+drift guard 동시 갱신**(MOMO-338 config drift 전례 — 머지 후 재시작 고지 포함).
  - memory_item: `embedding vector(차원은 구현 시 확정)` + HNSW, `tsv tsvector` 생성 컬럼 + GIN. 검색 `GET /v1/workspaces/:ws/memories/search?scope&agent&q&limit` — FTS+벡터 RRF SQL 함수 합성(Supabase 레시피), **정상 RLS 경로(BYPASSRLS 금지)**, 임베딩 없는 항목은 FTS만으로 검색 가능(임베딩은 지연 생성 허용).
  - 임베딩 생성: 워커 비동기. provider는 BYOA 경계 준수 — dev/gate는 결정적 mock 임베더로 검증(실 provider는 runtime-unverified로 표기).
- **함정**: pgvector 이미지 누락 시 마이그레이션이 전 게이트를 깨뜨림(이미지 선행 확인); HNSW 빌드 시간(마이그레이션은 인덱스 CONCURRENTLY 불가 맥락 확인); 한국어 질의는 pg_trgm 보조 고려(v0 선택).
- **검증**: `verify_memory_search.sh` — FTS 단독·벡터 단독·RRF 합성·scope 필터·RLS 거부·rate limit. 기존 전 게이트 회귀(이미지 교체 영향).

### MOMO-528 (엔진) — Context Packet v0 승격 (partial → 불변 packet)
- **Goal**: `contextPacketProjection`(`MessageRoutes.swift:2013-2060`)을 v0 계약으로 승격 — 불변 저장·`memory_refs`·`budget`·`redactions`·mock 제거·실 grant 주입.
- **계약**:
  - 신규 `context_packet` 저장(packet_id uuidv7, run_id, workspace_id, created_at, expires_at, content jsonb, RLS FORCE) — run 동안 불변, 정책/가시성 변화 시 재발급(스펙 `04-context-packet-v0.md:22,233`).
  - `memory_refs`: 527 검색 top-k(스코프: 해당 agent+요청 member+workspace, 토큰 예산 내 절사) — **profile kind는 상시 주입, fact/episode는 질의 시**(19-03 §2c).
  - **mock tool_grants 제거**(`MessageRoutes.swift:2062-2073`) → `plugin_capability_projection`(013) 실주입. projection 부재 시 빈 배열(fail-closed) — R2 해소.
  - `permission_basis` 라벨을 실검증으로: actor 채널 멤버십 EXISTS 추가 — R1 해소.
  - 소비 호환: `AgentJobPayload`에 memory_refs 가산(기존 필드 불변 — worker/gateway 양 경로 동시 지원, ADR-0102 경로 불가지 유지).
- **검증**: `verify_context_packet.sh` — packet 불변성(재조회 동일)·만료 재발급·mock 부재 단정·grant 실주입/회수 반영·memory_refs 스코프·RLS. 기존 verify 계열 회귀(mention 왕복).

### MOMO-530 (엔진) — work tool의 gateway 경로 노출
- **Goal**: worker 전용인 work tool-call 배선(`WorkerService.swift:358-410`, WorkToolDispatcher)을 gateway BYOA 계약에도 개방 — gateway 에이전트가 `work.spawn/input/read/kill`을 구조화 tool_call로 제출하면 서버가 work.control 원장 경로(승인·host 라우팅·감사)로 처리.
- **계약**: 서버-소유 보장 매트릭스(경로 불가지 — `research/11/11-hermes-adapter-contract-v0.md`) 준수. gateway events 계약에 tool_call 이벤트 수용 추가(rate limit 기존 240/60s 내). 승인·auto-approve·host 검증은 기존 `WorkControlRoutes.swift` 기계장치 무변경 재사용. QA_FOLLOWUP의 X-7 계열 후속 성문화.
- **검증**: gateway 경로 spawn→승인→dispatch→ack 왕복 verifier(기존 verify_workd/work 계열 확장). worker 경로 회귀.

### MOMO-533 (엔진) — work_tool_profile 원장 (하드코딩 화이트리스트 제거)
- **Goal**: `["claude","codex","opencode","shell"]` 하드코딩 3곳(서버 `WorkControlRoutes.swift:507`·mac 앱 launch spec `MomoLocalTerminalSession.swift:72-115`·workd 템플릿 `ProcessManager.swift`) 중 **서버·workd를 원장화**(앱 소비는 532).
- **계약**: `work_tool_profile(workspace_id, tool_key, display_name, launch_template jsonb, tier_defaults, enabled, created_by, audit)` migration + 관리자 CRUD REST + 서버 spawn 검증을 원장 조회로 교체(**미등재/disabled 도구 fail-closed 거부**) + 기본 시드 4종(기존 동작 보존) + workd가 GET 투영으로 템플릿 소비. launch_template에 자격증명·절대경로 비유입(도구 키+인자 템플릿만, 경로 resolve는 호스트 로컬).
- **함정**: `WorkControlRoutes.swift`를 530과 공유 — **530 랜딩 후 착수**(rebase 비용 방지).
- **검증**: `verify_work_tool_profile.sh` — 시드 4종 동작 보존·신규 등록→spawn 성공·disabled→거부·미등재→거부·RLS·audit.

### MOMO-531 (엔진+호스트) — momo-acp-host v0
- **Goal**: workd·앱 세션 매니저에 **ACP(Zed Agent Client Protocol) 클라이언트**를 구현 — ACP 에이전트를 work_session으로 물화. v0 실증 대상 2종: opencode(네이티브)+claude-agent-acp(어댑터).
- **계약**:
  - JSON-RPC 2.0 over stdio 서브프로세스: `initialize`(capability 협상)→`session/new`→`session/prompt`. **`session/update`**(진행·plan·툴콜)→세션 스레드 카드(기존 agent.partial/status envelope 정렬 — AG-UI 어휘 기준). **`session/request_permission`**→momo 승인 카드(0114 D5) 왕복 — 승인 전 해당 작업 미진행(fail-closed). `terminal/*`는 기존 PTY 세션 매니저에 위임 — **workd의 비-PTY(Pipe) 경로를 PTY로 정합 회복(R4)**.
  - ACP는 **호스트-로컬 전송**: ACP 트래픽·raw는 momo 서버 비경유(0125 D10 불변). 서버 계약(work.control·승인·감사) 무변경. 도구 기동은 533 launch_template 경유.
  - 에이전트별 이벤트 밀도 편차 대응: 카드 렌더 최소 공통분모(진행 텍스트+plan 유무+승인)로 설계, 확장 필드는 `_meta` 통과 저장만.
- **검증**: `verify_acp_host.sh` — mock ACP 에이전트(stdio 스크립트)로 initialize→prompt→update 카드 투영→request_permission→승인/거부 분기→종료. opencode 실왕복은 credential 환경 opt-in(runtime-unverified 허용, MOMO-230 문법).

### MOMO-518 (UXUI) — 산출물 diff 카드 (ADR-0126 D2, 기예약 승격)
- **Goal**: 세션 스레드 산출물의 타입드 카드 — unified diff 렌더(파일별 접기·추가/삭제 요약·모노스페이스), 커밋/PR 링크 카드 승격. props 계약 `artifact_kind: diff|commit|pr`(macOS·iOS·웹 공용 정본).
- **계약**: 소스는 work.read 발췌와 동일 경로(사용자 검토 후 공유 — 0114 D3 유지), 에이전트 발췌의 diff 감지는 클라 렌더 계층. GitHub API 조회는 클라 opt-in. 서버 원장 변경 없음(props 스키마 검증만). 렌더 상세·회피 패턴은 `research/19-agent-native-fabric/05`(UXUI 레퍼런스) 반영.
- **검증**: macOS 스냅샷+focused tests, `momo-design-taste` + design-review 에이전트 Blocker 0.

### MOMO-529 (UXUI) — 워크스페이스 메모리 브라우저 + 서빙 인스펙터
- **Goal**: ①"에이전트가 아는 것" 뷰 — 스코프/에이전트 필터, 항목 열람·편집·무효화, **출처 메시지 역링크**(source_ref→타임라인 점프), 관리자 정책 스위치 ②run 서빙 인스펙터 — 세션/응답 카드에서 "이 실행에 서빙된 packet"(히스토리 창·memory_refs·tool_grants) 열람.
- **의존**: 526(스키마)·527(검색 REST)·528(packet 저장). **계약**: 편집·무효화는 REST 경유(서버 집행 — 0129 D6), packet 열람은 저장된 불변 packet 조회(신규 GET). 레이아웃·문법은 `research/19-05` 레퍼런스 분석 반영(카드=요약·서랍=상세 관례).
- **검증**: macOS focused/스냅샷 + 실서버 왕복(편집→realtime 반영), design-review Blocker 0.

### MOMO-532 (UXUI) — 도구 프로파일 관리 + ACP 세션 카드
- **Goal**: ①관리자 도구 등록 UI(533 원장 CRUD 소비 — **앱 launch spec 하드코딩 제거**, 원장 투영 fail-closed 소비) ②ACP 세션 카드 렌더(531 이벤트 — plan/진행/승인 인라인, 터미널 서랍 진입은 기존 A-10/511-U 재사용).
- **의존**: 533·531. **검증**: 등록→spawn 목록 반영→미등재 도구 비노출, ACP 카드 상태 전이 스냅샷, design-review Blocker 0.

## 3. 지켜야 할 계약 (전 티켓 공통 — 위반=반려)

1. PG=SoT·Centrifugo=전송전용·단일 쓰기경로(REST→PG tx→outbox→relay). 신규 realtime 이벤트도 outbox 경유.
2. 신규 테이블 전부 workspace_id+RLS ENABLE **FORCE**+ws_isolation. 사용자 대면 retrieval에 BYPASSRLS 금지.
3. provider 자격증명·OAuth 토큰·raw PTY 스트림은 서버·packet·로그·원장에 절대 비유입(ADR-0004). launch_template에도.
4. 위험 쓰기=승인 정지점(`tool_call→approval_request→tool_result→audit_log`). ACP request_permission도 이 경로.
5. packet은 run 동안 불변, 정책 변화 시 재발급. 에이전트·actor 채널 멤버십 fail-closed 재검증.
6. `schema_v0.sql` 수정·이동 금지. openapi.yaml이 REST 계약 정본(신규 라우트 동시 반영).
7. worker는 merge/close 금지·PR handoff 후 정지. 계획 이탈은 PR `## 계획 이탈` 섹션 의무.

## 4. 공통 함정 (검수 실측 축적분 — worker 프롬프트에 포함할 것)

1. **nil String?/UUID? 바인딩** → `::text`/`::uuid` 명시 캐스트(jsonb_build_object 내 nullable 포함 — 489 전례).
2. **트랜잭션 내 HTTPError**는 `Database.withTenantTransaction` 중앙 unwrap이 처리 — 라우트별 ad hoc unwrap 금지(565 전례).
3. **verifier 작성 규율**: bash 3.2 빈 배열 금지 문법 / api 컨테이너에 curl 없음(python 대체) / `psql -q`(명령 태그 오염 방지) / UUID 비교는 `lower()` / 포트 대역 신규 배정(**28100대부터 — 27850~28093 사용 중**, 스폰 전 `grep -rn '<포트>' scripts/`로 선점 확인) / demo 계정 password는 NULL 아님(migration 005가 dev/e2e 백필) — 행 존재 확인 후 UPDATE 덮어쓰기.
4. **compose/infra 변경 후 컨테이너 재시작 필수**(config drift — MOMO-338 전례). 527 이미지 교체는 e2e/dev/prod+drift guard 동시.
5. **(527 실측) 시드에는 채널(…202)만 있고 message 행이 없다** — verifier 소스 메시지는 API POST로 생성(verify_memory_plane.sh 패턴).
6. **(527 실측) Swift Int 바인딩은 bigint** — SQL 함수의 `integer` 파라미터에 넘길 때 `::integer` 캐스트 필수(함수 해석 실패=500).
7. **(533 실측) 마이그레이션 번호는 병렬 wave 간 충돌** — 스폰 시점에 다른 진행 중 PR의 번호를 확인하고 배정(028 memory_search·029 work_tool_profile 확정, 다음=030).
5. openssl 직접 호출 금지(LibreSSL 게이트 함정 — 내부 Crypto 사용, 491 전례).
6. Centrifugo 발행 payload에 props 탑재 확인(X-9 전례 — 신규 이벤트도 REST↔outbox 일치 단정).
7. 게이트 실행 후 docker 회수(`momo-docker-reclaim.sh`, 배치 종료 시).

## 5. 검증 규율

- 엔진: 티켓별 verifier(docker 실런) PASS + `scripts/local_gate.sh --profile runtime-db` + 기존 verify 계열 회귀. 실 LLM/임베딩/opencode 왕복은 credential opt-in 게이트(runtime-unverified 표기 허용 — MOMO-230 문법).
- UXUI: macos-ui 게이트+focused tests+스냅샷, design-review 에이전트 Blocker 0, 실서버 왕복은 트랙 스택.
- 머지: 트랙 브랜치까지 자율, **track/*→main은 성재 명시 승인**(TRACKS 규칙 불변).

## 6. 트랙 편성 (트랙 진단 반영)

- 현행 2트랙 유지: Wave M·A=track/engine, Wave U=track/uxui. 이 패킷의 함정 §4를 `HANDOFF_TEMPLATE.md` 고정 섹션으로 승격(정비 규율 ①). 정비 배치 정례화·한시 release 트랙은 오픈소스 공개 배치 시 적용(진단 §3).

## 7. 컨텍스트 델타 (오케스트레이터가 알아야 할 변경분)

- **Blaxel 캔슬**(성재 2026-07-21) — E2B 베이스 확정. T3 프로비저너 후속 ADR에서 E2B Enterprise 보관 조항 문의만 유지.
- **"ACP"는 Zed Agent Client Protocol**(IBM ACP는 2025-08 A2A에 흡수·소멸). research/13-redesign의 "ACP 무시" 판정은 구 IBM ACP 기준 — Zed ACP는 본 배치가 채택(ADR-0130).
- Agent Membership Protocol(공개 규격 제안)은 **보류** — 제품 질량(오픈소스 공개+실사용) 확보 후. 지금은 구현만.
- `research/19-agent-native-fabric/05`(UXUI 레퍼런스 분석) **랜딩 완료** — 518/529/532 수용기준 이관 시 §2(표면별 구현 제안: 컴포넌트 재사용/신규 목록·v0/v1 범위)가 원문. 핵심 계약: 카드=요약·서랍=상세 / ACP 승인 4옵션(이번만·항상×허용·거부) / 처리된 승인 카드 불변 고정 / plan=체크리스트 카드 / 산출물→run 역링크.
- 정합 리뷰 R1~R6(진단 §6) 중 R1·R2=528, R3=533, R4=531에서 해소. R5(inbound MCP 구버전)·R6(delegation)은 이 배치 범위 외(후속).

## 8. 오케스트레이터 인수 프롬프트 (성재가 현행 오케스트레이터 세션에 붙여넣는 원문)

```
[PLN-20260721-01 인수 — 에이전트-네이티브 패브릭 배치 (ADR-0129·0130 Accepted)]

main 최신에 PLN-20260721-01 산출물이 랜딩됐다. 다음 순서로 인수해줘:

1. 정본 읽기(이 순서만): docs/planning/handoffs/2026-07-21-agent-native-fabric-batch.md(실행 정본)
   → 필요 시에만 docs/adr/0129·0130, docs/planning/2026-07-21-agent-native-vision-diagnosis.md,
   research/19-agent-native-fabric/00~05.
2. 승인 상태: ADR-0129(D1~D6 A)·0130(D1·D2·D3·D5 A, Card는 2단계) 성재 Accepted.
   Blaxel 캔슬·E2B 확정. 트랙은 현행 2트랙 유지(패킷 §6).
3. momo-main 정본 통합 수행: BUILD_TICKETS.md에 MOMO-518·526~533 수용기준 이관(패킷 §2가 원문),
   GitHub Issue 발급(패킷 링크 필수), ENGINE_HANDOFF·CURRENT_STATE 갱신,
   패킷 §4 함정을 HANDOFF_TEMPLATE.md 고정 섹션으로 승격.
4. 실행: Wave M(526→527→528)·Wave A(530→533→531)=track/engine 병렬(내부 순차),
   Wave U(518→529→532)=track/uxui(518은 의존 0 — 즉시 후보).
   기존 진행 배치(iOS·웹·UXUI 순차)와의 슬롯 편성은 네 재량, 동시 in-progress ≤5 유지.
5. worker 전달은 3줄 규율(레포 경로+패킷 경로+goal 번호) + 패킷 §4 함정 포함.
   research/19-05(UXUI 레퍼런스)는 518/529/532 이슈 본문에 참조로 연결.
```

## 9. 델타 (2026-07-21 비전 정합 검토 — docs/planning/2026-07-21-vision-conformance-review.md)

1. **MOMO-526 스키마 가산**: `memory_visibility_grant(id, workspace_id, memory_id FK, grantee_kind ∈ member|agent, grantee_id, granted_by, created_at, revoked_at?)` + RLS FORCE — 스펙(research/11 05 §15)·0129 D1에 있던 테이블의 §2 누락 복원(성재 원문 "1급 멤버지만 권한은 있을 수도"의 데이터 기반). `memory_item`에 `source_kind text NOT NULL DEFAULT 'message'` 선반영(v1 추출원 확장 대비 — memory_source_ref 재작업 방지).
2. **MOMO-528 서빙 필터 가산**: memory_refs 검색 범위 = "기본 스코프(해당 agent+요청 member+workspace) ∪ 유효 visibility grant(revoked_at IS NULL)".
3. **MOMO-529 범위 가산**: grant 목록·회수 UI(관리자/소유자) 1절.
4. **W-6(웹 Work 관전 v0) 백로그 신설**: 세션 리스트(read-only)+스레드 관전+observer 터미널(516 capability)+diff 카드 웹 렌더(518 props 공용). 착수=518 랜딩 후, track/engine 소관. CTO 원문 "다양한 직군이 하나의 화면"의 브라우저 전제 — 진단 §1-4 권고의 큐 등재 유실 복원.
