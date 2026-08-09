# 핸드오프 패킷 AP-2R(=M-AP1 2R) — 승인 표면 정직성 수리 (core 뿌리 + 모바일)

- status: **ready** (2026-08-04 W-AP1 리뷰 반영 완료) · 배치 1 2R · owner/integrator: Fable(momo-main)
- worker: **worker-M-AP1**(기존 브랜치 `feat/M-AP1-mobile-approval`에 추가 커밋 — W-2R과 병렬, 머지는 W 먼저·너는 그 뒤 리베이스)
- **병렬 경계(중요)**: W-AP1 2R이 동시에 돈다. **네 전속 = core `model.ts`·`api.ts` + `clients/mobile/src/**` + `clients/mobile/__tests__/inboxApproval.test.tsx` + core model 테스트.** core `serverSurfaces.ts`·`approvalDecision.ts`·`clients/web/src` 소스·`clients/mobile/__tests__/shell.test.tsx`는 **W-2R 전속 — 접근 금지.** core 변경이 웹 테스트의 문자열 단정을 깨면 그 **테스트 단정만** 고치고 이탈로 보고.
- 발단: #987 디자인 리뷰(신선 컨텍스트) **Blocker 2 · High 5 · Medium 6** — 오케스트레이터가 B1·B2를 코드에서 독립 확정
- 전제: 이 Blocker들의 뿌리는 네 코드가 아니라 **기존 core**(B5.3b·RN-N1 시절)다. 1R 패킷이 core 수정을 금지해 네가 고칠 수 없던 자리이고, 이제 W-AP1이 랜딩해 **core 수정이 허용된다**(이 패킷이 그 허용의 정본).

## 0. 리뷰가 확정한 것 (요지 — 전문은 리뷰 보고서, 오케스트레이터 보관)

> 컨트롤(확인 단계·400ms 가드·멱등키·superseded 구분)은 견고하다. **무너지는 것은 컨트롤이 하는 말이다.**

## 1. Blocker — 반드시 이 순서의 뿌리에서 고쳐라

### B1. 비가역 승인이 전부 "되돌릴 수 있음"으로 렌더
- 계약: `server-rust/bins/momo-server/src/dto.rs:2210-2212` — *absent `isReversible` = "unknown", never "reversible"*. 서버 DTO에 이 필드는 **없다**.
- 위반 뿌리: `packages/momo-core/src/features/inbox/model.ts:280-281` — `isReversible !== false`를 가역으로.
- v0의 유일한 툴 `work.session.end`는 **비가역이 선정 사유**(`server-rust/crates/momo-agent/src/tools.rs:33-38`).
- **수리**: fail-closed 반전 — 명시적 `true`만 가역. absent/false 모두 「되돌릴 수 없음」 경고 + 확정 문장 재진술. 모바일 `ApprovalDecision.tsx:67` 기본값·웹 `ApprovalActions.tsx:40`·`InboxRoute.tsx:235`가 같은 뿌리를 소비하는지 확인하고 세 표면이 한 판정을 쓰게 하라.

### B2. 행 제목이 내부 식별자 `tool_call`
- 서버가 보내는 유일한 action_type = `"tool_call"`(`tools.rs:82`). core `actionTypeLabel`(`model.ts:384-392`)은 모른다 → 사용자 화면에 `tool_call 허가를 요청했습니다`.
- 툴 이름은 `payload`에 있으나 `WireApproval`(`packages/momo-core/src/lib/api.ts:2005` 부근)이 payload를 타입에서 제외 — 화면에 닿을 길이 없다.
- **수리**: ①`WireApproval`에 payload에서 툴 식별 최소 필드만 파싱(서버 payload의 실제 키는 `routes/approvals.rs`·`tools.rs`에서 실측 — 추측 금지) ②`tool_call`+툴명 → 사람 문장 매핑(`work.session.end` → 예: "작업 세션 종료 허가"). 미지 툴은 **원문 툴명**을 보여주되 `tool_call`이라는 계층 식별자는 노출 금지.

## 2. High

- **H1 (모바일)** 픽스처가 B1·B2를 잠근다: `__tests__/inboxApproval.test.tsx:128-141`이 서버가 절대 보내지 않는 형상(`action_type:'work.spawn'`·`is_reversible:true`)만 렌더. **기본 픽스처를 프로덕션 형상(`tool_call`+필드 부재)으로 교체**하고, 가역 명시 케이스는 별도 픽스처로. 수리 전 그 픽스처에서 B1·B2가 **빨간불**임을 먼저 확인하라(red proof).
- **H2** — 코드 수정 불요. W-AP1(#988)의 `provided:true` 플립이 먼저 머지되므로 릴리스 순서로 해소됨. 리베이스 후 네 테스트 헤더 주석이 현실과 일치하는지 만 확인.
- **H3 (모바일)** 결정 결과(성공/superseded/오류)에 `announceForAccessibility` 부재 + 영수증이 목록 상단 고정이라 스크롤 상태에서 화면 밖. announce 추가 + 영수증 가시성(행 근처 표시 또는 결정 시 스크롤 — 네 판단, 근거를 PR에).
- **H4 (core 카피, 웹·모바일 공통)** "바로/이어서 실행합니다"는 계약상 못 지키는 약속 — `approve_run`은 run이 hold를 떠났으면 resume job 없이 200을 답하고, 정상 경로도 outbox 비동기다. 확정 문장은 조건 없는 사실로(예: "승인하면 에이전트가 이어서 진행합니다"), 영수증은 "승인을 기록했습니다"류로. 웹 `ApprovalActions.tsx:129-130`·`InboxRoute.tsx:202`와 모바일이 같은 문장을 쓰게 하라.
- **H5 (모바일 푸시 경로)** `push/notifications.ts:139-145`가 superseded를 `{kind:'decided', approved}`로 접어 **반대 판정이 있어도 사용자가 누른 방향으로 성공 보고** + `PushProvider.tsx:160-168` 결과가 console.log뿐. 최소 수리: superseded를 실제 기록된 방향으로 구분. 실패의 사용자 고지는 비용 대비 판단해 이탈 보고로.

## 3. Medium (전건 수리 대상, 판단 여지는 이탈 보고로)

M1 400ms 가드 내 탭 무피드백 → 가드 중 시각적 inert 또는 한 줄 고지 · M2 무장 버튼 a11y 라벨이 행동을 약속("승인"→"승인, 확인 필요"류) · M3 superseded 영수증에 실제 결정 방향 표기(`outcome.status` 사용) · M4 만료 행의 확정 문장 정직화 · ~~M5 상태 코드 노출~~(**W-2R로 이관** — `approvalDecision.ts`가 W 전속) · M6 영수증 단일 슬롯 덮어쓰기.

## 4. W-AP1 리뷰 반영 (2026-08-04 확정)

- W-리뷰 B1(모바일 shell.test 플립 파장)·B2(활동 라우트)·H1~H3·웹 M들은 **전부 W-2R 몫**(`2026-08-04-W-AP1-2R-packet.md`) — 너는 손대지 마라.
- **확정 카피 정본(오케스트레이터 결정 — 웹과 같은 문장을 모바일에)**: 확정 문장 **"승인하면 에이전트가 이어서 진행합니다."** + 비가역/불명 시 **"되돌릴 수 없습니다."** 재진술 · 승인 영수증 **"승인을 기록했습니다."** · 거부 영수증은 서버 거부→취소가 같은 트랜잭션인지 실측 후 참인 문장만(H4 근거: hold 이탈 시 resume job 없이 200 — "바로 실행"은 못 지키는 약속).
- 네 픽스처 교체(H1)가 W-2R의 shell.test 갱신과 **파일이 다름을 확인했다** — 겹치지 않는다.

## 5. 계약·검증

- 수정 허용: **core `model.ts`·`api.ts`(+그 테스트)** · `clients/mobile/src/**` · `clients/mobile/__tests__/inboxApproval.test.tsx`. 웹은 core 변경이 깨는 **테스트 단정만**. **서버 수정 금지. W-2R 전속 파일 접근 금지**(위 병렬 경계).
- core 수정은 웹 579+/모바일 468 테스트 전체 무회귀가 게이트다. 픽스처 교체 후 **수리 전 상태에서 빨간불 → 수리 후 초록**을 커밋 로그나 PR 본문으로 증명하라.
- 검증: web/mobile/core 테스트 전체 + typecheck + `gate:approvals`(W-AP1 신설) + 기존 게이트 무회귀. red proof: B1(명시 true 아닌 픽스처에서 경고 부재 시 이름 있는 실패) · B2(`tool_call` 문자열이 사용자 문자열에 등장하면 실패).
- PR: 기존 #987 브랜치에 추가 커밋(리베이스 포함) → 재리뷰(Blocker 0) 후 머지.

## 6. 리베이스 단계 추가 작업 (2026-08-04 W-2R 재검증 파생 — N-A·N-B)

W-AP1 머지 후 리베이스 시점에 함께 닫는다(그 시점엔 W-2R 전속 제한이 해제된다):

- **N-A (High)**: 모바일 인박스에 미제공 폴딩이 없다 — `clients/mobile/src/features/inbox/useInbox.ts:354`가 `allFailed`만 보고 `serverSaysAbsent`/`retryUnlessAbsent`를 안 쓴다. 승인 라우트 없는 서버에서 결정 대기 탭이 "인박스를 불러오지 못했습니다"+영원한 재시도가 된다(웹 B2와 동일 클래스). 웹 `useInbox.ts`의 폴딩(absent 계산·재시도 억제·미제공 문구)과 같은 것을 입혀라.
- **N-B (High)**: 「에이전트」 탭 반쪽 정직성(작업 기록 405인 채 "조용한 게 정상") — 웹은 `agentsFeedPartial`(`clients/web/src/features/inbox/approvalsPanel.ts:220`)로 닫았다. **그 판정을 `packages/momo-core`로 승격**하고 웹은 import 교체(한 줄), 모바일은 같은 판정으로 반쪽 고지를 세워라 — 두 클라이언트가 한 벌을 쓰는 것이 목적이다.
- 리베이스 후 필수: `gate:approvals`(W가 신설) 실행 + mobile/web/core 전체 스위트.
