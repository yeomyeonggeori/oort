# iOS v1 모바일 개편 계획 — 빌더블 이슈 분해 (2026-07-20, Fable 기안 · 성재 승인 대기)

> 발단: 성재 발제 — Discord(세련된 UXUI)·Mattermost(메신저 친화 모바일 문법)·Claude 앱(원격 작업 트래킹·중간보고·결과 서빙)을 레퍼런스로 iOS를 "푸시 확인용"에서 "슬랙/디스코드급 메신저 + 원격 Work 관제"로 승격.
> 정본: ADR-0123(iOS v0) 승계·확장. 구현=codex worker(iOS plugin), **컴파일·시뮬레이터·스냅샷은 전부 오케스트레이터**(worker 샌드박스 CoreSimulator/xcodebuild 불가 — v0 실측 교훈).
> 번호 예약: **MOMO-496~506** (+ 엔진 보완 E-1). 각 티켓 = goal 이슈 1개 = 핸드오프 패킷 겸용으로 발급.

## 0. 레퍼런스 해석 → momo 설계 원칙

| 레퍼런스 | 가져올 것 | momo 번역 |
|---|---|---|
| Discord 모바일 | 아바타·이름·연속 메시지 그룹핑, 채팅 밀도, 명확한 다크 위계, 컴포저(+·이모지·마이크) | 타임라인 v2 그룹핑·mention 하이라이트·컴포저 확장 |
| Mattermost 모바일 | **하단 탭바**(홈/검색/멘션/저장/프로필), Threads 진입점, unread 굵기·프레즌스 도트, replies N + Follow, 파일 카드, 날짜 구분선 | 탭 셸(홈/검색/활동/Work/프로필), 채널 목록 문법, 스레드 1급 |
| Claude 앱(코드) | **세션 리스트**(상태 배지·연결됨/해제됨·repo 라벨·시간), 세션 상세=진행 스트림+피드백 입력, **백그라운드 작업 시트**(실행 중 N/완료 N) | Work 탭 = work_session 리스트, 세션 상세 = 카드 스레드 관전+개입(work_input), 승인 카드 인라인 |

원칙: 에이전트 원장(승인·세션·스레드)이 이미 서버에 있으므로 **모바일은 "관전과 개입"에 집중** — 실행은 호스트(맥/workd/cloud), 폰은 트래킹·승인·중간보고 소비·개입 입력.

## 1. 티켓 분해

### Phase A — 기반 (선행)

**MOMO-496 · IOS-6: momo 앱 아이콘·브랜드 자산** `[ios]` 소형
- macOS 앱의 momo 아이콘 원본을 iOS AppIcon.appiconset 전 사이즈로 생성(1024 포함, iOS 다크/틴트 변형), TestFlight/홈 화면 반영. 런치 스크린 배경·AccentColor 정렬.
- 수용: 실기기 홈 화면·설정·알림 배너에서 momo 아이콘 표시. (원본 부재 시 codex-image로 후보 3안 생성 → 성재 선택)

**MOMO-497 · IOS-7: 네비게이션 셸 — 하단 탭바 + 채널 홈** `[ios]` 대형
- 탭 5개: **홈**(채널·DM 목록) / **검색** / **활동**(멘션·반응 피드) / **Work** / **프로필**(설정). Mattermost 문법.
- 홈: 워크스페이스 헤더, Threads 진입 행, CHANNELS/DM 섹션, unread 굵기+뱃지, 음소거 아이콘(기존 muted 투영), DM 프레즌스 도트, 채널 롱프레스(음소거 토글·읽음 처리). 스와이프 백 제스처 일관.
- 수용: 시뮬레이터 스냅샷(홈·각 탭 빈 상태) + 기존 화면(타임라인·승인) 탭 구조로 재배치, 회귀 0.

### Phase B — 메시징 패리티 (엔진은 전부 main 랜딩됨 — 소비만)

**MOMO-498 · IOS-8: 타임라인 v2 — 그룹핑·상태 렌더** `[ios]`
- 연속 메시지 그룹핑(동일 저자·5분 창 — Discord식), 날짜 구분선, mention 하이라이트(@나 배경 강조 — Mattermost식), edited 배지·tombstone("메시지 삭제됨")·코드블록/링크 렌더. `state/editedAtMs/deletedAtMs`(X-5 투영) 소비.
- 수용: 라이트/다크 스냅샷, 한국어 장문 3줄 오버플로 통과, 스크롤 성능(200+ 메시지) 육안 기준.

**MOMO-499 · IOS-9: 메시지 상호작용 — 롱프레스·반응** `[ios]`
- 롱프레스 컨텍스트 시트: 반응(이모지 피커+최근), 답글(스레드), 수정(작성자), 삭제(작성자·확인), 복사. reaction pill 행(카운트·내 반응 강조·탭 토글). X-5 realtime 4종 소비(Core 기완비), 재시작 복원.
- 수용: 맥에서 반응 → 폰 실시간 반영(C-4 모바일판 실증 겸용). fail-closed(비확정 seq 메시지 메뉴 미노출 — macOS A-9 규칙 동일).

**MOMO-500 · IOS-10: 스레드 1급** `[ios]`
- 타임라인 rollup 배지(replies N·참여자 아바타 — `Message.thread`), 스레드 화면(replies cursor 페이지네이션·과거 로드), thread.updated 실시간 갱신, 스레드 컴포저(rootId 전송), 홈의 Threads 목록(내가 참여한 스레드 — v0는 로컬 집계, 서버 팔로우 모델은 후속).
- 수용: 맥↔폰 스레드 왕복 실증.

**MOMO-501 · IOS-11: 첨부 송수신** `[ios]`
- 컴포저 +: 사진 라이브러리/파일/카메라 → 업로드 세션→직송 PUT→complete→attachmentIds(macOS A-6과 동일 계약·capability URL 무유출·ephemeral 세션). 수신: 이미지 인라인 미리보기·파일 카드(이름/크기)·탭 다운로드(QuickLook)·저장. 100MB 상한·실패 재시도.
- 수용: 사진 1장 폰→맥, 파일 1개 맥→폰 실왕복.

**MOMO-502 · IOS-12: 검색 + 활동 탭** `[ios]`
- 검색 탭: 서버 FTS(debounce·cursor·snippet 하이라이트·결과 탭→해당 메시지로 점프). 활동 탭: 내 멘션·내 메시지에 달린 반응 피드(v0는 히스토리 스캔 기반, 서버 활동 피드 API는 후속 엔진 항목으로 기록).
- 수용: 검색→점프 정확성, 멤버십 격리(서버 강제 확인).

### Phase C — 알림 고도화 (Slack/Discord 수준)

**E-1(엔진 선행) · MOMO-503: 푸시 페이로드 v2 — notifier 확장** `[runtime-db]`
- NSE fetch용 id-only 유지하되 가산: `thread-id`(스레드/채널 그룹핑용), 카테고리(`message`/`mention`/`approval`/`work`), 승인 푸시엔 approval_id, **서버 계산 badge count**(ADR-0109 unread 집계 재사용). verify_push_notifier 확장.
- 수용: verifier에서 페이로드 필드 단정 + 기존 억제(음소거) 회귀 0.

**MOMO-504 · IOS-13: 알림 UX v2** `[ios]`
- 알림 카테고리·액션: 메시지=**빠른 답장**(text input action→REST 전송), 승인=**승인/거부 액션**(잠금화면에서 결정→기존 승인 REST), work=세션 카드로 딥링크. 스레드별 그룹핑(thread-id), 앱 뱃지=서버 badge, **딥링크 수정 포함(MOMO-469/C-3 — 알림 탭→정확한 채널/스레드)**, 알림 설정 화면(카테고리별 on/off + 채널 음소거 연동).
- 수용: 실기기에서 빠른 답장·승인 액션·딥링크 3종 실증(C-3 종결).

### Phase D — 원격 Work 트래킹 (Claude 앱 모델 · 차별화 핵심)

**MOMO-505 · IOS-14: Work 탭 — 세션 관제 리스트** `[ios]`
- Claude 코드 탭 문법: 세션 카드 리스트 — 상태 배지(running 펄스 금지·정적 칩/ended), tool 아이콘, 라벨, 호스트 표시명(연결됨/해제됨 = host online), 시작 시간/경과. `GET work-sessions` + `work.session.*` 실시간. 필터(전체/실행 중). work_pool 사용량 행(슬롯 N/M — 489 GET).
- 수용: 맥에서 세션 시작→폰 리스트 즉시 반영, 종료 전이.

**MOMO-506 · IOS-15: 세션 상세 — 관전·개입·결과 수신** `[ios]`
- 세션 상세 = **카드 스레드 뷰**: 중간보고(발췌·에이전트 요약) 타임라인, **개입 입력**(스레드 답글 → 호스트 work_input 반영), work_read 요청 버튼("현재 출력 보여줘" → 호스트가 검토·공유한 발췌 수신 — D3 경계 유지), 결과물 수신(발췌 코드블록·첨부·PR/커밋 링크 카드). 스폰 **승인 카드 인라인**(모바일에서 승인/거부 + auto-approve 토글 — X-6 GET로 현재값).
- 수용: **모바일 E2E 1왕복** — 폰에서 spawn 승인→맥 PTY 실행→폰에서 개입 입력→발췌 수신. (Q1c 스택 재사용)

## 2. 미구현 엔진/UXUI 의존 정리 (계획에 반영됨)

| 갭 | 상태 | 소비 티켓 |
|---|---|---|
| X-7 에이전트 생성/pairing | MOMO-494 발급됨(엔진) | 온보딩 개선 시(iOS 범위 밖) |
| 푸시 페이로드 v2(badge·thread-id·카테고리) | **E-1=MOMO-503 신설(엔진)** | IOS-13 |
| 서버 활동 피드(멘션/반응 집계 API) | 후속 엔진 항목(v0는 클라 집계) — X-8 후보로 기록만 | IOS-12 |
| 스레드 팔로우 모델(서버) | 후속(v0 로컬) — X-8 후보 | IOS-10 |
| work_pool GET·X-6 GET·X-5 투영·검색·음소거·첨부 | **전부 main 랜딩 완료** | B·D 전역 |
| C-3 딥링크 버그 | IOS-13에 포함·종결 | IOS-13 |

## 3. 실행 규율 (codex iOS plugin worker 공통 계약)

- worker 프롬프트 필수 명시: `xcodebuild -scheme MomoiOS -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO` 시도 금지 아님—단, **컴파일 확증은 오케스트레이터**가 수행(worker는 swift 문법 수준까지), Swift 6 sending/Sendable 오류는 오케스트레이터가 잡는다(v0에서 3건 전례). 커밋·push 빈번 계약.
- MomoiOSKit 우선(뷰모델·클라이언트), XcodeHost는 타깃 설정만. Core 계약은 가산 소비(수정 필요 시 ENGINE_HANDOFF 역요청).
- 게이트: 오케스트레이터가 시뮬레이터 빌드+스냅샷+`verify_ios_build.sh`, 실기기 검증은 성재(케이블 Run 또는 TestFlight 내부 그룹 — v0 체계 재사용).
- 발급 순서: **496·497(기반) → 498·499(체감 큰 순) → 505·506(차별화, 엔진 의존 0) → 500·501·502 → E-1(503) → 504**. 병렬 최대 2(같은 파일군 충돌 방지 — ConversationViews가 핫파일).

## 4. 발급 대기

성재 승인 시: MOMO-496~506 이슈를 위 수용기준으로 발급(각각 패킷 겸용), BUILD_TICKETS 등재, 496부터 worker 착수.
