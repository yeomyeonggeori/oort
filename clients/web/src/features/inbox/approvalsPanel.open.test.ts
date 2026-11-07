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
// §12 L2.5, 보안 검수 R2-H1), 세트 카드는 칸을 골라야 한다. 이 규칙은 **이 두 행동 id의 닫힌 목록에만** 걸린다: 서버가
// 찍는 `decision_mode: open`은 받은함이 따르지 않으므로, 서버가 `open`을 찍는 기존 승인(`work.spawn` 호스트 고르개,
// `message.pin`, 아바타·이름 변경 …)의 받은함 모습은 예전 그대로다(서버 open을 받은함에서 따르는 것은 #4765의 몫).
// 이 파일은 그 판정(`approvalRowControl`)과 그 판정을 읽는 수(배지)를 못 박는다. 화면(「열기」 한 개)은
// `InboxDetail.open.test.tsx`가 잰다.
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

function approvalRow(
  id: string,
  workspaceActionId: string | undefined,
  decisionMode?: "inline" | "open",
  actionType = "workspace_action"
): Approval {
  return {
    id,
    workspaceId: "00000000-0000-7000-8000-000000000001",
    runId: "00000000-0000-7000-8000-000000000301",
    channelId: "00000000-0000-7000-8000-000000000201",
    requestedBy: "00000000-0000-7000-8000-000000000102",
    actionType,
    status: "pending",
    expiresAtMs: NOW_MS + 600_000,
    ...(workspaceActionId === undefined ? {} : { workspaceActionId }),
    ...(decisionMode === undefined ? {} : { decisionMode }),
  };
}

function row(id: string, workspaceActionId: string | undefined, decisionMode?: "inline" | "open", actionType?: string) {
  return approvalItem(approvalRow(id, workspaceActionId, decisionMode, actionType), AGENT, "#emoji", NOW_MS);
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

  it("서버가 값을 안 싣든 inline 이든 open 이든 목록의 행동은 열기를 받는다 (잠금 화면 결정이 아니라 카드를 보고 누르는 동의)", () => {
    for (const id of ["expression.set.plan", "expression.set.create"]) {
      for (const mode of [undefined, "inline", "open"] as const) {
        expect(approvalRowControl(row("a1", id, mode), { offline: false }).kind, `${id} (서버 ${mode ?? "값 없음"})`).toBe("open");
      }
    }
  });

  it("서버가 open 을 찍어도 다른 행동은 예전처럼 승인·거부 컨트롤을 받는다 — 기존 승인의 받은함 모습은 그대로다 (planner 11-07)", () => {
    // 서버가 `open`을 찍는 기존 승인들: 행동 승인(`message.pin`·아바타·이름)과 호스트를 고르는 `work.spawn`(행동 id 없음).
    const existing: [string, string | undefined, string][] = [
      ["a1", "channel.create", "workspace_action"],
      ["a2", "message.pin", "workspace_action"],
      ["a3", "member.avatar.set", "workspace_action"],
      ["a4", "member.display_name.set", "workspace_action"],
      ["a5", "expression.create", "workspace_action"],
      ["a6", undefined, "work.spawn"],
    ];
    for (const [id, actionId, actionType] of existing) {
      for (const mode of [undefined, "inline", "open"] as const) {
        const label = `${actionId ?? actionType} (서버 ${mode ?? "값 없음"})`;
        expect(approvalRowControl(row(id, actionId, mode, actionType), { offline: false }), label).toEqual({
          kind: "decide",
          approvalId: id,
        });
        expect(approvalRowControl(row(id, actionId, mode, actionType), { offline: true }), label).toEqual({
          kind: "offline",
        });
      }
    }
  });
});

describe("카드로 보내는 승인도 내가 결정할 일이다 (#5462)", () => {
  const items = [
    row("plan", "expression.set.plan"),
    row("set", "expression.set.create"),
    row("channel", "channel.create"),
    // 서버가 open 을 찍은 기존 승인: 받은함에서는 예전처럼 결정 컨트롤이라 이것도 센다.
    row("pin-server-open", "message.pin", "open"),
  ];

  it("awaitedApprovalId 는 결정 컨트롤과 열기에만 id 를 준다", () => {
    expect(awaitedApprovalId({ kind: "decide", approvalId: "d" })).toBe("d");
    expect(awaitedApprovalId({ kind: "open", approvalId: "o" })).toBe("o");
    expect(awaitedApprovalId({ kind: "offline" })).toBeNull();
    expect(awaitedApprovalId({ kind: "none" })).toBeNull();
  });

  it("배지는 열기 승인을 센다 — 단추가 받은함에 없어도 결정은 내 몫이다", () => {
    // 열기는 목록의 두 행동뿐이고(plan·set), 나머지 둘은 결정 컨트롤이다. 넷 모두 내가 결정할 일이다.
    expect(items.map((item) => approvalRowControl(item, { offline: false }).kind)).toEqual(["open", "open", "decide", "decide"]);
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
