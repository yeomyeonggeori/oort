# ADR-0120: 푸시 알림 경계 — Dawn 운영 push relay + 서버 notifier

- Status: **Proposed** (2026-07-15, Fable draft — 성재 option 승인 대기)
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
