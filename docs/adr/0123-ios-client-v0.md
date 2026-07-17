# ADR-0123: iOS 클라이언트 v0 — dogfood-first 모바일 수신부

- Status: **Accepted** (2026-07-17, 성재 — D1~D6 권고안 전체 승인 "ㄱㄱ". IOS-1(MOMO-462)부터 순차 발급, 구현=codex iOS 플러그인)
- 관련: ADR-0120(푸시 — P-1/P-2/P-3 랜딩 완료, P-4가 이 ADR로 합류), ADR-0119(웹 v0 — "웹 먼저" 결정의 다음 순번), ADR-0112(제품 표면), `docs/BACKLOG.md` EP-IOS(MOMO-040~043 레거시), ROADMAP M5, ux-bible P1~P15
- 발단: 성재 지시(2026-07-17) "iOS 클라이언트 트랙 기획부터 진행. 구현은 codex iOS 플러그인으로 위임." 서버측 푸시 전 구간(등록 REST→notifier→PushRelay 실발송)이 완성되어 모바일 수신부만 남았다.

## Context

1. **모바일의 제1가치는 수신이다**: 이동 중 알림 수신→열람→짧은 답장→**승인 결정**. 특히 "이동 중 에이전트 승인"은 Slack 모바일에 없는 momo 고유 가치다(승인 카드는 이미 macOS에서 실물).
2. **재사용 자산 실측**: `clients/Core`(MomoCore, 20파일)는 AppKit 의존 0 — REST/Centrifugo/모델 전부 iOS에서 그대로 쓴다. `clients/macOS`의 뷰·뷰모델은 Mac 관용구(NavigationSplitView·창 크롬·키보드)에 결합되어 직접 공유 대상이 아니다.
3. **레거시 EP-IOS 정리**: MOMO-040(xcodeproj 골격)은 승계. MOMO-041(APNs 서버측)은 ADR-0120 P-1~P-3으로 **이미 완성**. MOMO-042(계정 삭제)·043(privacy manifest)·EP-UGC는 **App Store 제출 요건** — dogfood v0와 무관하므로 M8/EP-STORE 시점으로 이월.
4. **배포 전제 확인됨**: 성재 개인 유료 Apple Developer 계정(Team `YWQQFQM38J`), APNs 키 실검증 완료(2026-07-17). TestFlight internal은 개인 팀으로 충분. Apple silicon 시뮬레이터는 APNs sandbox 푸시 수신을 지원해 실기기 전 검증 폭이 넓다.

## Options & Decision

### D1. 타깃 구조와 코드 공유
- **A (권고) — 얇은 앱 셸 + SwiftPM 킷 + MomoCore 재사용**: `clients/iOS/MomoiOS.xcodeproj`(앱 엔트리·서명·capability만) + `clients/iOS/MomoiOSKit`(SwiftPM — 뷰·뷰모델·전 로직, 테스트 가능) + `clients/Core` 의존. macOS 뷰모델 공유는 v0에서 하지 않는다 — **복제 후 수렴**(v1에서 공용 ViewModel 추출 재평가, 지금 추출하면 활발한 UX 트랙과 충돌).
- B — 멀티플랫폼 단일 타깃(macOS 앱에 iOS destination 추가): Mac 관용구 결합 해체 비용이 v0 가치를 넘는다. 기각.

### D2. v0 스코프 (dogfood-first)
- **포함**: 로그인/워크스페이스 부트스트랩(기존 REST 그대로) · 채널/DM 목록+unread 배지(ADR-0109 계약) · 타임라인 실시간 열람(Centrifugo 구독, `message.seq` 순서) · 메시지 전송/답장 · **승인 카드 열람+승인/거부**(기존 결정 REST) · 푸시 수신+탭 시 해당 채널 deep link.
- **제외(후속)**: 검색, 파일 업로드/열람, Work 콘솔 상세, 설정 편집, 스레드 작성(열람은 타임라인 인라인 수준), 음성(ADR-0122 별도), 계정 삭제·privacy manifest(M8).
- 원칙: iOS는 **수신·결정 우선의 컴패니언**이지 macOS 패리티가 아니다(패리티 압박은 로드맵 왜곡의 주범 — Slack 모바일 교훈).

### D3. 푸시 P-4 합류
- ADR-0120 P-4를 이 트랙의 티켓으로 실행: Notification Service Extension이 **id-only 페이로드**(P-2/P-3 하드 계약)를 받아 REST로 본문 fetch 후 알림 표시(mutable-content 경로 정착 — P-3 후속 노트였던 push-type/alert 조합도 여기서 확정). 등록은 기존 `POST /v1/devices`.

### D4. 배포
- **TestFlight internal 전용**(v0): Team `YWQQFQM38J`, bundle `app.momo.ios`(push topic=bundle id — P-1 등록 계약과 정합). 서명·업로드는 `[manual]` 런북(성재 수행, Fable 안내). App Store 제출은 M8에서 042/043/EP-UGC와 함께.

### D5. 구현 파이프라인
- 구현=Codex worker(성재 지정 — codex iOS 플러그인), 현행 계약 유지: worker는 `xcodebuild build`(simulator, `CODE_SIGNING_ALLOWED=NO`)+단위 테스트까지, **시뮬레이터 게이트는 오케스트레이터**(신규 `ios` 게이트 프로파일: build-for-testing + test-without-building). `clients/iOS/**`는 이 트랙 전용 파일군 — UX 트랙(clients/macOS)과 무충돌.
- 디자인: momo-design-taste의 iOS 변형(§iOS: HIG-first, Dynamic Type, 밀도/모션 기준, Mac AI-tells의 iOS 대응 표) 을 IOS-1에서 rubric 문서로 추가, design-review 에이전트 재사용.

### D6. 파생 배치 (순차 — 같은 파일군, worker 1기씩)
| 티켓 | 내용 | 승계 |
|---|---|---|
| IOS-1 | 골격: xcodeproj+MomoiOSKit+MomoCore 연결, 로그인/부트스트랩, `ios` 게이트 프로파일, taste rubric iOS 절 | MOMO-040 |
| IOS-2 | 채널/DM 목록+unread + 타임라인 실시간 열람 | — |
| IOS-3 | 컴포저(전송/답장) + 승인 카드 결정 | — |
| IOS-4 | 푸시: 디바이스 등록 + NSE id-only fetch + deep link | ADR-0120 P-4 |
| IOS-5 | TestFlight 런북(`[manual]` 서명/업로드) + 시뮬레이터 푸시 E2E evidence | — |

## Consequences

- (+) 서버측 푸시 투자(P-1~P-3)가 사용자 체감 가치로 완결된다. "이동 중 승인"이 첫 모바일 차별점.
- (+) MomoCore 단일 계약 위에 3번째 클라이언트(macOS·웹·iOS) — 서버 계약의 실질 호환성 검증이 된다.
- (−) 뷰 레이어 복제 비용(macOS와 이중 유지) — v1 수렴 항목으로 명시 관리. 스토어 요건(042/043) 이월은 M8 전 반드시 회수.
- 보류: iPad 레이아웃, 위젯/라이브 액티비티, macOS Catalyst, 오프라인 큐.
