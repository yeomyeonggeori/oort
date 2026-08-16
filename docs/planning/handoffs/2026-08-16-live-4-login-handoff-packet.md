# LIVE-4 핸드오프 패킷 — 로그인 핸드오프 카드 축 (에이전트 발제형)

> 2026-08-16 Fable 발급, **성재 발사 결재 완료(우로보로스 인터뷰 편성 승인 — 2026-08-16 구조화 질의)**. 워커: 단발 무명 Opus 5.
> planning ID: **PLN-20260815-01** (owner: Fable · integrator: momo-main) · supersedes: 없음
> 정본 goal: GitHub Issue **#1428**(status:ready — metadata-only binding). 수용기준 정본 = 본 패킷 §4.
> 설계 정본(필독): **`docs/planning/research/2026-08-16-live4-interview-and-plan.md`**(인터뷰 확정 6설계·발제자 절단·LIVE-5 예약) · ADR-0004 증보 3 Accepted · ADR-0165+증보 1.
> **스코프 절단 명심**: 이 goal은 **에이전트 발제형 카드 축만**이다. 창을 여는 UI·입력 포워딩·framesDecoded 게이팅·관전자 observation 전환은 전부 **LIVE-5**(설계 정본 §3) — 만들면 이탈.

## 0. 발주 전 랜딩분 대조

- base = **`track/engine@8ce5ad38`**(#1425 PR #1427 랜딩 HEAD, 2026-08-16). #1425가 준 것: run 파킹/재개 writer 쌍·notifier lease sweep·`work.session.control` 봉투 어휘의 momo_t3 하강·파킹 run의 거절 문장 분화(에이전트-facing — 이 goal 비접촉).
- LIVE-3(`460f142b`)가 준 것: control 창 원장(end_reason 3종)·경계 이벤트 봉투·owner_only="소유자만 본다" 카피 계열.
- 채팅 카드 선례: 승인 카드(approvalNote — receipt>blocked>guidance 위계)·divider 계약이 momo-core에 실재. **로그인 핸드오프 카드는 그 가족의 신구성원으로 — 새 카드 체계 발명 금지.**

## 1. 미션 요약 — 네 조각

1. **코어 카드 계약**: "로그인 핸드오프 요청" 카드 kind — 에이전트가 채팅에 올리는 구조화 메시지(단일 쓰기경로). 상태: 대기 중(에이전트 정지) → 터미널 3종(`returned`=개입 완료 / `expired`=중단·완료 불확실 / `session_ended`) — **control 창 원장 end_reason에 1:1 대응, 새 상태 어휘 발명 금지**. 카드 액션: 세션 상세 딥링크 + **재개**(에이전트 계속 — 핸드오프 취소) + **중단**(run 중지). 폰: 카드 렌더+["데스크톱/웹에서 열기"] 안내(attach 내부 비반입 가드).
2. **에이전트 방출+정지 결선**: 에이전트가 카드를 올리며 자기 run을 세우는 기계 — **기존 승인 hold(`is_approval_held`·awaiting_approval 계열) 재사용을 1순위로 탐사**(에이전트가 사람을 기다리는 동형 폐곡선·resume 경로 기존재·#1425가 의미 보존을 테스트로 고정). 재사용 성립 불가 판명 시 **추측 신설 금지 — 동결+이탈 보고**. 카드의 재개/중단이 그 hold를 푸는/끝내는 경로와 결선.
3. **경계 이벤트 표면**: `work.session.control` 개설/닫힘(API로 창이 열린 경우 포함)을 카드·세션 상세에 정직 표시 — 정지 시각·재개 시각·닫힘 사유. 이벤트는 전송(Centrifugo)일 뿐 SoT는 원장 투영.
4. **정직 카피 2분법+부재-단언 갱신**: 배포 사실("이 배포에서는 아직 화면 전송이 준비되지 않았습니다") ≠ 세션 사실 — 카드에서 직접 조작 안내가 필요한 자리엔 배포 사실 카피(어포던스는 **부재**로, 비활성 버튼 금지). `displayStream.test.ts` 부재-단언(인수 금지·datachannel 부재·input_enabled 정직)의 controller 시대 문법 갱신.

## 2. 필독 코드 좌표 (base에서 재확인)

- 코어 카드 선례: `packages/momo-core/src/features/`의 approvalNote·divider·composerCopy 계약(위계·톤 계약·카피 단일 소스 규율 — CRUN-3).
- 승인 hold 기계: `server-rust/crates/momo-agent/src/run.rs`(#1425 후 — RunStatus·is_approval_held·requeue_run_from_approval_in_tx)·`agent_gateway` hold 거부 지점(:345·:567 계열).
- 창 원장·이벤트: `server-rust/crates/momo-t3/src/display_control.rs`(end_reason·`control_window_payload` — #1425가 봉투 어휘를 여기로 하강)·`routes/display_attach.rs`(경계 이벤트 방출 지점).
- 웹: `clients/web/src/features/work/WorkSessionDetail.tsx`·`displayStream.ts`(카피·부재-단언)·채팅 카드 렌더 계열(승인 카드 렌더러). 폰: `clients/mobile` 카드 렌더+가드 테스트(`__tests__/workConsole.test.tsx`).
- 디자인: momo-design-taste-web 프리플라이트·`docs/design-system/README.md`. **"인수" 단어 금지**(증보 3 D1) — 카드·카피 전체.

## 3. 지켜야 할 계약

- 하드 불변식: 단일 쓰기경로·RLS FORCE·seq 순서·schema_v0 불가침·시크릿 금지. 카드 메시지도 보통 메시지의 원장 규율을 따른다(멱등·outbox 1행).
- **창을 여는 코드 금지**(LIVE-5): 이 goal의 어떤 표면도 display controller 발급·창 개설을 호출하지 않는다. 서버 스키마 변경 최소(카드 kind가 스키마를 요구하면 마이그 077 — 번호 스크립트 통과).
- 에이전트 자격·자유문 비유입: 카드에 자격증명 입력 필드 금지(증보 3 D2 — 채팅에 비밀번호 경로를 만들지 않는다), 카드 본문은 에이전트가 쓴 요청 사유 텍스트+구조화 필드만.
- 실기동 불가 지점 정직 라벨. 테스트 캔어리는 결정적 단언만.

## 4. 수용 기준 (계약 정본)

1. 코어 카드 계약: kind·상태기계(대기→터미널 3종=end_reason 1:1)·액션 3종(딥링크/재개/중단)·카피 단일 소스·웹/폰 렌더 파리티(폰=안내 동선).
2. 에이전트 방출+정지: hold 재사용 성립 시 — 카드 올림=run hold, 재개=hold 해제, 중단=run 중지, 각 경로 멱등+테스트. (불성립 시 동결+보고가 PASS 조건.)
3. 경계 이벤트 표면: 개설/닫힘이 카드·세션 상세에 반영(정지·재개 시각), API-발 창 개설도 정직 표시.
4. 정직 카피 2분법 실장+어포던스 부재 원칙(비활성 버튼 0)+부재-단언 갱신.
5. 게이트: 웹 typecheck·test·게이트 스위트, 코어·폰 test, design 프리플라이트, **design-review Blocker 0**(카드 상태 전이 — 상태별 캡처 라이트/다크). 서버 접촉 시 clippy·conformance·verifier 무회귀.

## 5. 작업 규율 (E6 동형)

워크트리 `~/projects/momo-tracks/momo-worktrees/live4-login-handoff` · 브랜치 `feat/live4-login-handoff` · 단발 무명·중간 보고 없음·로컬 커밋 동결·미결 경계=동결+이탈 보고.

## 6. 리뷰 폐곡선

동결 → Fable 기획검수 → **design-review(Blocker 0)** → 수리 → grok 리뷰어 C freeze → push→PR(track/engine)→CI→머지. 랜딩 시: LIVE-5는 TURN 발주 후 패킷화(설계 정본 §3이 예약 스코프 정본).

## 7. 컨텍스트 델타

- 발제자 절단의 근거·기각된 대안(프레임 게이팅=안전 극장 판정)·관전자 매듭의 해법 전환은 설계 정본 §1-4·§1-5 — 워커가 "왜 창을 안 여는가"를 물을 필요 없게 전부 거기 있다.
