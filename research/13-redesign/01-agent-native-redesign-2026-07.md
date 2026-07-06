# momo 재설계 — "이럴 거면 Slack 쓰지" 방지 설계서 (2026-07)

> 생성: 2026-07-06 · 입력 = 전체 코드베이스 심층 분석(클라/서버/문서 3트랙) + 외부 레퍼런스 리서치 2트랙(astryx·openagents·Codex app·Slack Kit·Discord·Compass·Apple on-device AI·pgvector).
> 성격: **정본 스펙이 아니라 재설계 방향 문서.** 채택 시 각 트랙을 `docs/BACKLOG.md` 티켓(MOMO-3XX 제안 번호)으로 변환한다.
> 정본 우선순위는 기존 규칙 유지(AGENTS > ROADMAP > BACKLOG). 이 문서는 ROADMAP 개정의 근거 자료다.

---

## 0. 한 줄 결론

momo의 **에이전트 네이티브 코어(스키마·outbox·seq·비용회계·승인)는 이미 경쟁력이 있다.**
지금 위험한 것은 반대쪽이다: **메신저로서의 기본기(스레드·검색·파일·마크다운·알림)와 디자인 시스템이 통째로 비어 있고, 에이전트가 실제로는 "기억 없는 단발 호출"이라는 것.**
"이럴 거면 Slack 쓰지"는 에이전트 기능이 부족해서가 아니라 **메신저 기본기가 부족해서** 나오는 말이다. 재설계의 절반은 기본기 회복, 절반은 이미 설계된 에이전트 프리미티브를 표준 프로토콜(MCP/A2A/AG-UI) 위에 올리는 것이다.

---

## 1. 진단 — 우리의 문제 7가지

### P1. 디자인 시스템이 없다 (🔴 사용자 체감 1순위)
- 현재 토큰 전부 = `clients/macOS/.../Theme.swift` **55줄** (색 5개 + 코너/거터 2개). 주석 스스로 "full design system lands with the .app follow-up ticket"이라 적어둔 상태.
- 타이포 스케일 없음(`.system(size: 8~17)` 하드코딩 산재), 스페이싱 스케일 없음(4/8/12/14/18 혼용), 추출된 재사용 컴포넌트 0개.
- 결과: 화면마다 밀도·정렬·위계가 미묘하게 다르고, 새 surface를 붙일 때마다 스타일이 발산한다. Mattermost Compass / Discord / Codex 수준은 토큰 계층 없이는 도달 불가.

### P2. 메신저 테이블스테이크스가 "스펙엔 있는데 어디에도 없다" (🔴 silent commitment vacuum)
- **스키마/프로토콜에는 존재**: `root_id`/`reply_to_id`(스레드), `reaction` 테이블, `file` 테이블, `pg_trgm` 인덱스(검색), `edited_at`/`deleted_at`, `read_state`(unread), typing/presence 이벤트.
- **클라 UI에도 서버 라우트에도 로드맵 티켓에도 없음**: 스레드 UI 0, 리액션 UI 0(뷰모델이 명시적으로 이벤트 무시), 검색 UI 0, 파일 업로드 0, 마크다운/코드블록 렌더 0, 알림 0, 단축키 1개, @멘션 자동완성 0, unread 마커 0. **BACKLOG 41티켓 중 이들에 대한 티켓이 하나도 없다.**
- 이것이 포지셔닝("channel timeline is the execution ledger")과 정면 충돌한다 — 타임라인이 ledger가 되려면 먼저 팀이 그 타임라인에서 *살 수 있어야* 한다.

### P3. 에이전트가 사실상 기억상실이다 (🔴 제품 정체성 위협)
- `workers/AgentWorker/.../WorkerService.swift`의 hermes 호출은 **트리거 메시지 1개만** `messages`에 담아 보낸다. 대화 히스토리 0, 스레드 컨텍스트 0, RAG 0, Memory Plane 0.
- Context Packet v0 / Memory Plane v0 / Capability Cache v0는 **정본 스펙과 fixture까지 완성**되어 있으나(research/11), 이를 실제로 조립하는 **Context Broker에는 owner 티켓이 없다** (research/10 문서에만 존재).
- "AI가 함께 쓰는 것을 전제로 한 메신저"의 최소 조건 — 에이전트가 채널의 맥락을 아는 것 — 이 미충족.

### P4. 프로토콜이 고립되어 있다 (🟠)
- Inbound MCP는 전부 스텁(`momo.mcp.runtime_stub` 반환, JSON-RPC 아닌 HTTP-shape, `mcp.*` scope 발급 경로 없음). 외부 에이전트 초대 경로 없음, 웹훅 없음, 플러그인 런타임 없음. A2A 스펙 개념은 문서에 있으나(agent run lifecycle v0) Agent Card/디스커버리 없음.
- 유일한 에이전트 접점 = 글로벌 단일 hermes 게이트웨이. "에이전트 초대와 플러그인 연동이 자유로운" 목표와 거리가 있다.

### P5. 보안이 "문서 의도 > 코드 현실" (🟠 신뢰 포지셔닝 리스크)
- Centrifugo subscribe proxy가 **미인증**(코드 TODO: HMAC 검증 없이 `user` 신뢰 — 프라이빗 네트워크 가정).
- `token.revoked_at` 컬럼은 있으나 **읽기 시 검사하지 않음** → 로그아웃/탈취 토큰이 만료까지 유효.
- HTTP rate limiting 전무(비용 서킷브레이커는 있으나 요청량 기반 아님). 감사로그 `detail` jsonb의 시크릿 redaction 규칙 없음.
- **BYOK 없음**: provider key가 전역 env 1개. per-workspace/per-agent 키·모델 선택 구조 부재.
- 스키마 안전장치 2개가 설계에만 존재: `agent_run.depth/round_count`(A2A 무한루프 방지 — 스펙 §3.4가 depth≤4를 약속하는데 저장 컬럼이 없어 **집행 불가**), `tool_call.reversibility_tier`(경험 H 되돌리기 — 렌더 불가).
- 반면 잘된 것: 전 테이블 RLS FORCE, token_hash 저장, 시크릿 preflight/fail-fast, provider credential boundary ADR-0004. 기반은 건강하다.

### P6. 온디바이스 AI가 반쪽이다 (🟡)
- FoundationModels 통합은 이미 시작됨(`LocalContextCopilot.swift` 555줄 — capability probe + deterministic fallback + 온디바이스 요약). **이건 경쟁사 대비 강점.**
- 그러나: 4k 토큰 컨텍스트 윈도 전략 없음(한국어는 ~1자/토큰이라 더 빨리 소진), 임베딩(`NLContextualEmbedding`) 미사용, 음성 입력 0 (Speech 프레임워크 import 자체가 없음), "LLM 호출 전 컨텍스트 압축"이라는 핵심 활용처가 미연결.

### P7. 포지셔닝-구현 간극 (🟡)
- "모든 승인·비용·감사가 타임라인에 보인다"는 카피 대비, 승인 결정 엔드포인트·거버넌스 UX는 M2+, 실제 hermes 스트리밍 검증은 mock 중심. 내부 알파에서 카피가 먼저 검증대에 오르면 신뢰를 잃는다. (해결책은 카피 톤다운이 아니라 P2·P3을 닫는 것.)

---

## 2. 레퍼런스 → 채택 결정

| 레퍼런스 | 실체 (2026-07 검증) | momo가 가져올 것 |
|---|---|---|
| **facebook/astryx** | Meta의 오픈소스 디자인 시스템(React+StyleX, "agent ready", MCP 서버/CLI 동봉). 메신저 아님 | 코드가 아니라 **철학**: 디자인 시스템·문서·API를 사람과 LLM이 같은 인터페이스로 소비("one API for humans and AI"). momo 자신이 `llms.txt` + 자기 MCP 서버를 가진 agent-ready 제품이 될 것. 예측 가능한 네이밍 규약 |
| **openagents-org/openagents** | "Slack, but for agents" — 워크스페이스+런처+Network SDK(Python, MCP/A2A 지원). 가장 가까운 유사체 | ① **세션 모델 그대로 이식**: 에이전트 컨텍스트 키 = `(workspace, agent, channel)`, 채널=컨텍스트 경계, 채널 내 직렬 실행, 재시작 생존·자가치유 ② 이벤트 네이티브 에이전트 SDK(`on_channel_post`/`on_mention` 핸들러 + fluent reply) ③ 단일 포트 `/a2a` + `/mcp` 레이아웃, `/.well-known/agent.json` Agent Card ④ 거버넌스: process-tree kill Stop, inactivity watchdog, max-turns |
| **OpenAI Codex app** | Electron(비공개). 오픈소스는 CLI/TUI(Rust)만. 네이티브 장인정신의 모범은 아님 | **인터랙션 문법**: 스레드=에이전트 세션(+워크트리 격리), 승인 = 상태 라이프사이클(Reviewing/Approved/Denied/Aborted/Timed-out)을 가진 1급 타입 메시지, **sandbox 수준 × 승인 정책 2축 분리**, diff는 별도 화면이 아닌 메시지-레벨 아티팩트. momo 스키마와 놀랍도록 호환 — 렌더 문법만 가져오면 됨 |
| **Slack Kit** | 점진적 디자인 시스템 구축기 | **"ugly mode"**: 토큰 미사용 색을 디버그 테마에서 형광색으로 노출 → SwiftUI에서 저비용 재현, day-1 도입. 사용자 테마 입력 9→4개 축소 + 시맨틱 램프 파생 |
| **Discord 2025 리디자인** | 밀도 3단이 1급 설정 | **Density(compact/default/spacious)를 토큰 차원으로** — 뷰별 해킹 금지 |
| **Mattermost Compass** | Foundations→Components→Patterns 계층. 서버 테마 JSON을 유저에게 노출 | 패턴 택소노미(Channel Sidebar/Header/Right Sidebar) + **self-hosted 어드민이 테마 JSON으로 클라를 테마링**하는 관행 |
| **Apple FoundationModels** | macOS 26, ~3B 온디바이스, **4,096토큰(입출력 합산)**, `@Generable` 유도 생성, 한국어 지원, 무료·무제한(포그라운드) | 요약·스레드 제목·알림 트리아지·**클라우드 호출 전 컨텍스트 압축**. 26.4의 TN3193 transcript-compaction 패턴 채택. 전면 사용이 아닌 "메신저 메모리·컨텍스트 최적화 보조" — 사용자가 원한 정확히 그 역할 |
| **NLContextualEmbedding** | 512-dim, CJK 스크립트 모델, 온디바이스 무료 | **온디바이스 전용** 기능(알림 semantic dedup, 로컬 클러스터링)에만. 공유 인덱스는 서버 임베더로(OS 버전별 모델 드리프트가 인덱스를 오염시킴) |
| **SpeechAnalyzer/SpeechTranscriber** (macOS 26) | `ko_KR` 지원, Whisper large-v3-turbo 대비 ~55% 빠름, OS 내장 무료, 스트리밍(volatile/finalized) API | **음성 입력 1순위.** 폴백 = WhisperKit(MIT). 한국어 WER 공개 벤치 없음 → 자체 평가 1회 필요 |
| **pgvector 0.8.4** (2026-06) | PG18 지원, HNSW + iterative scan, halfvec. 0.8.2~0.8.4가 HNSW vacuum 손상 픽스 | 서버 RAG 정본: `halfvec` HNSW + 채널/ACL 필터 + **RRF 하이브리드**(vector+FTS+pg_trgm). 한국어 FTS는 기본 파서 형태소 분리 못함 → pg_trgm 병행 또는 MeCab 사전 |
| **프로토콜 지형** | MCP(도구)·A2A(에이전트 간, Linux Foundation)·AG-UI(에이전트↔UI 스트리밍) 3층이 승자. ACP는 A2A로 흡수(사망) | **MCP + A2A + AG-UI 삼각 채택, ACP 무시.** 특히 AG-UI 이벤트 어휘(run started/tool call/state delta)를 자체 발명 대신 `agent.partial`/`agent.status` envelope의 정렬 기준으로 |

---

## 3. 재설계 — 6개 트랙

### Track A. MomoDS — 자체 디자인 시스템 (P1 해소)

`clients/Core`에 플랫폼 무관 토큰 정의, `clients/macOS`에 렌더 적용. 구조는 4층:

```
Primitive  : gray.50~900 / brand ramp / spacing 4pt grid / radius / type scale
             — 뷰가 직접 참조 금지
Semantic   : background.{primary,secondary,raised,hover} / text.{primary,muted,link}
             / status.{online,away,dnd} / danger·warning·success
             / **agent.accent · agent.surface** ← 에이전트에 고유 시맨틱 정체성 부여
             (기존 MomoTheme 5색은 semantic 층으로 흡수: costAmber→warning,
              reversibleGreen→success, irreversibleRed→danger)
Component  : messageBubble / composer / sidebarItem 등 실제 분기 있는 곳만
Density    : compact / default / spacious — spacing·lineHeight 토큰을 스케일 (Discord)
```

- 주입: `Theme` struct → `\.environment`, `ColorScheme`+유저 테마별 resolve. **워크스페이스 테마 JSON**(Compass 관행)을 서버가 서빙 → self-hosted 어드민 브랜딩.
- 타이포: 시맨틱 텍스트 스타일(`.messageBody`, `.timestamp`, `.channelName`, `.agentPayloadMono`)만 뷰에서 사용. Dynamic Type 호환.
- **Ugly mode**(Slack): 디버그 스킴에서 비토큰 색을 마젠타로 — 토큰 위반을 즉시 가시화. 도입 첫 주에 기존 하드코딩 전수 회수.
- 컴포넌트 1차 추출 목록(현재 인라인 중복): Avatar, Badge(risk/agent/seq), CardFrame, MessageHeader, StatusChip(run phase), IconButton, InlineBanner(realtime status).
- DTCG 2025.10 포맷으로 토큰 JSON 관리 → 추후 Figma/iOS/웹 codegen 여지.

### Track B. 메신저 코어 UX — 테이블스테이크스 회복 (P2 해소)

스키마가 이미 지원하므로 대부분 **서버 라우트 + 클라 UI**만 작업. 우선순위 순:

1. **마크다운+코드블록 렌더** (AttributedString 기반, 에이전트 출력의 최소 요건 — 에이전트가 마크다운으로 답하는데 raw text로 보이는 현재가 최악)
2. **스레드 UI** (`root_id` 활용, right sidebar 패턴) — *에이전트 세션 경계와 겸용* (Track C)
3. **unread 마커 + 채널 배지** (`read_state` 활용) + 로컬 알림(UNUserNotificationCenter)
4. **검색** (`pg_trgm` + FTS 라우트 노출, Cmd+K 커맨드 팔레트로 채널 점프와 통합)
5. **리액션** (테이블 존재, 뷰모델의 명시적 무시 해제 + 피커)
6. **파일 업로드/프리뷰** (`file` 테이블 + presigned 경로, 드래그&드롭)
7. **편집/삭제 UX** (컨텍스트 메뉴, edited 배지, soft-delete undo)
8. **@멘션 자동완성** (멤버 roster 기반 — 에이전트 초대의 UX 진입점이기도 함)
9. 단축키 체계(Cmd+K/Cmd+N/↑편집), 타이핑 인디케이터, 무한 스크롤 백필, 오프라인 송신 큐
- 성능 가드: 채널별 메시지 배열 상한(예: 500, 초과 시 페이지 아웃), upsert 시 전체 재정렬 대신 이진 삽입.

### Track C. 에이전트 프로토콜 — 표준 위에 올리기 (P3·P4 해소)

1. **세션 모델 (openagents 이식):** 에이전트 컨텍스트 키 = `(workspace_id, agent_member_id, channel_id)`. 채널=컨텍스트 경계, 채널 내 직렬(이미 partition_key로 보장), 스레드 시작 = 새 서브세션. `agent_run`에 `session_key` 파생 컬럼.
2. **컨텍스트 조립 v1 (최우선 버그 수준):** WorkerService의 단일 메시지 전송을 폐기. Context Packet v0 스펙대로 조립 — recent N messages(스레드 우선) + 토큰 예산 내 슬라이딩 윈도 + Memory Plane 조회. **Context Broker를 서버 서비스로 티켓화**(스펙은 이미 research/10·11에 완성).
3. **Inbound MCP 실구현:** JSON-RPC 전송으로 교체, 4개 도구(search/fetch_thread/post/create_tool_call) 실동작, `mcp.*` scope 발급 플로우(admin install). → 외부 에이전트(Claude Code, Codex CLI 등)가 momo를 도구로 쓰는 입구.
4. **A2A Agent Card:** `/.well-known/agent.json` + `agents/announce` 등록 플로우(openagents 단일 포트 레이아웃). 에이전트 초대 = Card fetch → member(kind=agent) 생성 → 채널 멤버십. "에이전트 초대가 자유로운" 목표의 프로토콜적 실현.
5. **AG-UI 정렬:** 기존 `agent.partial`/`agent.status`/`approval` envelope의 필드명·이벤트 종류를 AG-UI 어휘(RunStarted/ToolCallStart/ToolCallEnd/StateDelta/RunFinished)에 맞춰 정규화. 자체 발명 최소화 + 외부 프런트엔드 호환.
6. **BYOK:** `provider_config` 테이블(workspace 단위, 필요시 agent 단위 override) — base_url, 모델, **암호화된 key**(age/KMS 봉투 암호화, 평문 컬럼 금지), 회전 감사로그. UI = Settings > AI Providers. ADR-0004 경계 유지(Codex OAuth 토큰은 여전히 provider 소유).
7. **거버넌스 하드닝:** 루프가드 G1~G4 스텁 → 실제 PG 쿼리. `agent_run`에 `depth`/`round_count`/`consecutive_auto_count` 컬럼 추가(신규 마이그레이션). `tool_call` props에 `reversibility_tier` 추가. Codex의 **sandbox × approval 2축**을 채널 단위 에이전트 정책으로 채택(`read-only/workspace-write` × `untrusted/on-request/never`). Stop = 실행 트리 전체 kill + watchdog.

### Track D. 컨텍스트 엔진 — RAG + 온디바이스 (P3·P6 해소)

```
서버 (공유, SoT)                          클라 (온디바이스, 로컬 전용)
─────────────────────                    ─────────────────────────
pgvector ≥0.8.4 halfvec HNSW             FoundationModels (~3B, 4k ctx)
  ├ 임베딩 워커(서버측 단일 모델,           ├ 클라우드 호출 전 컨텍스트 압축
  │  BGE-M3급 멀티링구얼)                   ├ 스레드 제목/요약 (@Generable)
  ├ RRF 하이브리드(vector+FTS+trgm)         ├ 알림 트리아지(urgency enum)
  └ 채널/ACL 필터 → Context Broker 소비     └ LocalContextCopilot 확장(기존 자산)
                                          NLContextualEmbedding(512d, CJK)
                                            └ 알림 semantic dedup 등 로컬 전용
```

- **역할 분리 원칙:** 공유 인덱스 임베딩은 반드시 서버(모델 버전 단일성 — 혼합 OS 클라가 인덱스 오염). 온디바이스 임베딩은 벡터가 기기를 떠나지 않는 기능에만.
- Memory Plane v0 스펙 구현이 RAG의 쓰기 경로(typed memory + source attribution + retrieval-time 권한). "자체 RAG보다 좋은 구조" = **RAG + 권한 스냅샷 + 감사가능 출처**, 이미 스펙이 그렇게 설계돼 있음 — 구현만 하면 됨.
- 한국어: FTS 기본 파서 한계 → pg_trgm 가중 병행, 필요시 textsearch_ko. 온디바이스 4k 한계는 한국어에서 더 타이트(~1자/토큰) → TN3193 compaction 패턴 필수.

### Track E. 음성 입력

- **1순위: SpeechAnalyzer + SpeechTranscriber(`ko_KR`)** — macOS 26 내장, 바이너리 0MB, ANE 가속, volatile(라이브 캡션)/finalized(전송 페이로드) 스트리밍이 push-to-talk에 정확히 맞음.
- 폴백: 구 macOS = SFSpeechRecognizer, 옵션 플러그인 티어 = WhisperKit(MIT).
- UX: 컴포저 push-to-talk(hold-to-record) + 라이브 volatile 텍스트 → 손 떼면 finalized 삽입(전송 아님 — 검토 후 전송). 에이전트 멘션과 결합 시 "말로 김인턴 시키기"가 데모 킬러.
- 선행 과제: 한국어 WER 공개 벤치 부재 → 팀 음성 샘플로 자체 평가 1회.

### Track F. 보안 하드닝 (P5 해소, 순서 = 위험도순)

1. Centrifugo subscribe proxy **HMAC/공유 시크릿 검증** (현 TODO 해소 — 네트워크 가정에 의존하는 인증은 인증이 아님)
2. **토큰 revocation 검사** 모든 인증 경로에 + 로그아웃 엔드포인트, 클라 토큰은 **Keychain** 보관 명문화
3. **Rate limiting 미들웨어** (per-member/per-agent/per-IP) — 비용 브레이커와 별개 축
4. BYOK 키 **봉투 암호화 at rest** (Track C-6과 동일 작업)
5. audit_log `detail` **redaction 규약** (시크릿 패턴 스크럽을 쓰기 경로에 강제)
6. 보존 정책(per-workspace TTL) + 계정 삭제 캐스케이드
7. E2EE는 **명시적 non-goal 유지**(v0~v1): 서버가 Context Broker로 메시지를 읽어야 RAG·에이전트가 성립. 대신 "self-hosted = 데이터가 당신 인프라를 떠나지 않음 + provider 토큰 비보관(ADR-0004) + RLS FORCE + 감사로그"를 신뢰 스토리로 정면 배치. (토큰 탈취 대응 = 2번, 내부 문서 유출 대응 = self-host 경계 + retrieval 권한 체크)

---

## 4. 티켓 델타 제안 (MOMO-3XX)

| 제안 | 트랙 | 내용 | 우선순위 |
|---|---|---|---|
| MOMO-300 | F | subscribe proxy HMAC 검증 + 토큰 revocation 검사 + rate limit | **P0** |
| MOMO-301 | C | `agent_run` depth/round/consecutive_auto 컬럼 + 루프가드 G1~G4 실쿼리 | **P0** (설계된 안전장치의 미집행 상태 해소) |
| MOMO-302 | C | 컨텍스트 조립 v1: 단일 메시지 → recent-N/스레드/토큰 예산 윈도 | **P0** (에이전트 기억상실 해소) |
| MOMO-303 | A | MomoDS 토큰 4층 + ugly mode + 컴포넌트 1차 추출 7종 | **P0** |
| MOMO-304 | B | 마크다운/코드블록 렌더 + 편집/삭제 UX + @멘션 자동완성 | **P0** |
| MOMO-305 | B | 스레드 UI(= 에이전트 세션 경계) + unread/알림 | P1 |
| MOMO-306 | B | 검색 라우트+Cmd+K 팔레트 / 리액션 / 파일 업로드 | P1 |
| MOMO-307 | C | Context Broker 서버 서비스 (Context Packet v0 실조립) | P1 |
| MOMO-308 | C | Inbound MCP 실구현(JSON-RPC) + scope 발급 | P1 |
| MOMO-309 | C/F | BYOK provider_config + 봉투 암호화 + Settings UI | P1 |
| MOMO-310 | D | pgvector RAG 파이프라인(임베딩 워커 + RRF 하이브리드) + Memory Plane v0 구현 | P1 |
| MOMO-311 | D | FoundationModels 컨텍스트 압축(클라우드 호출 전) + 스레드 제목/트리아지 | P2 |
| MOMO-312 | E | SpeechTranscriber push-to-talk + 한국어 WER 자체 평가 | P2 |
| MOMO-313 | C | A2A Agent Card + agents/announce 초대 플로우 | P2 |
| MOMO-314 | C | reversibility_tier props + 승인 상태 라이프사이클 렌더(Codex 문법) | P2 |
| MOMO-315 | F | audit redaction 규약 + 보존 TTL + 계정 삭제 | P2 |

**로드맵 통합:** P0 4건은 M3(데스크탑 v0 UX) 진입 전 게이트로. P1은 M3 본체와 병행(MOMO-305/306은 M3의 실질 내용물). P2는 M4~M5 병행 트랙. 기존 M0~M8 골격과 M7 검수 게이트 불변식은 그대로 유지.

---

## 5. "왜 Slack이 아니라 momo인가"에 대한 답 (재설계 후)

1. **에이전트가 봇이 아니라 멤버다** — presence·lifecycle·비용·감사를 가진 member(kind=agent). Slack 봇은 웹훅이다.
2. **타임라인이 실행 원장이다** — tool call·승인·diff·비용이 채팅 버블이 아니라 상태 라이프사이클을 가진 1급 메시지 (Codex의 문법을 팀 채널로).
3. **컨텍스트가 거버넌스된다** — 에이전트가 보는 모든 것이 Context Packet(권한 스냅샷+출처+redaction)으로 감사 가능. 외부 봇 런타임으로 워크스페이스 데이터가 새지 않는다.
4. **당신의 인프라, 당신의 키** — self-hosted + BYOK + provider 토큰 비보관 + RLS. 토큰 탈취·내부 문서 유출 걱정의 구조적 해소.
5. **맥에서 진짜 네이티브** — Electron이 아닌 SwiftUI + 온디바이스 AI(요약·압축·트리아지는 기기에서 공짜로) + OS 내장 한국어 음성 입력.
6. **표준으로 열려 있다** — MCP로 도구가 되고, A2A로 에이전트를 초대하고, AG-UI로 렌더가 호환된다.

이 6개 중 1·2번의 뼈대는 이미 있다. 3~6번이 이 문서의 재설계이고, **그 전제인 "메신저로서 매일 살 수 있는 기본기"(Track A·B)가 첫 삽**이다.
