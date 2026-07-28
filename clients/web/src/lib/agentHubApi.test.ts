import { describe, expect, it } from "vitest";
import {
  agentRunSummaryPageFromWire,
  memoryGrantPageFromWire,
  memoryPageFromWire,
  memorySearchFromWire,
} from "./api";
import { WireShapeError } from "./wire";

const memory = {
  id: "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAAAAA",
  workspaceId: "BBBBBBBB-BBBB-7BBB-8BBB-BBBBBBBBBBBB",
  scope: "agent",
  agentMemberId: "CCCCCCCC-CCCC-7CCC-8CCC-CCCCCCCCCCCC",
  kind: "preference",
  body: "긴 답변보다 검증 근거를 먼저 보여 주세요.",
  confidence: 0.9,
  validAtMs: 100,
  createdByKind: "human",
  createdByMemberId: "DDDDDDDD-DDDD-7DDD-8DDD-DDDDDDDDDDDD",
  createdAtMs: 100,
  updatedAtMs: 100,
  sourceRefs: [{
    messageId: "EEEEEEEE-EEEE-7EEE-8EEE-EEEEEEEEEEEE",
    channelId: "FFFFFFFF-FFFF-7FFF-8FFF-FFFFFFFFFFFF",
  }],
};

describe("agent hub REST decoders", () => {
  it("normalizes every UUID in memory and history pages to lower case", () => {
    const memories = memoryPageFromWire({ memories: [memory] });
    expect(memories[0].id).toBe(memory.id.toLowerCase());
    expect(memories[0].agentMemberId).toBe(memory.agentMemberId.toLowerCase());
    expect(memories[0].sourceRefs[0].channelId).toBe(
      memory.sourceRefs[0].channelId.toLowerCase()
    );

    const page = agentRunSummaryPageFromWire({
      runs: [{
        id: "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAAA01",
        channelId: "BBBBBBBB-BBBB-7BBB-8BBB-BBBBBBBBBB01",
        triggerMessageId: "CCCCCCCC-CCCC-7CCC-8CCC-CCCCCCCCCC01",
        triggerSummary: "MOMO-652 gate",
        status: "running",
        createdAtMs: 1,
        updatedAtMs: 2,
      }],
      nextCursor: "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAAA01",
    });
    expect(page.runs[0].id).toBe("aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaa01");
    expect(page.nextCursor).toBe("aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaa01");
  });

  it("keeps list zero, search zero, and malformed responses distinct", () => {
    expect(memoryPageFromWire({ memories: [] })).toEqual([]);
    expect(memorySearchFromWire({ hits: [] })).toEqual([]);
    expect(() => memoryPageFromWire({ memories: null })).toThrow(WireShapeError);
    expect(() => memorySearchFromWire({ hits: [{}] })).toThrow(WireShapeError);
  });

  it("reads active and revoked visibility grants without coercion", () => {
    const grants = memoryGrantPageFromWire({
      grants: [{
        id: "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAAA02",
        workspaceId: memory.workspaceId,
        memoryId: memory.id,
        granteeKind: "agent",
        granteeId: memory.agentMemberId,
        grantedBy: memory.createdByMemberId,
        createdAtMs: 1,
        revokedAtMs: 2,
      }],
    });
    expect(grants[0]).toMatchObject({
      granteeKind: "agent",
      granteeId: memory.agentMemberId.toLowerCase(),
      revokedAtMs: 2,
    });
    expect(() =>
      memoryGrantPageFromWire({
        grants: [{ ...grants[0], granteeKind: "workspace" }],
      })
    ).toThrow(WireShapeError);
  });
});
