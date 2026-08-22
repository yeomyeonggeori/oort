import { describe, expect, it } from "vitest";
import type { RosterMember } from "../../lib/api";
import type { HostedAgentConnection } from "./model";
import {
  FIRST_MENTION_AGENT_BADGE,
  FIRST_MENTION_WAIT_MS,
  bodyMentionsHandle,
  firstMentionDraft,
  firstMentionView,
  pickFirstMentionTarget,
  previewHintedAgent,
  type FirstMentionMessage,
  type FirstMentionTarget,
} from "./firstMention";

const CONNECTION = "00000000-0000-7000-8000-0000000000c1";
const AGENT = "00000000-0000-7000-8000-0000000000a1";
const OTHER = "00000000-0000-7000-8000-0000000000a2";
const HUMAN = "00000000-0000-7000-8000-0000000000b1";
const CHANNEL = "00000000-0000-7000-8000-000000000201";
const OTHER_CHANNEL = "00000000-0000-7000-8000-000000000202";
const WS = "00000000-0000-7000-8000-000000000001";
const NOW = 1_700_000_000_000;

function member(overrides: Partial<RosterMember> = {}): RosterMember {
  return {
    id: AGENT,
    workspaceId: WS,
    kind: "agent",
    status: "active",
    displayName: "그록봇",
    handle: "grokbot",
    channelCount: 1,
    channelIds: [CHANNEL],
    capabilities: [],
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...overrides,
  };
}

function connection(
  overrides: Partial<HostedAgentConnection> = {}
): HostedAgentConnection {
  return {
    id: CONNECTION,
    agentMemberId: AGENT,
    status: "active",
    authMode: "static_bearer",
    audience: "/v1/mcp/agent-port",
    approvedChannelIds: [CHANNEL],
    approvedScopes: ["messages:write"],
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...overrides,
  };
}

function target(
  overrides: Partial<FirstMentionTarget> = {}
): FirstMentionTarget {
  return {
    connectionId: CONNECTION,
    agentMemberId: AGENT,
    displayName: "그록봇",
    handle: "grokbot",
    ...overrides,
  };
}

function msg(
  overrides: Partial<FirstMentionMessage> = {}
): FirstMentionMessage {
  return {
    authorMemberId: HUMAN,
    createdAtMs: NOW,
    body: "@grokbot 안녕",
    state: "sent",
    ...overrides,
  };
}

function view(
  overrides: Parameters<typeof firstMentionView>[0] extends infer T
    ? Partial<T>
    : never = {}
) {
  return firstMentionView({
    target: target(),
    connectionsStatus: "ready",
    messagesStatus: "ready",
    messages: [],
    selfMemberId: HUMAN,
    nowMs: NOW,
    waitMs: 60_000,
    ...overrides,
  });
}

describe("첫 왕복 대상", () => {
  it("활성 그록봇 연결이 이 채널을 승인했을 때만 고른다", () => {
    expect(
      pickFirstMentionTarget({
        channelId: CHANNEL,
        members: [member()],
        connections: [connection()],
      })?.agentMemberId
    ).toBe(AGENT);
    expect(
      pickFirstMentionTarget({
        channelId: OTHER_CHANNEL,
        members: [member()],
        connections: [connection()],
      })
    ).toBeNull();
    expect(
      pickFirstMentionTarget({
        channelId: CHANNEL,
        members: [member()],
        connections: [connection({ status: "detected" })],
      })
    ).toBeNull();
  });

  it("힌트가 있으면 이름을 바꾼 전용 에이전트도 따라간다", () => {
    const renamed = member({
      displayName: "내 봇",
      handle: "mybot",
    });
    expect(
      pickFirstMentionTarget({
        channelId: CHANNEL,
        members: [renamed],
        connections: [connection()],
        hintedAgentMemberId: AGENT,
      })
    ).toEqual({
      connectionId: CONNECTION,
      agentMemberId: AGENT,
      displayName: "내 봇",
      handle: "mybot",
    });
    expect(
      pickFirstMentionTarget({
        channelId: CHANNEL,
        members: [renamed],
        connections: [connection()],
      })
    ).toBeNull();
  });

  it("힌트 미리보기는 목록 전에 뱃지용 이름을 준다", () => {
    expect(previewHintedAgent([member()], AGENT)?.displayName).toBe("그록봇");
    expect(previewHintedAgent([member({ kind: "human" })], AGENT)).toBeNull();
  });

  it("사람과 정지된 에이전트는 고르지 않는다", () => {
    expect(
      pickFirstMentionTarget({
        channelId: CHANNEL,
        members: [member({ kind: "human" })],
        connections: [connection()],
      })
    ).toBeNull();
    expect(
      pickFirstMentionTarget({
        channelId: CHANNEL,
        members: [member({ status: "suspended" })],
        connections: [connection()],
        hintedAgentMemberId: AGENT,
      })
    ).toBeNull();
  });
});

describe("본문 멘션 토큰", () => {
  it("핸들 경계가 맞을 때만 멘션이다", () => {
    expect(bodyMentionsHandle("@grokbot 안녕", "grokbot")).toBe(true);
    expect(bodyMentionsHandle("안녕 @grokbot", "grokbot")).toBe(true);
    expect(bodyMentionsHandle("@grokbot2 안녕", "grokbot")).toBe(false);
    expect(bodyMentionsHandle("@other 안녕", "grokbot")).toBe(false);
  });

  it("한글 핸들도 글자 경계로 가른다", () => {
    expect(bodyMentionsHandle("@봇 안녕", "봇")).toBe(true);
    expect(bodyMentionsHandle("@봇2 안녕", "봇")).toBe(false);
    expect(bodyMentionsHandle("@봇안녕", "봇")).toBe(false);
  });
});

describe("첫 왕복 네 상태", () => {
  it("멘션 전은 빈 상태이고 액션이 하나다", () => {
    const empty = view();
    expect(empty.phase).toBe("empty");
    expect(empty.complete).toBe(false);
    expect(empty.headline).toBe("첫 멘션을 보내보세요.");
    expect(empty.actionLabel).toBe("첫 멘션 쓰기");
    expect(empty.agentBadge).toBe(FIRST_MENTION_AGENT_BADGE);
    expect(empty.agent?.handle).toBe("grokbot");
  });

  it("멘션 후 대기와 메시지 로딩은 로딩이다", () => {
    const waiting = view({
      messages: [msg({ createdAtMs: NOW - 1_000 })],
      nowMs: NOW,
    });
    expect(waiting.phase).toBe("loading");
    expect(waiting.loadingKind).toBe("wait");
    expect(waiting.waitStartedAtMs).toBe(NOW - 1_000);
    expect(waiting.headline).toContain("답을 기다리는 중입니다");
    const fetching = view({ messagesStatus: "loading" });
    expect(fetching.phase).toBe("loading");
    expect(fetching.loadingKind).toBe("fetch");
    expect(fetching.waitStartedAtMs).toBeNull();
  });

  it("실패한 전송은 왕복 멘션이 아니다", () => {
    const failed = view({
      messages: [msg({ state: "failed", createdAtMs: NOW - 1_000 })],
    });
    expect(failed.phase).toBe("empty");
    expect(failed.complete).toBe(false);
  });

  it("보내는 중인 멘션은 대기다", () => {
    const sending = view({
      messages: [msg({ state: "sending", createdAtMs: NOW - 1_000 })],
      nowMs: NOW,
    });
    expect(sending.phase).toBe("loading");
    expect(sending.loadingKind).toBe("wait");
  });

  it("타임아웃 뒤 재멘션은 최신 멘션 시계로 대기에 돌아온다", () => {
    const reMentioned = view({
      messages: [
        msg({ createdAtMs: NOW - 60_000 }),
        msg({ createdAtMs: NOW - 1_000, body: "@grokbot 다시" }),
      ],
      nowMs: NOW,
      waitMs: 60_000,
    });
    expect(reMentioned.phase).toBe("loading");
    expect(reMentioned.loadingKind).toBe("wait");
    expect(reMentioned.errorKind).toBeNull();
    expect(reMentioned.waitStartedAtMs).toBe(NOW - 1_000);
  });

  it("실패한 멘션 뒤에 보낸 멘션만 시계에 쓴다", () => {
    const afterFail = view({
      messages: [
        msg({ state: "failed", createdAtMs: NOW - 60_000 }),
        msg({ createdAtMs: NOW - 1_000 }),
      ],
      nowMs: NOW,
      waitMs: 60_000,
    });
    expect(afterFail.phase).toBe("loading");
    expect(afterFail.waitStartedAtMs).toBe(NOW - 1_000);
  });

  it("완료와 닫기는 메시지를 보지 않고 숨긴다", () => {
    expect(
      view({
        recorded: "complete",
        messages: [msg({ createdAtMs: NOW - 1_000 })],
      })
    ).toMatchObject({ phase: "hidden", complete: true });
    expect(
      view({
        recorded: "dismissed",
        messages: [msg({ createdAtMs: NOW - 1_000 })],
      })
    ).toMatchObject({ phase: "hidden", complete: false });
  });

  it("닫은 뒤 에이전트 답이 오면 완료로 승격한다", () => {
    expect(
      view({
        recorded: "dismissed",
        messages: [
          msg({ createdAtMs: NOW - 2_000 }),
          msg({
            authorMemberId: AGENT,
            body: "안녕하세요",
            createdAtMs: NOW - 500,
          }),
        ],
      })
    ).toMatchObject({ phase: "hidden", complete: true });
  });

  it("에이전트 메시지가 오면 완료하고 숨긴다", () => {
    const done = view({
      messages: [
        msg({ createdAtMs: NOW - 2_000 }),
        msg({
          authorMemberId: AGENT,
          body: "안녕하세요",
          createdAtMs: NOW - 500,
        }),
      ],
    });
    expect(done.complete).toBe(true);
    expect(done.phase).toBe("hidden");
  });

  it("타임아웃은 오류 상태이고 무음이 아니다", () => {
    const timedOut = view({
      messages: [msg({ createdAtMs: NOW - 60_000 })],
      nowMs: NOW,
      waitMs: 60_000,
    });
    expect(timedOut.phase).toBe("error");
    expect(timedOut.errorKind).toBe("timeout");
    expect(timedOut.headline).toContain("답이 오지 않았습니다");
    expect(timedOut.actionLabel).toBe("다시 멘션하기");
    expect(timedOut.agentBadge).toBe("에이전트");
  });

  it("메시지 조회 실패도 오류 상태다", () => {
    const failed = view({ messagesStatus: "error" });
    expect(failed.phase).toBe("error");
    expect(failed.errorKind).toBe("messages");
    expect(failed.actionLabel).toBe("다시 시도");
  });

  it("힌트만 있고 목록이 실패하면 연결 오류다", () => {
    const failed = view({
      target: null,
      hintedAgentMemberId: AGENT,
      previewAgent: target({ displayName: "내 봇" }),
      connectionsStatus: "error",
    });
    expect(failed.phase).toBe("error");
    expect(failed.errorKind).toBe("connections");
    expect(failed.headline).toContain("내 봇");
    expect(failed.headline).not.toContain("그록봇");
    const unnamed = view({
      target: null,
      hintedAgentMemberId: AGENT,
      connectionsStatus: "error",
    });
    expect(unnamed.headline).toContain("에이전트");
    expect(unnamed.headline).not.toContain("그록봇");
  });

  it("대상이 없으면 힌트 없는 채널은 침묵한다", () => {
    expect(view({ target: null }).phase).toBe("hidden");
  });

  it("서버 mention_member_ids 가 있으면 본문 파싱 없이 멘션이다", () => {
    const waiting = view({
      messages: [
        msg({
          body: "이거 봐줘",
          createdAtMs: NOW - 1_000,
          props: { mention_member_ids: [AGENT.toUpperCase()] },
        }),
      ],
    });
    expect(waiting.phase).toBe("loading");
  });

  it("지운 행은 멘션도 답도 아니다", () => {
    expect(
      view({
        messages: [msg({ state: "deleted", createdAtMs: NOW - 1_000 })],
      }).phase
    ).toBe("empty");
    expect(
      view({
        messages: [
          msg({ createdAtMs: NOW - 2_000 }),
          msg({
            authorMemberId: AGENT,
            state: "deleted",
            createdAtMs: NOW - 500,
          }),
        ],
      }).phase
    ).toBe("loading");
  });
});

describe("카피와 계약", () => {
  it("에이전트 뱃지 라벨은 고정이고 엠대시·과장어가 없다", () => {
    expect(FIRST_MENTION_AGENT_BADGE).toBe("에이전트");
    const copies = [
      view(),
      view({
        messages: [msg({ createdAtMs: NOW - 60_000 })],
        waitMs: 60_000,
      }),
      view({ messagesStatus: "error" }),
      view({ messagesStatus: "loading" }),
      view({
        target: null,
        hintedAgentMemberId: AGENT,
        connectionsStatus: "error",
      }),
    ].flatMap((row) => [row.headline, row.detail, row.actionLabel ?? ""]);
    const blob = copies.join("\n");
    expect(blob).not.toMatch(/[—–]/);
    expect(blob).not.toMatch(
      /seamless|effortless|unleash|elevate|원활한|손쉽게|매끄러운/
    );
  });

  it("대기 상한은 벤치 기본과 같고 게이트 숫자가 아니다", () => {
    expect(FIRST_MENTION_WAIT_MS).toBe(300_000);
  });

  it("초안은 핸들 멘션 한 토큰이다", () => {
    expect(firstMentionDraft("grokbot")).toBe("@grokbot ");
  });

  it("다른 에이전트의 메시지는 이 왕복을 끝내지 않는다", () => {
    expect(
      view({
        messages: [
          msg({ createdAtMs: NOW - 2_000 }),
          msg({
            authorMemberId: OTHER,
            body: "다른 봇",
            createdAtMs: NOW - 500,
          }),
        ],
      }).complete
    ).toBe(false);
  });
});
