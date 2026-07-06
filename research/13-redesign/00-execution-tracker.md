# 재설계 2026-07 — 실행 팔로업 보드

> **역할:** "지금 무얼 해야 하고, 무얼 했는지"를 한 화면에서 보는 보드. **티켓 정본은 `docs/BACKLOG.md` §4 재설계 섹션**, 마일스톤 정본은 `ROADMAP.md` §1.3 — 이 보드는 상태 뷰이며 충돌 시 정본이 우선.
> **갱신 규칙:** 재설계 티켓(MOMO-300~323)을 닫을 때 STATUS.md와 함께 이 표의 상태를 갱신한다(AGENTS.md DoD 5 참조). 상태 값: `ready`(착수 가능) / `blocked(<deps>)` / `in-progress` / `review` / `done` / `dropped`.
> 최종 갱신: 2026-07-06 (기획 정본화 시점 — 코드 티켓은 전부 미착수)

## 완료된 것 (기획/도구, 2026-07-06)

| 산출물 | 상태 |
|---|---|
| 코드베이스 진단 + 재설계 방향 정본 (`01-agent-native-redesign-2026-07.md`) | ✅ done |
| 게이트 최적화 감사/플랜 (`02-gate-optimization.md`) | ✅ done |
| GWS 파일/RAG 아키텍처 (`03-google-workspace-files-rag.md`) | ✅ done |
| `momo-design-taste` skill 설치 (`.claude/skills/momo-design-taste/`) | ✅ done |
| `design-review` 에이전트 설치 (`.claude/agents/design-review.md`) | ✅ done |
| BACKLOG 티켓화(MOMO-300~323) + ROADMAP §1.3 overlay | ✅ done |

## Phase 0 — 게이트/도구 정비 (M1) · **지금 여기**

| 티켓 | 내용 | 우선순위 | 상태 |
|---|---|---|---|
| MOMO-316 | local gate `--auto` 프로파일 + compose `--wait` + 멱등 1-run | P0 | `done` (2026-07-06 구현+3-lens 리뷰 반영+머지, STATUS §0ay) |
| MOMO-318 | 디자인 pre-flight grep → swift 프로파일 + snapshot testing | P1 | `ready` |
| MOMO-317 | BuildKit cache mount + worktree 공유 빌드 캐시 | P1 | `ready` (316 머지됨) |
| MOMO-319 | runtime-db verifier 병렬화 + 웜 볼륨 opt-in | P2 | `blocked(317)` |

> **후속 발견(316 검증 중, 새 티켓 후보):** verify_*.sh 계열이 host MomoServer를 누수시킬 수 있다 — `swift run` 부모만 trap kill 되고 자식 MomoServer 바이너리가 살아남아, 프로파일을 별도 호출로 연달아 돌리면 다음 verifier가 "already serving"으로 실패(`all` 프로파일은 내부 cleanup으로 방어). MOMO-319(Wave 3)에 process-group kill 또는 verifier 선행 port-guard로 흡수 권장.

## Phase 1 — P0 코어 (M1/M3)

| 티켓 | 내용 | 상태 |
|---|---|---|
| MOMO-300 | subscribe proxy 인증 + token revocation + rate limit | `ready` |
| MOMO-301 | agent_run depth/round 스키마 + 루프가드 G1~G4 실쿼리 | `review` (2026-07-06 구현: 007 마이그레이션 + G1~G4 실쿼리 + 트립 verifier 3종, STATUS §0az) |
| MOMO-302 | 컨텍스트 조립 v1 (단일 메시지 → 히스토리/토큰 윈도) | `ready` |
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
| MOMO-323 | GWS 스펙 정정 3건 + Internal consent 런북 (문서만) | `review` (2026-07-06 스펙 정정 3건 + `docs/GWS_INTERNAL_CONSENT_RUNBOOK.md` + fixtures `boundary_kind`, STATUS §0az) |

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
