import { describe, expect, it } from "vitest";
import { assertExpressionContract, matchesExpressionContract } from "./contracts";
import { FIXTURE_APPROVAL, FIXTURE_CHANNEL_ID, FIXTURE_EXPRESSIONS, FIXTURE_HIDDEN_DELTA, FIXTURE_LIST, FIXTURE_MEDIA_SET, FIXTURE_READY_DRAFT, FIXTURE_RESULT, fixtureManualDraft } from "./fixtures";
import { expressionChoice } from "./cards";
import { MANUAL_UPLOAD_CODES } from "./types";

const choice = expressionChoice(FIXTURE_READY_DRAFT, 0)!;
const metadata = { name: "happy_dance", displayName: "신나는 춤", tags: ["축하"], subjectMemberId: null };
const candidate = { ...metadata, image: { source: "url", url: "https://giphy.com/gifs/example" } };
const action = { action: "expression.create", args: { candidates: [candidate] } };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("ADR-0218 closed wire-schema fixture assertions", () => {
  it("accepts every canonical response and failed-fetch variant", () => {
    for (const value of FIXTURE_EXPRESSIONS) assertExpressionContract("Expression", value);
    assertExpressionContract("List", FIXTURE_LIST);
    assertExpressionContract("List", FIXTURE_HIDDEN_DELTA);
    assertExpressionContract("Media", FIXTURE_MEDIA_SET);
    assertExpressionContract("Draft", FIXTURE_READY_DRAFT);
    for (const code of MANUAL_UPLOAD_CODES) assertExpressionContract("Draft", fixtureManualDraft(code));
    assertExpressionContract("Approval", FIXTURE_APPROVAL);
    assertExpressionContract("Result", FIXTURE_RESULT);
    assertExpressionContract("Choice", choice);
    assertExpressionContract("Decision", { expressionChoice: choice });
    assertExpressionContract("MessageInput", { body: ":party_parrot:" });
    assertExpressionContract("Mutation", { workspaceId: FIXTURE_LIST.workspaceId, version: "3", expression: FIXTURE_EXPRESSIONS[0] });
    assertExpressionContract("ImportRequest", { ...metadata, url: "https://giphy.com/gifs/example" });
    assertExpressionContract("AttachmentRequest", { ...metadata, attachmentId: FIXTURE_EXPRESSIONS[0].id, channelId: FIXTURE_CHANNEL_ID });
    expect(matchesExpressionContract("AttachmentRequest", { ...metadata, attachmentId: FIXTURE_EXPRESSIONS[0].id })).toBe(false);
    assertExpressionContract("Changed", { type: "expression.changed", workspaceId: FIXTURE_LIST.workspaceId, version: "3" });
    assertExpressionContract("Patch", { displayName: "새 표시 이름" });
    assertExpressionContract("ReportRequest", { reason: "face", detail: "내 얼굴이에요" });
  });
  it("accepts attachment, generated and GIF-site agent sources with 1–4 candidates", () => {
    const candidates = [candidate,
      { ...candidate, image: { source: "attachment", attachmentId: FIXTURE_EXPRESSIONS[0].id } },
      { ...candidate, image: { source: "generated", mime: "image/png", dataBase64: "AAAA", prompt: "춤추는 새" } }, candidate];
    assertExpressionContract("AgentAction", { ...action, args: { candidates } });
    assertExpressionContract("AgentAction", action);
    for (const url of ["https://tenor.com/view/example", "https://media.giphy.com/media/example/giphy.gif"]) assertExpressionContract("AgentAction", { ...action, args: { candidates: [{ ...candidate, image: { source: "url", url } }] } });
  });
  it("rejects hidden bytes, broken state unions, wrong casing and extra fields", () => {
    expect(matchesExpressionContract("Expression", { ...FIXTURE_EXPRESSIONS[0], status: "hidden" })).toBe(false);
    expect(matchesExpressionContract("Expression", { ...FIXTURE_EXPRESSIONS[0], media: null })).toBe(false);
    expect(matchesExpressionContract("Draft", { ...FIXTURE_READY_DRAFT, state: "manual_upload_required" })).toBe(false);
    expect(matchesExpressionContract("Draft", { ...fixtureManualDraft(), code: "unknown" })).toBe(false);
    expect(matchesExpressionContract("Draft", { ...FIXTURE_READY_DRAFT, downloadUrl: "https://bad.example" })).toBe(false);
    expect(matchesExpressionContract("Expression", { ...FIXTURE_EXPRESSIONS[0], name: "UpperCase" })).toBe(false);
    expect(matchesExpressionContract("Metadata", { ...metadata, name: "a".repeat(31) })).toBe(false);
    expect(matchesExpressionContract("Patch", { name: "rename" })).toBe(false);
    expect(matchesExpressionContract("Patch", {})).toBe(false);
    expect(matchesExpressionContract("MessageInput", { body: ":party_parrot:", sticker: { id: FIXTURE_EXPRESSIONS[0].id } })).toBe(false);
  });
  it("rejects missing required fields, floating timestamps, numeric versions and mismatched reset", () => {
    const draft: Record<string, unknown> = { ...copy(FIXTURE_READY_DRAFT) };
    delete draft.origin;
    expect(matchesExpressionContract("Draft", draft)).toBe(false);
    expect(matchesExpressionContract("Draft", { ...FIXTURE_READY_DRAFT, expiresAtMs: 1.5 })).toBe(false);
    expect(matchesExpressionContract("List", { ...FIXTURE_LIST, version: 3 })).toBe(false);
    expect(matchesExpressionContract("List", { ...FIXTURE_LIST, baseVersion: "2" })).toBe(false);
    expect(matchesExpressionContract("Choice", { ...choice, revision: "01" })).toBe(false);
  });
  it("rejects sources that could bypass server-owned provenance or media limits", () => {
    for (const image of [
      { source: "url", url: "http://tenor.com/image.gif" },
      { source: "url", url: "https://user:pass@example.org/image.gif" },
      { source: "url", url: "https://example.org/image.gif", sha256: "0".repeat(64) },
      { source: "generated", mime: "image/svg+xml", dataBase64: "AAAA", prompt: "hi" },
      { source: "generated", mime: "image/png", dataBase64: "@@@=", prompt: "hi" },
      { source: "generated", mime: "image/png", dataBase64: "AAAA" },
    ]) expect(matchesExpressionContract("AgentAction", { ...action, args: { candidates: [{ ...candidate, image }] } })).toBe(false);
    for (const sourceUrl of ["https://giphy.com/gifs/example?token=secret", "https://user:pass@example.org/file", "javascript:alert(1)"]) expect(matchesExpressionContract("Origin", { kind: "url", sourceUrl, prompt: null })).toBe(false);
    const invalid = copy(FIXTURE_MEDIA_SET);
    invalid.small.width = 129;
    expect(matchesExpressionContract("Media", invalid)).toBe(false);
    invalid.small.width = 128; invalid.small.bytes = 262145;
    expect(matchesExpressionContract("Media", invalid)).toBe(false);
    invalid.small.bytes = 100; invalid.large.frameCount = 101;
    expect(matchesExpressionContract("Media", invalid)).toBe(false);
    invalid.large.frameCount = 2; invalid.large.durationMs = 10001;
    expect(matchesExpressionContract("Media", invalid)).toBe(false);
    invalid.large.durationMs = 200; invalid.thumb.mime = "image/gif";
    expect(matchesExpressionContract("Media", invalid)).toBe(false);
  });
  it("rejects more than four candidates and semantic metadata bounds", () => {
    expect(matchesExpressionContract("AgentAction", { ...action, args: { candidates: [] } })).toBe(false);
    expect(matchesExpressionContract("AgentAction", { ...action, args: { candidates: Array(5).fill(candidate) } })).toBe(false);
    expect(matchesExpressionContract("AgentAction", { ...action, args: { ...action.args, bypassApproval: true } })).toBe(false);
    expect(matchesExpressionContract("Metadata", { ...metadata, tags: Array(9).fill("tag") })).toBe(false);
    expect(matchesExpressionContract("Metadata", { ...metadata, tags: ["중복", "중복"] })).toBe(false);
    expect(matchesExpressionContract("Metadata", { ...metadata, tags: ["가".repeat(17)] })).toBe(false);
    expect(matchesExpressionContract("Metadata", { ...metadata, displayName: "<admin>" })).toBe(false);
    expect(() => assertExpressionContract("Draft", { ...FIXTURE_READY_DRAFT, media: null })).toThrow("Invalid expression contract: Draft");
  });
});
