# ADR-0131: agent_profile 원장과 momo 네이티브 간편 생성

- 상태: **Accepted** (성재 승인 2026-07-22 — "537은 승인할게. 최적의 형태로 구현 진행")
- 날짜: 2026-07-22
- 발단: 성재 — "우리쪽 간편 생성 레벨에서 사용자가 원하는 에이전트를 제공할 수 있는가"(research/20-01 §2 T-B). 업계 수렴(OpenAI Workspace Agents·Notion Custom Agents)은 "이름·지시문·도구·트리거를 가진 공유 에이전트"이며, momo는 실행 런타임(AgentWorker+Context Packet)과 생성 API(X-7)를 이미 보유 — 빠진 것은 에이전트별 인격 정의 원장뿐.

## 결정

### D1. agent_profile 원장 (정의=PG 행, 실행=기존 경로)
`agent_profile(agent_member_id PK/FK, workspace_id, instructions text, model_pref text NULL, enabled_tools jsonb, triggers jsonb, version int, updated_by, updated_at)` — RLS FORCE. 신규 상주 프로세스 0: AgentWorker가 run 조립 시 profile을 읽어 반영한다. eve의 "에이전트=디렉터리"에 대한 momo의 대답은 **"에이전트=member 행+profile 행+Context Packet"**.

### D2. Context Packet 주입 (528 경로 가산, 기존 필드 불변)
- instructions → packet `system_prompt` 앞단에 병합(서버 관제 프리앰블·하드 룰이 항상 우선 — 프리앰블을 profile이 덮을 수 없음).
- enabled_tools → tool_grants 투영에 **교집합 필터**(profile은 권한을 늘릴 수 없고 좁힐 수만 있다 — grant 원장이 상한).
- model_pref → 워크스페이스 허용 모델 목록 내에서만 유효(티어/예산 정책 우선).

### D3. 생성 UX는 폼 1장 + 대화식 보조(후속)
비주얼 캔버스는 만들지 않는다(업계 실증: OpenAI Agent Builder 11개월 만에 폐기 — research/20-01 §1-B). v0=관리자/멤버 폼(이름·핸들·아바타·instructions·도구 체크·트리거), 대화식 생성("에이전트에게 에이전트 만들게")은 profile CRUD가 안정된 뒤 별도 티켓.

### D4. 트리거 v0 = 멘션 + 스케줄 예약
triggers jsonb는 v0에서 `{"mention": true}` 고정 + `{"schedule": …}` 필드 예약(집행은 후속 — 스케줄 실행기는 별도 결정). 웹훅 트리거는 MOMO-535 outbound와 대칭 설계로 후속.

## 불변식 준수
- 단일 쓰기경로·RLS FORCE·에이전트=member 유지. profile은 자격증명을 절대 담지 않는다(ADR-0004 — provider 연결은 기존 hermes/gateway credential 기계장치 그대로).
- 승인 정지점(0114)·메모리 거버넌스(0129)는 profile과 무관하게 서버 집행 유지.

## 기각
- 에이전트별 전용 컨테이너/프로세스(리소스·격리 비용, research/20-01 §1-C — 이벤트 구동이 정답).
- profile에 도구 권한 상승 허용(grant 원장 우회 금지).
- 노코드 플로차트 빌더.

## 후속
- MOMO-537(원장+주입+폼 API). UXUI 생성 폼은 엔진 랜딩 후 ENGINE_HANDOFF 개방. 대화식 생성·스케줄 실행기는 별도 ADR/티켓.
