# 엔진 ↔ UXUI 갭 감사 + 핸드오프 큐

> 규칙: `docs/TRACKS.md` §4. 상태: `ready`(대기) → `proposed`(성재 제안됨) → `in-progress` → `done`.
> UXUI 세션은 세션 시작 시 §A를 읽고 ready를 성재에게 "이거 구현할까요?"로 제안하고, 집으면 상태를 갱신한다.
> 2026-07-18 밤 통합판: UXUI 실서버 연동 배치(A-1/2/3/5/7 + A-4 답글 전송)와 엔진 배치(음소거 MOMO-477·상호작용 MOMO-478·X-1)가 main에 랜딩.

> **2026-07-21 순차 배치 정본**: UXUI 잔여 전량(A-13·A-14 포함 9항목)의 실행 순서·수용기준·함정은 `docs/planning/handoffs/2026-07-21-uxui-sequential-batch.md`가 정본이다 — UXUI 세션은 그 문서 순서대로 처리한다(성재 지시).
> **2026-07-21 패브릭 배치 가산(PLN-20260721-01 인수)**: 순차 배치의 ⑧(MOMO-518 diff 카드)은 패브릭 Wave U의 첫 장을 겸한다(수용기준은 패브릭 패킷 §2가 우선 — research/19-05 반영 필수). 순차 배치 완료 후 **⑩ MOMO-529**(메모리 브라우저 — 엔진 527·528 랜딩 대기), **⑪ MOMO-532**(도구 관리+ACP 카드 — 엔진 533·531 랜딩 대기)를 잇는다. 정본: `docs/planning/handoffs/2026-07-21-agent-native-fabric-batch.md`.

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
| A-12 | `done`(MOMO-511-U #555 + #567, main 계약 소비 2026-07-21) | **원격 Work 터미널 direct attach (MOMO-511 UXUI 절반)** | exact grant 메모리 소비, capability header, SwiftTerm direct stdout/stdin/resize/kill, 오류별 인라인 재시도, ended read-only, 카드→서랍 진입, 소켓 정리를 구현했다. X-8의 credential-free `remoteAttachAvailable` projection을 소비해 owner의 running 결속 세션에만 실데이터 액션을 열고, false·필드 누락은 계속 fail-closed한다. | ADR-0125 D10, `MomoRemoteTerminalSession.swift`, `MomoWorkConsoleDrawer.swift`, macOS focused tests |
| A-13 | `done`(MOMO-504 #583, track/uxui) | **iOS 알림 UX v2 소비 (MOMO-504)** | APNs `thread-id`와 `momo.message|mention|approval|work` category를 등록하고 빠른 답장·승인/거부·정확한 채널/스레드/Work 딥링크를 연결했다. `momo.push.notification.v2`의 승인 전용 `approval_id`와 서버 badge를 소비하며 NSE fetch 기반 id-only 본문 경계를 유지한다. 잠금화면 액션 등록 설정과 서버 채널 음소거를 구분해 노출한다. | MOMO-503 `PushDispatch.swift`, `docs/PUSH_RELAY_RUNBOOK.md`, `verify_push_notifier.sh` (Goal #550, main 랜딩 2026-07-21) |
| A-14 | `ready` | **호스트 상실 전환 제안 소비 (MOMO-520)** | `work.session.orphaned`와 같은 스레드의 `approval_request(props.kind=resume_offer)`를 Work 카드로 표시하고, 사용자가 대상 host를 골라 resume REST를 호출한 뒤 `resumedFromSessionId` 계보를 같은 서랍/스레드에서 이어 보여준다. t1_only/auto는 불필요한 제안 카드를 만들지 않는다. | MOMO-519 `WorkTierPolicyRoutes.swift`, `POST .../work-sessions/:id/resume`, OpenAPI, `verify_tier_fallback.sh` |
| A-15 | `ready` | **멤버 lifecycle·audit 표면 소비 (MOMO-525)** | 채널/workspace 나가기, agent suspend/remove 후 credential 재발급 안내, owner/admin audit 목록의 action/대상/시간 필터와 cursor pagination을 연결한다. 마지막 owner 409와 DM leave 403은 인라인 사유로 표시한다. | MOMO-524 `MemberLifecycleRoutes.swift`, `AuditRoutes.swift`, OpenAPI, `verify_lifecycle_completion.sh` |
| A-16 | `ready`(526·527·528 main 랜딩 완료) | **불변 Context Packet 서빙 인스펙터 (MOMO-529)** | run/응답 카드에서 저장 packet의 히스토리·memory refs·tool grants·budget·redactions를 읽기 전용 상세로 표시하고 expired 상태를 구분한다. 클라에서 현재 정책으로 재조립하지 않는다. 전체 스코프는 BUILD_TICKETS MOMO-529(메모리 브라우저·출처 역링크·grant 목록/회수 포함)가 정본. | `GET /v1/workspaces/:ws/context-packets/:packet`, `docs/specs/04-context-packet-v0.md`, OpenAPI |
| A-17 | `ready`(MOMO-546 서버 relay 포함) | **ACP 세션 카드·도구 프로파일 소비 (MOMO-532)** | workd ACP progress/plan/승인/terminal lifecycle가 이제 세션 root 아래 `props.kind=work_session_event` message로 복원되고 같은 tx의 `agent.partial`/`agent.status`/`approval.*` outbox로 실시간 도착한다. 저장 message를 카드 복원 SoT로, envelope를 live 갱신으로 소비한다. 승인 카드 결정은 `resolvePermission`으로 왕복하며 앱 launch spec 하드코딩을 MOMO-533 profile 투영으로 교체한다. | `WorkSessionRoutes.recordACPEvent`, `momo.work_session.acp_event.v1`, `MomoACPHost`, MOMO-533 work-tool-profiles, `verify_acp_host.sh` |
| A-18 | `ready` | **에이전트 작업신호 3종 (buzz Wave U″-1)** | 사이드바 working 배지+경과시간, 컴포저 활동 헤드라인, 턴 liveness. 서버 이벤트 계약 필요 — ADR-0104(presence/typing/streaming) draft를 UXUI 세션이 제안. buzz agentWorkingSignal 단일 모듈 패턴. | 2026-07-22-buzz-actions-plan.md Wave U″ |
| A-19 | `ready` | **managed-by 표기+수신 게이트 (buzz Wave U″-2)** | 에이전트 카드/인스펙터에 관리 주체 표기, who-can-talk owner-only 기본. ADR-0131 profile 소비 후속. | agent_profile(036), buzz 계획 Wave U″ |
| A-20 | `ready` | **빈 채널 인트로 'Create agent'='Add people' 동급 (buzz Wave U″-3, 소형)** | 빈 채널 온보딩에 에이전트 생성 진입 동급 배치. | 537 생성 API |
| A-18 | `ready`(MOMO-535 track/engine 리뷰 대기) | **outbound 이벤트 구독 관리 UI** | 관리자 설정에서 URL·이벤트 종류(멘션/승인요청/Work 상태)·활성 상태·누적 실패/자동 비활성 사유를 CRUD에 연결한다. 생성 응답의 one-time signing secret은 확인 전 이탈을 잠그고 확인 즉시 메모리에서 폐기하며 목록/수정 화면에서 재노출을 기대하지 않는다. | `/v1/workspaces/:ws/event-subscriptions`, OpenAPI, `verify_event_subscription.sh` |
| A-19 | `done`(MOMO-550 #638, track/uxui PR 대기) | **에이전트 주소 온보딩 UI** | 관리자용 주소 입력→공개 능력·인증 요약 동의→confirm을 멤버 디렉터리·설정에 연결하고, 명부 `origin=card|local`을 제품 뱃지로 투영했다. 카드 제공 인증정보는 표시 요약만 소비하며 입력·영속 상태에 두지 않는다. | MOMO-536 `/agents/from-card`·confirm·roster origin, macOS focused tests + 한국어 light/dark snapshot |
| A-17 | `in-progress`(MOMO-532 #604) | **ACP 세션 카드·도구 프로파일 소비 (MOMO-532)** | 로컬 `MomoLocalACPSession` plan/진행/4방향 승인과 결정 후 불변 카드를 연결하고, 앱 launch spec을 동적 MOMO-533 profile 투영으로 교체했다. 관리자 CRUD는 human bearer, 일반 실행 목록은 등록 Work Host 서명 enabled projection을 소비해 미등재/disabled를 fail-closed한다. 원격 workd 이벤트는 X-11 선행 대기. | `MomoACPSessionCard.swift`, `MomoWorkConsoleDrawer.swift`, MOMO-533 work-tool-profiles, `verify_acp_host.sh` |
| A-19 | `ready`(MOMO-537 track/engine 리뷰 대기) | **momo 네이티브 에이전트 생성·프로필 폼** | 기존 agent 생성 화면에 이름·핸들·avatar 후속 표면과 instructions(8KB)·model preference·enabled tool 체크·mention 고정/schedule 예약을 한 장으로 연결한다. 생성 뒤 profile GET/PUT version을 사용하고, tool은 서버 grant와 교집합임을 설명하며 credential/provider secret 입력은 만들지 않는다. | ADR-0131, `POST .../agents` optional profile, `GET/PUT .../agents/:agent/profile`, OpenAPI, `verify_agent_profile.sh` |
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
| X-6 | `done`(MOMO-493 #529 → track/engine, main 대기) | A-10 auto-approve 현재값 조회 계약 부재 | owner가 워크스페이스의 tool별 auto-approve 현재값을 앱 시작 시 복원할 수 있는 GET/snapshot 계약 추가. 응답은 tool+enabled만 포함하고 호스트·경로·자격증명은 포함하지 않음. 현재 UXUI는 거짓 기본값을 표시하지 않고 `unknown`에서 사용자의 PUT/DELETE 성공 후에만 상태를 확정한다. | WorkControlRoutes는 현재 PUT/DELETE만 제공, `work_auto_approve` 원장은 이미 존재 (2026-07-20) |

| X-7 | `done`(MOMO-494 #542 → main 랜딩·runtime-verified) | fresh DB에서 앱의 "에이전트 초대"가 실패 — UXUI `inviteDogfoodAgent()`는 기존 `@hermes` 멤버 탐색만 하고 서버에 에이전트 생성 API가 없음(이번 실 Hermes E2E는 fixture 우회) | 관리자용 에이전트 생성 REST 랜딩(POST .../agents, pairing 후속 흐름 문서화). UXUI 호출 교체는 후속 | 2026-07-21 main c953322 랜딩, verify_agent_create docker PASS |
| X-8 | `done`(MOMO-516 #560 → main 랜딩 2026-07-21) | 511-U(맥 원격 attach)가 세션 목록에서 원격 PTY 결속 여부를 사전 판별 불가 | `remoteAttachAvailable` bool을 WorkSession read projection에 가산(관전 attach와 동일 PR). capability/endpoint 비투영 유지. UXUI는 실데이터 액션 노출 개방 가능 | MOMO-516 #560, verify_observer_attach docker PASS (2026-07-21) |
| X-9 | `done`(MOMO-513 #556 → track/engine, main 대기) | 라이브 수신 메시지에 멘션 하이라이트/답장 인용/승인 props 부재 — `send()` outbox 브로드캐스트 페이로드에 props 미탑재(REST/history는 정상) | message.new 페이로드에 최종 props(멘션 투영 포함) 탑재 + edited 보존 verifier 단정 + agent_worker REST↔outbox 일치 단정. docker verifier PASS(2026-07-21) | Fable 발견(543 육안 QA — 콜드/라이브 A/B 격리), MessageRoutes.swift:242 |
| X-10 | `ready` | iOS 카테고리별 푸시 전달 설정 계약 부재. 앱의 `UNNotificationCategory` 등록은 잠금화면 액션만 제어하며 백그라운드 remote notification 전달을 억제할 수 없다. | device/member 범위 category preference REST와 NotifierWorker 판정 필터를 추가하거나, 제품 계약을 채널 음소거 단위로 명시한다. 그 전까지 UXUI는 액션 토글과 실제 서버 채널 음소거를 구분하고 카테고리 전달 억제를 주장하지 않는다. | MOMO-504 #583, ADR-0120/0124, `DeviceRoutes.swift`·`NotifierService.swift` 감사 (2026-07-21) |
| X-11 | `in-progress`(MOMO-546 #623) | workd ACP plan/progress/permission 이벤트의 서버 thread/realtime 투영 부재 | 로컬 앱 ACP 카드는 host-local 이벤트로 완성했지만, 원격 workd 세션 카드는 raw 비유출 정규화 릴레이가 랜딩돼야 동일 투영을 소비할 수 있다. 랜딩 전 원격 ACP 카드 실왕복은 fail-closed·`runtime-unverified` 유지 | ADR-0125 D10·0130 D1, `MomoACPHost`, `verify_acp_host.sh` (2026-07-22) |
| X-11 | `ready` | A-16(MOMO-529) 전체 수용기준 중 ① `memory_visibility_grant` 목록/회수 REST가 없고 ② run/응답에서 저장 packet ID를 발견할 투영 또는 run별 packet 조회가 없으며 ③ 서버가 발행하는 `memory.updated`가 Core `RealtimeEnvelope`에서 unknown type으로 폐기되고 ④ source_ref에는 message/channel ID만 있으나 ID 단건 조회가 없어 현재 history·검색 cache 밖의 출처로 이동할 수 없다. 현재 공개 계약은 packet ID를 이미 아는 호출자의 단건 GET뿐이다. | 관리자/소유자용 visibility grant list+revoke REST와 OpenAPI, `agent_run`의 credential-free `contextPacketId` 또는 `GET .../agent-runs/:run/context-packets`, Core realtime `memory.updated`, membership을 재검증하는 message ID 단건 조회(또는 source_ref에 seq 투영)를 가산한다. 그 전까지 UXUI는 grant 회수를 거짓 개방하지 않고, packet ID가 기존 메시지 props에 있을 때만 저장 packet을 조회하며, REST mutation 성공 후 재조회하고 source jump 실패를 인라인으로 고지한다. | ADR-0129 D4~D6, BUILD_TICKETS MOMO-529 델타 3, `MemoryRoutes.swift`, `ContextPacketRoutes.swift`, `RealtimeEnvelope.swift` 감사 (2026-07-22) |

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
