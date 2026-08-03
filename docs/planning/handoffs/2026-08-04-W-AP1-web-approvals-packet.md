# 핸드오프 패킷 W-AP1 — 웹 승인함 (목록 + 결정 UI)

- status: **ready** · planning: 배치 1 「승인이 사람 손에」 · owner/integrator: Fable(momo-main)
- worker: Opus 5 · 기준 브랜치: **`track/engine`** (`dae3a387` 이후 HEAD) · 작업 레포: `~/projects/momo-tracks/engine` 기준의 **새 워크트리**
- 근거 결정: ADR-0137 D5(v0 축=관전·승인·대화) · 검증 정본 `docs/planning/2026-08-04-handover-verification-and-roadmap-adjustment.md` §2.1·§3 배치 1
- supersedes: 없음

## 0. 왜 이 티켓인가 (한 단락)

승인 축은 서버가 섰다(#979 — 목록·결정·재개 폐곡선, 게이트 7/7). 그런데 **웹에는 결정 UI가 0건**이다: 인박스 `FeedRow`가 승인 항목에 아이콘을 그릴 뿐, 결정 POST를 부르는 코드가 클라이언트 웹 전체에 없다. 에이전트가 승인을 기다리며 멈춰 서면 웹 사용자가 할 수 있는 일이 없다. 이 티켓이 닫히면 승인 축이 **웹에서 폐곡선**이 된다.

## 1. Goal

1. **momo-core surface 플립**: `packages/momo-core/src/features/capabilities/serverSurfaces.ts`의 `approvals.provided`를 `false → true`로 바꾸고 `measured`를 갱신한다(근거: `server-rust/bins/momo-server/src/lib.rs`에 승인 3라우트 등록, 2026-08-04 실측). **이 파일의 approvals 항목 외에는 momo-core를 수정하지 않는다**(병렬 티켓 M-AP1과의 충돌 경계).
2. **웹 승인함**: 인박스(`clients/web/src/features/inbox/`)에 승인 목록 + 결정(승인/거부) UI를 세운다. 신규 feature 디렉터리를 팔지, 인박스 확장으로 할지는 기존 인박스 구조를 읽고 워커가 판단하되 **판단 근거를 PR 본문에 적는다**.

## 2. 서버 계약 (정본 — 추측 금지, 코드를 읽어라)

| 무엇 | 위치 |
|---|---|
| `GET /v1/workspaces/{ws}/approvals` (목록, 쿼리 필터) | `server-rust/bins/momo-server/src/routes/approvals.rs:104` (`list`) |
| `POST /v1/workspaces/{ws}/approvals/{approval}/decision` | `approvals.rs:168` (`decide_by_approval`) |
| `POST /v1/agent-runs/{run}/approval-decisions` (run 기준 결정) | `approvals.rs:191` (`decide_by_run`) |
| DTO 모양 (Swift 패리티) | `server-rust/bins/momo-server/src/dto.rs:2214-2283` — `ApprovalDto` · `ApprovalListResponse` · `ApprovalDecisionRequest` · `ApprovalDecisionReceipt` · `ApprovalListQuery` |
| status 어휘 | `approvals.rs:112` — pending / approved / rejected / expired / cancelled |
| 결정 로직 (클라 재사용 대상) | `packages/momo-core/src/features/timeline/approvalDecision.ts` — `decideApproval`(:76) · `interpretReceipt`(:160) · `newDecisionId`(:60) · `sendFailureCopy`(:69). **모바일 푸시 결정 경로가 이미 쓰는 모듈이다 — 새로 만들지 말고 이걸 소비하라** |

## 3. 지켜야 할 계약

- **되돌릴 수 없는 액션 규율**: 승인은 이 제품에서 되돌릴 수 없는 유일한 액션 계열이다(모바일 `InboxScreen.tsx` 상단 주석 참조). 원클릭 즉발 금지 — 확인 단계 또는 명시적 2단 상호작용. 거부도 동급.
- **`superseded`는 결정됨으로 취급** — 이미 다른 곳(폰 푸시 등)에서 결정된 항목에 두 번째 결정을 보내면 receipt가 그렇게 답한다. `interpretReceipt`가 이미 그 해석을 안다.
- **한국어 카피는 클라가 만든다** — 서버 `ApiError`는 영어다(한글 0건 실측). `momo-core`의 기존 패턴(`http.ts`/`api.ts`)을 따른다.
- **미제공 vs 장애 구분**: `serverSaysAbsent`(404/405/501) 폴딩 규약을 그대로 쓴다. 라이브 서버는 이 글을 쓰는 시점에 아직 미배포(404)다 — 플립 후에도 런타임 폴딩이 이를 "미제공"으로 접는 것이 정상 동작이다.
- **디자인**: `momo-design-taste-web` 스킬 규율(여명 토큰·4상태 의무·키보드/포커스 링·AI-tell 금지). 어휘는 「재우기/깨우기」 계열(성재 결정 C).
- **에이전트 principal은 승인 결정 불가** — UI를 사람 세션 전제로만 열 것.

## 4. 함정 (전 배치가 이미 밟은 것)

- `GET …/channels/{ch}/agent-runs`는 POST 전용 경로라 **405**가 돌아온다 — 404만 보는 판정은 장애로 오인한다(registry 주석의 실측 사례).
- 목(mock)이 같은 tick에 답하면 포커스/타이밍 단정이 헛초록이 된다 — 게이트/테스트에서 응답 지연 편차를 넣어라(#839 교훈).
- 뷰포트 밖 컨트롤 2연속 전과 — 900x600에서 결정 버튼이 화면 안에 있는지 확인.

## 5. 검증 (PASS 기준)

- 웹 테스트 전체 + `typecheck` 0 + 기존 gate 스크립트 무회귀.
- 신규 UI 상태 4종(로딩/빈/오류/미제공) 테스트.
- **red proof ≥ 2**: ①pending이 아닌 항목에서 결정 컨트롤이 렌더되지 않음을 단언하고, 조건 분기를 부수면 이름 있는 실패 ②superseded receipt가 "이미 결정됨"으로 표기되고 오류로 그려지지 않음.
- 결정 왕복은 fixture로: 게이트 모드 픽스처 이음매(`serverSurfaces.ts` 하단 주석, `turnFixture.ts` 선례)를 따른다.

## 6. 이탈 보고 의무

패킷/계약과 어긋나는 발견(예: DTO 모양이 core 기대와 다름, momo-core 수정이 불가피)은 **임의 해결하지 말고** PR 본문 `## 계획 이탈` 절에 적어라. momo-core의 approvals 항목 외 수정이 필요하면 **멈추고 이탈로 보고**.

## 7. 착수

```bash
cd ~/projects/momo-tracks/engine && git fetch origin track/engine && \
git worktree add ~/projects/momo-tracks/momo-worktrees/W-AP1-web-approvals -b feat/W-AP1-web-approvals origin/track/engine
```
작업 → 커밋 → push → `gh pr create --repo Dawn-kim-official/momo --base track/engine` → **STOP** (머지 금지, 리뷰는 오케스트레이터).
