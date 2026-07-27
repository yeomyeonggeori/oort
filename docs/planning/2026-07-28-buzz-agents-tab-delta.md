# buzz 에이전트 탭 실사 + 07-21 이후 델타 — momo 에이전트 허브 갭 판정

- 작성: 2026-07-28 (Fable). 발단: 성재 — "buzz의 에이전트 탭을 바탕으로, 워크스페이스 에이전트·프로필·접근권한·시스템 프롬프트·memory·최근 작업 이력·현재 수행중·cron job을 확인/설정하는 agent 베이스 탭이 우리 설계에 있는지. buzz 최신 아니면 갱신."
- 방법: `github.com/block/buzz` 얕은 clone(HEAD `18eef633`, push 2026-07-27) — **기존 분석(07-22, 커밋~07-21) 이후 179 커밋 델타** + 에이전트 탭 실코드 인벤토리. momo 쪽은 전부 코드 검증.

## 1. 판정 한 줄

**momo에 "에이전트 베이스 탭"은 없다 — 조각은 흩어져 있고(프로필 다이얼로그·디렉터리·작업 패널), 서버는 대부분 준비돼 있는데(특히 메모리 REST 10종 완비·웹 소비자 0건) 한 곳에 모은 표면과 cron 실행기가 빠져 있다.**

## 2. buzz 에이전트 탭 실코드 인벤토리 (2026-07-27 HEAD 기준)

`desktop/src/features/agents/ui/` 173파일. 구조:

| buzz가 가진 것 | 실코드 근거 |
|---|---|
| **글로벌 Agents 탭**(채널보다 위 IA) | `app/routes/agents.tsx` → `AgentsScreen` → `UnifiedAgentsSection`·`TeamsSection`·`ManagedAgentRow` |
| 에이전트 프로필 패널 탭 4종: **info · runtime · channels · memories** | `UserProfilePanelUtils.ts:30 ProfilePanelTab` |
| 정의 = 모델·프로바이더·**프롬프트가 단일 정본** | 07-27 커밋 `8c0e8cb` "make agent definition authoritative for model/provider/prompt" · `PromptSectionAccordion` |
| 접근권한: **"Respond to"**(누가 말 걸 수 있나) · MCP 서버 섹션 · 실행 위치 | `RespondToField` · `McpServersSection` · `WhereToRunSection` |
| 세션/이력: 전사 목록·툴 분류·파일 diff·raw 관전 레일 | `AgentSessionTranscriptList`·`agentSessionToolClassifier`·`FileEditDiffView`·`RawEventRail` |
| 현재 작업: 상태 배지·턴 생존 표시·워킹 배지 | `AgentStatusBadge`·`TurnLivenessIndicator`(+07-25 `a64cc71` stale 배지 정리) |
| **스냅샷 내보내기/가져오기/공유**(에이전트·팀 단위) | `Agent/TeamSnapshotExport/ImportDialog`·`PersonaShareDialog` |
| **팀**(에이전트 묶음) 관리 | `TeamsSection`·`TeamDialog`·`team_repair.rs` |
| **BYOH** — 서드파티 하니스(generic ACP) 갤러리 | 07-25 `95fdf97` "bring your own harness — generic ACP runtime seam + settings gallery" |
| 프로바이더 API 키 입력 | `PersonaProviderApiKeyField` — **momo와 반대 결정**(ADR-0004 비유입). 따라가지 않는다 |
| cron | **없음** — buzz도 cron이 아니라 Workflows 글로벌 표면이 그 자리다 |

**07-21→07-27 델타 179커밋 중 방향 신호**: 페르소나 카탈로그 UI 삭제(`8e67cf3`)·Agents 페이지에서 디렉터리 섹션 삭제(`5d1233e`) — **분산 표면을 Unified 한 곳으로 수렴 중**. 기본 병렬도 24→10(`5d8ede4`). 관리형 런타임 모듈 재편(`74b63e1`).

## 3. momo 현황 (전부 코드 검증)

| 성재가 물은 것 | momo 서버 | momo 웹 |
|---|---|---|
| 에이전트 목록+프로필 | `agent_profile`(036: instructions 8KiB·model_pref·pause·triggers) + profile/pause/allowed-models REST | **탭 없음.** `routing/AgentProfileDialog.tsx`(다이얼로그) + 디렉터리(#782)에 분산 |
| 시스템 프롬프트 | `agent.system_prompt`(001) + `agent_profile.instructions` — **이원 구조** | instructions만 다이얼로그에서 |
| 접근권한 | allowed-models(#831)·플러그인 grant(self-grant)·capability projection(ADR-0113) | 플러그인은 설정>앱(#838/#839), **에이전트별 모아보기 없음** |
| memory | **MemoryRoutes 10종 완비**(list/search/create/update/invalidate/**grants**/policy, 027+ADR-0129) | **소비자 0건** — 서버만 있고 UI가 없다 |
| 최근 작업 이력 | `agent-runs`가 **채널 단위** list + run detail. **에이전트별 전역 목록 없음**(CURRENT_STATE에 후속 후보로 기록돼 있던 그 항목) | 인박스·작업 패널(세션 축)뿐 |
| 현재 수행중 | agent.status/partial outbox 투영 완비 | `agentWorkingSignal.ts` **의도적 空**(MOMO-568 대기) |
| cron | `triggers.schedule` **예약만** — 036 주석 "reserved data and has no executor" | 없음 |

## 4. 갭 → 향후 작업 (성재 지시: 현재 배치 뒤 진행)

1. **#860 웹 에이전트 허브 탭 v1** — 결정 불요분: 목록(상태·현재작업 배지)+프로필/instructions/모델/pause+에이전트별 권한 모아보기+**메모리 뷰**(서버 완비 소비)+작업 이력(채널 단위 현행 REST 범위)+cron 자리는 "예약됨·실행기 없음" 정직 고지. MOMO-568(작업중 전류)과 접합.
2. **#861 엔진 — 에이전트별 전역 run 이력 REST** — 결정 불요. 허브 탭의 이력 축이 채널 단위 한계를 벗는 선행.
3. **ADR-0140 기안 예정 — schedule 트리거 실행기(cron)**: 예약된 `triggers.schedule`에 실행기를 다는 것은 **새 실행 유발 경로**(승인·비용·감사 접점)라 ADR-0131 증보가 선행. 성재 결정 큐에 추가.
4. **buzz 추적 상시화**: 방법 고정 — `git clone --depth 300 --filter=blob:none` → `git log --since=<지난 실사일>` 델타 + 관심 표면 diff. **주기: 배치 종결 시마다 또는 주 1회.** 이번 실사일 2026-07-28, HEAD `18eef633`.

## 5. 따라가지 않는 것 (명시)

- **프로바이더 API 키 유입**(buzz `PersonaProviderApiKeyField`) — ADR-0004 위반. momo는 BYOA.
- **스냅샷 공유·팀**은 v1 범위 밖(관찰 대상으로만 기록 — 수렴 방향이 확인되면 별도 발제).
- buzz의 Nostr 계층 전반(07-22 분석 결론 유지 — 가져올 것 없음).
