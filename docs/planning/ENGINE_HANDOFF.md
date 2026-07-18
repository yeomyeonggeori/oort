# 엔진 ↔ UXUI 갭 감사 + 핸드오프 큐

> 규칙: `docs/TRACKS.md` §4. 상태: `ready`(대기) → `proposed`(성재 제안됨) → `in-progress` → `done`.
> UXUI 세션은 세션 시작 시 §A를 읽고 ready를 성재에게 "이거 구현할까요?"로 제안하고, 집으면 상태를 갱신한다.
> 2026-07-18 밤 통합판: UXUI 실서버 연동 배치(A-1/2/3/5/7 + A-4 답글 전송)와 엔진 배치(음소거 MOMO-477·상호작용 MOMO-478·X-1)가 main에 랜딩.

## A. UI 작업 큐 — UXUI 트랙 소비 대상

| # | 상태 | 항목 | UI가 할 일 | 착수 포인터 (전부 main) |
|---|---|---|---|---|
| A-1 | `done` | **마켓플레이스 실서버 연동** | REST 카탈로그·추천·설치/해제·grant 발급/회수와 상태 UI를 연결. `external_webhook`은 채널 통합으로 라우팅하고 세션 변경 시 캐시를 전부 폐기 | `GET/POST/DELETE /v1/workspaces/:ws/plugins...` — PluginRoutes.swift, openapi 명세 완비 |
| A-2 | `done` | **채널 웹훅 발급 UI** | native/Slack 호환 발급·회전·revoke·목록을 연결. one-time secret/URL은 확인 전 화면 이탈을 잠그고 확인 즉시 메모리에서 폐기 | WebhookRoutes.swift, openapi |
| A-3 | `done` | **초대 단축 링크 노출** | HTTPS(로컬 개발 예외) public base URL을 검증해 `/i/<code>`를 1회 노출·민감 클립보드로 복사하고 확인 전 이탈을 잠금 | services/LinkShort/README.md |
| A-4 | `in-progress` | **스레드 실전송** | `rootId`를 포함한 1단계 답글 실전송·엄격 응답 검증 완료. 정확한 서버 롤업/오래된 답글 조회는 **X-3 엔진 계약 대기** | `SendMessageRequest.rootId` + thread 롤업 — MessageRoutes.swift, `verify_thread_reply.sh`가 계약 예시 |
| A-5 | `done` | **허들 UI 폴리시** | 비활성 사유를 포인터·키보드에서 동일하게 설명하고 참가 전/참가 중 상태의 아이콘·레이블·동작을 분리 | MomoHuddle*.swift |
| A-6 | `in-progress` | **파일 첨부 실업로드** | 업로드 송신 API는 확인했으나 수신 메시지가 첨부를 발견할 Core/history/realtime 투영이 없어 **X-4 엔진 계약 대기**. 로컬 초안을 실물로 오인시키는 부분 구현은 하지 않음 | AttachmentRoutes.swift, openapi, `verify_attachment_upload.sh`가 흐름 예시 |
| A-7 | `done` | **검색 서버 승격** | 기존 destination 심을 유지하면서 서버 FTS, 300ms debounce, 최신순 cursor pagination, 오류/빈 상태와 정확한 과거 메시지 이동을 연결 | `GET /v1/workspaces/:ws/search/messages?q=&cursor=` — 멤버십 필터 서버 강제·snippet+matchOffset 제공, SearchRoutes.swift |
| A-8 | `done` | **채널 음소거 설정 UI** | 채널 목록 `muted` 투영·음소거 아이콘·컨텍스트/설정 토글·낙관 갱신/롤백을 연결. 멘션 포함 전면 억제·unread 무영향(ADR-0124)을 UI에 명시 | ChannelRoutes/DTOs, verify_notification_mute.sh가 계약 예시 |
| A-9 | `in-progress`(REST/로컬 UI 완료, X-5 대기) | **반응/수정/삭제 UI 개방** | edit/remove/delete/reaction snapshot 실호출과 capability 개방, 세션 전환·동시 수정/삭제 방어 완료. 타 클라이언트 realtime 및 재진입 history 복원은 **X-5 엔진 계약 대기** | PATCH·DELETE /v1/workspaces/:ws/messages/:id, PUT·DELETE .../reactions/:emoji, GET .../channels/:ch/reactions — openapi 명세·verify_message_interaction.sh 계약 예시 |

## X. UXUI → 엔진 역방향 로그

| # | 상태 | UXUI에서 확인·요청한 엔진 소유 항목 | 엔진 액션 | 근거 |
|---|---|---|---|---|
| X-1 | `done` | `scripts/macos_dev_run.sh` SwiftPM 바이너리 프레임워크·리소스 번들 스테이징(LiveKit DYLD 종료 수정) | main 반영 완료 | UXUI 발견, 양 트랙 빌드 검증 (2026-07-18) |
| X-2 | `done`(서버 절반 main 랜딩 — MOMO-478) | 반응/수정/삭제 REST+realtime 계약. UI는 capability gate로 기완비 | UI 개방은 **A-9**로 이관 | MessageInteractionModel.swift, MessageInteractionTests (2026-07-18) |
| X-3 | `done`(MOMO-479 `#508` → track/engine, main 대기) | A-4 잔여였던 정확한 롤업·과거 답글 조회·AgentWorker thread 문맥 보존 | 톱레벨 `thread` 투영, ASC cursor replies REST, `thread.updated` realtime, Worker INSERT 4곳 root_id·롤업 보존 완료. main 랜딩 시 **A-4 ready 전환**(UI: 배지 실데이터·과거 답글 로드·thread.updated 소비) | MessageRoutes.swift, Core ThreadRollup.swift, verify_thread_projection.sh (2026-07-19) |
| X-4 | `needs-engine-contract` | A-6 잔여: Core `DraftMessage`와 메시지 history/realtime 응답에 `attachmentIds`·첨부 메타데이터 투영이 없어 수신자가 다운로드 대상을 발견할 수 없음 | `DraftMessage` 가산 필드와 Message history/realtime의 attachment projection 또는 message별 attachment 조회 API를 추가. 업로드 URL은 bearer capability이므로 로그·영속 저장 금지 계약 유지 | `AttachmentRoutes.swift`, `MessageRoutes.swift`, `clients/Core/Message.swift`, `verify_attachment_upload.sh` (2026-07-18) |
| X-5 | `needs-engine-contract` | A-9 잔여: 수정/삭제/반응 이벤트가 원본 메시지 `seq`를 envelope seq·Centrifugo version으로 재사용해 relay stale-skip 및 Core replay drop 대상이 됨. history도 deleted 행을 제외하고 `state/editedAtMs/deletedAtMs`를 투영하지 않아 재진입 시 편집 표시·tombstone이 사라짐 | 메시지 순서 SoT는 유지하되 상호작용 전달용 단조 cursor/version 또는 비-seq mutation 경로를 정의하고 relay/Core를 함께 갱신. history에 수정 상태/시각과 명시적 tombstone 복원 계약을 추가하고 실제 relay/WebSocket 2클라이언트 verifier로 검증 | `MessageRoutes.swift`, `RealtimeSubscriptionDriver.swift`, `OutboxRelay`, `verify_message_interaction.sh`, `docs/planning/JOURNAL.md` stale-skip 기록 (2026-07-19) |

## B. 엔진 역요청 — 전량 완료 (main)

B-1 첨부 업로드(MOMO-474) · B-2 검색 FTS(MOMO-475) · B-3 스레드 개방(MOMO-476) · B-4 알림 음소거(ADR-0124, MOMO-477) — 2026-07-18 종결.

## C. 검증 부채

| # | 항목 | 상태 |
|---|---|---|
| C-1 | 허들 2-클라 실오디오 왕복 | 성재 마이크 필요 — A-5와 함께 |
| C-2 | Work 실 Codex↔momo 왕복 | 엔진 트랙 후보(성재 Codex 환경 잠깐 필요) |
| C-3 | iOS deep link 실기기 재확인 | 케이블 Run 1회 |

## 완료 이력 (main 랜딩)

- 2026-07-18 밤: UXUI 실서버 연동 배치(A-1/2/3/5/7 + A-4 답글 전송) · 엔진 음소거(MOMO-477)·상호작용 서버(MOMO-478)·X-1 스테이징
- 2026-07-18: B-1 첨부(MOMO-474) · B-2 검색 FTS(MOMO-475) · B-3 스레드 개방(MOMO-476) · 허들 V-1~V-3b(MOMO-468~473)
- 2026-07-17: 플러그인 SE-04A~D(MOMO-410~458) · 웹훅(MOMO-412) · 단축링크(MOMO-460) · iOS v0(MOMO-462~467)
