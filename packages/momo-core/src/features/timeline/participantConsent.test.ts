import { describe, expect, it } from "vitest";
import type { Message } from "../../lib/api";
import { agentRequestBundle } from "./agentCardModel";
import {
  approvalCardNote,
  isParticipantConsent,
  participantWaitingLine,
  waitsForParticipant,
} from "./approvalNote";
import { requestLoopCopyViolations } from "./requestBundle";

// #4920. 두 트랙을 합친 트리에서 DM 들이기 허락 카드(ADR-0217, 행동 `dm.agent.admit`)가 결정할 사람을
// 틀리게 말했다. 묶음 카드의 대체 문장 「관리자의 승인을 기다려요」와 현행 카드의 「이 카드에 표시된
// 참여자의 허락을 기다려요.」가 요청자에게 함께 섰다. 서버는 초대한 사람을 뺀 사람마다 카드를 한 장씩
// 만들고 카드마다 결정자 한 명을 고정한다. 그래서 한 장의 카드가 기다리는 사람은 언제나 그 한 사람이다.
const NOW = 1_800_000_000_000;
const REQUESTER = "00000000-0000-7000-8000-0000000000a1";
const TARGET = "00000000-0000-7000-8000-0000000000b2";
const PEER = "00000000-0000-7000-8000-0000000000c3";
const NAMES: Record<string, string> = {
  [REQUESTER]: "김인턴",
  [TARGET]: "박연구원",
  [PEER]: "이도현",
};
// 사람 이름 줄은 손으로 적었어요. 문장을 만드는 함수와 시험이 같은 틀을 공유하면 둘이 함께 틀려도 초록이에요.
const TARGET_LINE = "박연구원 님의 허락을 기다려요";
const PEER_LINE = "이도현 님의 허락을 기다려요";
const UNNAMED_LINE = "다른 참여자의 허락을 기다려요";

function consentCard(target: string = TARGET, extra: Record<string, unknown> = {}): Message {
  return {
    id: "0199aa00-0000-7000-8000-00000000abcd",
    channelId: "00000000-0000-7000-8000-000000000201",
    seq: 42,
    hlcTs: 1_753_400_000_000,
    hlcCount: 0,
    // 카드의 작성자는 초대한 사람(요청자)이에요.
    authorMemberId: REQUESTER,
    type: "approval_request",
    body: "코메토 들이기 허락을 기다려요",
    state: "sent",
    createdAtMs: 1_753_400_000_000,
    props: {
      approval_id: "approval-consent",
      action_type: "workspace_action",
      status: "pending",
      title: "에이전트를 이 대화에 들이기",
      expires_at_ms: NOW + 15 * 60_000,
      target_member_id: target,
      action: {
        id: "dm.agent.admit",
        required_role: "dm_participant",
        target_member_id: target,
        rows: [{ label: "에이전트", value: "코메토 (@kometto)" }],
      },
      ...extra,
    },
  } as unknown as Message;
}

function viewedBy(
  viewerMemberId: string | undefined,
  message: Message = consentCard(),
  extra: Record<string, unknown> = {}
) {
  const model = agentRequestBundle(message, {
    nowMs: NOW,
    nameFor: (id) => NAMES[id],
    ...(viewerMemberId !== undefined ? { viewerMemberId } : {}),
    viewerKind: "human",
    canDecide: true,
    ...extra,
  });
  if (model === null) throw new Error("approval card expected");
  return model;
}

/** 카드 얼굴. 접힌 「자세히」(결정 권한 행)는 이 이슈의 범위 밖이라 얼굴에서 뺀다. */
function face(model: ReturnType<typeof viewedBy>): string {
  const { details: _details, ...rest } = model;
  return JSON.stringify(rest);
}

describe("참여자 동의 카드는 결정할 사람을 이름으로 말해요 (#4920)", () => {
  it.each([
    ["요청한 사람", REQUESTER, false, TARGET_LINE],
    ["결정할 사람 본인", TARGET, true, undefined],
    ["세 사람 이상 대화의 다른 참여자", PEER, false, TARGET_LINE],
  ] as const)("%s에게는 단추 여부와 기다리는 줄이 이렇게 서요", (_who, viewer, canDecide, line) => {
    const model = viewedBy(viewer);
    expect(model.state).toBe("approval");
    expect(model.canDecide).toBe(canDecide);
    expect(model.waitingFor).toBe(line);
    // 기다리는 줄은 있어도 하나뿐이고, 관리자를 말하지 않으며 카드에 없는 것을 가리키지도 않아요.
    expect(face(model)).not.toMatch(/관리자|표시된/u);
    expect(face(model).match(/기다려요/gu) ?? []).toHaveLength(line === undefined ? 0 : 1);
  });

  it("카드마다 자기 결정자의 이름을 말해요: 세 사람 대화에서 요청자는 서로 다른 두 줄을 본다", () => {
    const forTarget = viewedBy(REQUESTER, consentCard(TARGET));
    const forPeer = viewedBy(REQUESTER, consentCard(PEER, { approval_id: "approval-consent-2" }));
    expect(forTarget.waitingFor).toBe(TARGET_LINE);
    expect(forPeer.waitingFor).toBe(PEER_LINE);
    // 같은 카드를 보는 두 번째 사람도 같은 한 사람을 말해요(「다른 사람 모두」가 아니에요).
    expect(viewedBy(PEER, consentCard(TARGET)).waitingFor).toBe(TARGET_LINE);
    expect(viewedBy(TARGET, consentCard(PEER, { approval_id: "approval-consent-2" })).waitingFor).toBe(PEER_LINE);
  });

  it("결정자는 대소문자만 다른 아이디여도 결정자예요", () => {
    expect(viewedBy(TARGET.toUpperCase()).canDecide).toBe(true);
    expect(viewedBy(TARGET.toUpperCase()).waitingFor).toBeUndefined();
  });

  it("관리자 역할이어도 결정자가 아니면 기다리는 쪽이고 관리자 문장을 받지 않아요", () => {
    const model = viewedBy(PEER, consentCard(TARGET), { isWorkspaceAdmin: true });
    expect(model.canDecide).toBe(false);
    expect(model.waitingFor).toBe(TARGET_LINE);
  });

  it("명부에서 이름을 못 풀면 이름 없이 말하고, 그래도 관리자를 세우지 않아요", () => {
    for (const nameFor of [() => undefined, () => "", () => "   "]) {
      const model = viewedBy(REQUESTER, consentCard(), { nameFor });
      expect(model.waitingFor).toBe(UNNAMED_LINE);
      expect(face(model)).not.toMatch(/관리자|표시된/u);
    }
    // nameFor를 아예 받지 못한 호출도 같아요.
    expect(viewedBy(REQUESTER, consentCard(), { nameFor: undefined }).waitingFor).toBe(UNNAMED_LINE);
  });

  it("보는 사람을 모르면 기다리는 쪽이고, 결정자를 모르는 카드도 아무에게나 열지 않아요", () => {
    const anonymous = viewedBy(undefined);
    expect(anonymous.canDecide).toBe(false);
    expect(anonymous.waitingFor).toBe(TARGET_LINE);
    const noTarget = consentCard();
    delete (noTarget.props as Record<string, unknown>).target_member_id;
    delete ((noTarget.props as Record<string, unknown>).action as Record<string, unknown>).target_member_id;
    for (const viewer of [REQUESTER, TARGET, PEER]) {
      const model = viewedBy(viewer, noTarget);
      expect(model.canDecide).toBe(false);
      expect(model.waitingFor).toBe(UNNAMED_LINE);
    }
  });

  it("결정자 본인은 지금 결정을 못 보내는 때에도 자기 자신을 기다리지 않고 관리자도 기다리지 않아요", () => {
    // 폰이 대기 목록에서 이 승인을 못 찾는 때(`canDecide: false`)와 같아요.
    const model = viewedBy(TARGET, consentCard(), { canDecide: false });
    expect(model.canDecide).toBe(false);
    expect(model.waitingFor).toBeUndefined();
    expect(face(model)).not.toContain("관리자");
  });

  it("결정이 끝난 참여자 동의 카드는 기다리는 줄 없이 상태 문장 그대로예요", () => {
    for (const [status, sentence] of [
      ["rejected", "거부됐어요"],
      ["expired", "승인을 기다리다 만료됐어요"],
      ["cancelled", "요청이 취소됐어요"],
    ] as const) {
      const model = viewedBy(REQUESTER, consentCard(TARGET, { status }));
      expect(model.waitingFor).toBeUndefined();
      expect(model.sentence).toBe(sentence);
    }
  });
});

describe("다른 승인 카드의 대기 문장과 결정 판정은 그대로예요 (#4920)", () => {
  const tool = (props: Record<string, unknown> = {}): Message => ({
    ...consentCard(),
    authorMemberId: "agent",
    props: { approval_id: "approval-tool", action_type: "tool_call", tool_name: "shell", status: "pending", ...props },
  } as unknown as Message);

  it("도구 승인은 결정할 사람이 여럿이면 관리자를, 한 사람이면 그 사람의 승인을 말해요", () => {
    expect(viewedBy(PEER, tool(), { canDecide: false }).waitingFor).toBe("관리자의 승인을 기다려요");
    expect(viewedBy(PEER, tool(), { canDecide: false, approverMemberIds: [TARGET, PEER] }).waitingFor).toBe("관리자의 승인을 기다려요");
    expect(viewedBy(PEER, tool(), { canDecide: false, approverMemberIds: [TARGET] }).waitingFor).toBe("박연구원 님의 승인을 기다려요");
  });

  it("참여자 동의가 아닌 행동은 결정자 고정 필드가 곁에 붙어 있어도 이 판정을 받지 않아요", () => {
    const profile = (viewer: string, canDecide: boolean) =>
      viewedBy(viewer, consentCard(TARGET, { action: { id: "agent.profile.update", required_role: "agent_editor", target_member_id: TARGET, rows: [] } }), { canDecide });
    // 결정할 수 있는 사람은 요청자가 아니면 누구나 단추를 받고, 못 하는 사람은 관리자 문장을 받아요.
    expect(profile(PEER, true).canDecide).toBe(true);
    expect(profile(PEER, true).waitingFor).toBeUndefined();
    expect(profile(PEER, false).waitingFor).toBe("관리자의 승인을 기다려요");
    expect(isParticipantConsent({ id: "agent.profile.update", requiredRole: "agent_editor", targetMemberId: TARGET })).toBe(false);
  });
});

describe("참여자 동의 카드의 판정과 문장은 한 곳이 져요 (#4920)", () => {
  it("판정: 결정자 본인만 기다리지 않고, 모르면 기다려요, 다른 카드는 해당 없어요", () => {
    const admit = { id: "dm.agent.admit", requiredRole: "dm_participant", targetMemberId: TARGET };
    expect(isParticipantConsent(admit)).toBe(true);
    expect(isParticipantConsent({ id: "future.action", requiredRole: "dm_participant" })).toBe(true);
    expect(isParticipantConsent({ id: "channel.create", requiredRole: "workspace_operator" })).toBe(false);
    expect(isParticipantConsent(null)).toBe(false);
    expect(waitsForParticipant(admit, TARGET)).toBe(false);
    expect(waitsForParticipant(admit, TARGET.toUpperCase())).toBe(false);
    expect(waitsForParticipant(admit, REQUESTER)).toBe(true);
    expect(waitsForParticipant(admit, undefined)).toBe(true);
    expect(waitsForParticipant({ id: "dm.agent.admit" }, TARGET)).toBe(true);
    expect(waitsForParticipant({ id: "channel.create", requiredRole: "workspace_operator" }, PEER)).toBe(false);
    expect(waitsForParticipant(null, PEER)).toBe(false);
  });

  it("묶음 카드의 대기 줄과 현행 카드의 참여자 줄은 같은 문장이에요", () => {
    for (const [name, line] of [["박연구원", TARGET_LINE], [undefined, UNNAMED_LINE]] as const) {
      expect(participantWaitingLine(name)).toBe(line);
      const note = approvalCardNote({
        waitingForParticipant: true,
        ...(name !== undefined ? { participantName: name } : {}),
        settled: false,
        hasTarget: true,
        pendingHere: true,
        offline: false,
        approvalsProvided: true,
      });
      expect(note).toEqual({ kind: "participant", tone: "guidance", text: line });
      const model = viewedBy(REQUESTER, consentCard(), { nameFor: () => name });
      expect(model.waitingFor).toBe(note?.text);
    }
  });

  it("끊긴 연결에서도 결정자가 아닌 사람은 연결이 돌아와도 못 하는 결정을 안내받지 않아요", () => {
    const note = approvalCardNote({
      waitingForParticipant: true,
      participantName: "박연구원",
      settled: false,
      hasTarget: true,
      pendingHere: true,
      offline: true,
      approvalsProvided: true,
    });
    expect(note?.kind).toBe("participant");
    expect(note?.text).toBe(TARGET_LINE);
    // 결정자 본인이 끊겼을 때는 그대로 연결 문장이에요.
    expect(
      approvalCardNote({ settled: false, hasTarget: true, pendingHere: true, offline: true, approvalsProvided: true })?.kind
    ).toBe("offline");
  });

  it("두 문장 모두 요청 고리 문구 프리플라이트를 지나요", () => {
    for (const line of [TARGET_LINE, PEER_LINE, UNNAMED_LINE]) {
      expect(requestLoopCopyViolations(line)).toEqual([]);
      expect(line).not.toMatch(/관리자|표시된|[.!?]$/u);
    }
  });
});
