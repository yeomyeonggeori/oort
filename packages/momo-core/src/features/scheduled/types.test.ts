import { describe, expect, it } from "vitest";
import { WireShapeError } from "../../lib/wire";
import {
  SCHEDULED_FAILURE_REASONS,
  SCHEDULED_STATUSES,
  isScheduledFailureReason,
  isScheduledStatus,
  parseScheduledMessage,
  parseScheduledPage,
  parseScheduledResponse,
  readFailureReason,
} from "./types";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const ID = "00000000-0000-7000-8000-0000000004a1";

// openapi `ScheduledMessage`의 필수 필드만 갖춘 가장 작은 행.
function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    workspaceId: WS,
    memberId: ME,
    channelId: CH,
    status: "pending",
    sendAtMs: 1_800_000_000_000,
    rev: 0,
    createdAtMs: 1_799_000_000_000,
    updatedAtMs: 1_799_000_000_000,
    ...overrides,
  };
}

describe("scheduled message wire types", () => {
  it("keeps the closed sets of the contract exactly: 4 statuses and 8 failure reasons", () => {
    expect([...SCHEDULED_STATUSES]).toEqual(["pending", "sent", "failed", "cancelled"]);
    expect([...SCHEDULED_FAILURE_REASONS]).toEqual([
      "sessions_ended",
      "author_inactive",
      "missed",
      "send_error",
      "not_member",
      "root_unavailable",
      "attachment_unavailable",
      "not_allowed",
    ]);
    expect(isScheduledStatus("sending")).toBe(false);
    expect(isScheduledStatus("canceled")).toBe(false);
    expect(isScheduledFailureReason("channel_archived")).toBe(false);
  });

  it("parses a pending row with every optional field the server sends", () => {
    const parsed = parseScheduledMessage(
      wire({
        rootId: "00000000-0000-7000-8000-000000000301",
        body: "자료 올려 둘게요",
        attachments: [{ id: "a1", name: "일정.pdf", mime: "application/pdf", sizeBytes: 1024 }],
        editableUntilMs: 1_799_999_970_000,
      })
    );
    expect(parsed).toEqual({
      id: ID,
      workspaceId: WS,
      memberId: ME,
      channelId: CH,
      rootId: "00000000-0000-7000-8000-000000000301",
      body: "자료 올려 둘게요",
      attachments: [{ id: "a1", name: "일정.pdf", mime: "application/pdf", sizeBytes: 1024 }],
      sendAtMs: 1_800_000_000_000,
      status: "pending",
      editableUntilMs: 1_799_999_970_000,
      rev: 0,
      createdAtMs: 1_799_000_000_000,
      updatedAtMs: 1_799_000_000_000,
    });
  });

  it("leaves absent optional fields out instead of inventing them", () => {
    const parsed = parseScheduledMessage(wire({ status: "sent", sentMessageId: "m1", sentAtMs: 5 }));
    expect(parsed).not.toBeNull();
    expect("body" in (parsed ?? {})).toBe(false);
    expect("attachments" in (parsed ?? {})).toBe(false);
    expect("failureReason" in (parsed ?? {})).toBe(false);
    expect(parsed?.sentMessageId).toBe("m1");
    expect(parsed?.sentAtMs).toBe(5);
  });

  it("rejects a row that lacks a required field or names a status outside the closed set", () => {
    for (const key of [
      "id",
      "workspaceId",
      "memberId",
      "channelId",
      "status",
      "sendAtMs",
      "rev",
      "createdAtMs",
      "updatedAtMs",
    ]) {
      const broken = wire();
      delete broken[key];
      expect(parseScheduledMessage(broken), `without ${key}`).toBeNull();
    }
    expect(parseScheduledMessage(wire({ status: "sending" }))).toBeNull();
    expect(parseScheduledMessage(wire({ sendAtMs: "1800000000000" }))).toBeNull();
    expect(parseScheduledMessage(null)).toBeNull();
    expect(parseScheduledMessage("x")).toBeNull();
  });

  it("rejects a row whose attachment lost a field rather than showing a nameless file", () => {
    expect(
      parseScheduledMessage(wire({ attachments: [{ id: "a1", mime: "text/plain", sizeBytes: 1 }] }))
    ).toBeNull();
  });

  it("reads an unknown failure reason as not_allowed so a newer server never blanks the list", () => {
    expect(readFailureReason("sessions_ended")).toBe("sessions_ended");
    expect(readFailureReason("something_new")).toBe("not_allowed");
    expect(readFailureReason(undefined)).toBeUndefined();
    expect(readFailureReason(7)).toBeUndefined();
    const parsed = parseScheduledMessage(wire({ status: "failed", failureReason: "something_new" }));
    expect(parsed?.failureReason).toBe("not_allowed");
  });

  it("unwraps the single-row response and throws on a malformed one", () => {
    expect(parseScheduledResponse({ scheduledMessage: wire() }).id).toBe(ID);
    expect(() => parseScheduledResponse({ scheduledMessage: wire({ status: "weird" }) })).toThrow(
      WireShapeError
    );
    expect(() => parseScheduledResponse({})).toThrow(WireShapeError);
    expect(() => parseScheduledResponse(null)).toThrow(WireShapeError);
  });

  it("parses a page with its cursor and throws when one row is unreadable", () => {
    const page = parseScheduledPage({
      scheduledMessages: [wire(), wire({ id: "00000000-0000-7000-8000-0000000004a2" })],
      nextCursor: "00000000-0000-7000-8000-0000000004a2",
    });
    expect(page.scheduledMessages).toHaveLength(2);
    expect(page.nextCursor).toBe("00000000-0000-7000-8000-0000000004a2");
    expect(parseScheduledPage({ scheduledMessages: [] })).toEqual({ scheduledMessages: [] });
    expect(() => parseScheduledPage({ scheduledMessages: [wire(), { id: "x" }] })).toThrow(
      WireShapeError
    );
    expect(() => parseScheduledPage({ reminders: [] })).toThrow(WireShapeError);
  });
});
