import { describe, expect, it } from "vitest";
import type { AgentRunProgress, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { NO_RUNS, runStatusForMessage } from "./runStatus";

// =============================================================================
// 한 메시지 행이 받는 「이 메시지가 일으킨 run들」 (#4619 planner 결정 2). 타임라인은 가상 목록이라 jsdom에서 그려 볼 수
// 없으므로 규칙을 순수 함수로 꺼내 잰다: 칩은 에이전트를 부른 **사람의 메시지면 누구의 것이든** 서고, 에이전트의 글에는
// 서지 않으며, 내가 방금 보낸 메시지만 run이 없어도 슬롯을 세운다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const ME = "00000000-0000-7000-8000-000000000101";
const SEOYEON = "00000000-0000-7000-8000-000000000102";
const BOT = "00000000-0000-7000-8000-000000000301";
const STRANGER = "00000000-0000-7000-8000-0000000009ff";
const M_MINE = "0199aa11-0000-7000-8000-000000000001";
const M_THEIRS = "0199aa11-0000-7000-8000-000000000002";
const M_BOT = "0199aa11-0000-7000-8000-000000000003";
const M_NONE = "0199aa11-0000-7000-8000-000000000004";

function member(id: string, kind: "human" | "agent", name: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind,
    status: "active",
    displayName: name,
    handle: name,
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember;
}
const directory = makeDirectory([
  member(ME, "human", "이도현"),
  member(SEOYEON, "human", "박서연"),
  member(BOT, "agent", "달무리봇"),
]);

function run(trigger: string): AgentRunProgress {
  return {
    id: `0199bb11-0000-7000-8000-${trigger.slice(-12)}`,
    channelId: CH,
    agentMemberId: BOT,
    triggerMessageId: trigger,
    status: "running",
    phase: "running",
    leaseState: "live",
    stepCount: 0,
    ahead: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}
const runsByMessage = new Map<string, readonly AgentRunProgress[]>([
  [M_MINE, [run(M_MINE)]],
  [M_THEIRS, [run(M_THEIRS)]],
  [M_BOT, [run(M_BOT)]],
]);

/** `viewer`가 null이면 내 id가 없는 표면(스레드 패널·검색 결과)이다. */
const forMessage = (id: string, author: string, viewer: string | null = ME) =>
  runStatusForMessage({
    message: { id, authorMemberId: author },
    myMemberId: viewer ?? undefined,
    directory,
    runsByMessage,
  });

describe("행이 받는 run (#4619 planner 결정 2)", () => {
  it("내가 부른 메시지: 그 run들이다", () => {
    expect(forMessage(M_MINE, ME)).toBe(runsByMessage.get(M_MINE));
  });

  it("남이 부른 메시지도 그 run들이다 — 칩이 내 요청에만 서지 않는다", () => {
    expect(forMessage(M_THEIRS, SEOYEON)).toBe(runsByMessage.get(M_THEIRS));
  });

  it("에이전트가 쓴 글은 사람이 부른 일이 아니다 — run이 있어도 없다", () => {
    expect(forMessage(M_BOT, BOT)).toBeUndefined();
  });

  it("내가 방금 보낸, run이 아직 없는 메시지는 빈 목록이다(행이 슬롯을 세우고 진행을 당겨 읽는다). 같은 참조다", () => {
    const first = forMessage(M_NONE, ME);
    expect(first).toBe(NO_RUNS);
    expect(first).toHaveLength(0);
    expect(forMessage("0199aa11-0000-7000-8000-000000000099", ME)).toBe(first);
  });

  it("남의 메시지에 run이 없으면 슬롯도 없다 — 남의 새 메시지마다 채널 읽기가 돌지 않는다", () => {
    expect(forMessage(M_NONE, SEOYEON)).toBeUndefined();
  });

  it("대화 표면이 아니면(내 id가 없다) 아무에게도 주지 않는다", () => {
    expect(forMessage(M_MINE, ME, null)).toBeUndefined();
    expect(forMessage(M_THEIRS, SEOYEON, null)).toBeUndefined();
  });

  it("명부에 없는 저자(나간 사람)도 사람의 글로 본다 — run이 있으면 선다", () => {
    const map = new Map<string, readonly AgentRunProgress[]>([[M_THEIRS, [run(M_THEIRS)]]]);
    expect(
      runStatusForMessage({
        message: { id: M_THEIRS, authorMemberId: STRANGER },
        myMemberId: ME,
        directory,
        runsByMessage: map,
      })
    ).toBe(map.get(M_THEIRS));
  });

  it("메시지 id는 대소문자를 가리지 않는다", () => {
    expect(forMessage(M_THEIRS.toUpperCase(), SEOYEON)).toBe(runsByMessage.get(M_THEIRS));
  });
});
