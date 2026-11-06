import { describe, expect, it } from "vitest";
import { approvalItem, type ActorNames } from "@momo/core/features/inbox/model";
import type { Approval } from "@momo/core/lib/api";
import {
  approvalRowControl,
  awaitedApprovalId,
  decidableCount,
} from "./approvalsPanel";
import { needsMeFrom } from "./useNeedsMe";

// =============================================================================
// 받은함은 어떤 승인에 승인·거부를 세우지 않는가 (#5462, planner 2026-11-07).
//
// 이모티콘 세트의 계획 카드(`expression.set.plan`)와 세트 카드(`expression.set.create`)는 받은함의 일반
// 승인 단추로 확정하지 않는다: 계획 카드는 참조 썸네일·장수·처음 한 번의 고지를 **본 채로** 눌러야 하고(ADR-0218
// §12 L2.5, 보안 검수 R2-H1), 세트 카드는 칸을 골라야 한다. 이 파일은 그 판정(`approvalRowControl`)과 그 판정을
// 읽는 수(배지)를 못 박는다. 화면(「열기」 한 개)은 `InboxDetail.open.test.tsx`가 잰다.
//
// 픽스처는 서버 승인 행 모양 그대로 만들어 진짜 `approvalItem`을 태운다(손으로 빚은 FeedItem은 자기가 만든 모양만 검사한다).
// =============================================================================

const NOW_MS = 1_785_238_400_000;
const AGENT: ActorNames = {
  name: "오르트 도우미",
  handle: "oort",
  isAgent: true,
  ownerName: "곽성재",
};

function actionApproval(
  id: string,
  workspaceActionId: string | undefined,
  decisionMode?: "inline" | "open"
): Approval {
  return {
    id,
    workspaceId: "00000000-0000-7000-8000-000000000001",
    runId: "00000000-0000-7000-8000-000000000301",
    channelId: "00000000-0000-7000-8000-000000000201",
    requestedBy: "00000000-0000-7000-8000-000000000102",
    actionType: "workspace_action",
    status: "pending",
    expiresAtMs: NOW_MS + 600_000,
    ...(workspaceActionId === undefined ? {} : { workspaceActionId }),
    ...(decisionMode === undefined ? {} : { decisionMode }),
  };
}

function row(id: string, workspaceActionId: string | undefined, decisionMode?: "inline" | "open") {
  return approvalItem(actionApproval(id, workspaceActionId, decisionMode), AGENT, "#emoji", NOW_MS);
}

describe("approvalRowControl: 카드로 보내는 승인 (#5462)", () => {
  it.each(["expression.set.plan", "expression.set.create"])(
    "%s 는 승인·거부 컨트롤이 아니라 열기를 받는다 — 연결이 끊겨도 같다",
    (id) => {
      const item = row("a1", id);
      expect(approvalRowControl(item, { offline: false })).toEqual({ kind: "open", approvalId: "a1" });
      // 「열기」는 결정이 아니라 그 대화로 가는 길이다: 오프라인 줄로 대신하지 않는다.
      expect(approvalRowControl(item, { offline: true })).toEqual({ kind: "open", approvalId: "a1" });
    }
  );

  it("이 클라이언트가 이미 결정한 승인에는 열기도 서지 않는다", () => {
    expect(approvalRowControl(row("a1", "expression.set.plan"), { offline: false, settled: true })).toEqual({
      kind: "none",
    });
  });

  it("서버가 open 을 찍은 다른 행동도 열기를 받고, 값이 없거나 inline 이면 이전 그대로 결정 컨트롤을 받는다", () => {
    expect(approvalRowControl(row("a1", "channel.create", "open"), { offline: false })).toEqual({
      kind: "open",
      approvalId: "a1",
    });
    for (const mode of [undefined, "inline"] as const) {
      expect(approvalRowControl(row("a2", "channel.create", mode), { offline: false })).toEqual({
        kind: "decide",
        approvalId: "a2",
      });
      expect(approvalRowControl(row("a2", "channel.create", mode), { offline: true })).toEqual({
        kind: "offline",
      });
    }
  });

  it("서버가 inline 을 찍어도 목록의 행동은 열기를 받는다 (잠금 화면 결정이 아니라 카드를 보고 누르는 동의)", () => {
    expect(approvalRowControl(row("a1", "expression.set.create", "inline"), { offline: false }).kind).toBe("open");
  });
});

describe("카드로 보내는 승인도 내가 결정할 일이다 (#5462)", () => {
  const items = [
    row("plan", "expression.set.plan"),
    row("set", "expression.set.create"),
    row("channel", "channel.create"),
    row("server-open", "message.pin", "open"),
  ];

  it("awaitedApprovalId 는 결정 컨트롤과 열기에만 id 를 준다", () => {
    expect(awaitedApprovalId({ kind: "decide", approvalId: "d" })).toBe("d");
    expect(awaitedApprovalId({ kind: "open", approvalId: "o" })).toBe("o");
    expect(awaitedApprovalId({ kind: "offline" })).toBeNull();
    expect(awaitedApprovalId({ kind: "none" })).toBeNull();
  });

  it("배지는 열기 승인을 센다 — 단추가 받은함에 없어도 결정은 내 몫이다", () => {
    expect(decidableCount(items)).toBe(4);
    // 같은 입력에서 배지의 수와 「결정을 기다리는 행」의 수는 어긋나지 않는다.
    expect(items.filter((item) => awaitedApprovalId(approvalRowControl(item, { offline: false })) !== null)).toHaveLength(
      decidableCount(items)
    );
  });

  it("「나에게 필요한 일」의 승인 수도 열기 승인을 센다", () => {
    const needs = needsMeFrom({ approvalItems: items, paneEntries: [], unreadMentions: 0, desktop: false });
    expect(needs.total).toBe(4);
  });
});
