import { describe, expect, it } from "vitest";
import type { TimelineMessage } from "../timeline/model";
import {
  approvalCardModel,
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
