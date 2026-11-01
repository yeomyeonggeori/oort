// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@/lib/coreHost";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { agentCardModel } from "@momo/core/features/timeline/agentCardModel";
import type { Message } from "@momo/core/lib/api";
import { AgentCard } from "./AgentCard";

// #5066 (검증 줄 1회차 M1). 묶음 카드의 머리 문장은 한국어 문장이라 `word-break: keep-all`(Tailwind `break-keep`)이 없으면
// 기본 데스크탑 폭 1440 의 스레드 칸에서도 「…고정해도 될까 / 요?」처럼 낱말 가운데에서 끊긴다(캡처
// `4847-4863-26-channel-thread-card-receipt-chromium-1440-light.png`). 줄 수를 두 줄로 묶는 `line-clamp-2` 는 그대로다.
// jsdom 에는 Tailwind CSS 가 없어서 이 시험은 클래스를 잰다(`AgentUsage.test.tsx`·`teamSize.test.ts` 와 같은 방식).
const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-0000000001ff";

function session(): SessionContextValue {
  return {
    session: { accessToken: "access", refreshToken: "refresh", member: { id: ME, workspaceId: WORKSPACE_ID, kind: "human", displayName: "보는 사람", handle: "viewer" }, realtimeWebSocketUrl: "wss://example.test/connection/websocket" },
    workspaceId: WORKSPACE_ID, realtime: null, connStatus: "connected", logout: () => undefined, replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

function card(): Message {
  return {
    id: "0199aa11-2222-7000-8000-0000000000d1", channelId: "00000000-0000-7000-8000-000000000201", seq: 3, hlcTs: 3, hlcCount: 0,
    authorMemberId: "00000000-0000-7000-8000-000000000402", type: "approval_request", body: "승인 요청", state: "sent", createdAtMs: 3,
    props: {
      approval_id: "ap-1", call_id: "c1", tool_name: "message.pin", action_type: "tool_call", status: "pending", expires_at_ms: Date.now() + 3_600_000,
      intent: "이 메시지를 채널 상단에 고정해도 될까요",
    },
  } as unknown as Message;
}

afterEach(cleanup);

describe("묶음 카드 머리 문장의 줄바꿈 (#5066)", () => {
  it("머리 문장은 어절 단위로 줄을 바꾼다(break-keep) — 두 줄 제한(line-clamp-2)은 그대로다", () => {
    const model = agentCardModel(card());
    if (model === null) throw new Error("no card");
    render(<SessionProvider value={session()}><AgentCard card={model} directory={makeDirectory([])} /></SessionProvider>);
    const headline = screen.getByTestId("request-bundle-headline");
    expect(headline.textContent ?? "").not.toBe("");
    expect(headline.classList.contains("break-keep")).toBe(true);
    expect(headline.classList.contains("line-clamp-2")).toBe(true);
  });
});
