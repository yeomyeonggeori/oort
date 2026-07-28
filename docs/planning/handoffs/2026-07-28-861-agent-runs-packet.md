# goal #861 — MOMO-653: 에이전트별 전역 run 이력 REST

너는 momo 레포의 Codex worker다. 이 문서가 네 유일한 지시서다. 계약은 `AGENTS.md`.
**base = `track/engine`**(최신 — #855~#859 랜딩분 포함). 모델: gpt-5.6-sol high(Fast 티어는 전역 설정).

## 0. 착수 전 필수
1. `git status` clean. 2. 자격증명·`.env` 금지. 3. **PR 후 STOP.** 4. docker는 오케스트레이터. 5. 심볼은 grep 실재 확인. 6. UUID 텍스트 비교는 lower() 정규화.

## 1. 문제 (검증 완료)
`agent-runs` 목록이 **채널 단위뿐**(`AgentRunRoutes.swift:21` `/channels/:ch/agent-runs`). "이 에이전트가 최근 무엇을 했나"의 워크스페이스 전역 질의가 없다 — 에이전트 허브 탭(#860)의 이력 축 선행.

## 2. 할 일
- `GET /v1/workspaces/:ws/agents/:agent/runs` — cursor 페이지네이션(최신순), 활성 멤버만, RLS 경유.
- **노출 최소**(#831 선례 그대로): run 요약 필드만 — 상태·시각·채널·트리거 요약. **내부 payload·자격증명 인접 필드·전문 transcript 배제**(전문은 기존 run detail로).
- 기존 `AgentRunRoutes` 목록 쿼리의 필드 선택을 재사용해 **채널 목록과 요약 형태가 갈라지지 않게**(두 목록이 같은 run을 다르게 말하면 안 된다).
- openapi 명세 동반(역방향 게이트가 잡는다).

## 3. 검증
- `swift build`·서버 테스트 무회귀(현재 339).
- 격리 검증기: 페이지네이션 경계(경계 커서·빈 페이지·순서 안정) · **비멤버 403을 실제 REST 로그인으로**(SQL 지름길 픽스처 금지 — 6회 반복 패턴) · 타 워크스페이스 불가시 · 채널 목록과 전역 목록의 같은 run 요약 동일성.
- **red proof**: 신규 경로를 스펙에서 빼면 역방향 게이트가 지목 + 검증기 단정 1개 이상 되돌림 실패(**이름 있는 실패** — 행/타임아웃 금지). 절차 명시.

## 4. PR
`feat/861-momo-653-agent-runs` → `track/engine`. 본문: 요약 필드 선택 근거, 커서 설계, 오케스트레이터 실행 목록, 계획 이탈. **PR 후 STOP.**
