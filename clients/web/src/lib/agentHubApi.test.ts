import { describe, expect, it } from "vitest";
import {
  agentRunSummaryPageFromWire,
  channelMembershipFromWire,
  createdAgentFromWire,
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

describe("에이전트 만들기 · 채널 배치 REST decoders", () => {
  it("만들기 응답의 id를 접고, 사람이 정한 이름은 건드리지 않는다", () => {
    const created = createdAgentFromWire({
      agent: {
        id: "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAAA10",
        handle: "kim-intern",
        displayName: "김인턴",
      },
    });
    // uuid는 서버마다 대소문자가 다르게 온다. 라우팅 키로 쓰이므로 여기서 접는다.
    expect(created.id).toBe("aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaa10");
    expect(created.displayName).toBe("김인턴");
  });

  it("만들기 응답에서 한 필드라도 빠지면 형태 오류다", () => {
    expect(() => createdAgentFromWire({})).toThrow(WireShapeError);
    expect(() =>
      createdAgentFromWire({ agent: { id: "x", handle: "y" } })
    ).toThrow(WireShapeError);
  });

  it("멤버십 응답은 역할을 열거값으로만 받고, leftAtMs는 있을 때만 싣는다", () => {
    const membership = channelMembershipFromWire({
      membership: {
        id: "BBBBBBBB-BBBB-7BBB-8BBB-BBBBBBBBBB10",
        workspaceId: "CCCCCCCC-CCCC-7CCC-8CCC-CCCCCCCCCC10",
        channelId: "DDDDDDDD-DDDD-7DDD-8DDD-DDDDDDDDDD10",
        memberId: "EEEEEEEE-EEEE-7EEE-8EEE-EEEEEEEEEE10",
        role: "member",
        joinedAtMs: 1,
        leftAtMs: null,
      },
    });
    expect(membership.channelId).toBe("dddddddd-dddd-7ddd-8ddd-dddddddddd10");
    expect(membership.role).toBe("member");
    // 서버는 아직 나가지 않은 멤버십에 null을 싣는다. null을 0으로 접으면
    // "1970년에 나갔다"가 된다.
    expect("leftAtMs" in membership).toBe(false);

    expect(() =>
      channelMembershipFromWire({
        membership: {
          id: "B",
          workspaceId: "C",
          channelId: "D",
          memberId: "E",
          role: "observer",
          joinedAtMs: 1,
        },
      })
    ).toThrow(WireShapeError);
  });
});
