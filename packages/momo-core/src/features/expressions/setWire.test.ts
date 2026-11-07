import { describe, expect, it } from "vitest";
import { matchesExpressionContract } from "./contracts";
import { createExpressionFixtureServer } from "./fixtureServer";
import { FIXTURE_NOW_MS, FIXTURE_WORKSPACE_ID } from "./fixtures";
import { EXPRESSION_SET_ACTION_ID, expressionSetChoices, type ExpressionSetApproval } from "./set";
import {
  FIXTURE_SET_APPROVAL_ID, FIXTURE_SET_CARDS, FIXTURE_SET_NORMAL, FIXTURE_SET_PLAN_CARD, FIXTURE_SET_REFUSED, fixtureSetBytesHeavy, fixtureSetOverLimit, fixtureSetPlanCard, fixtureSetReadySlot,
} from "./setFixtures";
import {
  EXPRESSION_SET_DECISION_FAILURES, EXPRESSION_SET_PLAN_ACTION_ID, expressionDecisionRequest, expressionSetDecisionFailure, expressionSetFromProps, expressionSetPlanFromProps,
  expressionSetOfMessage, expressionSetPlanOfMessage, expressionSetResultFromProps, expressionSetResultFromReceipt, expressionSetResultOfMessage,
} from "./setWire";

const base = `/v1/workspaces/${FIXTURE_WORKSPACE_ID}`;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const setProps = (expressionSet: unknown, id: string = EXPRESSION_SET_ACTION_ID) => ({ action: { id, expressionSet } });
const planProps = (expressionSetPlan: unknown, id: string = EXPRESSION_SET_PLAN_ACTION_ID) => ({ action: { id, expressionSetPlan } });

describe("ADR-0218 §12 the set card as the clients read it off a message (#5462)", () => {
  it("reads a set card from props.action.expressionSet and nothing else", () => {
    expect(expressionSetFromProps(setProps(FIXTURE_SET_NORMAL))).toEqual(FIXTURE_SET_NORMAL);
    expect(expressionSetFromProps(setProps(FIXTURE_SET_REFUSED))).toEqual(FIXTURE_SET_REFUSED);
    // Another action id is another card: a set payload under it is not read as a set.
    expect(expressionSetFromProps(setProps(FIXTURE_SET_NORMAL, "expression.create"))).toBeNull();
    expect(expressionSetFromProps({ action: { id: EXPRESSION_SET_ACTION_ID, expression: FIXTURE_SET_NORMAL } })).toBeNull();
    for (const bad of [null, undefined, 7, "x", [], {}, { action: null }, { action: [] }]) expect(expressionSetFromProps(bad)).toBeNull();
  });

  it("does not read a set past the limits: 41 slots fail the schema, a heavy 17-GIF set passes the schema and fails the budget rule", () => {
    expect(matchesExpressionContract("SetApproval", fixtureSetOverLimit())).toBe(false);
    expect(expressionSetFromProps(setProps(fixtureSetOverLimit()))).toBeNull();
    const heavy = fixtureSetBytesHeavy();
    // The schema alone lets this one through; only the whole-set sum refuses it (so the second check is what keeps it off the screen).
    expect(matchesExpressionContract("SetApproval", heavy)).toBe(true);
    expect(expressionSetFromProps(setProps(heavy))).toBeNull();
  });

  it("does not read a set whose names collide or whose kind contradicts its picture", () => {
    const twice = copy(FIXTURE_SET_NORMAL);
    twice.slots[1] = { ...twice.slots[1], name: twice.slots[0].name };
    expect(matchesExpressionContract("SetApproval", twice)).toBe(true);
    expect(expressionSetFromProps(setProps(twice))).toBeNull();
    // A slot that says GIF while its pictures are PNG: well formed for the schema, refused by the kind-and-file rule.
    const liar: ExpressionSetApproval = { ...copy(FIXTURE_SET_NORMAL), slots: [{ ...fixtureSetReadySlot(0, "still", "cat_hello", "안녕"), kind: "gif" }] };
    expect(matchesExpressionContract("SetApproval", liar)).toBe(true);
    expect(expressionSetFromProps(setProps(liar))).toBeNull();
  });

  it("reads the plan card from props.action.expressionSetPlan, and not a plan whose GIF has no still to move", () => {
    expect(expressionSetPlanFromProps(planProps(FIXTURE_SET_PLAN_CARD))).toEqual(FIXTURE_SET_PLAN_CARD);
    expect(expressionSetPlanFromProps(planProps(FIXTURE_SET_PLAN_CARD, EXPRESSION_SET_ACTION_ID))).toBeNull();
    expect(expressionSetPlanFromProps(setProps(FIXTURE_SET_PLAN_CARD))).toBeNull();
    const broken = fixtureSetPlanCard({ slots: fixtureSetPlanCard().slots.filter((slot) => slot.index !== 0) });
    // The schema is satisfied (every field is well formed); only the rule "a GIF moves a still that is in the plan" refuses it.
    expect(matchesExpressionContract("SetPlanCard", broken)).toBe(true);
    expect(expressionSetPlanFromProps(planProps(broken))).toBeNull();
  });

  it("reads the result of a settled card only when the card says it was executed", () => {
    const result = { setId: FIXTURE_SET_NORMAL.setId, registered: [], skipped: [] };
    expect(expressionSetResultFromProps({ result: { status: "executed", expressionSet: result } })).toEqual(result);
    expect(expressionSetResultFromProps({ result: { status: "rejected", expressionSet: result } })).toBeNull();
    expect(expressionSetResultFromProps({ result: { status: "executed", expressionSet: { setId: "x" } } })).toBeNull();
    expect(expressionSetResultFromProps({ result: { status: "executed", expression: result } })).toBeNull();
    expect(expressionSetResultFromProps(undefined)).toBeNull();
  });

  it("names the three closed refusal codes of a spent-nothing decision and no other word", () => {
    for (const code of EXPRESSION_SET_DECISION_FAILURES) expect(expressionSetDecisionFailure({ status: code })).toBe(code);
    expect(EXPRESSION_SET_DECISION_FAILURES).toHaveLength(3);
    for (const other of ["approved", "role_required", "pending", "", 3, null, undefined]) expect(expressionSetDecisionFailure({ status: other })).toBeNull();
    expect(expressionSetDecisionFailure(null)).toBeNull();
    // The word is read from the receipt's own status, not from an error envelope.
    expect(expressionSetDecisionFailure({ error: { code: "expression_quota" } })).toBeNull();
  });
});

describe("the decision request (an existing route; the sets add fields, not paths)", () => {
  it("is the one POST …/approvals/{id}/decision, and the identity keys cannot be overridden by the fields", () => {
    const request = expressionDecisionRequest(base, FIXTURE_SET_APPROVAL_ID, "key-1", { approve: true, expressionChoices: [] });
    expect(request).toEqual({
      method: "POST", path: `${base}/approvals/${FIXTURE_SET_APPROVAL_ID}/decision`,
      body: { approve: true, expressionChoices: [], approval_id: FIXTURE_SET_APPROVAL_ID, client_decision_id: "key-1" },
    });
    const sneaky = expressionDecisionRequest(base, FIXTURE_SET_APPROVAL_ID, "key-1", { approval_id: "other", client_decision_id: "other", approve: false });
    expect(sneaky.body).toEqual({ approve: false, approval_id: FIXTURE_SET_APPROVAL_ID, client_decision_id: "key-1" });
  });

  it("makes the fake server register what was kept and read its result back from the receipt", () => {
    const server = createExpressionFixtureServer({ nowMs: FIXTURE_NOW_MS, sets: FIXTURE_SET_CARDS });
    const choices = expressionSetChoices(FIXTURE_SET_NORMAL, FIXTURE_NOW_MS, { only: [0, 1, 2] });
    expect(choices).toHaveLength(3);
    const request = expressionDecisionRequest(base, FIXTURE_SET_APPROVAL_ID, "00000000-0000-4000-8000-0000000007b1", { approve: true, expressionChoices: choices });
    const response = server.request(request);
    expect(response.status).toBe(200);
    const result = expressionSetResultFromReceipt(response.json);
    expect(result?.registered.map((item) => item.name)).toEqual(["cat_hello", "cat_thanks", "cat_sorry"]);
    expect(result?.skipped).toEqual([]);
    expect(expressionSetResultFromReceipt({ result: null })).toBeNull();
    expect(expressionSetResultFromReceipt(undefined)).toBeNull();
  });
});

describe("the same readers on a whole message (S4 phone, #5463)", () => {
  it("reads a message exactly as its props are read, and a message without props is no card", () => {
    const executed = { status: "executed", expressionSet: { setId: FIXTURE_SET_NORMAL.setId, registered: [], skipped: [] } };
    expect(expressionSetOfMessage({ props: setProps(FIXTURE_SET_NORMAL) })).toEqual(FIXTURE_SET_NORMAL);
    expect(expressionSetPlanOfMessage({ props: planProps(FIXTURE_SET_PLAN_CARD) })).toEqual(FIXTURE_SET_PLAN_CARD);
    expect(expressionSetResultOfMessage({ props: { result: executed } })).toEqual(expressionSetResultFromProps({ result: executed }));
    // The id is what picks the card: a plan under the set's id (and the other way round) is not read.
    expect(expressionSetOfMessage({ props: planProps(FIXTURE_SET_PLAN_CARD) })).toBeNull();
    expect(expressionSetPlanOfMessage({ props: setProps(FIXTURE_SET_NORMAL) })).toBeNull();
    expect(expressionSetOfMessage({})).toBeNull();
    expect(expressionSetPlanOfMessage({})).toBeNull();
    expect(expressionSetResultOfMessage({})).toBeNull();
  });
});
