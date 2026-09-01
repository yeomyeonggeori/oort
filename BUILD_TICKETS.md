# oort — 빌드 티켓 정본 (수용기준·활성 축·백로그)

> **현행 티켓 흐름:** 신규 작업은 GitHub Issue + 핸드오프 패킷(`docs/planning/handoffs/`)이 정본이다(ADR-0100 · `docs/planning/README.md`). 이 파일이 계속 담는 것은 ① 공통 수용기준 등급 ② 아직 살아 있는 축의 티켓 계약 ③ 미착수 백로그.
> **아카이브(2026-09-01 재편):** Phase 0/v0 데모 STEPS·티켓 상세, M1~M7 확장 티켓, ADR-0101 신원 티켓, MOMO-447, 에이전트-네이티브 패브릭 배치 등 2026-07 이전 체계 원문은 `docs/archive/BUILD_TICKETS-2026H1-legacy.md`로 이동(원문 불변). 완료 여부 추적은 GitHub Issue가 정본.

## 수용기준 등급 (공통)

각 티켓의 체크박스는 아래 등급 중 하나로 검증한다.

- **[swift]** — `swift build`가 green (경고 허용, 에러 0). 미완성부는 `// TODO` + 컴파일 보장.
- **[infra]** — 파일 존재 + L4 스펙/`schema_v0.sql`과 정합. Docker/psql로 가능한 범위는 M1 runtime goal에서 검증.
- **[sql]** — 파일 존재 + DDL/시드가 `schema_v0.sql`(정본)과 정합. 적용은 `runtime-unverified`.
- **[python]** — `python3 -m py_compile` 통과(문법). 실행은 `runtime-unverified (hermes 게이트웨이 필요)`.
- **[runtime]** — Docker/psql로 가능한 검증은 수행. hermes 등 외부 의존이 필요하면 실제 의존성 또는 mock 준비 후 검증하고, 못 닫는 범위만 `runtime-unverified` 표시.

---

## 2026-08 런칭 보조축 — Bring your hosted agent

> 정본 결정: ADR-0162 Accepted(2026-08-12) · 실행 패킷: `docs/planning/handoffs/2026-08-12-hosted-agent-pairing-launch-packet.md` · Milestone: M1 · Project: `oort roadmap` #44.
>
> #1344는 공식 Grok Bot의 무구매 접근, Bot/chat, custom HTTP MCP loader dial-in, routine Test run과 cleanup UI를 측정했다. generic 구현은 provider 로그인·결제에 의존하지 않는다. #1358/#1363은 ADR이 `track/engine`에 랜딩할 때까지 `status:blocked`이며, 랜딩 뒤 두 goal만 `status:ready`로 전환한다. 나머지는 native `blockedBy`가 닫힐 때까지 blocked다.

| order | logical ID · Issue | 트랙 | 한줄 | 수용기준 등급 | native 의존 |
|---|---|---|---|---|---|
| 1 | `HAP-E1` · `#1358` | 엔진 | Rust agent bearer issue/list/rotate/revoke lifecycle | rust/runtime-db/docs | #1344(ADR landing gate) |
| 2 | `HAP-E2` · `#1363` | 엔진 | MCP 2026-07-28 modern core + 2025-11-25 legacy compatibility Agent Port | rust/runtime-db/docs | #1344(ADR landing gate) |
| 3 | `HAP-E3` · `#1364` | 엔진 | dedicated paused member + atomic pairing/activation + Agent-Port-only credential guard | rust/sql/runtime-db | #1358, #1363 |
| 4 | `HAP-E4` · `#1365` | 엔진 | connection-scoped durable inbox + opaque cursor | rust/sql/runtime-db | #1364 |
| 5 | `HAP-E5` · `#1366` | 엔진 | MCP inbox/message/gateway thin binding + per-agent delivery | rust/runtime-agent | #1364, #1365 |
| 6 | `HAP-E6` · `#1367` | 엔진 | atomic revoke/pause + invalid-token reconciliation + direct REST audience guard + artifact-level cleanup terminal state | rust/sql/runtime-agent | #1364, #1366 |
| 6a | `HAP-E7` · `#1368` | 엔진(후속) | ADR-0162 OAuth lifecycle 증보 + Agent-Port-only MCP OAuth 2.1 authorization-server mode | rust/sql/runtime/docs | #1364; v0 static pairing 비차단 |
| 7 | `HAP-UX1` · `#1360` | UXUI web/core | web/Tauri “Bring your hosted agent” pairing wizard | web/design/merge-tree | #1364, #1366 |
| 7a | `HAP-UX4` · `#1369` | UXUI web/core(후속) | OAuth resource-owner 로그인·동의 + pairing wizard 복귀 | web/design/merge-tree | #1368, #1360; v0 static pairing 비차단 |
| 8 | `HAP-UX2` · `#1362` | UXUI web/core | disconnect + cleanup acknowledgement | web/design/merge-tree | #1367 |
| 9 | `HAP-UX3` · `#1359` | UXUI mobile/core | hosted connection/cleanup status read-only | mobile/merge-tree | #1364 |
| 10 | `HAP-GROK-E2E` · `#1361` | runtime/manual | real Grok pair→reply→disconnect, active credential/automation/config residual 0 | runtime-agent/manual/docs | #1344, #1358, #1363~#1367, #1360, #1362 |

```text
#1358 || #1363 -> #1364 -> #1365 -> #1366 -> #1360
                                 #1366 -> #1367 -> #1362
                          #1364 -------------> #1359
#1364 -> #1368 OAuth AS ----> #1369 OAuth consent/wizard UX (후속)
                   #1360 ----/
#1344 + #1358 + #1363..#1367 + #1360/#1362 -> #1361
```

`#1361` 전까지 “Grok Bot 연결 검증됨”을 제품 카피로 쓰지 않는다. Grok가 OAuth를 요구하면 #1361에 #1368과 #1369를 추가로 결속하고 static bearer로 묵시 fallback하지 않는다. connector UI uninstall과 local plugin files 제거, routine 비활성화와 제거, Bot 보존과 삭제는 서로 다른 cleanup artifact다.

---

# 후속 백로그 (v1 / v2 + 신규 프리미티브 P1~P6)

> 출처: 경험 설계 문서(`research/07-deepdive/05-agent-native-experiences.md`) §3·§6·§7.
> v0 데모(D+B+C)는 **추가 프리미티브 0**으로 스펙 §9.2 위에서 성립(§7). 아래는 그 다음 단계.

## v1 경험 (구 Phase 0/v0 STEPS — `docs/archive/BUILD_TICKETS-2026H1-legacy.md` — 완료 후)

| 경험 | 한줄 | 신규 프리미티브 | 핵심 프리미티브(기존) | platform |
|---|---|---|---|---|
| **A 유리 어항** | A2A 협업을 관전·난입 가능한 1급 스레드로 | 없음(0) | A2A depth/라운드배리어(§3.4), agent_run, agent.partial, 1급 메시지(tool_call/diff), seq, audit_log | both |
| **E 신원의 가면** | "X가 Y로서" 합성신원 + audit 리본 | 없음(Delegation Inbox UI만) | actor/subject 델리게이션 + audit_log(§7.3), 승인게이트, agent_run | both |
| **F 끼어들 존재감** | presence를 실시간 steer(미니 조종석) | 없음 | member(presence/lifecycle), agent_run, agent.partial, cancelRun(§6.1) | both |
| **I 공개 토론 + 캐스팅보트** | 동시 블라인드 입찰 + TIE-BREAK + minority report | **P5** | A2A 라운드배리어(R=4), approval 확장, agent_run, 델리게이션+audit, reserve | both |
| **H 되돌리기 동료** | 가역성 배지 + 인라인 UNDO + 보상 | **P2** | tool_call/tool_result 1급 메시지, audit_log, reserve/reconcile, 승인게이트, actor/subject | both |
| **J 길들이기** | 팀이 함께 에이전트 믿음 교정·합의 | **P3** | 1급 메시지(diff 재사용), 델리게이션+audit, 승인게이트, member 속성, seq | both |
| M/N 스탠드업·야간조 | 안무된 멀티에이전트 보고 / 자는 동안 일하고 아침 보고 | **P6** | A2A 라운드배리어, agent_run(히스토리 재생), reserve/reconcile, seq | desktop/both |
| O 먼저 두드리기 | 비용예산 가진 근거 있는 주도적 노크 | **P6** | 승인게이트, reserve/reconcile, member, approval_request, 메일박스 | both |

## v2 경험

| 경험 | 한줄 | 신규 프리미티브 | 핵심 프리미티브(기존) | platform |
|---|---|---|---|---|
| **G 분기 타임라인** | 채널을 평행우주로 갈래내고 인간이 정본 승격 | **P1** (가장 무거움) | channel_seq(분기좌표), agent_run(갈래별), reserve/reconcile(갈래별 원장), A2A 격리 | both(데스크탑 N열 우선) |
| **L 수습→정직원** | 신뢰 축적으로 승인게이트 점진 소멸을 팀이 관전 | **P4** | member.status, 승인게이트, audit_log, reserve, agent_run | both |
| H 체크포인트 분기 / G Branch Tournament / 리플레이+분기 / 역할 캐스팅 보드 | 데스크탑 고밀도 확장 | P1/P2 확장 | 위 프리미티브 조합 | desktop |

## 신규 프리미티브 P1~P6 (경험 설계 §6)

> v0 데모(D+B+C)에는 **불필요**. v1/v2 경험을 열기 위한 스펙 외 추가 작업.

### ☐ P1 — `branch_id` 좌표축 `(v2 · G 분기 타임라인 · 가장 큰 신규 작업)`
- [ ] `message`에 `branch_id` 컬럼 추가 + 분기당 `channel_seq` 별도 카운터(또는 갈래=경량 서브채널).
- [ ] 정본 병합 시 `branch → main` seq 재매핑 로직.
- [ ] 갈래별 reserve/reconcile 원장 격리, 폐기 갈래 자동 환불.
- 근거: 현 seq는 채널당 단일 모노토닉(§3.1)이라 "한 채널 다중 평행 갈래" 직접 표현 불가. **(추정)**

### ☐ P2 — `reversibility_tier` + 보상 레지스트리 `(v1 · H 되돌리기 동료)`
- [ ] tool_call `props`에 `reversibility: green/amber/red`.
- [ ] 보상 핸들러 매핑 테이블(compensation registry).
- [ ] audit_log를 역연산 소스로 재사용.

### ☐ P3 — `corrected_belief` 메시지 타입(또는 diff 확장) `(v1 · J 길들이기)`
- [ ] 1급 메시지 타입 enum에 `belief` 추가 또는 diff 타입 재사용.
- [ ] belief 원장 테이블(member 속성 + 교정 이력). co-sign/dispute는 reaction 재사용.

### ☐ P4 — `autonomy_level` + 승급/강등 사건 `(v2 · L 수습→정직원)`
- [ ] `agent` 테이블에 `autonomy_level`.
- [ ] 승급/강등 audit_log 사건 + 게이트 정책 바인딩(G6 scope별 점진 소멸/자동 강등).

### ☐ P5 — TIE-BREAK 결정표 + `decision_ledger` `(v1 · I 공개 토론)`
- [ ] approval 확장(2지선다 → 다지선다 캐스팅보트).
- [ ] 불변 `decision_ledger` 테이블 + minority report 첨부/recall.

### ☐ P6 — scheduled trigger `(v1 · M/N 스탠드업, Sentinel, O 노크)`
- [ ] cron/트리거 테이블(outbox `agent_job` 재사용 가능, kind 확장으로 흡수).
- [ ] 예약/모니터링 트리거 디스패치.

---

