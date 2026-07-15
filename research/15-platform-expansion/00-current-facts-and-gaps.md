# 15-00 · 플랫폼 확장 리서치 — 범위와 코드 사실 지도

> Planning ID: `PLN-20260715-02` (owner: Fable) · 기준: 2026-07-15 @ 9c1fc7a
> 발제(성재, 2026-07-15): ① 메신저 아키텍처 이해도를 세우는 "바이블" ② Codex 앱류 슈퍼앱으로의 고도화에서 비개발자/개발자 동시 수용 ③ iOS·푸시·프레즌스·그룹채팅·파일·웹훅·리전 등 인프라 + 셀프호스팅 무료 서버 개설·초대 모델 + 웹 접근(서버 URL로 웹 접속).

## 산출물 지도

| 질문 | 산출물 |
|---|---|
| ① 바이블 | `docs/architecture/bible/` (README + 01~06장, 초판) — 학습용 파생 문서 등급 |
| ②③ 리서치 원자료 | 이 디렉터리 01(Slack/Discord), 02(셀프호스팅 4종) |
| ②③ 결정 제안 | `03-decision-proposals.md` — ADR 분해·로드맵 배치·티켓 후보 (성재 승인 대기) |

## 코드 사실 지도 — "자리는 있고 경로만 없다"

2026-07-15 탐사 결과(전수 라우트 인벤토리 포함)의 압축. 공통 패턴: **스키마·모델·placeholder는 준비되어 있고, 라우트+worker+클라이언트 연결만 비어 있다.** 즉 대부분의 확장이 "재설계"가 아니라 "채우기"다.

| 도메인 | 있는 것 | 없는 것 | 기존 예약 |
|---|---|---|---|
| 푸시 | `device`/`push_token`/`push_dispatch_log` 테이블(`001_init.sql:506-543`), APNs 운영 상수 문서(`docs/DEPLOY.md:447-451`) | 토큰 등록 라우트, 발송 worker, 판정 로직, **momo 운영 push relay(신규 결정 필요)** | M5 · MOMO-040~043 |
| presence/typing | Centrifugo namespace presence 켜짐(`infra/centrifugo.json:4,9,12`), 클라 `PresenceDelta`/`TypingDelta` 모델, `ChatBackend.setTyping` 프로토콜 | 서버 소유 경로 전무 — `setTyping`은 no-op(`MomoServerRESTChatBackend.swift:562`), heartbeat 없음 | ADR-0104 (결정 큐) |
| 파일 | `file` 테이블 + `message_type='artifact'`(`001_init.sql:227-246`), Drive 설계(`research/13-redesign/03`)·GWS 런북 | 업로드/서빙 라우트, 클라 경로 전부 | **동결** — ADR-0113/0116 게이트 |
| 웹훅 | 채널 설정 placeholder 탭(`MomoAccountSettingsViews.swift:1060-1065`) | 발급·서명·수신 전부 | ADR-0115 + SE-04A/B |
| 웹 클라이언트 | 없음 (0건) | 전부 — 로드맵에 트랙 자체가 없음(`ROADMAP.md:77`) | **미예약 — 신규** |
| iOS | MomoCore iOS 타깃(`clients/Core/Package.swift:16`), fastlane lane, release-ios.yml | 앱 소스(`clients/iOS` 없음) | M5 · EP-IOS · MOMO-040~043 |
| 그룹채팅 | **완비** — channel/membership/channel_seq/DM(dm_key)·read_state 전부 코어 | (없음 — 신규 결정 불요) | — |
| 배포판 | prod compose 8서비스 + Caddy TLS + SOPS + pgBackRest + GHCR 수동 발행 + preflight | install/upgrade 스크립트(ADR-0002 예약), 비개발자 포장, 단일노드 상한 문서 | ADR-0002/0107/0108 |
| 리전 | 명시적 단일 노드(EC2 t4g.large) + 확장 레버 문서(`docs/DEPLOY.md:504-515`) | 멀티 리전 관련 일체(의도적) | **미예약** — 05 리서치 결론: 불요 |
| 초대/합류 | invite hash 발급/redeem/revoke + 공개 `/v1/join`(`JoinRoutes.swift:20-57`) + 감사 | universal link/QR, 앱 미설치 관통 흐름 | ADR-0112 D4 (온보딩 여정) |
| 멀티 워크스페이스 | 서버/DB day-1 멀티테넌트 (RLS FORCE) | 클라이언트 UI (의도적 잠금) | ADR-0117 |

## 스케일 준비도 (재확인)

- API stateless (다중화 가능), relay/worker `SKIP LOCKED`(다중 안전), Centrifugo prod=Redis 엔진(노드 추가 가능), 순서/복구 권위는 PG(`docs/DEPLOY.md:279`).
- 유의: in-process rate limiter(`App.swift:37`)는 프로세스 로컬 — API 다중화 시 per-IP 한도가 인스턴스별로 쪼개진다. 다중화 티켓에 함께 기록할 것.

## 이 리서치가 존중하는 경계

- MOMO-300~323 번호 블록 재사용 금지(전부 할당), 신규 티켓은 **MOMO-389+**.
- ADR 번호 0103~0118 회피, 신규는 **0119+** (발급은 성재 승인 후).
- 파일 저장 백엔드를 이 리서치가 재결정하지 않는다 — 동결 계약(ADR-0113/0116 대기) 승계, 단 "가벼운 첨부 vs Drive 문서 분리" 질문을 input으로 제출.
- M0~M8 backbone과 M7 게이트 불변식은 불변 — 제안은 전부 overlay.
