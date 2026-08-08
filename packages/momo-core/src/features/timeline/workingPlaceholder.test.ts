import { describe, expect, it } from "vitest";

import type { Message } from "../../lib/api";
import {
  parseTurnPlaceholderKey,
  turnPlaceholderKey,
  type AgentWorkingSignal,
} from "../agents/workingSignal";
import {
  buildTimelineItems,
  withTurnPlaceholders,
  type PendingMessage,
} from "./model";

// =============================================================================
// 「작업 중」이 답이 나타날 자리에서 보이기까지의 순수 규칙 (#999)
//
// 성재, 1차 검수: *"에이전트가 일하고 있는 상태인지도 잘 파악이 안 돼."*
//
// 화면 쪽 검증은 `clients/mobile/__tests__/conversationRenders.test.tsx` 가
// 한다(칸이 서는가, 사라지는가, 목록이 다시 그려지지 않는가). 여기서 잠그는 것은
// 그 화면이 소비하는 **판정**이다 — 어느 턴이 칸을 얻는가, 그 칸이 스트림의 어디에
// 서는가. 둘 다 순수 함수이므로 DOM 없이 못 박을 수 있고, 그래야 두 클라이언트가
// 같은 답을 쓴다.
// =============================================================================

const AGENT = "cccccccc-1111-4111-8111-cccccccccccc";
const HERMES = "dddddddd-1111-4111-8111-dddddddddddd";
const CH = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const SELF = "11111111-1111-4111-8111-111111111111";
const BASE_MS = 1_700_000_000_000;

function signal(over: Partial<AgentWorkingSignal> = {}): AgentWorkingSignal {
  return {
    memberId: AGENT,
    channelId: CH,
    state: "working",
    source: "run",
    runId: "A1111111-1111-4111-8111-A11111111111",
    startedAtMs: BASE_MS,
    headlines: [],
    lastActivityAtMs: BASE_MS,
    ...over,
  };
}

function message(seq: number, over: Partial<Message> = {}): Message {
  return {
    id: `msg-${seq}`,
    channelId: CH,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: SELF,
    type: "text",
    body: `메시지 ${seq}`,
    state: "sent",
    createdAtMs: BASE_MS + seq * 1000,
    ...over,
  };
}

describe("어느 턴이 답의 자리를 얻는가", () => {
  it("작업 중인 턴만 얻는다 — 승인 대기는 절대 아니다", () => {
    // 이 한 줄이 이 파일의 이유다. `awaiting_approval` 은 **멈춰 서서 사람의
    // 결정을 기다리는** 상태이고, 답이 나타날 칸을 내주면 화면이 "곧 답이 온다"고
    // 말하는 동안 에이전트는 바로 그 사람을 기다리고 있게 된다.
    expect(
      turnPlaceholderKey([signal({ state: "awaiting_approval" })])
    ).toBe("");
    expect(turnPlaceholderKey([signal()])).toBe(AGENT.toLowerCase());
  });

  it("섞여 있으면 작업 중인 것만 남기고 순서는 그대로다", () => {
    const key = turnPlaceholderKey([
      signal({ memberId: HERMES }),
      signal({ memberId: AGENT, state: "awaiting_approval" }),
    ]);
    expect(key).toBe(HERMES.toLowerCase());
  });

  it("키는 손실이 없다 — 되돌리면 같은 멤버들이다", () => {
    // `agentRail` 의 `subscriptionKey`/`parseSubscriptionKey` 와 같은 계약이고,
    // 같은 이유로 문자열이다: 값이 같으면 문자열도 같으므로 소비하는 쪽이 이것으로
    // memo 를 걸 수 있다. 스트리밍 청크마다 새 배열이 만들어지면 목록 전체가 그
    // 박자로 다시 그려진다(#997).
    const key = turnPlaceholderKey([
      signal({ memberId: AGENT }),
      signal({ memberId: HERMES }),
    ]);
    expect(parseTurnPlaceholderKey(key)).toEqual([
      { memberId: AGENT.toLowerCase() },
      { memberId: HERMES.toLowerCase() },
    ]);
    expect(parseTurnPlaceholderKey("")).toEqual([]);
  });

  it("헤드라인이 바뀌어도 키는 그대로다", () => {
    // 자리표시가 나르는 것은 **존재**뿐이다. 이 단정이 깨지는 순간 스트리밍
    // 한 청크가 목록 한 번의 재빌드가 된다.
    expect(turnPlaceholderKey([signal({ headlines: ["빌드 확인 중"] })])).toBe(
      turnPlaceholderKey([signal({ headlines: ["테스트 실행 중"] })])
    );
  });
});

describe("그 자리는 스트림의 어디인가", () => {
  const pending: PendingMessage[] = [
    {
      clientMsgId: "c1",
      channelId: CH,
      authorMemberId: SELF,
      body: "@김인턴 빌드 봐줘",
      createdAtMs: BASE_MS + 9_000,
      sinceSeq: 2,
      status: "sending",
    },
  ];

  it("맨 끝이다 — 대기행보다도 뒤", () => {
    // 순서가 곧 이야기다: 「내가 물었다」 다음 칸이 「그가 작업 중」이고, 답이
    // 도착하면 그 칸이 답으로 바뀐다. 반대로 두면 자리표시가 자기가 기다리는
    // 메시지보다 위에 선다.
    const items = withTurnPlaceholders(
      buildTimelineItems([message(1), message(2)], { pending }),
      [{ memberId: AGENT }]
    );
    expect(items.map((item) => item.kind)).toEqual([
      "day",
      "message",
      "message",
      "pending",
      "working",
    ]);
  });

  it("키는 멤버당 하나이고 대소문자를 접는다", () => {
    const items = withTurnPlaceholders(buildTimelineItems([message(1)]), [
      { memberId: AGENT.toUpperCase() },
    ]);
    const working = items.filter((item) => item.kind === "working");
    expect(working).toHaveLength(1);
    expect(working[0].key).toBe(`w-${AGENT.toLowerCase()}`);
  });

  it("빈 대화에서도 선다 — 첫 질문의 답도 자리가 있어야 한다", () => {
    const items = withTurnPlaceholders(buildTimelineItems([]), [
      { memberId: AGENT },
    ]);
    expect(items.map((item) => item.kind)).toEqual(["working"]);
  });

  it("붙일 것이 없으면 **받은 배열 그대로**를 돌려준다", () => {
    // 스레드 패널처럼 이 표면을 쓰지 않는 곳이 있다. 그리고 동일성을 지키는 것이
    // 곧 호출자의 memo 를 지키는 것이다(#997) — 새 배열을 만들면 자리표시가 하나도
    // 없는 대화에서조차 목록이 매 렌더 다시 빌드된다.
    const items = buildTimelineItems([message(1)]);
    expect(withTurnPlaceholders(items)).toBe(items);
    expect(withTurnPlaceholders(items, [])).toBe(items);
  });

  it("자리표시는 저자 묶음을 만들지 않는다", () => {
    // 뒤이어 도착할 진짜 메시지가 자기 이름줄을 온전히 얻어야 한다. 자리표시가
    // 저자를 "이미 소개했다"고 주장하면, 그것이 사라지는 순간 이름 없는 행이 남는다.
    const withPlaceholder = withTurnPlaceholders(
      buildTimelineItems([message(1)]),
      [{ memberId: AGENT }]
    );
    const arrived = buildTimelineItems(
      [message(1), message(2, { authorMemberId: AGENT })],
      {}
    );
    const lastBefore = withPlaceholder[withPlaceholder.length - 1];
    expect(lastBefore.kind).toBe("working");
    const agentRow = arrived[arrived.length - 1];
    expect(agentRow.kind === "message" && agentRow.startsGroup).toBe(true);
  });
});
