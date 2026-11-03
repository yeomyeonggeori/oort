// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import "@/lib/coreHost";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { ConnectionContext } from "@/features/common/connectionContext";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { connectionScene, type ConnectionScene } from "@/testing/connectionViews";
import { koreanLocale } from "@/testing/koLocale";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { agentCardModel } from "@momo/core/features/timeline/agentCardModel";
import type { Message } from "@momo/core/lib/api";
import { AgentCard } from "@/features/timeline/AgentCard";
import { resetSettledApprovalsForTest } from "@/features/timeline/settledApprovals";

// #5239. 승인 카드의 막힘 줄(`approval-note-offline`)은 연결 상태 모델이 고른 **원인**을 말한다. 진짜 `AgentCard`를 코어
// 모델이 돌린 모습(`connectionScene`) 위에 그려 원인마다 줄이 무엇을 말하는지(또는 서지 않는지)를 잰다.
//
//   기기 오프라인      「오프라인이라 …」
//   서버에 닿지 못함   「서버에 닿지 못해 …」 — 오프라인이라고 말하지 않는다(이 칸이 고친 거짓말)
//   알 수 없음·실시간만  모델이 막지 않는다: 줄 없이 결정 단추가 선다 (#5201 결정 ③)
//
// 문장은 손으로 적는다: 문장을 짓는 코드와 시험이 같은 틀을 공유하면 함께 틀려도 초록이다.
const OFFLINE_LINE = "오프라인이라 지금은 결정할 수 없어요. 다시 연결되면 여기서 승인하거나 거부할 수 있어요.";
const SERVER_LINE = "서버에 닿지 못해 지금은 결정할 수 없어요. 다시 연결되면 여기서 승인하거나 거부할 수 있어요.";

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const DECIDER = "00000000-0000-7000-8000-0000000000b2";
const REQUESTER = "00000000-0000-7000-8000-0000000000a1";
const AGENT = "019f9a01-0000-7000-8000-000000000401";

function member(id: string, kind: "human" | "agent", displayName: string) {
  return { id, workspaceId: WORKSPACE_ID, kind, status: "active", role: "member", displayName, handle: displayName, channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0 };
}
const DIRECTORY = makeDirectory([member(REQUESTER, "human", "김인턴"), member(DECIDER, "human", "박연구원"), member(AGENT, "agent", "코메토")] as never);

function consentCard(): Message {
  const approvalId = "0199aa11-2222-7000-8000-0000000000a1";
  return {
    id: "0199aa11-2222-7000-8000-0000000000a1", channelId: "00000000-0000-7000-8000-000000000201", seq: 9, hlcTs: 1_753_400_000_000, hlcCount: 0,
    authorMemberId: REQUESTER, type: "approval_request", body: "코메토 들이기 허락을 기다려요", state: "sent", createdAtMs: 1_753_400_000_000,
    props: {
      approval_id: approvalId, run_id: "0199aa11-2222-7000-8000-0000000000b2", channel_id: "00000000-0000-7000-8000-000000000201",
      action_type: "workspace_action", status: "pending", title: "에이전트를 이 대화에 들이기", expires_at_ms: Date.now() + 900_000, target_member_id: DECIDER,
      action: { id: "dm.agent.admit", required_role: "dm_participant", target_member_id: DECIDER, rows: [{ label: "에이전트", value: "코메토 (@kometto)" }] },
    },
  } as unknown as Message;
}

const SESSION = {
  session: { accessToken: "access", refreshToken: "refresh", member: { id: DECIDER, workspaceId: WORKSPACE_ID, kind: "human", displayName: "박연구원", handle: "viewer" }, realtimeWebSocketUrl: "wss://example.test/connection/websocket" },
  workspaceId: WORKSPACE_ID, realtime: null, connStatus: "connected", logout: () => undefined, replaceSessionMember: () => undefined,
} as unknown as SessionContextValue;

function draw(scene: ConnectionScene) {
  const card = agentCardModel(consentCard());
  if (card === null) throw new Error("no card for these props");
  return render(
    <LocaleProvider locale={ko}>
      <SessionProvider value={SESSION}>
        <ConnectionContext.Provider value={connectionScene(scene)}>
          <AgentCard card={card} directory={DIRECTORY} viewerMemberId={DECIDER} />
        </ConnectionContext.Provider>
      </SessionProvider>
    </LocaleProvider>
  );
}

let ko: AppLocale;
beforeAll(async () => { ko = await koreanLocale(); });
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); sessionStorage.clear(); resetSettledApprovalsForTest();
});
afterAll(() => { delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
afterEach(() => { cleanup(); });

describe("승인 카드의 막힘 줄은 막은 원인을 말한다 (#5239)", () => {
  it("기기 오프라인: 「오프라인이라 …」이고 결정 단추 자리를 대신한다", () => {
    expect(connectionScene("deviceOffline").view.cause).toBe("deviceOffline");
    const view = draw("deviceOffline");
    expect(view.getByTestId("approval-note-offline").textContent).toBe(OFFLINE_LINE);
    expect(view.queryByTestId("approval-approve")).toBeNull();
  });

  it("서버에 닿지 못함: 「서버에 닿지 못해 …」이고 오프라인이라고 말하지 않는다", () => {
    expect(connectionScene("serverUnreachable").view.cause).toBe("serverUnreachable");
    const view = draw("serverUnreachable");
    expect(view.getByTestId("approval-note-offline").textContent).toBe(SERVER_LINE);
    expect(view.container.textContent ?? "").not.toContain("오프라인");
    expect(view.queryByTestId("approval-approve")).toBeNull();
  });

  // unknown = 알 수 없음, realtimeDown = 실시간만 끊김
  it.each(["unknown", "realtimeDown"] as const)("%s: 줄이 서지 않고 결정 단추가 열려 있다", (scene) => {
    expect(connectionScene(scene).view.cause).toBe(scene);
    const view = draw(scene);
    expect(view.queryByTestId("approval-note-offline")).toBeNull();
    expect(view.getByTestId("approval-approve")).toBeTruthy();
    expect(view.getByTestId("approval-reject")).toBeTruthy();
  });
});
