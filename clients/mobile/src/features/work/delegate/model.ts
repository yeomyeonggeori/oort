import type {Channel, RosterMember} from '@momo/core/lib/api';
import {uuidEq} from '@momo/core/lib/api';
import {
  channelLabel,
  type Directory,
} from '@momo/core/features/workspace/directory';
import type {HostedAgentConnection} from '@momo/core/features/hostedAgents/model';
import type {WorkRunFailure} from '@momo/core/features/agents/workRunRequest';

// =============================================================================
// 「작업 맡기기」 시트가 묻는 것의 순수 부분 (이슈 #3588 N8, ADR-0198 D4 증보 1).
//
// 시트가 하는 판단은 셋이다. 누구에게 맡길 수 있나, 어느 채널로 보내나, 그리고
// 같은 의도의 재시도에 같은 `clientRunId`를 쓰나. 화면에서 떼어 두는 이유는 셋 다
// 「보여 주기」가 아니라 **서버로 나가는 값**에 닿기 때문이다.
//
// ## 이 파일이 아는 것과 모르는 것
//
// 명부(`RosterMember`)에는 호스티드 연결도 채널 승인도 없다. 그것은 호스티드 연결
// 목록(`HostedAgentConnection`)에 있고, 그 목록은 **소유자·관리자만** 읽는다(일반
// 멤버는 403). 그래서 이 파일은 「모른다」를 값으로 든다(`HostedRead.unknown`):
// 모르는 채로는 아무것도 거르지 않고 서버의 409에 맡긴다. 「승인 채널 0개」는
// 목록을 **읽었고**, 그 에이전트의 연결 줄이 있고, 승인 목록이 비었을 때만이다.
// 읽지 못한 것을 0으로 읽으면 일반 멤버는 모든 에이전트에게 못 맡긴다고 거짓말하게 된다.
//
// DM은 거르지 않는다. 서버의 `hosted_connection_channel_ids`는 저장된 승인 목록에
// **소유자와의 1:1 DM 같은 파생 채널**을 더해서 판정하지만 목록 응답의
// `approvedChannelIds`는 저장된 열 그대로다. 그래서 그 목록으로 DM이 안 된다고
// 말하면 소유자 본인의 DM을 거짓으로 막는다. DM은 DM 머리 메뉴가 채널을 정해서
// 넘기고(거르지 않음), 서버가 409로 답한다.
// =============================================================================

/** 호스티드 연결 목록을 읽었는가. 못 읽으면(403·오류) 모른다. */
export type HostedRead =
  | {kind: 'unknown'}
  | {kind: 'known'; connections: readonly HostedAgentConnection[]};

export const HOSTED_UNKNOWN: HostedRead = {kind: 'unknown'};

export type RestReason = 'paused' | 'subscription_paused' | 'not_connected';

export const REST_SENTENCE: Readonly<Record<RestReason, string>> = {
  paused: '지금 쉬어요',
  subscription_paused: '이 서버에서는 쉬게 해 두었어요',
  not_connected: 'oort와 연결이 끊겨 있어요',
};

export interface DelegateAgent {
  member: RosterMember;
  /** `null`이면 맡길 수 있다. 아니면 회색 줄에 쓰는 이유. */
  rest: RestReason | null;
  /**
   * 이 에이전트에게 보낼 수 있는 채널. DM은 들어 있지 않다(위 머리 설명).
   * 호스티드 목록을 읽었고 연결 줄이 있으면 승인된 채널만이다.
   */
  channels: Channel[];
  /** 승인 목록으로 걸렀는가. 걸렀는데 비었다면 「승인 채널 0개」다. */
  filteredByApproval: boolean;
}

function connectionFor(
  hosted: HostedRead,
  agentId: string,
): HostedAgentConnection | null {
  if (hosted.kind !== 'known') return null;
  const mine = hosted.connections.filter(connection =>
    uuidEq(connection.agentMemberId, agentId),
  );
  return mine.find(connection => connection.status === 'active') ?? mine[0] ?? null;
}

function restOf(
  member: RosterMember,
  connection: HostedAgentConnection | null,
): RestReason | null {
  if (member.paused === true) return 'paused';
  if (member.brainUnavailableReason === 'claude_subscription_agent_paused') {
    return 'subscription_paused';
  }
  if (connection !== null && connection.status !== 'active') return 'not_connected';
  return null;
}

/** 보낼 수 있는 채널: 내 채널 중 그 에이전트가 들어 있는 비-DM. */
function channelsFor(
  member: RosterMember,
  channels: readonly Channel[],
  connection: HostedAgentConnection | null,
): {channels: Channel[]; filteredByApproval: boolean} {
  const present = channels.filter(
    channel =>
      channel.kind !== 'dm' &&
      channel.archivedAtMs === undefined &&
      member.channelIds.some(id => uuidEq(id, channel.id)),
  );
  if (connection === null) return {channels: present, filteredByApproval: false};
  return {
    channels: present.filter(channel =>
      connection.approvedChannelIds.some(id => uuidEq(id, channel.id)),
    ),
    filteredByApproval: true,
  };
}

/**
 * 이 사람이 작업을 맡길 수 있는 에이전트들.
 *
 * - 소유자 전용 에이전트의 소유자가 내가 아니면 뺀다(서버가 어차피 403이다).
 *   소유자 줄이 명부에 없는 경우(손님에게는 빠진다)도 뺀다.
 * - 쉬는 에이전트는 **빼지 않고** 회색으로 둔다. 왜 안 되는지 말할 수 있어서다.
 * - 어느 채널에도 못 보내는 에이전트(내 채널에 없음)는 빼되, 승인 때문에 비는
 *   경우는 남긴다: 「승인 채널 0개」 문장이 사람이 할 일을 알려 준다.
 */
export function delegateAgents(input: {
  directory: Directory;
  channels: readonly Channel[];
  selfId: string;
  hosted: HostedRead;
}): DelegateAgent[] {
  const out: DelegateAgent[] = [];
  for (const member of input.directory.members) {
    if (member.kind !== 'agent' || member.status !== 'active') continue;
    if (member.callableBy === 'owner_only') {
      if (member.owner === undefined || !uuidEq(member.owner.id, input.selfId)) continue;
    }
    const connection = connectionFor(input.hosted, member.id);
    const picked = channelsFor(member, input.channels, connection);
    const withoutApproval = channelsFor(member, input.channels, null);
    if (withoutApproval.channels.length === 0) continue;
    out.push({
      member,
      rest: restOf(member, connection),
      channels: picked.channels,
      filteredByApproval: picked.filteredByApproval,
    });
  }
  return out.sort((a, b) =>
    a.member.displayName.localeCompare(b.member.displayName, 'ko'),
  );
}

/** 에이전트 한 명만 따로 볼 때(진입점이 에이전트를 정해 줄 때). 빼지 않고 상태만 단다. */
export function delegateAgentFor(input: {
  directory: Directory;
  channels: readonly Channel[];
  agentId: string;
  hosted: HostedRead;
}): DelegateAgent | null {
  const member = input.directory.members.find(
    candidate => candidate.kind === 'agent' && uuidEq(candidate.id, input.agentId),
  );
  if (member === undefined) return null;
  const connection = connectionFor(input.hosted, member.id);
  const picked = channelsFor(member, input.channels, connection);
  return {
    member,
    rest: restOf(member, connection),
    channels: picked.channels,
    filteredByApproval: picked.filteredByApproval,
  };
}

/** 「그록봇 · #개발 채널로 보내요」. 도착지는 입력 전에 이름으로 보인다(ADR-0198 D4). */
export function destinationLine(
  agentName: string,
  channel: Channel,
  directory: Directory,
  selfId: string,
): string {
  if (channel.kind === 'dm') return `${agentName} · 이 DM으로 보내요`;
  return `${agentName} · #${channelLabel(channel, directory, selfId)} 채널로 보내요`;
}

export const NO_APPROVED_CHANNEL_SENTENCE =
  '이 에이전트는 아직 승인된 채널이 없어요. 승인은 데스크탑에서 해요.';
export const NO_AGENT_SENTENCE =
  '지금 작업을 맡길 수 있는 에이전트가 없어요. 에이전트가 들어 있는 채널에 참여하면 여기에 나와요.';

// ---- 같은 의도에는 같은 id ---------------------------------------------------

/**
 * 한 번의 「맡기기」 의도의 지문. 에이전트·채널과 **다듬은** 입력이 같으면 같은
 * 의도다(공백만 바뀐 입력은 서버도 같은 것으로 본다). 하나라도 다르면 다른
 * 의도라서 새 `clientRunId`가 필요하다: 같은 id에 다른 내용을 보내면 서버가
 * `idempotency conflict`로 거절한다.
 */
export function intentKey(
  agentMemberId: string,
  channelId: string,
  input: {title: string; brief: string; repo?: string; branch?: string},
): string {
  return JSON.stringify([
    agentMemberId.toLowerCase(),
    channelId.toLowerCase(),
    input.title,
    input.brief,
    input.repo ?? null,
    input.branch ?? null,
  ]);
}

export interface RunIdSlot {
  key: string;
  id: string;
}

/**
 * 이번 의도에 쓸 id. 직전에 보낸 의도와 같으면 **같은 id**(재시도), 아니면 새 id.
 * `forceFresh`는 서버가 이 요청을 끝난 것으로 본 경우(`new_request`)다.
 */
export function nextRunId(
  previous: RunIdSlot | null,
  key: string,
  fresh: () => string,
  forceFresh = false,
): RunIdSlot {
  if (!forceFresh && previous !== null && previous.key === key) return previous;
  return {key, id: fresh()};
}

// ---- 거절이 시트에서 어떤 모양인가 ------------------------------------------------

/**
 * - `retry`: 「다시 보내기」(같은 id). 요청이 갔는지 모를 때.
 * - `new`: 「새로 맡기기」(새 id). 이 요청은 끝났다.
 * - `repick`: 이 시트에서 못 고친다. 다른 에이전트·채널을 고르게 한다. 재시도 없음.
 * - `edit`: 입력을 고쳐 다시 보낸다. 버튼 없음(칸이 말한다).
 */
export type FailureAction = 'retry' | 'new' | 'repick' | 'edit';

export function failureAction(failure: WorkRunFailure): FailureAction {
  switch (failure.next) {
    case 'retry_same':
      return 'retry';
    case 'new_request':
      return 'new';
    case 'fix_elsewhere':
      return 'repick';
    case 'edit':
      return 'edit';
  }
}

export const FAILURE_ACTION_LABEL: Readonly<Record<'retry' | 'new' | 'repick', string>> = {
  retry: '다시 보내기',
  new: '새로 맡기기',
  repick: '다른 곳에 맡기기',
};

// ---- 바이트 한도의 카운터 -----------------------------------------------------

/** 한도의 80%부터만 「조금 남았어요」를 보인다. 그 전에는 숫자를 보이지 않는다. */
export function nearLimit(bytes: number, limit: number): boolean {
  return bytes >= Math.floor(limit * 0.8);
}
