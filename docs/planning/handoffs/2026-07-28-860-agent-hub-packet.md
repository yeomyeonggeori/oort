# goal #860 — MOMO-652: 웹 에이전트 허브 탭 v1 (buzz Agents 탭 대응, 결정 불요분)

너는 momo 레포의 Codex worker다. 이 문서가 네 유일한 지시서다. 계약은 `AGENTS.md`.
**base = `track/uxui`**(#850·#851·#858 랜딩분 포함). 모델: gpt-5.6-sol high(Fast 티어 전역).

## 0. 착수 전 필수
1. `git status` clean. 2. 자격증명·`.env` 금지. 3. **PR 후 STOP.** 4. typecheck·test·build·preflight 필수, Playwright는 오케스트레이터. 5. 심볼 grep 실재 확인. 6. UUID 대소문자 lower() 정규화.

## 1. 배경 (정본: `docs/planning/2026-07-28-buzz-agents-tab-delta.md`)
oort에는 에이전트를 한 곳에 모은 표면이 없다 — 조각 분산(프로필 다이얼로그·디렉터리·앱 권한·작업 패널). buzz는 글로벌 Agents 탭으로 수렴 중(최근 델타가 분산 표면 삭제 방향). **이 티켓은 결정 불요분만** — 서버 REST가 전부 준비돼 있다.

## 2. 소비할 서버 계약 (전부 검증됨 — 재확인하고 써라)
| 축 | REST | 비고 |
|---|---|---|
| 목록 | 디렉터리 roster(#782 웹 기존 소비) — `kind='agent'` 필터 | 새 엔드포인트 없음 |
| 프로필 | `GET/PUT /agents/:agent/profile` · `PUT /agents/:agent/pause` · `GET /agents/:agent/allowed-models`(#831) | 기존 `routing/AgentProfileDialog.tsx`·`useAgentProfile.ts` 로직 재사용 — **다이얼로그를 허브로 승격하되 기존 진입점 유지 여부는 판단·근거** |
| **메모리** | **MemoryRoutes 13 endpoints**(list/search/create/update/invalidate·grants 3종·delete-all·policy 2종·외부제공자 동의 2종) | **웹 소비자 0건 — 이 티켓의 최대 신설면.** v1 범위: list/search + invalidate + grants **열람**. policy·delete-all·동의는 **범위 밖**(위험 커서 후속) |
| 이력 | **`GET /agents/:agent/runs`(#861 방금 랜딩)** — cursor 최신순, 요약 필드만 + 기존 run detail | 채널 목록과 요약 동일성이 서버 검증기로 잠겨 있다 |
| 현재 작업 | `agentWorkingSignal.ts` — **실배선 완료 상태다**(MOMO-613, Sidebar·Composer 소비 중). 허브는 같은 store를 **에이전트별로** 소비 | 새 구독 발명 금지 |
| 권한 모아보기 | capability projection 데이터(설정>앱과 동일 원천) | **읽기 전용** + 변경은 설정>앱으로 링크 |
| cron | `triggers.schedule` — **예약만, 실행기 없음**(036 주석) | "예약됨 — 실행기 미구현" **정직 고지 자리만**. 실행기는 ADR-0140 선행 |

## 3. 만들 것
1. **허브 표면**: 워크스페이스 에이전트 목록(상태: 활성/일시정지 + 현재 작업 배지) → 선택 시 상세(프로필/instructions/모델/pause · 권한 읽기 · **메모리** · 이력). IA 위치(설정 섹션 vs 별도 표면)는 **레포의 기존 내비 문법을 따라 판단·근거를 커밋에**.
2. **메모리 뷰**: list(+search) · 항목 invalidate(확인 동선 — #839 동의 다이얼로그 프리미티브 재사용: 조건부 마운트·`opener`·Escape 소유·aria-busy) · visibility grants 열람. **빈 상태·오류·0건 각각 정직하게.**
3. **이력**: #861 REST 소비, cursor "더 보기". run 클릭 → 기존 detail 경로.
4. **pause/재개**: 기존 REST — 진행 중 aria-busy(흐림 금지 — tokens §5b).

## 4. 함정 (이 배치 실측 반복분)
- **"자기 원칙을 나머지 분기에 미적용"·"기존 셸과의 통합 지점"**이 최근 FAIL 전부다. 새 표면이 앉는 자리의 기존 계약(내비 문법·헤더 폭 계약·패널 소유권)을 먼저 읽어라.
- 게이트 픽스처는 **응답 타이밍 어긋나게**(메모리/이력/roster 도착 순서 3케이스).
- 기존 게이트 6종(wire/shell/csp/huddle/my-sessions) 단정·red proof를 깨지 마라.
- **신규 게이트**(`gate:agent-hub` 권장): 목록·메모리 invalidate 왕복·이력 페이지·pause 반영. **red proof 절차 명시**(이름 있는 실패 — 행 금지).

## 5. 하지 말 것
- 프로바이더 API 키 입력(ADR-0004 — buzz를 따라가지 않는 명시 결정) · 팀/스냅샷 · schedule 실행기 · 메모리 policy/전체삭제/외부동의 · 서버 변경.

## 6. PR
`feat/860-momo-652-agent-hub` → `track/uxui`. 본문: IA 위치 판단, 메모리 v1 범위 근거, 다이얼로그 승격 판단, 오케스트레이터 실행 목록, 계획 이탈. **PR 후 STOP.**
