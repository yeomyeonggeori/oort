# 핸드오프 패킷 — 검수 피드백 배치 2 구현 (W-B2-1~5)

> 발주: 2026-08-10 Fable. 편성 정본: `docs/planning/2026-08-10-desktop-qa-feedback-batch2.md`. 성재 결정: ADR 둘 다 승인·구현 / 알림규칙 실기능 / 레이아웃 전체폭 / 업데이트 dev 가드.
> **ADR-0160·0161은 방금 Accepted로 승격됨** — 6b·4b 구현 착수 가능.
> 공통 규율: 워크트리 base=origin/track/engine(main과 0/0)·PR base=track/engine·STOP·이탈은 PR 본문.
> **UI 하드룰**: UI 워커는 `momo-design-taste` 스킬 로드(웹 방언). 자체 design-review 금지 — 머지 전 오케스트레이터가 design-review 에이전트 실행(Blocker 0·High 0=ADR-0133). 4상태·포커스·키보드. 폰(clients/mobile) 범위 밖.
> **서버 접촉 워커**: cargo test --workspace + verify_merge_tree.sh 8레인. 로컬 Docker 프로젝트명 b2-<n>- 접두·down -v 회수.

## W-B2-1 · 사용자 프레즌스 6b (ADR-0160) · `feat/presence-6b` — 대형

- 정본: `docs/adr/0160-user-presence.md`(Accepted). 세 어휘 분리: ①연결(자기·비presence, 6a 완료)·②가용성(휘발·Centrifugo)·③선언상태(내구·단일 쓰기경로). 유효값=f(선언,가용성) 렌더 엣지 계산·미저장.
- 서버: `member`에 선언상태 필드(auto/away/dnd — active 회피) 마이그레이션 · set/read REST · 가용성은 `momo-ephemeral` crate의 봉인 EphemeralSignal에 새 variant(ADR-0149 sanctioned writer 재사용, 새 쓰기 이음매 0) · Centrifugo presence(이미 켜짐, 소비 0)를 소비.
- 프론트: 하단 프로필 패널(6a로 연결점 이미 여기)에 **상태칩 + 상태변경 드롭다운**(online/away/dnd). 6a 연결칩과 presence 칩의 앵커 충돌 해소(ADR §6b 이음매). 실시간 반영.
- 검증: cargo+PG 정합+8레인+red proof(DND 재접속 생존·가용성 휘발 미저장)+design-review. 인바운드 presence 프레임이 불변식("transport carries never authors") 위반 안 하는지 게이트.

## W-B2-2 · 워크스페이스 4b (ADR-0161) + 레일 공간 · `feat/workspace-4b` — 대형

- 정본: `docs/adr/0161-workspace-rail-membership-surface.md`(Accepted).
- **레일 공간(5-공간, 프론트 즉시분)**: 32px 레일을 디스코드급으로 널널하게(48~64px)·타일 히트영역 44pt·현재/호버 여백. 4a(#1276) 위에.
- **아바타 이미지(4b)**: `workspace`에 아바타 필드 마이그레이션 + 업로드 경로(ADR-0151 Drive 계약 **전송 프리미티브 재사용**·워크스페이스 스코프·immutable content-hash·owner/admin 설정). 없으면 텍스트 이니셜(현행 유지).
- **멀티 워크스페이스(4b)**: ADR-0161 D2~D6 — N:M(D5-A 위 테넌트별 human 재사용)·나가기 API(`DELETE …/workspaces/{ws}/members/me`·마지막 owner 409)·세션 전환(클라 세션 스왑). D5-B(공개 `GET /me/workspaces`)는 ADR이 예약이라 범위 판정 후 진행/적립.
- 검증: cargo+PG+8레인+red proof(마지막 owner 나가기 409·아바타 스코프 격리)+design-review. 라이브 워크스페이스 데이터 연속성.

## W-B2-3 · 알림규칙 실기능 · `feat/notif-rules` — 대형

- 성재 결정: 실기능 채우기. 조사: 현재 빈 안내 패널(`SettingsRoute.tsx:304-319`), 서버 operator REST 없음. ADR-0124 보류항목(DND·스케줄·키워드 알림·멘션 예외)이 파킹돼 있음.
- **ADR-0124 증보 기안**(Proposed — 머지 시 성재 최종 승인): notifier 판정 트리(P9·서버 단일)에 사용자 편집 경로를 여는 경계. 어휘·저장·API·기존 채널 mute(ADR-0124)와의 관계. **경계 변경이니 증보 문서 선행.**
- 서버: 알림 규칙 REST(GET/PUT — 사용자별 or 워크스페이스별 판정), notifier가 그 규칙을 소비. 채널 mute(이미 있음)와 통합.
- 프론트: `NotificationRulesSection`을 안내 패널 → 실제 스위치(DND·키워드·멘션 예외 등 증보가 정한 v0 범위). 인박스 "알림 규칙" 링크 목적지 정합(현재 깨짐).
- 검증: cargo+PG+8레인+red proof+design-review. v0 범위는 증보가 좁게 정할 것(전부 다 하지 말고).

## W-B2-4 · 레이아웃 전체폭 통일 · `feat/layout-fullwidth` — 소

- 성재 결정: 전체폭 통일. 멤버(DirectoryRoute)·에이전트(AgentHubRoute)가 `max-w-pane-lg`(640px)로 콘텐츠 캡+좌측정렬해 우측이 빔. 채팅·인박스·활동은 이미 전체폭.
- 수정: `DirectoryRoute.tsx:184,216`·`MemberRow.tsx:42`의 `max-w-pane-lg` 제거(전체폭) · `AgentHubRoute.tsx:323,428,623,644,1094,1484` 캡 제거 · 에이전트 로스터 320px 고정(`tokens.css:892-896`)을 유연화(min/max로 반응). 채팅 기준선과 정합.
- 주의: 640px 캡이 "의도된 설계"(주석 존재)였으니, 전체폭 전환 시 행 가독성(너무 넓은 행)이 깨지지 않게 — 개별 셀 정렬은 유지하되 컨테이너만 전체폭. design-review로 확인.
- 검증: 웹 스위트+design_preflight_web+design-review(라이트/다크·넓은 뷰포트에서 우측 살아나는지).

## W-B2-5 · 업데이트 dev 가드 · `fix/updater-dev-guard` — 소

- 성재 결정: dev 가드 구현. 조사: 로컬/dev 빌드가 항상 매니페스트(next.10)>로컬(next.1)이라 자동 다운그레이드. `store.ts:79-97 checkForUpdate`가 `isDesktop()`만 보고 startup+6h 자동 실행.
- 수정: dev/디버그 빌드(또는 버전이 published 최저값일 때)에서 업데이터 체크를 **건너뛴다**. Tauri dev 판별(`tauri::is_dev()` 또는 빌드 플래그·env). 프로덕션 발행 빌드는 정상 동작 유지.
- **범위 밖(적립)**: 매니페스트 재발행(성재 맥 셀프호스티드+시크릿 3종)·구 org URL 정정은 릴리스 티켓. 이 워커는 dev 가드만.
- 검증: dev 빌드에서 업데이터 미실행 확인(콘솔/로그) + 프로덕션 경로 무영향(플래그 분기 테스트) + red proof(가드 제거 시 dev도 체크).

## 보고 (전 워커)
PR 번호+검증+적립. 서버 워커는 마이그레이션 번호(066+ 선점 확인). 중간 보고 없음.
