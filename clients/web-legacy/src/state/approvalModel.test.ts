import { describe, expect, it } from "vitest";
import type { TimelineMessage } from "../timeline/model";
import {
  approvalActionType,
  approvalCardModel,
  approvalRequestedBy,
  parseApprovalStatus,
  resolveApprovalStatus,
} from "./approvalModel";

function approvalMessage(
  props: Record<string, unknown>
): TimelineMessage {
  return {
    id: "message-1",
    seq: 1,
    type: "approval_request",
    body: "파일 변경을 승인해 주세요.",
    authorMemberId: "agent-1",
    createdAtMs: 1,
    props,
  };
}

describe("approval card state machine", () => {
  it("consumes approval_status as the canonical cold-load status", () => {
    const card = approvalCardModel(
      approvalMessage({
        approval_id: "approval-1",
        approval_status: "approved",
        status: "pending",
      })
    );
    expect(card?.status).toBe("approved");
  });

  it("falls back to legacy status when approval_status is absent", () => {
    expect(
      approvalCardModel(
        approvalMessage({ approval_id: "approval-1", status: "rejected" })
      )?.status
    ).toBe("rejected");
  });

  it("renders a resume offer without an approval id", () => {
    const card = approvalCardModel(
      approvalMessage({ kind: "resume_offer", status: "pending" })
    );
    expect(card).toMatchObject({
      approvalId: null,
      isResumeOffer: true,
      status: "pending",
    });
  });

  it("rejects malformed ordinary approval cards", () => {
    expect(approvalCardModel(approvalMessage({ status: "pending" }))).toBeNull();
  });

  it("lets a realtime settled status beat stale pending props", () => {
    expect(resolveApprovalStatus("expired", "pending")).toBe("expired");
  });

  it("lets settled cold-load props beat a stale pending projection", () => {
    expect(resolveApprovalStatus("pending", "approved")).toBe("approved");
  });

  it("rejects unknown status values", () => {
    expect(parseApprovalStatus("running")).toBeNull();
  });
});

// #1176: the two servers in the tree answer this endpoint in two notations.
// These rows are the real wire shapes, trimmed to the fields the panel reads.
describe("approval projection notation (#1176)", () => {
  const rustRow = {
    id: "approval-1",
    actionType: "tool_call",
    requestedBy: "member-agent-1",
  };
  const swiftRow = {
    id: "approval-1",
    action_type: "tool_call",
    requested_by: "member-agent-1",
  };

  it("reads the deployed Rust api's camelCase row", () => {
    expect(approvalActionType(rustRow)).toBe("tool_call");
    expect(approvalRequestedBy(rustRow)).toBe("member-agent-1");
  });

  it("still reads the Swift e2e server's snake_case row", () => {
    expect(approvalActionType(swiftRow)).toBe("tool_call");
    expect(approvalRequestedBy(swiftRow)).toBe("member-agent-1");
  });

  it("prefers the deployed notation when a row carries both", () => {
    expect(
      approvalRequestedBy({
        requestedBy: "member-camel",
        requested_by: "member-snake",
      })
    ).toBe("member-camel");
  });

  it("reports absence instead of a name the caller would index by", () => {
    // The panel must be able to tell "no requester" from a member id, because
    // displayNameFor() lowercases whatever it is handed.
    expect(approvalRequestedBy({ id: "approval-1" })).toBeUndefined();
    expect(approvalRequestedBy({ requestedBy: "" })).toBeUndefined();
    expect(approvalRequestedBy({ requestedBy: 7 })).toBeUndefined();
    expect(approvalActionType(null)).toBeUndefined();
    expect(approvalActionType("approval-1")).toBeUndefined();
  });
});
