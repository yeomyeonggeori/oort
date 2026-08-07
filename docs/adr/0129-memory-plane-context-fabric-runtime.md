# ADR-0129: Memory Plane & Context Fabric 런타임 — 메신저가 에이전트의 컨텍스트를 핸들링한다

- Status: **Accepted** (2026-07-21, 성재 — "위 내용을 main에 설계 기반으로 아주 상세하게 풀어내고 트랙으로 실행" 지시로 권고안 D1~D6 전부 A 승인. 실행 정본: `docs/planning/handoffs/2026-07-21-agent-native-fabric-batch.md`)
- 관련: research/11-agent-runtime/04·05·06(Context Packet/Memory Plane/Capability Cache v0 규범 스펙 — 본 ADR은 그 **런타임 실장 결정**), research/19-agent-native-fabric/00(내부 실사)·03(메모리 OSS 지형), ADR-0102(실행 경로), ADR-0113(Capability projection), research/14 gap-audit(크리티컬 패스: "승인된 보안 ADR → Capability/Context/Memory foundation")
- 발단: 성재(CTO 대화, 2026-07-21) — "메신저 레벨에서 codex/claude code가 해주는 것 같은 에이전트 컨텍스트 핸들링. 회사 단위로 관리되는 컨텍스트·메모리를 사용자가 가시적으로 보고, 에이전트에게 서빙한다. 메모리·데이터·컨텍스트 최적화가 핵심 화두."

## Context

1. **스펙은 있고 런타임이 없다**(19-00 실사): Context Packet은 5필드 partial projection(`MessageRoutes.swift:2013-2060`, mock tool_grants), Memory Plane은 서버 테이블 0개, Capability Cache는 정적 projection만, pgvector/FTS 부재. 규범 스펙·fixture(research/11 04~06)는 2026-06에 완비.
2. **업계 수렴 패턴**(19-03): 2-phase 추출(ADD/UPDATE/DELETE/NOOP, mem0 논문) · 삭제 대신 시간축 무효화(Graphiti `invalid_at`) · 프로필 상시 주입+사실 질의 시 조립(memobase/Letta) · workspace→user→agent→session 4단 스코프(oort RLS와 동형) · 하이브리드 검색(semantic+BM25+temporal).
3. **라이선스 지형이 경로를 강제한다**: 그래프 전용 DB는 전멸(Neo4j GPLv3·FalkorDB SSPL·Kuzu 아카이브), 사이드카(mem0 서버 등)는 제2의 SoT를 만들어 "PG=단일 SoT" 하드 룰과 충돌. **Hindsight(MIT)가 PG 단일 백엔드로 그래프 포함 메모리 시스템을 실증** — PG-native가 유일한 permissive 경로.
4. Slack·업계 비교: Slack은 대화 원장만 갖고 메모리는 각 에이전트 벤더에 위임한다. ChatGPT Enterprise/Claude Team은 메모리를 갖되 메신저가 아니다. **"대화 원장과 메모리를 같은 거버넌스(RLS·감사·출처 역링크) 아래 두는 것"은 self-hosted 메신저인 oort만 가능한 위치.**

## Options

### D1. 저장 계층
- **A (권고)** — **PG-native 자체구현**: research/11 05 §15 스키마 승계(`memory_item`/`memory_source_ref`/`memory_visibility_grant`/`memory_lifecycle_event`), workspace_id + RLS FORCE(013 선례), 스코프 4단(`workspace|member|agent|conversation`). 그래프는 엣지 테이블+재귀 CTE(1~2-hop이면 충분, Hindsight 실증), 필요 시 Apache AGE 승급 경로.
- B — 사이드카(mem0/Hindsight 컨테이너): 제2 SoT·RLS 격하·운영 런타임 추가. **기각.**

### D2. 추출 파이프라인
- **A (권고)** — outbox 소비 비동기 워커(단일 쓰기경로 유지): mem0 2-phase(후보 추출→기존 대조→ADD/UPDATE/**무효화**/NOOP) + **삭제 대신 `invalid_at` 무효화**(조직 메모리 감사가능성). 추출 LLM은 워크스페이스가 지정한 에이전트 경로(BYOA) 재사용 — provider 자격증명 비유입 불변. 채널 히스토리 원문은 memory_source_ref(message_id)로 링크만, 본문 중복 저장 금지.
- B — hot-path만(에이전트가 tool로 직접 기록): 추출 커버리지가 에이전트 호출에 종속. background와 병행하는 D6로 흡수. 단독으로는 **기각.**

### D3. 검색 스택 (기술스택 변경 — 이 ADR의 Accepted가 곧 승인)
- **A (권고)** — **pgvector v0.8.5 도입**(PostgreSQL License — permissive 통과) + `tsvector` FTS + RRF 하이브리드(SQL 함수 합성, Supabase 정착 레시피). 한국어는 pg_trgm 보조. 부수 효과: 메시지 검색 ILIKE→FTS 승격 경로 개방(별도 티켓).
- B — 외부 벡터DB(Qdrant 등): 제2 SoT + 운영 부담. **기각.** / C — 임베딩 없이 FTS만: 시맨틱 회상 불가 — 반쪽. **기각(단 v0 배치 순서상 FTS 먼저, 벡터는 같은 ADR 내 2단계 허용).**

### D4. Context Packet v0 실장 (partial → 불변 packet)
- **A (권고)** — 기존 projection을 v0 계약으로 승격: `packet_id`/`created_at`/`expires_at`/**`memory_refs`**/`budget`/`redactions` 실장, run 동안 불변·정책 변화 시 재발급, **mock tool_grants 제거**(ADR-0113 projection 실주입), `permission_basis` 라벨을 실검증으로 승격(19-00 R1·R2 해소). 서빙 규칙: 프로필/핵심 블록 상시 주입 + 사실/에피소드 질의 시 조립 + 토큰 예산 절사.

### D5. 가시성 — 메모리는 1급 제품 표면
- **A (권고)** — ①워크스페이스 메모리 브라우저("에이전트가 아는 것" 뷰 — 채널처럼 탐색) ②**항목별 출처 메시지 역링크**(메신저 고유 차별화 — OpenMemory/ChatGPT/Claude 모두 없음) ③편집·무효화 이력 ④관리자 정책 스위치(워크스페이스 기본 on/off, off 시 삭제 — ChatGPT Enterprise 문법) ⑤run별 서빙 인스펙터("이 실행에 어떤 히스토리/메모리/grant가 들어갔나" — MOMO-171 승계, 감사 원장 투영).
- B — 백엔드 전용(가시화 없음): 성재 요구("사용자가 가시적으로 볼 수 있게") 정면 위배. **기각.**

### D6. 에이전트 쓰기 경로
- **A (권고)** — Anthropic memory tool 책임 분리 이식: 에이전트는 자기 스코프 메모리를 tool로 조회·**제안**하되, 저장·권한·무효화는 서버 집행. 스코프 밖 쓰기/워크스페이스 스코프 승격은 승인 정지점(`tool_call→approval_request→audit`) 경유.

## Decision (Proposed 권고안)

D1-A(PG-native) · D2-A(outbox 2-phase+무효화) · D3-A(pgvector+FTS+RRF) · D4-A(packet v0 실장) · D5-A(1급 가시성) · D6-A(서버 집행 memory tool) — 성재 승인 대기.

## Consequences

- (+) "메신저가 에이전트의 컨텍스트 매니저"라는 제품 정체성의 런타임 완성 — 대화·메모리·승인·비용이 한 거버넌스.
- (+) 불변식 무변경: PG=SoT·RLS FORCE·단일 쓰기경로·자격증명 비유입 전부 기존 경로 재사용.
- (−) pgvector는 스택 가산(이미지·마이그레이션·운영 지식) — 셀프호스트 배포판(0121)에 확장 동봉 필요.
- (−) 추출 품질은 튜닝 반복이 필요(공개 프롬프트·mem0 논문으로 시작점은 확보).
- 후속(v1, 2026-07-21 정합 검토): **추출원 확장** — 첨부 텍스트·Drive 문서·웹훅 payload를 메모리 소스로("회사 단위 데이터"의 잔여 절반). v0는 `memory_item.source_kind='message'` 고정 컬럼으로 확장 여지만 선반영.
- 파생(Accepted 시 발급 예약): **MOMO-526**(엔진 — memory 스키마+RLS+수명주기 원장+추출 워커 v0) · **MOMO-527**(엔진 — pgvector/FTS/RRF 검색 + retrieval 게이트) · **MOMO-528**(엔진 — Context Packet v0 승격: 불변화·memory_refs·budget·mock grant 제거·실 projection 주입) · **MOMO-529**(UXUI — 메모리 브라우저+출처 역링크+정책 스위치+서빙 인스펙터).
