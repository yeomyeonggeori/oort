---
name: momo-planning
description: oort 이슈 편성, 워커 인계 또는 세션 간 진행 복원에 사용한다.
---

# oort 기획·인계

공용 계약은 [AGENTS.md](../../../AGENTS.md)다. 필요에 맞는 문서만 읽는다.

- 시작·재개: `scripts/planning_context.sh` → 현재 작업·owner·다음 행동.
- 이슈 분해·진행 보고·체크포인트: [기획 운영](../../../docs/planning/README.md).
- 워커 발사·모델 선택: [PIPELINE](../../../docs/planning/PIPELINE.md)과 필요한 [실행 어댑터](../../../docs/planning/worker-adapters.md).
- 복잡한 인계: [HANDOFF_TEMPLATE](../../../docs/planning/HANDOFF_TEMPLATE.md). 작은 수정은 이슈의 수용기준으로 충분하다.
- 트랙 통합: [MULTI_SESSION_OPS](../../../docs/MULTI_SESSION_OPS.md). 제품 경계 결정은 관련 ADR.

판단·결과·다음 행동은 공용 기록에 남긴다. 이 스킬에 별도 작업 상태나 운영 규칙 사본을 만들지 않는다.
