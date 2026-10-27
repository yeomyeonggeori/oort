import type { TriggerChipTone } from "@momo/core/features/agents/triggerChip";

// =============================================================================
// 트리거 칩의 클래스 상수. 컴포넌트 파일(`TriggerChip.tsx`)과 떼어 둔 것은 순수 상수뿐이기 때문이다(컴포넌트 파일이
// 상수를 함께 내보내면 빠른 새로고침이 그 파일을 통째로 다시 읽는다 — `react-refresh/only-export-components`).
// =============================================================================

/** 톤 → 그릇과 글자. 짝은 `tokens.contrast.test`가 두 스킴에서 재는 것들이다. */
export const TRIGGER_CHIP_TONE_CLASS: Readonly<Record<TriggerChipTone, string>> = {
  muted: "bg-muted-soft text-ink-muted",
  working: "bg-muted-soft text-warn",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
};

/**
 * 칩 한 개의 바탕 클래스. 격자(`inline-grid`)가 겹쳐 놓은 낱말들 중 가장 넓은 것이 폭을 정한다.
 *
 * `self-center`가 높이를 지킨다: 머리 줄은 `items-baseline`이고, 칩의 기준선은 안에 아이콘이 있느냐에
 * 따라 갈린다(아이콘이 먼저면 아이콘 바닥이 기준선이다). 기준선 정렬로 두면 글자만 있는 칩(받음·가져감·
 * 승인 대기)은 줄을 1px, 점이 붙은 칩(작업 중)은 2px 키웠다 — 실제 엔진에서 잰 값이다. 가운데 정렬은
 * 칩 높이(18)가 줄(22) 안에 들어가는 한 낱말과 무관하게 줄 높이를 건드리지 않는다.
 */
export const TRIGGER_CHIP_CLASS = "inline-grid items-center self-center";
