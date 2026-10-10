import {
  callFailureLine,
  callPersonalAgent,
  CALL_MAC_OFF_LINE,
  labelFromPrompt,
  promptFromMessage,
  type CallDestination,
  type CallPersonalAgentInput,
  type PersonalAgentCall,
} from '@momo/core/features/auth/personalAgentCall';
import {spawnPromptText} from '@momo/core/features/auth/humanControlV4';
import type {HumanControlSigner} from '@momo/core/features/auth/signedControl';
import {mentionedHandles} from '@momo/core/features/routing/mentionTargets';
import {dmAutoReplyAgent} from '@momo/core/features/workspace/directory';
import type {Directory} from '@momo/core/features/workspace/directory';
import {
  ApiError,
  uuidEq,
  type Channel,
  type Message,
  type RosterMember,
  type WorkHost,
} from '@momo/core/lib/api';

import {personalAgentRows} from '../ai/aiSheetModel';
import {macState, ownMacs} from '../work/ask/model';

// =============================================================================
// 폰 컴포저 → 개인 에이전트 호출 (#3638, ADR-0198 증보 1 D7 · 「P1 확정」 4).
//
// 서버는 멘션에서 작업을 만들지 않는다. 소유자의 클라이언트가 (1) 메시지를 보내고 (2) 그
// 메시지 id를 서명해 `POST /work-spawns`를 한다 — 그 두 걸음은 코어 `callPersonalAgent`가
// 하고, 이 파일은 **누가 부르는가**(대상)와 **어디로**(목적지)를 정한다. 둘 다 서명에
// 들어가거나 서버가 신뢰하는 값이라 화면에서 떼어 둔다.
//
// ## 소유자만 부른다
//
// 대상은 **내 개인 에이전트**(로스터 `personalAgent.ownerId`가 나)뿐이다. 팀원의 별칭 멘션,
// 일반 에이전트 멘션은 대상이 아니라 평범한 메시지로 간다(서버가 팀원에게는 「소유자만 부를
// 수 있어요」 한 줄을 남긴다). 팀원·비소유자는 이 경로로 spawn이 만들어지지 않는다.
//
// ## 목적지는 내 맥뿐이다
//
// 호스트는 `scope=member`·소유자 == 나·해지되지 않은 맥(`ownMacs`)에서만 고른다. 꺼진 맥에는
// 서명하지 않는다(대기 요청 없음, D4 결재 6). 폴더는 맥이 알린 「질문용 폴더」
// (`defaultFolderId`)뿐이다 — 프로젝트 폴더로 대신하지 않는다(N5).
// =============================================================================

export interface CallTarget {
  memberId: string;
  /** 소문자 핸들. 프롬프트 맨 앞 `@별칭`을 떼는 기준이다. */
  handle: string;
  /** 하네스 키(`claude`·`codex`…), 서명의 `tool`. */
  harness: string;
}

/**
 * 이 글이 부르는 **내** 개인 에이전트. 둘 중 하나다.
 *   - 1:1 DM의 상대가 내 개인 에이전트(멘션 없이도).
 *   - 글에 적힌 `@별칭`이 내 개인 에이전트의 핸들(등장 순서의 첫 번째).
 * 아무도 아니면 `null` — 평범한 메시지다.
 */
export function personalAgentCallTarget(input: {
  body: string;
  channel: Channel | null;
  directory: Directory;
  members: readonly RosterMember[];
  selfId: string;
}): CallTarget | null {
  const rows = personalAgentRows(input.members, input.selfId);
  if (rows.length === 0) return null;
  const asTarget = (row: (typeof rows)[number]): CallTarget => ({
    memberId: row.id,
    handle: row.handle.toLowerCase(),
    harness: row.harnessKey,
  });
  if (input.channel !== null) {
    const peer = dmAutoReplyAgent(input.channel, input.directory, input.selfId);
    if (peer !== null) {
      const row = rows.find(candidate => uuidEq(candidate.id, peer.id));
      if (row !== undefined) return asTarget(row);
    }
  }
  for (const handle of mentionedHandles(input.body)) {
    const row = rows.find(candidate => candidate.handle.toLowerCase() === handle);
    if (row !== undefined) return asTarget(row);
  }
  return null;
}

export type DestinationPick =
  | {kind: 'ok'; destination: CallDestination}
  /** 보낼 수 없다 — 서명 없이 메시지만 간다. `sentence`가 이유다. */
  | {kind: 'none'; sentence: string};

/** 내 켜진 맥 하나와 그 맥의 질문용 폴더. 서버가 읽어 준 값 그대로다. */
export function pickDestination(
  hosts: readonly WorkHost[] | undefined,
  selfId: string,
  harness: string,
): DestinationPick {
  const state = macState(ownMacs(hosts, selfId));
  if (state.kind === 'none') {
    return {
      kind: 'none',
      sentence: callFailureLine(new ApiError(404, '', 'spawn_host_not_found')),
    };
  }
  if (state.kind === 'off') return {kind: 'none', sentence: CALL_MAC_OFF_LINE};
  const mac = state.macs[0];
  if (mac === undefined || mac.defaultFolderId === null) {
    return {
      kind: 'none',
      sentence: callFailureLine(new ApiError(409, '', 'spawn_folder_not_found')),
    };
  }
  return {
    kind: 'ok',
    destination: {hostId: mac.id, folderId: mac.defaultFolderId, tool: harness},
  };
}

export interface CallDeps {
  fetchHosts: (workspaceId: string) => Promise<WorkHost[]>;
  fetchSessionIds: (workspaceId: string) => Promise<string[]>;
  call: (input: CallPersonalAgentInput) => ReturnType<typeof callPersonalAgent>;
  newClientMsgId: () => string;
}

export type CallRun =
  /** 부르지 않았다 — 호출하는 쪽이 평범한 메시지로 보내고 `sentence`를 말한다. */
  | {kind: 'plain'; sentence: string}
  /** 메시지 전송 자체가 실패했다 — 호출하는 쪽이 평범한 전송(실패 줄·재시도)으로 맡는다. */
  | {kind: 'unsent'}
  | {
      kind: 'sent';
      message: Message;
      call: PersonalAgentCall;
      /** 호출이 맥에 닿았을 때만: 만들어질 세션을 찾는 단서. */
      wait: null | {
        before: ReadonlySet<string>;
        hostId: string;
        channelId: string;
        label: string;
      };
    };

/**
 * 한 번의 호출: 목적지 → 메시지 전송 → (Face ID) 서명 → `/work-spawns`.
 * 서명 전에 알 수 있는 막힘(맥 없음·꺼짐·폴더 없음)은 Face ID를 올리지 않고 `plain`이다.
 */
export async function runPersonalAgentCall(
  input: {
    workspaceId: string;
    channelId: string;
    selfId: string;
    body: string;
    target: CallTarget;
    signer: HumanControlSigner;
  },
  deps: CallDeps,
): Promise<CallRun> {
  let hosts: WorkHost[];
  try {
    hosts = await deps.fetchHosts(input.workspaceId);
  } catch {
    return {kind: 'plain', sentence: callFailureLine(undefined)};
  }
  const pick = pickDestination(hosts, input.selfId, input.target.harness);
  if (pick.kind === 'none') return {kind: 'plain', sentence: pick.sentence};

  let before: Set<string>;
  try {
    before = new Set(await deps.fetchSessionIds(input.workspaceId));
  } catch {
    // 세션 목록을 못 읽으면 어느 세션이 새것인지 알 수 없다 — 호출은 하되 작업 목록으로 간다.
    before = new Set();
  }

  let result: Awaited<ReturnType<typeof callPersonalAgent>>;
  try {
    result = await deps.call({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      clientMsgId: deps.newClientMsgId(),
      text: input.body,
      agent: {memberId: input.target.memberId, handle: input.target.handle},
      destination: pick.destination,
      signer: input.signer,
    });
  } catch {
    return {kind: 'unsent'};
  }

  let wait: Extract<CallRun, {kind: 'sent'}>['wait'] = null;
  if (result.call.state === 'called') {
    try {
      const prompt = spawnPromptText(
        promptFromMessage(input.body, input.target.handle),
      );
      wait = {
        before,
        hostId: pick.destination.hostId,
        channelId: input.channelId,
        label: labelFromPrompt(prompt),
      };
    } catch {
      wait = null;
    }
  }
  return {kind: 'sent', message: result.message, call: result.call, wait};
}
