# 핸드오프: 워크스페이스 사용량 요약 REST 계약 (MOMO-615 엔진 ↔ MOMO-616 웹)

- 근거: 에이전트 경험 프로그램 AX-7 1층 (성재 승인 2026-07-25). `usage_ledger`는 workspace_id 축+`usage_ledger_ws_time_idx` 인덱스 완비 — 노출만 부재.
- 두 티켓이 이 계약을 공유한다. 필드명 세부는 엔진이 기존 DTO 컨벤션에 맞춰 다듬을 수 있으나 **형태 변경 시 이 파일을 같이 갱신**하고 웹 티켓에 알린다.

## 계약 v1

```
GET /v1/workspaces/:ws/usage/summary?from=<ISO8601>&to=<ISO8601>&bucket=day|week|month
```

- 인증: 기존 워크스페이스 멤버십 검증 패턴(사용자 전원 조회 가능 — 성재 지시 "워크스페이스에서 발생하는 과금은 사용자가 전부 트래킹"). RLS FORCE 하 기존 쿼리 관례.
- 기본값: from=to-30d, bucket=day. 최대 범위 93일(초과 400).

```jsonc
200 {
  "range": { "from": "...", "to": "...", "bucket": "day" },
  "totals": {
    "costMicroUsd": 123456,          // was_estimated 포함 합계
    "estimatedMicroUsd": 2345,        // was_estimated=true 부분합 (신뢰도 분리 표시용)
    "promptTokens": 0, "completionTokens": 0
  },
  "buckets": [ { "start": "...", "costMicroUsd": 0, "promptTokens": 0, "completionTokens": 0 } ],
  "byModel": [ { "model": "...", "costMicroUsd": 0, "promptTokens": 0, "completionTokens": 0 } ],
  "byAgent": [ { "agentMemberId": "uuid", "displayName": "...", "costMicroUsd": 0, "promptTokens": 0, "completionTokens": 0 } ],
  "budget": null | {
    "grain": "workspace|agent|channel|workspace_agent|agent_channel",
    "limitMicroUsd": 0, "spentMicroUsd": 0, "reservedMicroUsd": 0,
    "state": "normal|soft_limit|hard_limit", "periodStart": "..."
  }
}
```

- budget은 CostProjectionRoutes의 기존 grain 매칭·MIN(limit) 채택 로직 재사용, workspace grain 매칭분(없으면 null).
- 정렬: byModel·byAgent는 costMicroUsd 내림차순. UUID 비교는 항상 소문자.
- 빈 기간 = 200 + 0값(404 아님).

## 검증 의무
- 엔진: 라우트 테스트(멤버십 거부·범위 검증·집계 정확성 — 시드 원장 대비) + verifier 스크립트(`scripts/verify_usage_summary.sh`) docker 실측.
- 웹: 계약 픽스처 기반 구현·테스트. **라이브 통합 검증은 엔진 랜딩 후 오케스트레이터가 momowebqa에서 수행**(웹 티켓 완료 조건에 포함하지 않음).
