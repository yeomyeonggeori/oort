# sol 체크포인트 A ADR 초안 (2026-08-11 · 미랜딩 회수분)

sol(GPT 5.6) 인수인계 기간의 서버 안전 릴리스 검수(체크포인트 A)에서 나온 **미랜딩 ADR 초안 5건**.
`sol-20260811-review` 워크트리 폐기(2026-08-14 성재 판정) 전에 회수했다.

⚠ **번호 충돌**: 파일명이 달고 있는 0162~0166은 이후 track/engine에 랜딩된 정본
ADR-0162(외부 에이전트 수용 Agent Port)·0163(관리형 카탈로그)과 충돌한다.
**이 초안들은 ADR이 아니라 결정 재료다** — 채택 시 새 번호로 재기안한다.

| 초안 | 주제 | 현행 정본과의 관계 |
|---|---|---|
| 0162-dnd-notification-policy-boundary | DND/알림 정책 경계 | ADR-0124 증보 1(알림규칙 v0)과 겹침 — 잔여 결정만 유효할 수 있음 |
| 0163-presence-lifecycle-and-monotonic-events | 프레즌스 수명주기 | ADR-0160(user-presence) 랜딩과 대조 필요 |
| 0164-workspace-avatar-content-integrity | 워크스페이스 아바타 무결성 | #1286(ADR-0161 계열) 랜딩과 대조 필요 |
| 0165-workspace-self-leave-history | self-leave 이력 | #1275(self-leave 권한) 적립과 연결 |
| 0166-webhook-credential-root-separation | 웹훅 자격증명 루트 분리 | #1264(웹훅 Rust 이식) 이후 재평가 |

동반 회수: `../2026-08-11-checkpoint-a-adr-decision-sheet.md`·`../2026-08-11-merge-floor-wave1-issue-drafts.md`·`../2026-08-11-server-safety-release-work-plan.md`
