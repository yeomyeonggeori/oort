# 핸드오프 패킷 — 검수 피드백 배치 1 (W-QA1~5)

> 발주: 2026-08-10 Fable. 편성 정본: `docs/planning/2026-08-10-desktop-qa-feedback-batch1.md`. 성재 승인 4결정: A 지금 발사·#2는 **채널 멤버 추가 재설계**·B는 있으면 배선/없으면 티켓·**C 대형까지 착수**(단 경계 변경이라 ADR 기안+설계까지, 구현은 Accepted 후).
> 공통 규율: 워크트리 base=origin/track/engine(main과 0/0 정렬)·PR base=track/engine·STOP·이탈은 PR 본문.
> **UI 하드룰**: 각 워커는 시작 시 `momo-design-taste` 스킬 로드(웹/데스크톱=`momo-design-taste-web` 방언). 자체 design-review 금지 — 머지 전 오케스트레이터가 design-review 에이전트 별도 실행(Blocker 0). 4상태·포커스·키보드 규칙 준수. 폰(clients/mobile) 범위 밖.

## W-QA1 · #1 포커스 링 → border 색상 (전면 스윕) · `fix/focus-border-qa1`

- 실체: `ring` 없음. `focus-visible:outline-2 outline-offset-2 outline-accent`가 **63파일 109곳 복붙**(프리미티브 button/input/select/dropdown 포함 각자 문자열).
- 방식: `clients/web/src/design/tokens.css`의 `@layer utilities`에 **공용 focus 유틸 신설**(선례=transition-colors 중앙화 `tokens.css:370-376`). 포커스 시 컨트롤 **border-color를 `--accent`로** 바꾸고 바깥 outline은 제거(또는 투명). 그 유틸로 109곳 치환.
- 예외 판정(워커 실측): ①`-outline-offset-2`(인셋) 쓰는 곳(ADE·WorkPanel 행·ObserverTerminal 등)은 컨테이너 특성상 border 부적합할 수 있음 — 유지 여부 표면별 판정, 보고. ②**border 없는 컨트롤**(고스트 버튼 등)은 focus 시 border를 새로 그리거나 저대비 배경 강조 중 표면 정합안 선택. ③접근성: border-color만으로는 색맹 사용자에 약할 수 있으니, border 두께 변화나 배경 병용을 taste 스킬 기준으로 판단.
- 검증: 웹 스위트+`design_preflight_web.sh`+치환 누락 0 grep(잔존 `outline-offset-2 outline-accent` = 의도적 예외만) + red proof(유틸 되돌리면 스냅샷/테스트 빨강). PR 본문에 예외 목록.

## W-QA2 · #2 채널 멤버 추가 모달 (재설계) · `feat/invite-modal-qa2`

- 현황: "멤버 초대하기"→`navigate("/settings?section=members")`(`ChatShell.tsx:859`). 그 목적지 `InviteSection`은 **워크스페이스 초대 링크 생성기**(채널 멤버 추가 아님).
- 성재 결정: **채널 멤버 추가 모달로 재설계**. 워크스페이스 로스터(`fetchRoster`)에서 아직 채널에 없는 멤버를 골라 `addChannelMember(ws, ch, memberId)`(`api.ts:1043`) 호출.
- 구현: `dialog.tsx` 프리미티브 + `useOpenCreateChannel`/`CreateChannelDialog`(MOMO-614) 패턴 복제 — 셸에 한 번 마운트, 진입점(빈 상태 버튼 `Timeline.tsx:427`, 디렉터리 `DirectoryRoute.tsx:255`)에서 open. 모달 내용: 로스터 목록(검색·에이전트/사람 구분)+선택+추가. 이미 채널 멤버인 사람은 제외/표시. 낙관적 갱신+실패 롤백.
- 빈 상태 카피(`packages/momo-core/.../timeline/model.ts:67`)의 `invitable`은 유지. 초대 **링크 생성**(기존 `InviteSection`)은 설정에 그대로 둠 — 이건 워크스페이스 레벨 초대라 별개.
- 검증: 웹 스위트+모달 열림/추가/중복제외/롤백 테스트+design-review 대상.

## W-QA3 · #3 채널 헤더 개선 · `feat/channel-header-qa3`

세 조각:
1. **멤버 표시 👤 N**: `ChatShell.tsx:634-650` `memberSummary`의 "이름 외 N"을 **사람 아이콘+인원수**로. 인원수는 클라 계산(`names.length` 또는 `channel.memberIds.length` — 조사대로 서버 count 없음, 클라 계산 유지). 아이콘은 기존 lucide(Users 등).
2. **채널명 클릭 메뉴**: context-menu 프리미티브 없음 → `dropdown-menu.tsx`로 클릭 트리거(헤더 `PinListMenu` 선례). 채널명 `<h1>`(`ChatShell.tsx:678`)에 트리거. 항목: 이름 수정·알림 끄기·채널 떠나기.
3. **각 액션 API**(있으면 배선/없으면 티켓 — 성재 결정):
   - 떠나기: **있음** `removeChannelMember(ws, ch, 자기 memberId)`(`api.ts:1064`). 배선(확인 다이얼로그+낙관적).
   - 이름 수정·알림 끄기: 웹 클라 래퍼 없음. **서버 라우트 실측**(`server-rust/bins/momo-server/src/lib.rs` 라우트 전수에서 channel PATCH/rename·mute/notification-pref 확인). 있으면 core api.ts 래퍼 추가+배선. 없으면 **메뉴에서 빼고 티켓 발급**(비활성 항목 두지 말 것).
- 검증: 웹 스위트+메뉴 열림/각 액션+red proof+design-review. 서버 실측 결과를 PR 본문에 명시.

## W-QA4 · #6 사용자 상태(presence) — ADR 기안 + 설계 (구현 아님) · `docs/presence-adr-qa4`

- 조사 판정: presence가 **서버 필드·API·Centrifugo 프레임 전 계층 전무**. 좌하단 칩은 실제로 **소켓 연결 상태**(사용자 상태 아님).
- 임무(구현 금지 — ADR 기안+설계 패킷): 
  1. **ADR 기안**(`docs/adr/016X-user-presence.md`, 다음 번호 확인) — status 모델(online/away/dnd/offline 등 어휘 결정 제안)·저장(PG 필드 vs 휘발)·set/read API·Centrifugo presence 프레임(불변식 "transport carries never authors"와의 정합)·프라이버시 경계. **Proposed 상태**(Accepted는 성재).
  2. **6a 즉시분 설계**: 연결칩을 하단 프로필 패널(`Sidebar.tsx:507`)로 이동하되 **연결 상태 의미 보존**(presence와 별개 — 옮겨도 연결 표시가 사라지지 않게). 이건 ADR 없이 가능한 프론트 이동이라 별도 구현 패킷 초안.
- 산출: ADR(Proposed) + 구현 계획(6a 즉시/6b ADR 승인 후) 패킷. PR은 문서만. 코드 0.

## W-QA5 · #4 워크스페이스 레일(디스코드형) — ADR 기안 + 설계 (구현 아님) · `docs/workspace-rail-adr-qa5`

- 조사 판정: 멀티 워크스페이스가 세션·데이터·API 미완(ADR-0117 미실현). 목록·나가기·이미지 업로드 API·워크스페이스 아바타 필드 전무. 레일의 "데"는 워크스페이스가 아니라 **로그인 사용자 이름 첫 글자**(prop 오배선 `Sidebar.tsx:287`).
- 임무(구현 금지 — ADR 기안+설계):
  1. **ADR 기안**(ADR-0117 증보 또는 신규 — 실측 후 결정): 멀티 워크스페이스 멤버십 모델(사용자↔워크스페이스 N:M)·목록/생성/나가기 API·워크스페이스 아바타(이미지 업로드=신규 미디어 경로 — Drive 계약 ADR-0151과의 관계)·세션 전환. **Proposed**.
  2. **4a 즉시분 설계**: prop 오배선 정정(워크스페이스명 실제 표시)+[+]를 설정 링크가 아닌 실제 생성 진입점(생성 API는 부분 존재)+현재/호버 시각 구분(디스코드 pill). ADR 없이 가능한 프론트. 별도 구현 패킷 초안.
- 산출: ADR(Proposed) + 구현 계획(4a 즉시/4b ADR 승인 후) 패킷. PR은 문서만. 코드 0.

## 보고 (전 워커)
PR 번호+검증+적립. W-QA3은 서버 실측 결과(rename/mute 유무) 필수. W-QA4·5는 ADR 번호+즉시분(6a/4a) 착수 가능 여부. 중간 보고 없음.
