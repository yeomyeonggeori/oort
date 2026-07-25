# ADR-0134: 요청 단위 모델·effort 라우팅 + auto 정책

- Status: **Proposed** (2026-07-26, Fable 초안 — 방향은 성재 2026-07-25 결정 큐 승인, 세부 결정 검토 대기)
- 관련: ADR-0131 D2(agent model_pref + 허용목록 게이트), ADR-0130(provider-불가지 gateway), 에이전트 경험 프로그램 AX-2, 레퍼런스 리서치 §2(`research/2026-07-25-reference-ux-survey.md`)

## Context

1. run 생성 API는 closed-world다: `WorkRunInput.allowedKeys = [type,title,brief,repo,branch]`, 미지 필드 400. 요청 시점에 모델/추론강도를 지정할 통로가 없다.
2. `effort` 개념이 1st-party 코드 전역에 존재하지 않는다(전수 grep 0).
3. 모델 선택은 에이전트 단위 `model_pref`(0131 D2, 워크스페이스 `allowed_agent_models` 교집합 게이트)뿐 — "이 요청만 무겁게/가볍게"가 불가능하다.
4. 레퍼런스 실측: Cursor Auto는 선택 모델을 의도적으로 은닉(팀원 공식 답변), Copilot·OpenRouter는 항상 노출. buzz는 effort 유효값이 provider×model 테이블이고 3단 상속 체인 + "Inherit (실제값 병기)" 문법, 모델 변경으로 무효해진 effort는 자동 클리어.

## Decisions

### D1. `routing` 블록 — run 생성 요청의 선택적 오버라이드
- **A (권고)**: `CreateAgentRunRequest`에 선택적 `routing { model?, effort? }` 추가. closed-world 유지 — allowedKeys에 `routing`만 추가하고 내부도 closed-world.
- 게이트: model은 0131 D2와 동일한 허용목록 교집합. **위반 시 400**(에이전트 선호의 조용한 무시(ignored 감사행)와 달리, 사용자가 방금 명시한 선택의 실패는 즉시 보여야 한다). 클라는 허용목록으로 사전 필터.
- B — input 자유필드로 우회: closed-world 계약 파괴. **기각.**

### D2. effort 축 신설
- 유효값은 **provider×model 테이블**(서버 정본, `GET /v1/provider/effort-table`로 노출 — buzz 실측 패턴). 모델별로 xhigh/max 지원 여부가 다르다.
- `usage_ledger`에 `effort text NULL` 컬럼(마이그레이션 041) — 비용 분석 축. hermes adapter에 전달.
- Claude 문법(Effort와 Thinking 별개 축)은 v0에서 effort 단일 축으로 시작 — provider가 둘을 구분하면 adapter가 매핑.

### D3. 상속 체인 — 전역 → 에이전트 → 요청
- 워크스페이스 기본(신규 설정) → agent profile `model_pref`/`effort_pref`(후자 신규) → 요청 `routing`. 빈 값 = 상속.
- UI 문법: **"상속 (실제값 병기)"** 명시 옵션. 모델 변경으로 현재 effort가 무효해지면 **자동 클리어 + 인라인 안내**(조용한 리셋 금지 — t3.chat 반면교사).

### D4. auto 모드 — 정책 라우팅 v0
- **A (권고)**: auto = 서버 측 정적 정책(작업 타입→모델 매핑, 워크스페이스 설정 테이블). 학습형/비용 최적화 라우팅은 v1 이후.
- **선택된 모델은 항상 노출**: 카드 usage.model(기존) + "auto가 {model} 선택" 배지. Cursor식 은닉은 **기각** — 에이전트가 멤버이고 감사·비용 원장이 1급인 제품에서 "누가 어떤 모델로 답했는지 모름"은 계약 위반에 가깝다.

## Consequences
- (+) 요청 단위 유연성 + 감사 원장 정합(effort까지 원장 기록). 기존 게이트 로직 재사용으로 경계 확장 최소.
- (−) 마이그레이션 1건(usage_ledger.effort + effort_pref + auto 정책 테이블). adapter 계약 확장.
- 파생(Accepted 시): 엔진 1장(routing+effort 원장+effort-table REST), 웹 1장(컴포저 인라인 피커+상속 표기 — MOMO-537 에이전트 다이얼로그와 합류), hermes adapter 1장(effort 전달+auto 매핑).
