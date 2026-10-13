import type { RosterMember } from "../../lib/api";
import {
  GROK_HOSTED_AGENT_ID,
  HOSTED_AGENT_SIGNATURES,
  matchHostedAgentMember,
} from "./detect";
import {
  hostedStatusLabel,
  hostedStatusTone,
  isHostedTerminal,
  type HostedAgentConnection,
  type HostedChipTone,
} from "./model";
import type { HostedPresetId } from "./presets";
import { awaitingProof } from "./wizard";

// =============================================================================
// 「개인 비서」 목록의 행 모델 (#3773, Aside Settings › Channels 의 Personal
// Assistants 문법).
//
// 한 행 = 아이콘(이니셜) · 이름 · 상태 배지 · **주 행동 하나**. 이 파일은 화면이
// 그릴 것을 결정만 한다(순수 함수). 요청·타이머·위저드는 웹이 한다.
//
// ## 규율
//
// - **행당 행동은 최대 하나다.** 상태가 행동을 정한다: 연결 안 됨 → 연결, 연결 값
//   대기·만료 → 프롬프트 다시 받기, 감지됨 → 승인하기, 증명 대기 → 이어서 확인,
//   활성 → 관리. 두 번째 버튼을 더하는 변경은 이 모듈의 시험이 막는다.
// - **상태 어휘는 새로 만들지 않는다.** 연결 상태는 `hostedStatusLabel`, 활성 행의
//   배지는 ADR-0200 생존 라벨(`AgentLivenessLabel`)이 말한다. 이 모듈은 활성 행에
//   「생존 라벨을 그려라」라는 표지(`kind: "liveness"`)만 준다. 라벨의 낱말은 서버
//   판정을 옮기는 `livenessView` 의 것이다.
// - **연결할 수 없는 줄은 「곧」이다.** dots·Muse 는 oort 쪽에 실제 연동 경로가
//   없다. 눌러서 위저드로 들어가는 가짜 길을 만들지 않는다(`externalPresets.ts`
//   규칙 2와 같다).
// - **이름·제공사는 근거가 있을 때만 쓴다.** 제공사 문자열은 레포 안의 근거가
//   확인된 줄에만 채운다(`provider`). 근거가 없으면 비워 두고 화면은 그 줄을
//   그리지 않는다. 브랜드 로고는 쓰지 않고 이니셜만 쓴다.
// =============================================================================

export type PersonalAssistantId = "grok" | "dots" | "muse";

export interface PersonalAssistantEntry {
  id: PersonalAssistantId;
  name: string;
  /** 이니셜. 브랜드 로고를 쓰지 않는다. */
  mark: string;
  /**
   * 제공사 표기. 레포 안에 근거가 있을 때만 채운다.
   * - Muse: ADR-0186 L8 「Meta Muse」, ADR-0198 L101·L194 (에이전트 계열로 함께 호명).
   * - Grok Bot·dots: 레포에 제공사 문장이 없다. 비워 둔다(스크린샷의 표기는 근거가 아니다).
   */
  provider?: string;
  state: "available" | "soon";
  /** 한 줄 설명. 행의 이름 아래에 상시 선다. */
  note: string;
  presetId?: HostedPresetId;
}

export const PERSONAL_ASSISTANTS: readonly PersonalAssistantEntry[] = [
  {
    id: "grok",
    name: "그록봇",
    mark: "G",
    state: "available",
    note: "프롬프트 하나를 붙여 넣으면 연결돼요.",
    presetId: "grok",
  },
  {
    id: "dots",
    name: "dots",
    mark: "d",
    state: "soon",
    note: "연결 방식을 확인하는 중이라 아직 연결할 수 없어요.",
  },
  {
    id: "muse",
    name: "Muse",
    mark: "M",
    provider: "Meta",
    state: "soon",
    note: "연결 방식을 확인하는 중이라 아직 연결할 수 없어요.",
  },
];

export const PERSONAL_ASSISTANTS_COPY = {
  title: "개인 비서",
  lead: "이미 쓰고 있는 AI 비서를 팀의 멤버로 불러와요. 한 줄에서 한 번만 누르면 돼요.",
  listLabel: "개인 비서 목록",
  soonBadge: "곧",
  notConnectedBadge: "연결 안 됨",
  connectedBadge: "연결됨",
  manage: "관리",
  boundary:
    "연결 값은 한 번만 보이고, 승인은 항상 사람이 해요. 승인 전에는 어떤 대화도 읽지 못해요.",
} as const;

export interface PersonalAssistantLaunch {
  presetId: HostedPresetId;
  displayName: string;
  handle: string;
  connectionId?: string;
  autoAdvance?: "create" | "regenerate";
}

export type PersonalAssistantActionKind =
  | "connect"
  | "regenerate"
  | "approve"
  | "resume"
  | "manage";

export interface PersonalAssistantAction {
  kind: PersonalAssistantActionKind;
  label: string;
  /** `manage` 가 아니면 위저드가 받는 시작 값. */
  launch?: PersonalAssistantLaunch;
}

export type PersonalAssistantBadge =
  | { kind: "none"; text: string; tone: HostedChipTone }
  | { kind: "status"; text: string; tone: HostedChipTone }
  /** 활성 행: 서버가 파생한 생존 라벨을 그린다. 라벨이 없으면 `text` 로 물러난다. */
  | { kind: "liveness"; text: string; tone: HostedChipTone; agentMemberId: string }
  | { kind: "soon"; text: string; tone: HostedChipTone };

export interface PersonalAssistantRow {
  entry: PersonalAssistantEntry;
  badge: PersonalAssistantBadge;
  /** 없으면 그 행에는 버튼이 서지 않는다. 최대 하나다. */
  action: PersonalAssistantAction | null;
  connection: HostedAgentConnection | null;
}

function uuidEq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function grokIdentity() {
  const signature = HOSTED_AGENT_SIGNATURES.find((row) => row.id === GROK_HOSTED_AGENT_ID);
  if (!signature) throw new Error("grok signature missing");
  return signature.identity;
}

/** 이 멤버의 연결 중 사람이 이어갈 수 있는 것을 먼저, 없으면 가장 최근 것. */
function connectionFor(
  connections: readonly HostedAgentConnection[],
  memberId: string
): HostedAgentConnection | null {
  const mine = connections.filter((row) => uuidEq(row.agentMemberId, memberId));
  const live = mine.filter((row) => !isHostedTerminal(row.status));
  if (live.length > 0) {
    return [...live].sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0] ?? null;
  }
  return [...mine].sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0] ?? null;
}

function soonRow(entry: PersonalAssistantEntry): PersonalAssistantRow {
  return {
    entry,
    badge: { kind: "soon", text: PERSONAL_ASSISTANTS_COPY.soonBadge, tone: "neutral" },
    action: null,
    connection: null,
  };
}

function grokRow(
  entry: PersonalAssistantEntry,
  members: readonly RosterMember[],
  connections: readonly HostedAgentConnection[]
): PersonalAssistantRow {
  const identity = grokIdentity();
  const member = matchHostedAgentMember(members, identity);
  const connection = member ? connectionFor(connections, member.id) : null;
  const handleTaken = members.some(
    (row) =>
      row.status !== "deleted" &&
      row.handle.trim().toLowerCase() === identity.handle.toLowerCase()
  );
  const seed = { presetId: "grok" as const, displayName: identity.displayName, handle: identity.handle };

  // 연결이 없거나 끝난 것(해제 완료)이면 새로 시작한다. 정리 중(cleanup_pending)은
  // 아직 지워야 할 것이 남은 상태라 새 연결을 권하지 않는다.
  if (connection === null || connection.status === "disconnected") {
    return {
      entry,
      connection: null,
      badge: { kind: "none", text: PERSONAL_ASSISTANTS_COPY.notConnectedBadge, tone: "neutral" },
      action: {
        kind: "connect",
        label: "연결",
        launch: { ...seed, ...(handleTaken ? {} : { autoAdvance: "create" as const }) },
      },
    };
  }

  const badge: PersonalAssistantBadge = {
    kind: "status",
    text: hostedStatusLabel(connection.status),
    tone: hostedStatusTone(connection.status),
  };
  switch (connection.status) {
    case "pairing_pending":
    case "expired":
      return {
        entry,
        connection,
        badge,
        action: {
          kind: "regenerate",
          label: "프롬프트 다시 받기",
          launch: { ...seed, connectionId: connection.id, autoAdvance: "regenerate" },
        },
      };
    case "detected":
      return {
        entry,
        connection,
        badge,
        action: awaitingProof(connection)
          ? {
              kind: "resume",
              label: "이어서 확인",
              launch: { ...seed, connectionId: connection.id },
            }
          : {
              kind: "approve",
              label: "승인하기",
              launch: { ...seed, connectionId: connection.id },
            },
      };
    case "active":
      return {
        entry,
        connection,
        badge: {
          kind: "liveness",
          text: PERSONAL_ASSISTANTS_COPY.connectedBadge,
          tone: "ok",
          agentMemberId: connection.agentMemberId,
        },
        action: { kind: "manage", label: PERSONAL_ASSISTANTS_COPY.manage },
      };
    default:
      // cleanup_pending: 정리가 끝나야 다음이 열린다. 행동은 없다.
      return { entry, connection, badge, action: null };
  }
}

/**
 * 목록 한 벌. 순서는 카탈로그 순서다. 연결 목록을 아직 못 읽었으면(`connections`
 * 가 `null`) 연결 가능 행도 상태를 말하지 않고 행동도 세우지 않는다 — 읽지 못한
 * 것을 「연결 안 됨」으로 단정하면 이미 연결된 사람에게 새로 만들라고 권한다.
 */
export function personalAssistantRows(input: {
  members: readonly RosterMember[];
  connections: readonly HostedAgentConnection[] | null;
}): PersonalAssistantRow[] {
  return PERSONAL_ASSISTANTS.map((entry) => {
    if (entry.state === "soon") return soonRow(entry);
    if (input.connections === null) {
      return {
        entry,
        connection: null,
        badge: { kind: "none", text: "", tone: "neutral" },
        action: null,
      };
    }
    return grokRow(entry, input.members, input.connections);
  });
}

/** 온보딩 목록이 같은 카탈로그에서 「곧」 줄을 가져가는 길. */
export function soonPersonalAssistants(): readonly PersonalAssistantEntry[] {
  return PERSONAL_ASSISTANTS.filter((entry) => entry.state === "soon");
}
