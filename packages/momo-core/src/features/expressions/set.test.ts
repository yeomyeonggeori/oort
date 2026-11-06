import { describe, expect, it } from "vitest";
import { assertExpressionContract, EXPRESSION_CONTRACTS, EXPRESSION_SET_CONTRACTS, matchesExpressionContract } from "./contracts";
import { createExpressionFixtureServer } from "./fixtureServer";
import { FIXTURE_MEDIA } from "./fixtureMedia";
import { FIXTURE_EXPRESSIONS, FIXTURE_NOW_MS, FIXTURE_WORKSPACE_ID } from "./fixtures";
import {
  decideExpressionSet, EXPRESSION_SET_ACTION_ID, EXPRESSION_SET_BACKENDS, EXPRESSION_SET_GRAY_CODES, EXPRESSION_SET_LIMITS, EXPRESSION_SET_REFERENCE_ISSUES,
  EXPRESSION_SET_REFERENCE_LIMITS, EXPRESSION_SET_REFUSAL_STREAK, expressionSetBackendEnabled, expressionSetCard, expressionSetChoices, expressionSetGrayCodeOf,
  expressionSetIssues, expressionSetReferenceIssues, expressionSetReferenceLine, expressionSetReferenceNotice, expressionSetReferenceVerdict, expressionSetResultLine,
  expressionSetMayTryNext, expressionSetSlotDraft, expressionSetStoredBytes, expressionSetWithinBudget, parseExpressionSetResult, readySlots, settleExpressionSetGifs, settleExpressionSetStills,
  type ExpressionSetApproval, type ExpressionSetAttempt, type ExpressionSetDecisionReceipt, type ExpressionSetReadySlot, type ExpressionSetReferenceProbe,
  type ExpressionSetSlot, type ExpressionSetStillOutcome,
  expressionSetPlanIssues, expressionSetPlanMayStart, expressionSetPlanStateAt, expressionSetPlanView, expressionSetReferenceNoticeDue, expressionSetReferenceNoticeSeen,
  narrowExpressionSetReferences, type ExpressionSetPlanCard, type ExpressionSetPlanState,
} from "./set";
import { expressionSetGrayLine, expressionSetSkipLine } from "./setCopy";
import {
  FIXTURE_SET_ACTION, FIXTURE_SET_ACTION_RESERVED_BACKEND, FIXTURE_SET_APPROVAL_ID, FIXTURE_SET_CARDS, FIXTURE_SET_NORMAL, FIXTURE_SET_REFERENCE_IDS,
  FIXTURE_SET_REFERENCE_PROBES, FIXTURE_SET_REFERENCE_PROBES_BAD_FORMAT, FIXTURE_SET_REFERENCE_PROBES_TOO_BIG_INPUT,
  FIXTURE_SET_REFUSED, FIXTURE_SET_REFUSED_APPROVAL_ID, FIXTURE_SET_REFUSED_ATTEMPTS, FIXTURE_SET_REFUSED_GIF_BASES, FIXTURE_SET_SAME_NAME,
  FIXTURE_SET_SAME_NAME_APPROVAL_ID, FIXTURE_SET_STREAK_ATTEMPTS, FIXTURE_SET_STREAK_CLOSED, FIXTURE_SET_STREAK_GIF_BASES, fixtureSetBytesHeavy,
  fixtureSetDraftId, fixtureSetGraySlot, fixtureSetOverLimit, fixtureSetReadySlot, fixtureSetReferenceProbesOverBytes, fixtureSetReferenceProbesTooMany,
  FIXTURE_SET_PLAN_CARD, FIXTURE_SET_PLAN_CARD_ONE, FIXTURE_SET_PLAN_CARD_SEEN, FIXTURE_SET_PLAN_CARD_WORDS, fixtureSetPlanCard,
} from "./setFixtures";
import type { ExpressionChoice, ExpressionMutation } from "./types";
import vectorFile from "./set.vectors.json";

const base = `/v1/workspaces/${FIXTURE_WORKSPACE_ID}`;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const ids = (n: number) => Array.from({ length: n }, (_, i) => i);
const decisionPath = (approvalId: string) => `${base}/approvals/${approvalId}/decision`;
const approve = (approvalId: string, choices: ExpressionChoice[] | null, clientDecisionId = "00000000-0000-4000-8000-0000000007a1") => ({
  method: "POST" as const, path: decisionPath(approvalId),
  body: { approval_id: approvalId, approve: true, client_decision_id: clientDecisionId, expressionChoices: choices },
});
const receiptOf = (response: { json?: unknown }) => response.json as ExpressionSetDecisionReceipt;

describe("ADR-0218 §12 set wire schema (set.schema.json)", () => {
  it("accepts the four cards, the proposal the team AI sends, a decision and a result", () => {
    for (const card of [FIXTURE_SET_NORMAL, FIXTURE_SET_REFUSED, FIXTURE_SET_SAME_NAME]) assertExpressionContract("SetApproval", card);
    assertExpressionContract("SetAction", FIXTURE_SET_ACTION);
    assertExpressionContract("SetDecision", { expressionChoices: expressionSetChoices(FIXTURE_SET_NORMAL, FIXTURE_NOW_MS) });
    assertExpressionContract("SetResult", { setId: FIXTURE_SET_NORMAL.setId, registered: [{ id: fixtureSetDraftId(0), name: "cat_hello", token: ":cat_hello:" }], skipped: [{ draftId: fixtureSetDraftId(1), name: "cat_thanks", reason: "name_taken" }] });
    for (const slot of FIXTURE_SET_REFUSED.slots) assertExpressionContract("SetSlot", slot);
  });

  it("holds the ceiling at forty slots exactly: forty pass, a forty-first does not", () => {
    const over = fixtureSetOverLimit();
    expect(over.slots).toHaveLength(41);
    expect(matchesExpressionContract("SetApproval", over)).toBe(false);
    expect(matchesExpressionContract("SetApproval", { ...over, slots: over.slots.slice(0, 40) })).toBe(true);
    const plan = copy(FIXTURE_SET_ACTION);
    plan.args.slots = Array.from({ length: 41 }, (_, i) => ({ index: i % 40, name: `cat_s${i}`, displayName: `장면 ${i}`, tags: [] }));
    expect(matchesExpressionContract("SetAction", plan)).toBe(false);
    plan.args.slots = plan.args.slots.slice(0, 40);
    expect(matchesExpressionContract("SetAction", plan)).toBe(true);
    const choices = expressionSetChoices(FIXTURE_SET_NORMAL, FIXTURE_NOW_MS)!;
    expect(matchesExpressionContract("SetDecision", { expressionChoices: Array.from({ length: 41 }, () => choices[0]) })).toBe(false);
    expect(matchesExpressionContract("SetDecision", { expressionChoices: [] })).toBe(false);
  });

  it("gives a grey slot no id, no picture and no way to look ready", () => {
    const gray = FIXTURE_SET_REFUSED.slots[2];
    expect(gray.state).toBe("gray");
    for (const extra of [{ draftId: fixtureSetDraftId(2) }, { revision: "1" }, { media: FIXTURE_SET_NORMAL.slots[0] && (FIXTURE_SET_NORMAL.slots[0] as ExpressionSetReadySlot).media }]) {
      expect(matchesExpressionContract("SetSlot", { ...gray, ...extra }), JSON.stringify(Object.keys(extra))).toBe(false);
    }
    expect(matchesExpressionContract("SetSlot", { ...gray, code: "manual_upload_required" })).toBe(false);
    expect(matchesExpressionContract("SetSlot", { ...gray, code: "source_blocked" })).toBe(false);
    expect(matchesExpressionContract("SetSlot", { ...gray, state: "ready" })).toBe(false);
    expect(matchesExpressionContract("SetSlot", { ...FIXTURE_SET_NORMAL.slots[0], code: "refused" })).toBe(false);
    expect(matchesExpressionContract("SetSlot", { ...FIXTURE_SET_NORMAL.slots[0], state: "gray" })).toBe(false);
    for (const code of EXPRESSION_SET_GRAY_CODES) assertExpressionContract("SetSlot", { ...gray, code });
  });

  it("carries no picture bytes in the proposal and nothing the server must decide", () => {
    for (const bad of [
      { ...FIXTURE_SET_ACTION.args, dataBase64: "AAAA" },
      { ...FIXTURE_SET_ACTION.args, sourceAttachmentId: FIXTURE_SET_NORMAL.setId },
      { ...FIXTURE_SET_ACTION.args, kind: "emoji" },
      { ...FIXTURE_SET_ACTION.args, tags: ["가", "나", "다", "라"] },
      { ...FIXTURE_SET_ACTION.args, prefix: "Cat" },
      { ...FIXTURE_SET_ACTION.args, prefix: "c" },
      { ...FIXTURE_SET_ACTION.args, prefix: "c".repeat(13) },
      { ...FIXTURE_SET_ACTION.args, slots: [{ ...FIXTURE_SET_ACTION.args.slots[0], image: { source: "url", url: "https://example.org/a.png" } }] },
      { ...FIXTURE_SET_ACTION.args, slots: [{ ...FIXTURE_SET_ACTION.args.slots[0], tags: Array(6).fill("태그").map((t, i) => `${t}${i}`) }] },
    ]) expect(matchesExpressionContract("SetAction", { ...FIXTURE_SET_ACTION, args: bad })).toBe(false);
    const withoutFace: Record<string, unknown> = { ...FIXTURE_SET_ACTION.args };
    delete withoutFace.subjectMemberId;
    expect(matchesExpressionContract("SetAction", { ...FIXTURE_SET_ACTION, args: withoutFace })).toBe(false);
    expect(matchesExpressionContract("SetAction", { ...FIXTURE_SET_ACTION, action: "expression.create" })).toBe(false);
    expect(FIXTURE_SET_ACTION.action).toBe(EXPRESSION_SET_ACTION_ID);
  });

  it("takes only the plural choice list, and keeps the single-choice wire of expression.create exactly as it was", () => {
    const one = expressionSetChoices(FIXTURE_SET_NORMAL, FIXTURE_NOW_MS)![0];
    expect(matchesExpressionContract("SetDecision", { expressionChoice: one })).toBe(false);
    expect(matchesExpressionContract("SetDecision", { expressionChoices: [one], expressionChoice: one })).toBe(false);
    expect(matchesExpressionContract("Decision", { expressionChoices: [one] })).toBe(false);
    expect(matchesExpressionContract("Decision", { expressionChoice: one })).toBe(true);
    const five = { v: 1, candidates: Array(5).fill(FIXTURE_SET_NORMAL.slots[0]) };
    expect(matchesExpressionContract("Approval", five)).toBe(false);
    expect(matchesExpressionContract("SetResult", { setId: FIXTURE_SET_NORMAL.setId, registered: [], skipped: [{ draftId: one.draftId, name: "cat_hello", reason: "stale" }] })).toBe(false);
    expect(matchesExpressionContract("SetResult", { setId: FIXTURE_SET_NORMAL.setId, registered: [], skipped: [], extra: 1 })).toBe(false);
  });

  it("adds only Set* definitions, shares none with the pinned block, and keeps the constants equal to the schema", () => {
    const main = Object.keys(EXPRESSION_CONTRACTS.$defs);
    const added = Object.keys(EXPRESSION_SET_CONTRACTS.$defs);
    expect(added.every((name) => name.startsWith("Set"))).toBe(true);
    expect(added.filter((name) => main.includes(name))).toEqual([]);
    const defs = EXPRESSION_SET_CONTRACTS.$defs as unknown as Record<string, { properties: Record<string, { maxItems?: number }> & { args?: { properties: Record<string, { maxItems?: number }> } } }>;
    expect(defs.SetApproval.properties.slots.maxItems).toBe(EXPRESSION_SET_LIMITS.slots);
    expect((EXPRESSION_SET_CONTRACTS.$defs.SetGrayCode as { enum: string[] }).enum).toEqual([...EXPRESSION_SET_GRAY_CODES]);
    const action = defs.SetAction.properties.args as unknown as { properties: Record<string, { maxItems?: number; maxLength?: number }> };
    expect(action.properties.tags.maxItems).toBe(EXPRESSION_SET_LIMITS.commonTags);
    expect(action.properties.prompt.maxLength).toBe(EXPRESSION_SET_LIMITS.promptChars);
    expect(EXPRESSION_SET_LIMITS.defaultCaptionStills + EXPRESSION_SET_LIMITS.defaultPlainStills).toBe(8);
    expect(EXPRESSION_SET_LIMITS.slotStoredBytes).toBe(1_572_864);
    expect(EXPRESSION_SET_LIMITS.storedBytes).toBeLessThan(EXPRESSION_SET_LIMITS.slots * EXPRESSION_SET_LIMITS.slotStoredBytes);
  });
});

describe("ADR-0218 §12 what JSON Schema cannot say (names, kinds, budget)", () => {
  it("finds nothing wrong with the real cards", () => {
    for (const card of [FIXTURE_SET_NORMAL, FIXTURE_SET_REFUSED, FIXTURE_SET_SAME_NAME]) expect(expressionSetIssues(card)).toEqual([]);
    expect(FIXTURE_SET_NORMAL.slots.filter((slot) => slot.kind === "still")).toHaveLength(8);
    expect(FIXTURE_SET_NORMAL.slots.filter((slot) => slot.kind === "gif")).toHaveLength(2);
  });

  it("names every way a set can break the rules the server enforces", () => {
    const tamper = (change: (set: ExpressionSetApproval) => void) => { const set = copy(FIXTURE_SET_NORMAL); change(set); return expressionSetIssues(set).map((i) => i.issue); };
    expect(tamper((set) => { set.slots[1].name = set.slots[0].name; })).toContain("duplicate_name");
    expect(tamper((set) => { set.slots[1].name = "dog_hello"; })).toContain("prefix_mismatch");
    expect(tamper((set) => { set.slots[1].name = "cat_"; })).toContain("prefix_mismatch");
    expect(tamper((set) => { set.slots[1].name = "Cat_Hello"; })).toContain("name_invalid");
    expect(tamper((set) => { set.slots[1].index = 0; })).toContain("duplicate_index");
    expect(tamper((set) => { (set.slots[1] as ExpressionSetReadySlot).draftId = (set.slots[0] as ExpressionSetReadySlot).draftId; })).toContain("duplicate_draft");
    expect(tamper((set) => { set.slots[0].kind = "gif"; })).toContain("kind_mime_mismatch");
    expect(tamper((set) => { set.slots[8].kind = "still"; })).toContain("kind_mime_mismatch");
    expect(expressionSetIssues(fixtureSetOverLimit()).map((i) => i.issue)).toContain("over_slots");
  });

  it("refuses a set that fits the wire but not the byte budget, and passes the real ones", () => {
    const heavy = fixtureSetBytesHeavy();
    assertExpressionContract("SetApproval", heavy);
    expect(heavy.slots.length).toBeLessThanOrEqual(EXPRESSION_SET_LIMITS.slots);
    expect(expressionSetStoredBytes(heavy)).toBe(17 * EXPRESSION_SET_LIMITS.slotStoredBytes);
    expect(expressionSetIssues(heavy).map((i) => i.issue)).toContain("over_bytes");
    expect(expressionSetWithinBudget(heavy)).toBe(false);
    for (const card of [FIXTURE_SET_NORMAL, FIXTURE_SET_REFUSED]) expect(expressionSetWithinBudget(card)).toBe(true);
    // The ceiling is about the sum, not about one slot: sixteen of the same slots are still inside it.
    expect(expressionSetWithinBudget({ ...heavy, slots: heavy.slots.slice(0, 16) })).toBe(true);
  });
});

describe("ADR-0218 §12 the card and what a person can keep", () => {
  it("counts the default set as eight stills and two GIFs, all keepable", () => {
    const view = expressionSetCard(FIXTURE_SET_NORMAL, FIXTURE_NOW_MS);
    expect(view).toMatchObject({ state: "pending", total: 10, ready: 10, gray: 0, canApprove: true, stills: { ready: 8, total: 8 }, gifs: { ready: 2, total: 2 }, summary: "그림 10개" });
    expect(view.slots.every((slot) => slot.selectable && slot.canUpload === false && slot.grayCode === null && slot.line === null)).toBe(true);
  });

  it("shows a grey slot as a grey slot: not keepable, no upload, and a sentence that does not invite a retry", () => {
    const view = expressionSetCard(FIXTURE_SET_REFUSED, FIXTURE_NOW_MS);
    expect(view).toMatchObject({ ready: 5, gray: 5, canApprove: true, summary: "그림 5개 · 만들지 못한 장면 5개", stills: { ready: 4, total: 8 }, gifs: { ready: 1, total: 2 } });
    const gray = view.slots.filter((slot) => slot.grayCode !== null);
    expect(gray.map((slot) => slot.grayCode)).toEqual(["refused", "refused", "failed", "not_made", "base_missing"]);
    expect(gray.every((slot) => !slot.selectable && slot.canUpload === false && slot.draftId === null && !!slot.line)).toBe(true);
    for (const code of EXPRESSION_SET_GRAY_CODES) expect(expressionSetGrayLine(code), code).not.toMatch(/다시|다르게|바꿔|올려|시도|재/);
    expect(new Set(EXPRESSION_SET_GRAY_CODES.map(expressionSetGrayLine)).size).toBe(4);
    expect(expressionSetGrayLine("something_new")).toBe(expressionSetGrayLine("failed"));
  });

  it("closes when the card is settled or expired, and when nothing in it can be kept", () => {
    expect(expressionSetCard(FIXTURE_SET_NORMAL, FIXTURE_NOW_MS, false)).toMatchObject({ state: "settled", canApprove: false });
    const expired = expressionSetCard(FIXTURE_SET_NORMAL, FIXTURE_SET_NORMAL.expiresAtMs);
    expect(expired).toMatchObject({ state: "expired", canApprove: false });
    expect(expired.slots.some((slot) => slot.selectable)).toBe(false);
    expect(expressionSetChoices(FIXTURE_SET_NORMAL, FIXTURE_SET_NORMAL.expiresAtMs)).toBeNull();
    const none = { ...FIXTURE_SET_REFUSED, slots: FIXTURE_SET_REFUSED.slots.filter((slot) => slot.state === "gray") };
    expect(expressionSetCard(none, FIXTURE_NOW_MS).canApprove).toBe(false);
    expect(expressionSetChoices(none, FIXTURE_NOW_MS)).toBeNull();
  });

  it("builds choices only for ready slots, in slot order, with the pin the person saw", () => {
    const all = expressionSetChoices(FIXTURE_SET_REFUSED, FIXTURE_NOW_MS)!;
    expect(all.map((c) => c.draftId)).toEqual([0, 1, 5, 6, 9].map(fixtureSetDraftId));
    // Stills pin the PNG the card showed, the GIF slot pins its GIF; every choice is revision 1 of its own draft.
    expect(all.map((c) => c.sha256)).toEqual([0, 1, 5, 6, 9].map((i) => (i === 9 ? FIXTURE_MEDIA.gif.image.sha256 : FIXTURE_MEDIA.png.image.sha256)));
    expect(all.every((c) => c.revision === "1")).toBe(true);
    expect(expressionSetChoices(FIXTURE_SET_REFUSED, FIXTURE_NOW_MS, { only: [9, 2, 3, 99, 1] })!.map((c) => c.draftId)).toEqual([1, 9].map(fixtureSetDraftId));
    expect(expressionSetChoices(FIXTURE_SET_REFUSED, FIXTURE_NOW_MS, { only: [2, 3] })).toBeNull();
    expect(expressionSetChoices(FIXTURE_SET_NORMAL, FIXTURE_NOW_MS, { only: [0], kinds: { 0: "sticker" } })).toEqual([
      { draftId: fixtureSetDraftId(0), revision: "1", sha256: FIXTURE_MEDIA.png.image.sha256, kind: "sticker" },
    ]);
  });

  it("puts a slot's draft back together from the card (the shared strings are on the set, once)", () => {
    const slot = readySlots(FIXTURE_SET_NORMAL)[0];
    assertExpressionContract("Draft", expressionSetSlotDraft(FIXTURE_SET_NORMAL, slot));
    // The first reference stands for the bundle (an expression has one pointer, G1); a set made from words alone has none.
    expect(expressionSetSlotDraft(FIXTURE_SET_NORMAL, slot)).toMatchObject({ origin: { kind: "generated", prompt: FIXTURE_SET_NORMAL.prompt, sourceAttachmentId: FIXTURE_SET_REFERENCE_IDS[0] }, subjectMemberId: null });
    const words = readySlots(FIXTURE_SET_SAME_NAME)[0];
    expect(expressionSetSlotDraft(FIXTURE_SET_SAME_NAME, words).origin.sourceAttachmentId).toBeNull();
  });

  it("says what a decision did in one line", () => {
    const registered = [{ id: fixtureSetDraftId(0), name: "cat_hello", token: ":cat_hello:" }];
    expect(expressionSetResultLine({ setId: FIXTURE_SET_NORMAL.setId, registered, skipped: [] })).toBe("1개를 팀 보관함에 저장했어요");
    expect(expressionSetResultLine({ setId: FIXTURE_SET_NORMAL.setId, registered, skipped: [{ draftId: fixtureSetDraftId(1), name: "cat_thanks", reason: "quota" }] })).toBe("1개를 저장하고 1개는 건너뛰었어요");
    expect(expressionSetSkipLine("quota")).not.toBe(expressionSetSkipLine("name_taken"));
    expect(parseExpressionSetResult({ setId: FIXTURE_SET_NORMAL.setId, registered: [], skipped: [] })).not.toBeNull();
    expect(parseExpressionSetResult({ registered: [] })).toBeNull();
  });
});

interface VectorSlot { index: number; name: string; state: "ready" | "gray"; kind: "still" | "gif"; width?: number; height?: number; frames?: number }
interface Vector {
  name: string; slots: VectorSlot[]; choose: number[]; chooseKinds?: Record<string, "emoji" | "sticker">; taken: string[]; live: number; quota?: number; stale?: number[]; expired?: boolean;
  expect: { ok: true; registered: Array<{ name: string; kind: string }>; skipped: Array<{ name: string; reason: string }> } | { ok: false; status: number; code: string };
}
interface VectorPicture { mime: string; bytes: number; width: number; height: number; preparedBytes?: number; duplicateOf?: number }
interface ReferenceVector { name: string; pictures: VectorPicture[]; expect: { ok: true; count: number; bundleBytes: number } | { ok: false; refused: string[] } }
const vectors = vectorFile as unknown as {
  quota: number; cases: Vector[]; referenceLimits: Record<string, unknown>; referenceCases: ReferenceVector[];
  streak: number; mayTryCases: Array<{ name: string; attempts: ExpressionSetAttempt[]; expect: boolean }>; streakCases: Array<{ name: string; stills: number; attempts: ExpressionSetAttempt[]; expect: ExpressionSetStillOutcome[] }>;
  gifCases: Array<{ name: string; stills: ExpressionSetStillOutcome[]; bases: number[]; expect: string[] }>;
  planGateCases: Array<{ name: string; state: ExpressionSetPlanState; expiresAtMs: number; nowMs: number; expect: boolean }>;
  noticeCases: Array<{ name: string; seenAtMs: number | null; references: number; expect: boolean }>;
  narrowCases: Array<{ name: string; current: string[]; remove: string[]; expect: { ok: true; references: string[] } | { ok: false; unknown: string[] } }>;
};

function approvalOf(slots: VectorSlot[], expired: boolean): ExpressionSetApproval {
  const built: ExpressionSetSlot[] = slots.map((s) => {
    if (s.state === "gray") return fixtureSetGraySlot(s.index, s.kind, "refused", s.name, s.name);
    const slot = fixtureSetReadySlot(s.index, s.kind, s.name, s.name);
    const frames = s.frames ?? 1;
    slot.media.large = { ...slot.media.large, width: s.width ?? 1, height: s.height ?? 1, frameCount: frames, mime: frames > 1 ? "image/gif" : "image/png", durationMs: frames > 1 ? 200 : 0 };
    return slot;
  });
  return { ...FIXTURE_SET_NORMAL, expiresAtMs: expired ? FIXTURE_NOW_MS - 1 : FIXTURE_NOW_MS + 3_600_000, slots: built };
}

describe("ADR-0218 §12 L6 the decision rules (shared vectors: set.vectors.json)", () => {
  it("reads the ceiling the Rust side reads", () => expect(vectors.quota).toBe(1000));
  for (const vector of vectors.cases) {
    it(vector.name, () => {
      const approval = approvalOf(vector.slots, vector.expired === true);
      const bySlot = new Map(approval.slots.map((slot) => [slot.index, slot]));
      const choices = vector.choose.map((index) => {
        const slot = bySlot.get(index)!;
        // A grey slot has no id, so the only thing a request can send for it is an id the card does not have.
        if (slot.state === "gray") return { draftId: "00000000-0000-4000-8000-0000000009ff", revision: "1", sha256: FIXTURE_MEDIA.png.image.sha256 };
        const pin = { draftId: slot.draftId, revision: vector.stale?.includes(index) ? "2" : slot.revision, sha256: slot.media.large.sha256 };
        return vector.chooseKinds?.[String(index)] ? { ...pin, kind: vector.chooseKinds[String(index)] } : pin;
      });
      const verdict = decideExpressionSet({ approval, choices, nowMs: FIXTURE_NOW_MS, taken: new Set(vector.taken), live: vector.live, quota: vector.quota });
      const seen = verdict.ok
        ? { ok: true, registered: verdict.registered.map((item) => ({ name: item.name, kind: item.kind })), skipped: verdict.skipped.map((skip) => ({ name: skip.name, reason: skip.reason })) }
        : verdict;
      expect(seen).toEqual(vector.expect);
    });
  }

  it("takes a whole set of forty in one decision", () => {
    const slots = ids(40).map((i) => fixtureSetReadySlot(i, "still", `cat_s${i}`, `장면 ${i}`));
    const approval = { ...FIXTURE_SET_NORMAL, slots };
    const verdict = decideExpressionSet({ approval, choices: expressionSetChoices(approval, FIXTURE_NOW_MS)!, nowMs: FIXTURE_NOW_MS, taken: new Set(), live: 0 });
    expect(verdict.ok && verdict.registered.length).toBe(40);
    const more = [...expressionSetChoices(approval, FIXTURE_NOW_MS)!, { draftId: fixtureSetDraftId(0), revision: "1", sha256: FIXTURE_MEDIA.png.image.sha256 }];
    expect(decideExpressionSet({ approval, choices: more, nowMs: FIXTURE_NOW_MS, taken: new Set(), live: 0 })).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses a malformed choice item and a kind outside the closed two", () => {
    const [one] = expressionSetChoices(FIXTURE_SET_NORMAL, FIXTURE_NOW_MS)!;
    for (const bad of [{ ...one, kind: "huge" }, { ...one, extra: 1 }, { draftId: one.draftId }, "x", null]) {
      expect(decideExpressionSet({ approval: FIXTURE_SET_NORMAL, choices: [bad], nowMs: FIXTURE_NOW_MS, taken: new Set(), live: 0 }), JSON.stringify(bad)).toMatchObject({ ok: false, status: 400, code: "expression_choice_invalid" });
    }
  });
});

describe("ADR-0218 §12 fake server: a set card end to end (no network)", () => {
  it("serves the pictures behind the card by the pin, and never registers one through the direct route", () => {
    const server = createExpressionFixtureServer({ sets: FIXTURE_SET_CARDS });
    const slot = readySlots(FIXTURE_SET_NORMAL)[0];
    const image = `${base}/expression-drafts/${slot.draftId}/image?size=large`;
    expect(server.request({ method: "GET", path: `${image}&v=${slot.media.large.sha256}` })).toMatchObject({ status: 200, headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" } });
    expect(server.request({ method: "GET", path: `${image}&v=${"0".repeat(64)}` }).status).toBe(404);
    const choice = expressionSetChoices(FIXTURE_SET_NORMAL, FIXTURE_NOW_MS)![0];
    expect(server.request({ method: "POST", path: `${base}/expressions`, body: choice }).status).toBe(404);
  });

  it("registers exactly what was kept, in one catalogue version, and replays the same receipt", () => {
    const server = createExpressionFixtureServer({ sets: FIXTURE_SET_CARDS });
    const choices = expressionSetChoices(FIXTURE_SET_NORMAL, FIXTURE_NOW_MS, { only: [0, 1, 8] })!;
    const done = server.request(approve(FIXTURE_SET_APPROVAL_ID, choices));
    expect(done.status).toBe(200);
    const receipt = receiptOf(done);
    expect(receipt).toMatchObject({ status: "executed", approvalId: FIXTURE_SET_APPROVAL_ID, result: { actionId: "expression.set.create", ref: { type: "expression_set", id: FIXTURE_SET_NORMAL.setId } } });
    const result = parseExpressionSetResult(receipt.result?.expressionSet)!;
    expect(result.registered.map((r) => r.token)).toEqual([":cat_hello:", ":cat_thanks:", ":cat_hello_bounce:"]);
    expect(result.skipped).toEqual([]);
    const list = server.request({ method: "GET", path: `${base}/expressions` }).json as { version: string; items: ExpressionMutation["expression"][] };
    const added = list.items.filter((item) => item.name.startsWith("cat_"));
    expect(added.map((item) => item.version)).toEqual(["4", "4", "4"]);
    expect(list.version).toBe("4");
    expect(added.map((item) => [item.name, item.kind])).toEqual([["cat_hello", "emoji"], ["cat_thanks", "emoji"], ["cat_hello_bounce", "sticker"]]);
    expect(added.every((item) => item.origin.prompt === FIXTURE_SET_NORMAL.prompt && item.createdBy === FIXTURE_EXPRESSIONS[0].createdBy)).toBe(true);
    // A retry of the same decision is the same answer and registers nothing twice.
    expect(server.request(approve(FIXTURE_SET_APPROVAL_ID, choices))).toEqual(done);
    expect((server.request({ method: "GET", path: `${base}/expressions` }).json as { items: unknown[] }).items).toHaveLength(6);
    // The card is settled: another decision is refused, and the pictures are gone.
    expect(server.request(approve(FIXTURE_SET_APPROVAL_ID, choices, "00000000-0000-4000-8000-0000000007a2")).status).toBe(409);
    expect(server.request({ method: "GET", path: `${base}/expression-drafts/${fixtureSetDraftId(4)}/image?size=large&v=${FIXTURE_MEDIA.png.image.sha256}` }).status).toBe(404);
  });

  it("skips the name the library already has and registers the rest of the same card", () => {
    const server = createExpressionFixtureServer({ sets: FIXTURE_SET_CARDS });
    const done = server.request(approve(FIXTURE_SET_SAME_NAME_APPROVAL_ID, expressionSetChoices(FIXTURE_SET_SAME_NAME, FIXTURE_NOW_MS)!));
    const result = receiptOf(done).result!.expressionSet;
    expect(result.registered.map((r) => r.name)).toEqual(["thumbs_wave", "thumbs_clap", "thumbs_heart"]);
    expect(result.skipped).toEqual([{ draftId: fixtureSetDraftId(0), name: "thumbs_up", reason: "name_taken" }]);
    expect(expressionSetResultLine(result)).toBe("3개를 저장하고 1개는 건너뛰었어요");
  });

  it("stops at the 1,000 ceiling and skips the rest in slot order", () => {
    const server = createExpressionFixtureServer({ sets: FIXTURE_SET_CARDS, liveBase: 996 });
    const result = receiptOf(server.request(approve(FIXTURE_SET_APPROVAL_ID, expressionSetChoices(FIXTURE_SET_NORMAL, FIXTURE_NOW_MS, { only: [0, 1, 2] })!))).result!.expressionSet;
    expect(result.registered.map((r) => r.name)).toEqual(["cat_hello"]);
    expect(result.skipped.map((s) => [s.name, s.reason])).toEqual([["cat_thanks", "quota"], ["cat_sorry", "quota"]]);
  });

  it("offers only the ready slots of a card with refusals, and registers those five", () => {
    const server = createExpressionFixtureServer({ sets: FIXTURE_SET_CARDS });
    const card = FIXTURE_SET_CARDS[1].approval;
    const choices = expressionSetChoices(card, FIXTURE_NOW_MS)!;
    const result = receiptOf(server.request(approve(FIXTURE_SET_REFUSED_APPROVAL_ID, choices))).result!.expressionSet;
    expect(result.registered.map((r) => r.name)).toEqual(["cat_hello", "cat_thanks", "cat_done", "cat_happy", "cat_done_wobble"]);
    expect(result.skipped).toEqual([]);
  });

  it("refuses a stale pin for the whole decision and does not spend the approval", () => {
    const server = createExpressionFixtureServer({ sets: FIXTURE_SET_CARDS });
    const choices = expressionSetChoices(FIXTURE_SET_NORMAL, FIXTURE_NOW_MS, { only: [0, 1] })!;
    const stale = server.request(approve(FIXTURE_SET_APPROVAL_ID, [choices[0], { ...choices[1], revision: "2" }]));
    expect(stale).toMatchObject({ status: 409, json: { error: { code: "expression_preview_stale" } } });
    expect((server.request({ method: "GET", path: `${base}/expressions` }).json as { items: unknown[] }).items).toHaveLength(3);
    expect(server.request(approve(FIXTURE_SET_APPROVAL_ID, choices, "00000000-0000-4000-8000-0000000007a3")).status).toBe(200);
  });

  it("takes the plural field on a set card and the single field on nothing else", () => {
    const server = createExpressionFixtureServer({ sets: FIXTURE_SET_CARDS });
    const [choice] = expressionSetChoices(FIXTURE_SET_NORMAL, FIXTURE_NOW_MS)!;
    const body = { approval_id: FIXTURE_SET_APPROVAL_ID, approve: true, client_decision_id: "00000000-0000-4000-8000-0000000007a4" };
    const code = (response: { json?: unknown }) => (response.json as { error: { code: string } }).error.code;
    expect(code(server.request({ method: "POST", path: decisionPath(FIXTURE_SET_APPROVAL_ID), body: { ...body, expressionChoice: choice } }))).toBe("expression_choice_not_allowed");
    expect(code(server.request({ method: "POST", path: decisionPath(FIXTURE_SET_APPROVAL_ID), body }))).toBe("expression_choice_required");
    expect(code(server.request({ method: "POST", path: decisionPath(FIXTURE_SET_APPROVAL_ID), body: { ...body, expressionChoices: [] } }))).toBe("expression_choice_invalid");
    expect(server.request({ method: "POST", path: decisionPath("00000000-0000-4000-8000-0000000004ff"), body }).status).toBe(404);
  });

  it("rejects a set by taking the pictures back, and registers nothing", () => {
    const server = createExpressionFixtureServer({ sets: FIXTURE_SET_CARDS });
    const body = { approval_id: FIXTURE_SET_APPROVAL_ID, approve: false, client_decision_id: "00000000-0000-4000-8000-0000000007a5" };
    expect(receiptOf(server.request({ method: "POST", path: decisionPath(FIXTURE_SET_APPROVAL_ID), body }))).toMatchObject({ status: "rejected", result: null });
    expect(server.request({ method: "GET", path: `${base}/expression-drafts/${fixtureSetDraftId(0)}/image?size=large&v=${FIXTURE_MEDIA.png.image.sha256}` }).status).toBe(404);
    expect((server.request({ method: "GET", path: `${base}/expressions` }).json as { items: unknown[] }).items).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// ADR-0218 §12 L18 (owner 2026-11-06, O3): the reference pictures. The server picks them; one failing picture refuses all.
// ---------------------------------------------------------------------------------------------------------------
const attachmentIdAt = (index: number) => `00000000-0000-4000-8000-${String(0x500 + index).padStart(12, "0")}`;
function probesOf(pictures: VectorPicture[]): ExpressionSetReferenceProbe[] {
  return pictures.map((picture, index) => ({
    attachmentId: attachmentIdAt(picture.duplicateOf ?? index), mime: picture.mime, bytes: picture.bytes, width: picture.width, height: picture.height,
    ...(picture.preparedBytes !== undefined ? { prepared: { mime: "image/png" as const, bytes: picture.preparedBytes } } : {}),
  }));
}

describe("ADR-0218 §12 L18 reference bundle: who picks, how many, how big", () => {
  it("records the references on the card as closed pointers (at most four, no repeats) and never in the plan the model could write", () => {
    expect(FIXTURE_SET_NORMAL.references.map((reference) => reference.attachmentId)).toEqual([...FIXTURE_SET_REFERENCE_IDS]);
    assertExpressionContract("SetApproval", { ...FIXTURE_SET_NORMAL, references: [] });
    const withRefs = (references: unknown) => ({ ...FIXTURE_SET_NORMAL, references });
    const five = [0, 1, 2, 3, 4].map((i) => ({ attachmentId: attachmentIdAt(i) }));
    expect(matchesExpressionContract("SetApproval", withRefs(five.slice(0, 4)))).toBe(true);
    expect(matchesExpressionContract("SetApproval", withRefs(five))).toBe(false);
    expect(matchesExpressionContract("SetApproval", withRefs([five[0], five[0]]))).toBe(false);
    expect(matchesExpressionContract("SetApproval", withRefs([{ attachmentId: "not-a-uuid" }]))).toBe(false);
    expect(matchesExpressionContract("SetApproval", withRefs([{ attachmentId: attachmentIdAt(0), mime: "image/png" }]))).toBe(false);
    const withoutRefs: Record<string, unknown> = { ...FIXTURE_SET_NORMAL };
    delete withoutRefs.references;
    expect(matchesExpressionContract("SetApproval", withoutRefs)).toBe(false);
    // The old single pointer is gone from the card: one name for one thing.
    expect(matchesExpressionContract("SetApproval", { ...FIXTURE_SET_NORMAL, sourceAttachmentId: null })).toBe(false);
    // No model, agent or client names an attachment: the proposal has no key that could carry one.
    for (const key of ["references", "attachmentId", "attachmentIds", "referenceAttachmentIds", "sourceAttachmentId", "image", "url"]) {
      expect(matchesExpressionContract("SetAction", { ...FIXTURE_SET_ACTION, args: { ...FIXTURE_SET_ACTION.args, [key]: [attachmentIdAt(0)] } }), key).toBe(false);
    }
    expect(matchesExpressionContract("SetDecision", { expressionChoices: [{ ...expressionSetChoices(FIXTURE_SET_NORMAL, FIXTURE_NOW_MS)![0], attachmentId: attachmentIdAt(0) }] })).toBe(false);
  });

  it("keeps the numbers in the constants, the vectors and the plan equal, and the request inside P1's 1,200 characters", () => {
    expect(EXPRESSION_SET_REFERENCE_LIMITS).toMatchObject(vectors.referenceLimits);
    expect(EXPRESSION_SET_REFERENCE_LIMITS.pictures).toBe(4);
    expect(EXPRESSION_SET_REFERENCE_LIMITS.inputBytes).toBe(5 * 1024 * 1024);
    expect(EXPRESSION_SET_REFERENCE_LIMITS.bundleBytes).toBe(4 * 1024 * 1024);
    expect(EXPRESSION_SET_REFERENCE_LIMITS.bundleBytes).toBeLessThanOrEqual(EXPRESSION_SET_REFERENCE_LIMITS.preparedBytesEach);
    // The set's description + a line break + a scene is what Hermes is asked, and one request is at most 1,200 characters (ADR-0201 P1).
    expect(EXPRESSION_SET_LIMITS.promptChars + 1 + EXPRESSION_SET_LIMITS.sceneChars).toBeLessThanOrEqual(EXPRESSION_SET_LIMITS.requestChars);
    expect(matchesExpressionContract("SetAction", { ...FIXTURE_SET_ACTION, args: { ...FIXTURE_SET_ACTION.args, prompt: "가".repeat(EXPRESSION_SET_LIMITS.promptChars) } })).toBe(true);
    expect(matchesExpressionContract("SetAction", { ...FIXTURE_SET_ACTION, args: { ...FIXTURE_SET_ACTION.args, prompt: "가".repeat(EXPRESSION_SET_LIMITS.promptChars + 1) } })).toBe(false);
    expect(matchesExpressionContract("SetApproval", { ...FIXTURE_SET_NORMAL, prompt: "가".repeat(EXPRESSION_SET_LIMITS.promptChars + 1) })).toBe(false);
  });

  it("says yes to two good pictures and refuses the whole bundle for each way it can be wrong", () => {
    expect(expressionSetReferenceVerdict(FIXTURE_SET_REFERENCE_PROBES)).toEqual({ ok: true, count: 2, bundleBytes: 460_000 });
    expect(expressionSetReferenceVerdict([])).toEqual({ ok: true, count: 0, bundleBytes: 0 });
    expect(expressionSetReferenceVerdict(fixtureSetReferenceProbesTooMany())).toEqual({ ok: false, refused: ["too_many"] });
    expect(expressionSetReferenceVerdict(FIXTURE_SET_REFERENCE_PROBES_BAD_FORMAT)).toEqual({ ok: false, refused: ["format"] });
    expect(expressionSetReferenceVerdict(fixtureSetReferenceProbesOverBytes())).toEqual({ ok: false, refused: ["bundle_bytes"] });
    expect(expressionSetReferenceVerdict(FIXTURE_SET_REFERENCE_PROBES_TOO_BIG_INPUT)).toEqual({ ok: false, refused: ["input_bytes", "input_pixels"] });
    // Which picture an issue is about is known: nothing is dropped and the rest kept.
    expect(expressionSetReferenceIssues(FIXTURE_SET_REFERENCE_PROBES_BAD_FORMAT).map((entry) => entry.index)).toEqual([1, 2]);
    expect(expressionSetReferenceIssues(fixtureSetReferenceProbesTooMany()).map((entry) => entry.index)).toEqual([null]);
  });

  for (const vector of vectors.referenceCases) {
    it(`vector: ${vector.name}`, () => {
      expect(expressionSetReferenceVerdict(probesOf(vector.pictures))).toEqual(vector.expect);
    });
  }

  it("lists the issues in one fixed order, and the vectors name only issues the code knows", () => {
    const named = new Set(vectors.referenceCases.flatMap((vector) => (vector.expect.ok ? [] : vector.expect.refused)));
    for (const issue of named) expect(EXPRESSION_SET_REFERENCE_ISSUES as readonly string[]).toContain(issue);
    expect([...EXPRESSION_SET_REFERENCE_ISSUES].filter((issue) => !named.has(issue))).toEqual([]);
  });

  it("tells the requester why, once per thing to fix, with no company and no model named", () => {
    const lines = EXPRESSION_SET_REFERENCE_ISSUES.map((issue) => expressionSetReferenceLine(issue));
    expect(new Set(lines).size).toBe(lines.length);
    expect(expressionSetReferenceLine("too_many")).toBe("그림은 4장까지 보낼 수 있어요");
    expect(expressionSetReferenceLine("input_bytes")).toBe("그림 한 장은 5MB까지 보낼 수 있어요");
    expect(expressionSetReferenceNotice()).toBe("첨부한 그림이 Hermes의 그림 모델로 전송돼요");
    for (const line of [...lines, expressionSetReferenceNotice()]) expect(line).not.toMatch(/OpenAI|Gemini|GPT|Codex|Anthropic|Claude|gpt-image/i);
    for (const line of lines) expect(line).not.toMatch(/\{|\}/);
  });
});

describe("ADR-0218 §12 L20 backend: hermes is on, the team's own image key is a reserved name", () => {
  it("lets the plan name either word and the server make pictures only with the first", () => {
    expect([...EXPRESSION_SET_BACKENDS]).toEqual(["hermes", "team_image_model"]);
    assertExpressionContract("SetAction", FIXTURE_SET_ACTION);
    assertExpressionContract("SetAction", FIXTURE_SET_ACTION_RESERVED_BACKEND);
    expect(FIXTURE_SET_ACTION.args.backend).toBe("hermes");
    expect(expressionSetBackendEnabled("hermes")).toBe(true);
    expect(expressionSetBackendEnabled("team_image_model")).toBe(false);
    for (const word of ["openai", "gemini", "", null, undefined, 1, "Hermes", "__proto__", "constructor", "toString"]) expect(expressionSetBackendEnabled(word), String(word)).toBe(false);
  });

  it("closes the word, requires it, and keeps it off the card: the card is the same whatever made the pictures", () => {
    for (const bad of ["openai", "", null, 1, "HERMES"]) expect(matchesExpressionContract("SetAction", { ...FIXTURE_SET_ACTION, args: { ...FIXTURE_SET_ACTION.args, backend: bad } }), String(bad)).toBe(false);
    const withoutBackend: Record<string, unknown> = { ...FIXTURE_SET_ACTION.args };
    delete withoutBackend.backend;
    expect(matchesExpressionContract("SetAction", { ...FIXTURE_SET_ACTION, args: withoutBackend })).toBe(false);
    expect(matchesExpressionContract("SetApproval", { ...FIXTURE_SET_NORMAL, backend: "hermes" })).toBe(false);
    expect(Object.keys(FIXTURE_SET_NORMAL)).not.toContain("backend");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// ADR-0218 §12 L7.7 (owner 2026-11-06, O2): three refusals in a row close the rest of the stills.
// ---------------------------------------------------------------------------------------------------------------
describe("ADR-0218 §12 L7.7 three refusals in a row close the rest (shared vectors)", () => {
  it("reads the streak the Rust side reads", () => expect(vectors.streak).toBe(EXPRESSION_SET_REFUSAL_STREAK));
  for (const vector of vectors.mayTryCases) {
    it(`may try the next still: ${vector.name}`, () => {
      expect(expressionSetMayTryNext(vector.attempts)).toBe(vector.expect);
    });
  }
  for (const vector of vectors.streakCases) {
    it(`stills: ${vector.name}`, () => {
      expect(settleExpressionSetStills(vector.stills, vector.attempts)).toEqual(vector.expect);
    });
  }
  for (const vector of vectors.gifCases) {
    it(`gifs: ${vector.name}`, () => {
      expect(settleExpressionSetGifs(vector.stills, vector.bases)).toEqual(vector.expect);
    });
  }

  it("derives every grey slot of the two refusal cards from the rules, so the cards cannot drift from them", () => {
    const grayOf = (set: ExpressionSetApproval) => set.slots.map((slot) => (slot.state === "gray" ? slot.code : "ready"));
    const derive = (attempts: readonly ExpressionSetAttempt[], bases: readonly number[]) => {
      const stills = settleExpressionSetStills(8, attempts);
      const gifs = settleExpressionSetGifs(stills, bases);
      return [...stills.map((outcome) => (outcome === "made" ? "ready" : expressionSetGrayCodeOf(outcome))), ...gifs.map((outcome) => (outcome === "made" ? "ready" : outcome))];
    };
    expect(grayOf(FIXTURE_SET_STREAK_CLOSED)).toEqual(derive(FIXTURE_SET_STREAK_ATTEMPTS, FIXTURE_SET_STREAK_GIF_BASES));
    expect(grayOf(FIXTURE_SET_REFUSED)).toEqual(derive(FIXTURE_SET_REFUSED_ATTEMPTS, FIXTURE_SET_REFUSED_GIF_BASES));
    // The closed one: stills 5, 6 and 7 were never tried, and the GIF on the grey still 5 has no base; the GIF on still 0 was made.
    const closed = expressionSetCard(FIXTURE_SET_STREAK_CLOSED, FIXTURE_NOW_MS);
    expect(closed.slots.filter((slot) => slot.grayCode === "not_made").map((slot) => slot.index)).toEqual([5, 6, 7]);
    expect(closed.slots.filter((slot) => slot.grayCode === "base_missing").map((slot) => slot.index)).toEqual([9]);
    expect(closed).toMatchObject({ ready: 3, gray: 7, canApprove: true, gifs: { ready: 1, total: 2 } });
    assertExpressionContract("SetApproval", FIXTURE_SET_STREAK_CLOSED);
    expect(expressionSetIssues(FIXTURE_SET_STREAK_CLOSED)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// ADR-0218 §12 L2.5 and L19 (owner 2026-11-06, O5): the plan card, the one-time notice, and "before the button nothing leaves".
// ---------------------------------------------------------------------------------------------------------------
describe("ADR-0218 §12 L2.5 the plan card: the person's one look before anything leaves", () => {
  it("is closed on the wire: the pictures it would send are pointers, at most four, no repeats, and the plan has no id the person could aim", () => {
    for (const card of [FIXTURE_SET_PLAN_CARD, FIXTURE_SET_PLAN_CARD_SEEN, FIXTURE_SET_PLAN_CARD_WORDS]) assertExpressionContract("SetPlanCard", card);
    expect(FIXTURE_SET_PLAN_CARD.references).toHaveLength(2);
    const five = [0, 1, 2, 3, 4].map((i) => ({ attachmentId: attachmentIdAt(i) }));
    expect(matchesExpressionContract("SetPlanCard", fixtureSetPlanCard({ references: five.slice(0, 4) }))).toBe(true);
    expect(matchesExpressionContract("SetPlanCard", fixtureSetPlanCard({ references: five }))).toBe(false);
    expect(matchesExpressionContract("SetPlanCard", fixtureSetPlanCard({ references: [five[0], five[0]] }))).toBe(false);
    for (const bad of [{ state: "done" }, { noticeDue: "yes" }, { prompt: "가".repeat(801) }, { prefix: "Cat" }]) {
      expect(matchesExpressionContract("SetPlanCard", { ...FIXTURE_SET_PLAN_CARD, ...bad }), JSON.stringify(bad)).toBe(false);
    }
    const slot = FIXTURE_SET_PLAN_CARD.slots[0];
    expect(matchesExpressionContract("SetPlanCard", { ...FIXTURE_SET_PLAN_CARD, slots: [{ ...slot, scene: "가".repeat(301) }] })).toBe(false);
    expect(matchesExpressionContract("SetPlanCard", { ...FIXTURE_SET_PLAN_CARD, slots: [{ ...slot, attachmentId: attachmentIdAt(0) }] })).toBe(false);
    expect(matchesExpressionContract("SetPlanCard", { ...FIXTURE_SET_PLAN_CARD, slots: [{ ...slot, motion: "spin" }] })).toBe(false);
    const without: Record<string, unknown> = { ...FIXTURE_SET_PLAN_CARD };
    delete without.noticeDue;
    expect(matchesExpressionContract("SetPlanCard", without)).toBe(false);
  });

  it("finds nothing wrong with the real plan and names each way a plan can break the rules the schema cannot say", () => {
    expect(expressionSetPlanIssues(FIXTURE_SET_PLAN_CARD)).toEqual([]);
    const tamper = (change: (card: ExpressionSetPlanCard) => void) => { const card = copy(FIXTURE_SET_PLAN_CARD); change(card); return expressionSetPlanIssues(card).map((entry) => entry.issue); };
    expect(tamper((card) => { card.slots[0].scene = null; })).toContain("still_without_scene");
    expect(tamper((card) => { card.slots[8].scene = "움직이는 장면"; })).toContain("gif_with_scene");
    expect(tamper((card) => { card.slots[8].baseIndex = 9; })).toContain("gif_base_missing");
    expect(tamper((card) => { card.slots[8].baseIndex = null; })).toContain("gif_base_missing");
    expect(tamper((card) => { card.slots[8].motion = null; })).toContain("gif_without_motion");
    expect(tamper((card) => { card.slots[1].index = 0; })).toContain("duplicate_index");
    expect(tamper((card) => { card.slots[1].name = "dog_thanks"; })).toContain("prefix_mismatch");
    expect(tamper((card) => { card.slots[1].name = card.slots[0].name; })).toContain("duplicate_name");
    // The longest legal prompt and the longest legal scene still fit one request (800 + 1 + 300 <= 1,200): the check never fires on a schema-legal plan.
    expect(tamper((card) => { card.prompt = "가".repeat(800); card.slots[0].scene = "나".repeat(300); })).not.toContain("request_too_long");
  });

  it("shows what is made, how many pictures would be sent, the declaration every time, and the notice only the first time", () => {
    const first = expressionSetPlanView(FIXTURE_SET_PLAN_CARD, FIXTURE_NOW_MS);
    expect(first).toMatchObject({ state: "planned", canConfirm: true, canRevise: true, canCancel: true, stills: 8, gifs: 2, picturesLine: "만들 그림 10장", referencesLine: "보낼 참조 그림 2장" });
    expect(first.declareLine).toBe("사람 얼굴이 있는 그림은 보내지 마세요. 이 그림들에는 사람 얼굴이 없어요.");
    expect(first.noticeLines).toEqual(["첨부한 그림이 Hermes의 그림 모델로 전송돼요", "Hermes는 보낸 그림과 결과를 자기 기록에 남길 수 있어요"]);
    const next = expressionSetPlanView(FIXTURE_SET_PLAN_CARD_SEEN, FIXTURE_NOW_MS);
    expect(next.noticeLines).toEqual([]);
    expect(next.referencesLine).toBe("보낼 참조 그림 2장");
    expect(next.declareLine).not.toBeNull();
    const words = expressionSetPlanView(FIXTURE_SET_PLAN_CARD_WORDS, FIXTURE_NOW_MS);
    expect(words).toMatchObject({ referencesLine: null, declareLine: null, noticeLines: [] });
    // A card that says the notice is due but sends nothing shows no notice: there is nothing to be told about.
    expect(expressionSetPlanView(fixtureSetPlanCard({ references: [], noticeDue: true }), FIXTURE_NOW_MS).noticeLines).toEqual([]);
    for (const line of [first.picturesLine, first.referencesLine!, first.declareLine!, ...first.noticeLines]) expect(line).not.toMatch(/OpenAI|Gemini|GPT|Codex|Anthropic|Claude|gpt-image/i);
  });

  it("tells a member who sends exactly ONE picture the same three things as a member who sends two: the count, the declaration, and the first-time notice (R2-M1)", () => {
    // One reference per character is the commonest case, and each of these lines once could open only above one picture (`references > 1`) with no test noticing.
    expect(FIXTURE_SET_PLAN_CARD_ONE.references).toHaveLength(1);
    expect(FIXTURE_SET_PLAN_CARD_ONE.noticeDue).toBe(true);
    const first = expressionSetPlanView(FIXTURE_SET_PLAN_CARD_ONE, FIXTURE_NOW_MS);
    expect(first.referencesLine).toBe("보낼 참조 그림 1장");
    expect(first.declareLine).toBe("사람 얼굴이 있는 그림은 보내지 마세요. 이 그림들에는 사람 얼굴이 없어요.");
    expect(first.noticeLines).toEqual(["첨부한 그림이 Hermes의 그림 모델로 전송돼요", "Hermes는 보낸 그림과 결과를 자기 기록에 남길 수 있어요"]);
    // The same member's next set with one picture: the count and the declaration come back every time, the notice does not.
    const next = expressionSetPlanView({ ...FIXTURE_SET_PLAN_CARD_ONE, noticeDue: false }, FIXTURE_NOW_MS);
    expect(next.referencesLine).toBe("보낼 참조 그림 1장");
    expect(next.declareLine).toBe(first.declareLine);
    expect(next.noticeLines).toEqual([]);
    // One picture is the first count that sends anything: none of the three at zero, all three (the notice only while it is due) at every count from 1 to 4.
    for (const count of [0, 1, 2, 3, 4]) {
      const references = [0, 1, 2, 3].slice(0, count).map((i) => ({ attachmentId: attachmentIdAt(i) }));
      const view = expressionSetPlanView(fixtureSetPlanCard({ references, noticeDue: true }), FIXTURE_NOW_MS);
      expect(view.referencesLine, `${count} pictures: count line`).toBe(count === 0 ? null : `보낼 참조 그림 ${count}장`);
      expect(view.declareLine === null, `${count} pictures: declaration absent`).toBe(count === 0);
      expect(view.noticeLines, `${count} pictures: notice lines`).toHaveLength(count === 0 ? 0 : 2);
    }
  });

  it("closes the buttons once the card is answered or its window is over", () => {
    for (const state of ["confirmed", "cancelled", "expired"] as const) {
      expect(expressionSetPlanView(fixtureSetPlanCard({ state }), FIXTURE_NOW_MS)).toMatchObject({ state, canConfirm: false, canRevise: false, canCancel: false });
    }
    const late = expressionSetPlanView(FIXTURE_SET_PLAN_CARD, FIXTURE_SET_PLAN_CARD.expiresAtMs);
    expect(late).toMatchObject({ state: "expired", canConfirm: false });
    expect(expressionSetPlanStateAt(FIXTURE_SET_PLAN_CARD, FIXTURE_SET_PLAN_CARD.expiresAtMs - 1)).toBe("planned");
  });
});

describe("ADR-0218 §12 L19: before the button, nothing leaves (shared vectors)", () => {
  for (const vector of vectors.planGateCases) {
    it(`may start: ${vector.name}`, () => {
      expect(expressionSetPlanMayStart({ state: vector.state, expiresAtMs: vector.expiresAtMs }, vector.nowMs)).toBe(vector.expect);
    });
  }
  it("only a confirmed card lets a set start, from the fixtures", () => {
    expect(expressionSetPlanMayStart(FIXTURE_SET_PLAN_CARD, FIXTURE_NOW_MS)).toBe(false);
    expect(expressionSetPlanMayStart(fixtureSetPlanCard({ state: "confirmed" }), FIXTURE_NOW_MS)).toBe(true);
    expect(expressionSetPlanMayStart(fixtureSetPlanCard({ state: "cancelled" }), FIXTURE_NOW_MS)).toBe(false);
  });
});

describe("ADR-0218 §12 L19: the reference notice is shown once per member (shared vectors)", () => {
  for (const vector of vectors.noticeCases) {
    it(`notice: ${vector.name}`, () => {
      expect(expressionSetReferenceNoticeDue({ seenAtMs: vector.seenAtMs }, vector.references)).toBe(vector.expect);
    });
  }
  it("keeps the first time a member saw it, never moves it, and keeps one member's record apart from another's", () => {
    const first = expressionSetReferenceNoticeSeen({ seenAtMs: null }, 1000);
    expect(first).toEqual({ seenAtMs: 1000 });
    expect(expressionSetReferenceNoticeSeen(first, 9999)).toEqual({ seenAtMs: 1000 });
    const other = { seenAtMs: null };
    expect(expressionSetReferenceNoticeDue(first, 2)).toBe(false);
    expect(expressionSetReferenceNoticeDue(other, 2)).toBe(true);
    expect(expressionSetReferenceNoticeSeen(other, 5)).toEqual({ seenAtMs: 5 });
    expect(other).toEqual({ seenAtMs: null });
  });
});

describe("ADR-0218 §12 L2.5 「장면 고치기」 takes pictures out of the bundle and never puts one in (shared vectors)", () => {
  for (const vector of vectors.narrowCases) {
    it(`narrow: ${vector.name}`, () => {
      const current = vector.current.map((attachmentId) => ({ attachmentId }));
      const verdict = narrowExpressionSetReferences(current, vector.remove);
      expect(verdict.ok ? { ok: true, references: verdict.references.map((reference) => reference.attachmentId) } : verdict).toEqual(vector.expect);
    });
  }
});
