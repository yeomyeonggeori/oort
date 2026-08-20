# LIVE-3 핸드오프 패킷 — control 개방 엔진 축 (display controller · control 창 원장 · 비관측 강제 · owner_only owner 예외)

> 2026-08-15 Fable 발급, **성재 발사 결재 완료(2026-08-15 구조화 질의 "지금 발사" — 계약 선행+정직 라벨, 실 E2E는 TURN 후)**. 워커: 단발 무명 Opus 5.
> planning ID: **PLN-20260815-01** (owner: Fable · integrator: momo-main) · supersedes: 없음
> 정본 goal: GitHub Issue **#1424**(status:ready — metadata-only binding). 수용기준 정본 = 본 패킷 §4.
> 경계 정본: **ADR-0004 증보 3 Accepted**(control-창 비관측·사용자 자격 비유입·어휘 control≠인수·VM running 유지) · ADR-0165(+증보 1 Accepted — 전송·TURN) · 선행 랜딩: LIVE-1(#1409 — 마이그 075의 observer 스키마 잠금이 "경계가 열리는 날 지우는 절"로 설계됨)·LIVE-2(#1412).

## 0. 발주 전 랜딩분 대조

- base = **`track/engine@f56c07f7`**(#1418 랜딩 HEAD, 2026-08-16).
- 개방의 실행 지점이 이미 설계돼 있다: `server/Migrations/075_display_attach.sql` 말미 주석 — "경계가 열리는 날 이 절(`terminal_attach_display_observer_ck`)을 지우는 것이 그 결정의 실행 지점". 그 결정(증보 3)이 2026-08-15 Accepted 됐다.
- 3중 잠금의 나머지 두 층: `momo-t3/src/terminal_attach.rs` `AttachKind::permits_mode`(display→observer만) · `routes/display_attach.rs` `requested_display_mode`(controller 403). **세 층이 함께 움직여야 한다**(075 주석의 계약).

## 1. 미션 요약 — control을 여는 네 조각

1. **마이그 076**: ①`terminal_attach_display_observer_ck` 제거 ②**control 창 원장** 신설(`display_control_window`: 세션·grantee(=owner member)·started_at·ended_at·end_reason — 경계 이벤트의 SoT, RLS FORCE) ③(별항) owner 예외는 스키마 불요 — 인가 로직.
2. **display controller capability 개방**: `permits_mode`·라우트 403 해제하되 **grantee=세션 owner만**(PTY controller의 `c.owner_member_id = ws.member_id` 술어 재사용 — 증보 3 D1의 control은 사용자의 행위, v0는 owner 한정). 발급=control 창 열림(원장 행+audit), validate의 controller 응답에 `input_enabled: true`. 반환(창 닫힘)=명시 REST(owner)+capability 만료·세션 종료 시 자동 닫힘(fail-closed).
3. **비관측 강제 = 에이전트 run 진행 경로의 서버 게이트**: control 창 활성 동안 **그 세션의 에이전트 run 진행(도구 실행·턴 계속)의 서버측 경로가 보류/거부**되고(fail-closed — 이것이 증보 3 D3의 기술 차단: 정지된 에이전트는 캡처할 수 없다), 에이전트에는 **경계 이벤트만**(정지 시각·재개 시각·"사용자 개입 완료") 전달. **run 기계의 실제 seam은 탐사 대상** — agent run 진행이 서버를 경유하지 않는 구조라 게이트 불가로 판명되면 **추측 구현 금지, 동결+이탈 보고**(그 경우 controller 개방 자체를 이 goal에서 닫아둔 채 동결 — 증보 3 위반 상태로 열지 않는다).
4. **owner_only owner 예외**(성재 결재로 이 파도 편입): display **observer** 발급의 observation 게이트에 owner 우회 추가 — `owner_only` = "소유자만 본다"로 확정(기존 "아무도 못 본다" fail-closed를 대체). LIVE-2가 고정한 fail-closed 테스트·게이트 문장(`소유자도 볼 수 없습니다` 계열)을 새 의미로 갱신(웹 카피 갱신이 필요하면 최소 diff — 큰 UX는 LIVE-4).

template spec(`infra/cubesandbox/display-template/`): controller validate 성공 시에만 입력 채널 협상 허용으로 계약 갱신(D4 유지 — view-only 발급엔 여전히 채널 부재). producer 실기동은 여전히 TURN 후(정직 라벨 유지).

## 2. 필독 코드 좌표 (LIVE-1 랜딩 기준 — base에서 재확인)

- `server/Migrations/075_display_attach.sql`(잠금 절+주석) · `021_work_host.sql`.
- `server-rust/crates/momo-t3/src/terminal_attach.rs`: `AttachKind::permits_mode`·`validate_attach_capability_in_tx`(controller 술어 `c.owner_member_id = ws.member_id` — PTY와 공유)·`issue_attach_capability_in_tx`.
- `server-rust/bins/momo-server/src/routes/display_attach.rs`: `requested_display_mode`(403 지점)·`issue_in_tx`(observation 게이트 — owner 예외 지점)·`validate`(`input_enabled` 리터럴).
- run 기계 탐사 시작점: `server-rust/crates/momo-outbox/src/gateway.rs`(job claim/renew — hosted)·agent run 관련 라우트(`routes/` 안 run/turn 계열)·ADR-0140(T3 상태기계 — **불변 유지**: control 중 VM running·과금 지속)·ADR-0155(취소 시 스트리밍).
- 웹 소비자(참고 — 이 goal 수정 최소화): `clients/web/src/features/work/DisplayObserver.tsx`(observer 전용 유지)·`displayStream.ts`(카피)·LIVE-2 가드 테스트(`displayStream.test.ts`의 "인수" 금지·observer-only 단언 — controller 개방과 정합 갱신).

## 3. 지켜야 할 계약

- 하드 불변식: 단일 쓰기경로·RLS FORCE·`schema_v0.sql` 불가침·시크릿 금지·프레임 비저장(ADR-0165 D5 — control 창도 녹화 없음).
- **증보 3 전 조항**: D1 어휘(control≠인수 — "인수" 단어 금지)·D2 자격 비유입(control 창 입력이 전사·audit·Memory Plane 비유입 — audit엔 경계 이벤트·채널 사실만)·D3 비관측(위 §1-3)·D4 재개=세션 상태(서버는 쿠키류 비보관)·D6 VM running 유지(T3 상태기계 무변경 — `running` 그대로, 정지는 run 층)·D7 범위(cloud+cubesandbox·BYOC fail-closed 유지).
- 마이그 076 단일·번호 스크립트 통과. LIVE-1 verifier(`verify_display_attach.sh`)의 observer-잠금 단언은 **새 계약으로 갱신**(잠금 해제가 회귀로 읽히지 않게 — controller 발급이 owner 한정·창 원장 동반임을 단언).
- 비관측 게이트는 **mutation 증명**(게이트를 우회한 run 진행이 실제로 거부되는 적대 케이스) — 증보 3 Consequences의 수용기준.
- 실기동 불가 지점은 정직 라벨(`runtime-unverified(...)`) — 추측 성공 주장 금지.

## 4. 수용 기준 (계약 정본)

1. 마이그 076: 잠금 절 제거+control 창 원장(RLS)+적용·롤포워드.
2. controller 발급: owner만·창 원장 행 동반·audit — 비owner/비멤버/BYOC/비광고 호스트/observer-세션 owner_only 케이스 매트릭스.
3. 반환·만료·세션 종료의 창 닫힘 3경로 전부 fail-closed + 멱등.
4. **비관측 게이트**: control 창 활성 동안 run 진행 경로 보류/거부 실증 + mutation 증명 + 경계 이벤트 전달 계약. (게이트 불가 판명 시 §1-3 동결 절차.)
5. owner_only owner 예외: observer 발급 owner 우회 + LIVE-2 고정 테스트·게이트 문장 정합 갱신.
6. validate `input_enabled`가 kind·mode·창 상태에 정직(controller+창 활성일 때만 true).
7. verifier 갱신+기존 무회귀(pty·display observer 경로 그린)·workspace clippy·전체 테스트·마이그 번호. 로컬 docs gate 금지(#1376).

## 5. 작업 규율 (E6 동형)

워크트리 `~/projects/momo-tracks/momo-worktrees/live3-control-open` · 브랜치 `feat/live3-control-open` · 단발 무명·중간 보고 없음·로컬 커밋 동결·미결 경계=동결+이탈 보고. 문서: STATUS·overview 관전 절·OpenAPI·CURRENT_STATE(engine 계보) supersede.

## 6. 리뷰 폐곡선

동결 → Fable 기획검수(C/H/M) → 수리 → grok 리뷰어 C freeze → push→PR(track/engine)→CI→머지. 랜딩 시 **LIVE-4(웹: 직접 조작 UI·로그인 핸드오프 UX — "여기서 로그인해 주세요" 정지 카드→control→반환→쿠키 재개, design-review Blocker 0) 패킷 발급·발사**(성재 결재 완료분).

## 7. 컨텍스트 델타

- 실 미디어·입력 E2E는 TURN 호스트(발주 검토 패키지 — 성재 결재 진행 중) 후 — 이 goal은 계약·원장·게이트를 완결하고 정직 라벨.
- LIVE-2의 관전 UI는 observer 전용 유지 — controller 소비 UI는 LIVE-4.
