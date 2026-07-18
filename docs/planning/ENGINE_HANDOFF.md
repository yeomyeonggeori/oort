# 엔진 ↔ UXUI 갭 감사 + 핸드오프 큐

> 규칙: `docs/TRACKS.md` §4. 상태: `ready`(대기) → `proposed`(성재 제안됨) → `in-progress` → `done`.
> UXUI 세션은 세션 시작 시 §A를 읽고 ready를 성재에게 "이거 구현할까요?"로 제안하고, 집으면 상태를 갱신한다.
> 2026-07-18 갱신: **§A 전 항목의 엔진 표면이 main(`7edad20`)에 랜딩 완료 — 즉시 착수 가능.**

## A. 엔진 완료(main) → UI 작업 대기 — UXUI 트랙 소비 대상

| # | 상태 | 항목 | UI가 할 일 | 착수 포인터 (전부 main) |
|---|---|---|---|---|
| A-1 | `ready` | **마켓플레이스 실서버 연동** | 로컬 카탈로그(`MomoPluginCatalogItem`)를 REST로 교체: 카탈로그 조회(`recommended` 필드=추천 섹션), 설치/해제, grant 발급/회수, 설치·grant 상태 표시 | `GET/POST/DELETE /v1/workspaces/:ws/plugins...` — PluginRoutes.swift, openapi 명세 완비 |
| A-2 | `ready` | **채널 웹훅 발급 UI** | placeholder 탭(`MomoAccountSettingsViews.swift:1451`) 실물화: 발급(**one-time secret 1회 표시** — 재조회 불가 UX 필수)·회전·revoke·수신 URL 복사 | WebhookRoutes.swift, openapi |
| A-3 | `ready` | **초대 단축 링크 노출** | 초대 발급 화면에 `/i/<code>` 복사 버튼(베이스 URL은 env/설정) | services/LinkShort/README.md |
| A-4 | `ready` | **스레드 실전송** | 컴포저 "스레드 초안(로컬)"을 실전송으로: 전송 시 `rootId` 포함(**1단계 스레드만** — 대댓글 불가 계약), 타임라인 답글 표시(`rootId` 필드 수신), thread 롤업(reply_count/last_reply) 배지 | `SendMessageRequest.rootId` + thread 롤업 — MessageRoutes.swift, `verify_thread_reply.sh`가 계약 예시 |
| A-6 | `ready` | **파일 첨부 실업로드** | 컴포저 "파일 첨부(로컬 초안)"를 실물로: ①세션 발급 REST ②**클라가 Google에 직접 청크 PUT**(서버 비경유) ③complete ④전송 시 `attachmentIds` ⑤수신 측 content 프록시 다운로드 | AttachmentRoutes.swift, openapi, `verify_attachment_upload.sh`가 흐름 예시 |
| A-7 | `ready` | **검색 서버 승격** | `MomoWorkspaceSearchIndex`의 메시지 소스를 서버 FTS로 교체(기존 심 `MomoWorkspaceSearchDestination` 유지 — handoff 2026-07-17 설계대로). "현재 불러온 대화에서 검색" 카피를 실검색으로 승격 | `GET /v1/workspaces/:ws/search/messages?q=&cursor=` — 멤버십 필터 서버 강제·snippet+matchOffset 제공, SearchRoutes.swift |
| A-5 | `ready` | **허들 UI 폴리시** | design High 2건(disabled 사유 키보드 접근성, 참가 상태별 시각 증거) + 실창 QA | MomoHuddle*.swift |

## B. 엔진 역요청 (남은 것)

| # | 상태 | 항목 | 비고 |
|---|---|---|---|
| B-4 | `ready` | 알림 음소거/설정 계약 | 소형 ADR 선행(판정=notifier 한 곳, P9) — 엔진 트랙 다음 후보 |

## C. 검증 부채

| # | 항목 | 상태 |
|---|---|---|
| C-1 | 허들 2-클라 실오디오 왕복 | 성재 마이크 필요 — A-5와 함께 |
| C-2 | Work 실 Codex↔momo 왕복 | 엔진 트랙 다음 후보(성재 Codex 환경 잠깐 필요) |
| C-3 | iOS deep link 실기기 재확인 | 케이블 Run 1회 |

## 완료 이력 (main 랜딩)

- 2026-07-18: B-1 첨부 업로드(MOMO-474) · B-2 검색 FTS(MOMO-475) · B-3 스레드 개방(MOMO-476) · 허들 V-1~V-3b(MOMO-468~473)
- 2026-07-17: 플러그인 SE-04A~D(MOMO-410~458) · 웹훅(MOMO-412) · 단축링크(MOMO-460) · iOS v0(MOMO-462~467)
