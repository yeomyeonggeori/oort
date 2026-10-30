import { describe, expect, it } from "vitest";
import type { AgentApprovalCard } from "./agentCardModel";
import { requestBundleModel, type RequestBundleContext } from "./requestBundle";
import {
  createDecisionStage, decisionStageModel, moveDecisionStage,
  nextPendingDecisionStage, decisionStageDragAction,
} from "./decisionStage";

const context: RequestBundleContext = {
  nowMs: 1000, viewerKind: "human", viewerMemberId: "reviewer", canDecide: true,
};
function card(id: string, patch: Partial<AgentApprovalCard> = {}, facts = context) {
  const approval: AgentApprovalCard = {
    kind: "approval", approvalId: id, title: "채널 안내 고정", status: "pending",
    isResumeOffer: false, execution: null, action: null, detail: { rows: [], withheld: 0 },
    requestedByMemberId: "agent", ...patch,
  };
  return { id, bundle: requestBundleModel(approval, facts) };
}

describe("decision stage selection", () => {
  it("keeps the opened order, shares the exact bundle, and ignores new arrivals", () => {
    const cards = [card("a"), card("b")];
    const selection = createDecisionStage([...cards, cards[0]], "b");
    const view = decisionStageModel(selection, [card("new"), ...[...cards].reverse()]);
    expect(selection.cardIds).toEqual(["a", "b"]);
    expect(view.cards.map((item) => item.id)).toEqual(["a", "b"]);
    expect(view.current?.bundle).toBe(cards[1].bundle);
    expect(view.positionLabel).toBe("2건 중 2번");
    expect(createDecisionStage(cards, "missing").selectedId).toBe("a");
  });

  it("clamps manual navigation, and advances to pending cards with one wrap", () => {
    const cards = [card("a"), card("b", { status: "approved" }), card("c")];
    const first = createDecisionStage(cards);
    expect(moveDecisionStage(first, cards, "previous")).toBe(first);
    const second = moveDecisionStage(first, cards, "next");
    expect(second.selectedId).toBe("b");
    expect(nextPendingDecisionStage(first, cards).selectedId).toBe("c");
    const last = { ...first, selectedId: "c" };
    expect(moveDecisionStage(last, cards, "next")).toBe(last);
    expect(nextPendingDecisionStage(last, cards).selectedId).toBe("a");
    expect(first.selectedId).toBe("a");
  });

  it("uses bundle approval facts for completion, including expiry and approved execution", () => {
    const pending = card("a", { expiresAtMs: 2000 });
    const approved = card("b", { status: "approved", bundle: { actionType: "tool_call" } });
    const selection = createDecisionStage([pending, approved]);
    expect(approved.bundle.state).toBe("executing");
    expect(decisionStageModel(selection, [pending, approved]).allProcessed).toBe(false);
    const expired = card("a", { expiresAtMs: 2000 }, { ...context, nowMs: 2000 });
    const completed = decisionStageModel(selection, [expired, approved]);
    expect(completed.allProcessed).toBe(true);
    expect(completed.pendingIds).toEqual([]);
    // Silence is not a recorded decision, and a vanished snapshot is not completion.
    const silent = card("a", {}, { ...context, run: { phase: "timed_out" } });
    expect(decisionStageModel(selection, [silent, approved]).allProcessed).toBe(false);
    expect(decisionStageModel(selection, [approved]).allProcessed).toBe(false);
    const thinking = card("a", { bundle: { status: "thinking" } });
    expect(decisionStageModel(selection, [thinking, approved]).allProcessed).toBe(false);
  });

  it("does not count absent permissions or an empty list as processed decisions", () => {
    const waiting = card("a", {}, { ...context, canDecide: false });
    expect(waiting.bundle.canDecide).toBe(false);
    const model = decisionStageModel(createDecisionStage([waiting]), [waiting]);
    expect(model.pendingIds).toEqual(["a"]);
    expect(model.allProcessed).toBe(false);
    expect(decisionStageModel(createDecisionStage([]), [])).toMatchObject({
      current: null, index: -1, positionLabel: "0건", allProcessed: false,
    });
  });
});

describe("decision stage drag safety", () => {
  it.each([
    [{ x: 0, y: 100 }, "close"],
    [{ x: 0, y: -100 }, "close"],
    [{ x: 0, y: 99 }, "restore"],
    [{ x: 0, y: 20, velocityY: 0.8 }, "close"],
    [{ x: 0, y: 20, velocityY: -0.8 }, "restore"],
    [{ x: 0, y: 8, velocityY: 2 }, "restore"],
    [{ x: -60, y: 4 }, "next"],
    [{ x: 60, y: 4 }, "previous"],
    [{ x: -20, y: 4, velocityX: -0.8 }, "next"],
    [{ x: -59, y: 4 }, "restore"],
    [{ x: -120, y: 150 }, "close"],
    [{ x: 120, y: 120 }, "restore"],
    [{ x: NaN, y: 200 }, "restore"],
    [{ x: 200, y: 0, velocityX: Infinity }, "restore"],
  ] as const)("maps %o only to navigation, close or restoration", (gesture, expected) => {
    expect(decisionStageDragAction(gesture)).toBe(expected);
  });
});
