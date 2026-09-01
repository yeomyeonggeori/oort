# ADR-0177: 사이드바 조직화 문법 — 멤버별 소유 섹션·별표

- 상태: **Accepted** (2026-09-01 성재 결재 — 기안 Fable)
- 발제: 2026-09-01 버즈 패리티 감사 사각지대 S1 (`docs/planning/research/2026-09-01-buzz-parity-audit.md` §3-S1·§4 순위 1)
- 관련: ADR-0159(디자인 시스템) · BZ-1 사이드바 접기(#1870) · 우로보로스 인터뷰 interview_20260901_052920

## 맥락

사이드바 섹션이 `SidebarSectionId = "channels" | "dms"` 하드코딩 2종이라, 사용자가 접을 대상 자체를 만들 수 없다. 그 위에 BZ-1 접기·unread 집계·hover 액션·⌥↑↓ 순회가 이미 올라가 있어 **섹션이 데이터가 되는 시점이 늦을수록 그 전부를 다시 뜯는다**. buzz 실사: 섹션은 nip44 자기-암호화 개인 블롭을 릴레이로 로밍 동기화(`desktop/src/features/sidebar/lib/channelSectionsSync.ts`) — **순수 멤버별 소유이며 워크스페이스 공유 개념이 없다**(Slack 동형).

## 결정

- **D1 소유 = 멤버별.** 섹션·채널 배치·별표는 각 멤버의 사적 구성이다. 워크스페이스 공유 구조(관리자가 정한 공통 섹션)는 **v2 명시 보류** — 필요해지면 별도 ADR.
- **D2 저장 = 서버 member-scoped 로밍.** 신규 테이블 `member_sidebar_prefs`(workspace_id·member_id 유니크, `payload JSONB`, `updated_at`) — RLS `ws_isolation` 동일 적용, 단일 쓰기경로(REST→PG). 구조 데이터라 기기 로밍이 필요하므로 localStorage-only 기각. **outbox 이벤트 없음(v1)** — 자기 기기는 즉시 반영, 타 기기는 부트스트랩 GET으로 수렴(리마인더 #1888의 무-outbox 전례 동형).
- **D3 계약.** `GET/PUT /v1/workspaces/{ws}/members/me/sidebar-prefs`, `require_human`(에이전트 403 — 에이전트에 사이드바 없음). payload v1: `{version:1, sections:[{id,name,order,channelIds[]}], starredChannelIds[], sectionSort?}`. 서버는 형식·크기 상한만 검증(섹션 ≤50·이름 ≤80자·채널 참조 ≤500), **채널 membership은 검증하지 않는다** — 탈퇴·삭제된 채널 id는 클라가 표시 시점에 걸러낸다(관용적 계약, 경합 단순화).
- **D4 클라 통합.** 하드코딩 2종은 **기본 섹션**(채널·DM — 삭제 불가, 이름변경 불가)으로 남고, 커스텀 섹션이 그 문법에 합류한다. 배치되지 않은 채널은 기본 「채널」 섹션에 귀속. 접기 상태는 현행 localStorage 유지(기기별 — 접힘은 기기 성향, 구조는 로밍). 섹션 배치·별표·정렬의 파생 계산은 momo-core 단일점 함수로 — 웹·폰이 공유.
- **D5 페이징.** BT-4(골격: 서버+CRUD+배치+기존 접기/unread/hover 통합) → BT-5(상호작용: 별표 UI·A–Z/Recent 정렬·DnD 재정렬). D2 스키마는 별표까지 처음부터 수용.

## 기각 대안

- **워크스페이스 소유**: 훔치는 원본(buzz·Slack)이 멤버별이고, 공유 구조는 권한·충돌 설계가 별개 문제 — v2로.
- **localStorage-only**: 조직화 구조가 기기마다 다르면 "내 사이드바"가 성립하지 않는다.
- **정규화 테이블(섹션·배치 행 단위)**: v1 규모에서 JSONB 단일 행이 검증·마이그레이션·경합 전부 값싸다. 공유 구조가 생기는 v2에서 재평가.

## 영향·게이트

- 스키마: 신규 마이그레이션 1본(`member_sidebar_prefs` + RLS). `schema_v0.sql` 무접촉.
- 게이트: momo-core 파생 함수 테스트 + 크기 상한 red proof + 에이전트 403 시험. 기존 BZ-1 접기·unread 집계 회귀 금지.
