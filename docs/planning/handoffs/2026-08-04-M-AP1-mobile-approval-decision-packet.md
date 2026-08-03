# 핸드오프 패킷 M-AP1 — 모바일 인앱 승인 결정

- status: **ready** · planning: 배치 1 「승인이 사람 손에」 · owner/integrator: Fable(momo-main)
- worker: Opus 5 · 기준 브랜치: **`track/engine`** (`dae3a387` 이후 HEAD) · 작업 레포: `~/projects/momo-tracks/engine` 기준의 **새 워크트리**
- 근거 결정: ADR-0137 D5 · 성재 결정 E(2026-08-04 — 인앱 결정을 배치 1에서 개방) · 검증 정본 `2026-08-04-handover-verification-and-roadmap-adjustment.md` §2.1
- supersedes: 없음

## 0. 왜 이 티켓인가

모바일 인박스는 승인 **목록**과 **푸시 잠금화면 결정**(승인/거부 액션, 생체/암호 요구)까지 이미 배선돼 있다. 인앱 결정만 의도적으로 보류돼 있었다 — `clients/mobile/src/screens/InboxScreen.tsx:60-72` 주석이 그 이유("서버에 엔드포인트가 없어 한 번도 실행해볼 수 없는 되돌릴 수 없는 컨트롤은 출하하지 않는다")와 함께 **"다음 배치의 1순위"라고 스스로 발주해 뒀다.** 서버가 섰으니(#979) 그 보류를 푼다.

## 1. Goal

`InboxScreen`의 승인 항목에서 **인앱 결정(승인/거부)** 을 연다. 푸시 결정 경로와 **같은 core 함수**(`decideApproval`·`interpretReceipt`)를 소비한다 — 두 경로가 다른 코드를 타면 그 갈라짐이 다음 결함이다.

## 2. 파일 맵 (정본 — 읽고 시작하라)

| 무엇 | 위치 |
|---|---|
| 발주서가 된 주석 + 목록 화면 | `clients/mobile/src/screens/InboxScreen.tsx` (:45-75 — fail-closed 구조 포함) |
| 결정 로직 (재사용, **수정 금지**) | `packages/momo-core/src/features/timeline/approvalDecision.ts` — `decideApproval`(:76) · `interpretReceipt`(:160) · `newDecisionId`(:60) |
| 푸시 결정 선례 (참조, **수정 금지**) | `clients/mobile/src/push/notifications.ts:120-145` — superseded=결정됨 취급의 선례 |
| 푸시 카테고리 (참조) | `clients/mobile/src/push/categories.ts:22-62` — 잠금화면 결정이 인증을 요구하는 이유 |
| surface 게이트 (참조, **수정 금지**) | `packages/momo-core/src/features/capabilities/serverSurfaces.ts` — `approvals.provided` 플립은 **병렬 티켓 W-AP1의 몫**이다. 이 티켓은 플립에 의존하지 않고 `isSurfaceProvided('approvals')` 게이트 아래에서 UI를 세운다(fixture로 검증) |
| 서버 계약 | `server-rust/bins/momo-server/src/routes/approvals.rs:104,168,191` · `dto.rs:2214-2283` |

## 3. 지켜야 할 계약

- **수정 범위 = `clients/mobile/**` 만.** `packages/momo-core` 수정이 불가피해 보이면 **멈추고 PR에 이탈 보고**(W-AP1과 같은 파일을 만지면 머지가 깨진다).
- **되돌릴 수 없음 규율**: 잠금화면 결정도 인증을 요구한다(categories.ts 주석). 인앱도 동급의 마찰 — 확인 단계 필수. 원클릭 즉발 금지.
- **superseded=결정됨**: 푸시에서 이미 결정된 항목을 인앱에서 또 결정하면 receipt가 superseded로 답한다 — 오류가 아니라 "이미 결정됨"으로 그린다(notifications.ts:142 선례).
- fail-closed 유지: 서버 미제공이면 지금처럼 미제공 문구. 어휘는 「재우기/깨우기」 계열(성재 결정 C).
- 한국어 카피는 클라 몫(서버 ApiError는 영어).

## 4. 함정

- 라이브 서버는 아직 미배포(404) — 실서버 왕복은 오케스트레이터 검수 단계 몫이다. 워커 검증은 fixture/게이트 모드.
- 목이 같은 tick에 답하면 타이밍 단정이 헛초록(#839) — 지연 편차를 넣어라.
- #980의 교훈: 픽스처가 결함을 잠글 수 있다(`SESSION-CLOUD`가 ended인데 "계속됩니다"를 단언했던 사례) — 픽스처 상태와 단언 문구가 서로 참인지 재확인.

## 5. 검증 (PASS 기준)

- 모바일 테스트 전체 + typecheck 0.
- 상태 4종(로딩/빈/오류/미제공) + 결정 성공/실패/superseded 3분기 테스트.
- **red proof ≥ 2**: ①확인 단계를 건너뛰는 경로가 없음(확인 없이 `decideApproval`이 불리면 이름 있는 실패) ②pending 아닌 항목에 결정 컨트롤 비노출.

## 6. 이탈 보고 의무

PR 본문 `## 계획 이탈` 절. 특히 core 수정 필요·DTO 불일치·푸시 경로와의 충돌은 임의 해결 금지.

## 7. 착수

```bash
cd ~/projects/momo-tracks/engine && git fetch origin track/engine && \
git worktree add ~/projects/momo-tracks/momo-worktrees/M-AP1-mobile-approval -b feat/M-AP1-mobile-approval origin/track/engine
```
작업 → 커밋 → push → `gh pr create --repo Dawn-kim-official/momo --base track/engine` → **STOP** (머지 금지).
