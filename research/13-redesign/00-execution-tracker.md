# 재설계 2026-07 — 실행 팔로업 보드

> **역할:** "지금 무얼 해야 하고, 무얼 했는지"를 한 화면에서 보는 보드. **티켓 정본은 `docs/BACKLOG.md` §4 재설계 섹션**, 마일스톤 정본은 `ROADMAP.md` §1.3 — 이 보드는 상태 뷰이며 충돌 시 정본이 우선.
> **갱신 규칙:** 재설계 티켓(MOMO-300~323)을 닫을 때 STATUS.md와 함께 이 표의 상태를 갱신한다(AGENTS.md DoD 5 참조). 상태 값: `ready`(착수 가능) / `blocked(<deps>)` / `in-progress` / `review` / `done` / `handoff` / `dropped`.
> 최종 갱신: **2026-07-07** — Opus 세션에서 **316·323·301·300·302·318 머지 완료**(main HEAD `88234d2`). 이후 실행 주체는 **Codex/GPT로 인수**(핸드오프 브리프 `docs/HANDOFF_2026-07.md`, 실행 주체 전환은 AGENTS.md 참조).
>
> **Codex 진입점(다음 착수):** 로컬 1인 테스트 승격 레인은 `docs/LOCAL_SOLO_ALPHA_ROADMAP.md`가 조정한다. 즉시 unblock은 **LSA-001**(MOMO-300/301/302 이후 local-alpha env/login/docs 재정렬)이고, 그다음은 **MOMO-319**(게이트/verifier 하드닝) 또는 **MOMO-303(MomoDS v0)**다. 일반 picker로는 MOMO-303 우선(Phase 1 마지막 P0, macOS UI 모든 후속 선행), 병렬 가능: **308(MCP)·309(BYOK)**(deps done). 그리고 **317**(아래, build-infra 브랜치 대기)과 **319**(게이트/verifier 하드닝). UI 티켓(303~306)은 `momo-design-taste` skill 준수 + design-review 리포트(Blocker 0) evidence 필수.

## 완료된 것 (기획/도구, 2026-07-06)

| 산출물 | 상태 |
|---|---|
| 코드베이스 진단 + 재설계 방향 정본 (`01-agent-native-redesign-2026-07.md`) | ✅ done |
| 게이트 최적화 감사/플랜 (`02-gate-optimization.md`) | ✅ done |
| GWS 파일/RAG 아키텍처 (`03-google-workspace-files-rag.md`) | ✅ done |
| `momo-design-taste` skill 설치 (`.claude/skills/momo-design-taste/`) | ✅ done |
| `design-review` 에이전트 설치 (`.claude/agents/design-review.md`) | ✅ done |
| BACKLOG 티켓화(MOMO-300~323) + ROADMAP §1.3 overlay | ✅ done |

## Phase 0 — 게이트/도구 정비 (M1)

| 티켓 | 내용 | 우선순위 | 상태 |
|---|---|---|---|
| MOMO-316 | local gate `--auto` 프로파일 + compose `--wait` + 멱등 1-run | P0 | `done` (2026-07-06 구현+3-lens 리뷰 반영+머지, STATUS §0ay) |
| MOMO-318 | 디자인 pre-flight grep → swift 프로파일 + snapshot testing | P1 | `done` (2026-07-07 merged-main swift 게이트 PASS: ratchet baseline 81/1/0/0 + 60 tests + light/dark 스냅샷, STATUS 0b3) |
| MOMO-317 | BuildKit cache mount + worktree 공유 빌드 캐시 | P1 | **`handoff`** — 구현 완료(브랜치 `feat/MOMO-317-buildkit-cache` @ e31d30e, 6e01142 기반), 재작성 Dockerfile 단일이미지(OutboxRelay) 빌드+바이너리 실행 검증됨. **Codex 잔여:** main 머지(Makefile/swift-service.Dockerfile/verify_internal_host_runtime.sh에서 316/300과 build-infra 충돌 해소) → `--profile host-runtime` 게이트(5이미지, 이 세션 머신은 메모리 압박으로 미실행) → 머지 |
| MOMO-319 | 게이트/verifier 하드닝 (verifier-owned leaked-process 정리 + stale runtime fixture cleanup; runtime-db 병렬화/웜 볼륨은 후속 최적화) | P2 | `done` (2026-07-07 local solo alpha slice, STATUS 0b6) |
| MOMO-320 | Local runtime env drift guard (`.env.worktree` stale secret/key omission → Centrifugo publish 401 방지) | P2 | `done` (2026-07-07 merge, security review fixes + latest-history bridge check, STATUS 0b7) |
| MOMO-324 | AgentWorker verifier cleanup FK rerun hardening | P2 | `in-progress` (main runtime-agent gate after MOMO-320 merge exposed legacy trigger FK cleanup order; issue #276) |

> **MOMO-319에서 닫은 게이트 하드닝:** ① verifier 선두/말미에 repo-local verifier/mock/server만 대상으로 하는 port/process-tree cleanup guard를 추가했다. raw command line은 evidence에 남기지 않는다. ② `runtime-agent` full sequence에서 AgentWorker/context/live/local-Hermes verifier가 `.conductor` 10-port block 안의 worktree-safe port 대역(`base+4..6`)을 쓰고 종료 시 tracked child process를 회수한다. ③ 공유 DB volume cleanup은 deterministic verifier fixture/client_msg_id/run id 범위로 축소해 local dogfood의 실제 Hermes agent job을 중립화하지 않는다. 실측 `runtime-agent` full gate PASS. 남은 runtime-db 병렬화/웜 볼륨 최적화는 별도 performance slice로 미룬다.

## Phase 1 — P0 코어 (M1/M3)

| 티켓 | 내용 | 상태 |
|---|---|---|
| MOMO-300 | subscribe proxy 인증 + token revocation + rate limit | `done` (2026-07-07 리뷰+게이트 전프로파일 PASS, STATUS 0b2) |
| MOMO-301 | agent_run depth/round 스키마 + 루프가드 G1~G4 실쿼리 | `done` (2026-07-06 머지, STATUS 0b0) |
| MOMO-302 | 컨텍스트 조립 v1 (단일 메시지 → 히스토리/토큰 윈도) | `done` (2026-07-07 리뷰+게이트, 개별 verifier 전부 PASS, STATUS 0b1) |
| MOMO-303 | MomoDS v0: 토큰 4층 + ugly mode + 컴포넌트 7종 추출 | `ready` |
| MOMO-304 | 마크다운/코드블록 + 편집/삭제 UX + @멘션 자동완성 | `blocked(303 토큰 슬라이스)` |

> 300/301/302/303은 표면이 겹치지 않아 **worktree 4개 병렬 가능** (server / worker+schema / worker / macOS).

## Phase 2 — P1 확장 (M2/M3)

| 티켓 | 내용 | 상태 |
|---|---|---|
| MOMO-305 | 스레드 UI(에이전트 세션 경계) + unread + 로컬 알림 | `blocked(303,304)` |
| MOMO-306 | 검색 라우트 + Cmd+K 팔레트 + 리액션 | `blocked(303)` |
| MOMO-307 | Context Broker 실조립 (Context Packet v0) | `blocked(302,120)` |
| MOMO-308 | Inbound MCP JSON-RPC 실구현 + scope 발급 | `blocked(172=done)` → `ready` |
| MOMO-309 | BYOK provider_config + 봉투 암호화 + Settings UI | `blocked(227=done)` → `ready` |
| MOMO-310 | pgvector RAG + RRF 하이브리드 + Memory Plane v0 구현 | `blocked(302,121)` |
| MOMO-320 | AttachmentStore + Drive workspace archive + resumable 업로드 | `blocked(323)` |
| MOMO-321 | Drive changes.list 폴러 + 추출/청크 인덱싱 | `blocked(320,310)` |
| MOMO-323 | GWS 스펙 정정 3건 + Internal consent 런북 (문서만) | `done` (2026-07-06 머지, STATUS §0az) |

## Phase 3 — P2 마감 (M3+)

| 티켓 | 내용 | 상태 |
|---|---|---|
| MOMO-311 | FoundationModels 컨텍스트 압축 + 스레드 제목/트리아지 | `blocked(131,305)` |
| MOMO-312 | 음성 입력 SpeechTranscriber ko_KR push-to-talk | `blocked(303)` |
| MOMO-313 | A2A Agent Card + agents/announce 초대 | `blocked(308)` |
| MOMO-314 | reversibility_tier + 승인 라이프사이클 렌더 + 정책 2축 | `blocked(160=done,303)` |
| MOMO-315 | audit redaction + 보존 TTL + 계정 삭제 | `blocked(300)` |
| MOMO-322 | 김인턴 위키 v0 (propose-write 승인 + 인용 강제) | `blocked(321)` |

## 착수 전 실증 항목 (runtime-unverified 예약)

- [ ] SA + `drive.file` scope + 공유 드라이브 멤버십으로 changes.list/다운로드 충분성 (부족 시 SA만 `drive.readonly`, MOMO-123 inventory 기록) — MOMO-320 착수 시
- [ ] Drive API `fullText contains` 한국어 실측 — MOMO-321 안에서
- [ ] SpeechTranscriber 한국어 WER 자체 평가 — MOMO-312 안에서 `[manual]`
- [ ] macOS 26 실기기 FoundationModels/SpeechTranscriber 확인 — MOMO-311/312 `[manual]`

## 사람(owner)만 할 수 있는 것

- MomoDS 시각 최종 승인(design-review 리포트의 High 이하 판정) — MOMO-303~306 각 PR
- GCP 프로젝트/Internal consent/SA 생성 `[manual]` — MOMO-323 런북 이후 1회
- 한국어 WER 평가용 음성 샘플 제공 — MOMO-312
- credentialed provider smoke (기존 runtime-unverified 항목 유지)
