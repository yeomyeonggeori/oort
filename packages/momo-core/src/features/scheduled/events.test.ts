import { describe, expect, it } from "vitest";
import {
  EMPTY_SCHEDULED_STORE,
  SCHEDULED_MESSAGE_EVENT,
  applyScheduledEvent,
  applyScheduledList,
  applyScheduledRow,
  asScheduledMessageFrame,
  isScheduledStub,
  removeScheduledRow,
  type ScheduledMessageFrame,
  type ScheduledStore,
} from "./events";
import { needsReview, scheduledBanner, scheduledNavEntry, scheduledSections, scheduledTotals } from "./model";
import type { ScheduledMessage } from "./types";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const CH2 = "00000000-0000-7000-8000-000000000202";
const ID = "00000000-0000-7000-8000-0000000004a1";
const ID2 = "00000000-0000-7000-8000-0000000004a2";
const SEND_AT = 1_800_000_000_000;

function row(overrides: Partial<ScheduledMessage> = {}): ScheduledMessage {
  return {
    id: ID,
    workspaceId: WS,
    memberId: ME,
    channelId: CH,
    body: "금요일 배포 공지",
    sendAtMs: SEND_AT,
    status: "pending",
    editableUntilMs: SEND_AT - 30_000,
    rev: 0,
    createdAtMs: SEND_AT - 86_400_000,
    updatedAtMs: SEND_AT - 86_400_000,
    ...overrides,
  };
}

// 와이어 그대로: 대문자 UUID, snake_case 페이로드, 본문 없음.
function frameWire(payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    type: SCHEDULED_MESSAGE_EVENT,
    v: 1,
    ts: 1_799_999_000_000,
    payload: {
      workspace_id: WS.toUpperCase(),
      member_id: ME.toUpperCase(),
      scheduled_message_id: ID.toUpperCase(),
      channel_id: CH.toUpperCase(),
      status: "pending",
      send_at_ms: SEND_AT,
      rev: 1,
      ...payload,
    },
    ...extra,
  };
}

function frame(overrides: Partial<ScheduledMessageFrame> = {}): ScheduledMessageFrame {
  return {
    workspaceId: WS.toUpperCase(),
    memberId: ME.toUpperCase(),
    scheduledMessageId: ID.toUpperCase(),
    channelId: CH.toUpperCase(),
    status: "pending",
    sendAtMs: SEND_AT,
    rev: 1,
    ...overrides,
  };
}

function storeOf(...rows: ScheduledMessage[]): ScheduledStore {
  return applyScheduledList(EMPTY_SCHEDULED_STORE, rows);
}

describe("asScheduledMessageFrame", () => {
  it("reads a frame exactly as the server writes it (uppercase ids, snake_case, ids and times only)", () => {
    expect(asScheduledMessageFrame(frameWire())).toEqual({
      workspaceId: WS.toUpperCase(),
      memberId: ME.toUpperCase(),
      scheduledMessageId: ID.toUpperCase(),
      channelId: CH.toUpperCase(),
      status: "pending",
      sendAtMs: SEND_AT,
      rev: 1,
      tsMs: 1_799_999_000_000,
    });
  });

  it("carries the failure reason of a failed frame and the sent message of a sent one", () => {
    expect(
      asScheduledMessageFrame(frameWire({ status: "failed", failure_reason: "sessions_ended", rev: 2 }))
    ).toMatchObject({ status: "failed", failureReason: "sessions_ended", rev: 2 });
    expect(
      asScheduledMessageFrame(frameWire({ status: "sent", sent_message_id: "M1".padEnd(36, "0"), rev: 3 }))
    ).toMatchObject({ status: "sent", sentMessageId: "M1".padEnd(36, "0") });
    // 모르는 사유는 not_allowed로 읽는다.
    expect(asScheduledMessageFrame(frameWire({ status: "failed", failure_reason: "new_reason" }))).toMatchObject({
      failureReason: "not_allowed",
    });
  });

  it("reads the timestamp whether it is epoch milliseconds or a date string, and omits it otherwise", () => {
    expect(asScheduledMessageFrame(frameWire({}, { ts: "2026-10-22T12:00:00.000Z" }))?.tsMs).toBe(
      Date.parse("2026-10-22T12:00:00.000Z")
    );
    expect(asScheduledMessageFrame(frameWire({}, { ts: "not a date" }))).not.toHaveProperty("tsMs");
    expect(asScheduledMessageFrame(frameWire({}, { ts: undefined }))).not.toHaveProperty("tsMs");
  });

  it("returns null for a frame of another type, so inbox and read-state frames are left to their own readers", () => {
    expect(asScheduledMessageFrame({ type: "inbox_item.created", payload: { item_id: "X" } })).toBeNull();
    expect(asScheduledMessageFrame({ type: "read_state.updated" })).toBeNull();
    expect(asScheduledMessageFrame({ ...frameWire(), type: "scheduled.updated" })).toBeNull();
  });

  it("returns null for an unknown shape instead of guessing", () => {
    for (const key of [
      "workspace_id",
      "member_id",
      "scheduled_message_id",
      "channel_id",
      "status",
      "send_at_ms",
      "rev",
    ]) {
      const wire = frameWire();
      delete (wire.payload as Record<string, unknown>)[key];
      expect(asScheduledMessageFrame(wire), `without ${key}`).toBeNull();
    }
    expect(asScheduledMessageFrame(frameWire({ status: "sending" }))).toBeNull();
    expect(asScheduledMessageFrame(frameWire({ rev: 1.5 }))).toBeNull();
    expect(asScheduledMessageFrame(frameWire({ rev: -1 }))).toBeNull();
    expect(asScheduledMessageFrame(frameWire({ rev: "1" }))).toBeNull();
    expect(asScheduledMessageFrame(frameWire({ send_at_ms: "soon" }))).toBeNull();
    expect(asScheduledMessageFrame({ type: SCHEDULED_MESSAGE_EVENT })).toBeNull();
    expect(asScheduledMessageFrame("x")).toBeNull();
    expect(asScheduledMessageFrame(null)).toBeNull();
  });
});

describe("rev order (ADR-0208 D12)", () => {
  it("ignores a duplicate delivery of the same rev and an older rev", () => {
    const store = storeOf(row({ rev: 3 }));
    const same = applyScheduledEvent(store, frame({ rev: 3, status: "failed", failureReason: "missed" }));
    expect(same.store).toBe(store);
    expect(same.refetch).toBe(false);
    const older = applyScheduledEvent(store, frame({ rev: 2, status: "failed", failureReason: "missed" }));
    expect(older.store).toBe(store);
    expect(older.refetch).toBe(false);
    expect(store.rows[0]?.status).toBe("pending");
  });

  it("applies a larger rev and asks for a re-read, because the event carries no text", () => {
    const store = storeOf(row({ rev: 1 }));
    const next = applyScheduledEvent(store, frame({ rev: 2, sendAtMs: SEND_AT + 3_600_000 }));
    expect(next.refetch).toBe(true);
    expect(next.store.rows).toHaveLength(1);
    expect(next.store.rows[0]).toMatchObject({
      id: ID,
      rev: 2,
      sendAtMs: SEND_AT + 3_600_000,
      editableUntilMs: SEND_AT + 3_600_000 - 30_000,
      body: "금요일 배포 공지",
    });
  });

  it("keeps events in order even when they arrive reversed: rev 3 then a late rev 2", () => {
    const base = storeOf(row({ rev: 1 }));
    const afterThree = applyScheduledEvent(base, frame({ rev: 3, status: "failed", failureReason: "missed" })).store;
    const afterLate = applyScheduledEvent(afterThree, frame({ rev: 2, status: "pending" }));
    expect(afterLate.store).toBe(afterThree);
    expect(afterLate.store.rows[0]).toMatchObject({ status: "failed", failureReason: "missed", rev: 3 });
  });

  it("treats ids that differ only in letter case as the same row, not a second one", () => {
    const store = storeOf(row({ id: ID.toLowerCase(), rev: 1 }));
    const next = applyScheduledEvent(store, frame({ scheduledMessageId: ID.toUpperCase(), rev: 2 }));
    expect(next.store.rows).toHaveLength(1);
    expect(next.store.rows[0]?.rev).toBe(2);
    // 같은 대소문자 차이로 옛 rev가 새 행으로 둔갑하지도 않는다.
    const stale = applyScheduledEvent(next.store, frame({ scheduledMessageId: ID.toUpperCase(), rev: 2 }));
    expect(stale.store).toBe(next.store);
  });

  it("moves a row out of failed when a later event says it is pending again, and clears the failure", () => {
    const failed = storeOf(row({ status: "failed", failureReason: "missed", editableUntilMs: undefined, rev: 2 }));
    const rearmed = applyScheduledEvent(
      failed,
      frame({ rev: 3, status: "pending", sendAtMs: SEND_AT + 86_400_000 })
    ).store.rows[0];
    expect(rearmed?.status).toBe("pending");
    expect("failureReason" in (rearmed ?? {})).toBe(false);
    expect(rearmed?.editableUntilMs).toBe(SEND_AT + 86_400_000 - 30_000);
  });
});

describe("closed rows leave a tombstone", () => {
  it("removes a sent or cancelled row and asks for nothing", () => {
    const store = storeOf(row({ rev: 1 }));
    for (const status of ["sent", "cancelled"] as const) {
      const next = applyScheduledEvent(store, frame({ rev: 2, status }));
      expect(next.store.rows).toHaveLength(0);
      expect(next.refetch).toBe(false);
    }
  });

  it("does not let a late older pending event bring a sent row back", () => {
    const sent = applyScheduledEvent(storeOf(row({ rev: 1 })), frame({ rev: 3, status: "sent" })).store;
    const late = applyScheduledEvent(sent, frame({ rev: 2, status: "pending" }));
    expect(late.store.rows).toHaveLength(0);
    expect(late.refetch).toBe(false);
  });

  it("does not let an old list snapshot bring a closed row back either", () => {
    const sent = applyScheduledEvent(storeOf(row({ rev: 1 })), frame({ rev: 3, status: "sent" })).store;
    const stale = applyScheduledList(sent, [row({ rev: 1 })]);
    expect(stale.rows).toHaveLength(0);
  });

  it("remembers a row it has never seen as closed, so its older events are ignored", () => {
    const closedFirst = applyScheduledEvent(EMPTY_SCHEDULED_STORE, frame({ rev: 5, status: "cancelled" })).store;
    const older = applyScheduledEvent(closedFirst, frame({ rev: 4, status: "pending" }));
    expect(older.store.rows).toHaveLength(0);
  });

  it("forgets a deleted row for good: no event for it can bring it back", () => {
    const deleted = removeScheduledRow(storeOf(row({ rev: 1 })), ID.toUpperCase());
    expect(deleted.rows).toHaveLength(0);
    expect(applyScheduledEvent(deleted, frame({ rev: 999, status: "pending" })).store.rows).toHaveLength(0);
  });
});

describe("an event for a row the client has not read yet", () => {
  it("stands up a body-less stub, so counts are right at once, and asks for a re-read", () => {
    const next = applyScheduledEvent(EMPTY_SCHEDULED_STORE, frame({ rev: 0, status: "pending" }));
    expect(next.refetch).toBe(true);
    expect(next.store.rows).toHaveLength(1);
    const stub = next.store.rows[0];
    // 와이어는 대문자지만 뼈대 행은 REST와 같은 소문자 id로 선다.
    expect(stub).toMatchObject({
      id: ID,
      workspaceId: WS,
      memberId: ME,
      channelId: CH,
      status: "pending",
      sendAtMs: SEND_AT,
      rev: 0,
      editableUntilMs: SEND_AT - 30_000,
    });
    expect(stub !== undefined && isScheduledStub(stub)).toBe(true);
    expect(stub !== undefined && "body" in stub).toBe(false);
    expect(scheduledTotals(next.store.rows)).toEqual({ total: 1, pending: 1, failed: 0 });
  });

  it("lets the read that follows fill the stub in at the same rev", () => {
    const stubbed = applyScheduledEvent(EMPTY_SCHEDULED_STORE, frame({ rev: 1 })).store;
    const filled = applyScheduledList(stubbed, [row({ id: ID.toLowerCase(), rev: 1 })]);
    expect(filled.rows).toHaveLength(1);
    expect(filled.rows[0]?.body).toBe("금요일 배포 공지");
    expect(filled.rows[0] !== undefined && isScheduledStub(filled.rows[0])).toBe(false);
  });

  it("stands up a failed stub with its reason from a frame", () => {
    const next = applyScheduledEvent(
      EMPTY_SCHEDULED_STORE,
      frame({ rev: 2, status: "failed", failureReason: "sessions_ended" })
    );
    expect(next.store.rows[0]).toMatchObject({ status: "failed", failureReason: "sessions_ended" });
    expect(next.store.rows[0]?.editableUntilMs).toBeUndefined();
  });
});

describe("responses of my own writes and the list merge by the same rule", () => {
  it("keeps the newer row when a stale response arrives, and replaces on an equal or newer rev", () => {
    const store = storeOf(row({ rev: 4, body: "최신" }));
    expect(applyScheduledRow(store, row({ rev: 3, body: "낡음" }))).toBe(store);
    expect(applyScheduledRow(store, row({ rev: 4, body: "같은 rev" })).rows[0]?.body).toBe("같은 rev");
    expect(applyScheduledRow(store, row({ rev: 5, body: "새것" })).rows[0]?.body).toBe("새것");
  });

  it("closes a row whose response says sent, and does not reopen it later", () => {
    const store = storeOf(row({ rev: 1 }));
    const sent = applyScheduledRow(store, row({ status: "sent", rev: 2, sentMessageId: "m1" }));
    expect(sent.rows).toHaveLength(0);
    expect(applyScheduledRow(sent, row({ rev: 1 })).rows).toHaveLength(0);
  });

  it("adds a freshly created row, and a second create with another id sits beside it", () => {
    const first = applyScheduledRow(EMPTY_SCHEDULED_STORE, row());
    const both = applyScheduledRow(first, row({ id: ID2, sendAtMs: SEND_AT + 60_000 }));
    expect(both.rows.map((entry) => entry.id)).toEqual([ID, ID2]);
  });

  it("does not let an older snapshot undo what an event already advanced (the larger rev wins)", () => {
    const advanced = applyScheduledEvent(
      storeOf(row({ rev: 1 })),
      frame({ rev: 2, status: "failed", failureReason: "missed" })
    ).store;
    const merged = applyScheduledList(advanced, [row({ rev: 1 })]);
    expect(merged.rows[0]).toMatchObject({ status: "failed", failureReason: "missed", rev: 2 });
  });

  it("drops a row the authoritative open list no longer has, and keeps the rest", () => {
    const store = storeOf(row(), row({ id: ID2, sendAtMs: SEND_AT + 60_000 }));
    const next = applyScheduledList(store, [row({ id: ID2, sendAtMs: SEND_AT + 60_000 })]);
    expect(next.rows.map((entry) => entry.id)).toEqual([ID2]);
  });
});

describe("a pending row held for sessions_ended shows at once (owner decision 6)", () => {
  it("moves into the failed section, the failed banner and the sidebar pill the moment the event arrives, before any re-read", () => {
    // 읽어 둔 대기 예약 둘: 하나는 이 채널, 하나는 다른 채널.
    const store = storeOf(row({ rev: 0 }), row({ id: ID2, channelId: CH2, sendAtMs: SEND_AT + 60_000 }));
    expect(scheduledBanner(store.rows, { channelId: CH })).toEqual({ tone: "pending", count: 1 });
    expect(scheduledNavEntry(store.rows)).toEqual({ visible: true, failedCount: 0, badgeLabel: null });

    // 비밀번호 변경으로 세션이 끝나 서버가 대기 예약을 멈췄다. 이벤트는 본문 없이 도착한다.
    const arrived = applyScheduledEvent(
      store,
      frame({ rev: 1, status: "failed", failureReason: "sessions_ended" })
    );

    // 재조회가 끝나기 전, 이벤트만으로 화면의 세 자리가 바뀐다.
    const sections = scheduledSections(arrived.store.rows);
    expect(sections.failed.map((entry) => entry.id)).toEqual([ID]);
    expect(sections.pending.map((entry) => entry.id)).toEqual([ID2]);
    expect(scheduledBanner(arrived.store.rows, { channelId: CH })).toEqual({ tone: "failed", count: 1 });
    expect(scheduledNavEntry(arrived.store.rows)).toEqual({
      visible: true,
      failedCount: 1,
      badgeLabel: "보내지 못한 예약 1개",
    });
    // 한 번 눌러 나가지 않는 행이다: 내용 확인을 거쳐야 한다. 본문은 재조회가 채운다.
    const held = sections.failed[0];
    expect(held !== undefined && needsReview(held)).toBe(true);
    expect(arrived.refetch).toBe(true);
    expect(held?.body).toBe("금요일 배포 공지");
  });

  it("does the same when the held row was never read, from the stub alone", () => {
    const arrived = applyScheduledEvent(
      EMPTY_SCHEDULED_STORE,
      frame({ rev: 4, status: "failed", failureReason: "sessions_ended" })
    );
    expect(scheduledBanner(arrived.store.rows, { channelId: CH })).toEqual({ tone: "failed", count: 1 });
    expect(scheduledNavEntry(arrived.store.rows).failedCount).toBe(1);
    expect(scheduledSections(arrived.store.rows).failed).toHaveLength(1);
    const held = arrived.store.rows[0];
    expect(held !== undefined && needsReview(held)).toBe(true);
    expect(held !== undefined && isScheduledStub(held)).toBe(true);
  });
});
