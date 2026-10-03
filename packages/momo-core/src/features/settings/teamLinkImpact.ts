import type { RosterMember } from "../../lib/api";

// =============================================================================
// 팀 키 「연결 끊기」의 영향 (#2880 AA-7, 시안 §3 오른쪽, brief §3.4).
//
// 끊기 전에 **누가 대답하지 못하게 되는가**를 이름으로 보인다. 팀 키로 대답하는
// 에이전트는 서버 워커가 도는 에이전트다: 활성 에이전트 멤버 가운데 호스티드
// 연결(자기 호스트·구독으로 도는 에이전트)이 없는 것. 서버의 같은 규칙은
// `is_hosted_agent_in_tx`(hosted_agent_connection 행이 하나라도 있으면 호스티드)다.
//
// 이 파일은 판정만 한다. 목록을 못 읽었으면(403·오류) 숫자를 지어내지 않고
// `null`을 돌려주고, 화면은 「목록을 불러오지 못했어요」라고 말한다.
// =============================================================================

export interface TeamLinkAffectedAgent {
  readonly id: string;
  readonly name: string;
  /** 이 에이전트가 들어 있는 채널 설명(「리서치 채널」「리서치 외 2개 채널」). */
  readonly where: string | null;
  /** 잠들어 있음(ADR SRV-R2). 지금은 대답하지 않지만 깨우면 이 키를 쓴다. */
  readonly paused: boolean;
}

export interface TeamLinkChannelName {
  readonly id: string;
  readonly name: string;
}

function lower(value: string): string {
  return value.toLowerCase();
}

function whereLabel(
  channelIds: readonly string[],
  names: ReadonlyMap<string, string>
): string | null {
  const known = channelIds.map((id) => names.get(lower(id))).filter((name): name is string => !!name);
  if (known.length === 0) return null;
  const rest = channelIds.length - 1;
  return rest > 0 ? `${known[0]} 외 ${rest}개 채널` : `${known[0]} 채널`;
}

/**
 * 팀 키를 쓰는 에이전트. 호스티드 목록을 못 읽었으면 null(빼야 할 줄을 모른다).
 * 이름 순(ko). 삭제·초대 상태는 빠진다.
 */
export function teamLinkAffectedAgents(input: {
  roster: readonly RosterMember[] | undefined;
  hostedAgentIds: readonly string[] | null;
  channels?: readonly TeamLinkChannelName[];
}): TeamLinkAffectedAgent[] | null {
  const { roster, hostedAgentIds, channels = [] } = input;
  if (!roster || hostedAgentIds === null) return null;
  const hosted = new Set(hostedAgentIds.map(lower));
  const names = new Map(channels.map((channel) => [lower(channel.id), channel.name] as const));
  return roster
    .filter((member) => member.kind === "agent" && member.status === "active" && !hosted.has(lower(member.id)))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, "ko", { numeric: true }))
    .map((member) => ({
      id: member.id,
      name: member.displayName,
      where: whereLabel(member.channelIds ?? [], names),
      paused: member.paused === true,
    }));
}

/** 끊기 확인 창의 제목(시안 §3 d2). */
export function teamUnlinkTitle(rowName: string): string {
  return `${rowName} 연결을 끊을까요?`;
}

/**
 * 끊기 확인 창의 본문. 영향 수는 목록을 읽었을 때만 말한다.
 * 키가 서버에서 지워지고 다시 볼 수 없다는 문장은 늘 붙는다(ADR-0004 쓰기 전용).
 */
export function teamUnlinkBody(affected: readonly TeamLinkAffectedAgent[] | null): string {
  const gone = "저장된 키는 서버에서 지워지고 다시 볼 수 없어요.";
  if (affected === null) {
    return `이 키를 쓰는 팀 에이전트는 대답할 수 없게 돼요. ${gone}`;
  }
  if (affected.length === 0) {
    return `지금 이 키를 쓰는 팀 에이전트는 없어요. ${gone}`;
  }
  return `이 키를 쓰는 팀 에이전트 ${affected.length}개가 대답할 수 없게 돼요. ${gone}`;
}

/**
 * 조용히 다른 키로 넘어가지 않는다는 문장(ADR-0135 D1: 예비 provider는 가용성 실패에만
 * 넘어가고 빈 첫 칸을 대신하지 않는다, #2897: 키가 없으면 실행을 실패로 닫고 까닭을
 * 말한다). 서버 환경값 키는 저장된 키가 없을 때의 원래 자리라 끊은 뒤 목록에 그대로
 * 보인다: 그래서 「어떤 키로도」라고 단정하지 않는다.
 */
export const TEAM_UNLINK_NO_SILENT_SWITCH =
  "예비 provider로 조용히 넘어가지 않아요. 에이전트는 대답 대신 AI로 가는 안내를 남겨요.";

/** 첫 인사·채널 요약은 키가 없으면 정해 둔 문구로 바뀐다(#2897 welcome provider-required). */
export const TEAM_UNLINK_FIXED_COPY = "채널 요약과 첫 인사는 정해 둔 문구로 바뀌어요.";

/** 호스티드 목록을 못 읽었을 때 영향 목록 자리의 문장. */
export const TEAM_UNLINK_LIST_UNKNOWN =
  "영향 받는 에이전트 목록을 불러오지 못했어요. 끊으면 팀 키로 대답하던 에이전트가 모두 멈춰요.";
