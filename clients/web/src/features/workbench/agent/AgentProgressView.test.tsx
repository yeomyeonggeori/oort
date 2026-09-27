// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkSession } from "@momo/core/lib/api";
import type { WorkSessionEvent } from "@momo/core/features/work/workSessionModel";
import { agentPaneModel, type AgentPaneModel } from "@momo/core/features/workbench/agentPane";
import { CONFIRM_GUARD_MS } from "@/features/timeline/ApprovalActions";
import {
  AgentProgressView,
  DECIDE_UNAVAILABLE,
  REPLY_UNAVAILABLE,
  type AgentPaneActions,
} from "./AgentProgressView";

// A 칸 진행 뷰(#2779). 사보타주 대상은 셋이다:
//   - 권한 카드는 사람이 무장 → 확정을 누르기 전에는 결정을 만들지 않는다.
//   - 「항상 허용」은 어떤 이름표를 달고 와도 버튼이 되지 않는다.
//   - 답장의 기본은 다음 차례, 끼어들기는 따로 누른 버튼에서만.

const OWNER = "00000000-0000-7000-8000-000000000101";
const OTHER = "00000000-0000-7000-8000-000000000202";
const SID = "019f9a34-5405-7fda-9fb2-c6806f69d8a6";

const session: WorkSession = {
  id: SID,
  workspaceId: "w",
  channelId: "c",
  memberId: OWNER,
  hostId: "h",
  rootMessageId: "r",
  tool: "claude",
  label: "온보딩 1단계 문구 다듬기",
  status: "running",
  observation: "open",
  observerGrantCount: 0,
  remoteAttachAvailable: false,
  remoteDisplayAvailable: false,
  startedAtMs: 1_784_998_548_483,
};

let n = 0;
function ev(type: string, payload: Record<string, unknown>): WorkSessionEvent {
  n += 1;
  return {
    eventId: `ev-${n}`,
    type: type as WorkSessionEvent["type"],
    sessionId: SID,
    atMs: 1_784_998_548_500 + n * 1000,
    seq: n,
    payload: { work_session_id: SID, ...payload },
  };
}
const tool = (name: string, detail?: string) =>
  ev("agent.status", { phase: "streaming", run_status: "running", tool_call_name: name, ...(detail ? { detail } : {}) });
const ask = (options: unknown[]) =>
  ev("approval.requested", { action: "requested", action_type: "tool_call", status: "pending", options });
const ONCE = { option_id: "once", name: "Allow once", kind: "allow_once" };
const REJECT = { option_id: "no", name: "Reject", kind: "reject_once" };

function model(events: WorkSessionEvent[], viewer = OWNER, extra: Partial<Parameters<typeof agentPaneModel>[0]> = {}): AgentPaneModel {
  return agentPaneModel({ session, events, truncated: false, viewerMemberId: viewer, hostName: "MacBook", ...extra });
}

const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactAct.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-09-28T01:00:00Z"));
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

function render(m: AgentPaneModel, actions: AgentPaneActions, ownerName: string | null = "곽성재") {
  if (!host) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  act(() => {
    root!.render(createElement(AgentProgressView, { model: m, ownerName, actions }));
  });
  return host;
}

const q = (sel: string) => host!.querySelector<HTMLElement>(sel);
const click = (el: HTMLElement | null) =>
  act(() => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

describe("permission card", () => {
  it("never decides on mount, re-render, re-delivery or time passing", async () => {
    const decide = vi.fn(async () => undefined);
    const events = [tool("bash", "npm install"), ask([ONCE, REJECT])];
    render(model(events), { decide, reply: null });
    // 같은 요청이 다시 배달되고(재연결), 시간이 흐르고, 다른 줄이 붙어도.
    render(model([...events, ...events]), { decide, reply: null });
    act(() => vi.advanceTimersByTime(60_000));
    render(model([...events, tool("read_file")]), { decide, reply: null });
    expect(q('[data-testid="agent-permission"]')).not.toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });

  it("arming is not deciding, and the commit inside the guard is ignored", async () => {
    const decide = vi.fn(async () => undefined);
    render(model([tool("bash", "npm install"), ask([ONCE, REJECT])]), { decide, reply: null });
    click(q('[data-testid="agent-permission-allow"]'));
    expect(decide).not.toHaveBeenCalled();
    click(q('[data-testid="agent-permission-commit"]'));
    expect(decide).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(CONFIRM_GUARD_MS));
    await act(async () => {
      q('[data-testid="agent-permission-commit"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith({
      sessionId: SID,
      requestEventId: expect.stringMatching(/^ev-/),
      optionId: "once",
      kind: "allow_once",
    });
  });

  it("Esc disarms and the caret goes back to the button that armed", () => {
    const decide = vi.fn(async () => undefined);
    render(model([tool("bash", "npm install"), ask([ONCE, REJECT])]), { decide, reply: null });
    click(q('[data-testid="agent-permission-reject"]'));
    const box = q('[data-testid="agent-permission-instruction"]')!;
    act(() => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(q('[data-testid="agent-permission-confirm"]')).toBeNull();
    expect(document.activeElement).toBe(q('[data-testid="agent-permission-reject"]'));
    expect(decide).not.toHaveBeenCalled();
  });

  it("reject carries the instruction as the next input", async () => {
    const decide = vi.fn(async () => undefined);
    render(model([tool("bash", "npm install"), ask([ONCE, REJECT])]), { decide, reply: null });
    click(q('[data-testid="agent-permission-reject"]'));
    const box = q('[data-testid="agent-permission-instruction"]') as HTMLTextAreaElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(box, "설치하지 말고 고쳐 줘");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => vi.advanceTimersByTime(CONFIRM_GUARD_MS));
    await act(async () => {
      q('[data-testid="agent-permission-commit"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "reject_once", optionId: "no", instruction: "설치하지 말고 고쳐 줘" })
    );
  });

  it("allow_always never becomes a button, whatever its name says", () => {
    const decide = vi.fn(async () => undefined);
    render(model([tool("bash"), ask([{ option_id: "x", name: "Allow once", kind: "allow_always" }, REJECT])]), {
      decide,
      reply: null,
    });
    const allow = q('[data-testid="agent-permission-allow"]') as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
    click(allow);
    expect(q('[data-testid="agent-permission-confirm"]')).toBeNull();
    expect(host!.textContent).not.toContain("항상");
  });

  it("a truncated preview cannot be allowed at all; the card says why", () => {
    render(model([tool("bash", "y".repeat(5000)), ask([ONCE, REJECT])]), { decide: vi.fn(), reply: null });
    expect((q('[data-testid="agent-permission-allow"]') as HTMLButtonElement).disabled).toBe(true);
    expect((q('[data-testid="agent-permission-reject"]') as HTMLButtonElement).disabled).toBe(false);
    expect(q('[data-testid="agent-permission-truncated"]')).not.toBeNull();
  });

  it("without a decision route the buttons stay visible, disabled, and say why", () => {
    render(model([tool("bash"), ask([ONCE, REJECT])]), { decide: null, reply: null });
    expect((q('[data-testid="agent-permission-allow"]') as HTMLButtonElement).disabled).toBe(true);
    expect((q('[data-testid="agent-permission-reject"]') as HTMLButtonElement).disabled).toBe(true);
    expect(q('[data-testid="agent-permission-unavailable"]')!.textContent).toBe(DECIDE_UNAVAILABLE);
  });

  it("non-owners see who decides and no buttons", () => {
    render(model([tool("bash", "npm install"), ask([ONCE, REJECT])], OTHER), { decide: vi.fn(), reply: vi.fn() });
    expect(q('[data-testid="agent-permission-allow"]')).toBeNull();
    expect(q('[data-testid="agent-permission-preview"]')).toBeNull();
    expect(q('[data-testid="agent-permission-waiting"]')!.textContent).toBe("곽성재의 확인을 기다려요");
    expect(q('[data-testid="agent-pane-reply"]')).toBeNull();
  });
});

describe("feed", () => {
  it("tool cards are collapsed; only the owner can open the raw view", () => {
    const events = [tool("read_file", "clients/web/copy.ts 120줄"), tool("edit_file", "+6 −6")];
    render(model(events), { decide: null, reply: null });
    expect(host!.querySelectorAll('[data-testid="agent-tool-card"]')).toHaveLength(2);
    expect(q('[data-testid="agent-tool-raw"]')).toBeNull();
    click(host!.querySelector<HTMLElement>('[data-testid="agent-tool-card"] button'));
    expect(q('[data-testid="agent-tool-raw"]')!.textContent).toContain("copy.ts 120줄");
    act(() => root!.unmount());
    host!.remove();
    host = null;
    render(model(events, OTHER), { decide: null, reply: null });
    expect(host!.querySelector('[data-testid="agent-tool-card"] button')).toBeNull();
  });

  it("unknown kinds and bad values become one fallback line, not a crash", () => {
    const events = [ev("mystery.kind", {}), ev("agent.partial", { text_delta: 5 }), tool("bash")];
    render(model(events, OWNER, { skipped: 1 }), { decide: null, reply: null });
    expect(q('[data-testid="agent-pane-skipped"]')!.textContent).toBe("알아보지 못한 진행 3개는 건너뛰었어요.");
    expect(host!.querySelectorAll('[data-testid="agent-tool-card"]')).toHaveLength(1);
  });

  it("renders 600 collapsed cards inside a loose budget", () => {
    const events: WorkSessionEvent[] = [];
    for (let i = 0; i < 600; i += 1) events.push(tool(i % 2 ? "read_file" : "bash", `step ${i}`));
    const m = model(events);
    vi.useRealTimers();
    const t0 = performance.now();
    render(m, { decide: null, reply: null });
    const ms = performance.now() - t0;
    expect(host!.querySelectorAll('[data-testid="agent-tool-card"]')).toHaveLength(600);
    expect(ms).toBeLessThan(2_000);
  });
});

describe("reply", () => {
  function type(text: string) {
    const box = q('[data-testid="agent-pane-reply-input"]') as HTMLTextAreaElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(box, text);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("defaults to the next turn; interrupting takes its own button", async () => {
    const reply = vi.fn(async () => undefined);
    render(model([tool("bash")]), { decide: null, reply });
    type("버튼 문구는 「이어서」로");
    await act(async () => {
      q('[data-testid="agent-pane-queue"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(reply).toHaveBeenLastCalledWith({ sessionId: SID, text: "버튼 문구는 「이어서」로", mode: "queue" });
    type("지금 멈추고 테스트부터");
    await act(async () => {
      q('[data-testid="agent-pane-interrupt"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(reply).toHaveBeenLastCalledWith({ sessionId: SID, text: "지금 멈추고 테스트부터", mode: "interrupt" });
    expect(reply).toHaveBeenCalledTimes(2);
  });

  it("without a reply route the box says so and sends nothing", () => {
    render(model([tool("bash")]), { decide: null, reply: null });
    expect((q('[data-testid="agent-pane-reply-input"]') as HTMLTextAreaElement).disabled).toBe(true);
    expect(q('[data-testid="agent-pane-reply-hint"]')!.textContent).toBe(REPLY_UNAVAILABLE);
  });
});
