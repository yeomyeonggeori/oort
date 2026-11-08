import { describe, expect, it } from "vitest";
import { FIXTURE_SET_PLAN_CARD, FIXTURE_SET_REFERENCE_IDS } from "@momo/core/features/expressions/setFixtures";
import { emptyPlanEdit, planEditValid, planRevisionFields, planSlotKept, type PlanEdit } from "./planRevision";

const plan = FIXTURE_SET_PLAN_CARD;
const edit = (over: Partial<PlanEdit> = {}): PlanEdit => ({ ...emptyPlanEdit(), ...over });

describe("the editing of a plan is a new plan: what may be taken out and changed (ADR-0218 L2.5)", () => {
  it("keeps everything of an untouched plan and asks for nothing to change", () => {
    expect(plan.slots.every((slot) => planSlotKept(plan, edit(), slot.index))).toBe(true);
    expect(planEditValid(plan, edit())).toBe(true);
    expect(planRevisionFields(plan, edit())).toEqual({ approve: false, planRevision: { setId: plan.setId, removeSlots: [], removeReferences: [], edits: [] } });
  });

  it("takes a GIF out with the still it moves, and only then", () => {
    expect(planSlotKept(plan, edit({ dropped: new Set([0]) }), 0)).toBe(false);
    // GIF 8 moves still 0, GIF 9 moves still 5.
    expect(planSlotKept(plan, edit({ dropped: new Set([0]) }), 8)).toBe(false);
    expect(planSlotKept(plan, edit({ dropped: new Set([0]) }), 9)).toBe(true);
    expect(planSlotKept(plan, edit({ dropped: new Set([8]) }), 0)).toBe(true);
    expect(planRevisionFields(plan, edit({ dropped: new Set([0, 5]) }))).toMatchObject({ planRevision: { removeSlots: [0, 5, 8, 9] } });
  });

  it("lists only what changed, trimmed, for the scenes that remain", () => {
    const fields = planRevisionFields(plan, edit({ names: { 1: "고마워요", 2: plan.slots[2].displayName }, scenes: { 3: ` ${plan.slots[3].scene} `, 4: "시계를 보는 고양이" } }));
    expect(fields).toMatchObject({ planRevision: { edits: [{ index: 1, displayName: "고마워요" }, { index: 4, scene: "시계를 보는 고양이" }] } });
    // A scene typed for a slot that was taken out is not sent: there is nothing left to say it about.
    const gone = planRevisionFields(plan, edit({ dropped: new Set([4]), scenes: { 4: "보내지 않는 글" } })) as { planRevision: { edits: unknown[] } };
    expect(gone.planRevision.edits).toEqual([]);
  });

  it("refuses an edit that leaves nothing, a blank name, a blank scene, or a picture the server never chose", () => {
    expect(planEditValid(plan, edit({ dropped: new Set(plan.slots.map((slot) => slot.index)) }))).toBe(false);
    expect(planEditValid(plan, edit({ names: { 1: "  " } }))).toBe(false);
    expect(planEditValid(plan, edit({ scenes: { 1: "" } }))).toBe(false);
    // A blank scene of a slot that is going anyway does not matter.
    expect(planEditValid(plan, edit({ dropped: new Set([1]), scenes: { 1: "" } }))).toBe(true);
    expect(planEditValid(plan, edit({ removedReferences: [FIXTURE_SET_REFERENCE_IDS[0]] }))).toBe(true);
    // References can only be taken out of the server's bundle: an id it does not hold refuses the whole edit.
    expect(planEditValid(plan, edit({ removedReferences: ["00000000-0000-4000-8000-0000000004ff"] }))).toBe(false);
  });
});
