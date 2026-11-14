import type { RosterMember } from "../../lib/api";
import type { MessageKey } from "../../i18n/generated/messages";

// =============================================================================
// 채널 멤버 패널의 묶음 (#5686). 디스코드의 멤버 목록처럼 「지금」으로 묶는다:
//
//   일하는 에이전트 → 그 밖의 에이전트 → 온라인 → (접속을 모르는 사람) → 오프라인 → 정지됨
//
// 머리의 낱말은 사람 점의 낱말(`presence/model.effectivePresenceLabel`의 「온라인」「오프라인」)과 같다.
//
//   working   이 채널에 안 끝난 run이 있는 에이전트(`channelAgentNow`가 줄을 낸 에이전트)
//   agents    그 밖의 에이전트. 일하는 묶음이 없으면 머리가 그냥 「에이전트」다
//   online    서버가 접속 중이라고 알린 사람(`online === true`, 자기 줄은 이 클라이언트의 연결)
//   people    서버가 접속 여부를 모르는 사람(`online` 없음). 「접속 없음」으로 그리지 않는다:
//             모름은 꺼짐이 아니다(`statusDot.humanPresenceDot`과 같은 이유)
//   offline   서버가 접속 없음이라고 알린 사람(`online === false`)
//   suspended 정지된 사람(#5781). 소유자·관리자의 명부에만 실린다(#5814). 정지는 채널 멤버십을 지우지 않으니 이 채널의
//             멤버이지만 지금 읽지도 쓰지도 못한다: 맨 아래 따로 서고 접속 점이 없다(`statusDot.humanPresenceDot`)
//
// 자리 비움·방해 금지는 접속 여부와 다른 축이라 묶음을 바꾸지 않는다(점과 글이 말한다).
//
// ## 묶음은 열려 있는 동안 얼어 있다
//
// 패널이 열린 채로 run이 끝나거나, 30초 명부 재조회가 접속을 바꾸면 줄이 다른 묶음으로 뛰고 그 아래 줄이 모두
// 밀린다. 그래서 표면은 **열 때 한 번** 묶음을 정하고(`memberPanelSnapshot`), 열려 있는 동안에는 그 판을 따른다
// (`memberPanelSections`의 `frozen`). 바뀐 사실은 줄 안의 글만 바꾸고(줄 높이는 고정), 묶음 이동은 다음에 열 때나
// 보는 사람이 없는 순간(표면이 정한다)에 한다. 열려 있는 동안 새로 들어온 멤버만 자기 묶음의 끝에 붙는다.
// =============================================================================

export type MemberPanelGroup = "working" | "agents" | "online" | "people" | "offline" | "suspended";

export const MEMBER_PANEL_GROUP_ORDER: readonly MemberPanelGroup[] = [
  "working",
  "agents",
  "online",
  "people",
  "offline",
  "suspended",
];

type GroupInput = Pick<RosterMember, "id" | "kind" | "online"> & { status?: RosterMember["status"] };

/**
 * 멤버 한 명의 지금 묶음. `working`은 이 채널에서 일하는 에이전트인가. 사람의 `online`은 자기 줄이면 이미
 * 이 클라이언트의 연결로 바꿔 넣은 값이어야 한다(`statusDot.withOwnConnection`).
 */
export function memberPanelGroupOf(member: GroupInput, working: boolean): MemberPanelGroup {
  if (member.kind === "agent") return working ? "working" : "agents";
  if (member.status !== undefined && member.status !== "active") return "suspended";
  if (member.online === true) return "online";
  if (member.online === false) return "offline";
  return "people";
}

/**
 * 채널 머리의 멤버 수(#5781): 활성 멤버만 센다. 정지된 사람은 채널 멤버십이 남아 패널의 「정지됨」 묶음에 서지만(소유자·관리자
 * 시점), 지금 이 채널을 읽고 쓰는 사람이 아니다 — 서버 명부의 `humanCount` 와 같은 뜻이다.
 */
export function channelHeadCount(members: readonly (Pick<RosterMember, "kind"> & { status?: RosterMember["status"] })[]): number {
  return members.filter((member) => member.status === undefined || member.status === "active").length;
}

/** 지금 묶음의 판(멤버 id 소문자 → 묶음). 패널을 열 때 한 번 만든다. */
export function memberPanelSnapshot<T extends GroupInput>(
  members: readonly T[],
  groupOf: (member: T) => MemberPanelGroup
): ReadonlyMap<string, MemberPanelGroup> {
  return new Map(members.map((member) => [member.id.toLowerCase(), groupOf(member)]));
}

export interface MemberPanelSection<T> {
  group: MemberPanelGroup;
  members: T[];
}

/**
 * 묶음 차례대로 나눈 목록. 묶음 안의 차례는 들어온 차례(명부의 차례) 그대로다. `frozen`에 있는 멤버는 그
 * 묶음을 따르고, 없는 멤버(열려 있는 동안 들어온 멤버)만 지금 묶음을 쓴다. 빈 묶음은 없다.
 */
export function memberPanelSections<T extends GroupInput>(
  members: readonly T[],
  groupOf: (member: T) => MemberPanelGroup,
  frozen?: ReadonlyMap<string, MemberPanelGroup>
): MemberPanelSection<T>[] {
  const buckets = new Map<MemberPanelGroup, T[]>();
  for (const member of members) {
    const group = frozen?.get(member.id.toLowerCase()) ?? groupOf(member);
    const bucket = buckets.get(group);
    if (bucket === undefined) buckets.set(group, [member]);
    else bucket.push(member);
  }
  return MEMBER_PANEL_GROUP_ORDER.flatMap((group) => {
    const bucket = buckets.get(group);
    return bucket === undefined ? [] : [{ group, members: bucket }];
  });
}

export type MemberPanelHeadingKey = Extract<MessageKey, `timeline.memberPanel.group${string}`>;

/** 묶음 머리의 사전 키(값 `count`). 일하는 묶음이 있을 때만 나머지 에이전트를 「그 밖의 에이전트」라 부른다. */
export function memberPanelHeadingKey(
  group: MemberPanelGroup,
  hasWorking: boolean
): MemberPanelHeadingKey {
  switch (group) {
    case "working":
      return "timeline.memberPanel.groupWorking";
    case "agents":
      return hasWorking ? "timeline.memberPanel.groupOtherAgents" : "timeline.memberPanel.groupAgents";
    case "online":
      return "timeline.memberPanel.groupOnline";
    case "people":
      return "timeline.memberPanel.groupPeople";
    case "offline":
      return "timeline.memberPanel.groupOffline";
    case "suspended":
      return "timeline.memberPanel.groupSuspended";
  }
}
