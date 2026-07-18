# 엔진 ↔ UXUI 갭 감사 + 핸드오프 큐

> 규칙: `docs/TRACKS.md` §4. 상태: `ready`(대기) → `proposed`(성재 제안됨) → `in-progress` → `done`.
> UXUI 세션은 세션 시작 시 §A를 읽고 ready를 성재에게 "이거 구현할까요?"로 제안. 엔진 세션은 §B의 역요청을 수거.
> 2026-07-18 전수 감사(Fable, 코드 실측) — 근거 파일 명시.

## A. 엔진 완료 → UI 미구현/미연동 (UXUI 트랙 소비 대상)

| # | 상태 | 항목 | 실측 근거 | UI가 할 일 | 계약 포인터 |
|---|---|---|---|---|---|
| A-1 | `ready` | **마켓플레이스 실서버 연동** | `PluginMarketplaceView.swift`가 로컬 `MomoPluginCatalogItem` 카탈로그만 사용, macOS REST backend에 plugins 호출 0건 | 카탈로그 GET(`recommended` 필드로 추천 섹션)·설치/해제·grant 발급/회수 연동 | `/v1/workspaces/:ws/plugins...`, openapi 명세 완비 |
| A-2 | `ready` | **채널 웹훅 발급 UI** | `MomoAccountSettingsViews.swift:1451` `webhookPlaceholderDetail` — placeholder 문구 그대로 | 발급(one-time secret 1회 표시 UX 필수)·회전·revoke·수신 URL 복사 | WebhookRoutes.swift, openapi |
| A-3 | `ready` | **초대 단축 링크 노출** | 초대 UI에 `/i/<code>` 노출 grep 0건 | 초대 발급 화면에 단축 링크 복사 버튼(서비스 URL env) | services/LinkShort |
| A-4 | `ready` | **스레드 실전송 연동** | 컴포저 "스레드 초안"=로컬 초안만(`localDraft` 카피). 서버 `message.root_id`+`thread` 테이블 001부터 기존재 | 로컬 초안 → 실제 root_id 전송/스레드 뷰. 전송 REST의 root_id 개방 여부 선확인(§B-3와 짝) | 001_init.sql:174-205 |
| A-5 | `ready` | **허들 UI 폴리시** | V-3 design High 2건(disabled 사유 키보드 접근성, 상태별 시각 증거) + 실창 QA | 폴리시 + 성재 실오디오 QA 동행 | MomoHuddle*.swift |
| A-6 | `ready` | **파일 첨부 실업로드** | 컴포저 "파일 첨부"=로컬 초안만. **엔진 전제 완비**: Drive SA+공유 드라이브 실검증(2026-07-17), GWS-ARCHIVE 동결 해제 가능 | (엔진 선행 필요 — §B-1 업로드 API 랜딩 후) 첨부→업로드→메시지 연결 | 런북 §6.1, research/13-03 |

## B. UI 존재/요구 → 엔진 미구현 (엔진 트랙 역요청)

| # | 상태 | 항목 | 실측 근거 | 엔진이 할 일 |
|---|---|---|---|---|
| B-1 | `ready` | **첨부 업로드 API (GWS-ARCHIVE 해제)** | UI 로컬 초안 존재, 서버 업로드 경로 없음. SA·공유드라이브·boundary 전제 전부 실검증 완료 | AttachmentStore + resumable 업로드(클라 직송) + 메시지 연결 — ADR-0113 합류 티켓 |
| B-2 | `ready` | **워크스페이스 검색 서버 FTS** | macOS 검색=로컬 인덱스(정직 스코프 카피), `message_body_trgm_idx`는 스키마 기존재 | 검색 REST(권한 필터 포함) — MOMO-386의 서버 절반 |
| B-3 | `ready` | **전송 REST root_id 개방 확인/개방** | A-4의 전제. V-1 노트: "필요 시 동티켓 개방" | 메시지 전송 DTO의 root_id 수용 확인, 미개방 시 소형 티켓 |
| B-4 | `ready` | **알림 음소거/설정 계약** | 설정 UI·서버 계약 양측 부재(판정은 notifier 한 곳 — P9 정합 필요) | 채널/워크스페이스 음소거 계약 설계(ADR 소형) 후 UI |

## C. 랜딩됐지만 runtime-unverified (검증 부채)

| # | 항목 | 상태 |
|---|---|---|
| C-1 | 허들 2-클라 실오디오 왕복 | 성재 마이크 필요 — A-5와 함께 |
| C-2 | Work 실 Codex↔momo 왕복 (승인/resume) | mock만 검증 — 실 runtime 검증 티켓 후보 |
| C-3 | iOS deep link 실기기 재확인 | MOMO-469 랜딩 후 케이블 Run 1회 |

## D. 진행 중 (엔진)

| # | 항목 | 상태 |
|---|---|---|
| D-1 | V-3b iOS 허들 참가 | in-progress (track/engine) |
