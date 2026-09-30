# ADR-0196: 팀 기억 v2 — 요약을 첫 계층으로, 권한은 RLS로, 자체 구축 (ADR-0129 대체)

- Status: **Accepted** (2026-09-29 성재 결재. 근거는 아래 인용)
- Date: 2026-09-29
- Deciders: 성재
- 결재 인용: 성재 2026-09-29 「M1뿐만 아니라 M3까지 완성하고 출시하고 싶어. 나머진 권장대로」. 팀 기억 계획 결재 질문 Q1=B(M1~M3를 지금 목표 A에 넣고 출시), Q2~Q12는 권장안 전부다. 방향 지시는 성재 2026-09-29 「예전 설계는 쓰지 않고 새로 설계한다. 외부 라이브러리는 읽고 배워서 우리 코드로 짓는 쪽을 기본으로 한다」.
- 대체: **ADR-0129(Memory Plane & Context Fabric 런타임)를 대체(Superseded)한다.** 이슈 #596(MOMO-526, 예전 설계의 추출 워커)도 이 ADR로 대체된다.
- 기안: Opus 5.5 worker(#3158)
- 근거 자료: 계획 `claudedocs/memory-research/plan.md`, 현재 상태 `current-state.md`, 외부 레퍼런스 `external.md`(같은 폴더). 모두 gitignore 대상이라 로컬에만 있다. 이 ADR이 결정에 필요한 사실과 근거(file:line)를 옮겨 담는다.
- 관계: ADR-0100(DB 계약·공개 API·보안 경계는 Accepted ADR이 머지 조건), ADR-0187(목표 A: 팀이 데스크탑·iOS로 매일 쓰기), ADR-0129(대체 대상), ADR-0145 증보1(memories 「판정 보류」 패밀리 — 이 ADR이 판정한다), ADR-0147(기본 AI `summary` 행), ADR-0122(허들 요약, #2771), ADR-0173(교차 채널 검색), ADR-0194(연결 도구가 원본인 작업 상태), ADR-0184(셀프호스트·Railway), ADR-0004(자격 원문 비유입). 「ADR-0146」은 서명 ADR이라 기억과 무관하다.
- 표기: [V] 원문·코드 직접 확인 · [S] 요약·스니펫만 확인 · [?] 확인 못 함 · **[추정]** 계산값(측정 아님) · `runtime-unverified` 실행 안 함. 코드 줄은 main `83ae2f0c1` 기준이다.

## 맥락

### 현재 사실 (코드·문서)

1. **지금 에이전트의 기억은 같은 채널 최근 30건이 전부다.** 창 크기 기본 30(1~200)은 `server-rust/crates/momo-agent/src/mention.rs:62-65`, 창 조립은 `crates/momo-messaging/src/message.rs:1906`(`agent_context_window_in_tx`, 스레드 우선 후 채널 보충), 본문 2,000자 절단은 `message.rs:1911`, 문자 예산 24,000자에서 오래된 턴부터 버리는 것은 `bins/momo-agent-worker/src/context.rs:148-238`·`config.rs:211`이다. `memory_refs`는 `context.rs:12-16`·`mention.rs:682`에서 의도적으로 이식하지 않았다. 채널 요약은 없다(#3147 OPEN). 메시지 검색은 ILIKE+pg_trgm 시간순이고 랭킹이 없다(`crates/momo-messaging/src/search.rs`). MCP는 10개 도구뿐이고 검색·기억 도구가 없다(`crates/momo-mcp/src/tools.rs:74-87`).
2. **예전 기억 스키마는 소비자 0으로 살아 있다.** 마이그레이션 027(`memory_item` 등 7테이블 RLS FORCE)·028(`vector(384)` HNSW, tsvector `'simple'` GIN, `memory_search_hybrid()` RRF k=60)·030(`context_packet`)·035(`workspace.memory_external_provider_consent`)가 매 배포 적용되지만 Rust 소비자가 없다. 소유자였던 Swift 서버·워커는 `8f4a23cac`(2026-09-07, #2165)에서 삭제됐고 원본은 `4dc75f2e4`다. 웹 `AgentHubRoute.tsx:1137 AgentMemorySection`은 완성돼 있으나 서버가 없어 `serverSurfaces.ts:333-342`에서 `agentMemory.provided:false`로 접혀 있다. 클라이언트 API는 `packages/momo-core/src/lib/api.ts:4657-4870`. env `MEMORY_EXTRACTION_*`·`MEMORY_EMBEDDING_*`는 `infra/.env.example:268-278`에 남아 있다.
3. **목표 A(ADR-0187 D1)에서 팀이 매일 느낄 가치는 둘이다.** ① 자리를 비운 사이 채널·스레드에서 무슨 일이 있었는지 한눈에 보는 요약, ② 에이전트가 30건 밖의 결정·담당·약속을 잊지 않는 것. `ROADMAP.md:62`는 agent-memory를 「외부 출시 뒤 재취사」로 미뤄 뒀는데, 이번 결재가 그 줄을 바꾼다.
4. **ADR-0129를 대체하는 이유.** 0129는 Swift 서버·워커·Swift macOS 표면을 전제로 한 실장 결정(D1 `memory_item` 4테이블, D2 outbox 추출 워커, D4 Context Packet v0 `memory_refs`)이었고, 그 실행 트리가 삭제됐다. 성재가 예전 설계를 쓰지 않기로 했고 Q2=A(증보 아님, 대체)다. 증보로 두면 살아 있는 결정과 죽은 결정이 뒤섞인다.

### 외부 레퍼런스 조사 요지

계획 시점에 클론한 7개 레퍼런스(company-brain `ef8a45e`, graphiti `ea4ac0f`, hindsight `1e42702`, mem0 `94c3fe9`, letta-archive `56ba9c2`, langmem `9d033b4`, cognee `c4cd8ce`)를 읽었다. 서버에 그대로 링크할 수 있는 기억 엔진은 없다. 사이드카(mem0 서버·Hindsight·cognee)는 제2의 원본을 만들고 RLS 밖에서 격리되며(Hindsight는 앱 필터 `bank_id`), 그래프 전용 DB는 라이선스로 탈락한다(Neo4j GPL·FalkorDB SSPL·Kuzu 아카이브). 조사한 레퍼런스 어느 것도 「근거를 볼 수 있는 사람만 읽는다」를 DB 정책으로 집행하지 않는다. 이것이 oort 설계의 차이다.

## 결정

### D1. 자체 구축을 기본으로 한다 (Q4=A)

- 기억 엔진은 **우리 Rust와 PG 안에 새로 짓는다.** 레퍼런스에서는 **알고리즘·프롬프트·데이터 모델만 이식**한다. 사이드카·파이썬 서버·외부 SaaS 기억 저장소는 쓰지 않는다.
- **채택(프로세스·DB 안에 들어오는 것) 3개**: ① `pg_trgm`(이미 설치, `server/Migrations/001_init.sql:8,196`) — 부분일치 보조. ② `pgvector`(이미 이미지에 있음, `pgvector/pgvector:0.8.5-pg18-trixie`) — M3. ③ 한국어 토큰화 — **자체 한글 bigram 또는 lindera(Rust 형태소, ko-dic)**를 M0 스파이크(#3159) 결과로 고른다(Q5=A). 채택 전 라이선스(lindera·ko-dic)를 확인하고 NOTICE·GHCR 고지 번들을 반영한다(R3).
- **탈락**: `timescale/pg_textsearch`(text_config를 받지만 PG에 한국어 설정이 없어 `'simple'` 공백 토큰화보다 나을 게 없다. Hindsight도 영어로 고정해 쓴다 — `hindsight_api/config.py:1465-1468`), pgroonga·pg_bigm(라이선스 [?]·이미지 확장 추가 필요, 스파이크 후보에서도 뺌), Khoj·basic-memory(AGPL), ParadeDB·VectorChord(AGPL/ELv2), supermemory 서버(소스 비공개 바이너리).
- **참고만(코드 이식 없음)**: Letta(상시 블록과 검색 계층 분리 개념 — `letta/schemas/memory.py`, `letta/services/summarizer/summarizer.py`), LangMem(도구로 즉시 기록 + 지연 백그라운드 반영 분리 — `src/langmem/short_term/summarization.py`), cognee(PG 그래프 어댑터가 스스로 「DEMO, not production-ready」), `@supermemory/memory-graph`(그래프 뷰는 M4에서 d3-force로 자체 구현, 라이선스 [?]).

### D2. 이식 목록과 원본 위치, 귀속

원본 위치는 각 레퍼런스 클론 기준이다. 이식하는 문장·프롬프트는 번역·변형해도 **NOTICE에 출처를 적고** `python3 scripts/generate_ghcr_notice_bundle.py generate`로 고지 번들을 재생성한다(구현 PR의 머지 조건).

| 레퍼런스 | 라이선스 | 이식 요소 → 원본 위치 |
|---|---|---|
| company-brain (supermemory) | Apache-2.0 | ① 수집 정책 문장(영구 vs 감쇠, **연결 도구가 원본인 상태는 저장 금지**, 잡담·시크릿 금지) `src/brain/memory/profile-config.ts:8-16` `BRAIN_CAPTURE_POLICY` ② 배치 큐레이션 프롬프트(봇 발언은 사실로 쓰지 않음, 원문·날짜 보존, 배치당 ≤6 클러스터) `src/brain/slack/channel-observe.ts:55` `DISTILL_SYSTEM` ③ 배치 파라미터(지연 180s, 최대 60건, 8,000자) 같은 파일 `:32-38` ④ **주제 자동 분할**(노드 ≥125면 160개 샘플로 2~4 하위 주제, 노드별 락) `src/brain/memory/split.ts:21-22,53-75` ⑤ 리셋 세대(`resetEpoch`로 리셋 전 쓰기 차단) `src/brain/memory/entities.ts:55-63` ⑥ 읽기 범위 = 묻는 사람 권한 합집합(DM 규칙만 채택, D6) `src/brain/memory/read-scope.ts:12` ⑦ 날짜 앵커 `src/brain/memory/writeback.ts:153-156` |
| mem0 v3 | Apache-2.0 | ① **추가만(ADD-only) 단일 패스 추출** 프롬프트 `mem0/configs/prompts.py:468` `ADDITIVE_EXTRACTION_PROMPT` ② 점수 융합(BM25 정규화 시그모이드 + 엔티티 부스트) `mem0/utils/scoring.py:16-60`, `mem0/memory/main.py:1747` `_compute_entity_boosts` ③ 백그라운드 정리 3동작(Supersede·Merge, Synthesis 옵트인, 원본 보존 + 근거 링크)은 **플랫폼 기능 문서만 있고 OSS 코드는 없다**(`docs/platform/features/dream.mdx` [S]) — 정리 알고리즘은 Hindsight 코드와 Graphiti 식을 조합해 새로 짠다(R8) |
| Graphiti (Zep) | Apache-2.0 | ① **모순 판정식**: 구간이 안 겹치면 둘 다 유효, 기존 `valid_at` < 새 `valid_at`이면 기존 `invalid_at = 새 valid_at`, 시스템 시간 `expired_at = now` — `graphiti_core/utils/maintenance/edge_operations.py:538-570` ② bi-temporal 필드(사실 시간 vs 시스템 시간) `graphiti_core/edges.py:271-277` ③ **Saga 증분 요약**(에피소드 체인을 워터마크로 이어 요약) `graphiti_core/prompts/summarize_sagas.py:26-41`, `graphiti.py:449` ④ Community 요약 `utils/maintenance/community_operations.py:216` ⑤ RRF `search/search_utils.py:1775`. 그래프 DB 자체는 쓰지 않고 시간 모델·요약 계층만 이식 |
| Hindsight (vectorize-io) | MIT | **1순위 참고**(PG+pgvector 단일 백엔드). ① consolidation(중복 판정 → 합치기 fold, 시간 경계) `hindsight_api/engine/consolidation/consolidator.py:137-560`, 프롬프트 `consolidation/prompts.py:14-120` ② RRF k=60 + 부스트 `engine/search/fusion.py:29`, `search/recall_boost.py:115` ③ BM25 검색어 선택 `search/bm25_term_selection.py` ④ 관찰·철회 `engine/reflect/observations.py`, `reflect/retractions.py` ⑤ 한국어 실측 근거 `config.py:1465-1468`, `migrations.py:1143-1160`(pgroonga `TokenBigram`은 CJK를 2-gram으로 처리) |

### D3. 기억 계층과 데이터 모델 (Q3=A)

**팀 기억(채널 공간 + 개인 공간 + 에이전트 자기 규범)을 한 기질로 둔다.** 사람이 보는 요약과 에이전트 컨텍스트가 같은 행을 읽는다.

| 층 | 이름 | 내용 | 만드는 주체 | 단계 |
|---|---|---|---|---|
| L0 | 원문 | `message` 원장. **기억에 복사하지 않고 링크만** | — | 고정 |
| L1 | 요약(digest) | 채널·스레드 구간(창) 요약 → 일간 → 주간 롤업 | 요약 워커 | M1 |
| L2 | 항목(item) | 결정·사실·약속(담당·기한)·선호·절차. 근거 메시지 링크 1개 이상 필수 | 추출(요약과 **같은 LLM 호출**), 사람 「기억해 줘」, 에이전트 제안 카드 | M2 |
| L3 | 주제(topic) | 주제 트리 노드 + 노드 요약(합성). **같은 채널(공간) 안에서만 합성**(Q12=A) | 정리 잡 | M3 |
| 상시 | 프로필 블록 | 팀 규범·에이전트 자기 규범·개인 선호. 에이전트 컨텍스트에 항상 실림 | 사람이 편집 | M2 |

L2를 L1과 같은 호출로 뽑는다(`{요약, 항목 후보[]}`) — 비용이 거의 늘지 않는다. L2만 먼저(mem0식)는 사람에게 보이는 가치가 늦게 와서 목표 A와 맞지 않고, 요약 없이 검색만은 에이전트가 30건 밖을 여전히 모르고 사람이 매일 쓸 표면도 없다.

**새 테이블(모두 신규 migration, `server/Migrations/`, 이름은 `mem_*`)**

| 테이블 | 핵심 칼럼 | 비고 |
|---|---|---|
| `mem_digest` | `workspace_id, channel_id, thread_root_id?, level(window/day/week), from_seq, to_seq, body, source_count, model, prompt_version, stale, created_at` | L1. `(channel_id, level, to_seq)` 유니크로 멱등 |
| `mem_cursor` | `workspace_id, channel_id, last_seq, lease_token, leased_until` | 채널별 워터마크. **요약 적용과 같은 tx에서만 전진**(충돌 시 구간 누락 방지) |
| `mem_item` | `workspace_id, space_kind(channel/personal/agent_self), channel_id?, owner_member_id?, agent_member_id?, kind(decision/fact/commitment/preference/procedure), origin(extracted/confirmed/curated/synthesized), body, subject_key?, valid_from, valid_to?`(사실 시간)`, recorded_at, retired_at?, retired_reason?`(시스템 시간)`, supersedes_id?, merged_into_id?, confidence, reinforce_count, last_seen_at, forget_after?, topic_id?, content_hash, extractor_version, terms tsvector, embedding vector(N)?` | L2. `content_hash`로 같은 날 같은 내용 멱등 |
| `mem_evidence` | `workspace_id, item_id \| digest_id, message_id, channel_id` | 근거 링크. **본문·발췌 저장 금지**(id만) |
| `mem_topic` | `workspace_id, channel_id?, parent_id?, path, label, live_count, summary, summary_evidence_hash, split_lock_until` | L3. 공간(채널)별 트리 |
| `mem_event` | `workspace_id, target_kind, target_id, action(created/confirmed/edited/merged/superseded/retired/forgotten/served/withheld/reset), actor_member_id?, detail jsonb, created_at` | 감사 원장. **잊기는 본문 없이 id만 남긴다** |
| `mem_serving` | `workspace_id, run_id, digest_ids[], item_ids[], withheld_count, budget_chars, used_chars, created_at` | 에이전트 한 턴의 영수증 |
| `mem_settings` | 워크스페이스: `enabled, paused, daily_token_cap, reset_epoch` · 채널: `excluded` · 개인: `paused` | 스위치(D9) |

- 모든 테이블은 `workspace_id` + RLS ENABLE/FORCE + 테넌트 정책이고, D6의 읽기 정책이 더해진다. 신규 테넌트 테이블이라 RLS 정책 대상이다(AGENTS.md). 쓰기 경로에 BYPASSRLS를 쓰지 않는다. Rust는 라이브 DB를 요구하는 `query!` 대신 sqlx 런타임 쿼리를 쓴다.
- **결정 변경은 행을 고치지 않고 새 항목을 추가하고 옛 항목의 `valid_to`를 닫는다**(Graphiti 식). `retired_*`는 「틀렸다·잊었다·병합됐다」처럼 시스템이 내리는 것이고 `valid_to`는 「예전엔 맞았지만 지금은 아니다」이다. 둘을 섞지 않아야 결정 타임라인이 그려진다.
- 벡터 칼럼 차원은 새 테이블이라 자유롭다. M3 결정(D8) 전에는 칼럼을 만들지 않는다.

### D4. 쓰기는 추가만, 정리는 백그라운드

| 경로 | 하는 일 | 하지 않는 일 |
|---|---|---|
| 쓰기(핫 패스) | 요약 워커가 구간을 읽고 `{digest, item 후보[]}`를 **추가만** 한다. 후보는 `origin=extracted`, 근거 message id 필수. 사람의 「기억해 줘」·제안 카드 수락은 `origin=confirmed` | 기존 항목 수정·삭제·병합(mem0 v3 원칙 — `prompts.py:468`) |
| 정리(백그라운드) | ① 중복 병합(같은 공간·같은 kind, 키워드 유사도 또는 벡터 거리 후보 → LLM 판정 → 근거를 합치고 한쪽 `merged_into_id`) ② 모순 시 기간 닫기 ③ 감쇠(`forget_after` 경과 + 재관찰 없음 → `retired_reason=decayed`) ④ 주제 배정·분할 ⑤ 주제 요약 재합성 ⑥ 요약 롤업(창→일→주) | `origin=curated/confirmed` 항목의 자동 감쇠·자동 병합(사람이 확정한 것은 사람에게 제안만) |

- 모든 정리는 `mem_event`에 남기고 되돌릴 수 있어야 한다. 추가만 + 기간 닫기이므로 원본은 남는다.
- **입력 필터(수집 정책)**: 잡담·시크릿·추측은 제외한다. **에이전트·봇 발언은 맥락으로만 읽고 사실로 쓰지 않는다.** **연결 도구가 원본인 상태(PR·이슈 상태, 배포, 지표, 캘린더, 작업 링크 상태 — ADR-0194)는 저장하지 않고 매번 라이브로 조회한다.** 날짜가 걸린 사실에는 `YYYY-MM-DD`를 본문에 넣는다. 시크릿은 LLM 호출 전에 간단한 패턴으로 차단한다.

### D5. 검색과 융합

- **신호**: ① 키워드(한국어 토큰 `terms tsvector`, 토큰화는 스파이크로 결정) ② `pg_trgm` 부분일치 보조(두 음절 한국어는 trigram 인덱스를 잘 못 탈 수 있어 스파이크에서 실측 — R4) ③ 벡터(M3, D8) ④ 엔티티·주제 부스트(같은 `subject_key`·`topic_id`) ⑤ 시간(현재 유효 `valid_to IS NULL` 우선, 최근성).
- **융합**: RRF k=60(Hindsight `fusion.py:29`, Graphiti `search_utils.py:1775` 이식) → 상위 N.
- **권한은 검색 SQL 바깥에서 거르지 않는다.** RLS 정책이 행을 가리고, 청중 축소(D6-4)는 같은 쿼리 안의 좁히기 술어로만 한다. 앱 계층 사후 필터 금지는 ADR-0129 증보1에서 이어받는다.
- 메시지 검색(#500, ILIKE+trgm)과 별개다. 한국어 토큰화 스파이크 결과는 #500에도 넘긴다.

### D6. 권한 — 가장 좁은 곳에 저장, 근거를 전부 읽을 수 있을 때만 읽는다 (Q6=A, Q12=A)

1. **가장 좁은 곳에 저장**: 항목·요약은 근거가 나온 **채널 하나**(또는 개인 공간)에만 쓴다. 여러 채널을 합친 항목은 만들지 않는다. 주제 합성도 채널 안에서만 한다. (합성을 여러 채널로 넓히면 결과가 근거 채널 모두의 멤버에게만 보여 거의 아무에게도 안 보일 수 있고, 공개 채널 근거 합성은 R1 확인이 필요해 채택하지 않았다.)
2. **읽기 = 근거를 전부 읽을 수 있을 때만**: 행의 모든 `mem_evidence.channel_id`를 뷰어가 지금 읽을 수 있고 근거 메시지가 `state <> 'deleted'`일 때만 보인다. 근거가 하나라도 안 보이면 행 전체를 가린다(합성 기억은 근거 채널 **교집합**으로만 보임). 요약(digest)도 같은 규칙이다. 40건 구간에서 한 건만 지워져도 그 요약은 다시 만들어질 때까지 가려지는데 **의도한 동작이다**(지운 내용이 요약으로 남으면 안 된다). 복구는 삭제 이벤트 즉시 재생성과 D10의 「읽을 때 요약」이 맡는다.
3. **RLS로 집행**: `app.member_id` GUC 선례(`server/Migrations/082_message_reminder.sql:47-55`)를 따라 정책 `USING`에 「같은 워크스페이스 AND (개인 공간이면 소유자 = `app.member_id`) AND 근거 전부 읽기 가능」을 넣는다. 「채널 읽기 가능」은 **메시지 읽기 경로와 같은 규칙을 SQL 함수 하나로** 뽑아 두 곳이 같이 쓴다. 현행 검색은 탈퇴하지 않은 멤버십 JOIN이다(`search.rs:17-19`). **공개 채널을 비멤버가 읽을 수 있는지(R1)는 확인하지 못했다 — #3161(스키마 이슈)이 함수를 정의하기 전에 메시지 읽기 경로로 먼저 확정하고 ADR 부록이 아닌 PR 본문에 근거를 남긴다. 확정 전 기본은 「탈퇴하지 않은 멤버만」이다(좁은 쪽).**
4. **청중 축소(에이전트 답)**: 에이전트 답은 채널의 **모든 멤버가 본다.** 그래서 RLS(요청자 기준) 위에 「근거 채널 = 답이 올라갈 채널 자신」이라는 좁히기 술어를 더한다(안전한 기본값). 요청자 DM(사람↔에이전트)에서만 요청자 권한 합집합을 쓴다(company-brain `read-scope.ts:12`의 DM 규칙만 채택, 그룹 채널에서는 합집합 금지). 공개 채널 근거까지 넓히는 것은 R1 확인 뒤 별도 결정으로만 한다. (요청자 권한 합집합을 그룹 채널에도 쓰면, 비공개 #hr 멤버 X가 공개 채널에서 에이전트를 부를 때 #hr 내용이 채널 전원에게 샌다.)
5. **원본 변화 연쇄** (Q9=A)
   - 원본 메시지 삭제: 즉시 가림(정책의 `state <> 'deleted'`), 정리 잡이 근거 0개가 된 항목을 `retired_reason=source_deleted`로 내리고, 삭제 메시지를 포함한 요약은 `stale=true` → 다음 주기(또는 삭제 이벤트 즉시)에 다시 만든다.
   - 채널 퇴장: 정책이 멤버십을 매번 보므로 자동으로 가려진다(파생물 수정 불필요).
   - 채널 보관(`channel.archived_at`): 메시지 읽기 규칙을 그대로 따른다.
   - 공개↔비공개 전환: `channel.kind`를 바꾸는 코드 경로를 찾지 못했다(R2 [?]). 규칙이 읽기 시점 계산이라 생기더라도 자동으로 맞는다.
   - 워크스페이스 기억 초기화: `reset_epoch` 증가 + 전량 삭제. 진행 중이던 쓰기는 epoch가 달라 버린다(company-brain `entities.ts:55-63`).
6. **전 테넌트 폴링 예외 최소화**: 기억 읽기는 API 프로세스(NOBYPASSRLS)의 tx 안에서 한다. 전 테넌트 폴링 예외를 가진 agent-worker 쪽에서 기억 행을 직접 읽지 않는다. 요약 워커가 워터마크·리스를 잡는 경로도 tx마다 `SET LOCAL app.workspace_id`를 건다.

- **증보 (2026-09-30, #3168 M2, 보안 검수 M-2)** — D5 「권한은 검색 SQL 바깥에서 거르지 않는다」와 D6-6 「전 테넌트 폴링 예외 최소화」의 항목(L2) 검색 구현:
  - **`mem_search_items`(API)는 PUBLIC EXECUTE인 `SECURITY DEFINER` 함수다.** 이유: pg_trgm의 `<%`는 leakproof가 아니라 RLS 아래에서(정의자 포함, FORCE) 정책 함수가 워크스페이스의 **모든 행에 먼저** 돈다. 항목 4.9천 개에서 검색 165 ms(행당 ~30 µs, 선형), 후보를 낱말 유사도로 먼저 좁히는 정의자 판은 같은 데이터에서 26 ms(GIN 인덱스도 같은 이유로 어느 경로에서든 쓰이지 않아 만들지 않았다). PUBLIC이지만 함수 안에서 `session_user`가 `momo_app`(또는 슈퍼유저)이 아니면 42501 — BYPASSRLS 로그인이 GUC를 스스로 정해 본문을 읽는 길을 막는다. 역할이 마이그레이션보다 늦게 생겨도 EXECUTE 부여 순서에 기대지 않으려 함수 안에서 검사한다.
  - **권한 규칙의 정의는 하나다**: `mem_item_readable_by(항목, 뷰어)`. RLS 정책(`mem_item_evidence_ok`, GUC 뷰어)과 검색 본체가 같은 함수를 부른다. 검색은 그 앞에 「뷰어의 활성 멤버십 채널(개인 공간은 소유자 본인)」 좁히기를 한 번 더 두어(타이밍 오라클 제거, 스캔 축소) 읽을 수 없는 채널의 항목에는 낱말 비교조차 하지 않는다. 그 밖의 **앱 계층 사후 필터는 없다.**
  - **서빙은 청중 좁히기 없이 돌지 않는다.** 본체 `mem_search_items_core`는 소유자 말고는 EXECUTE할 수 없고(`momo_memory`도 못 부른다), 서빙 진입점 `mem_search_items_for`(워커 전용, 뷰어=요청자를 인자로)는 답 채널이 필수(NULL이면 22023)이며 `mem_item_audience_ok`(D6-4 + 답 채널·요청자 개인 스위치)를 통과한 항목만 돌려준다. 열람(`mem_search_items`)은 답 채널을 받지 않는다.
  - 시험(`mem_item_conformance_pg`, 격리 PG): 검색 결과 == RLS로 읽히는 행 ∩ 일치(뷰어별 대조), 멤버십 좁히기와 읽기 규칙이 서로 독립된 벽이라는 것(하나씩 제거해 둘 다 빠질 때만 샘), `session_user` 가드 제거 시 `momo_worker`가 읽는 RED, 서빙 좁히기·질의 길이 상한(200자) 제거 RED. 알려진 한계: 지연은 워크스페이스 항목 수에 선형(PR #3200 측정표); M3의 후보 축소·벡터 융합이 다룬다.

### D7. 서빙 순서·예산·영수증

- **조립 위치**: 서버의 멘션 잡 페이로드 생성(`momo-agent/src/mention.rs:685` `mention_job_payload`, 창은 `message.rs:1906`). API 프로세스 tx 안이라 RLS가 그대로 걸린다.
- **블록 순서**(워커 `context.rs:123` `SystemBlocks`에 칸 추가): 운영자 프롬프트 → 현재 시각 → **프로필 블록(상시, ≤1,500자, 예산 절사 밖)** → **이 채널·스레드의 최신 요약(30건 창보다 오래된 구간, ≤3,000자)** → **질의 조립 항목(상위 k, ≤3,000자, 항목마다 `[mem:<id>]` 표시)** → 대화 창.
- **예산**: 글자 수 근사다(현행 24,000자와 같은 방식). 기억 블록은 별도 예산(기본 6,000자)을 두고 영수증에 `budget_chars/used_chars`를 남긴다. 토큰 단위 전환은 범위 밖이다.
- **영수증(`mem_serving`)**: 실린 digest·item id와 **보류 개수**를 run별로 저장한다. 보류 개수는 「요청자는 볼 수 있지만 청중 규칙(D6-4) 때문에 이 채널 답에 싣지 않은 개수」이다. RLS가 가린 행은 서버도 모르니 세지 않는다. 답글의 「기억 n개 참고」 칩이 이를 읽는다. 보류는 **내용 없이 개수만** 요청자에게 보인다.
- **에이전트 쓰기**: 에이전트는 도구로 **제안만** 한다(채널에 제안 카드). 저장·권한·무효화는 서버가 집행한다(ADR-0129 D6 승계).

- **증보 (2026-09-29, #3163)**: 서빙 조립은 API 프로세스가 아니라 **agent-worker**가 한다. 워커는 tx마다 `SET LOCAL ROLE momo_memory`(NOBYPASSRLS, 테이블 권한 없음)로 바꾼 뒤 정의자 함수(`mem_serve_requester` · `mem_serve_candidates` · `mem_record_serving`, `mem_definer` 소유, EXECUTE는 `momo_memory`만)로만 읽고 쓴다 — 워커 본래의 BYPASSRLS로 `mem_*`를 읽지 않는다는 D6-6의 목적은 유지된다. **묻는 사람(requester)은 잡 페이로드가 아니라 run 행에서 DB가 유도한다**(`agent_run.trigger_message_id`의 활성 human 작성자, 없거나 에이전트면 `parent_run_id` → 트리거 메시지를 쓴 run 순으로 가장 가까운 사람). 답 채널도 run 행의 것이다. 요청자가 없는 run(환영·예약)은 아무것도 싣지 않는다. 근거: 보안 검수 M-2(#3199).

- **증보 (2026-09-30, #3169, M2)** — 질의 조립 항목 서빙과 「기억해 둘게요」 제안(D4 「에이전트는 도구로 제안만」, D9 편집 행, D6-2):
  - **항목 서빙**: 기억 블록에 요약 다음의 **둘째 섹션**(`<기억 항목 참고자료>`)이 붙는다. 예산은 요약 3,000 + 항목 3,000 = 6,000자(`MEMORY_SERVE_ITEM_BUDGET_CHARS`, 영수증 `budget_chars` = 둘의 합, `used_chars` = 둘의 렌더링 합). 항목은 `mem_serve_items(run)`(워커 전용 정의자 함수)이 정한다: **요청자·답 채널·질의를 모두 run 행에서** DB가 유도한다(질의 = 트리거 메시지 본문, `@멘션` 제외 앞 400자). 스위치(워크스페이스·답 채널·요청자 개인 일시정지)와 요청자의 채널 읽기를 확인한 뒤 `mem_search_items_for`만 통과한 항목을 돌려준다 — 청중 규칙(D6-4: 답 채널 자신, 1:1 에이전트 DM에서만 요청자 합집합)은 그 안의 `mem_item_audience_ok`에 있고 Rust는 다시 거르지 않는다. 항목마다 `[결정 · 2026-09-20 · 사람이 확인 · 근거 2개 · mem:<id>]` 라벨(서버 어휘만)과 한 줄로 납작하게 편 본문이 실린다. 본문의 대괄호는 전각으로 바꿔 `[n]` 근거 표시·라벨을 흉내 낼 수 없다.
  - **영수증**: `mem_record_serving`(같은 시그니처로 교체)이 요청자를 run 행에서 다시 유도해 인자와 대조하고(22023), 실은 **항목도** 요약처럼 청중 규칙을 통과해야 한다(23514). 재시도(23505)는 요약·항목 id가 **둘 다** 같을 때만 블록을 싣는다(`mem_serving_record_of`). **보류 개수는 요약 범위로 유지한다**: 항목 검색은 청중 규칙 밖 항목을 세지 않고 건너뛴다(재정의하면 규칙이 셋이 된다).
  - **제안 저장은 `mem_item`이 아니라 별도 테이블 `mem_proposal`이다.** `mem_item`은 검색·서빙·정책이 읽는 표면이라 거기 pending 행이 있으면 「수락 전에는 읽히는 기억이 아니다」를 정책 조항 하나에 걸게 된다. 별도 테이블이면 구조가 보장한다. 제안 행은 에이전트·채널·요청자를 run 행에서 받고, 근거(1~8개)는 **run 채널의 살아 있는 사람 메시지**(트리거 뒤가 아니고 200개 앞보다 오래되지 않음, 에이전트·요청자 둘 다 읽는 채널, run 시작 뒤 수정되지 않음)여야 하며 시크릿 모양은 거부한다. 요율 제한: run당 3건 · 채널의 대기 제안 20건 · 에이전트당 시간당 30건(54000). 14일 뒤 만료.
  - **누가 수락하나**: 제안된 채널을 지금 읽을 수 있는 **활성 사람 멤버 누구나**(D4 사람의 제안 카드 수락 = `origin=confirmed`, D9 편집·잊기 = 근거 채널 멤버, D6-2). 요청자에게 특권을 주지 않는다 — 제안 카드는 채널 타임라인의 1급 객체(plan V3)라 요청자가 자리를 비웠다고 채널의 결정이 기억되지 못하면 안 된다. 에이전트는 수락할 수 없고, **게스트(워크스페이스 역할 또는 그 채널의 멤버십 역할이 guest)도 수락·거절할 수 없다**(#3209 「게스트는 편집·잊기 불가」와 같은 결정 — 보안 검수 M-2; DB의 `mem_proposal_decider`가 42501로 거부하고 라우트 검사는 두 번째 벽이다. 게스트도 카드는 읽는다). 권한 없음과 모르는 id는 같은 42501(403)이다(존재 오라클 없음). 수락은 근거를 **수락하는 사람 기준으로** 전부 다시 검증한다(제안 채널의 메시지·삭제·제안 뒤 수정 없음·수락자가 읽을 수 있음·사람 작성·DM 합류 이후) — 제안이 저장한 것을 믿지 않는다. 1:1 에이전트 DM의 제안은 그 사람의 개인 공간 기억이 된다. 결정된 제안은 본문·근거 id를 지운 껍데기로 남는다(잊기가 제안 쪽에 본문을 남기지 않는다). 거절은 `mem_event`(`target_kind=proposal`, `action=rejected`)만 남긴다.
  - **보안 검수 보강(#3210)**: ① 트리거가 없는 run(`parent_run_id` 자식 run)은 「run 시작 시점의 채널 머리 seq」를 200개 창의 기준으로 삼는다(창을 건너뛰지 않음; 거부 대신 폴백 — A2A 위임 run도 정당한 요청자가 있다). ② 같은 채널의 제안은 중복 검사 전에 채널 단위로 직렬화하고 INSERT는 `ON CONFLICT DO NOTHING`이라 동시에 같은 내용이 와도 23505가 나지 않는다. ③ 만료된 대기 제안을 같은 내용이 막지 않도록 닫을 때 `decided_by`는 제안한 에이전트(shape CHECK가 결정자를 요구)이고 사건은 `rejected`가 아니라 `expired`로 남긴다. ④ 제안 API는 근거마다 작성자·seq(`evidence[]`)와 「호출자가 요청자인가」(`callerIsRequester`, 자기 수락 경고용 UI 조언)를 돌려준다. 메시지 본문은 싣지 않는다.
  - 근거: 보안 검수 M-2(#3199), #3200 M-2/M-4, 이 증보의 시험(`mem_proposal_conformance_pg`, `memory_serving_conformance_pg`).

### D8. 임베딩·벡터 (Q7=A)

벡터 없이 키워드+엔티티+요약으로 시작하고, M3(#3173)에서 **평가 세트로 부족분을 잰 뒤** 제공자를 정한다. 후보는 ① 팀 링크 제공자의 임베딩 API ② 로컬 소형 다국어 모델(Rust ONNX, 384차원급, 크레이트·모델 라이선스 [?]) ③ 벡터 없이 유지. 결정 전에는 `embedding` 칼럼을 만들지 않고, 결정 시 새 migration과 필요하면 후속 ADR 증보를 낸다.

- **증보 (2026-09-30, #3173 M3, 성재 결재)** — 결정: **② 로컬 임베딩**(`intfloat/multilingual-e5-small`, MIT, int8 ONNX, 384차원). 근거: 평가 스파이크(PR #3213, `docs/research/MEM-M3-vector-search-spike.md`) — 키워드는 유의어·외래어 표기 0.00, 약어 풀이 0.46, 질문형 0.18을 놓치고 로컬 e5-small은 이를 0.12~0.24로 올리며(손글씨 점검 top-1 10/12 vs 5/12), 제공자 API는 프리셋 4종 중 2종만 임베딩 엔드포인트가 있고 본문 전량 외부 전송이 API 프로세스 HTTP 0(ADR-0147)과 충돌한다.
  - **위치**: agent-worker 프로세스(서빙 경로)에서만 모델을 실행한다. API 프로세스와 브라우저 검색(`mem_search_items`)은 M3에서 키워드만이다. 워커 이미지에 모델 118 MB와 ONNX Runtime 공유 라이브러리가 들어가고, 이미지 빌드 때 외부 다운로드 2건(Hugging Face 고정 리비전 + sha256 검증, GitHub microsoft/onnxruntime 릴리스 고정 버전 + 아키텍처별 sha256)을 수용한다. 가중치는 git에 넣지 않는다. (결재 때 예상한 두 번째 다운로드는 `ort-sys`의 cdn.pyke.io 정적 라이브러리였으나, 그 바이너리는 bookworm보다 새 GCC로 빌드돼 bookworm 빌드 이미지에서 링크가 실패해 — `__cxa_call_terminate` — Microsoft 공식 릴리스를 `ort-load-dynamic`으로 실행 시 적재하는 것으로 바꿨다. 라이선스(MIT)·다운로드 건수는 같고 cargo 빌드는 오프라인 가능해진다.)
  - **저장**: 새 테이블 `mem_item_embedding(item_id, model)` — 칼럼이 아니라 모델별 행(모델 교체 = 새 `model` 값으로 병행 백필). RLS FORCE, 어떤 런타임 역할에도 테이블 권한 없음(임베딩은 본문 복원 재료라 본문과 같은 등급). 쓰기·백필 읽기는 `momo_memory`만 부르는 정의자 함수(`mem_set_item_embedding`, `mem_items_to_embed`, `mem_embedding_stats`). 항목이 지워지면(잊기 포함) FK CASCADE로 함께 지워진다. `mem_digest`는 임베딩하지 않는다(요약 서빙은 질의가 아니라 청중 규칙이 고른다). ANN 색인은 만들지 않는다(정확 스캔이 워크스페이스당 수천 행에서 0.5~3 ms이고, 필터 걸린 HNSW는 기본 설정에서 재현율 0.10).
  - **융합**: 서빙 진입점 `mem_serve_items_fused`(요청자·답 채널·질의는 run 행에서 DB가 유도; 질의 본문은 `mem_serve_query`로 같은 게이트에서 받아 워커가 임베딩)가 키워드 후보(`mem_search_items_core`)와 벡터 후보를 **가중 RRF(키워드×2 : 벡터×1, k=60)**로 합친다. 벡터는 순위 신호일 뿐 권한이 아니다: 후보는 멤버십 좁히기 → 거리순 → `mem_item_readable_by` + `mem_item_audience_ok` 통과분 K개이고(**거른 뒤 자른다**, L-3), 융합은 이미 걸러진 두 목록 위에서만 한다. 최소 유사도·상대 마진·벡터 전용 3개 상한이 「가까운 무관 항목」을 막는다(e5 코사인은 좁은 대역이라 절대 문턱만으로는 못 거른다). 정의자 함수 허용 목록·잠금은 마이그레이션 107이 갱신한다.
  - **신뢰 경계(보안 검수 M1)**: `mem_items_to_embed`는 뷰어 좁히기 없이 워크스페이스의 살아 있는 항목 본문을 `momo_memory`에게 내준다 — 로컬 임베딩을 하려면 워커가 본문을 읽어야 하고, 요약 워커가 이미 모든 채널의 메시지 본문을 읽는 것과 같은 신뢰 경계다(프로세스 밖으로 나가지 않는다). 함수는 `momo_memory`만 부를 수 있고 스키마 시험의 「뷰어 없는 본문 반환 함수」 예외 목록에 이름이 올라 있다. 폐기(retired)·stale 이 된 항목의 벡터는 그 순간 트리거로 지운다.
  - **실패 격리**: 질문 임베딩은 자기 예산(250 ms) 안에서만 기다리고, 모델 미로드·바쁨·느림·오류·융합 SQL 오류는 모두 M2의 키워드 전용 읽기로 되돌아간다. 답은 어떤 경우에도 나간다.
  - **미측정(runtime-unverified)**: x86 Linux/Railway 지연·RSS, 실제 질문 분포, 게이팅 융합("키워드가 충분히 맞았으면 벡터는 채우기만") 튜닝.

### D9. 사용자 제어·제공자·동의 (Q8=A)

| 제어 | 누가 | 동작 |
|---|---|---|
| 보기 | 전원 | 브라우저·영수증에서 **자기가 읽을 수 있는 것만** |
| 편집 | 근거 채널 멤버 | 새 항목을 `origin=curated`로 추가 + 옛 항목 `retired_reason=edited`(이력 남음) |
| 잊기 | 근거 채널 멤버(개인은 본인) | **즉시 영구 삭제** + `mem_event`에 id만 |
| 일시정지 | 개인·채널·워크스페이스 관리자 | 수집·서빙 중지, 데이터 유지 |
| 초기화 | 워크스페이스 관리자 | 전량 영구 삭제(`reset_epoch`) |
| 채널 제외 | 채널 관리자 | 그 채널은 요약·추출 안 함 |
| 출처 | 전원 | 모든 항목·요약에 근거 메시지 역링크 |

- **LLM**: 기본 AI의 `summary` 행(#3039로 저장, #3146이 첫 인사에 연결, ADR-0147)을 요약·추출에 쓴다. 행이 안 풀리면 #3146의 정직한 실패를 그대로 따른다(모델을 부르지 않고 audit, 요약 카드에 「요약을 만들 AI 연결이 없어요」). **개인 구독 경로로는 가지 않는다.** 모델 출처 계약은 #3162가 집행한다.
- **동의**: `summary` 행은 운영자가 팀 링크로 고른 제공자다. 다만 에이전트 답은 멘션받은 때만 내용을 보내는 반면, 요약 워커는 **채널 내용을 먼저 전부** 보낸다. 개인정보 자세가 달라서 다음을 전제로 한다. ① **워크스페이스 관리자용 기억 스위치 하나** — **팀 인스턴스는 켜서 시작** ② **팀 고지**(스위치를 켤 때·설정 화면에 무엇이 어느 제공자로 가는지 명시) ③ **사람끼리의 DM은 요약·추출에서 기본 제외**(참여자 전원이 켜야 포함, 사람↔에이전트 DM은 그 사람의 개인 공간으로만 저장) ④ **채널 제외 스위치** ⑤ 개인 일시정지. 외부 출시 때 기본값은 다시 정한다(R9).
- 옛 `workspace.memory_external_provider_consent`(035)는 쓰지 않는다. 옛 스키마는 D11에서 내린다.
- **증보 (2026-09-30, #3208 M2, 기억 브라우저 편집·잊기)** — D9 표의 「편집」「잊기」 구현:
  - **권한은 D9 표 그대로다**: 편집·잊기 모두 저장 채널과 모든 근거 채널을 지금 읽을 수 있는 사람(개인 공간은 소유자)이다. 새 규칙을 만들지 않고 읽기 규칙 `mem_item_readable_by(항목, 행위자)` 하나를 쓴다. 관리자 전용으로 좁히지 않는다. 읽을 수 없는 항목의 편집·잊기는 없는 id와 **같은 404**다(존재 오라클 금지, #3199 F1). 읽을 수 있지만 할 수 없는 상태(이미 내려간 항목·새 버전이 있는 옛 버전)만 409다.
  - **쓰기 경로는 워커가 아니라 API가 부르는 정의자 함수 둘**(`mem_edit_item`, `mem_forget_item`, 마이그레이션 106)이다. 사용자의 동기 조작이고, 워커 경유는 큐·회신 경로를 새로 만들면서 쓰기를 더 넓은 역할에 맡길 뿐이라 보안 이득이 없다. 신뢰 경계는 `mem_search_items`와 같다: PUBLIC EXECUTE + 함수 안의 `session_user` 가드(momo_app/슈퍼유저만, BYPASSRLS 로그인이 GUC를 스스로 정해 남의 이름으로 쓰는 길을 막는다), 행위자는 인자가 아니라 `app.member_id`에서 유도하고 활성 사람(kind='human')이어야 한다. `mem_definer`의 권한은 `UPDATE(retired_at, retired_reason)`와 `DELETE`만 넓어진다(본문 등 다른 열은 여전히 못 고친다).
  - **편집(D4 추가만)** = 새 항목(`origin=curated`, `supersedes_id`, 같은 채널·공간·근거) 추가 + 옛 항목 `retired_reason=edited`(이력). 근거는 옛 항목 것을 `created_at`까지 그대로 옮긴다. 이벤트는 새 항목 `edited`, 옛 항목 `superseded`(id만). 새 본문은 `mem_add_item`과 같은 방어선(1..600자, 시크릿 모양 거부)을 지난다.
  - **잊기 = D9·D10 그대로 즉시 영구 삭제**다(`retired_reason='forgotten'`으로 숨기는 것이 아니다). 항목과 옛 버전 사슬(`supersedes_id`)과 근거 링크를 지우고 `mem_event`에는 id·개수만 남긴다. 새 버전이 있는 옛 버전만 잊는 것은 거부한다(최신 버전을 잊으면 사슬 전체가 지워진다).
  - **재추출 억제(보안 검수 M-5)**: 잊기는 `mem_suppress`(워크스페이스·채널·content_hash, **해시만**, FORCE RLS, 정의자 전용)에 잊은 해시를 남기고, `mem_item`의 BEFORE INSERT 트리거가 모든 삽입 경로(`mem_add_item`, 제안 수락 등)에서 `origin<>'curated'` 삽입을 건너뛴다. 사람이 직접 고쳐 쓴 `curated`(편집)는 막지 않는다. 같은 해시의 죽은·내려간 쌍둥이 행(stale·retired)은 잊을 때 함께 지운다(M-1) — 살아 있는 쌍둥이는 행위자가 읽을 수 있는지 알 수 없어 건드리지 않는다. **요약(digest) 본문에는 사실이 요약이 다시 만들어질 때까지 남아 있을 수 있다** — 그래서 UI 문구는 「다시는 나타나지 않아요」를 약속하지 않는다(M3 #3172가 요약 재생성·정리를 다룬다).
  - **편집의 같은 본문 항목(M-2)**: 같은 채널·같은 해시의 살아 있는 다른 항목이 있으면 읽을 수 있든 없든 「변경 없음」과 같은 22023(→ 일반 422)이다. 409로 구분해 주면 숨은 항목의 존재가 새기 때문이다(가장 덜 드러내는 쪽). 근거를 잃은(죽은) 옛 행이면 stale로 내리고 편집을 계속한다.
  - **guest 제외(M-6, 결정)**: D9의 「근거 채널 멤버」는 채널·워크스페이스 `guest` 역할을 포함하지 않는다고 좁혀 읽는다 — guest는 RLS대로 읽을 수는 있지만 편집·잊기는 정의자 함수가 42501(→ 403)로 거부한다(읽을 수 있는 사람에게만 닿는 답이라 오라클이 아니다). 새 본문을 쓴 사람은 `mem_event('edited')`의 행위자이고 API의 `editedByMemberId`/`editedAtMs`로 UI에 보인다. 읽기·쓰기 권한이 어긋나는 유일한 축이다.
  - **알려진 한계**: 요약 본문(위), 그리고 지운 항목의 근거 메시지를 포함한 요약이 재생성될 때의 추출은 억제 표가 막지만 요약 자체의 정리는 M3다.

### D10. compaction·양 처리 규칙

| 작업 | 트리거 | 비고 |
|---|---|---|
| 창 요약 + 항목 후보 | 채널 새 메시지 ≥40건, 또는 ≥5건 쌓이고 30분 정지 | company-brain 배치(180s·60건·8,000자, `channel-observe.ts:32-38`)보다 느슨하게 — 비용 우선 |
| 스레드 요약 | 스레드 답글 ≥15건 또는 스레드 정지 30분 | 채널 창과 별도 |
| 일간 롤업 | 매일 04:00(워크스페이스 시각) | 창 → 일간 |
| 주간 롤업 | 매주 월 04:00 | 일간 → 주간(Saga 증분식) |
| 정리 잡 | 매일 04:30 | 병합·기간 닫기·감쇠·주제 분할·주제 요약 |
| 삭제 연쇄 | 메시지 삭제 이벤트(outbox) 즉시 + 정리 잡 보정 | D6-5 |
| 읽을 때 요약 | 카드를 열었는데 최신 요약 뒤로 ≥10건이면 그 자리에서 창 요약 1회(**비용 상한 안에서만** — R7) | 매일 쓰는 체감 |

- **주제 분할**: 노드의 살아 있는 항목 ≥125이면 160개 샘플로 2~4 하위 주제로 재분류, 노드별 락(company-brain `split.ts` 이식). 분할 결과는 `mem_event`에 남기고 되돌릴 수 있다.
- **요약 보존**: 창 요약은 **90일** 뒤 일간·주간만 남긴다. 원문이 `message`에 그대로 있어 다시 만들 수 있다. 주간 요약은 워크스페이스 보존 정책이 생길 때까지 보존한다.
- **감쇠**: 영구는 결정+근거, 담당, 약속·블로커(완료 전까지), 반복 질문의 정답, 제약. 「오늘·이번 주」 상태와 단발 추론은 `forget_after` 14일이며 재관찰하면 `reinforce_count+1`과 `forget_after` 연장. **저장 안 함**: 연결 도구가 원본인 상태, 에이전트 자기 발언, 잡담, 시크릿. `confirmed/curated`는 자동 감쇠하지 않는다.
- **보존·삭제**: `retired` 항목은 90일 뒤 영구 삭제(근거 링크 포함). 잊기·초기화는 즉시 영구 삭제. 이벤트 원장은 id만 남는다.
- **비용 상한**: 워크스페이스 일일 토큰 상한(기본 20명 팀 추정치의 2배, 약 300k). 넘으면 ① 추출 중지 ② 요약 트리거를 ≥120건으로 늘림 ③ 관리자에게 표시. 도달은 audit에 남긴다.

### D11. 옛 자산 정리 (Q10=A)

- 마이그레이션 027/028/030/035 파일은 **수정하지 않고**, M1 서버가 main에 들어간 뒤 **새 migration으로 DROP**한다(#3167). `schema_v0.sql`은 건드리지 않는다.
- `infra/.env.example:268-278`의 `MEMORY_EXTRACTION_*`·`MEMORY_EMBEDDING_*`는 새 설정 이름으로 교체한다(#3167).
- 웹 `AgentMemorySection`·`serverSurfaces.ts` 접힘·`momo-core` 메모리 클라이언트는 M2 브라우저 이슈(#3170)에서 **삭제**하고 새 화면으로 교체한다. #2049는 함께 닫는다.
- pgvector 이미지 의존은 M3(D8)에서 다시 쓸 수 있어 유지한다.

### D12. 시각화 범위 (Q11=A)

| # | 화면 | 표면 | 단계 |
|---|---|---|---|
| V1 | 놓친 대화 요약 카드(「안 읽은 동안」 3~5줄, 줄마다 근거 역링크, `stale`이면 「원본 일부가 바뀌어 다시 만드는 중」) | 데스크탑·웹·폰 | M1 |
| V2 | 「기억 n개 참고」 칩 → 팝오버(실린 요약·항목, 출처, 「이 채널이라 싣지 않은 기억 n개」) | 데스크탑·웹·폰(읽기) | M1 |
| V3 | 「기억해 둘게요」 제안 카드([기억하기][고치기][아니요], 수락 시 `origin=confirmed`) | 데스크탑·웹·폰 | M2 |
| V4 | 기억 브라우저(공간→주제 트리, 목록, 상세·근거·이력·편집·잊기) | 데스크탑·웹 | M2 |
| V5 | 결정 타임라인(유효기간 막대, 「A → B로 바뀜」) | 데스크탑·웹 | M3 |
| V6 | 서빙 인스펙터(run별 실린 것·예산·보류·모델, 관리자용) | 데스크탑·웹 | M3 |
| V7 | 그래프 뷰 | — | **목표 A 밖(M4)** |

모든 화면은 `momo-design-taste` 해당 표면 규칙과 독립 design-review(Blocker 0·High 0)를 따른다.

### D13. 평가 기준 — 권한 누수 0건이 머지 조건

- **8.1 권한 누수(최우선, 통과 기준 = 0건). 이 시험이 통과하지 못하면 기억을 읽는 어떤 PR도 머지하지 않는다.** 픽스처: 공개 #general(A,B,X,Y,Z), 비공개 #hr(X,Y), DM(X↔에이전트), 스레드 1개. #hr에 「연봉 조정은 11월」 같은 고유 문자열 사실을 심는다. 단정: Z로 브라우저·검색·영수증 조회 → 0건 / X → 있음 / X의 `left_at` 설정 → 0건 / 근거 메시지 삭제 → 0건 / **#general에서 X가 에이전트를 불러도 그 사실이 답 컨텍스트에 없음(청중 규칙)** / X의 DM에서는 있음. 사보타주: RLS 정책의 근거 조건 제거, 청중 술어 제거, `state <> 'deleted'` 제거 — 각각 시험이 FAIL해야 하고 되돌리면 PASS. 에이전트 컨텍스트에 실린 텍스트 전체에서 심은 문자열을 grep한다(요약 속 우회 누수 포함).
- **8.2 결정 변경 추적**: 30개 결정 중 10개를 나중에 바꾸고 「지금 ○○는?」 질의 30개. 현재 결정 정답률 ≥90%, 옛 결정이 `valid_to` 닫힘으로 타임라인에 남는 비율 100%.
- **8.3 출처 정확도**: 모든 항목·요약 줄의 근거 message id가 ① 존재·읽기 가능 100% ② 근거 본문이 주장을 뒷받침하는지(LLM 판정 + 사람 20건 표본) ≥95%.
- **8.4 한국어 검색 재현율**: 50쌍(조사 변형, 두 음절 낱말, 붙여쓰기, 영문 혼용, 오타 1자). 선택안 recall@10 ≥0.8, 현 `'simple'` 공백 토큰화 대비 향상을 표로 낸다.
- **8.5 데이터셋**: 한국어 팀 대화 생성 스크립트(시드 고정, 약 400건, 정답 라벨 JSON)를 fixture로 두고 실제 팀 대화는 쓰지 않는다(#3160).
- 요약 품질(한국어, 소형 모델, R5)은 평가 세트 없이 체감으로 판단하지 않는다.

### D14. 단계와 이슈

한 이슈 = 한 PR, 엔진·UXUI 분리.

| 단계 | 이슈 | 내용 |
|---|---|---|
| **M0** | #3158 | 이 ADR |
| M0 | #3159 | 한국어 키워드 스파이크(자체 bigram / lindera / pg_trgm, 질의 50개 recall@10, 현행 `'simple'`에서 조사 변형 실패를 먼저 보임) |
| M0 | #3160 | 평가 세트 골격(생성 스크립트·정답 라벨·권한 누수 픽스처) |
| **M1** | #3161 | `mem_digest`·`mem_cursor`·`mem_serving`·`mem_settings` 스키마 + RLS 읽기 정책 + 「채널 읽기 가능」 SQL 함수 (R1 선행 확인) |
| M1 | #3162 | 요약 워커(`summary` 행) + 롤업 + 삭제 연쇄 |
| M1 | #3163 | 요약을 에이전트 컨텍스트에 싣고 영수증 남기기 |
| M1 | #3164 | 요약·영수증 조회 API + 설정(스위치·채널 제외·일시정지) |
| M1 | #3165 / #3166 | 요약 카드 + 참고 칩 (데스크탑·웹 / 폰) |
| M1 | #3167 | 옛 027~035 DROP migration + env 정리 (M1 서버 머지 뒤) |
| **M2** | #3168 | `mem_item`·`mem_evidence`·`mem_event` + 추가만 추출 + 키워드 검색 |
| M2 | #3169 | 질의 조립 항목 서빙 + 청중 축소 술어 + 에이전트 기억 제안 도구 |
| M2 | #3170 / #3171 | 제안 카드 + 기억 브라우저 v1 + 옛 `AgentMemorySection` 삭제(#2049) / 폰 제안 카드 |
| **M3** | #3172 | 정리 잡(병합·기간 닫기·감쇠·주제 배정/분할·주제 요약·보존 삭제) |
| M3 | #3173 | 벡터 검색(평가 뒤 제공자 결정) + RRF |
| M3 | #3174 | 결정 타임라인 + 서빙 인스펙터 |
| M4 | (목표 A 밖) | 그래프 뷰, 엔티티 테이블, 첨부·Drive·허들(#2771) 소스 |

기존 OPEN 이슈는 새로 만들지 않고 재정의·연결한다(#3147 요약 워커 부분은 #3162, #500 한국어 토큰화 결과 수령, #596 대체, #2049는 #3170). 완료 기준은 M2가 권한 누수 0건과 출처 정확도, M3가 결정 변경 추적 정확도(D13)이다. **M1~M3를 지금 출시 범위로 한다(Q1=B).**

## 결과

- 정본은 하나: 기억의 원본은 PG(`mem_*`)이고 원문은 `message`뿐이다. 제2 원본·사이드카가 없다.
- 권한은 문서 규칙이 아니라 RLS 정책과 같은 쿼리 안의 좁히기 술어로 집행된다. 대가로 합성 기억은 근거 채널 교집합으로만 보이므로 워크스페이스 단위 「팀이 아는 것」 뷰는 약하다.
- 요약 워커가 채널 내용을 멘션 없이 제공자에게 보내므로 팀 고지와 관리자 스위치가 필수다.
- 자체 구축이라 추출 프롬프트 튜닝과 정리 오판 유지보수가 우리 몫이다. `extractor_version`·`prompt_version`을 행에 기록해 회귀를 잰다.

## 위험·미검증

| # | 내용 | 상태 |
|---|---|---|
| R1 | 공개 채널 비멤버의 메시지 읽기 규칙을 확인하지 못했다 — 「채널 읽기 가능」 함수 정의가 달려 있다 | [?] #3161 선행. 확정 전 기본은 멤버만 |
| R2 | 채널 공개↔비공개 전환 경로 존재 여부 | [?] |
| R3 | lindera·ko-dic, d3-force, 로컬 임베딩 크레이트·모델 라이선스 | [?] 채택 전 확인·NOTICE |
| R4 | pg_trgm의 두 음절 한국어 검색 품질 | [?] #3159 |
| R5 | 한국어 요약 품질(소형 모델) | 미검증, 평가 세트로 |
| R6 | 모델 단가, 저장·토큰 양 추정 | [추정] — 5·20·50명 팀에서 연 25·100·250MB, 하루 입력 약 40k·150k·400k 토큰(가정: 사람당 하루 40건·80자, 구간 40건, 항목 15건당 1개, 행당 약 5KB, 한국어 1.3자당 1토큰, 프롬프트 오버헤드 ×3) |
| R7 | 「읽을 때 요약」이 비용 상한과 충돌할 수 있다 | 설계 위험 — 상한 우선 |
| R8 | mem0 정리(Dream)는 OSS 코드가 없어 Hindsight+Graphiti 조합으로 새로 짠다 | [S] |
| R9 | 스위치를 켠 채 시작하면 멘션 없이도 채널 내용이 요약 제공자로 간다 | 결재됨(Q8=A) — 팀 고지·DM 기본 제외·채널 제외 전제, 외부 출시 때 기본값 재결정 |
| R10 | #3147은 모델 출처 계약·웹 문구 제거까지 묶여 있다 | 편성 시 #3162와 범위 분리 확인 |
| R11 | 이 ADR 작성 시 런타임 동작을 하나도 실행하지 않았다. 레퍼런스 원본 위치는 계획 시점 클론 커밋 기준이다 | `runtime-unverified` |

## 검토한 대안 (기각)

- 사이드카(Hindsight·mem0 서버·cognee) 채택: 제2 원본, RLS 밖 격리, 파이썬 런타임 추가.
- ADR-0129 증보: 죽은 결정과 살아 있는 결정이 뒤섞임.
- 에이전트 개인 기억만(Q3-B): 요약 카드를 따로 만들어야 하고 같은 행을 공유하는 이점이 없음.
- 요청자 권한 합집합(Q6-B): 공개 채널에서 부른 답으로 비공개 내용이 샘.
- 원본 삭제와 기억 분리(Q9-B, Copilot·ChatGPT 식): 사용자 혼란의 주 원인(external.md §2.3).
- 기본 꺼짐 + 옵트인(Q8-B/C): 팀 인스턴스에서 매일 쓰는 가치가 켜지지 않음. 팀 고지·DM 제외로 대응.
- 여러 채널 합성(Q12-B/C): 거의 아무에게도 안 보이거나 R1에 의존.
