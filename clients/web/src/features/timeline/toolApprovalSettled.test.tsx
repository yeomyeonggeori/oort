// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/coreHost";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { agentCardModel } from "@momo/core/features/timeline/agentCardModel";
import { presentableRows } from "@momo/core/features/timeline/toolCallSettle";
import { agentRunProgressFromWire, type AgentRunProgress, type Message } from "@momo/core/lib/api";
import { nudgeRunProgress, resetRunProgress, startRunProgress } from "@/features/agents/agentRunProgressStore";
import { AgentCard } from "./AgentCard";

// =============================================================================
// #5168 (검증 줄 3회차, #5066의 다음 국면). 승인한 도구 호출은 결정 뒤 워커에서 실행되고 끝은 같은 `call_id` 의 `tool_result`
// 행으로 따로 온다. 서버는 도구 승인 카드를 그때 다시 고치지 않는다(「실행 중 → 끝」은 run이 말한다). 웹의 카드는 run 을 읽지
// 않아서(`approvalBundleContext` 가 만드는 문맥에 `run` 이 없다) 승인 뒤 카드가 「실행 중 · 승인됐어요 · 이어서 하는 중」에 영영
// 머물고 결과 줄이 도구 카드로 한 장 더 섰다. (그 뒤 #5254 가 문맥에 run 을 실었다 — 파일 아래 둘째 묶음.) 폰에서 처음 보였고(폰은 run 이 늦거나 창 밖이면 같은 모양) 웹도 같은 코어 경로
// (`presentableRows` → `agentCardModel` → `requestBundleModel`)를 쓰므로 같은 결함이다. 이 시험은 **실제로 그린 웹 DOM** 에서
// 승인 → 실행 → 끝의 세 국면을 잰다: 한 번의 도구 승인이 어느 국면에서나 카드 한 장이고 낱말이 하나이며, 끝난 뒤에는 닫힌
// 상태를 말한다.
//
// 픽스처는 서버가 쓰는 모양 그대로다: 호출은 `{name, arguments, call_id}`, 승인 카드는 처음부터 `call_id`·`tool_name`·
// `action_type` 을 싣고 결정하면 `status`·`approval_status` 를 한 패치로 함께 고치며, 결과는 `{call_id, output, is_error}`.
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
      member: { id: ME, workspaceId: WORKSPACE_ID, kind: "human", displayName: "보는 사람", handle: "viewer", },
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
const card = (status: string) =>
  row("approval_request", "approval", 2, {
    approval_id: "ap-1", call_id: "c1", tool_name: "work.session.end", action_type: "tool_call", decision_mode: "inline",
    approval_status: status, status, expires_at_ms: DEADLINE,
    ...(status === "pending" ? {} : { decided_by: ME, decided_at_ms: T0 + MIN }),
  }, "승인 요청");
const finished = (callId = "c1", props: Record<string, unknown> = {}) =>
  row("tool_result", "result", 3, { call_id: callId, output: "끝냈어요", is_error: false, ...props }, "끝냈어요");

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let stopProgress: (() => void) | null = null;

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
  stopProgress?.();
  stopProgress = null;
  resetRunProgress();
  vi.useRealTimers();
});

/** 타임라인이 하는 일과 같다: 행으로 그릴 목록(`presentableRows`)의 행마다 카드 모델 → `AgentCard`. */
function elements(messages: Message[]) {
  const cards = presentableRows(messages).flatMap((message) => {
    const model = agentCardModel(message);
    return model === null ? [] : [createElement(AgentCard, { key: message.id, card: model, directory: DIRECTORY })];
  });
  return createElement(SessionProvider, { value: sessionValue() }, ...cards);
}
function mount(messages: Message[]): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => { root?.render(elements(messages)); });
  return host;
}
/** 같은 마운트에 목록이 자라는 것(메시지가 실시간으로 늘고 카드가 제자리에서 고쳐지는 것)을 흉내 낸다. */
function update(messages: Message[]) {
  act(() => { root?.render(elements(messages)); });
}

/** 화면의 상태 낱말들: 묶음 카드의 상태 표지와 카드 칩을 모두 센다. 한 번의 승인은 하나만 말해야 한다. */
const words = (el: HTMLElement) =>
  [...el.querySelectorAll('[data-testid="request-bundle-state"], [data-testid="agent-status-chip"]')].map((node) => node.textContent);
const toolCards = (el: HTMLElement) => el.querySelectorAll('[data-card-kind="tool"]').length;
const approvalCards = (el: HTMLElement) => el.querySelectorAll('[data-card-kind="approval"]').length;
const repropose = (el: HTMLElement) => el.querySelector('[data-testid="approval-repropose"]');

describe("승인한 도구 호출은 웹에서도 끝난 뒤 카드 한 장이 닫힌 상태를 말한다 (#5168)", () => {
  it("승인 → 실행 → 성공: 한 마운트에서 카드가 「승인 필요」 → 「실행 중」 → 「끝」으로 바뀌고 어느 때에도 카드는 한 장이다", () => {
    const el = mount([started(), card("pending")]);
    expect(words(el)).toEqual(["승인 필요"]);
    expect([approvalCards(el), toolCards(el)]).toEqual([1, 0]);

    update([started(), card("approved")]);
    expect(words(el)).toEqual(["실행 중"]);
    expect([approvalCards(el), toolCards(el)]).toEqual([1, 0]);

    update([started(), card("approved"), finished()]);
    expect(words(el)).toEqual(["끝"]);
    expect([approvalCards(el), toolCards(el)]).toEqual([1, 0]);
    // 옛 낱말이 남지 않고, 결과 줄이 도구 카드로 한 장 더 서지 않는다.
    expect(el.textContent ?? "").not.toContain("실행 중");
    expect(el.textContent ?? "").not.toContain("이어서 하는 중");
    expect(repropose(el)).toBeNull();
  });

  it("결과가 오류면 「실패」로 닫히고 같은 카드가 다음 행동 「다시 요청」을 건넨다", () => {
    const el = mount([started(), card("approved"), finished("c1", { is_error: true, output: "권한이 없어요" })]);
    expect(words(el)).toEqual(["실패"]);
    expect([approvalCards(el), toolCards(el)]).toEqual([1, 0]);
    expect(repropose(el)?.textContent).toBe("다시 요청");
  });

  it("다른 call_id 의 결과는 이 카드를 닫지 않는다: 카드는 「실행 중」 그대로이고 그 결과는 도구 카드로 따로 선다", () => {
    const el = mount([started(), card("approved"), finished("c2")]);
    expect(words(el)).toContain("실행 중");
    expect(words(el)).not.toContain("끝");
    expect([approvalCards(el), toolCards(el)]).toEqual([1, 1]);
  });
});

// =============================================================================
// #5254 (#5168 후속). 위의 규칙은 **결과 줄이 있을 때**만 카드를 닫는다. 승인한 도구 호출은 결과 줄 없이도 끝난다: 에이전트가 오류로
// 끝나거나 사람이 run 을 멈추면 `tool_result` 는 오지 않는다. 폰은 이어진 run 이 카드를 닫는데 웹 카드는 run 을 찾고도 문맥
// (`approvalBundleContext`)에 싣지 않아 `canDecide` 에만 쓰고, 그래서 결과 줄 없이 끝난 호출은 「실행 중 · 이어서 하는 중」에 영영 남았다.
// 이 시험은 카드가 **진행 읽기 저장소에서 실제로 이어진 run**(와이어 파서를 지난 진행 한 줄)을 읽어 폰과 같은 코어 규칙
// (`requestBundleState` 의 run 가지)으로 닫히는지를 렌더된 DOM 에서 잰다. 결과 줄과 run 이 서로 다른 말을 하면 결과 줄이 이긴다.
// =============================================================================

const RUN_ID = "00000000-0000-7000-8000-0000000000b2";
/**
 * 진행 읽기가 실어 주는 run 한 줄. 기본은 이 승인(`ap-1`)에 이어진 run 이다: 서버는 결정 뒤에도 run 이 물은 가장 최근 승인을 `bundle` 에 싣는다
 * (`run_bundle.rs`). `status`·`phase` 는 같은 말이다.
 */
function runAt(phase: "running" | "succeeded" | "failed" | "cancelled", over: Record<string, unknown> = {}): AgentRunProgress {
  return agentRunProgressFromWire({
    id: RUN_ID, channelId: CHANNEL_ID, agentMemberId: AGENT, status: phase, phase, leaseState: phase === "running" ? "live" : "none", stepCount: 3,
    createdAtMs: T0, updatedAtMs: T0,
    bundle: { approvalId: "ap-1", status: "approved", decisionMode: "inline", canDecide: false, actionType: "tool_call" },
    ...over,
  });
}
/**
 * 카드를 그리기 **전에** 저장소가 run 을 들고 있게 한다(타임라인의 카드는 마운트될 때 이미 저장소를 읽는다). `runs` 는 진행 읽기가 답할
 * 때마다 불린다: 시험이 돌려줄 목록을 바꾸고 `rereadRuns` 를 부르면 이미 선 카드 위에서 run 이 끝나는 전환을 흉내 낸다.
 */
async function mountWithRuns(messages: Message[], runs: () => AgentRunProgress[]): Promise<HTMLElement> {
  stopProgress = startRunProgress({ workspaceId: WORKSPACE_ID, channelIds: [CHANNEL_ID], realtime: null, fetchProgress: async () => runs() });
  await act(async () => { await Promise.resolve(); });
  return mount(messages);
}
const mountWithRun = (messages: Message[], run: AgentRunProgress) => mountWithRuns(messages, () => [run]);
/** 서버가 새 진행을 답한 것처럼 저장소를 지금 다시 읽는다(채널의 프레임이 오면 하는 일). */
const rereadRuns = () => act(async () => { nudgeRunProgress(CHANNEL_ID); await Promise.resolve(); await Promise.resolve(); });
/** 같은 채널의 두 번째 도구 승인: 다른 호출(`c2`)·다른 승인(`ap-2`). seq 는 첫 쌍보다 뒤다. */
const startedTwo = () => row("tool_call", "call-2", 4, { name: "work.session.end", arguments: {}, call_id: "c2" }, "Tool call: work.session.end");
const cardTwo = () =>
  row("approval_request", "approval-2", 5, {
    approval_id: "ap-2", call_id: "c2", tool_name: "work.session.end", action_type: "tool_call", decision_mode: "inline",
    approval_status: "approved", status: "approved", expires_at_ms: DEADLINE, decided_by: ME, decided_at_ms: T0 + MIN,
  }, "승인 요청");

describe("승인한 도구 호출은 결과 줄이 없어도 이어진 run 의 끝으로 웹 카드가 닫힌다 (#5254)", () => {
  it("결과 줄 없음 + run 실패: run 이 도는 동안은 「실행 중」이고, 같은 카드 위에서 run 이 실패하면 「실패」로 닫혀 「다시 요청」을 건넨다", async () => {
    let runs = [runAt("running")];
    const el = await mountWithRuns([started(), card("approved")], () => runs);
    expect(words(el)).toEqual(["실행 중"]); // 열린 run 이 이어졌다는 것만으로는 카드를 닫지 않는다
    runs = [runAt("failed")];
    await rereadRuns();
    expect(words(el)).toEqual(["실패"]);
    expect([approvalCards(el), toolCards(el)]).toEqual([1, 0]);
    expect(el.textContent ?? "").not.toContain("이어서 하는 중");
    expect(repropose(el)?.textContent).toBe("다시 요청");
  });

  it("결과 줄 없음 + run 중단(사람이 멈춤): 「취소」로 닫힌다", async () => {
    const el = await mountWithRun([started(), card("approved")], runAt("cancelled", { endReason: "human_cancelled" }));
    expect(words(el)).toEqual(["취소"]);
    expect(el.textContent ?? "").not.toContain("이어서 하는 중");
  });

  it("결과 줄 없음 + run 완료: 「끝」으로 닫히고, run 은 **자기 승인 카드만** 닫는다 (같은 채널의 다른 승인은 「실행 중」 그대로)", async () => {
    const el = await mountWithRun([started(), card("approved"), startedTwo(), cardTwo()], runAt("succeeded"));
    expect(words(el)).toEqual(["끝", "실행 중"]);
    expect([approvalCards(el), toolCards(el)]).toEqual([2, 0]);
    expect(el.textContent ?? "").toContain("이어서 하는 중"); // 둘째 카드의 문장만 남는다
  });

  it("결과 줄이 있으면 결과 줄이 이긴다: 결과 성공 + run 실패 → 「끝」", async () => {
    const el = await mountWithRun([started(), card("approved"), finished()], runAt("failed"));
    expect(words(el)).toEqual(["끝"]);
    expect([approvalCards(el), toolCards(el)]).toEqual([1, 0]);
    expect(repropose(el)).toBeNull();
  });

  it("결과 줄이 있으면 결과 줄이 이긴다: 도구 오류 + run 완료(모델이 오류를 설명하고 끝남) → 「실패」", async () => {
    const el = await mountWithRun([started(), card("approved"), finished("c1", { is_error: true, output: "권한이 없어요" })], runAt("succeeded"));
    expect(words(el)).toEqual(["실패"]);
    expect(repropose(el)?.textContent).toBe("다시 요청");
  });
});
