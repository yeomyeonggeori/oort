import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import {
  deleteFailureMessage,
  editFailureMessage,
  genericActionFailureMessage,
  reactionFailureMessage,
  replyFailureMessage,
} from "./actionCopy";

// The exact sentences the message routes answer with. They are the right thing
// to log and the wrong thing to put under someone's message, and this file is
// the boundary that guarantees they never cross it (B8).
const WIRE_SENTENCES = [
  "only the message author may edit",
  "only the message author may delete",
  "not a member of this channel",
  "message not found",
  "deleted messages cannot be edited",
  "deleted messages cannot receive reactions",
  "message reaction limit reached",
  "thread root must be a top-level message",
];

const MAPPERS = [
  editFailureMessage,
  deleteFailureMessage,
  reactionFailureMessage,
  replyFailureMessage,
];

describe("message action failure copy", () => {
  /**
   * The rule, asserted mechanically rather than trusted: whatever the server
   * said, and whatever status it said it with, the string that reaches the
   * screen is Korean and is not the wire sentence.
   */
  it("never lets a wire sentence or a raw status reach the screen", () => {
    const statuses = [400, 401, 403, 404, 409, 429, 500, 503];
    for (const mapper of MAPPERS) {
      for (const status of statuses) {
        for (const wire of WIRE_SENTENCES) {
          const copy = mapper(new ApiError(status, wire));
          expect(copy).not.toContain(wire);
          expect(copy).not.toMatch(/HTTP \d/);
          expect(copy).not.toMatch(/^\d{3}\b/);
          // Every sentence ends as a sentence, in Korean.
          expect(copy).toMatch(/[가-힣]/);
          expect(copy.endsWith(".")).toBe(true);
        }
      }
    }
  });

  it("answers the same way for a non-ApiError as for an unmapped status", () => {
    for (const mapper of MAPPERS) {
      const thrown = mapper(new Error("TypeError: fetch failed"));
      expect(thrown).not.toContain("fetch");
      expect(thrown).toBe(mapper(new ApiError(500, "internal server error")));
      // …and an entirely non-Error rejection is handled too.
      expect(mapper(undefined)).toBe(thrown);
    }
  });

  /**
   * Each status a click can actually provoke gets its OWN sentence. Collapsing
   * them into one generic line is the tempting simplification and the wrong
   * one: "고칠 수 없습니다" tells someone nothing, while "내가 보낸 메시지만"
   * tells them the rule.
   */
  it("distinguishes the statuses a person can actually provoke", () => {
    const edit = [403, 404, 400].map((s) =>
      editFailureMessage(new ApiError(s, "x"))
    );
    expect(new Set(edit).size).toBe(edit.length);

    expect(reactionFailureMessage(new ApiError(409, "x"))).toContain("200");
    expect(editFailureMessage(new ApiError(403, "x"))).toContain("내가 보낸");
    expect(deleteFailureMessage(new ApiError(403, "x"))).toContain("내가 보낸");
  });

  it("keeps one shared fallback line rather than four near-identical ones", () => {
    expect(genericActionFailureMessage).toMatch(/다시 시도/);
  });
});
