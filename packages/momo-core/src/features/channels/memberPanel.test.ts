import { describe, expect, it } from "vitest";
import {
  channelHeadCount,
  memberPanelGroupOf,
  memberPanelHeadingKey,
  memberPanelSections,
  memberPanelSnapshot,
  type MemberPanelGroup,
} from "./memberPanel";

// 채널 멤버 패널의 묶음 (#5686): 차례, 모르는 접속, 열려 있는 동안 얼어 있는 판.

type M = { id: string; kind: "human" | "agent"; online?: boolean; status?: "active" | "suspended" };
const human = (id: string, online?: boolean): M => ({ id, kind: "human", ...(online === undefined ? {} : { online }) });
const agent = (id: string): M => ({ id, kind: "agent" });

describe("memberPanel (#5686)", () => {
  it("묶음 차례: 일하는 에이전트 → 그 밖의 에이전트 → 접속 중 → 모름 → 접속 없음, 묶음 안은 명부 차례", () => {
    const members = [
      human("h-off", false),
      agent("a-idle"),
      human("h-on-2", true),
      human("h-unknown"),
      agent("a-work"),
      human("h-on-1", true),
    ];
    const working = new Set(["a-work"]);
    const groupOf = (m: M) => memberPanelGroupOf(m, working.has(m.id));
    const sections = memberPanelSections(members, groupOf);
    expect(sections.map((s) => [s.group, s.members.map((m) => m.id)])).toEqual([
      ["working", ["a-work"]],
      ["agents", ["a-idle"]],
      ["online", ["h-on-2", "h-on-1"]],
      ["people", ["h-unknown"]],
      ["offline", ["h-off"]],
    ]);
  });

  it("접속을 모르는 사람은 「접속 없음」이 아니다", () => {
    expect(memberPanelGroupOf(human("x"), false)).toBe("people");
    expect(memberPanelGroupOf(human("x", false), false)).toBe("offline");
    // 사람에게 일하는 표지가 와도 사람 묶음이다(사람의 자동 활동은 묶음을 바꾸지 않는다).
    expect(memberPanelGroupOf(human("x", true), true)).toBe("online");
  });

  it("얼린 판을 따른다: 열려 있는 동안 run이 끝나고 접속이 바뀌어도 묶음이 그대로, 새로 온 멤버만 자기 묶음 끝에 붙는다", () => {
    const before = [agent("a1"), agent("a2"), human("h1", true), human("h2", false)];
    let working = new Set(["a1"]);
    const groupOf = (m: M) => memberPanelGroupOf(m, working.has(m.id));
    const frozen = memberPanelSnapshot(before, groupOf);

    // 열려 있는 동안: a1의 run이 끝나고 a2가 일을 시작, h1이 나가고 h2가 들어옴, 새 사람 h3(접속 중)
    working = new Set(["a2"]);
    const after = [agent("a1"), agent("a2"), human("h1", false), human("h2", true), human("h3", true)];
    const frozenView = memberPanelSections(after, groupOf, frozen);
    expect(frozenView.map((s) => [s.group, s.members.map((m) => m.id)])).toEqual([
      ["working", ["a1"]],
      ["agents", ["a2"]],
      ["online", ["h1", "h3"]],
      ["offline", ["h2"]],
    ]);

    // 다음에 열 때(새 판): 지금 사실대로
    const reopened = memberPanelSections(after, groupOf, memberPanelSnapshot(after, groupOf));
    expect(reopened.map((s) => [s.group, s.members.map((m) => m.id)])).toEqual([
      ["working", ["a2"]],
      ["agents", ["a1"]],
      ["online", ["h2", "h3"]],
      ["offline", ["h1"]],
    ]);
  });

  it("얼린 판의 키는 대소문자를 가리지 않는다", () => {
    const frozen = memberPanelSnapshot([agent("A1")], () => "working" as MemberPanelGroup);
    expect(memberPanelSections([agent("a1")], () => "agents", frozen)[0]!.group).toBe("working");
  });

  it("머리 키: 일하는 묶음이 있을 때만 「그 밖의 에이전트」", () => {
    expect(memberPanelHeadingKey("agents", true)).toBe("timeline.memberPanel.groupOtherAgents");
    expect(memberPanelHeadingKey("agents", false)).toBe("timeline.memberPanel.groupAgents");
    expect(memberPanelHeadingKey("working", true)).toBe("timeline.memberPanel.groupWorking");
    expect(memberPanelHeadingKey("people", false)).toBe("timeline.memberPanel.groupPeople");
  });

  it("정지된 사람(#5781): 접속과 무관하게 맨 아래 「정지됨」 묶음, 머리 수에는 들지 않는다", () => {
    // 서버는 정지된 줄에 `online` 을 싣지 않지만(#5814), 실려 와도 묶음은 정지됨이다.
    const members: M[] = [
      { id: "h-sus-online", kind: "human", online: true, status: "suspended" },
      human("h-on", true),
      { id: "h-sus", kind: "human", status: "suspended" },
      human("h-off", false),
      agent("a"),
    ];
    const sections = memberPanelSections(members, (m) => memberPanelGroupOf(m, false));
    expect(sections.map((s) => [s.group, s.members.map((m) => m.id)])).toEqual([
      ["agents", ["a"]],
      ["online", ["h-on"]],
      ["offline", ["h-off"]],
      ["suspended", ["h-sus-online", "h-sus"]],
    ]);
    expect(memberPanelHeadingKey("suspended", false)).toBe("timeline.memberPanel.groupSuspended");
    expect(channelHeadCount(members)).toBe(3);
    // 상태를 모르는 줄(옛 입력)은 활성으로 센다.
    expect(channelHeadCount([human("x"), agent("y")])).toBe(2);
  });
});
