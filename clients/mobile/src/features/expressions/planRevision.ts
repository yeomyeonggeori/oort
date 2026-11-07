import {
  narrowExpressionSetReferences,
  type ExpressionSetPlanCard,
} from '@momo/core/features/expressions/set';

// =============================================================================
// (폰 #5463: 웹 `planRevision.ts` 와 **같은 규칙·같은 요청 모양**이다. 코어 파일을 고치지 않는 칸이라 사본으로 두고, 규칙을 코어로 올리는 일은 인계의 후속이다.
//  두 사본이 어긋나지 않는지는 폰 시험 `expressionPlanCard` 가 웹 시험과 같은 입력·같은 기대값으로 잰다.)
//
// 「장면 고치기」 (ADR-0218 §12 L2.5): 고치기는 **새 계획**이다. 옛 계획 행은 고치지 않고 닫히고, 서버가 새 계획과 새 카드를 만든다.
// 사람이 줄 수 있는 입력은 셋뿐이다: (가) 장면·표시 이름의 글, (나) 칸 빼기, (다) 참조 그림 빼기. 참조는 **빼기만** 된다: 서버가 고른 묶음의
// 부분집합만 되고, 더할 길은 없다(코어 `narrowExpressionSetReferences`가 모르는 id 하나에도 편집 전체를 거절한다).
//
// **[추정]** 이 요청의 와이어(결정 요청의 새 필드 모양)는 서버 칸 S5a가 `docs/api/openapi.yaml`과 함께 고정한다(ADR L2.5, L23). 아래 `planRevision`
// 필드는 그 전까지의 이 화면의 가정이고, 서버가 다른 모양을 고정하면 이 파일 한 곳만 바뀐다. 요청은 거절(`approve: false`)에 실린다: 필드를 모르는
// 서버는 계획을 닫기만 하므로 아무것도 만들어지지 않는 쪽으로 실패한다.
// =============================================================================

export interface PlanEdit {
  /** 빼기로 고른 칸. */
  dropped: ReadonlySet<number>;
  /** 고친 표시 이름·장면 글(칸 번호별). 고치지 않은 칸은 없다. */
  names: Readonly<Record<number, string>>;
  scenes: Readonly<Record<number, string>>;
  /** 빼기로 고른 참조 그림의 첨부 id. */
  removedReferences: readonly string[];
}

export const emptyPlanEdit = (): PlanEdit => ({ dropped: new Set(), names: {}, scenes: {}, removedReferences: [] });

/** 장면 글이 있는 칸은 정지, 없는 칸은 GIF다(계획 스키마가 같은 말을 한다: `scene`은 정지에만 있다). */
const isStill = (slot: ExpressionSetPlanCard["slots"][number]) => slot.scene !== null;

/** 이 칸이 새 계획에 남는가: 빼지 않았고, GIF라면 움직일 정지 칸도 남아 있다. */
export function planSlotKept(plan: ExpressionSetPlanCard, edit: PlanEdit, index: number): boolean {
  const slot = plan.slots.find((entry) => entry.index === index);
  if (!slot || edit.dropped.has(index)) return false;
  return isStill(slot) || (slot.baseIndex !== null && planSlotKept(plan, edit, slot.baseIndex));
}

const nameOf = (slot: ExpressionSetPlanCard["slots"][number], edit: PlanEdit) => edit.names[slot.index] ?? slot.displayName;
const sceneOf = (slot: ExpressionSetPlanCard["slots"][number], edit: PlanEdit) => edit.scenes[slot.index] ?? slot.scene ?? "";

/**
 * 이 편집으로 새 계획을 요청할 수 있는가: 칸이 하나 이상 남고, 남은 칸의 표시 이름이 비지 않고, 남은 정지 칸의 장면이 비지 않고,
 * 뺀 참조가 모두 서버가 준 묶음 안에 있다. 하나라도 어긋나면 요청하지 않는다(서버가 같은 이유로 편집 전체를 거절한다).
 */
export function planEditValid(plan: ExpressionSetPlanCard, edit: PlanEdit): boolean {
  const kept = plan.slots.filter((slot) => planSlotKept(plan, edit, slot.index));
  return kept.length > 0
    && kept.every((slot) => nameOf(slot, edit).trim() !== "" && (!isStill(slot) || sceneOf(slot, edit).trim() !== ""))
    && narrowExpressionSetReferences(plan.references, edit.removedReferences).ok;
}

/**
 * 결정 요청에 더하는 필드. 바뀐 것만 싣는다: 뺀 칸(움직일 정지 칸이 빠진 GIF 포함), 고친 표시 이름과 장면 글, 뺀 참조.
 * 요청자가 쓴 글은 서버가 같은 거름과 상한을 다시 지나게 한다(L2.4-2): 이 화면의 `trim`은 편의이고 판정이 아니다.
 */
export function planRevisionFields(plan: ExpressionSetPlanCard, edit: PlanEdit): Record<string, unknown> {
  const kept = plan.slots.filter((slot) => planSlotKept(plan, edit, slot.index));
  const edits = kept.flatMap((slot) => {
    const displayName = nameOf(slot, edit).trim();
    const scene = sceneOf(slot, edit).trim();
    const change = {
      ...(displayName !== slot.displayName ? { displayName } : {}),
      ...(isStill(slot) && scene !== slot.scene ? { scene } : {}),
    };
    return Object.keys(change).length > 0 ? [{ index: slot.index, ...change }] : [];
  });
  return {
    approve: false,
    planRevision: {
      setId: plan.setId,
      removeSlots: plan.slots.filter((slot) => !planSlotKept(plan, edit, slot.index)).map((slot) => slot.index),
      removeReferences: [...edit.removedReferences],
      edits,
    },
  };
}
