# 타깃 아키텍처 — Rust/Axum 서버 (D1)

> ADR-0145 B안의 Phase 0 산출물 D1. 현재 Swift 서버 실측(`docs/planning/2026-07-30-server-rewrite-plan.md` §0, 조사 2026-07-30)에 기반. **설계 문서 — 코드 착수 전 성재 승인 대상.**

## 0. 실측이 바꾼 설계 전제 3가지

1. **단일 쓰기경로가 현재 chokepoint가 아니다.** `INSERT INTO outbox`가 18개 route 파일에 인라인 산재(`MessageRoutes.swift:257`·`AgentRunRoutes.swift:159` 등). tx 헬퍼 `withTenantTransaction`(`DB/Database.swift:85`)은 있으나 outbox emit 헬퍼는 없다. → **Rust 재작성의 순이득: 쓰기경로를 규약이 아니라 구조로 강제**(아래 §3).
2. **`message.seq`는 PG 트리거·시퀀스가 아니라 앱코드다.** `channel_seq` row-lock `UPDATE ... RETURNING`(`MessageRoutes.swift:127`)로 채널당 쓰기를 직렬화, DB는 `message_seq_uniq UNIQUE(channel_id, seq)`(`001_init.sql:184`)로 백스톱. → Rust도 같은 row-lock 패턴 복제, UNIQUE가 최종 안전망. (D2가 이 red 테스트 명시.)
3. **공유 계약이 소스 복제로 흩어져 있다.** 명시적 공유는 SwiftPM `CloudProviderKit`(821 LOC) 하나뿐. `CentrifugoClient`(3벌)·`T3Lifecycle*`(2벌)·서명 포맷 문자열(workd `Signing.swift` ↔ 서버 `WorkHostAuthenticator.swift`)이 물리 복제. → Rust에서 공유 crate로 통합(§2 `momo-wire`).

추가: **git 서버 도메인은 oort에 없다**(GitHub은 플러그인 매니페스트로만). → buzz의 git-over-http 패턴 인용은 지금 불필요(D4 카탈로그에서 제외, 향후 네이티브 git 도입 시 재검토).

## 1. 스택 결정

| 항목 | 선택 | 근거 |
|---|---|---|
| 웹 프레임워크 | **Axum** | buzz 검증, tower 미들웨어 생태계, oort relay/워커와 tokio 통일 |
| DB 접근 | **sqlx** | 컴파일타임 쿼리 검증 = 정합성 축 직접 기여, buzz도 sqlx, ORM 마법 최소 |
| 마이그레이션 | **기존 59개 SQL 그대로 실행** | 언어독립. `server/Migrations/NNN_*.sql`는 sqlx migrator 관례(`<version>_<desc>.sql`)와 호환 → 내용 수정·이동 없이 실행(하드룰). `schema_v0.sql`도 불변 |
| 런타임 | tokio | Axum/sqlx 표준 |
| 실시간 | **Centrifugo 유지**(전송전용) | 불변식. relay가 outbox→Centrifugo publish |

## 2. 워크스페이스 crate 레이아웃 (2026-07-30 성재 승인: 공유 인프라 확정 + 도메인 굵게 출발)

buzz의 핵심 원칙 채택: **"서버 바이너리가 오케스트레이터, 서브시스템 crate는 서로를 호출하지 않는다"**(buzz `ARCHITECTURE.md:97`). 도메인 crate 간 조율은 서버 바이너리 또는 공유 인프라 crate를 통해서만.

**분할 원칙(결정)**: crate 경계는 가장 바꾸기 비싼 형태의 경계다. 그래서 — ①**불변식이 사는 공유 인프라 + 이미 검증된 공유 경계는 별도 crate로 확정**(여기가 컴파일러 벽 = 불변식을 규약에서 구조로 올리는 지점). ②**미검증 도메인 경계는 굵게 출발**해 Rust에서 이음매가 검증되면 모듈→crate로 승격(모듈 승격은 쉽고 역방향은 어렵다). 아래 도메인 crate 안의 "모듈" 목록이 향후 분할선이다. 현 Swift 서버의 도메인 경계는 파일명 관례일 뿐 모듈 이음매로 검증된 적이 없어(§0) 굵게 출발이 과잉확정을 피한다.

### 공유 인프라 (foundational — 도메인이 의존, 확정)
| crate | 책임 | 현 Swift 대응 |
|---|---|---|
| **`momo-db`** | sqlx pool, `with_tenant_tx()` 가드(= **RLS GUC 배선 유일 지점**, `SET LOCAL app.workspace_id`), 변형 tx(provider_link_admin·provider_quota_admin·t3_lifecycle_lock), 마이그레이션 러너, `audit_log` write 헬퍼 | `DB/Database.swift:85-236` |
| **`momo-outbox`** | **`emit_outbox()` chokepoint** — 단일 쓰기경로 egress(이 crate만 `outbox` 테이블 SQL 소유), + relay 소비자(`FOR UPDATE SKIP LOCKED`) | 산재된 outbox insert 18곳 + `relay/OutboxRelay` |
| **`momo-wire`** | 공유 계약: 서명 포맷 문자열(`momo.work_host.request.v2` + **ADR-0146 신규 에이전트 메시지 서명 포맷**), outbox/agent_job 페이로드 JSON, 서버↔workd 공유 DTO | 소스 복제 파일들 통합 |
| **`momo-auth`** | JWT 발급/검증, principal 해석(→ RLS GUC 입력), WorkHost 서명 검증(`momo-wire` 포맷) | `Auth/*` + Join·Invite·Device·Centrifugo |
| **`momo-provider`** | provider 어댑터 계약 + BYOC(자격증명 비유입 경계). **이미 검증된 공유 경계** — `momo-notifier`가 서버와 독립으로 소비하므로 crate 승격 | `services/CloudProviderKit`(821) 이식 |

### 도메인 (굵게 출발 — 내부 모듈이 향후 분할선)
| crate | 내부 모듈(현 Swift route) | 배치 |
|---|---|---|
| **`momo-messaging`** | identity(Member/Agent·Workspace·Roster·AgentProfile/Card/Credential) · channels(Channel·DM·ReadState·Mention) · message(Message 2976 + seq) · huddle(Huddle·Attachment·Onboarding) · search(Search·Memory pgvector) · **provenance 서명(ADR-0146)의 집** | B1 |
| **`momo-t3`** | work-runtime(WorkSession·AgentGateway·AgentRun·WorkControl·ApprovalDecision·WorkHost·TerminalAttach·TierPolicy·Pool) · provisioner(CloudProvisioner·ProviderLink(Chain)·Quota·EffortTable — `momo-provider` 계약 사용) · billing(UsageSummary·CostProjection·CloudCredit·UsageLedger) · workstream(ADR-0143 읽기 프로젝션) | B2·B3 |
| **`momo-integrations`** | plugin(Plugin·EventSubscription) · webhook(Webhook) · mcp(InboundMCP·DriveMCP) · admin(PlatformAdmin·Audit, BYPASSRLS read) | B4 후속 |

**crate 총계: 공유 5 + 도메인 3 + 바이너리 5 = 13** (도메인은 11→3으로 굵게, 승격선은 모듈 경계에 표시).

### 바이너리
| bin | 대응 | 공유 |
|---|---|---|
| **`momo-server`** | `MomoServer`(Axum app, 전 도메인 router 마운트·미들웨어·config) | 모든 도메인 crate |
| **`momo-relay`** | `OutboxRelay` | `momo-outbox` 소비자 |
| **`momo-notifier`** | `NotifierWorker`(push 드레인·tier fallback sweep·cloud 재조정) | `momo-provider`·`momo-db` |
| **`workd`** | `WorkHostDaemon`(+ACP/Codex/OpenCode 어댑터·PTY attach) | `momo-wire`(서명) |
| **`agent-worker`** | `AgentWorker`(agent_job 소비) | `momo-wire` |

## 3. 단일 쓰기경로를 구조로 강제 (핵심 설계)

현재(규약): 각 핸들러가 `withTenantTransaction` 안에서 도메인 row + outbox row를 손으로 같은 tx에 insert(18곳 복붙).

타깃(구조):
```
// momo-outbox
pub async fn emit_outbox(tx, kind, method, payload, partition_key) -> Result<()>
// 도메인 crate는 raw `INSERT INTO outbox` 금지 — 이 헬퍼만 경유
with_tenant_tx(pool, workspace_id, |tx| async {
    let seq = bump_channel_seq(tx, channel_id).await?;   // row-lock
    insert_message(tx, .., seq).await?;                    // UNIQUE(channel_id,seq) 백스톱
    emit_outbox(tx, "broadcast", .., payload, channel_id).await?;  // 같은 tx
    Ok(())
}).await
```
- **강제 수단**: `momo-outbox` crate만 `outbox` 테이블 SQL을 소유. 도메인 crate에서 raw outbox insert = 리뷰/lint 차단. → 불변식이 "18곳을 다 지켰나"에서 "chokepoint 하나"로.
- `with_tenant_tx`가 GUC(`app.workspace_id`)를 SET LOCAL로 세팅 → tx 스코프 RLS. actor는 SQL 파라미터(현 설계 유지, actor GUC 없음).

## 4. 미해결 (성재/후속 설계가 답할 것)
- ~~crate 격리 강도~~ **결정됨(2026-07-30)**: 공유 인프라 5 확정 + 도메인 3 굵게 출발, 모듈 경계에 승격선 표시. B1에서 도메인 모듈 이음매 검증 → 필요시 crate 승격.
- **workd 동시 이관**(B5) vs 후행: `momo-wire` 공유 이득이 크면 조기 이관 유리.
- D5 커토버(빅뱅 권고)와 무관하게 crate 골격은 먼저 선다.

## 다음
- **D2 불변식 보존 스펙**(`docs/architecture/invariants-in-rust.md`): 위 crate 배선을 하드 불변식 강제 지점 표로 확정 + 각 불변식의 red 테스트. (seq=앱코드+UNIQUE, RLS=`with_tenant_tx` GUC, 쓰기경로=`emit_outbox` chokepoint 반영.) ← 작성됨
- **D4 buzz 인용 카탈로그**: git-over-http 제외 반영.
