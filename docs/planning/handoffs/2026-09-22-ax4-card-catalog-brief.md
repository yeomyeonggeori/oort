# AX-4 — 카드 카탈로그 v1: 승인 카드 `action` 행·`action_result`·`link_once`·팔레트 서버 카탈로그 병합 (ADR-0186 D4·D5)

- status: draft (착수 조건: **ADR-0186 Accepted** — 부록 A~C·E 고정 계약으로 착수. 병합 검증은 AX-3b 랜딩 뒤)
- issue / planning ID: #2510 · PLN-20260922-AX4
- owner / reviewer: Fable(planner) / design-review(fresh) B0·H0 + Grok 리뷰어 C
- track / base commit: uxui · AX-2 랜딩 뒤 `origin/track/uxui`
- supersedes: 없음

## Goal
에이전트의 제안이 **oort가 그리는 카드**로 보이고, 승인 직후 1회 링크가 그 자리에 나타나며, 새로고침 뒤에는 영속 결과 카드만 남는다. 팔레트 「명령」 그룹이 서버 행동 카탈로그를 합쳐 보여준다.

## 계약과 범위
- 정본: ADR-0186 D4·D5·§5, 부록 A·B·C·E · ADR-0182(①·③) · ADR-0159 네 상태 · `momo-design-taste-web`. 수용기준: 이슈 #2510.
- 허용 파일: `packages/momo-core/src/features/timeline/agentCardModel.ts`(+시험) · `packages/momo-core/src/features/commands/serverActions.ts`(AX-2 인터페이스 채움) · `packages/momo-core/src/features/approvals/**`(결정 응답 파서, 필요 시 신설) · `clients/web/src/features/timeline/AgentCard.tsx`·`ApprovalActions.tsx` · `clients/web/src/features/timeline/ActionResultCard.tsx`(신설) · `clients/web/src/app/QuickSwitcher.tsx`(병합 fetch 배선만) · 캡처 장면 · 시험.
- 지킬 계약: 총 파싱(모르는 값=폴백, 발명 0) · 토큰만 소비 · 토스트 0 · `link_once`는 **React 상태에만**(props·store 영속·localStorage·URL 금지) · 네 상태(로딩·빈·오류·정상) · 결정 버튼의 시간 게이트(`timeGatedTestId`) 현행 유지.
- 범위 밖: 서버, 테마 카드(AX-5), 폰(AX-7), plan/task 카드.

## 구현에 필요한 맥락
- `agentCardModel.ts:400` `AgentApprovalCard`에 `action?: {id, rows[], rationale, requiredRole}` 추가(부록 A). `agentCardModel()`가 `message.type === "tool_result"` && `props["momo.action_result"]`면 새 `AgentActionResultCard {kind:"action_result", actionId, status, ref, rows, decidedBy, next}` 반환(부록 B). `cardKeepsBody` 규칙 갱신.
- `ApprovalActions.tsx`: 승인 성공 응답(부록 C `result.secretOnce`)을 받으면 버튼 자리에 `LinkOnce`(링크 + 「복사」 in-place confirm `useInlineConfirm`) — ADR-0182 ①. 언마운트/새로고침 시 사라짐. 실패 `role_required`는 카드 안 `InlineBanner`(「관리자가 승인해야 합니다」 + 다음 행동).
- `ActionResultCard.tsx`: 부록 B 렌더. `secret_shown_once`면 「링크는 승인한 사람에게 1회 표시됨 · 재발급」— 재발급은 `next.href`(설정 › 초대)로 이동, 카드에서 직접 호출하지 않는다.
- 팔레트 병합: AX-2가 남긴 `parseActionsCatalog` + `GET /v1/workspaces/{ws}/actions` fetch(세션 캐시, 실패=그룹 숨김). 항목 선택 = 해당 설정 표면 이동(v1). 「에이전트에게 시키기」 항목은 없다(에이전트 호출은 채널에서 멘션).
- 시험 픽스처: AX-3b 랜딩 전에는 부록 A~C 샘플 JSON을 픽스처로 쓰고, 랜딩 뒤 ENGINE_HANDOFF의 실샘플로 교체해 `verify_merge_tree`.
- 함정: 「실패할 수 없는 가드」— `link_once` 부재 시험은 새로고침 시뮬레이션(스토어 초기화 + 재마운트) 뒤 DOM에 링크 문자열 0을 잰다. 픽스처 값이 아닌 렌더 결과로.

## 검증과 전달
- `clients/web` typecheck·lint·test · `packages/momo-core` test · preflight · 캡처 장면 4(대기·승인 직후 링크·영속·거부/role_required) 3짝 · `scripts/verify_merge_tree.sh`.
- design-review B0·H0(회귀 우선: tool_call 승인 카드가 그대로인가).
- 전달: PR(track/uxui) + `scripts/goal_release.sh 2510 --review --pr <url>`.

## 체크포인트
(발사 시 기록)
