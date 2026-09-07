# 핸드오프 패킷 — 워크스페이스 레일(#4) 구현 계획 (4a 즉시 / 4b ADR 후)

> 발주: 2026-08-10 W-QA5(설계). 결정 정본: **ADR-0161**(Proposed — Accepted는 성재). 편성 정본: `docs/planning/2026-08-10-desktop-qa-feedback-batch1.md` 웨이브 C #4.
> 공통 규율: 워크트리 base=origin/track/engine · PR base=track/engine · STOP · 이탈은 PR 본문.
> **UI 하드룰**: 워커는 시작 시 `momo-design-taste` → `momo-design-taste-web` 방언 로드. 자체 design-review 금지 — 머지 전 오케스트레이터가 design-review 에이전트 별도 실행(Blocker 0). 4상태·포커스·키보드 준수. 폰(clients/mobile) 범위 밖.
> **이 패킷은 코드 0(설계 문서)** — 아래 두 티켓 초안은 성재 승인 후 발주한다. 4a는 ADR 불요라 즉시 발사 가능, 4b는 ADR-0161 Accepted 의존.

---

## 4a — 즉시 구현분 (front-only · ADR 불요 · 지금 발사 가능) · `feat/workspace-rail-4a`

**판정: 착수 가능.** 세 수정 모두 기존 서버 계약만 쓴다(신규 라우트 0). 워크스페이스명은 이미 존재하는 `GET /v1/workspaces/{ws}`(`fetchWorkspace`)로 얻는다 — 현재 사용자명이 뜨는 건 서버 부재가 아니라 **prop 오배선**이다.

### 4a-1 · prop 오배선 정정 → 워크스페이스명 실제 표시
- **실체**: `Sidebar.tsx:287` `<WorkspaceRail workspaceName={selfName} .../>` — `selfName`은 `:137`의 **사용자 표시명**. `LoginResponse`에 workspace name이 없어서(ADR-0161 Context 3) 가장 가까운 사람-읽기 문자열을 꽂아둔 것.
- **방식**: 셸(또는 Sidebar)에서 워크스페이스 identity를 쿼리해 실제 이름을 넘긴다.
  - 소스: 기존 `fetchWorkspace(workspaceId)`(`packages/momo-core/src/features/settings/api.ts:446`, `WorkspaceIdentity{ …, name }` 반환). `WorkspaceSection.tsx`가 이미 `useQuery(["settings","workspace",ws], () => fetchWorkspace(ws))`로 쓴다 — **동일 쿼리키 재사용**(중복 페치 회피).
  - 전달: `WorkspaceRail`에 `workspaceName={workspace.name}`. `WorkspaceRail.tsx:23`의 `initial` 계산(첫 글자)은 **그대로**, 소스만 교체.
  - `selfName` 전달 **제거**(레일은 워크스페이스를 그리는 자리지 사람을 그리는 자리가 아니다).
- **4상태**: 이름 로딩 중엔 이니셜 스켈레톤(빈 24px 사각 또는 저대비 placeholder — 사용자명으로 오인될 글자를 그리지 않는다). 에러/미해결 시 폴백은 `workspaceId` 파생(첫 글자) — 사용자명 폴백보다 정직. `title`/`aria-label`도 워크스페이스명으로.
- **red proof**: prop을 `selfName`으로 되돌리면 레일 이니셜이 사용자명 첫 글자가 되어 스냅샷/테스트가 빨강.

### 4a-2 · `[+]` → 실제 생성/참여 진입점 (설정 링크 제거)
- **실체**: `WorkspaceRail.tsx:52` `<Link to="/settings">` — 생성이 아니라 설정 페이지로 샌다.
- **제약**: 생성 API(`POST /v1/workspaces`, `createWorkspace`)는 **operator-gated**(`require_instance_operator`, MOMO-583). 비운영자는 403. → `[+]`가 "무조건 생성"이면 대부분 사용자에게 403.
- **설계(권고)**: `[+]` = **「워크스페이스 추가」 다이얼로그**(비활성 항목 금지 규율 준수 — 아무도 막다른 골목에 안 보낸다). `CreateChannelDialog`(MOMO-614 "설정으로 보내던 걸 액션 자리로") 패턴 복제 — 셸에 한 번 마운트, `useOpenAddWorkspace` 훅으로 open.
  - **운영자**(instance operator): 생성 폼(name+slug, `WorkspaceSection`의 검증 `workspaceNameError`/`normalizeSlug` 재사용) → `createWorkspace` → 성공 안내. **자동 전환은 4a 범위 밖**(D6/4b-3) — 4a는 "새 워크스페이스로 로그인" 안내까지.
  - **비운영자**: 「새로 만들기는 운영자 전용」 안내 + **초대로 참여**(초대 링크/코드 입력 — ADR-0121 관통). 디스코드 `[+]`("서버 만들기 / 참가하기") 선례와 정합.
- **범위 판정(워커 실측)**: 초대-참여 탭 구현이 4a에 과하면 **최소선으로 축소** = `[+]` → 생성 다이얼로그(운영자 생성만, 비운영자는 안내 문구·초대 참여는 4b-3으로). 최소 요구는 **「설정 링크 제거 + 액션 자리 진입」**. 축소 여부를 PR 본문에 명시.
- **인가 표면**: 클라가 operator 여부를 확실히 알 방법은 시도 후 403이나, `WorkspaceSection`이 이미 생성 폼을 노출(403은 서버가)하는 선례가 있으니 동형으로. `isWorkspaceAdmin`(`features/plugins/model.ts:95`)은 admin 판정이지 operator 판정이 아님 — 혼용 금지.

### 4a-3 · 현재/호버 시각 구분 (디스코드 pill)
- **실체**: 현재 워크스페이스 = accent bar(`-left-1`, `w-marker`) + `bg-surface-hover`. `[+]` 타일도 `hover:bg-surface-hover` → **현재/호버가 같은 배경**이라 구분이 약하다.
- **설계(오르트 구름 §3 위계 규율 준수 — 위계는 채도가 아니라 마커/배경으로)**:
  - **현재**(active): 왼쪽 accent **긴 바**(현행 `h-4 w-marker` 유지) + 타일 배경 상시. `aria-current="true"` 부여(현 nav에 없음 — 스크린리더가 현재를 안다). 마커는 `aria-hidden`.
  - **호버**(비현재 타일): 짧은 accent **dot→pill** 전이 또는 배경만(현재의 긴 바와 길이로 구분). 디스코드 문법(dot=idle, 짧은 pill=hover, 긴 pill=active).
  - **default/focus**: focus는 **W-QA1 포커스 유틸(border-accent)** 과 정합시킨다 — `WorkspaceRail.tsx:56`의 `focus-visible:outline-…-accent`는 QA1 스윕 대상 63파일 중 하나일 수 있으니 **QA1과 충돌·중복 치환 조율**(둘 다 이 배치에 있으면 머지 순서 유의, PR 본문에 교차 표시).
  - 토큰: `--accent`·`--marker`·`--surface-hover` 기존값 재사용. 새 간격/색 신설 금지(격자 밖 컴파일 실패 규율).
- **4상태 필수**(오르트 구름 §4): default·hover·focus·current 네 상태를 `measure/states` 캡처로 증거화.

### 검증 (4a)
- 웹 스위트 + `scripts/design_preflight_web.sh` + **design-review 에이전트(B0, fresh context)** + red proof(4a-1).
- PR 본문: `[+]` 비운영자 처리 판정(권고안 채택/축소 여부) · 4a-3의 QA1 포커스 교차 여부 · design-review 결과.

---

## 4b — Accepted 후 배치 (ADR-0161 승인 의존)

> 아래는 **ADR-0161 Accepted 전까지 발주 금지**(경계 변경 — API/스키마/미디어). Proposed 단계에서는 설계만.

| 티켓 | 내용 | 트랙 | 의존(ADR-0161) | 수용기준 요약 |
|---|---|---|---|---|
| **4b-1** | `DELETE /v1/workspaces/{ws}/members/me` — self-leave. 모든 `membership.left_at` + member 소프트 전이. **마지막 owner=409**, 비멤버=403/404(0117 계약). 클라 래퍼+확인 다이얼로그+낙관적/롤백 | 엔진(+UXUI 배선) | D4 | 마지막 owner 거절 red proof·leave 후 로컬 세션 파기·채널 나가기와 카피 구분 |
| **4b-2** | 워크스페이스 아바타 미디어. 스키마 `workspace.avatar_media_id`(권고) · resumable 업로드/complete(0151 비대칭 재사용, mime·크기 검증) · content(**캐시 가능 content-hash**) · owner/admin 인가 · 교체 시 이전 미디어 회수 · 조인 프리뷰 얕은 읽기 | 엔진 | D5 | 바이트 Drive 우회·읽기 인가(멤버 스코프)·에이전트 업로드 제외·S3 미도입(0151 유보 유지) |
| **4b-3** | 클라 세션 집합 — refresh 토큰 **다건** 안전 저장(키체인) · 레일이 로컬 세션 집합 렌더(각 타일 이름·아바타=캐시된 `WorkspaceDto`) · 전환=세션 스왑+realtime 재수립+API base 재스코프 · 로그아웃=전 세션 일괄 파기 | UXUI | D3·D6 | 전환 시 연결 tear-down 없이 재수립·프라이버시(일괄 파기)·`[+]` 초대 참여 통합 |
| **4b-4(예약)** | `GET /v1/me/workspaces` 서버 목록 + 전역 토큰 즉시 전환 | — | **D5-B(공개)** 별도 ADR | D5-B 승격 전 발주 금지 |

### 순서·의존
- 4a는 **독립**(지금). 4b-1·4b-2(엔진)는 병렬 가능. 4b-3(UXUI)은 4b-1/4b-2 계약 확정 후 배선.
- 4b-4는 **공개 단계 D5-B 승격**과 동반 — 이번 로드맵에 적립만.

---

## 보고 (W-QA5 → 오케스트레이터)
- 산출: **ADR-0161(Proposed)** + 본 패킷. 코드 0.
- **번호 조율**: W-QA4(presence)=ADR-0160 예약 / 본건=0161(병렬 충돌 회피).
- **즉시분 판정**: 4a는 **ADR 불요·착수 가능**(기존 `fetchWorkspace` GET 재사용으로 이름 표시 성립 — prop 오배선일 뿐 서버 부재 아님). 4b는 ADR-0161 Accepted 의존.
- STOP.
