import { describe, expect, it } from "vitest";
import type { Message } from "../../lib/api";
import failureCopy from "../approvals/expression-failure-copy.json";
import settlementCopy from "../approvals/settlement-copy.json";
import { approvalOutcomeLine, expressionFailureLine } from "../approvals/approvalOutcome";
import { agentCardModel } from "../timeline/agentCardModel";
import { EXPRESSION_CARD_COPY, expressionCopy, type ExpressionCopyKey } from "./cardCopy";
import { expressionApprovalSummary, expressionDraftCard } from "./cards";
import { FIXTURE_AI_APPROVAL, FIXTURE_NOW_MS, FIXTURE_READY_DRAFT, FIXTURE_SOURCE_ATTACHMENT_ID, fixtureGeneratedDraft, fixtureManualDraft } from "./fixtures";
import { EXPRESSION_FAILURE_CODES, MANUAL_UPLOAD_CODES, type ExpressionDraft } from "./types";

// ADR-0218 section 7 G3.8, typed out by hand. The golden file is also what the server writes
// into the card body, so a test that only reads that file would pass after any edit to it.
// These literals are the second witness that pins each sentence to the table.
const G38 = [
  ["generation_failed", "그림을 만들지 못했어요"],
  ["assembly_source_invalid", "이 그림에는 움직임을 입힐 수 없어요"],
  ["assembly_source_too_large", "그림이 너무 커서 움직임을 입힐 수 없어요"],
  ["assembly_output_too_large", "움직이는 그림이 너무 커요"],
  ["assembly_timeout", "움직임을 입히다가 시간이 다 됐어요"],
  ["assembly_busy", "지금 다른 그림을 처리하고 있어요. 잠시 뒤에 다시 해 주세요"],
] as const;

// Banned words are written in pieces so this file does not contain them either.
const BANNED = [["그", "리기"], ["그", "려"], ["그", "리는"]].map((parts) => parts.join(""));
const hasBanned = (text: string) => BANNED.some((word) => text.includes(word));

describe("generation and assembly failure sentences (ADR-0218 G3.8)", () => {
  it("keeps exactly the six card codes of the closed list, in the table's order", () => {
    expect(failureCopy.map((row) => row.code)).toEqual([...EXPRESSION_FAILURE_CODES]);
    expect([...EXPRESSION_FAILURE_CODES]).toEqual(G38.map(([code]) => code));
  });
  it.each(G38)("says the table's own sentence for %s", (code, line) => {
    expect(failureCopy.find((row) => row.code === code)?.line).toBe(line);
    expect(expressionFailureLine(code)).toBe(line);
    // The request-loop card reads its sentence for `props.code` through this one lookup.
    expect(approvalOutcomeLine(code)).toBe(line);
  });
  it("never invents a sentence: the call error, unknown codes and prototype names stay null", () => {
    for (const code of ["assembly_params_invalid", "future_failure", "constructor", "__proto__", "toString", "", undefined, null, 7]) {
      expect(expressionFailureLine(code)).toBeNull();
      expect(approvalOutcomeLine(code)).toBeNull();
    }
  });
  it("leaves the four terminal approval sentences exactly as the server mirrors them", () => {
    expect(settlementCopy).toHaveLength(4);
    for (const row of settlementCopy) expect(approvalOutcomeLine(row.code)).toBe(row.line);
    expect(approvalOutcomeLine("approval_expired")).toBe("승인을 기다리다 만료됐어요");
  });
  it("keeps the server-readable shape: each row is code, the Korean line, and an English line", () => {
    for (const row of failureCopy) {
      expect(Object.keys(row).sort()).toEqual(["code", "en", "line"]);
      expect(row.line.length).toBeGreaterThan(5);
      expect(row.en.length).toBeGreaterThan(5);
      expect(row.en).not.toMatch(/[ㄱ-ㅎ가-힣]/u);
      expect(`${row.line}${row.en}`).not.toMatch(/[–—]/u);
      expect(hasBanned(row.line)).toBe(false);
    }
  });
});

describe("a slot with no picture: the reason sits where the person reads it", () => {
  it.each(G38)("%s is a slot that can only take a hand-made upload", (code, line) => {
    const draft = fixtureManualDraft(code);
    const card = expressionDraftCard(draft, FIXTURE_NOW_MS);
    expect(card).toMatchObject({ state: "manual_upload_required", code, line, canApprove: false, canUpload: true, preview: null, uploadLabel: "직접 올리기" });
  });
  it("keeps the fetch-failure sentences it already had", () => {
    for (const code of MANUAL_UPLOAD_CODES) {
      const { line } = expressionDraftCard(fixtureManualDraft(code), FIXTURE_NOW_MS);
      expect(line).toMatch(/직접 올려 주세요/u);
      expect(line).not.toBe(expressionCopy("expressions.card.manualFallback"));
    }
  });
  it("stands on a neutral sentence for a code this build has never seen, never an empty line", () => {
    for (const code of ["future_failure", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const draft = { ...fixtureManualDraft(), code } as unknown as ExpressionDraft;
      const { line } = expressionDraftCard(draft, FIXTURE_NOW_MS);
      expect(line).toBe("그림을 준비하지 못했어요. 직접 올려 주세요.");
    }
  });
  it("still lets settled and expired cards say their own thing", () => {
    const draft = fixtureManualDraft("assembly_busy");
    expect(expressionDraftCard(draft, FIXTURE_NOW_MS, false).line).toBe("처리가 끝난 요청이에요");
    expect(expressionDraftCard(draft, draft.expiresAtMs).line).toBe("승인을 기다리다 만료됐어요");
  });
});

describe("the approval card head: how many pictures and where they came from (ADR-0218 G1, G5)", () => {
  it("counts the pictures that exist and points at the one original photo", () => {
    const summary = expressionApprovalSummary(FIXTURE_AI_APPROVAL.candidates);
    expect(summary.count).toBe(3);
    expect(summary.countLabel).toBe("그림 3장");
    expect(summary.sources).toEqual([{ kind: "attached", attachmentId: FIXTURE_SOURCE_ATTACHMENT_ID, label: "원본 사진", missingLabel: "원본 사진 없음" }]);
  });
  it("counts every picture when none failed, and follows each change", () => {
    const four = [1, 2, 3, 4].map((index) => fixtureGeneratedDraft(index));
    expect(expressionApprovalSummary(four).countLabel).toBe("그림 4장");
    expect(expressionApprovalSummary(four.slice(0, 1)).countLabel).toBe("그림 1장");
    expect(expressionApprovalSummary(four.slice(0, 2)).count).toBe(2);
  });
  it("has nothing to count when every slot failed", () => {
    const failed = [1, 2].map((index) => ({ ...fixtureGeneratedDraft(index), state: "manual_upload_required", code: "generation_failed", media: null }) as ExpressionDraft);
    expect(expressionApprovalSummary(failed)).toMatchObject({ count: 0, countLabel: null });
    expect(expressionApprovalSummary([])).toEqual({ count: 0, countLabel: null, sources: [] });
  });
  it("says nothing about a request that was not made by an AI", () => {
    expect(expressionApprovalSummary([FIXTURE_READY_DRAFT, fixtureManualDraft()])).toEqual({ count: 0, countLabel: null, sources: [] });
    const link = { ...FIXTURE_READY_DRAFT, origin: { ...FIXTURE_READY_DRAFT.origin, sourceAttachmentId: null } };
    expect(expressionApprovalSummary([link]).sources).toEqual([]);
  });
  it("counts only generated pictures when a request mixes them with a link", () => {
    expect(expressionApprovalSummary([fixtureGeneratedDraft(1), FIXTURE_READY_DRAFT]).count).toBe(1);
  });

  it("keeps the three answers of the pointer apart: an id, words alone, and not said", () => {
    const withId = expressionApprovalSummary([fixtureGeneratedDraft(1)]).sources;
    const wordsAlone = expressionApprovalSummary([fixtureGeneratedDraft(1, { sourceAttachmentId: null })]).sources;
    const notSaid = expressionApprovalSummary([fixtureGeneratedDraft(1, { sourceAttachmentId: undefined })]).sources;
    expect(withId.map((line) => [line.kind, line.label])).toEqual([["attached", "원본 사진"]]);
    expect(wordsAlone).toEqual([{ kind: "none", attachmentId: null, label: "원본 사진 없음", missingLabel: "원본 사진 없음" }]);
    expect(notSaid).toEqual([]);
  });
  it("treats an unreadable pointer as not said instead of claiming there is no original", () => {
    for (const bad of ["", 7, {}, []]) {
      const draft = fixtureGeneratedDraft(1, { sourceAttachmentId: bad as unknown as string });
      expect(expressionApprovalSummary([draft]).sources).toEqual([]);
    }
  });
  it("lists each distinct original once, in the order the candidates name them", () => {
    const other = "00000000-0000-4000-8000-000000000032";
    const drafts = [
      fixtureGeneratedDraft(1), fixtureGeneratedDraft(2),
      fixtureGeneratedDraft(3, { sourceAttachmentId: other }), fixtureGeneratedDraft(4, { sourceAttachmentId: null }),
      fixtureGeneratedDraft(5, { sourceAttachmentId: other }),
    ];
    expect(expressionApprovalSummary(drafts).sources.map((line) => line.attachmentId)).toEqual([FIXTURE_SOURCE_ATTACHMENT_ID, other, null]);
  });
  it("leaves a card as it was when the server does not send the pointer", () => {
    const old = fixtureGeneratedDraft(1, { sourceAttachmentId: undefined });
    const { sourceAttachmentId: _dropped, ...origin } = old.origin;
    const without = { ...old, origin } as ExpressionDraft;
    expect("sourceAttachmentId" in without.origin).toBe(false);
    expect(expressionDraftCard(without, FIXTURE_NOW_MS)).toEqual(expressionDraftCard(fixtureGeneratedDraft(1), FIXTURE_NOW_MS));
    expect(expressionApprovalSummary([without]).sources).toEqual([]);
    expect(expressionApprovalSummary([without]).countLabel).toBe("그림 1장");
  });
  it("never puts money, tokens or limits on the card: the count is the only number it can say", () => {
    const labels = [expressionApprovalSummary(FIXTURE_AI_APPROVAL.candidates)].flatMap((summary) => [summary.countLabel ?? "", ...summary.sources.flatMap((line) => [line.label, line.missingLabel])]);
    expect(labels.join(" ").match(/\d+/gu)).toEqual(["3"]);
    // 원 as money only after a digit: 원본 is the very word under test.
    expect(labels.join(" ")).not.toMatch(/[$₩]|\d\s*원|토큰|달러|한도|가격|비용/u);
  });
});

describe("card copy pairs", () => {
  const entries = Object.entries(EXPRESSION_CARD_COPY) as Array<[ExpressionCopyKey, { ko: string; en: string }]>;
  const argumentsOf = (message: string) => [...message.matchAll(/\{(\w+)(?:,|\})/gu)].map((match) => match[1]).sort();
  it.each(entries)("%s names the same arguments in both languages, in the catalog's key shape", (key, message) => {
    expect(key).toMatch(/^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/u);
    expect(argumentsOf(message.ko)).toEqual(argumentsOf(message.en));
    expect(message.ko).toMatch(/[ㄱ-ㅎ가-힣]/u);
    expect(message.en).not.toMatch(/[ㄱ-ㅎ가-힣]/u);
    if (message.en.includes("plural")) expect(message.en).toContain("other {");
    expect(`${message.ko}${message.en}`).not.toMatch(/[–—]/u);
    expect(hasBanned(message.ko)).toBe(false);
  });
  it("reads the Korean sentence and fills the count", () => {
    expect(expressionCopy("expressions.card.pictureCount", { count: 4 })).toBe("그림 4장");
    expect(expressionCopy("expressions.card.sourcePhoto")).toBe("원본 사진");
    expect(expressionCopy("expressions.card.sourcePhotoNone")).toBe("원본 사진 없음");
  });
  it("keeps an argument it was not given visible instead of printing undefined", () => {
    expect(expressionCopy("expressions.card.pictureCount")).toBe("그림 {count, number}장");
  });
});

describe("a failure card carries its code and a measured size without breaking", () => {
  const CODES = [...EXPRESSION_FAILURE_CODES];
  const failure = (code: string, status: string, extra: Record<string, unknown> = {}): Message => ({
    id: "0199aa00-0000-7000-8000-00000000abcd", channelId: "00000000-0000-7000-8000-000000000201", seq: 7,
    hlcTs: 1_753_400_000_000, hlcCount: 0, authorMemberId: "00000000-0000-7000-8000-000000000101",
    type: "approval_request", body: "움직이는 그림이 너무 커요", state: "sent", createdAtMs: 1_753_400_000_000,
    props: { approval_id: "0199aa11-2222-7000-8000-0000000000a1", status, code, title: "팀 그림 등록 요청", ...extra },
  });
  it.each(CODES)("reads %s from props.code on a closed card", (code) => {
    const line = G38.find(([known]) => known === code)![1];
    for (const status of ["cancelled", "rejected", "expired"]) {
      const card = agentCardModel(failure(code, status, { bytes: 1_234_567 }));
      expect(card?.kind).toBe("approval");
      if (card?.kind !== "approval") return;
      expect(card.summary).toBe(line);
      expect(card.status).toBe(status);
    }
  });
  it("counts the measured size as one withheld field and shows it as a number nowhere", () => {
    const card = agentCardModel(failure("assembly_output_too_large", "cancelled", { bytes: 1_234_567 }));
    if (card?.kind !== "approval") throw new Error("approval card required");
    // The honesty rule of the card: a key it does not read is counted, never silently dropped.
    expect(card.detail.withheld).toBe(1);
    expect(JSON.stringify(card)).not.toMatch(/1234567|1,234,567/u);
  });
  it("does not change what a pending card says", () => {
    const card = agentCardModel(failure("assembly_busy", "pending", { summary: "그림 한 장을 올릴게요" }));
    if (card?.kind !== "approval") throw new Error("approval card required");
    expect(card.summary).toBe("그림 한 장을 올릴게요");
  });
});
