import { describe, expect, it } from "vitest";
import type { WorkSession } from "../../lib/api";
import type { WorkSessionEvent } from "../work/workSessionModel";
import {
  AGENT_PANE_BINDINGS_KEY,
  CREDENTIAL_MASK,
  SANITIZE_FIELD_MAX,
  agentPaneModel,
  agentSessionStatus,
  bindAgentPane,
  canAllow,
  openableAgentSessions,
  parseAgentPaneBindings,
  pendingPermission,
  pruneAgentPanes,
  sanitizeDisplayText,
  toolCardKind,
  unbindAgentPane,
} from "./agentPane";

// A 칸 진행 뷰 모델(#2779). 대소문자가 섞인 id는 실측 모양 그대로다(서버 REST는
// 대문자, 투영 페이로드는 소문자).

const SESSION_ID = "019F9A34-5405-7FDA-9FB2-C6806F69D8A6";
const OWNER = "00000000-0000-7000-8000-000000000101";
const OTHER = "00000000-0000-7000-8000-000000000202";

function session(overrides: Partial<WorkSession> = {}): WorkSession {
  return {
    id: SESSION_ID,
    workspaceId: "00000000-0000-7000-8000-000000000001",
    channelId: "019f9a34-53fd-7f7a-abff-1e1369f61090",
    memberId: OWNER,
    hostId: "019F9A34-53F2-793D-9CA7-5D5480407C9E",
    rootMessageId: "019F9A34-5406-77A9-AB33-B011D56B91F8",
    tool: "claude",
    label: "온보딩 1단계 문구 다듬기",
    status: "running",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    remoteDisplayAvailable: false,
    startedAtMs: 1_784_998_548_483,
    ...overrides,
  };
}

let n = 0;
function ev(type: string, payload: Record<string, unknown>): WorkSessionEvent {
  n += 1;
  return {
    eventId: `ev-${n}`,
    type: type as WorkSessionEvent["type"],
    sessionId: SESSION_ID.toLowerCase(),
    atMs: 1_784_998_548_500 + n,
    seq: n,
    payload: { work_session_id: SESSION_ID.toLowerCase(), ...payload },
  };
}

const tool = (name: string, detail?: string) =>
  ev("agent.status", { phase: "streaming", run_status: "running", tool_call_name: name, ...(detail ? { detail } : {}) });

const ask = (options: unknown[]) =>
  ev("approval.requested", { action: "requested", action_type: "tool_call", status: "pending", options });

const ONCE = { option_id: "o1", name: "Allow once", kind: "allow_once" };
const ALWAYS = { option_id: "o2", name: "Always allow", kind: "allow_always" };
const REJECT = { option_id: "o3", name: "Reject", kind: "reject_once" };
const REJECT_ALWAYS = { option_id: "o4", name: "Never", kind: "reject_always" };

describe("toolCardKind", () => {
  it("classifies read, edit, execute, diff and falls back to other", () => {
    expect(toolCardKind("read_file")).toBe("read");
    expect(toolCardKind("Edit")).toBe("edit");
    expect(toolCardKind("bash")).toBe("execute");
    expect(toolCardKind("apply_diff")).toBe("diff");
    expect(toolCardKind("grep")).toBe("search");
    expect(toolCardKind("mystery_tool")).toBe("other");
    expect(toolCardKind(42)).toBe("other");
    expect(toolCardKind(undefined)).toBe("other");
  });
});

describe("permission card (ADR-0188 D5 phone constraints on the desktop pane)", () => {
  it("offers only allow_once and reject_once, never allow_always / reject_always", () => {
    const p = pendingPermission([tool("edit_file", "copy.ts +6 -6"), ask([ALWAYS, ONCE, REJECT_ALWAYS, REJECT])], session());
    expect(p?.allow).toEqual({ kind: "allow_once", optionId: "o1" });
    expect(p?.reject).toEqual({ kind: "reject_once", optionId: "o3" });
    expect(p?.hiddenOptions).toBe(2);
    expect(p?.tool?.kind).toBe("edit");
  });

  it("an allow_always labelled 'Allow once' is still hidden: kind decides, not name", () => {
    const p = pendingPermission([ask([{ option_id: "x", name: "Allow once", kind: "allow_always" }])], session());
    expect(p?.allow).toBeNull();
  });

  it("drops malformed options without throwing", () => {
    const p = pendingPermission(
      [ask([null, 7, "allow_once", { kind: "allow_once" }, { option_id: "", kind: "allow_once" }, { option_id: "z".repeat(200), kind: "allow_once" }])],
      session()
    );
    expect(p).not.toBeNull();
    expect(p?.allow).toBeNull();
    expect(p?.hiddenOptions).toBe(6);
  });

  it("a decision closes the card, and a dead session has no live request", () => {
    expect(pendingPermission([ask([ONCE]), ev("approval.decided", { action: "decided", status: "approved" })], session())).toBeNull();
    expect(pendingPermission([ask([ONCE])], session({ status: "ended" }))).toBeNull();
    expect(pendingPermission([ask([ONCE])], session({ status: "orphaned" }))).toBeNull();
  });

  it("a truncated preview cannot be allowed; a whole one can", () => {
    const p = pendingPermission([tool("bash", "x".repeat(SANITIZE_FIELD_MAX + 10)), ask([ONCE, REJECT])], session())!;
    expect(p.preview?.truncated).toBe(true);
    expect(canAllow(p)).toBe(false);
    const whole = pendingPermission([tool("bash", "npm install"), ask([ONCE, REJECT])], session())!;
    expect(canAllow(whole)).toBe(true);
  });

  it("non-owners learn only that a request exists: no options, no preview", () => {
    const events = [tool("bash", "npm install"), ask([ONCE, REJECT])];
    const mine = agentPaneModel({ session: session(), events, truncated: false, viewerMemberId: OWNER.toUpperCase(), hostName: "MacBook" });
    const theirs = agentPaneModel({ session: session(), events, truncated: false, viewerMemberId: OTHER, hostName: "MacBook" });
    expect(mine.viewerIsOwner).toBe(true);
    expect(mine.permission?.allow?.optionId).toBe("o1");
    expect(mine.status).toBe("waiting");
    expect(theirs.viewerIsOwner).toBe(false);
    expect(theirs.permission).not.toBeNull();
    expect(theirs.permission?.allow).toBeNull();
    expect(theirs.permission?.reject).toBeNull();
    expect(theirs.permission?.preview).toBeNull();
    expect(theirs.status).toBe("running");
  });
});

describe("sanitizeDisplayText (D5)", () => {
  it("neutralizes bidi and invisible characters into visible marks", () => {
    const out = sanitizeDisplayText("rm -rf \u202Egnp.exe\u200B ok\u0007");
    // Per character, not a regex class: a control character inside a regex
    // literal trips eslint `no-control-regex` (#3064).
    for (const ch of ["\u202E", "\u200B", "\u0007"]) {
      expect(out.text).not.toContain(ch);
    }
    expect(out.text).toContain("‹U+202E›");
    expect(out.neutralized).toBe(3);
  });

  it("keeps head and tail past 3,500 characters", () => {
    const out = sanitizeDisplayText(`HEAD${"a".repeat(5000)}TAIL`);
    expect(out.truncated).toBe(true);
    expect(out.text.startsWith("HEAD")).toBe(true);
    expect(out.text.endsWith("TAIL")).toBe(true);
    expect(out.omitted).toBe(5008 - SANITIZE_FIELD_MAX);
  });

  it("masks recognisable credentials", () => {
    // 가짜 값을 실행 때 조립한다: 원문 모양이 소스에 있으면 비밀 스캐너가 이력째 잡는다.
    const fake = (...parts: string[]) => parts.join("");
    const out = sanitizeDisplayText(
      `key ${fake("sk-", "ant-", "abcdefghijklmnopqrstu")} and ${fake("gh", "p_", "abcdefghijklmnopqrstuvwxyz0123")} Bearer abcdefghijklmnopqrstuvwxyz ${fake("AK", "IA", "ABCDEFGHIJKLMNOP")}`
    );
    expect(out.text).not.toContain("sk-ant-abcdef");
    expect(out.text).not.toContain("ghp_abcdef");
    expect(out.text).not.toContain("AKIAABCD");
    expect(out.text).toContain(`Bearer ${CREDENTIAL_MASK}`);
    expect(out.masked).toBe(4);
  });

  it("returns empty text for non-strings", () => {
    expect(sanitizeDisplayText({ html: "<b>" }).text).toBe("");
  });
});

describe("agentPaneModel", () => {
  it("builds plan steps, collapsed tool cards and counts malformed events as skipped", () => {
    const events = [
      ev("agent.status", {
        phase: "thinking",
        run_status: "running",
        plan: [
          { content: "문구 파일 읽기", status: "completed" },
          { content: "해요체로 고치기", status: "in_progress" },
          { title: 42 },
          { content: "PR 열기", status: "weird" },
        ],
      }),
      tool("read_file", "copy.ts"),
      ev("agent.status", { phase: "streaming", run_status: "running", tool_call_name: { evil: true } }),
      ev("agent.partial", { text_delta: 12 }),
      ev("mystery.kind", { foo: 1 }),
      tool("edit_file"),
    ];
    const model = agentPaneModel({ session: session(), events, truncated: false, skipped: 2, viewerMemberId: OWNER, hostName: "MacBook" });
    expect(model.plan.map((p) => p.status)).toEqual(["completed", "in_progress", "pending"]);
    expect(model.planDone).toBe(1);
    const cards = model.feed.filter((f) => f.type === "tool");
    expect(cards.map((c) => (c.type === "tool" ? c.card.kind : null))).toEqual(["read", "edit"]);
    expect(model.skipped).toBe(5);
  });

  it("ignores events of another session", () => {
    const other = { ...tool("bash"), sessionId: "ffffffff-0000-7000-8000-000000000000" };
    const model = agentPaneModel({ session: session(), events: [other], truncated: false, viewerMemberId: OWNER, hostName: null });
    expect(model.feed).toHaveLength(0);
  });

  it("folds 1,000 events inside a loose budget", () => {
    const events: WorkSessionEvent[] = [];
    for (let i = 0; i < 1000; i += 1) events.push(tool(i % 3 === 0 ? "bash" : i % 3 === 1 ? "read_file" : "edit_file", `step ${i}`));
    const t0 = performance.now();
    const model = agentPaneModel({ session: session(), events, truncated: false, viewerMemberId: OWNER, hostName: null });
    const ms = performance.now() - t0;
    expect(model.feed).toHaveLength(1000);
    expect(ms).toBeLessThan(500);
  });
});

describe("agentSessionStatus", () => {
  it("maps ledger status onto the pane vocabulary", () => {
    expect(agentSessionStatus({ status: "running" }, false, true)).toBe("running");
    expect(agentSessionStatus({ status: "idle" }, false, true)).toBe("review");
    expect(agentSessionStatus({ status: "ended" }, false, true)).toBe("done");
    expect(agentSessionStatus({ status: "orphaned" }, false, true)).toBe("stopped");
    expect(agentSessionStatus({ status: "running" }, true, true)).toBe("waiting");
    expect(agentSessionStatus({ status: "running" }, true, false)).toBe("running");
  });
});

describe("pane bindings (this device)", () => {
  it("parses defensively and prunes panes that left the layout", () => {
    expect(AGENT_PANE_BINDINGS_KEY).toMatch(/agentPanes/);
    expect(parseAgentPaneBindings("not json")).toEqual({});
    expect(parseAgentPaneBindings('{"p1":"019f9a34-5405","bad key":"x","p2":7}')).toEqual({ p1: "019f9a34-5405" });
    let b = bindAgentPane({}, "p1", SESSION_ID);
    b = bindAgentPane(b, "p3", SESSION_ID);
    expect(pruneAgentPanes(b, ["p1"])).toEqual({ p1: SESSION_ID });
    expect(unbindAgentPane(b, "p3")).toEqual({ p1: SESSION_ID });
  });

  it("offers only the viewer's unfinished sessions, running first", () => {
    const list = openableAgentSessions(
      [
        session({ id: "a", status: "idle", startedAtMs: 3 }),
        session({ id: "b", status: "running", startedAtMs: 1 }),
        session({ id: "c", status: "ended" }),
        session({ id: "d", status: "running", memberId: OTHER }),
      ],
      OWNER
    );
    expect(list.map((s) => s.id)).toEqual(["b", "a"]);
  });
});

describe("approval.auto_allowed (#3095 / #3152)", () => {
  const SHA = "a".repeat(64);
  const auto = (tool_kind = "read", over: Record<string, unknown> = {}) =>
    ev("approval.auto_allowed", {
      action: "auto_allowed",
      status: "approved",
      scope: "session",
      tool_kind,
      preview_sha256: SHA,
      ...over,
    });

  it("shows one line per automatic allow and counts none as skipped", () => {
    const m = agentPaneModel({ session: session(), events: [auto("execute")], truncated: false, viewerMemberId: OWNER, hostName: null });
    expect(m.skipped).toBe(0);
    expect(m.feed).toHaveLength(1);
    expect(m.feed[0]).toMatchObject({ type: "line", kind: "approval", state: "done" });
    expect((m.feed[0] as { text: { text: string } }).text.text).toBe("세션 허락으로 자동 허락됨 · 명령 실행");
  });

  it("does NOT close a pending card of another tool kind (the approval.decided confusion)", () => {
    const events = [tool("bash", "npm test"), ask([ONCE, REJECT]), auto("read")];
    const p = pendingPermission(events, session());
    expect(p?.allow).toEqual({ kind: "allow_once", optionId: "o1" });
    const m = agentPaneModel({ session: session(), events, truncated: false, viewerMemberId: OWNER, hostName: null });
    expect(m.permission).not.toBeNull();
    expect(m.status).toBe("waiting");
    // the pending approval line stays pending; the auto line sits beside it.
    const lines = m.feed.filter((f) => f.type === "line");
    expect(lines.map((l) => l.type === "line" && [l.state, l.text.text])).toEqual([
      ["pending", "승인을 요청함"],
      ["done", "세션 허락으로 자동 허락됨 · 파일 읽기"],
    ]);
    // ...whereas a real decision does close it (control for the assertion above)
    expect(pendingPermission([...events, ev("approval.decided", { action: "decided", status: "approved" })], session())).toBeNull();
  });

  it("prints only fixed phrases for tool_kind, never the host's string", () => {
    const m = agentPaneModel({ session: session(), events: [auto("<script>x</script>"), auto("__proto__"), auto("edit")], truncated: false, viewerMemberId: OWNER, hostName: null });
    expect(m.feed.map((f) => f.type === "line" && f.text.text)).toEqual([
      "세션 허락으로 자동 허락됨 · 도구 사용",
      "세션 허락으로 자동 허락됨 · 도구 사용",
      "세션 허락으로 자동 허락됨 · 파일 수정",
    ]);
  });

  it("an event that is not the session-scope approved shape is not shown as an allow", () => {
    const m = agentPaneModel({
      session: session(),
      events: [auto("read", { scope: "once" }), auto("read", { status: "rejected" })],
      truncated: false,
      viewerMemberId: OWNER,
      hostName: null,
    });
    expect(m.feed).toHaveLength(0);
  });
});
