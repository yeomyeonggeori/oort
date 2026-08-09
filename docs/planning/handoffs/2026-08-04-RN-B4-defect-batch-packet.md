# 핸드오프 패킷 RN-B4 — 모바일 결함 배치 (성재 파이널 체크 수확분 + 적립 큐)

- status: **ready** · worker: Opus 5 (모바일) · 기준: `origin/track/engine` 최신(`66679a1c` 이후) · goal별 브랜치·PR 순차(같은 파일권은 앞 goal 위에 스택)
- 발단: 성재 실기 검수 발견 3건 + 레인/리뷰 적립 2건. **턴 규율**: 20분 내 턴 종료·goal마다 SendMessage 보고.

## Goal 1 — #1025 채널 진입 앵커
- 증상(성재 원문): *"채널에 진입을 하면 제일 하단으로 이동해야 하는데, 왜 자꾸 상단 어중간한 부분에서 진입되는 거야?"*
- 계약: 진입 시 **항상 최신(하단)**. 기존에 "읽던 위치 복원" 정책이 코드에 있으면 그 정책과의 충돌을 먼저 실측하고 판정 근거를 PR에(성재 지시가 우선 — 복원 정책이 있었다면 폐기가 아니라 성재 확인 항목으로 이탈 보고).
- 의심 지점: Timeline 초기 스크롤/anchor 로직·`initialNumToRender`(#1003이 8로 고정)와 콘텐츠 높이 추정의 상호작용. 진단 선행.
- red proof: 진입 앵커 단정 제거 시 이름 있는 실패.

## Goal 2 — #1026 pull-to-refresh
- 에이전트 탭(대표)·인박스·채널 목록에 표준 RefreshControl. 각 표면의 기존 쿼리 invalidate 재사용(새 fetch 경로 금지). 대화 타임라인은 **제외**(realtime이 정본 — 당김이 이력 페이지네이션과 충돌하면 혼란).
- 디자인: 시스템 표준 스피너, 토큰 색.

## Goal 3 — #1027 한국어 조사 판별
- 증상 실측: "루나**은(는)** 현재 일시정지되어 있습니다"(paused 시스템 라인).
- core에 순수 조사 유틸(받침 판별 — 은/는·이/가·을/를), **문구 생산 지점 전수 적용**. 시스템 라인이 서버 발신이면(paused_mention_body는 서버다!) 서버측 대응 필요 여부를 실측해 이탈 보고(서버 수정은 범위 밖 — 발견만).
- 주의: 영문 이름·숫자 끝 이름의 폴백(병기 유지가 정직할 수 있음 — 판단 근거 명시).

## Goal 4 — #1020 인박스 리얼타임 invalidate
- 레인이 실측한 결함: 앱 사용 중 도착한 승인이 인박스에 60초+ 안 뜸(FEED_STALE_MS·display:none 비언마운트·리얼타임 invalidate 부재).
- 수리: approval 계열 리얼타임 이벤트 수신 시 인박스 쿼리 invalidate(웹 `useInvalidateApprovals` 대응물) — 탭 포커스 refetch도 검토. **수리 후 MAESTRO 30-approval의 앱 재기동 우회 제거**(clients/mobile/maestro — 우회가 결함보다 오래 살면 안 된다).
- red proof: invalidate 절단 시 레인 플로우가 이름 있는 실패(우회 제거 상태에서).

## Goal 5 — #1011 AppState 커서 flush
- #1003의 알려진 잔여: 백그라운드 전환 시 600ms 창 커서 유실. AppState 구독으로 flush — 기존 "밀려남/떠남" 분리 구조(ConversationScreen)에 세 번째 갈래로.

## 공통
- 수정 범위: `clients/mobile/**` + core 순수 유틸(Goal 3). 서버·웹 소스 금지(발견은 이탈 보고).
- goal마다: mobile 전체+typecheck+red proof → PR("Closes #10XX") → 보고. **Goal 4 완료 후엔 `npm run lane:phone` 1회로 레인 무회귀 확인**(우회 제거 검증 겸).
