// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import "@/lib/coreHost";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { agentCardModel } from "@momo/core/features/timeline/agentCardModel";
import { reproposeDraft } from "@momo/core/features/approvals/expiry";
import type { Message } from "@momo/core/lib/api";
import { readDraft } from "@/features/chat/draftStore";
import { AgentCard } from "@/features/timeline/AgentCard";
import { rememberSettledApproval, resetSettledApprovalsForTest } from "@/features/timeline/settledApprovals";

// #4986. 실패·거부로 닫힌 묶음 카드에는 다음 행동이 없었다: 「실패했어요」「거부됐어요」만 서고, 서버가 결과
// 줄을 보내면 기본 문장의 「다시 요청해 보세요」까지 사라졌다. 요청 고리 상태표(agent-request-loop §2.2)는
// 두 상태의 다음 행동을 「다시 요청」으로 정한다. 만료 카드가 이미 쓰는 같은 단추를 세운다.
const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const CHANNEL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-0000000001aa";
const AGENT = "019f9a01-0000-7000-8000-000000000401";
const APPROVAL_ID = "0199aa11-2222-7000-8000-0000000000a1";

function member(id: string, kind: "human" | "agent", displayName: string, handle: string) {
  return { id, workspaceId: WORKSPACE_ID, kind, status: "active", role: "member", displayName, handle, channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0 };
}
const DIRECTORY = makeDirectory([member(AGENT, "agent", "달무리봇", "dalmuri"), member(ME, "human", "이도현", "dohyun")] as never);
const NO_AGENT = makeDirectory([member(ME, "human", "이도현", "dohyun")] as never);
const SESSION = { session: { accessToken: "access", refreshToken: "refresh", member: { id: ME, workspaceId: WORKSPACE_ID, kind: "human", displayName: "이도현", handle: "dohyun" }, realtimeWebSocketUrl: "wss://example.test/connection/websocket" }, workspaceId: WORKSPACE_ID, realtime: null, connStatus: "connected", logout: () => undefined, replaceSessionMember: () => undefined } as unknown as SessionContextValue;

function closedCard(status: string, extra: Record<string, unknown> = {}): Message {
  return {
    id: "0199aa11-2222-7000-8000-0000000000d1", channelId: CHANNEL_ID, seq: 9, hlcTs: 1_753_400_000_000, hlcCount: 0,
    authorMemberId: AGENT, type: "approval_request", body: "정리할 파일을 읽지 못했어요", state: "sent", createdAtMs: 1_753_400_000_000,
    props: { approval_id: APPROVAL_ID, run_id: "0199aa11-2222-7000-8000-0000000000b2", channel_id: CHANNEL_ID, status, title: "파일 정리 요청", ...extra },
  } as unknown as Message;
}
function draw(message: Message, directory = DIRECTORY) {
  const card = agentCardModel(message);
  if (card === null) throw new Error("no card for these props");
  return render(<SessionProvider value={SESSION}><AgentCard card={card} directory={directory} viewerMemberId={ME} /></SessionProvider>);
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); sessionStorage.clear(); resetSettledApprovalsForTest();
});
afterAll(() => { delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
afterEach(() => { cleanup(); });

describe("실패·거부로 닫힌 카드의 다음 행동 (#4986)", () => {
  it("실패 카드: 서버가 결과 줄을 보내도 「다시 요청」이 서고, 누르면 실패 초안이 입력창에 들어간다", () => {
    const view = draw(closedCard("failed", { result: { status: "failed", line: "정리할 파일을 읽지 못했어요" } }));
    expect(view.getByTestId("request-bundle-state").textContent).toBe("실패");
    expect(view.getByTestId("request-bundle-result").textContent).toBe("정리할 파일을 읽지 못했어요");
    const button = view.getByTestId("approval-repropose");
    expect(button.textContent).toBe("다시 요청");
    expect(view.queryByTestId("approval-approve")).toBeNull();
    act(() => { fireEvent.click(button); });
    expect(readDraft(WORKSPACE_ID, CHANNEL_ID)).toBe(reproposeDraft("dalmuri", "failed"));
    expect(view.getByTestId("approval-repropose-note").textContent).toContain("입력창에 넣어 뒀어요");
  });

  it("거부 카드: 다른 사람이 거부했으면 「다시 요청」이 서고 거부 초안이 들어간다", () => {
    const view = draw(closedCard("rejected", { decided_by: OTHER }));
    expect(view.getByTestId("request-bundle-state").textContent).toBe("거부");
    act(() => { fireEvent.click(view.getByTestId("approval-repropose")); });
    expect(readDraft(WORKSPACE_ID, CHANNEL_ID)).toBe(reproposeDraft("dalmuri", "declined"));
  });

  it("내가 거부한 카드에는 세우지 않는다: 방금 스스로 닫은 사람에게 되돌릴 것이 없다", () => {
    const view = draw(closedCard("rejected", { decided_by: ME }));
    expect(view.getByTestId("request-bundle-state").textContent).toBe("거부");
    expect(view.queryByTestId("approval-repropose")).toBeNull();
    expect(view.queryByTestId("approval-closed-next")).toBeNull();
  });

  it("만료 카드는 그대로다: 이유 문장과 단추가 함께 서고, 실패·거부에는 이유 문장이 겹쳐 서지 않는다", () => {
    const expired = draw(closedCard("expired"));
    expect(expired.getByTestId("approval-expired").textContent).toContain("승인 시간이 지나서");
    expect(expired.getByTestId("approval-repropose")).toBeTruthy();
    cleanup();
    const failed = draw(closedCard("failed"));
    expect(failed.queryByTestId("approval-expired")).toBeNull();
    expect(failed.container.textContent ?? "").not.toContain("승인 시간이 지나서");
    expect(failed.getAllByRole("button", { name: "다시 요청" })).toHaveLength(1);
  });

  it("방금 내가 승인했다가 실패로 닫힌 카드에는 영수증 줄과 함께 「다시 요청」이 선다", () => {
    // 이 세션의 결정 영수증이 있으면 푸터는 영수증 줄이 맡는다. 그 뒤 서버가 결과를 실패로 패치해도(`result.status`)
    // 다음 행동이 사라지면 안 된다: 승인했는데 일이 안 된 사람에게야말로 다시 시키는 길이 필요하다.
    rememberSettledApproval(APPROVAL_ID, { status: "approved", decidedAtMs: 1, decidedByMemberId: ME, note: "승인을 기록했어요." });
    const view = draw(closedCard("approved", { result: { status: "failed", line: "정리할 파일을 읽지 못했어요" } }));
    expect(view.container.textContent ?? "").toContain("승인을 기록했어요.");
    expect(view.getByTestId("approval-repropose").textContent).toBe("다시 요청");
  });

  it("올린 이가 에이전트로 풀리지 않으면 빈 띠도 단추도 세우지 않는다", () => {
    const view = draw(closedCard("failed"), NO_AGENT);
    expect(view.queryByTestId("approval-repropose")).toBeNull();
    expect(view.queryByTestId("approval-closed-next")).toBeNull();
  });

  it("끝·취소 카드에는 다음 행동이 없다(취소는 사람이 한 일, 끝은 끝)", () => {
    for (const status of ["executed", "cancelled"]) {
      const view = draw(closedCard(status));
      expect(view.queryByTestId("approval-repropose"), status).toBeNull();
      cleanup();
    }
  });
});
