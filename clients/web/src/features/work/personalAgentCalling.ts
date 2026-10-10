// =============================================================================
// 컴포저에서 내 개인 에이전트 부르기 (#3653, ADR-0198 증보 1 D7 · P1 확정).
//
// 서버는 멘션을 보고 스스로 일을 시작하지 않는다. 소유자의 클라이언트가
// core `callPersonalAgent`로 (1) 메시지를 보내고 (2) 그 메시지 id를 서명해
// `POST /work-spawns` 한다. 이 파일은 그 앞뒤의 웹 몫이다.
//
//   - 누가 부르는가: 로스터 `personalAgent`를 **좁게** 읽는다(폰 `aiSheetModel`과
//     같은 규칙). 소유자가 나이고 켜져 있고 부를 수 있을 때만 호출 계획이 선다.
//     팀원·비소유자는 계획이 없다 — 그냥 보내고, 서버가 NonOwner 문장을 남긴다.
//     이 판정은 안내용이고 문은 서버다.
//   - 어디로: 내 맥(`scope=member`, 내 것, 폐기 안 됨)과 그 호스트의 질문용 기본
//     폴더(`defaultFolderId`). 폴더를 고르는 화면은 이 범위 밖이다.
//   - 서명: 데스크탑 셸이면 데스크탑 서명자, 브라우저면 키 없음(null).
// =============================================================================

import {
  callFailureLine,
  callPersonalAgent,
  type CallDestination,
  type PersonalAgentCall,
  type PersonalAgentCallResult,
} from "@momo/core/features/auth/personalAgentCall";
import { SignerRefusal, type HumanControlSigner } from "@momo/core/features/auth/signedControl";
import { mentionedAgents } from "@momo/core/features/routing/mentionTargets";
import { ApiError, uuidEq, type Message, type RosterMember, type WorkHost } from "@momo/core/lib/api";

/** 로스터가 준 개인 에이전트 한 명(내 것). */
export interface MyPersonalAgent {
  memberId: string;
  handle: string;
  /** 로스터의 `personalAgent.label` (예: 「내 Claude Code」). */
  label: string;
  /** 서명에 들어가는 하네스 키 (`claude`, `codex`). */
  harness: string;
}

/** 사람 말 하네스 이름. 모르는 키는 그대로 보인다. */
const HARNESS_NAME: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  claude_code: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export function harnessName(harness: string): string {
  return Object.prototype.hasOwnProperty.call(HARNESS_NAME, harness) ? HARNESS_NAME[harness]! : harness;
}

/**
 * 이 로스터 행이 **내** 개인 에이전트면 그 값, 아니면 null. 모양이 맞지 않으면
 * 없는 것과 같다(구서버는 이 필드를 보내지 않는다).
 */
export function myPersonalAgent(member: RosterMember, selfId: string): MyPersonalAgent | null {
  if (member.kind !== "agent" || member.status !== "active") return null;
  const personal = (member as unknown as Record<string, unknown>).personalAgent;
  if (typeof personal !== "object" || personal === null) return null;
  const value = personal as Record<string, unknown>;
  if (
    typeof value.ownerId !== "string" ||
    typeof value.harness !== "string" ||
    value.harness.trim() === "" ||
    value.enabled !== true ||
    value.mentionable !== true
  ) {
    return null;
  }
  if (!uuidEq(value.ownerId, selfId)) return null;
  const label = typeof value.label === "string" && value.label.trim() !== "" ? value.label.trim() : member.displayName;
  return { memberId: member.id, handle: member.handle, label, harness: value.harness };
}

/** 내 맥과 질문용 기본 폴더. 둘 다 있어야 서명할 수 있다. */
export interface CallHost {
  hostId: string;
  hostName: string;
  folderId: string;
  online: boolean;
}

/**
 * 부를 내 맥. 온라인인 맥을 먼저, 그다음 폴더가 있는 맥. 남의 호스트·팀 공용·폐기된 호스트는
 * 후보가 아니다(서버가 같은 규칙으로 도출한다). 없으면 null.
 */
export function pickCallHost(hosts: readonly WorkHost[] | undefined, selfId: string): CallHost | null {
  const mine = (hosts ?? []).filter(
    (host) =>
      host.scope === "member" &&
      uuidEq(host.ownerMemberId, selfId) &&
      host.revokedAtMs === undefined &&
      typeof host.defaultFolderId === "string" &&
      host.defaultFolderId !== ""
  );
  const chosen = mine.find((host) => host.online) ?? mine[0];
  if (!chosen || chosen.defaultFolderId === undefined) return null;
  return {
    hostId: chosen.id,
    hostName: chosen.displayName,
    folderId: chosen.defaultFolderId,
    online: chosen.online,
  };
}

/** 전송 직전 컴포저 근처에 보이는 한 줄의 재료. */
export interface CallPreview {
  /** 「내 맥 · <기기> · Claude Code」 — 못 보내는 이유가 있으면 null. */
  destination: string | null;
  /** 이 글을 누가 읽는가: 채널 멤버 전부 / 대화 상대만. */
  audience: "channel" | "dm";
  /** 보내도 일이 시작되지 않는 이유 한 문장(웹·맥 미연결). 있으면 `destination`은 null. */
  blocked: string | null;
}

export const NO_MAC_LINE = callFailureLine(new ApiError(404, "", "spawn_host_not_found"));
export const FLAG_OFF_LINE = callFailureLine(new ApiError(403, "", "signed_spawn_disabled"));

/** 이 글이 부르는 내 개인 에이전트(처음 하나). DM이면 상대가 곧 대상이다. */
export function callTargetFor(input: {
  text: string;
  members: RosterMember[];
  selfId: string;
  dmAgent: RosterMember | null;
}): MyPersonalAgent | null {
  if (input.text.trim() === "") return null;
  for (const agent of mentionedAgents(input.text, input.members)) {
    const mine = myPersonalAgent(agent, input.selfId);
    if (mine) return mine;
  }
  if (input.dmAgent) return myPersonalAgent(input.dmAgent, input.selfId);
  return null;
}

/** 한 번의 호출에 필요한 것 전부. 컴포저가 들고 있다가 전송에 싣는다. */
export interface PersonalCallSpec {
  agent: MyPersonalAgent;
  /** 내 맥. null이면 서명할 수 없다(웹이면 상관없다 — 서명 자체가 없다). */
  host: CallHost | null;
  /** 데스크탑 셸의 서명자, 브라우저는 null. */
  signer: HumanControlSigner | null;
  audience: "channel" | "dm";
  /** 결과가 나오면 한 번 부른다(메시지는 이미 보내진 뒤다). */
  onResult: (result: PersonalAgentCallResult) => void;
}

export function previewFor(spec: Pick<PersonalCallSpec, "agent" | "host" | "signer" | "audience">): CallPreview {
  const { agent, host, signer, audience } = spec;
  if (signer === null) {
    return { destination: null, audience, blocked: "웹에서는 메시지만 보내져요. 데스크탑·폰에서 불러 주세요." };
  }
  if (host === null) return { destination: null, audience, blocked: NO_MAC_LINE };
  return {
    destination: `내 맥 · ${host.hostName} · ${harnessName(agent.harness)}`,
    audience,
    blocked: null,
  };
}

/**
 * 메시지를 보내고(`deliver`) 서명해 부른다. 메시지를 못 보내면 던진다 — 그때는 아무것도
 * 서명하지 않았다. 그 뒤의 모든 결과는 반환값에 있다.
 */
export async function runPersonalAgentCall(input: {
  workspaceId: string;
  channelId: string;
  clientMsgId: string;
  text: string;
  spec: PersonalCallSpec;
  deliver: () => Promise<Message>;
}): Promise<PersonalAgentCallResult> {
  const { spec } = input;
  const base = {
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    clientMsgId: input.clientMsgId,
    text: input.text,
    agent: { memberId: spec.agent.memberId, handle: spec.agent.handle },
    deliver: input.deliver,
  };
  if (spec.signer === null) {
    // 서명 키가 없다: 메시지만 가고 안내가 남는다. 목적지는 읽히지 않는다.
    return callPersonalAgent({
      ...base,
      signer: null,
      destination: { hostId: "", folderId: "", tool: spec.agent.harness },
    });
  }
  if (spec.host === null) {
    // 내 맥이 없다: 서명할 호스트·폴더가 없다. 메시지는 보내고 이유를 말한다.
    const message = await input.deliver();
    const call: PersonalAgentCall = {
      state: "not_delivered",
      stage: "server",
      text: NO_MAC_LINE,
      error: new ApiError(404, "", "spawn_host_not_found"),
      signed: null,
    };
    return { message, call };
  }
  const destination: CallDestination = {
    hostId: spec.host.hostId,
    folderId: spec.host.folderId,
    tool: spec.agent.harness,
  };
  return callPersonalAgent({ ...base, signer: spec.signer, destination });
}

/**
 * 서버가 서명 요구를 꺼 둔 것을 이미 알 때의 서명자. 서명 창(Touch ID)을 띄우지 않고
 * 메시지가 간 뒤 이유를 말한다. 모르면(null) 이 서명자를 쓰지 않는다 — 서버가 정한다.
 */
export function flagOffSigner(): HumanControlSigner {
  return {
    async sign() {
      throw new SignerRefusal(FLAG_OFF_LINE);
    },
  };
}
