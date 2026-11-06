import { describe, expect, it } from "vitest";
import { assertExpressionContract, EXPRESSION_CONTRACTS, EXPRESSION_SET_CONTRACTS, matchesExpressionContract } from "./contracts";
import { createExpressionFixtureServer } from "./fixtureServer";
import { FIXTURE_MEDIA } from "./fixtureMedia";
import { FIXTURE_EXPRESSIONS, FIXTURE_NOW_MS, FIXTURE_WORKSPACE_ID } from "./fixtures";
import {
  decideExpressionSet, EXPRESSION_SET_ACTION_ID, EXPRESSION_SET_GRAY_CODES, EXPRESSION_SET_LIMITS, expressionSetCard, expressionSetChoices,
  expressionSetIssues, expressionSetResultLine, expressionSetSlotDraft, expressionSetStoredBytes, expressionSetWithinBudget, parseExpressionSetResult, readySlots,
  type ExpressionSetApproval, type ExpressionSetDecisionReceipt, type ExpressionSetReadySlot, type ExpressionSetSlot,
} from "./set";
import { expressionSetGrayLine, expressionSetSkipLine } from "./setCopy";
import {
  FIXTURE_SET_ACTION, FIXTURE_SET_APPROVAL_ID, FIXTURE_SET_CARDS, FIXTURE_SET_NORMAL, FIXTURE_SET_REFUSED, FIXTURE_SET_REFUSED_APPROVAL_ID,
  FIXTURE_SET_SAME_NAME, FIXTURE_SET_SAME_NAME_APPROVAL_ID, fixtureSetBytesHeavy, fixtureSetDraftId, fixtureSetGraySlot, fixtureSetOverLimit, fixtureSetReadySlot,
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
    expect(expressionSetSlotDraft(FIXTURE_SET_NORMAL, slot)).toMatchObject({ origin: { kind: "generated", prompt: FIXTURE_SET_NORMAL.prompt, sourceAttachmentId: null }, subjectMemberId: null });
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
const vectors = vectorFile as unknown as { quota: number; cases: Vector[] };

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
