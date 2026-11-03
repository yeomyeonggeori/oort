// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/coreHost";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { agentCardModel } from "@momo/core/features/timeline/agentCardModel";
import { presentableRows } from "@momo/core/features/timeline/toolCallSettle";
import type { Message } from "@momo/core/lib/api";
import { AgentCard } from "./AgentCard";

// =============================================================================
// #5066 (검증 줄 1회차 H2). 도구 승인 하나를 호출 카드와 승인 카드가 서로 다른 상태로 말했다: 결정을 기다리는 내내
// 호출 카드는 「생각 중」, 기한이 지나 승인 카드가 시계로 「만료」를 말해도 서버가 정리하기 전까지 「생각 중」, 정리된
// 뒤에는 「중단됨」 대 「만료」. 코어는 승인이 걸린 호출 행을 접어 승인 카드 한 장이 말하게 하고(`presentableRows`),
// 이 시험은 그 결과를 **실제로 그린 DOM** 에서 잰다: 한 번의 도구 승인이 화면에 상태 낱말을 하나만 말하고, 그 낱말이 승인
// 카드의 것(사전: 승인 필요 · 만료 · 거부 · 취소)이다.
//
// 픽스처는 서버가 쓰는 모양 그대로다: 호출은 `{name, arguments, call_id}` + 영어 폴백 본문, 승인 카드는 처음부터
// `call_id`·`tool_name`·`expires_at_ms` 를 싣고(`approval.rs` `approval_request_props`), 끝나면 `status`·`approval_status`·
// `code` 를 한 패치로 함께 고친다.
// =============================================================================

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const CHANNEL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "00000000-0000-7000-8000-0000000001ff";
const AGENT = "019f9a01-0000-7000-8000-000000000402";
const T0 = 1_760_000_000_000;
const MIN = 60_000;
const DEADLINE = T0 + 30 * MIN;

const DIRECTORY = makeDirectory([
  { id: ME, workspaceId: WORKSPACE_ID, kind: "human", status: "active", role: "owner", displayName: "보는 사람", handle: "viewer", channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0 },
  { id: AGENT, workspaceId: WORKSPACE_ID, kind: "agent", status: "active", role: "member", displayName: "김인턴", handle: "kim-intern", channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0 },
] as never);

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId: WORKSPACE_ID, kind: "human", displayName: "보는 사람", handle: "viewer" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WORKSPACE_ID,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

function row(type: Message["type"], id: string, seq: number, props: Record<string, unknown>, body: string): Message {
  return { id, channelId: CHANNEL_ID, seq, hlcTs: seq, hlcCount: 0, authorMemberId: AGENT, type, body, state: "sent", createdAtMs: T0, props } as Message;
}
const started = () => row("tool_call", "call", 1, { name: "work.session.end", arguments: {}, call_id: "c1" }, "Tool call: work.session.end");
// 승인 카드. 끝난 카드의 `code` 는 서버가 정한 그대로다(`approval_outcome.rs` `outcome_code_and_line`).
const approval = (status: string, code?: string) =>
  row("approval_request", "approval", 2, {
    approval_id: "ap-1", call_id: "c1", tool_name: "work.session.end", action_type: "tool_call",
    approval_status: status, status, expires_at_ms: DEADLINE, ...(code === undefined ? {} : { code }),
  }, "승인 요청");

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => { reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ["Date", "setTimeout", "clearTimeout"] });
  localStorage.clear();
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
});

/** 코어가 행으로 그릴 목록의 **모든 행**을 웹 카드로 그린다(타임라인이 하는 일과 같다: 행마다 카드 모델 → `AgentCard`). */
function mount(messages: Message[]): HTMLElement {
  const cards = presentableRows(messages).flatMap((message) => {
    const card = agentCardModel(message);
    return card === null ? [] : [createElement(AgentCard, { key: message.id, card, directory: DIRECTORY })];
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => { root?.render(createElement(SessionProvider, { value: sessionValue() }, ...cards)); });
  return host;
}

/** 화면의 상태 낱말들: 묶음 카드의 상태 표지와 카드 칩을 모두 센다. 한 번의 승인은 하나만 말해야 한다. */
const words = (el: HTMLElement) =>
  [...el.querySelectorAll('[data-testid="request-bundle-state"], [data-testid="agent-status-chip"]')].map((node) => node.textContent);
const toolCards = (el: HTMLElement) => el.querySelectorAll('[data-card-kind="tool"]').length;

/** 호출 카드가 따로 말하던 옛 낱말들. 어느 국면에도 승인 카드 곁에 서면 안 된다. */
const STALE_WORDS = ["생각 중", "중단됨", "실행 중입니다"];
function expectOneSpeaker(el: HTMLElement, word: string) {
  expect(words(el)).toEqual([word]);
  expect(toolCards(el)).toBe(0);
  for (const stale of STALE_WORDS) expect(el.textContent ?? "").not.toContain(stale);
}

describe("도구 승인 하나는 화면에서 한 장이 한 낱말로 말한다 (#5066)", () => {
  it("결정을 기다리는 동안: 호출 카드는 「생각 중」으로 돌지 않고 승인 카드가 「승인 필요」를 말한다", () => {
    expectOneSpeaker(mount([started(), approval("pending")]), "승인 필요");
  });

  it("기한이 지나면 서버가 정리하기 전에도 시계로 「만료」: 같은 카드가 낱말을 바꾸고 호출 카드는 여전히 없다", () => {
    const el = mount([started(), approval("pending")]);
    expectOneSpeaker(el, "승인 필요");
    act(() => { vi.advanceTimersByTime(31 * MIN); });
    expectOneSpeaker(el, "만료");
  });

  it("서버가 카드를 고친 뒤에도 「만료」이고 「중단됨」으로 닫히지 않는다", () => {
    expectOneSpeaker(mount([started(), approval("expired", "approval_expired")]), "만료");
  });

  it("거부는 「거부」, 취소는 「취소」다", () => {
    expectOneSpeaker(mount([started(), approval("rejected", "approval_rejected")]), "거부");
    act(() => root?.unmount());
    root = null;
    host?.remove();
    expectOneSpeaker(mount([started(), approval("cancelled")]), "취소");
  });

  it("승인 카드가 없는 호출은 지금 그대로다: 호출 카드가 서고 「생각 중」이 맞는 말이다", () => {
    const el = mount([started()]);
    expect(toolCards(el)).toBe(1);
    expect(words(el)).toEqual(["생각 중"]);
  });
});
