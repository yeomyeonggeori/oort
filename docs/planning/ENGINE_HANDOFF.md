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
| A-4 | `done` | **스레드 실전송 완성** | X-3 main 랜딩으로 개방: `Message.thread` 롤업으로 배지 실데이터화, `GET .../messages/:root/replies` cursor로 과거 답글 로드, `thread.updated` 소비(ChatViewModel 기연결)로 열린 패널/배지 갱신. 로드 범위 기반 임시 카운트 제거 | Core `Message.thread`/`ThreadRollupDelta`, replies REST, `verify_thread_projection.sh`가 계약 예시 |
| A-5 | `done` | **허들 UI 폴리시** | 비활성 사유를 포인터·키보드에서 동일하게 설명하고 참가 전/참가 중 상태의 아이콘·레이블·동작을 분리 | MomoHuddle*.swift |
| A-6 | `done` | **파일 첨부 실업로드 완성** | 컴포저의 파일 선택을 세션 발급→capability URL 직송 PUT→complete→`attachmentIds` 전송에 연결하고, `Message.attachments` 카드·다운로드/열기·실패 재시도와 파일 검색을 완성. capability URL은 backend 호출 안에서만 소비하고 로그·UI·영속 상태에 노출하지 않음 | AttachmentRoutes.swift, Core `MessageAttachment.swift`, `verify_attachment_upload.sh` 계약 + macOS REST/스냅샷 테스트 (2026-07-19) |
| A-7 | `done` | **검색 서버 승격** | 기존 destination 심을 유지하면서 서버 FTS, 300ms debounce, 최신순 cursor pagination, 오류/빈 상태와 정확한 과거 메시지 이동을 연결 | `GET /v1/workspaces/:ws/search/messages?q=&cursor=` — 멤버십 필터 서버 강제·snippet+matchOffset 제공, SearchRoutes.swift |
| A-8 | `done` | **채널 음소거 설정 UI** | 채널 목록 `muted` 투영·음소거 아이콘·컨텍스트/설정 토글·낙관 갱신/롤백을 연결. 멘션 포함 전면 억제·unread 무영향(ADR-0124)을 UI에 명시 | ChannelRoutes/DTOs, verify_notification_mute.sh가 계약 예시 |
| A-11 | `done`(track/uxui, 성재 승인 전) | **로컬 Mac을 work_host로 자기등록 (MOMO-492)** | workspace/member별 로컬 Ed25519 신원을 0600으로 보관하고 활성 app host 재사용·revoke 시 재등록·서명 heartbeat를 연결했다. 서버가 반환한 host_id만 Work Console 라우팅 ID로 사용하며, 등록 실패 시 세션 시작/원격 control을 fail-closed한다. 설정에 상태·복사 가능한 host ID·AgentWorker `MOMO_WORK_HOST_ID` 조율 안내를 노출한다. private key·cwd·자격증명은 서버 요청/로그/UI에 넣지 않는다. 실제 서버 control 한 사이클은 수동 QA 전까지 runtime-unverified | ADR-0114/0125, WorkHostRoutes, macOS focused/전체 tests + 디자인 review(Blocker 0) + `macos-ui` gate |
| A-10 | `done`(main 랜딩 2026-07-20) | **Work 서랍 — SwiftTerm 터미널 + 세션 스레드 브리지 (MOMO-485)** | SwiftTerm(MIT) 임베드 + Control+backtick Work 서랍, 4종 로컬 프로파일, 세션 REST/카드·realtime 투영, 기존 approval 카드 재사용, auto-approve 변경 UI, 명시 발췌/스레드 브리지, `work.control.dispatched` 로컬 실행과 ack를 연결했다. PTY raw·실제 cwd·환경 자격증명은 서버 요청/로그/영속 상태에 넣지 않으며 `work.read`도 사용자 검토·편집 전에는 전송하지 않는다. Xcode 배포 빌드의 App Sandbox는 보안 경계 변경 없이 유지해 로컬 CLI를 fail-closed하고, SwiftPM 개발 빌드에서만 PTY를 허용한다. | ADR-0114(D1~D8), WorkSessionRoutes/WorkControlRoutes, macOS 420 tests + unsigned Xcode build + `macos-ui` gate. 실 Codex 왕복은 C-2, auto-approve 초기 snapshot은 X-6 |
| A-9 | `done`(X-5 main 랜딩으로 완성 — 2기기 수동 QA는 C-4) | **반응/수정/삭제 UI 개방** | REST/로컬 UI(A-9 배치) + 엔진 X-5(브로커·Core replay·history 복원)로 교차 클라 realtime·재시작 복원까지 보장. UXUI 추가 작업 불요 — tombstone이 이제 history에 내려오므로 목록 렌더만 재확인 권장 | PATCH·DELETE /v1/workspaces/:ws/messages/:id, PUT·DELETE .../reactions/:emoji, GET .../channels/:ch/reactions — openapi 명세·verify_message_interaction.sh 계약 예시 |

## X. UXUI → 엔진 역방향 로그

| # | 상태 | UXUI에서 확인·요청한 엔진 소유 항목 | 엔진 액션 | 근거 |
|---|---|---|---|---|
| X-1 | `done` | `scripts/macos_dev_run.sh` SwiftPM 바이너리 프레임워크·리소스 번들 스테이징(LiveKit DYLD 종료 수정) | main 반영 완료 | UXUI 발견, 양 트랙 빌드 검증 (2026-07-18) |
| X-2 | `done`(서버 절반 main 랜딩 — MOMO-478) | 반응/수정/삭제 REST+realtime 계약. UI는 capability gate로 기완비 | UI 개방은 **A-9**로 이관 | MessageInteractionModel.swift, MessageInteractionTests (2026-07-18) |
| X-3 | `done`(MOMO-479 `#508`, main 랜딩) | A-4 잔여였던 정확한 롤업·과거 답글 조회·AgentWorker thread 문맥 보존 | 톱레벨 `thread` 투영, ASC cursor replies REST, `thread.updated` realtime, Worker INSERT 4곳 root_id·롤업 보존 완료. main 랜딩 시 **A-4 ready 전환**(UI: 배지 실데이터·과거 답글 로드·thread.updated 소비) | MessageRoutes.swift, Core ThreadRollup.swift, verify_thread_projection.sh (2026-07-19) |
| X-4 | `done`(MOMO-482 `#515`, main 랜딩) | A-6 잔여: 첨부 수신 투영 부재 | history/전송/replies/`message.new`에 complete 첨부 `{id,name,mime,sizeBytes}` 투영 + Core `Message.attachments`·`DraftMessage.attachmentIds` 가산. 다운로드는 기존 content proxy, 업로드 URL 비노출 유지. **A-6 ready 전환 완료**(UI: 컴포저 실업로드 연결 + 수신 첨부 카드/다운로드) | `verify_attachment_upload.sh`(투영 단정 포함), Core `MessageAttachment.swift` (2026-07-19) |
| X-5 | `done`(MOMO-480 `#511`+MOMO-481 `#513`, main 랜딩) | A-9 잔여: 상호작용 이벤트 브로커/Core 드랍 + history 복원 부재 | ①브로커: 투영 이벤트 no-version 발행(Centrifugo version 게이팅 실측 해소) ②Core replay: 4종 type 분기로 커서 불전진 전달 ③history: tombstone 포함+`state/editedAtMs/deletedAtMs` 투영. main 랜딩 시 **A-9 done 전환 가능**(교차 클라 realtime·재시작 복원 보장). 실 2클라 ws E2E는 C-4 검증 부채 | verify_message_interaction.sh(회귀 가드+재시작 수렴), RealtimeSubscriptionDriver.swift (2026-07-19) |
| X-6 | `ready` | A-10 auto-approve 현재값 조회 계약 부재 | owner가 워크스페이스의 tool별 auto-approve 현재값을 앱 시작 시 복원할 수 있는 GET/snapshot 계약 추가. 응답은 tool+enabled만 포함하고 호스트·경로·자격증명은 포함하지 않음. 현재 UXUI는 거짓 기본값을 표시하지 않고 `unknown`에서 사용자의 PUT/DELETE 성공 후에만 상태를 확정한다. | WorkControlRoutes는 현재 PUT/DELETE만 제공, `work_auto_approve` 원장은 이미 존재 (2026-07-20) |

## B. 엔진 역요청 — 전량 완료 (main)

B-1 첨부 업로드(MOMO-474) · B-2 검색 FTS(MOMO-475) · B-3 스레드 개방(MOMO-476) · B-4 알림 음소거(ADR-0124, MOMO-477) — 2026-07-18 종결.

## C. 검증 부채

| # | 항목 | 상태 |
|---|---|---|
| C-1 | 허들 2-클라 실오디오 왕복 | 성재 마이크 필요 — A-5와 함께 |
| C-2 | Work 실 Codex↔momo 왕복 | UXUI 자동 계약 검수 완료. 실제 서버·Codex CLI·승인 카드·로컬 PTY·스레드 발췌의 한 사이클은 성재 환경 수동 검수 전까지 `runtime-unverified` |
| C-3 | iOS deep link 실기기 재확인 | 케이블 Run 1회 |
| C-4 | 상호작용 실 WebSocket 2-클라이언트 E2E | X-5는 history API 실수신+Core 회귀 테스트로 검증됨 — 실 ws 구독 2클라 왕복은 미실증(맥+아이폰 수동 QA로도 대체 가능) |

## 완료 이력 (main 랜딩)

- 2026-07-18 밤: UXUI 실서버 연동 배치(A-1/2/3/5/7 + A-4 답글 전송) · 엔진 음소거(MOMO-477)·상호작용 서버(MOMO-478)·X-1 스테이징
- 2026-07-18: B-1 첨부(MOMO-474) · B-2 검색 FTS(MOMO-475) · B-3 스레드 개방(MOMO-476) · 허들 V-1~V-3b(MOMO-468~473)
- 2026-07-17: 플러그인 SE-04A~D(MOMO-410~458) · 웹훅(MOMO-412) · 단축링크(MOMO-460) · iOS v0(MOMO-462~467)
