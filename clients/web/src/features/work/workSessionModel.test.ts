import { describe, expect, it } from "vitest";
import type { Message, WorkHost, WorkSession } from "@/lib/api";
import type { WorkSessionACPFrame } from "@/lib/realtime";
import {
  composeExcerpt,
  eventFromFrame,
  eventsForSession,
  foldSessionEvents,
  isSlowStep,
  lastLine,
  mergeEvents,
  parseWorkSessionEvent,
  peekRows,
  scopeSessions,
  sortSessions,
  SLOW_STEP_MS,
  toolPhrase,
  workChannelsToWatch,
  workHostTrust,
  workSessionStatus,
  type WorkSessionEvent,
} from "./workSessionModel";

// =============================================================================
// The rules the 작업 세션 panel renders (AX-3 / MOMO-618).
//
// The fixtures are the SHAPES momowebqa actually returned on 2026-07-26 during
// a host-signed round trip (register work host -> open session -> relay
// agent.status / agent.partial / approval.* -> read the thread back), including
// the two casing quirks that cost other surfaces a bug: the session id comes
// back UPPERCASE from the Swift encoder while the ids inside a projected ACP
// payload are lowercase Postgres JSON.
// =============================================================================

const SESSION_ID = "019F9A34-5405-7FDA-9FB2-C6806F69D8A6";
const CHANNEL_ID = "019f9a34-53fd-7f7a-abff-1e1369f61090";
const ROOT_ID = "019F9A34-5406-77A9-AB33-B011D56B91F8";
const HOST_ID = "019F9A34-53F2-793D-9CA7-5D5480407C9E";

function session(overrides: Partial<WorkSession> = {}): WorkSession {
  return {
    id: SESSION_ID,
    workspaceId: "00000000-0000-7000-8000-000000000001",
    channelId: CHANNEL_ID,
    memberId: "00000000-0000-7000-8000-000000000101",
    hostId: HOST_ID,
    rootMessageId: ROOT_ID,
    tool: "claude",
    label: "clients/web 관전 패널 왕복 확인",
    status: "running",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    startedAtMs: 1_784_998_548_483,
    ...overrides,
  };
}

let seq = 1;

function reply(
  type: string,
  payload: Record<string, unknown>,
  atMs = 1_784_998_548_500
): Message {
  seq += 1;
  return {
    id: `msg-${seq}`,
    channelId: CHANNEL_ID,
    rootId: ROOT_ID,
    seq,
    hlcTs: atMs,
    hlcCount: 0,
    authorMemberId: "00000000-0000-7000-8000-000000000101",
    type: "system",
    // The server writes these bodies in English; nothing in the panel reads
    // them, which is exactly what this fixture is here to keep true.
    body: "ACP session update",
    createdAtMs: atMs,
    props: {
      kind: "work_session_event",
      schema: "momo.work_session.acp_event.v1",
      source: "acp",
      event_id: `EVENT-${seq}`,
      event_type: type,
      event_ts: atMs,
      event: {
        run_id: SESSION_ID,
        work_session_id: SESSION_ID,
        channel_id: CHANNEL_ID,
        ...payload,
      },
    },
  };
}

function events(...messages: Message[]): WorkSessionEvent[] {
  return messages
    .map(parseWorkSessionEvent)
    .filter((event): event is WorkSessionEvent => event !== null);
}

describe("workSessionStatus", () => {
  it("splits ended on the exit code and keeps orphaned its own state", () => {
    expect(workSessionStatus(session()).key).toBe("running");
    expect(workSessionStatus(session({ status: "orphaned" })).key).toBe("orphaned");
    expect(
      workSessionStatus(session({ status: "ended", exitCode: 0 })).key
    ).toBe("done");
    expect(
      workSessionStatus(session({ status: "ended", exitCode: 137 })).key
    ).toBe("failed");
  });

  it("reads an ended session with no exit code as a clean end", () => {
    expect(workSessionStatus(session({ status: "ended" })).key).toBe("done");
  });
});

describe("toolPhrase", () => {
  it("moves through present, past and failed for the same call", () => {
    expect(toolPhrase("edit_file", "running")).toBe("파일 고치는 중");
    expect(toolPhrase("edit_file", "done")).toBe("파일 고침");
    expect(toolPhrase("edit_file", "error")).toBe("파일 고치기 실패");
  });

  it("classifies by substring, whatever the harness calls the tool", () => {
    expect(toolPhrase("Read", "done")).toBe("파일 읽음");
    expect(toolPhrase("fs.read_text_file", "done")).toBe("파일 읽음");
    expect(toolPhrase("bash", "done")).toBe("명령 실행함");
    expect(toolPhrase("grep_search", "done")).toBe("검색함");
  });

  it("falls back rather than inventing a verb for an unknown tool", () => {
    expect(toolPhrase("mcp__notion__query", "done")).toBe("도구 실행함");
    expect(toolPhrase(undefined, "running")).toBe("도구 실행 중");
  });
});

describe("parseWorkSessionEvent", () => {
  it("accepts the projected shape and keeps the seq as the ordering key", () => {
    const parsed = parseWorkSessionEvent(
      reply("agent.status", { phase: "thinking", run_status: "running" })
    );
    expect(parsed?.type).toBe("agent.status");
    expect(parsed?.sessionId).toBe(SESSION_ID);
    expect(parsed?.seq).toBeGreaterThan(0);
  });

  it("ignores every other reply in the thread, excerpts included", () => {
    const excerpt: Message = {
      id: "msg-excerpt",
      channelId: CHANNEL_ID,
      rootId: ROOT_ID,
      seq: 99,
      hlcTs: 1,
      hlcCount: 0,
      authorMemberId: "00000000-0000-7000-8000-000000000101",
      type: "text",
      body: "세션 발췌",
      createdAtMs: 1,
    };
    expect(parseWorkSessionEvent(excerpt)).toBeNull();
  });

  it("rejects a props blob that names an unknown schema", () => {
    const wrong = reply("agent.status", { phase: "thinking" });
    wrong.props = { ...wrong.props, schema: "momo.something.else.v1" };
    expect(parseWorkSessionEvent(wrong)).toBeNull();
  });
});

describe("mergeEvents", () => {
  it("dedupes across REST and the rail with folded ids, ordered by seq", () => {
    const durable = events(
      reply("agent.status", { phase: "thinking", detail: "첫 줄" })
    );
    const frame: WorkSessionACPFrame = {
      type: "agent.status",
      v: 1,
      ts: 1_784_998_548_600,
      seq: durable[0].seq! + 1,
      payload: {
        work_session_id: SESSION_ID.toLowerCase(),
        run_id: SESSION_ID.toLowerCase(),
        channel_id: CHANNEL_ID,
        event_id: durable[0].eventId.toLowerCase(),
        message_id: "m",
        root_message_id: ROOT_ID,
        detail: "같은 이벤트",
      },
    };
    const merged = mergeEvents(durable, [eventFromFrame(frame)]);
    expect(merged).toHaveLength(1);
    // The durable row wins: it is the one with a seq for certain.
    expect(merged[0].payload.detail).toBe("첫 줄");
  });

  it("keeps a live-only event and sorts it after the durable page", () => {
    const durable = events(reply("agent.status", { detail: "먼저" }));
    const live = eventFromFrame({
      type: "agent.partial",
      v: 1,
      ts: 2,
      seq: durable[0].seq! + 5,
      payload: {
        work_session_id: SESSION_ID,
        run_id: SESSION_ID,
        channel_id: CHANNEL_ID,
        event_id: "LIVE-1",
        message_id: "m",
        root_message_id: ROOT_ID,
        text_delta: "나중",
      },
    });
    const merged = mergeEvents(durable, [live]);
    expect(merged.map((e) => e.eventId)).toEqual([durable[0].eventId, "LIVE-1"]);
  });
});

describe("eventsForSession", () => {
  it("matches ids case-insensitively", () => {
    const all = events(reply("agent.status", { detail: "x" }));
    expect(eventsForSession(all, SESSION_ID.toLowerCase())).toHaveLength(1);
  });
});

describe("foldSessionEvents", () => {
  it("renders the projected stream as past-tense rows, newest still running", () => {
    const folded = foldSessionEvents(
      events(
        reply("agent.status", {
          phase: "thinking",
          run_status: "running",
          detail: "레포지토리 구조를 확인하는 중",
          terminal_event: "created",
        }),
        reply("agent.status", {
          phase: "streaming",
          run_status: "running",
          detail: "WorkPanel.tsx 읽는 중",
          tool_call_name: "read_file",
        }),
        reply("agent.partial", { text_delta: "자리를 잡았습니다." }),
        reply("agent.status", {
          phase: "streaming",
          run_status: "running",
          detail: "패널 골격 작성",
          tool_call_name: "edit_file",
        })
      ),
      session()
    );
    expect(folded.rows.map((row) => [row.kind, row.state, row.headline])).toEqual([
      ["lifecycle", "done", "세션을 시작함"],
      ["tool", "done", "파일 읽음"],
      ["message", "done", "자리를 잡았습니다."],
      ["tool", "running", "파일 고치는 중"],
    ]);
  });

  it("never leaves a row running once the server stopped calling it running", () => {
    const stream = events(
      reply("agent.status", { tool_call_name: "edit_file", detail: "쓰는 중" })
    );
    expect(foldSessionEvents(stream, session()).rows[0].state).toBe("running");
    expect(
      foldSessionEvents(stream, session({ status: "ended" })).rows[0].state
    ).toBe("done");
    expect(
      foldSessionEvents(stream, session({ status: "orphaned" })).rows[0].state
    ).toBe("done");
  });

  it("parks the interrupted call on the undecided approval", () => {
    const folded = foldSessionEvents(
      events(
        reply("agent.status", { tool_call_name: "shell", detail: "빌드 캐시 정리" }),
        reply("approval.requested", {
          action: "requested",
          action_type: "tool_call",
          status: "pending",
          options: [{ option_id: "allow-once", name: "이번만 허용", kind: "allow_once" }],
        })
      ),
      session()
    );
    expect(folded.rows.map((row) => [row.state, row.headline])).toEqual([
      ["pending", "명령 실행 중"],
      ["pending", "승인을 요청함"],
    ]);
  });

  it("turns a rejection into the failed branch of the same call", () => {
    const folded = foldSessionEvents(
      events(
        reply("agent.status", { tool_call_name: "edit_file", detail: "고치는 중" }),
        reply("approval.requested", {
          action: "requested",
          status: "pending",
          options: [{ option_id: "reject", name: "거부", kind: "reject_once" }],
        }),
        reply("approval.decided", {
          action: "decided",
          status: "rejected",
          option_id: "reject",
        })
      ),
      session()
    );
    expect(folded.rows.map((row) => [row.state, row.headline])).toEqual([
      ["error", "파일 고치기 실패"],
      ["error", "승인 거부됨"],
    ]);
  });

  it("resumes the call when the approval is granted", () => {
    const folded = foldSessionEvents(
      events(
        reply("agent.status", { tool_call_name: "shell", detail: "정리" }),
        reply("approval.requested", { action: "requested", status: "pending" }),
        reply("approval.decided", { action: "decided", status: "approved" })
      ),
      session()
    );
    expect(folded.rows.map((row) => [row.state, row.headline])).toEqual([
      ["running", "명령 실행 중"],
      ["done", "승인받음"],
    ]);
  });

  it("keeps the newest plan and nothing older", () => {
    const folded = foldSessionEvents(
      events(
        reply("agent.status", {
          has_plan: true,
          plan: [{ content: "먼저", status: "in_progress" }],
        }),
        reply("agent.status", {
          has_plan: true,
          plan: [
            { content: "먼저", status: "completed" },
            { content: "다음", status: "in_progress" },
          ],
        })
      ),
      session()
    );
    expect(folded.plan).toEqual([
      { content: "먼저", status: "completed" },
      { content: "다음", status: "in_progress" },
    ]);
  });

  it("does not blame the last step for the session's exit code", () => {
    const folded = foldSessionEvents(
      events(reply("agent.status", { tool_call_name: "shell", detail: "빌드" })),
      session({ status: "ended", exitCode: 1 })
    );
    expect(folded.rows[0].state).toBe("done");
    expect(workSessionStatus(session({ status: "ended", exitCode: 1 })).key).toBe(
      "failed"
    );
  });
});

describe("isSlowStep", () => {
  it("changes tone only for a running session past ten seconds", () => {
    const at = 1_000_000;
    expect(isSlowStep(session(), at, at + SLOW_STEP_MS + 1)).toBe(true);
    expect(isSlowStep(session(), at, at + SLOW_STEP_MS - 1)).toBe(false);
    expect(isSlowStep(session({ status: "ended" }), at, at + 60_000)).toBe(false);
  });

  it("says nothing when it has not listened", () => {
    expect(isSlowStep(session(), null, Date.now())).toBe(false);
  });
});

describe("workHostTrust", () => {
  const host = (overrides: Partial<WorkHost> = {}): WorkHost => ({
    id: HOST_ID,
    workspaceId: "00000000-0000-7000-8000-000000000001",
    scope: "member",
    ownerMemberId: "00000000-0000-7000-8000-000000000101",
    type: "app",
    displayName: "성재 MacBook Pro",
    capabilities: { terminal: true },
    createdAtMs: 0,
    online: true,
    ...overrides,
  });

  it("trusts the local app host and fails closed on everything else", () => {
    expect(workHostTrust(session(), [host()])).toBe("local");
    expect(workHostTrust(session(), [host({ type: "workd" })])).toBe("remote");
    expect(workHostTrust(session(), [])).toBe("unknown");
    expect(workHostTrust(session(), undefined)).toBe("unknown");
  });

  it("matches the host id case-insensitively", () => {
    expect(workHostTrust(session(), [host({ id: HOST_ID.toLowerCase() })])).toBe(
      "local"
    );
  });
});

describe("list surfaces", () => {
  it("puts running sessions first, then newest", () => {
    const ordered = sortSessions([
      session({ id: "a", status: "ended", startedAtMs: 300 }),
      session({ id: "b", status: "running", startedAtMs: 100 }),
      session({ id: "c", status: "orphaned", startedAtMs: 200 }),
    ]);
    expect(ordered.map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("scopes to the open channel case-insensitively, or shows everything", () => {
    const rows = [
      session({ id: "a" }),
      session({ id: "b", channelId: "00000000-0000-7000-8000-000000000201" }),
    ];
    expect(scopeSessions(rows, "channel", CHANNEL_ID.toUpperCase())).toHaveLength(1);
    expect(scopeSessions(rows, "all", CHANNEL_ID)).toHaveLength(2);
    expect(scopeSessions(rows, "channel", null)).toHaveLength(2);
  });

  it("summarises with the newest meaningful line", () => {
    const folded = foldSessionEvents(
      events(
        reply("agent.status", { terminal_event: "created" }),
        reply("agent.status", { tool_call_name: "read_file", detail: "api.ts" })
      ),
      session()
    );
    expect(lastLine(folded.rows)).toBe("파일 읽는 중 api.ts");
    expect(lastLine([])).toBeNull();
    expect(peekRows(folded.rows, 1)).toHaveLength(1);
  });

  it("watches the open channel first and reports what the cap left out", () => {
    const running = Array.from({ length: 10 }, (_, i) =>
      session({ id: `s${i}`, channelId: `0000000${i}-0000-7000-8000-00000000020${i}` })
    );
    const { watched, uncovered } = workChannelsToWatch(running, CHANNEL_ID, 3);
    expect(watched[0]).toBe(CHANNEL_ID);
    expect(watched).toHaveLength(3);
    expect(uncovered.length).toBeGreaterThan(0);
  });
});

describe("composeExcerpt", () => {
  it("starts from the label and the rendered lines, editable before it is sent", () => {
    const folded = foldSessionEvents(
      events(
        reply("agent.status", { tool_call_name: "read_file", detail: "api.ts" }),
        reply("agent.partial", { text_delta: "읽었습니다." })
      ),
      session({ status: "ended" })
    );
    expect(composeExcerpt(session(), folded.rows)).toBe(
      [
        "세션 발췌: clients/web 관전 패널 왕복 확인",
        "",
        "파일 읽음: api.ts",
        "읽었습니다.",
      ].join("\n")
    );
  });
});
