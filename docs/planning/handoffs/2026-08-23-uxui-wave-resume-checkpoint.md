# UXUI 완성도 파도 — Fable 재개 체크포인트 (2026-08-23)

> 성재 지시: "지금 도는 작업 끝나는 대로 중간 포인트 만들고 정지, Fable로 재개." 이 파일이 재개 진입점.

## 지금 어디까지 (배치 1·2)

**배치 1 — 완전 랜딩(track/uxui)**: M-1(#1681 iOS 첨부·프로필)·U-2(#1680 채널 컨텍스트)·U-1(#1679 우클릭·복사·프로필 카드). 세 이슈 close·워크트리 회수.

**배치 2 — 4/5 랜딩(track/uxui=72f38968), 1 보류**:
- U-5(#1687 단축키 도움말) ✅ 머지·close·회수
- C-1(#1685 멘션 하이라이트 코어+웹/폰) ✅ 머지·close·회수
- U-4(#1688 컴포저 이모지·스레드 동등성·패딩) ✅ 머지·close·회수 (검수 수리 1: 이모지 삽입 후 textarea 포커스 복귀)
- U-3(#1686 라이트박스+다운로드) ✅ 머지·close·회수 (named utility `lightbox-panel`·Esc/화살표/aria-live).
- **U-7(#1689 OmD v2) — 보류·성재 판정**: PR #1693. 590파일·389,734줄(.omd/system 생성물+.claude/skills/omd-* 스킬 번들). DESIGN.md·OMD.md는 정당하나 대량 커밋 스코프가 성재 승인 사안. PR #1693 코멘트에 판정 요청 2건. 브랜치 `feat/1689-design-md-core-v2-book@272dd4c2` 보존. **재개 시: 성재 결정(레포 버전관리 vs .gitignore) 확인 후 스코프 조정 재개.**

**M-2(사진 picker)**: 미발사 — ADR-0137 D1(네이티브 의존성) 기안 선행 필요.

## 막힌 것 (성재 입력 필요)

1. **로컬 docker 데몬 hung → 재연 미완**: 성재 D8 이후 docker가 hung. killall(프로세스 없음)→open 해도 데몬 안 올라옴(info/ps/version 전부 120s timeout). **Docker Desktop 재설치 or 시스템 재부팅 필요 추정**. 재연 web dist는 배치1(e14faa50)까지만 빌드됨 — **재개 시 track/uxui(72f38968) ff + web 재빌드로 배치2 반영 필요**. docker 회복 후: 로컬 스택 up(포트 23010~) + track/uxui dist 담은 데스크탑 앱 재빌드.
2. **UXUI 수동 재연**: 성재가 하기로. 빌드 원본=track/uxui 워크트리(`~/projects/momo-tracks/uxui`). docker 회복이 선결.
3. **U-7 스코프 판정**(위).

## 다른 전선 (이 파도 밖·미결)

- **ADR-0167 Accept + T-9(#1678)**: 셀프호스트 실시간 same-origin 파생. RN Origin AC 합류됨. 발사 대기.
- **D8 데스크탑 재연**: 그록봇 VM 서버(Funnel). 실시간 P1 즉석수리 완료(wss). 성재 수동 재연·에이전트 합류 릴레이·온보딩 캡처 회수 대기.
- **uxui rescue-20260823 stash**: 폐기 판정(`~/projects/momo-tracks/uxui`에서 `git stash list`).

## 재개 첫 행동 (Fable)

1. `docs/planning/CURRENT_STATE.md` 최신 스냅샷.
2. U-3(#1694) 머지됐는지 확인·미완이면 마무리.
3. docker 회복 여부 확인 → 되면 재연 스택·데스크탑 빌드, 안 되면 성재에 재설치 안내.
4. U-7·M-2·ADR-0167·D8 재연은 성재 결정 큐.

---

## 재개 결과 (2026-08-23 저녁 세션 — 이 체크포인트 소진)

- **§막힌 것 1(docker)**: 전 세션에서 Colima 전환으로 근본 해결(AppTranslocation 규명). 스택 healthy 실증.
- **§막힌 것 2(수동 재연)**: Fable이 브라우저 자동화로 대행 — U-5·U-2·C-1·U-1·U-4 PASS, U-3는 D8 보관소 미연결(no-archive)로 E2E 보류. 증거+리포트 `claudedocs/uxui-qa-d8-20260823/`. 데스크탑 실체감(실시간 포함)은 `~/Desktop/oort-uxui-review.app` 1회 실행으로 가능(선택).
- **§막힌 것 3(U-7)**: 판정 집행 — mirror 문서만 랜딩(#1695, track/uxui=35074dbd)·번들 .gitignore. #1693/#1689 종결. 번들 보존 feat/1689-design-md-core-v2-book@272dd4c2.
- **M-2**: ADR-0168 Proposed 기안 완료(`docs/adr/0168-…`) — Accept 시 발사 가능.
- **rescue stash**: 역행 패치(구스냅샷 복원) 확증. 보험 패치 세션 스크래치패드 저장. drop 명령만 성재 실행 필요(권한 분류기 차단).
- 잔여 성재 큐는 CURRENT_STATE 스냅샷 57 참조.
