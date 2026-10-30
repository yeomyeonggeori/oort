import { describe, expect, it } from "vitest";
import { FIXTURE_EXPRESSIONS, FIXTURE_HIDDEN_DELTA, FIXTURE_LIST, FIXTURE_NOW_MS, FIXTURE_READY_DRAFT, FIXTURE_WORKSPACE_ID, fixtureManualDraft } from "./fixtures";
import { applyExpressionList, compareExpressionVersions, emptyExpressionCache, expressionCacheNeedsRefresh } from "./cache";
import { expressionChoice, expressionDraftCard, matchesExpressionChoice } from "./cards";
import { buildExpressionMessage, expressionAltText, expressionFallbackBody, expressionMessageModel, expressionResultMessage, expressionToken, isExpressionName, tokenizeExpressionReaction, tokenizeExpressions } from "./message";
import { koreanInitials, searchExpressions } from "./search";
import { emptyExpressionUsage, frequentExpressions, recentExpressions, recordExpressionUse, restoreExpressionUsage } from "./usage";
import { MANUAL_UPLOAD_CODES } from "./types";

const [party, faint, thumbs] = FIXTURE_EXPRESSIONS;
const onlyExpressions = (body: string) => tokenizeExpressions(body, FIXTURE_EXPRESSIONS).filter((token) => token.type === "expression");

describe("expression search", () => {
  it("searches names, Korean labels, tags and emoji tags", () => {
    for (const query of ["PARTY", "  앵무  ", "축하", "🎉"]) expect(searchExpressions(FIXTURE_EXPRESSIONS, query).map((item) => item.id)).toEqual([party.id]);
    expect(searchExpressions(FIXTURE_EXPRESSIONS, "좋아요")[0].id).toBe(thumbs.id);
    expect(searchExpressions(FIXTURE_EXPRESSIONS, "없음")).toEqual([]);
  });
  it("handles Hangul initials, doubled consonants, and NFC", () => {
    expect(koreanInitials("기절 꽈악 ABC")).toBe("ㄱㅈ ㄲㅇ ABC");
    expect(searchExpressions(FIXTURE_EXPRESSIONS, "ㄱㅈ")[0].id).toBe(faint.id);
    expect(searchExpressions(FIXTURE_EXPRESSIONS, "ㅍㅌ")[0].id).toBe(party.id);
    expect(searchExpressions(FIXTURE_EXPRESSIONS, "기절".normalize("NFD"))[0].id).toBe(faint.id);
    expect(searchExpressions(FIXTURE_EXPRESSIONS, "ㄴㄴ")).toEqual([]);
  });
  it("ranks exact names before prefixes, tags and frequency; stable ties", () => {
    const exact = { ...party, name: "dance", id: "exact", tags: [] };
    const prefix = { ...faint, name: "dance_more", id: "prefix", tags: [] };
    const tag = { ...thumbs, id: "tag", tags: ["dance"] };
    let usage = emptyExpressionUsage(FIXTURE_WORKSPACE_ID, "member");
    for (let i = 0; i < 3; i++) usage = recordExpressionUse(usage, "tag", i);
    expect(searchExpressions([tag, prefix, exact], "dance", usage).map((item) => item.id)).toEqual(["exact", "prefix", "tag"]);
    expect(searchExpressions([tag, prefix, exact], "", usage)[0].id).toBe("tag");
    expect(searchExpressions([party, { ...faint, status: "hidden", media: null }], "")).toEqual([party]);
  });
});

describe("expression tokens and message model (a)", () => {
  it("keeps exact tokens and original body; no extra sending field or props", () => {
    expect(buildExpressionMessage(party)).toEqual({ body: ":party_parrot:" });
    expect(expressionMessageModel(":party_parrot:", FIXTURE_EXPRESSIONS).fallbackBody).toBe(":party_parrot:");
    expect(tokenizeExpressions("앞 :party_parrot: 뒤", FIXTURE_EXPRESSIONS).map((token) => token.text).join("")).toBe("앞 :party_parrot: 뒤");
    expect(onlyExpressions(":party_parrot::ki_jeol:")).toHaveLength(2);
  });
  it("keeps code, escaped tokens, URLs and link destinations literal", () => {
    const samples = [
      "`:party_parrot:`", "``code ` :party_parrot:``", "\\:party_parrot:",
      "```text\n:party_parrot:\n```", "~~~\n:party_parrot:\n~~~", "    :party_parrot:",
      "> ~~~\n> :party_parrot:\n> ~~~", "- ~~~\n  :party_parrot:\n  ~~~",
      "> > ```\n> > :party_parrot:\n> > ```", ">     :party_parrot:",
      "https://example.org/:party_parrot:", "<https://example.org/:party_parrot:>",
      "[label](/path/:party_parrot:)", "[label](/nested(a):party_parrot:)",
    ];
    for (const body of samples) {
      expect(onlyExpressions(body), body).toEqual([]);
      expect(tokenizeExpressions(body, FIXTURE_EXPRESSIONS).map((token) => token.text).join(""), body).toBe(body);
    }
    expect(onlyExpressions("```\n:party_parrot:\n```\n:ki_jeol:")[0].text).toBe(":ki_jeol:");
    expect(onlyExpressions("`:party_parrot:` :ki_jeol:")).toHaveLength(1);
    expect(onlyExpressions("\\\\:party_parrot:")).toHaveLength(1);
  });
  it("accepts only exact known active reaction tokens, without trimming", () => {
    expect(tokenizeExpressionReaction(":party_parrot:", FIXTURE_EXPRESSIONS).type).toBe("expression");
    for (const value of [":missing:", " :party_parrot:", ":party_parrot: ", "hi :party_parrot:", ":PARTY_PARROT:", ":party_parrot::ki_jeol:", "👍"]) expect(tokenizeExpressionReaction(value, FIXTURE_EXPRESSIONS)).toEqual({ type: "text", text: value });
    expect(tokenizeExpressionReaction(":party_parrot:", [{ ...party, status: "deleted", media: null }]).type).toBe("text");
  });
  it.each([1, 2, 6, 7])("sizes %i pure expressions at the boundary", (count) => {
    expect(expressionMessageModel(Array(count).fill(":party_parrot:").join(" \n"), FIXTURE_EXPRESSIONS).size).toBe(count === 1 ? "large" : count <= 6 ? "medium" : "inline");
  });
  it.each(["", "hello :party_parrot:", ":party_parrot:!", ":missing:", ":party_parrot: 👍", "`:party_parrot:`"])("keeps mixed/unknown body inline: %s", (body) => {
    expect(expressionMessageModel(body, FIXTURE_EXPRESSIONS).size).toBe("inline");
  });
  it("retains whitespace in fallback and never substitutes a mutable display name", () => {
    const body = " \n:party_parrot: ";
    const renamed = { ...party, displayName: "다른 표시 이름" };
    expect(expressionFallbackBody(body)).toBe(body);
    expect(expressionMessageModel(body, [renamed]).fallbackBody).toBe(body);
    expect(expressionAltText(renamed)).toBe("다른 표시 이름 · 축하");
    expect(expressionMessageModel(body, [{ ...renamed, status: "hidden", media: null }]).size).toBe("inline");
    expect(() => buildExpressionMessage({ ...party, status: "deleted", media: null })).toThrow();
  });
  it("uses 2–30 ASCII name characters within the 32-char reaction ceiling", () => {
    expect(expressionToken("a".repeat(30))).toHaveLength(32);
    for (const name of ["x", "a".repeat(31), "한글", "CAPS", "bad/name", ":aa:"]) expect(isExpressionName(name)).toBe(false);
    expect(() => expressionToken("bad name")).toThrow();
  });
  it("revalidates result-card sends against live identity and state", () => {
    const result = { id: party.id, name: party.name, token: ":party_parrot:" };
    expect(expressionResultMessage(result, FIXTURE_EXPRESSIONS)).toEqual({ body: ":party_parrot:" });
    expect(expressionResultMessage(result, [])).toBeNull();
    expect(expressionResultMessage({ ...result, name: "ki_jeol" }, FIXTURE_EXPRESSIONS)).toBeNull();
    expect(expressionResultMessage({ ...result, token: ":ki_jeol:" }, FIXTURE_EXPRESSIONS)).toBeNull();
  });
});

describe("device-local successful-use history", () => {
  it("orders recent by time, frequent by count first, and never mutates prior state", () => {
    const empty = emptyExpressionUsage(FIXTURE_WORKSPACE_ID, "member");
    let usage = recordExpressionUse(empty, party.id, 10);
    usage = recordExpressionUse(usage, party.id, 20);
    usage = recordExpressionUse(usage, faint.id, 30);
    expect(empty.entries).toEqual([]);
    expect(recentExpressions(usage).map((item) => item.id)).toEqual([faint.id, party.id]);
    expect(frequentExpressions(usage).map((item) => item.id)).toEqual([party.id, faint.id]);
    expect(frequentExpressions(usage, new Set([faint.id]))).toHaveLength(1);
    expect(recordExpressionUse(usage, party.id, 0).entries.find((entry) => entry.id === party.id)?.lastUsedAtMs).toBe(20);
  });
  it("breaks ties deterministically and caps counts", () => {
    let usage = recordExpressionUse(emptyExpressionUsage("ws", "member"), "b", 10);
    usage = recordExpressionUse(usage, "a", 10);
    expect(recentExpressions(usage).map((entry) => entry.id)).toEqual(["a", "b"]);
    usage.entries[0].count = Number.MAX_SAFE_INTEGER;
    expect(recordExpressionUse(usage, "a", 11).entries[0].count).toBe(Number.MAX_SAFE_INTEGER);
    expect(recordExpressionUse(usage, "a", NaN)).toBe(usage);
  });
  it("rejects other-account/workspace storage and corrupt/duplicate entries", () => {
    const usage = recordExpressionUse(emptyExpressionUsage("ws", "person"), "a", 10);
    expect(restoreExpressionUsage(usage, "other", "person").entries).toEqual([]);
    expect(restoreExpressionUsage(usage, "ws", "other").entries).toEqual([]);
    const corrupt = { ...usage, entries: [null, { id: "a", count: -1, lastUsedAtMs: 0 }, ...usage.entries, ...usage.entries] };
    expect(restoreExpressionUsage(corrupt, "ws", "person")).toEqual(usage);
    expect(restoreExpressionUsage(null, "ws", "person").entries).toEqual([]);
    expect(restoreExpressionUsage({ ...usage, v: 2 }, "ws", "person").entries).toEqual([]);
  });
});

describe("fetch-failure approval cards and exact preview choice", () => {
  it.each(MANUAL_UPLOAD_CODES)("preserves source and upload control for %s", (code) => {
    const draft = fixtureManualDraft(code);
    const card = expressionDraftCard(draft, FIXTURE_NOW_MS);
    expect(card).toMatchObject({ state: "manual_upload_required", sourceLink: "https://giphy.com/gifs/example", code, canApprove: false, canUpload: true, preview: null, uploadLabel: "직접 올리기" });
    expect(expressionChoice(draft, FIXTURE_NOW_MS)).toBeNull();
  });
  it("requires an unexpired ready preview; replacement invalidates the viewed choice", () => {
    const choice = expressionChoice(FIXTURE_READY_DRAFT, FIXTURE_NOW_MS)!;
    expect(matchesExpressionChoice(FIXTURE_READY_DRAFT, choice, FIXTURE_NOW_MS)).toBe(true);
    expect(matchesExpressionChoice({ ...FIXTURE_READY_DRAFT, revision: "2" }, choice, FIXTURE_NOW_MS)).toBe(false);
    expect(matchesExpressionChoice(FIXTURE_READY_DRAFT, { ...choice, sha256: "0".repeat(64) }, FIXTURE_NOW_MS)).toBe(false);
    expect(matchesExpressionChoice(FIXTURE_READY_DRAFT, { ...choice, draftId: "other" }, FIXTURE_NOW_MS)).toBe(false);
    expect(expressionChoice(FIXTURE_READY_DRAFT, FIXTURE_READY_DRAFT.expiresAtMs)).toBeNull();
    expect(expressionDraftCard(fixtureManualDraft(), FIXTURE_READY_DRAFT.expiresAtMs).canUpload).toBe(false);
    expect(expressionDraftCard(FIXTURE_READY_DRAFT, FIXTURE_NOW_MS, false)).toMatchObject({ state: "settled", canApprove: false, canUpload: false, preview: null });
  });
});

describe("workspace catalogue cache", () => {
  const empty = emptyExpressionCache(FIXTURE_WORKSPACE_ID, "member");
  it("applies snapshot/delta and evicts hidden images without disturbing other rows", () => {
    const initial = applyExpressionList(empty, FIXTURE_LIST);
    expect(initial.applied).toBe(true);
    expect(empty.items).toEqual([]);
    const update = applyExpressionList(initial.cache, FIXTURE_HIDDEN_DELTA);
    expect(update.applied).toBe(true);
    expect(update.cache.items.map((item) => item.id)).not.toContain(party.id);
    expect(update.cache.items).toHaveLength(2);
    expect(update.evictImageIds).toEqual([party.id]);
    expect(applyExpressionList(update.cache, FIXTURE_LIST).applied).toBe(false);
  });
  it("rejects another workspace, a delta gap, duplicate names/ids and renames", () => {
    const current = applyExpressionList(empty, FIXTURE_LIST).cache;
    expect(applyExpressionList(current, { ...FIXTURE_LIST, workspaceId: "other" }).needsFullRefresh).toBe(true);
    const foreignEmpty = applyExpressionList(current, { ...FIXTURE_LIST, workspaceId: "other", items: [] });
    expect(foreignEmpty).toMatchObject({ applied: false, needsFullRefresh: true });
    expect(foreignEmpty.cache).toBe(current);
    expect(applyExpressionList(current, { ...FIXTURE_HIDDEN_DELTA, baseVersion: "2" }).needsFullRefresh).toBe(true);
    expect(applyExpressionList(current, { ...FIXTURE_HIDDEN_DELTA, items: [{ ...party, workspaceId: "other", version: "4" }] }).applied).toBe(false);
    expect(applyExpressionList(current, { ...FIXTURE_LIST, items: [party, party] }).applied).toBe(false);
    expect(applyExpressionList(current, { ...FIXTURE_LIST, items: [party, { ...faint, name: party.name }] }).applied).toBe(false);
    expect(applyExpressionList(current, { ...FIXTURE_HIDDEN_DELTA, items: [{ ...party, name: "new_name", version: "4" }] }).applied).toBe(false);
  });
  it("detects bigint changes without number rounding and treats reset as authoritative", () => {
    expect(compareExpressionVersions("9007199254740993", "9007199254740992")).toBeGreaterThan(0);
    expect(compareExpressionVersions("10", "9")).toBeGreaterThan(0);
    expect(() => compareExpressionVersions("01", "1")).toThrow();
    const current = applyExpressionList(empty, FIXTURE_LIST).cache;
    expect(expressionCacheNeedsRefresh(current, FIXTURE_WORKSPACE_ID, "4")).toBe(true);
    expect(expressionCacheNeedsRefresh(current, "other", "4")).toBe(false);
    expect(expressionCacheNeedsRefresh(current, FIXTURE_WORKSPACE_ID, "2")).toBe(false);
    const update = applyExpressionList(current, { ...FIXTURE_LIST, version: "4", items: [faint] });
    expect(update.cache.items).toEqual([faint]);
    expect(update.evictImageIds).toEqual([party.id, thumbs.id]);
  });
});
