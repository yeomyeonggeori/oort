// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type WorkSession } from "@momo/core/lib/api";
import type { WorkSessionEvent } from "@momo/core/features/work/workSessionModel";
import {
  PERMISSION_HOST_WAIT_MS,
  PERMISSION_LAPSED_LINE,
  PERMISSION_OFFLINE_LINE,
  agentPaneModel,
  type AgentPaneModel,
} from "@momo/core/features/workbench/agentPane";
import { CONFIRM_GUARD_MS } from "@/features/timeline/ApprovalActions";
import {
  ALLOW_IN_APP_LINE,
  AgentProgressView,
  DECIDE_UNAVAILABLE,
  REPLY_IN_APP_HINT,
  REPLY_IN_APP_PLACEHOLDER,
  REPLY_UNAVAILABLE,
  type AgentPaneActions,
} from "./AgentProgressView";
import { humanSignatureRefusal, type InstructFrom } from "@momo/core/features/auth/humanSignature";

// A 칸 진행 뷰(#2779). 사보타주 대상은 셋이다:
//   - 권한 카드는 사람이 무장 → 확정을 누르기 전에는 결정을 만들지 않는다.
//   - 「항상 허용」은 어떤 이름표를 달고 와도 버튼이 되지 않는다.
//   - 답장의 기본은 다음 차례, 끼어들기는 따로 누른 버튼에서만.
// #3013: 결정의 결과(보냄·409 두 가지·403·닿지 못함), 오프라인 잠금, 630초 만료,
// 거부에 지시문이 실리지 않음.

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
    // 시계(beforeEach)보다 1분 앞. 권한 요청은 630초 뒤 닫힌다.
    atMs: Date.parse("2026-09-28T00:59:00Z") + n,
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

function render(
  m: AgentPaneModel,
  actions: AgentPaneActions,
  ownerName: string | null = "곽성재",
  offline = false,
  instructFrom: InstructFrom = "here"
) {
  if (!host) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  act(() => {
    root!.render(createElement(AgentProgressView, { model: m, ownerName, actions, offline, instructFrom }));
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
      scope: "once",
    });
  });

  it("Esc disarms and the caret goes back to the button that armed", () => {
    const decide = vi.fn(async () => undefined);
    render(model([tool("bash", "npm install"), ask([ONCE, REJECT])]), { decide, reply: null });
    click(q('[data-testid="agent-permission-reject"]'));
    const box = q('[data-testid="agent-permission-commit"]')!;
    act(() => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(q('[data-testid="agent-permission-confirm"]')).toBeNull();
    expect(document.activeElement).toBe(q('[data-testid="agent-permission-reject"]'));
    expect(decide).not.toHaveBeenCalled();
  });

  it("reject sends only the three golden keys; there is no instruction box to fill", async () => {
    const decide = vi.fn(async () => undefined);
    render(model([tool("bash", "npm install"), ask([ONCE, REJECT])]), { decide, reply: null });
    click(q('[data-testid="agent-permission-reject"]'));
    expect(q('[data-testid="agent-permission"] textarea')).toBeNull();
    expect(q('[data-testid="agent-permission-instruction"]')).toBeNull();
    act(() => vi.advanceTimersByTime(CONFIRM_GUARD_MS));
    await act(async () => {
      q('[data-testid="agent-permission-commit"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(decide).toHaveBeenCalledTimes(1);
    const [decision] = decide.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(Object.keys(decision).sort()).toEqual(["kind", "optionId", "requestEventId", "sessionId"]);
    expect(decision).toMatchObject({ kind: "reject_once", optionId: "no" });
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

async function commitAllow() {
  click(q('[data-testid="agent-permission-allow"]'));
  act(() => vi.advanceTimersByTime(CONFIRM_GUARD_MS));
  await act(async () => {
    q('[data-testid="agent-permission-commit"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("decision outcomes (#3013)", () => {
  const events = () => [tool("bash", "npm install"), ask([ONCE, REJECT])];

  it("200: the buttons go and the card says what was sent", async () => {
    const decide = vi.fn(async () => undefined);
    render(model(events()), { decide, reply: null });
    await commitAllow();
    expect(q('[data-testid="agent-permission-allow"]')).toBeNull();
    expect(q('[data-testid="agent-permission-outcome"]')!.textContent).toBe(
      "이번 한 번 허락을 보냈어요. 에이전트가 이어서 해요."
    );
    expect(q('[data-testid="agent-permission"]')!.getAttribute("data-settled")).toBe("sent");
    expect(document.activeElement).toBe(q('[data-testid="agent-permission"]'));
  });

  it("when the server's approval.decided closes the card, the caret lands on the pane and the result is still announced", async () => {
    const decide = vi.fn(async () => undefined);
    const evs = events();
    render(model(evs), { decide, reply: null });
    await commitAllow();
    // 서버가 같은 tx에서 쓴 `approval.decided`가 실시간(또는 다시 읽기)으로 온다.
    const decided = ev("approval.decided", { action: "decided", status: "approved", option_id: "once", request_event_id: evs[1].eventId });
    render(model([...evs, decided]), { decide, reply: null });
    await act(async () => {
      await Promise.resolve();
    });
    expect(q('[data-testid="agent-permission"]')).toBeNull();
    expect(document.activeElement).toBe(q('[data-testid="agent-pane"]'));
    expect(q('[data-testid="agent-pane-announce"]')!.textContent).toBe(
      "이번 한 번 허락을 보냈어요. 에이전트가 이어서 해요."
    );
  });

  it("a failed send keeps the buttons; the same decision again (server 200) settles it", async () => {
    const decide = vi
      .fn<(d: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(undefined);
    render(model(events()), { decide, reply: null });
    await commitAllow();
    expect(q('[data-testid="agent-permission-error"]')!.textContent).toBe(
      "결정을 보내지 못했어요. 연결을 확인한 뒤 다시 누르세요."
    );
    // 무장은 풀리지 않았다: 같은 확정 버튼을 다시 누른다.
    await act(async () => {
      q('[data-testid="agent-permission-commit"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(decide).toHaveBeenCalledTimes(2);
    expect(decide.mock.calls[0][0]).toEqual(decide.mock.calls[1][0]);
    expect(q('[data-testid="agent-permission-outcome"]')!.textContent).toContain("허락을 보냈어요");
  });

  it("409 permission_already_decided: another decision won, said plainly, no buttons", async () => {
    const decide = vi.fn(async () => {
      throw new ApiError(409, "x", "permission_already_decided");
    });
    render(model(events()), { decide, reply: null });
    await commitAllow();
    expect(q('[data-testid="agent-permission-commit"]')).toBeNull();
    expect(q('[data-testid="agent-permission-outcome"]')!.textContent).toBe(
      "이미 다른 결정이 먼저 들어갔어요. 다른 기기에서 결정했을 수 있어요."
    );
    expect(q('[data-testid="agent-permission"]')!.getAttribute("data-settled")).toBe("closed");
  });

  it("409 permission_request_closed: the request is closed, a different sentence", async () => {
    const decide = vi.fn(async () => {
      throw new ApiError(409, "x", "permission_request_closed");
    });
    render(model(events()), { decide, reply: null });
    await commitAllow();
    const text = q('[data-testid="agent-permission-outcome"]')!.textContent ?? "";
    expect(text).toContain("이 요청은 이미 닫혔어요");
    expect(text).not.toContain("다른 결정");
  });

  it("403: only the owner decides", async () => {
    const decide = vi.fn(async () => {
      throw new ApiError(403, "x", "permission_owner_only");
    });
    render(model(events()), { decide, reply: null });
    await commitAllow();
    expect(q('[data-testid="agent-permission-outcome"]')!.textContent).toContain("소유자만 결정할 수 있어요");
    expect(q('[data-testid="agent-permission-allow"]')).toBeNull();
  });

  it("offline locks both buttons with one line of reason, and disarms", () => {
    const decide = vi.fn(async () => undefined);
    const m = model(events());
    render(m, { decide, reply: null });
    click(q('[data-testid="agent-permission-allow"]'));
    expect(q('[data-testid="agent-permission-confirm"]')).not.toBeNull();
    render(m, { decide, reply: null }, "곽성재", true);
    expect(q('[data-testid="agent-permission-confirm"]')).toBeNull();
    expect((q('[data-testid="agent-permission-allow"]') as HTMLButtonElement).disabled).toBe(true);
    expect((q('[data-testid="agent-permission-reject"]') as HTMLButtonElement).disabled).toBe(true);
    expect(q('[data-testid="agent-permission-unavailable"]')!.textContent).toBe(PERMISSION_OFFLINE_LINE);
    expect(decide).not.toHaveBeenCalled();
  });

  it("the card closes itself when the host stops waiting (630s)", () => {
    const decide = vi.fn(async () => undefined);
    const evs = events();
    const requestedAt = evs[1].atMs;
    render(model(evs), { decide, reply: null });
    act(() => vi.setSystemTime(requestedAt + PERMISSION_HOST_WAIT_MS - 2_000));
    act(() => vi.advanceTimersByTime(1_000));
    expect(q('[data-testid="agent-permission-allow"]')).not.toBeNull();
    act(() => vi.advanceTimersByTime(PERMISSION_HOST_WAIT_MS));
    expect(q('[data-testid="agent-permission-allow"]')).toBeNull();
    expect(q('[data-testid="agent-permission-outcome"]')!.textContent).toBe(PERMISSION_LAPSED_LINE);
    expect(decide).not.toHaveBeenCalled();
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

// #3029 (R2-E9, ADR-0146 개정 D-4): 일반 브라우저 + 서명을 요구하는 서버. 사보타주 대상:
//   - 권한 카드의 허락과 답장 칸이 같은 값(`instructFrom`)을 읽는다(한쪽만 안내면 실패).
//   - 거부는 안내 아래에서도 그대로 보낸다.
//   - 서명 거부는 사유마다 다른 문장이고, 「소유자만」으로 뭉개지지 않는다.
describe("browser instructs from the app (#3029)", () => {
  const events = () => [tool("bash", "npm install"), ask([ONCE, REJECT])];

  function typeReply(text: string) {
    const box = q('[data-testid="agent-pane-reply-input"]') as HTMLTextAreaElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(box, text);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it.each(["here", "app"] as const)("the allow button and the reply box read the same value (%s)", async (from) => {
    const decide = vi.fn(async () => undefined);
    const reply = vi.fn(async () => undefined);
    render(model(events()), { decide, reply }, "곽성재", false, from);
    const app = from === "app";
    const allow = q('[data-testid="agent-permission-allow"]') as HTMLButtonElement;
    const inApp = q('[data-testid="agent-permission-in-app"]');
    const input = q('[data-testid="agent-pane-reply-input"]') as HTMLTextAreaElement;
    const hint = q('[data-testid="agent-pane-reply-hint"]')!;
    // 권한 카드
    expect(allow.disabled).toBe(app);
    expect(inApp?.textContent ?? null).toBe(app ? ALLOW_IN_APP_LINE : null);
    expect(allow.getAttribute("aria-describedby")).toBe(app ? inApp!.id : null);
    expect((q('[data-testid="agent-permission-reject"]') as HTMLButtonElement).disabled).toBe(false);
    // 답장 칸 — 같은 판정
    expect(input.disabled).toBe(app);
    expect(hint.textContent === REPLY_IN_APP_HINT).toBe(app);
    expect(hint.textContent === "지시는 폰이나 데스크탑 앱에서 보내 주세요").toBe(app);
    expect(input.placeholder).toBe(app ? REPLY_IN_APP_PLACEHOLDER : "다음 지시를 적어요");
    // 판정이 두 자리에서 어긋나지 않는다.
    expect(allow.disabled).toBe(input.disabled);
    // 브라우저에서는 무엇을 눌러도 허락·지시가 나가지 않는다.
    typeReply("다음은 테스트부터");
    click(allow);
    await act(async () => {
      q('[data-testid="agent-pane-queue"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      q('[data-testid="agent-pane-interrupt"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(decide).toHaveBeenCalledTimes(0);
    expect(reply.mock.calls.length > 0).toBe(!app);
  });

  it("reject still goes from the browser", async () => {
    const decide = vi.fn(async () => undefined);
    render(model(events()), { decide, reply: null }, "곽성재", false, "app");
    click(q('[data-testid="agent-permission-reject"]'));
    act(() => vi.advanceTimersByTime(CONFIRM_GUARD_MS));
    await act(async () => {
      q('[data-testid="agent-permission-commit"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(decide).toHaveBeenCalledWith({ sessionId: SID, requestEventId: expect.any(String), optionId: "no", kind: "reject_once" });
    expect(q('[data-testid="agent-permission-outcome"]')!.textContent).toContain("거부를 보냈어요");
  });

  it("offline or cramped reasons win over the app line (one reason at a time)", () => {
    render(model(events()), { decide: async () => undefined, reply: null }, "곽성재", true, "app");
    expect(q('[data-testid="agent-permission-in-app"]')).toBeNull();
    expect(q('[data-testid="agent-permission-unavailable"]')!.textContent).toBe(PERMISSION_OFFLINE_LINE);
  });

  it.each([
    [403, "device_signature_required"],
    [403, "device_key_not_endorsed"],
    [403, "device_key_revoked"],
    [403, "device_signature_expired"],
    [403, "device_signature_invalid"],
    [409, "device_nonce_replayed"],
  ] as const)("%s %s on an allow: its own sentence, the request stays open", async (status, code) => {
    const decide = vi.fn(async () => {
      throw new ApiError(status, "server words", code);
    });
    render(model(events()), { decide, reply: null });
    await commitAllow();
    const error = q('[data-testid="agent-permission-error"]')!.textContent;
    expect(error).toBe(humanSignatureRefusal({ code })!.text);
    expect(error).not.toContain("소유자만");
    expect(error).not.toContain("이미 닫혔어요");
    expect(q('[data-testid="agent-permission-outcome"]')).toBeNull();
    expect(q('[data-testid="agent-permission"]')!.getAttribute("data-settled")).toBeNull();
  });

  it("after a 403 device_signature_required the pane turns to the app line: no armed allow, one sentence, caret on the card", async () => {
    const decide = vi.fn(async () => {
      throw new ApiError(403, "x", "device_signature_required");
    });
    const m = model(events());
    render(m, { decide, reply: null });
    await commitAllow();
    expect(q('[data-testid="agent-permission-error"]')).not.toBeNull();
    // 소스가 플래그를 다시 읽고 `app`으로 바꾼다.
    render(m, { decide, reply: null }, "곽성재", false, "app");
    expect(q('[data-testid="agent-permission-confirm"]')).toBeNull();
    expect(q('[data-testid="agent-permission-error"]')).toBeNull();
    expect(q('[data-testid="agent-permission-in-app"]')!.textContent).toBe(ALLOW_IN_APP_LINE);
    expect((q('[data-testid="agent-permission-reject"]') as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement).toBe(q('[data-testid="agent-permission"]'));
  });

  it("a refused instruction says why in the reply hint", async () => {
    const reply = vi.fn(async () => {
      throw new ApiError(403, "x", "device_key_not_endorsed");
    });
    render(model([tool("bash")]), { decide: null, reply });
    typeReply("이어서");
    await act(async () => {
      q('[data-testid="agent-pane-queue"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // #3028: a signed instruction that does not arrive says so first (D-5b 「전달 안 됨」).
    expect(q('[data-testid="agent-pane-reply-hint"]')!.textContent).toBe(
      `전달 안 됨 · ${humanSignatureRefusal({ code: "device_key_not_endorsed" })!.text}`
    );
    expect(q('[data-testid="agent-pane-reply-hint"]')!.getAttribute("role")).toBe("alert");
  });
});

// ---- #3028 R2-E8: 서명하는 표면(데스크탑 셸 + 서명을 요구하는 서버) ---------------

describe("signed surface (#3028)", () => {
  const events = () => [tool("bash", "npm install"), ask([ONCE, REJECT])];
  function typeInto(selector: string, text: string) {
    const box = q(selector) as HTMLTextAreaElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(box, text);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function commit() {
    act(() => vi.advanceTimersByTime(CONFIRM_GUARD_MS));
    await act(async () => {
      q('[data-testid="agent-permission-commit"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("without the signed path there is no 「이 세션 동안」 and no instruction box on reject (today's card)", () => {
    render(model(events()), { decide: vi.fn(async () => undefined), reply: null });
    expect(q('[data-testid="agent-permission-allow-session"]')).toBeNull();
    click(q('[data-testid="agent-permission-reject"]'));
    expect(q('[data-testid="agent-permission-reject-note"]')).toBeNull();
  });

  it("「이 세션 동안 허락」 sends scope session, only after arming", async () => {
    const decide = vi.fn(async () => undefined);
    render(model(events()), { decide, reply: null, sessionScope: true, rejectWithInstruction: vi.fn() });
    click(q('[data-testid="agent-permission-allow-session"]'));
    expect(decide).not.toHaveBeenCalled();
    expect(q('[data-testid="agent-permission-confirm"]')!.textContent).toContain("이 세션이 끝날 때까지");
    await commit();
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ kind: "allow_once", optionId: "once", scope: "session" }));
    expect(q('[data-testid="agent-permission-outcome"]')!.textContent).toContain("이 세션 동안 허락을 보냈어요");
  });

  it("a truncated preview locks 「이 세션 동안」 too", () => {
    const long = "x\n".repeat(3000);
    render(model([tool("bash", long), ask([ONCE, REJECT])]), {
      decide: vi.fn(async () => undefined),
      reply: null,
      sessionScope: true,
    });
    expect((q('[data-testid="agent-permission-allow-session"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("「거부 + 지시」: the note goes to rejectWithInstruction; an empty note is a plain reject", async () => {
    const decide = vi.fn(async () => undefined);
    const rejectWithInstruction = vi.fn(async () => ({ state: "rejected" as const, instruction: { state: "sent" as const } }));
    render(model(events()), { decide, reply: null, sessionScope: true, rejectWithInstruction });
    click(q('[data-testid="agent-permission-reject"]'));
    typeInto('[data-testid="agent-permission-reject-note"]', "테스트만 고쳐 줘");
    expect(q('[data-testid="agent-permission-commit"]')!.textContent).toBe("거부하고 지시 보내기");
    await commit();
    expect(decide).not.toHaveBeenCalled();
    expect(rejectWithInstruction).toHaveBeenCalledWith({
      sessionId: SID,
      requestEventId: expect.stringMatching(/^ev-/),
      optionId: "no",
      text: "테스트만 고쳐 줘",
    });
    expect(q('[data-testid="agent-permission"]')!.getAttribute("data-settled")).toBe("sent");
  });

  it("arming reject with the instruction box puts the caret in the box, not on body (design-review H1)", () => {
    render(model(events()), { decide: vi.fn(async () => undefined), reply: null, sessionScope: true, rejectWithInstruction: vi.fn() });
    click(q('[data-testid="agent-permission-reject"]'));
    expect(document.activeElement).toBe(q('[data-testid="agent-permission-reject-note"]'));
  });

  it("an undelivered 「거부 + 지시」 is added after a draft already in the reply box, never dropped", async () => {
    const rejectWithInstruction = vi.fn(async () => ({
      state: "rejected" as const,
      instruction: { state: "not_delivered" as const, stage: "server" as const, text: "호스트", error: null },
    }));
    render(model(events()), { decide: vi.fn(async () => undefined), reply: vi.fn(), sessionScope: true, rejectWithInstruction });
    typeInto('[data-testid="agent-pane-reply-input"]', "쓰던 글");
    click(q('[data-testid="agent-permission-reject"]'));
    typeInto('[data-testid="agent-permission-reject-note"]', "다르게 해 줘");
    await commit();
    expect((q('[data-testid="agent-pane-reply-input"]') as HTMLTextAreaElement).value).toBe("쓰던 글\n다르게 해 줘");
  });

  it("a cancelled signature on 「거부 + 지시」 keeps the card and says 「전달 안 됨」", async () => {
    const rejectWithInstruction = vi.fn(async () => ({
      state: "not_sent" as const,
      text: "서명을 취소해서 보내지 않았어요.",
      error: null,
    }));
    render(model(events()), { decide: vi.fn(async () => undefined), reply: null, sessionScope: true, rejectWithInstruction });
    click(q('[data-testid="agent-permission-reject"]'));
    typeInto('[data-testid="agent-permission-reject-note"]', "다르게 해 줘");
    await commit();
    expect(q('[data-testid="agent-permission-error"]')!.textContent).toBe("전달 안 됨 · 서명을 취소해서 보내지 않았어요.");
    expect(q('[data-testid="agent-permission"]')!.getAttribute("data-settled")).toBeNull();
  });

  it("rejected but the instruction did not arrive: the card says both, never just 「거부를 보냈어요」", async () => {
    const rejectWithInstruction = vi.fn(async () => ({
      state: "rejected" as const,
      instruction: {
        state: "not_delivered" as const,
        stage: "server" as const,
        text: "호스트가 90초 넘게 응답하지 않아 보내지 않았어요.",
        error: null,
      },
    }));
    render(model(events()), { decide: vi.fn(async () => undefined), reply: null, sessionScope: true, rejectWithInstruction });
    click(q('[data-testid="agent-permission-reject"]'));
    typeInto('[data-testid="agent-permission-reject-note"]', "다르게 해 줘");
    await commit();
    const card = q('[data-testid="agent-permission"]')!;
    expect(card.getAttribute("data-settled")).toBe("partial");
    // 쓴 지시는 버리지 않는다: 지시 칸으로 옮겨 다시 보낼 수 있다(design-review M1).
    expect((q('[data-testid="agent-pane-reply-input"]') as HTMLTextAreaElement).value).toBe("다르게 해 줘");
    expect(q('[data-testid="agent-permission-outcome"]')!.getAttribute("role")).toBe("alert");
    const text = q('[data-testid="agent-permission-outcome"]')!.textContent!;
    expect(text).toContain("거부는 보냈어요");
    expect(text).toContain("전달 안 됨");
    expect(text).toContain("호스트가 90초");
  });

  it("a signed reply that does not arrive keeps the text and says 「전달 안 됨」 (never cleared as if sent)", async () => {
    const reply = vi.fn(async () => ({
      state: "not_delivered" as const,
      stage: "sign" as const,
      text: "서명을 취소해서 보내지 않았어요.",
      error: null,
    }));
    render(model([tool("bash")]), { decide: null, reply });
    const box = q('[data-testid="agent-pane-reply-input"]') as HTMLTextAreaElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(box, "이어서 해 줘");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      q('[data-testid="agent-pane-interrupt"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(reply).toHaveBeenCalledWith({ sessionId: SID, text: "이어서 해 줘", mode: "interrupt" });
    const hint = q('[data-testid="agent-pane-reply-hint"]')!;
    expect(hint.textContent).toBe("전달 안 됨 · 서명을 취소해서 보내지 않았어요.");
    expect(hint.getAttribute("data-failed")).toBe("");
    expect(box.value).toBe("이어서 해 줘");
  });
});
