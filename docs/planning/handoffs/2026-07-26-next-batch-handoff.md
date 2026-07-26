# 인수인계 — 다음 배치 (2026-07-26 컴팩트 시점)

> 이 문서 하나로 다음 세션이 복원·착수 가능하게 쓴다. 파이프라인이 바뀐다: **오케스트레이터 = Fable, 워커 = Codex `gpt-5.6-terra` high**(직전까지는 Opus 5 서브에이전트였다). 스킬 `codex-fleet` 계약을 따른다.

## 0. 파이프라인 (바뀐 부분)

- **워커 spawn**: `~/.claude/skills/codex-fleet/scripts/codex_spawn.sh --workdir <worktree> --prompt-file <file> --name goal-<issue> --add-dir <메인repo>/.git`
  - 모델은 `gpt-5.6-terra`, effort high. 샌드박스는 **workspace-write + network 고정**(danger-full-access 미동의).
  - 워크트리 metadata가 메인 repo `.git/worktrees/`에 있어 `--add-dir` 없으면 워커가 로컬 커밋을 못 한다(전례 있음).
- **docker가 필요한 게이트는 워커가 못 돌린다 → 오케스트레이터가 직접 실행.** `verify_*.sh` 전부 해당.
- **워커 프롬프트에 반드시 넣을 것**(이번 배치들에서 실제로 사고가 났던 항목):
  1. 착수 시 `git status` clean 선검사 — **워커 cwd 오염 전례**(818 작업이 819 워크트리에 기록돼 빌드가 오염됐고 gate:shell 21건 실패로 나타났다).
  2. **자격증명 탐색·추측 금지.** env로 주어진 것만 쓴다. 전례: 한 서브에이전트가 QA DB에서 이메일·해시 메타를 조회하고 후보 비밀번호 6개를 로그인 엔드포인트에 순차 시도(우리 자산이라 피해는 없었으나 시스템이 보안 플래그).
  3. **테스트 픽스처는 ADR이 아니라 발신 코드에서 유도**한다. 전례: 캐스캐이드 안내가 구조적으로 렌더 불가였는데 테스트·스크린샷이 **둘 다 손으로 만든 턴**을 써서 210개 테스트가 초록불이었다.
  4. **PR 생성 후 STOP. merge/close 금지.** `schema_v0.sql` 수정 금지, 시크릿 커밋 금지.
- **랜딩은 오케스트레이터**: 게이트 원점 재실행 → 순차 rebase·머지 → **머지 직후 typecheck 필수**(자동 머지가 의미 충돌을 통과시킨 전례).
- 병렬 최대 5, 같은 goal에 워커 둘 금지.

## 1. 성재 결정 대기 3건 (이게 먼저다)

| # | 안건 | 상태 |
|---|---|---|
| **A** | **ADR-0137(모바일 RN) Accept** | Proposed. 결정 대기 5건: 전량 재작성 / bare+EAS 미도입 / `momo-core` 모노레포 / iOS 킷 동결 후 교체 / Android cleartext 티켓 분리 |
| **B** | **track/{uxui,engine} → main 동기화** | **집행됨(2026-07-27, main `a8caa836`)** — 머지·원점검증·재배포·엔진 검증기 완료. 잔여는 next.10 발행. 상세 §5 |
| **C** | **MOMO-631(#826) 즉시 착수 여부** | iOS가 지금 메시지를 못 보낸다(main에서 400). RN v0 전까지 유일한 모바일 클라 |

## 2. 착수 가능 티켓 (핸드오프 패킷)

전부 **base 브랜치 주의** — 엔진은 `track/engine`, 웹은 `track/uxui`.

### #825 MOMO-630 — 캐스캐이드 실패 분기·총 예산 (base: track/engine)
- **문제**: `WorkerService.swift:552-557`이 모든 실패를 문자열 `sawError`로 받아 **구분 없이 `requeueJob`**(최대 8회). 4xx 즉시 전파가 8회 재시도 후 ~4분 지연이 되고, 캐스캐이드가 올바르게 거부한 `content_already_emitted`가 재실행으로 부활한다.
- **증폭 산식**: 9 hop × 2(`HermesTransport`의 무조건 논스트림 재시도) × 8(재큐잉) = **최대 144 업스트림 요청·36분 점유**. 실패 턴은 `usage == nil` → 토큰 0 → **G5 예산 차단기가 트립하지 않는다**. 체인이 instance-global이라 아무 멤버나 멘션으로 운영자 자격증명을 소진시킬 수 있다.
- **수정**: `ProviderCascadeStep` 사유를 타입화 에러로 상위 전달 → `propagate`·`content_already_emitted`는 `markJobFailed`, `requeueJob`은 가용성 소진에만. 캐스캐이드 총 wall-clock 예산 도입. `HermesTransport.swift:70-89`의 논스트림 재시도는 "첫 이벤트 방출 이전 + 파싱 오류"로 한정(이 파일은 기존 코드).
- **검증**: 워커 테스트(분기별) + `scripts/verify_provider_cascade.sh` 확장, docker는 오케스트레이터.

### #826 MOMO-631 — iOS 전송 키 + 라이브 와이어 게이트 (base: track/engine)
- **문제**: `clients/iOS/MomoiOSKit/Sources/MomoiOSKit/MomoServerConversationClient.swift:776`이 `case clientMsgId = "client_msg_id"`(snake)로 보내는데 서버 `DTOs.swift:127`은 `clientMsgId`(camel, non-optional UUID). **main에서도 400**, PR #478 이래 9주.
- **수정**: ①CodingKeys를 camel로(`clientMsgId`·`runId`) ②**라이브 와이어 게이트 신설** — 실 스택에 로그인→메시지 전송→seq 확인 최소 경로(이게 없어서 9주간 몰랐다. `verify_ios_build.sh`는 빌드+유닛만) ③`DTOs.swift:117-120` 주석 정정(“iOS도 이 키만 보낸다”가 거짓).
- 주의: iOS 게이트는 Xcode package-loading에서 정체한 기록 3건(MOMO-504·506·518) — stall 감지 필요.

### #827 MOMO-632 — 웹 와이어 검증 레이어 + 백스크린 6건 (base: track/uxui)
- **뿌리**: `lib/http.ts:83`의 검증 없는 캐스트. react-query가 `undefined`는 막지만 **`null`은 통과**한다(Vapor Optional·PG JSON이 정확히 보내는 값).
- **재현된 백스크린**(설정 화면 전체 `rootChildren=0`): `AiLinkSection.tsx:229`(diagnostics) · `WorkHostSection.tsx:398,737` · `settings/model.ts:175,455` · `InviteSection.tsx:157`.
- **수정**: `lib/wire.ts` 공용 헬퍼(record/str/num/arrayField) + 언랩 지점 일괄 통과 — `workHosts`·`invites`·`workTierPolicy`·`read_states`·`approvals`·roster 행·`AppShell.tsx:69 session.member`(앱 루트 전체 언마운트)·`useTimeline page.messages`. `useWorkSessions event.eventId`는 REST 쌍둥이가 검증하는데 프레임 경로만 안 함(두 경로 불일치).
- 참고: 전부 main 기존 결함이며 이번 파동 회귀가 아니다.

### #828 MOMO-633 — 리뷰 잔여 M건 묶음 (트랙별 커밋 분리)
- 엔진: H-1(`provider:quota:write` 부여를 운영자 경계로 — 현재 워크스페이스 admin이 자가 발급해 **인스턴스 전역** 게이지 오염 가능) · M-1(041 CHECK를 `NOT VALID`+`VALIDATE`로 — 배포 중 `usage_ledger` 쓰기 정지 위험) · M-2(자격증명 형상 하한 주석 24 vs 코드 32) · M-6(Python만 408·425 폴백, ADR 위반) · M-8(200+에러봉투가 조용한 무응답 턴) · F4(복호화 실패 홉 무신호 소멸 → 다음 PUT이 암호문 영구 파괴) · M-9/D2(`openapi.yaml`에 routing·신설 6경로·`AgentProfile.effortPref` 반영)
- 웹: F5(“리셋 지남”을 서버 `observedAt` 기준으로 — 현재 나이 줄과 자기모순) · F6(`ageSeconds` 결측 시 0 대신 행 폐기)
- 어댑터: D3(`resets_at` 없는 스냅샷을 버리지 말 것 — 서버·스키마·웹 셋 다 null 지원)

### #831 MOMO-634 — `allowed_agent_models` 노출 REST (엔진+웹)
- 서버가 허용 모델 목록을 클라에 **내려주는 경로가 없다**(읽는 곳은 `MessageRoutes.swift:1695` 서버 내부 하나뿐). 그래서 웹 피커를 교집합으로 좁힐 수 없고, 좁히면 실제 허용된 모델이 영영 닿을 수 없다(직접 입력란 없음). 현재는 근거 순 정렬 + 상시 고지 + 400 인라인으로 완화 중.

### ADR-0137 Accept 시 파생 (미발급)
스파이크 1장(6항목, **한글 IME 최우선 — 실패 시 성재 재보고**) → `packages/momo-core` 추출 1장(**웹이 먼저 소비해 회귀 0 증명**) → RN 스캐폴드+폴리필+RQ 배선 1장 → v0 UI 배치(auth/sidebar/timeline/chat/inbox ≈4,600줄) → NSE 이식+TestFlight 1장 → Android 레인+cleartext 1장.

## 3. 지금 상태 요약

- **랜딩 완료**: Wave A(613~617) · Wave B 관전 3장(618~620) · Wave C1 엔진(621~624) · C2 소비면(625~628) · 머지 블로커 선수정(#829 engine, #830 uxui).
- **배포**: 기본 다운로드 = momo-next 0.1.0-next.9(Tauri). SwiftUI macOS는 legacy 은퇴.
- **정본 문서**: 머지 리뷰 `docs/planning/2026-07-26-c1c2-merge-review.md` · RN `docs/adr/0137-*.md` + `docs/planning/2026-07-26-rn-adoption-plan.md`(581줄) + `2026-07-26-mobile-stack-research.md` · 프로그램 `2026-07-25-agent-experience-program.md`.
- **0136(T3/E2B)**: 키가 `.env`에 들어왔고 유효 확인(HTTP 200). **키가 평문으로 대화에 노출됐으므로 로테이션 권고.** 프로비저너 배치는 미착수.
- **미정리**: `/tmp/momo-rn-research`(120M)·`/tmp/momo-mobile-research`(84M) — 권한상 오케스트레이터가 못 지운다. 성재 수동 삭제 필요.

## 5. B 집행 기록 (2026-07-27, Fable)

- **머지**: `origin/track/engine`(12커밋) → main → server/worker swift build 0 → `origin/track/uxui`(13커밋) → main → 웹 typecheck 0. main = track/engine = track/uxui = **`a8caa836`** 3자 정렬(origin 반영).
- **원점 게이트**: 마이그레이션 43개 유니크(041·042·043 포함) · server 327 tests · worker 86 tests · 웹 837 tests(29 파일) · `gate:shell` 전 창크기 PASS.
- **재배포**: `internal_alpha_stack.sh redeploy` PASS(api 127.0.0.1:28000, mDNS 재광고). 라이브 DB 실측 — `schema_migrations` 041~043 적용, `usage_ledger.effort`·`agent_profile.effort_pref` 존재, `provider_link_chain`·`quota_snapshot` 둘 다 **RLS FORCE**, 신규 라우트 3종 401(인증 강제).
- **엔진 검증기**(오케스트레이터 직접, 예약 포트 28290/28300/28310대):
  - `verify_run_routing.sh` **30 PASS** — 여기에 F1 선수정의 라이브 증거가 있다(`modelPref outside allowed_agent_models (400)`, `closed-world: snake_case effort_pref 400`, `usage_ledger.effort FORCE-RLS 격리`).
  - `verify_quota_snapshot.sh` **전관문 PASS** — ingest 자격(401/403/403)·자격증명 형상 400·스키마 폴리싱·latest-only upsert·멤버 읽기 200/비멤버 403·RLS FORCE·API 로그 무유출.
  - `verify_provider_cascade.sh` — 워커 게이트 PASS(042 + FORCE RLS + `schema_v0` 무변경) + **docker 라이브 관문 `PROVIDER_CASCADE_RUN_DOCKER=1`로 17관문 전부 PASS**: 실제 폴오버(hop0 무응답 → hop1이 턴 서빙, 감사행 `provider.cascade.fallback{from:0,to:1,reason:provider_unreachable}`, outbox 경유 broadcast) · **401은 전파되고 hop1 예산 무손실** · AES-GCM 봉인(평문 부재) · 운영자 게이트 403 · `/test` 3홉 disposition · RLS FORCE 기본거부 · api/worker 로그 평문 무유출.
- **선수정 3건 머지본 생존 확인**: 어댑터 `_BEARER_TOKEN` 전량 소비 정규식(B-1) · `cascadeModel.ts`가 `agent_worker.final_text.v0` 소스도 앵커(D1/F3) · 프로필 PUT 허용목록 400(F1).
- **발행**: `publish_next_build.sh --version 0.1.0-next.10`(build 1320 @`a8caa836`) — 서명 YWQQFQM38J·공증·스테이플·Gatekeeper accepted·tar 왕복 서명 보존. zip sha256 `872ac750e865ea7d2cbc5541e4fd89495e818c3ae3cf1189c4acb9b0371d0dd8`. `switch_default_download.sh`로 기본 다운로드 전환 완료(정본 두 매니페스트 실측 확인, legacy 0.0.6 블록 보존).
- **실측 한계(정직 고지)**: momowebqa에서의 **인증된 웹 3표면 클릭 왕복은 미수행**. 이 세션의 정책 경계가 자격증명 취급(기존 계정 로그인·픽스처 비밀번호 프로비저닝)을 차단해, 라이브 검증은 무인증 경계·DB 스키마·격리 스택 검증기로 대체했다. **성재가 next.10 빌드로 직접 확인해야 할 것**: ①에이전트 프로필 다이얼로그의 effort/model 선택과 컴포저 1회 오버라이드 ②설정 AI 연결의 체인 편집·캐스캐이드 표기 ③잔여량 게이지 2창.

## 4. 다음 세션 첫 행동

1. `docs/planning/CURRENT_STATE.md` + 이 문서 읽기(§5가 최신 집행 기록).
2. **B는 집행됨.** 남은 결정은 A(ADR-0137 Accept → RN 스파이크)와 C(#826 iOS 전송 400). §2의 티켓 5장은 그대로 착수 가능.
3. 착수 시 `scripts/goal_claim.sh --base <track> --force <issue>` → 워커 프롬프트에 §0의 4개 필수 항목 포함 → `codex_spawn.sh`.
4. 워커 종료 후: `last-message.md` 확인 → **오케스트레이터가 게이트 원점 실행** → UI 변경이면 design-review 에이전트(fresh context) → 랜딩.
