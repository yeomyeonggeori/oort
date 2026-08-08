# ADR-0143: Workstream — 목표와 실행의 분리, actor-independent 연속성

- Status: **Accepted** (2026-07-29, 성재 — "ADR-0142, 0143 승인할게". 기안 Fable)
- 관련: ADR-0114(세션=스레드 — **유지·확장**), ADR-0125 D11(계보 재개 — 유지), ADR-0139(idle·재부착 — 유지), ADR-0141(보류 — WIP push·Takeover가 이 ADR의 이웃), ADR-0132(부재≠오류)
- 입력: GPT 설계 문서(성재 전달)의 핵심 기여 2건 + `docs/planning/2026-07-29-gpt-work-runtime-review.md` + 우로보로스 인터뷰(interview_20260729_053912)
- 발단: 성재 확인 요구 — "한 사람이 시작한 일을 다른 사람이나 에이전트가 자연스럽게 이어받을 수 있는가?" 현행 답은 **불가능**이다.

## Context

- `work_session`은 GPT 문서 어휘로 **Run**(1회 실행)이다. 문제는 이 타입의 과책임이 아니라 **상위 계층(목표)이 통째로 비어 있는 것**: 목표·수용기준·담당 이력을 담는 타입이 없고, "목표"는 GitHub Issue(개발 메타)에만 존재한다.
- 연속성이 사람에 묶여 있다: `work_session.member_id NOT NULL`(019:13), 재부착은 소유자만(ADR-0139 D1), 계보 재개도 요청자 본인의 새 세션만(`WorkSessionRoutes.swift:1410`). "A가 요청→B가 시작→Agent가 이어받고→C가 마무리"가 표현 불가능 — GPT 문서 §22.1이 경고한 바로 그 형태다.
- 반면 관찰(read-only observer·입력 거부·ring replay)·티어 동형성(work_host 단일 표면)·Cold/Hot 재개 원칙은 이미 구현돼 있다. **이 ADR은 그 위에 목표 계층 하나만 얹는다.**

## Decision

### D1. Workstream = 스레드에 앵커되는 목표 계층 (대화 문법 유지)

- 신규 테이블 `workstream`: 목표 문장 · 상태(`active|paused|done|cancelled`) · 앵커 스레드(root message) · 워크스페이스/채널 FK. **스레드를 대체하지 않고 스레드에 앵커한다** — ADR-0114 "세션=스레드"는 "스레드=Workstream의 대화 표면"으로 확장된다.
- **암시 생성**(성재 확정): 스레드에서 첫 work_session이 시작되면 Workstream row가 자동 생성된다(기본 1:1). 선언 의식 없음 — 기존 사용 동선 무변경. 명시 선언·분리·병합·"후보 제시"(GPT §6.3)는 P2.
- `work_session`에 `workstream_id` FK 추가. 기존 세션은 마이그레이션에서 스레드 기준으로 소급 생성·연결.

### D2. 인계 = 같은 Workstream 아래 새 Run (소유권 이전 아님)

- `work_session.member_id`는 **그 Run의 실행자**로 의미 축소 — 불변 실행 기록이며 이전하지 않는다. 연속성은 Workstream이 갖는다.
- 인계는 기존 계보 재개와 같은 문법: **다른 사람/에이전트가 같은 Workstream 아래 새 Run을 시작**(`resumed_from_session_id` 계보 유지). 재개 자격을 '소유자 본인'에서 **'Workstream 참여 자격자'로 확장**하는 것이 이 ADR의 유일한 권한 변경이다.
- 실행 이력은 Workstream에 누적된다(A 요청 → B Run → Agent Run → C Run — 전원 병기).
- **라이브 PTY takeover는 범위 밖** — 실행 중 세션의 제어권 이전은 Writer Lease가 필요한 유일한 지점이고, ADR-0141 재론(Takeover·unreachable·#893)에 귀속한다. 이 ADR의 인계는 "멈춘 것을 잇기"만 다룬다.

### D3. 권한 = 채널 멤버십 파생 (새 권한 체계 발명 금지)

- Workstream을 보고 이어받을 수 있는 자 = **앵커 스레드가 속한 채널의 멤버**(RLS FORCE — 에이전트도 member라 같은 게이트). Workstream 단위 명시 할당은 P2.
- **거부는 강제다**: 비멤버의 재개는 403(실제 REST 로그인 검증기로 잠금). 정보성 경고 방식은 기각 — 강제 없는 경계는 깨진다는 것이 이 레포의 반복 실측(SQL 지름길 픽스처 7회)이다.
- **WIP 비대칭 명문화**: oort 원장이 노출하는 것은 WIP branch 이름·base commit·checkpoint 메타까지다. git 원격의 실제 접근 권한은 사용자 소유이며 oort 권한 밖 — ADR-0141의 WIP push(`momo/wip/<session-id>`)를 가져올 수 있는지는 git 원격이 판정한다.

### D4. GPT 문서에서 채택하지 않는 것 (기각 명시)

- **local-first sync 확장**: oort 하드 불변식(Postgres=SoT·단일 쓰기경로·Centrifugo 전송전용)과 정면 충돌. "offline-tolerant client + server-authoritative ledger"로 재해석하고 SoT는 유지. **기각.**
- **Project 계층 · Request 타입 · RunAttempt 분리 · 우선순위 5단 Queue와 선점 · Workstream별 동시 실행 한도 · 의미 유사도 검색**: 현 단계 과도(④). 필요해지는 시점에 개별 재론.
- **Task 계층**: 첫 슬라이스에서 Task≈work_session 1:1. 병렬 Subtask·Source Lane·Integration이 필요해질 때 분리(P2) — 그때도 워크트리 병렬은 이 레포 개발 파이프라인이 이미 실증한 문법을 따른다.

## 수용 기준 (P1 — 인터뷰 확정)

같은 채널 멤버 시나리오를 격리 검증기로:
1. A가 스레드에서 세션 시작 → Workstream 암시 생성(원장 단정).
2. B(같은 채널 멤버)가 이어받기 → **새 Run이 같은 Workstream에 연결**되고 실행 이력에 A·B 병기(actor-independence의 실측 증거).
3. 비멤버 403 — 실제 REST 로그인 + FORCE RLS 불가시(기존 검증기 패턴 재사용, SQL 지름길 금지).
4. WIP 메타는 원장까지 노출, git fetch 가능 여부는 검증 범위 밖임을 명시.

## Consequences

- (+) "A 시작→Agent 이어받기→C 마무리"가 표현 가능해진다 — oort의 agent-native 정체성(에이전트=member)이 작업 연속성까지 확장.
- (+) 마이그레이션 최소: member_id 의미 변경 없음, 기존 재개 문법 재사용, 새 권한 체계 없음.
- (−) 스레드:Workstream 기본 1:1의 예외(한 스레드에서 두 목표)는 P2로 미룸 — 그때까지는 스레드를 나누는 것이 답.
- (−) 재개 자격 확장은 새 보안 표면: 다른 사람의 WIP 메타가 채널 멤버에게 보인다. D3의 경계(메타까지만)와 검증기로 잠근다.
- (−) 웹/모바일 표면(Workstream 목록·이력·이어받기 동선)은 UXUI 트랙 후속.

## 이행 (Accepted 시)

1. 마이그레이션(workstream + work_session.workstream_id + 소급 생성) — 엔진.
2. 재개 자격 확장 REST + 검증기(수용 기준 4종) — 엔진. **ADR-0140 T-3(#891) 랜딩 후** (같은 수명주기 코드).
3. UXUI: Workstream 표면(별도 티켓, 성재에게 화면으로 제안).
4. ADR-0141 재론(Takeover·unreachable·WIP push)은 이 ADR 랜딩 후 사용 패턴 데이터와 함께.
