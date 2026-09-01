# 워커 브리프 — BT-5(#1933) 섹션 상호작용 확장 — 별표·정렬·DnD (uxui)

> 워커: Opus 5 · base=origin/track/uxui (BT-4 섹션 골격 랜딩 포함 최신) · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. 서버 무접촉(payload v1 계약 안에서만 — `starredChannelIds`·`sectionSort`는 ADR-0177 D3에 이미 있고 서버는 통과 수용). MCP 금지.
> 정본: ADR-0177 D5(페이징 — 이 티켓이 상호작용 절반). BT-4가 세운 것: 코어 파생 단일점 `packages/momo-core/src/features/sidebar/sidebarSections.ts`(변경 함수·상한 검사 포함), `useSidebarPrefs`(디바운스 PUT·부트스트랩 게이트), 행 컨텍스트 메뉴 「섹션으로 이동」 라디오 무리, BZ-1 접기·unread 통합.
> 참조(Apache-2.0, 구조만·복붙 금지): buzz `desktop/src/features/sidebar/ui/SidebarDnd.tsx`(282줄 — **무라이브러리 손구현**이라는 사실 자체가 참조점), `ChannelContextMenu.tsx`(Star/Unstar), 정렬 문법은 buzz 사이드바 전반 실사.

## 구현 계약
1. **별표**: 행 컨텍스트 메뉴에 「별표」 토글(BT-1 확장점 — SURFACE_KEYS 합성, 헤더 메뉴 제외 여부는 실사 후 결정 주석). 별표 채널은 **「별표」 파생 섹션**(맨 위, 파생 단일점에서 합성 — 새 저장 개념 금지, `starredChannelIds` 소비). 별표 섹션은 삭제·이름변경 불가(기본 섹션 문법), 비면 렌더 생략(빈 그릇 금지). 별표해도 원 섹션 배치는 불변(별표는 배치가 아니라 표식 — 결정 주석).
2. **정렬**: 섹션별 `sectionSort`(payload v1 예약 필드) — 「사용자 지정(현행 order)」/「가나다」 2값부터. buzz 실사에서 Recent 문법 실물이 확인되면 3값, 없으면 축소 판정+결정 주석(무단 확장 금지). UI는 섹션 ⋮ 메뉴에 편입(BT-4 문법).
3. **DnD 재정렬**: ①채널 행을 섹션으로 드래그(배치 이동) ②커스텀 섹션 머리글 드래그(섹션 순서). **무라이브러리 손구현**(buzz 동형 — 레포에 dnd 라이브러리 없음·신설 금지). 드롭 대상 시각 표지는 토큰만. **키보드 동등 경로 필수**: DnD가 유일한 문이면 안 된다 — 배치는 기존 라디오 무리, 섹션 순서는 ⋮ 메뉴 「위로/아래로」(또는 동형)로 같은 결과 도달. 터치(hover:none)에서는 DnD 미제공 시 그 사실이 표면 진실과 일치해야(BT-4 H-1 규율 승계).
4. **로빙·접기 무회귀**: 드래그 기계가 기존 로빙 tabindex·⌥↑↓·접기·unread 집계·BT-1 컨텍스트 메뉴(경계 세운 sidebarRoving.ts)를 깨지 않아야 — 기존 시험 전량 그린 + 드래그 중 키보드 상태 시험.
5. 저장은 전부 파생 단일점의 변경 함수 경유(BT-4 게이트·롤백·배너 승계) — 새 쓰기 경로 금지.

## red proof (선행 커밋)
- 별표 토글 왕복(payload 반영·파생 섹션 등장/소멸) · 별표 섹션 순위 고정
- 정렬 전환이 렌더 순서만 바꾸고 order 저장값 불변(가나다) / 사용자 지정 복귀
- DnD: 드래그→드롭이 변경 함수 1회 호출·경계 밖 드롭 무동작·**Esc가 드래그 취소**(실 DOM)
- 키보드 동등 경로: 메뉴만으로 같은 최종 배치 도달 단정
- 사보타지: 드롭 계산 한 줄 제거 → 시험 붉음

## 완료 절차
`clients/web` vitest·core vitest·tsc·(레포 루트) `scripts/design_preflight_web.sh`·CAPTURE_PORT=8577 capture:design(별표 섹션·드래그 중 표지 프레임 두 스킴)·SHELL_GATE_PORT=8579 SHELL_GATE_FOCUS_ONLY=1 gate:shell 그린 실측 → 커밋(#1933 참조) → `git push -u origin feat/bt5-section-interactions` → `gh pr create --base track/uxui` → 정지. 최종 출력에 PR URL·변경 요약·게이트 결과.

## 규율
디자인 토큰만. 게이트 스크립트 무수정(capture 장면 보강 허용). 짧은 픽스처 금지(별표 다수·긴 이름 섹션 드래그·50 상한 경계). 막히면 우회 말고 보고 후 정지.
