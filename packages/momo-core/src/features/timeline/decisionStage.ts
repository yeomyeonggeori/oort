import type { RequestBundleModel } from "./requestBundle";

/** 무대는 묶음의 승인 상태를 빌려 읽고, 선택과 열린 순서만 소유해요. */
export interface DecisionStageCard {
  id: string;
  bundle: RequestBundleModel;
}

export interface DecisionStageSelection {
  readonly cardIds: readonly string[];
  readonly selectedId: string | null;
}

export interface DecisionStageModel {
  cards: readonly DecisionStageCard[];
  current: DecisionStageCard | null;
  index: number;
  positionLabel: string;
  pendingIds: readonly string[];
  allProcessed: boolean;
}

export function createDecisionStage(
  cards: readonly DecisionStageCard[],
  selectedId?: string | null
): DecisionStageSelection {
  const cardIds = [...new Set(cards.map((card) => card.id))];
  return {
    cardIds,
    selectedId:
      selectedId && cardIds.includes(selectedId) ? selectedId : cardIds[0] ?? null,
  };
}

/** 서버 갱신은 목록을 늘리거나 순서를 흔들지 않아요. 사라진 카드는 완료로 추측하지 않아요. */
export function decisionStageModel(
  selection: DecisionStageSelection,
  latest: readonly DecisionStageCard[]
): DecisionStageModel {
  const byId = new Map(latest.map((card) => [card.id, card]));
  const cards = selection.cardIds.flatMap((id) => {
    const card = byId.get(id);
    return card ? [card] : [];
  });
  const selected = cards.findIndex((card) => card.id === selection.selectedId);
  const index = selected >= 0 ? selected : cards.length > 0 ? 0 : -1;
  const pendingIds = cards
    .filter((card) => card.bundle.state === "approval")
    .map((card) => card.id);
  return {
    cards,
    current: cards[index] ?? null,
    index,
    positionLabel: cards.length > 0 ? `${cards.length}건 중 ${index + 1}번` : "0건",
    pendingIds,
    allProcessed:
      cards.length > 0 &&
      cards.length === selection.cardIds.length &&
      cards.every((card) =>
        ["executing", "done", "declined", "expired", "failed", "cancelled"].includes(
          card.bundle.state
        )
      ),
  };
}

/** 화살표·썸네일·가로 끌기는 선택만 바꿔요. 끝에서 반대 끝으로 뛰지 않아요. */
export function moveDecisionStage(
  selection: DecisionStageSelection,
  latest: readonly DecisionStageCard[],
  direction: "next" | "previous"
): DecisionStageSelection {
  const model = decisionStageModel(selection, latest);
  const next = model.cards[model.index + (direction === "next" ? 1 : -1)];
  return next ? { ...selection, selectedId: next.id } : selection;
}

/** 결정 영수증을 읽은 뒤에만 호출해요. 다음 미처리 장을 찾아 한 번만 순환해요. */
export function nextPendingDecisionStage(
  selection: DecisionStageSelection,
  latest: readonly DecisionStageCard[]
): DecisionStageSelection {
  const model = decisionStageModel(selection, latest);
  for (let step = 1; step <= model.cards.length; step += 1) {
    const next = model.cards[(model.index + step) % model.cards.length];
    if (next.bundle.state === "approval") {
      return { ...selection, selectedId: next.id };
    }
  }
  return selection;
}

export type DecisionStageDragAction = "next" | "previous" | "close" | "restore";

/** 속도는 마지막 움직임의 px/ms예요. 끌기는 결정 명령을 만들 수 없어요. */
export function decisionStageDragAction({
  x,
  y,
  velocityX = 0,
  velocityY = 0,
}: {
  x: number;
  y: number;
  velocityX?: number;
  velocityY?: number;
}): DecisionStageDragAction {
  if (![x, y, velocityX, velocityY].every(Number.isFinite)) return "restore";
  const horizontal = Math.abs(x);
  const vertical = Math.abs(y);
  if (vertical > horizontal) {
    return vertical >= 100 ||
      (vertical >= 12 && Math.abs(velocityY) >= 0.65 && y * velocityY > 0)
      ? "close"
      : "restore";
  }
  if (horizontal > vertical &&
    (horizontal >= 60 ||
      (horizontal >= 12 && Math.abs(velocityX) >= 0.65 && x * velocityX > 0))) {
    return x < 0 ? "next" : "previous";
  }
  return "restore";
}
