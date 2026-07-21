# 외부 리서치 ② — 셀프호스팅 에이전트 메모리 OSS 지형과 momo 내장 설계 패턴 (2026-07-21, Fable · PLN-20260721-01)

> 조사 기준: 모든 라이선스는 GitHub API(`repos/{repo}/license`)로 LICENSE 원문 직접 확인(2026-07-21). momo 제약(PG18=단일 SoT, Swift Hummingbird, RLS FORCE, permissive만 허용·AGPL 백본 금지)을 판정 축으로 사용.

## §1. 프로젝트별 실태

### 1.1 비교표

| 프로젝트 | 라이선스(레포 확인) | 아키텍처 계층 | 저장 백엔드(PG/pgvector) | API 형태 | 멀티테넌시 | 가시화 UI | 성숙도(스타·최근 push) |
|---|---|---|---|---|---|---|---|
| **mem0** (+OpenMemory) | **Apache-2.0** ✅ | 벡터(사실 레코드)+선택 그래프, 2-phase 추출 | vector store 플러그블, **pgvector 지원**·OSS 서버 기본 FastAPI+PG(+Neo4j 선택) | Python/TS SDK, REST, **MCP**(OpenMemory) | `user_id/agent_id/run_id`(플랫폼판 org/project 추가) | **OpenMemory 대시보드**(보기/편집/pause/앱별 ACL/접근로그) | 61.4k, push 2026-07-21 |
| **Letta** (구 MemGPT) | **Apache-2.0** ✅ | core memory block(항상 in-context)+archival(벡터)+MemFS(git 파일) | **PG+pgvector 필수**(서버 상태 전체 PG) | REST+SDK. 구 레포 legacy, **letta-code(App Server)로 이동** | agent 단위, memory block 공유 | ADE에서 블록 열람/편집 | 23.9k+2.9k, push 2026-07-21 |
| **Zep** | CE **2025-04 폐기** ❌ | temporal KG → Cloud 전용 | — | Cloud SDK만 | — | Cloud | 예제 레포로 전환 |
| **Graphiti** (Zep 엔진) | **Apache-2.0** ✅ | **bi-temporal 지식그래프**(valid_at/invalid_at) | 그래프DB 필요: Neo4j(GPLv3)·FalkorDB(**SSPLv1**)·Kuzu(MIT, **2025-10 아카이브**)·Neptune. **PG 백엔드 없음** | Python+REST+**MCP** | group_id | 없음 | 29.0k, push 2026-07-20 |
| **cognee** | **Apache-2.0** ✅ | ECL 파이프라인, 관계형+벡터+그래프 3계층 | 3계층 플러그블: relational(**PG**), vector(**pgvector**), graph(Kuzu/Neo4j/NetworkX) | Python+REST+MCP | dataset/user | 그래프 시각화 일부 | 28.9k, push 2026-07-21 |
| **Hindsight** (vectorize-io, 2025-10 등장) | **MIT** ✅ | retain/recall/consolidate. **4중 검색: semantic+BM25+graph+temporal**+cross-encoder 리랭커 | **Postgres 단일 백엔드**(그래프도 PG 위) | REST+SDK+LLM 래퍼+MCP | bank 단위 | **UI 동봉**(:9999) | 18.6k(9개월), push 2026-07-21. LongMemEval SOTA 주장 |
| **memobase** | **Apache-2.0** ✅ | **user profile(구조화 슬롯)+event timeline** 이원, 버퍼 배치 | FastAPI+PG+Redis | REST+SDK | user 단위 | Playground | 2.8k, **push 2026-01(정체)** |
| **LangMem** | **MIT** ✅ | 라이브러리: semantic/episodic/procedural 3형, hot-path 툴+background manager | LangGraph BaseStore(**PG 가능**) | Python SDK만 | namespace 튜플 | 없음 | 1.6k, pre-1.0 |
| **supermemory** | **MIT** ✅(개방 범위 상충 정보 — 미검증) | 문서 RAG+메모리, hybrid | 호스티드 우선, 엔터프라이즈 셀프호스트 CF Workers+PG | REST+SDK+MCP | containerTag | 콘솔 | 28.5k |
| **MemOS** (MemTensor) | **Apache-2.0** ✅ | MemCube(plaintext/KV-cache/parametric 3층)+MemScheduler | 셀프호스트 시 **Neo4j+Qdrant 필요** | REST+SDK | **Multi-Cube**(user/project/agent 격리·공유·조합) | inspectable 표방 | 10.3k |
| **memU** | **Apache-2.0** ✅ | "파일로서의 메모리": Markdown 작성→임베딩→랭킹. 500줄 | 파일+플러그블 | Python+SKILL.md | 개인용 | 파일 자체 | 14.0k |
| **Memori** | **Apache-2.0** ✅ | SQL-네이티브 → Cloud 우선 피벗 | PG/MySQL/SQLite 직결 | SDK(Cloud 키 요구) | org/workspace(Cloud) | Cloud | 15.6k |
| **A-MEM** | **MIT** ✅ | Zettelkasten식 노트 자동 연결·진화 | 연구 코드 | Python | 없음 | 없음 | 1.1k, 연구용 |
| **Honcho** | **AGPL-3.0** ❌ **탈락** | 유저 심리모델링 | PG | REST | — | — | 6.1k |

### 1.2 핵심 상술

- **mem0**: 사실상의 레퍼런스. 논문(arXiv:2504.19413) **2-phase 파이프라인** — ①추출(대화→후보 사실) ②갱신(기존 메모리 대조 → LLM tool call로 **ADD/UPDATE/DELETE/NOOP**). OpenMemory에서 가져갈 것은 스택이 아니라 **UI/ACL 패턴**(§4).
- **Letta**: 메모리 서버가 아니라 에이전트 런타임 전체. momo처럼 자체 런타임이 있는 시스템에는 **아키텍처 참고용**(core memory block=항상 상주하는 self-editing 블록 / archival=벡터층 분리).
- **Zep/Graphiti**: CE 2025-04 공식 폐기. Graphiti는 엔진일 뿐 그래프DB 조달이 필요한데 **백엔드 선택지가 전부 momo 라이선스와 충돌**(Neo4j GPLv3/FalkorDB SSPL/Kuzu 사망). 가치는 코드가 아니라 **bi-temporal 무효화 설계**(사실을 지우지 않고 `invalid_at`).
- **cognee**: PG+pgvector 공식 지원 유일 그래프형 후보. 단 기본 그래프 계층 Kuzu(아카이브) 리스크, GraphRAG 성격이라 대화 메모리와는 결이 다름.
- **Hindsight**: **MIT+PG 단일 백엔드**에 4중 검색·리랭커·REST·UI 동봉. **"그래프 전용 DB 없이 PG 위에서 그래프 포함 메모리 시스템 성립"의 가장 강력한 실증** — momo 라이선스 필터 통과 후보 중 완성도 최고.
- **1st-party 벤치마크**: Anthropic memory tool(`memory_20250818`) — 클라이언트 측 파일 디렉토리에 6개 명령, **저장은 호출자(서버) 관할** = momo의 "서버가 메모리를 관리하고 서빙"과 동일한 책임 분리. claude.ai는 프로젝트 스코프 자동 메모리+직접 열람/편집. OpenAI는 saved memories+reference chat history 이원 → 2026-06 "Dreaming V3" 백그라운드 합성(회상 41.5%→82.8% 주장), **Enterprise 기본 off(관리자 opt-in)·워크스페이스 끄면 삭제·학습 제외**.

## §2. 공통 설계 패턴

**(a) 추출 파이프라인** — `원문 → 후보 사실 추출(LLM) → 기존 메모리 유사도 대조 → ADD/UPDATE/DELETE(무효화)/NOOP → 반영`. 변주: ①**삭제 대신 무효화**(Graphiti `invalid_at` — 감사가능성 필요한 조직 메모리에 적합) ②**hot-path vs background** 이원화(LangMem 명시적, Letta=hot 극단, ChatGPT=background 극단).

**(b) 저장 계층** — 최소 구조: **구조화 사실 레코드 + 임베딩 인덱스 + 원문 에피소드 링크(출처)** + 선택적 그래프/프로필. 2025-26의 뚜렷한 방향: **"파일/레코드가 1급, 임베딩은 파생 인덱스"**(memU·Letta MemFS·Claude memory tool).

**(c) 검색/서빙** — 하이브리드가 표준(semantic+BM25+graph+temporal→리랭커). 서빙 이원: ①질의 시점 조립(검색→리랭킹→토큰 예산 절사) ②상시 상주 블록(Letta core/memobase 프로필, <100ms). 성숙 시스템은 겸비.

**(d) 스코프 모델** — **org/workspace → user → agent → session(run) 4단 + 명시적 공유 단위**로 수렴(mem0/LangMem/Zep/MemOS/OpenMemory·Claude·ChatGPT 공통). **momo RLS FORCE 멀티테넌시와 자연 동형.**

## §3. Postgres-native 구현 타당성 — **타당. momo 규모·제약에서는 PG 단일이 오히려 정합적**

1. **pgvector v0.8.5**(PostgreSQL License — permissive). 0.8.x iterative index scan이 overfiltering 해소 → `WHERE workspace_id=... AND scope=...`+벡터 검색(=RLS/테넌트 필터 패턴) 실용화. 워크스페이스 메모리는 수만~수십만 행 — HNSW 한계(수백만)까지 여유. 초과 시 pgvectorscale(PostgreSQL License) 승급.
2. **하이브리드 검색**: `tsvector`+pgvector+**RRF SQL 함수** 합성이 정착된 표준 레시피(Supabase 공식). 한국어는 pg_trgm 보조(메시지 검색과 동일 과제).
3. **그래프를 PG로**: ①엣지 테이블+재귀 CTE(메모리 그래프는 1~2-hop — **Hindsight가 전체를 PG 단일로 실증**) ②Apache AGE(Apache-2.0, PG 11~18) 승급 경로 ③그래프 생략(mem0에서도 선택 계층). 그래프 전용 DB는 라이선스 전멸 지대 — **PG 표현이 유일한 permissive 경로**.
4. **momo 불변식 정합**: memory 테이블에 workspace_id+RLS FORCE → 기존 멀티테넌시 편입. 추출 파이프라인=outbox 소비 비동기 워커. 메모리 갱신 이벤트도 동일 경로로 realtime 반영. **탈락 확장**: VectorChord(AGPL/ELv2), ParadeDB pg_search(AGPL).

## §4. momo 적용 권고

**라이선스 통과**: mem0·Hindsight·cognee·LangMem·Graphiti(설계만)·memobase·MemOS(Neo4j 의존 주의)·memU·supermemory(검증 필요). **탈락**: Honcho(AGPL)·Zep CE(폐기)·VectorChord/pg_search(AGPL)·FalkorDB(SSPL)·Neo4j CE(GPLv3).

- **A. 내장(자체구현 PG-native)**: 불변식 완전 보존·메모리가 메시지와 같은 거버넌스(권한·감사·백업)·라이선스 무결·외부 런타임 0. 단 추출 품질 직접 구축(mem0 논문+공개 프롬프트로 설계 리스크 낮음, 튜닝 비용 문제로 수렴).
- **B. 사이드카(mem0 서버/Hindsight 컨테이너)**: 착수 최소·검증된 품질·UI 동봉. 그러나 **제2의 SoT 발생** — "PG=단일 SoT" 정면 충돌, 멀티테넌시가 RLS→앱레벨 필터로 격하, Python 런타임 운영 부담, momo 클라에 UI 재구축 시 이점 소멸.
- **C. 하이브리드(권고 1안)**: **스키마·저장·서빙·거버넌스는 momo PG 내장(A) + 파이프라인 설계는 검증된 오픈 패턴 이식 + Hindsight를 개발 중 대조군 사이드카로만 병행.**
  - 이식 패턴: ①mem0 2-phase ②Graphiti `invalid_at` 무효화 ③memobase식 "프로필 상시 주입+사실/에피소드 질의 시 조립+토큰 예산" ④FTS+pgvector+RRF 하이브리드 ⑤스코프 `workspace→member→agent→conversation` 4단(RLS 강제).
  - 근거: momo에서 메모리는 **사용자가 보고 편집하는 제품 표면** = 메시지와 동급의 도메인 데이터 — 별도 SoT는 하드 룰과 양립 불가. 라이선스상 그래프DB 전멸이라 PG-native가 유일 경로.

**가시성/거버넌스 UX 이식**:
- OpenMemory: 상태 3단(active/paused/archived)·에이전트별 접근 토글·메모리별 접근 로그·`access_controls`(앱-메모리 allow/deny) — RLS 정책 직결 가능.
- ChatGPT: 항목 열람/수정/삭제+"Memory updated" 인라인 알림+**워크스페이스 관리자 통제(기본 off·끄면 삭제·학습 제외)**.
- Claude: 프로젝트(채널/워크스페이스)별 격리+요약 직접 편집. memory tool의 "저장은 호출자 관할" = momo 서버가 에이전트에게 메모리 툴을 노출하되 저장·권한은 서버 집행과 동형.
- **momo 고유 차별화**: 워크스페이스 메모리를 **채널처럼 브라우징하는 1급 객체**("에이전트가 아는 것" 뷰 + **각 항목의 출처 메시지 역링크** + 수정/무효화 이력) — 세 선례 중 어디에도 없는, 메신저만 가능한 지점.

## §출처 (모두 2026-07-21 확인)

**레포 직접 확인(GitHub API)**: mem0ai/mem0 · letta-ai/letta · letta-ai/letta-code · getzep/zep · getzep/graphiti · topoteretes/cognee · memodb-io/memobase · langchain-ai/langmem · supermemoryai/supermemory · MemTensor/MemOS · agiresearch/A-mem · MemoriLabs/Memori · NevaMind-AI/memU · vectorize-io/hindsight · plastic-labs/honcho(AGPL) · kuzudb/kuzu(archived) · FalkorDB/FalkorDB(SSPLv1) · pgvector/pgvector(v0.8.5) · timescale/pgvectorscale

**웹 문서**: mem0.ai/blog/self-host-mem0-docker · arXiv:2504.19413 · mem0.ai/blog/introducing-openmemory-mcp · docs.mem0.ai/openmemory/overview · blog.getzep.com/announcing-a-new-direction-for-zeps-open-source-strategy · help.getzep.com/faq · help.getzep.com/graphiti · docs.letta.com/guides/selfhosting · aws.amazon.com/blogs/database/how-letta-builds-production-ready-ai-agents-with-amazon-aurora-postgresql · docs.cognee.ai · memos-docs.openmem.net · arXiv:2505.22101 · langchain-ai.github.io/langmem · supermemory.ai/docs/self-hosting · hindsight.vectorize.io/blog/2026/07/17/hermes-hindsight-open-stack · platform.claude.com/docs(memory tool) · openai.com/index/memory-and-new-controls-for-chatgpt · openai.com/index/chatgpt-memory-dreaming(2026-06) · help.openai.com(Memory FAQ Business) · postgresql.org(pgvector 0.8.0) · dbi-services.com(pgvector DBA 2026-03) · supabase.com/docs/guides/ai/hybrid-search · github.com/apache/age · docs.vectorchord.ai(AGPL/ELv2) · github.com/paradedb/paradedb(AGPL) · vectorize.io/articles/best-ai-agent-memory-systems

**미확인/유보**: supermemory 코드 개방 범위(제3자 "셀프호스트 불가" vs README "local 바이너리" 상충), Memgraph(BSL) 세부, MemOS의 Neo4j Community 호환 세부.
