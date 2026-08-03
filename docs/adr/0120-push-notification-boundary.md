# ADR-0120: 푸시 알림 경계 — Dawn 운영 push relay + 서버 notifier

- Status: **Accepted** (2026-07-15, 성재 — 권고안 D1-A~D5-A 전체 승인. Dawn 운영 항목(Apple Developer 계정·relay 배포)은 별도 실행 결정, 서버측 P-1/P-2는 웹 배치 후 발급)
- 관련: `research/15-platform-expansion/01`(Slack 판정 교훈)·`02` §2-1(4사 relay 구조), ADR-0109(unread — 판정의 데이터 기반), ADR-0004(자격증명 비유입 — 같은 결의 content 비유입), ux-bible P8(알림 예산)·P9(판정 로직은 서버 한 곳)·P10(관측 내장), 로드맵 M5·EP-IOS(MOMO-040~043 승계)
- 발단: 성재 인프라 발제(2026-07-15) 중 푸시. iOS(M5)의 전제조건이며 Dawn 운영 인프라가 필요해 **리드타임이 가장 긴 항목** — 웹 우선 결정과 무관하게 draft를 선행한다.

## Context

1. **구조적 필연**: APNs 발송 열쇠(.p8/인증서)는 App Store 배포자만 가진다. 셀프호스팅 momo 서버 각각이 Apple과 계약할 수 없으므로, **모든 셀프호스트 서버는 Dawn이 운영하는 push relay를 경유해야만 iOS 푸시를 보낼 수 있다.** Mattermost(HPNS)·Rocket.Chat(gateway)·Zulip(bouncer)·Matrix(Sygnal) 전원이 같은 구조에 수렴했다(`research/15-platform-expansion/02` §2-1).
2. **스키마는 day-1부터 준비되어 있다**: `device`(ios/macos)/`push_token`(apns_token/env/topic/invalidated_at)/`push_dispatch_log`(apns_status/collapse_id) 테이블(`server/Migrations/001_init.sql:506-543`)과 APNs 운영 상수(ES256, 429/410→invalidate) 문서(`docs/DEPLOY.md:447-451`). 없는 것은 등록 REST·notifier worker·relay 서비스 전부다.
3. **판정이 본체다**: Slack의 20년 교훈은 "전송은 쉽고 판정(무엇을·누구에게·어느 기기로)이 어렵다 — activity와 delivery를 분리하고 판정을 한 곳에"(15-01 §1.5). momo는 unread/멘션의 SoT(`read_state`, ADR-0109)가 이미 서버에 있어 판정의 데이터 기반이 완비 상태다.
4. **과금 반면교사**: Mattermost의 id-only 유료 게이팅과 Rocket.Chat의 월 1만 건 제한은 커뮤니티 반발·우회 생태계를 낳았다. Zulip(관대한 무료+등록제+rate limit)이 유일하게 마찰 없는 모델.

## Options

### D1. relay 운영 형태
- **A (권고) — momo repo 내 신규 패키지 `relay/PushRelay`(가칭), Dawn 단독 배포**: OutboxRelay와 같은 Swift 패키지 문법. 셀프호스트 서버는 설치 시 relay에 등록(서버 ID+공개키)하고, 발송 시 서명 요청. Dawn만 APNs .p8을 보유·배포한다. 오픈소스 레포에 포함하되 운영은 Dawn 인프라 — 코드 투명성(셀프호스터가 뭘 거치는지 검증 가능) + 자체 빌드 앱 사용자는 자기 relay를 띄울 수 있음(Mattermost MPNS 패턴을 공짜로 얻음).
- B — 비공개 별도 repo: 투명성 상실, BYO-relay 경로 차단. **기각.**
- C — 서드파티 푸시 SaaS(OneSignal 등) 경유: 대화 메타데이터가 제3자에 유입, self-hosted trust 포지셔닝 정면 충돌. **기각.**

### D2. 페이로드 등급
- **A (권고) — id-only 기본**: relay에는 `{server_id, device_token, badge, channel_id/message_id 해시}`만 — **대화 내용이 Dawn 인프라를 지나지 않는다**(ADR-0004의 content 판). 클라이언트는 깨어나 자기 서버에서 fetch해 알림을 완성(iOS Notification Service Extension). Zulip E2E 봉투(Server 12+ 방식)는 v2 승격 후보.
- B — 내용 포함(full) 기본 + id-only 옵트인: 표시 지연은 없지만 셀프호스터 대화가 Dawn을 경유 — 신뢰 경계상 기본값이 될 수 없다. **기각(기본값으로는).** 셀프호스터 명시 옵트인 옵션으로만 검토(v1).
- C — Zulip식 E2E 암호화 봉투를 v0부터: 보안 최상이나 키 관리·확장 구현이 v0 범위를 초과. **보류(v2).**

### D3. 서버측 notifier
- **A (권고) — outbox 소비 단일 worker**: 기존 transactional outbox를 구독하는 notifier가 판정(v0: DM 전건 + 멘션 + 승인 요청; 채널 전체 알림 설정은 후속)→`push_dispatch_log` 기록→relay 호출. 판정 로직은 이 worker 한 곳에만 존재(P9). Slack activity/delivery 분리 교훈을 outbox(activity)/notifier(delivery)로 구현하는 셈 — 신규 개념 0.
- B — API 요청 경로에서 인라인 발송: 쓰기 경로 지연 + 판정 산재의 시작. **기각.**

### D4. 등록 REST와 수명주기
- 신규: `POST /v1/devices`(플랫폼·토큰 upsert), `DELETE`(로그아웃 시 invalidate). 410/400 응답 시 `invalidated_at` 기록(스키마 기존재). MOMO-041(APNs .p8 ES256+push_token 등록)의 계약을 승계·구체화한다.

### D5. 무료 정책
- **A (권고) — 전면 무료 + 서버 단위 rate limit + 남용 차단**: Zulip 모델. 대량 상업 사용의 과금은 momo Cloud/지원과 함께 ADR-0121 BM 절에서 다룬다 — relay 단독 과금은 하지 않는다.
- B — 건수 제한/유료 게이팅: 업계 반발 실증. **기각.**

## Decision (Proposed 권고안)

D1-A + D2-A + D3-A + D4 + D5-A. macOS 알림(APNs macOS topic)도 같은 파이프라인을 태운다(스키마 `device_platform`에 macos 기존재 — `001_init.sql:503`). Android/FCM은 iOS 랜딩 후 같은 relay에 추가.

## 파생 배치 후보 (Accepted 후 발급 — 서버측은 iOS 앱 이전 선행 가능)

| 후보 | 내용 | 프로파일 | 의존 |
|---|---|---|---|
| P-1 | device/push_token 등록·해지 REST + 수명주기(410 invalidate) | swift/runtime-db | 없음 |
| P-2 | notifier worker(outbox 소비·판정 v0·dispatch_log) — relay는 mock | swift/runtime-db | P-1 |
| P-3 | PushRelay 서비스 v0(등록제·서명 검증·rate limit·APNs 발송) + Dawn 배포 런북 | swift/infra | P-2, Apple Developer 계정 |
| P-4 | iOS Notification Service Extension(id-only fetch 완성) | M5/EP-IOS 합류 | P-3, MOMO-040 |

## Consequences

- (+) 셀프호스팅 배포 모델의 마지막 구조적 공백(모바일 알림)이 닫힌다. 내용 비유입으로 신뢰 경계 유지.
- (+) 판정을 notifier 한 곳에 고정 — Slack이 사후에 비싸게 정리한 산재를 원천 방지(P9).
- (+) BYO-relay 경로가 공짜 부산물로 생긴다(오픈소스 relay).
- (−) Dawn이 상시 운영 인프라(relay)와 Apple Developer 계정·키 커스터디를 짊어진다 — momo의 첫 "제품 부속 SaaS".
- (−) id-only는 알림 표시에 fetch 왕복 지연을 더한다 — 셀프호스터 서버가 느리면 알림도 느리다(문서에 명시).
- 보류: E2E 봉투(v2), FCM/Android, 채널별 알림 설정·DND(후속 — P8 알림 예산과 함께), 웹 브라우저 알림(ADR-0119 v1 합류).

---

# 부록 A — `work_session_idle` 푸시가 조용히 폐기된다 (**미결 · Accept 대기**)

> **상태: 제안(미결). 성재 승인 전까지 코드 변경 없음.** goal HYG-1(2026-08-03)에서 실측·기안.
> 위 본문의 Accepted 결정을 바꾸지 않는다 — 이 절은 그 결정이 만든 어휘 경계에서
> 발견된 결함과 선택지를 기록할 뿐이다.
> 발단: ADR-0139 D1이 약속한 "완료 감지 푸시"(`0139:20`)가 실제로는 배달되지 않는다.

## A-1. 증상 — 판정은 5개를 내고, 배달 경로는 4개만 안다

`reason` 어휘가 체인 중간에서 갈라진다. 아래는 전부 실측(파일:줄)이다.

| 지점 | 파일 | 어휘 | `work_session_idle` |
|---|---|---|---|
| 판정 SQL | `server-rust/crates/momo-push/src/judgment.rs:84-86` | 5 | **낸다** |
| 판정 SQL(Swift 원본) | `workers/NotifierWorker/Sources/NotifierWorker/NotifierService.swift:367-369` | 5 | **낸다** |
| Rust `PushReason` | `server-rust/crates/momo-push/src/dispatch.rs:45`·`:55` | 5 | **낸다** |
| **relay 검증기** | `relay/PushRelay/Sources/PushRelay/PushDispatch.swift:71-73` | **4** | **거부** |
| iOS NSE | `clients/iOS/MomoiOSKit/Sources/MomoiOSPushKit/PushNotification.swift:188` | 4 | 거부 |
| RN iOS kit | `clients/mobile/ios/MomoPushKit/PushNotification.swift:218` | 4 | 거부 |
| RN JS 미러 | `clients/mobile/src/push/contract.ts:62-68` | 4 | 거부 |
| e2e 게이트 단정 | `scripts/verify_push_notifier.sh:601` | **3** | 거부 |

`category` 는 **네 곳 모두 4종으로 일치**한다(`momo.message`·`momo.mention`·`momo.approval`·`momo.work`).
`work_session_idle` 은 `momo.work` 로 분류되므로(`dispatch.rs:122-124`) **category 관문은 통과하고
reason 관문에서만 죽는다** — 고칠 대상이 reason 어휘 하나로 좁혀진다는 뜻이다.

## A-2. 죽는 경로 — 400이 "영구 실패"로 정산되어 폐기된다

1. Swift API 가 idle 전이 시 `props.kind="work_session_idle"` 메시지를 넣는다
   (`server/Sources/MomoServer/Routes/WorkSessionRoutes.swift:913-918`, 본문 `:933`).
   호출자는 **work-host 서명 주체**(T2 데몬)다.
2. 판정이 그 메시지를 **세션 소유자 한 명에게만** `work_session_idle` 로 라벨한다
   (`judgment.rs:84-86` — `owner_member_id` 일치가 조건, `:106-109` 는 작성자 제외 규칙의 예외).
3. notifier 가 서명해 relay 로 POST 한다(`momo-notifier/src/push_relay.rs:175`·`:204`).
4. relay 가 reason 관문에서 던지고, 핸들러가 **어느 필드가 틀렸는지 알려주지 않는 맨 400** 으로 뭉갠다
   (`relay/PushRelay/Sources/PushRelay/App.swift:67-71`).
5. notifier 가 400 을 **영구 실패**로 분류한다(`push_relay.rs:137-143` — 429/5xx만 transient).
6. 그대로 `settle` 되고 `Ok(true)` 를 돌려준다(`momo-notifier/src/push.rs:266-288`).
   outbox 행은 done, `push_dispatch_log` 는 `apns_status=400`,
   `apns_reason="relay_http: HTTP 400"`. **재시도 없음, 배달 없음, 사용자 신호 없음.**

즉 매 idle 전이마다 서명된 요청이 한 번 오가고 조용히 묻힌다.

## A-3. 왜 아무도 못 잡았나 — 목 relay 가 어휘를 검증하지 않는다

`scripts/mock_push_relay.py` 의 검증 전부는 ⓐ 경로가 `/v1/push` 인가 ⓑ JSON 인가
ⓒ 객체인가 셋뿐이고(`:53-65`), **무조건 200 + `apns_status:200`** 을 돌려준다(`:76-83`, `:87`).
reason·category·schema·서명·필드집합 어느 것도 보지 않는다.

그래서 `scripts/verify_work_session_idle.sh:388-405` 는 `apns_status=200` 인 행 3개를 기다렸다가
`:406-421` 에서 "relay 가 `reason=work_session_idle`·`category=momo.work` 로 받았다"고 단정하며 **PASS 한다.**
게이트가 초록인 이유는 동작이 옳아서가 아니라 **목이 아무것도 안 보기 때문**이다.

## A-4. 영향 범위 — 배포 조합상 **잠재가 아니라 실동 결함**이다

현재 배포는 **Swift API + Rust notifier + Swift PushRelay** 다:
`infra/prod/docker/momo.Dockerfile:25-26`(prod 이미지가 굽는 API 는 Swift `MomoServer`),
`infra/rust/docker-compose.push.yml:115-117`(notifier = Rust `momo-notifier`),
`:62-63`(push-relay = Swift PushRelay).

이 조합에서 A-2 가 그대로 성립한다. 반대로 **Rust API** 를 세우면 idle 전이 자체가
work-host 서명 미포팅으로 400 거부라(`server-rust/bins/momo-server/src/routes/work_sessions.rs:466-472`,
사유는 `:37-42`) 결함이 드러나지 않는다 — 즉 **API 를 Rust 로 옮기면 증상이 사라져 더 찾기 어려워진다.**

잃는 것: **T2/T3 작업 세션의 "완료 — idle 대기" 알림이 통째로 안 간다.** ADR-0139 D1(`:20`)이
약속한 바로 그 신호이고, 사용자 입장의 시나리오("폰 닫고 나갔다가 끝나면 알림 받고 돌아온다")의
마지막 한 칸이다. 세션 자체·재부착·스크롤백은 정상이며 **알림만** 없다.
호스트 사망 경로(`resume_offer`)는 어휘에 있으므로 정상 배달된다.

## A-5. 선택지와 대가

### 선택지 1 — **어휘를 5종으로 넓힌다** (relay + 클라 검증기)
- 바꿀 곳: `PushDispatch.swift:71` · iOS `PushNotification.swift:188` · RN kit `:218` ·
  RN JS `contract.ts:62-68` · 게이트 `verify_push_notifier.sh:601` · 목 relay.
- 대가: **와이어 계약 변경**이라 ADR-0120 개정이 필요하다. 클라 검증기는 **앱 바이너리에 박혀
  배포**되므로 이미 나간 빌드는 새 reason 을 모른다. RN 사본은
  `scripts/verify_push_kit_inheritance.sh` 가 iOS 원본과 대조하므로 둘이 같이 움직여야 한다.
- **완화(중요):** 구버전 앱은 **죽지 않고 fail-open** 한다 — NSE 가 파싱 실패 시 relay 의 정적
  자리표시자를 그대로 보여준다(`clients/iOS/NotificationService/NotificationService.swift`
  의 `// Fail open` 분기; 자리표시자는 `PushDispatch.swift:104-105` 의 `"momo"` / `"새 알림"`).
  category 는 이미 `momo.work` 라 탭하면 작업 세션으로 정상 진입한다
  (`PushRegistration.swift:136` `opensWorkSession`). 즉 **구버전에서는 문구만 일반형으로
  퇴화하고 알림 자체는 도착한다.** 따라서 relay 를 먼저 넓히고 클라가 따라가는
  **순차 배포가 가능**하며, 원자적 동시 랜딩이 필요 없다.
- 남는 비용: 어휘가 하나 늘어 네 표면이 영구히 동기화 대상이 된다.

### 선택지 2 — **판정에서 제거한다**
- 바꿀 곳: `judgment.rs:84-86`·`:106-109` · Swift `NotifierService.swift:367-369`·`:391` ·
  `PushReason::WorkSessionIdle` · `dispatch.rs:122-124`.
- 대가: **ADR-0139 D1 이 약속한 기능의 철회**다. 사용자는 작업이 끝난 걸 알 방법이 없어
  직접 들어와 확인해야 한다. Accepted ADR 을 코드 정리로 되돌리는 모양이라 어차피 성재 결정이 필요하다.
- 이점: 와이어 무변경, 최소 diff, 낭비 왕복과 오해를 부르는 400 로그가 사라지고
  게이트가 즉시 정직해진다.

### 선택지 3 — **`resume_offer` 로 접는다**
- 바꿀 곳: `judgment.rs:84-86` 이 `resume_offer` 를 내도록. category 는 어차피 양쪽 다
  `momo.work`(`dispatch.rs:122-124`)라 **와이어·클라 변경 0**.
- 왜 통하나: 어느 클라이언트도 `reason` 으로 분기하지 않는다 — 검증만 하고 버린다.
  화면 동작은 전부 `category`(`IOSPushActionExecutor.swift:38`·`:63`,
  `PushRegistration.swift:136`)와, id-only 봉투로 **다시 fetch 한 메시지의 `props.kind`** 가 정한다.
  그래서 사용자에게는 오늘 당장 올바른 카드가 뜬다.
- 대가: **`reason` 이 거짓말이 된다.** ADR-0139 D3 가 명시적으로 갈라 둔 두 경로
  — 재부착(호스트 생존·idle) vs 계보 재개(호스트 사망·orphaned) — 이 `push_dispatch_log`
  와 관측에서 한 값으로 뭉개진다. D3 는 "같은 버튼에 섞지 않는다"고까지 적었다(`0139:29`).
  나중에 `reason == "resume_offer"` 를 근거로 뭔가를 만드는 사람이 idle 세션까지 함께 받는다.

## A-6. 권고 — **선택지 1(어휘 확장), 단 검수 이후 · relay 우선 순차 배포**

근거:
1. `reason` 의 역할은 **서버 판정을 사실대로 나르는 것**이다. 선택지 3 은 그 필드를 거짓으로
   만들어 ADR-0139 D3 가 비싸게 갈라 둔 구분을 관측에서 지우고, 선택지 2 는 Accepted ADR 이
   약속한 기능을 조용히 철회한다. 둘 다 "검증기를 우회하려고 의미를 굽히는" 형태다.
2. 선택지 1 의 최대 비용으로 지목되던 **클라 동시 배포 제약이 실제로는 없다** — A-5 의
   fail-open 실측 때문이다. 구버전 앱도 알림을 받고 탭하면 올바른 화면으로 간다
   (문구만 `"momo" / "새 알림"`). 그래서 **relay 를 먼저 넓히고 클라를 뒤따르게** 할 수 있다.
3. 비용은 1회성·경계 확정적이다(어휘 1개, 표면 4개). 선택지 3 의 비용은 영구적이고
   미래의 오독으로 갚는다.

**순서 제안**
1. 성재 Accept → ADR-0120 본문 어휘를 5종으로 개정(이 부록을 결정으로 승격).
2. `mock_push_relay.py` 에 reason·category 검증을 넣는다. **이걸 먼저 해야** 게이트가
   비로소 이 층을 본다(지금은 무엇을 바꾸든 초록이다).
3. relay 확장 + `verify_push_notifier.sh:601` 을 5종으로.
4. 클라 검증기 4종(iOS·RN kit·RN JS)과 `verify_push_kit_inheritance.sh` 를 한 세트로.
5. **`clients/*` 는 성재 실기기 검수가 끝난 뒤에 건드린다** — 지금은 안정화 구간이다.

## A-7. 이 배치가 남긴 못(현행 고정)

코드 동작은 **하나도 바꾸지 않았다.** 대신 현행을 세 곳에서 못박아, 누가 어휘를 넓히면
반드시 빨개지고 이 부록을 다시 읽게 했다.

- `server-rust/crates/momo-push/src/dispatch.rs:71-88`(`accepted_by_relay`) + 그 테스트
  `dispatch.rs:482-505` — **기존**. 다만 이 술어는 **문서·테스트 전용**이고 발송 경로에서
  호출되지 않는다(호출부 0). 그래서 낭비 왕복은 그대로 일어난다.
- `relay/PushRelay/Tests/PushRelayTests/PushRelayTests.swift`
  `testWorkSessionIdleIsRejectedEvenThoughItsCategoryIsAllowed` — **신규**. relay 자기 스위트에
  거부를 고정하고, category 는 통과하고 reason 에서만 죽는다는 사실까지 단정한다.
- `scripts/tests/test_push_relay_vocabulary_contract.py` — **신규**. 다섯 표면의 어휘를 정적으로
  대조하고, **목 relay 가 `work_session_idle` 을 200 으로 받는 것을 루프백 소켓으로 실증**한다
  (docker·DB·외부망 없음). `local_gate.sh` "python syntax" 단계에 등록.
