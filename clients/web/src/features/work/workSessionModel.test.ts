import { describe, expect, it } from "vitest";
import type { Message, WorkHost, WorkSession } from "@/lib/api";
import {
  asWorkSessionToolTransitionFrame,
  type WorkSessionACPFrame,
} from "@/lib/realtime";
import {
  canReattachWorkSession,
  composeExcerpt,
  emptyStepsDetail,
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
  workHostOnline,
  workHostTrust,
  workSessionContinuityStatus,
  workSessionIdleNotice,
  workSessionResumeTargets,
  workSessionStatus,
  type WorkSessionEvent,
} from "./workSessionModel";
import { silenceLabel } from "./workSessionFormat";

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
  it("keeps idle neutral and does not treat the last tool result as an ending", () => {
    expect(workSessionStatus(session()).key).toBe("running");
    expect(workSessionStatus(session({ status: "idle", exitCode: 0 }))).toEqual({
      key: "idle",
      label: "완료 · 대기 중",
    });
    expect(workSessionStatus(session({ status: "orphaned" })).key).toBe("orphaned");
    expect(
      workSessionStatus(session({ status: "ended", exitCode: 0 })).key
    ).toBe("done");
    expect(
      workSessionStatus(session({ status: "ended", exitCode: 137 })).key
    ).toBe("done");
  });

  it("reads an ended session with no exit code as a clean end", () => {
    expect(workSessionStatus(session({ status: "ended" })).key).toBe("done");
  });

  it("renders an unknown future status neutrally", () => {
    expect(workSessionStatus({ status: "future", exitCode: undefined })).toEqual({
      key: "unknown",
      label: "상태 확인 필요",
    });
  });
});

describe("work-session idle wire", () => {
  const transition = {
    type: "work.session.idle",
    v: 1,
    ts: 1_785_163_200_000,
    seq: 41,
    payload: {
      session_id: SESSION_ID,
      channel_id: CHANNEL_ID.toUpperCase(),
      root_message_id: ROOT_ID,
      member_id: "00000000-0000-7000-8000-000000000101",
      host_id: HOST_ID,
      status: "idle",
      exit_code: 0,
      idle_at: 1_785_163_200_000,
    },
  } as const;

  it("accepts uppercase Swift UUIDs without rewriting identity", () => {
    const parsed = asWorkSessionToolTransitionFrame(transition);
    expect(parsed?.payload.session_id).toBe(SESSION_ID);
    expect(parsed?.payload.status).toBe("idle");
    expect(
      asWorkSessionToolTransitionFrame({
        ...transition,
        payload: { ...transition.payload, exit_code: undefined },
      })
    ).not.toBeNull();
  });

  it("drops every type inversion and mismatched transition state", () => {
    expect(
      asWorkSessionToolTransitionFrame({
        ...transition,
        payload: { ...transition.payload, idle_at: "now" },
      })
    ).toBeNull();
    expect(
      asWorkSessionToolTransitionFrame({
        ...transition,
        payload: { ...transition.payload, exit_code: "0" },
      })
    ).toBeNull();
    expect(
      asWorkSessionToolTransitionFrame({
        ...transition,
        payload: { ...transition.payload, status: "running" },
      })
    ).toBeNull();
    expect(
      asWorkSessionToolTransitionFrame({
        ...transition,
        type: "work.session.resumed-to-running",
        payload: {
          ...transition.payload,
          status: "running",
          idle_at: undefined,
          resumed_at: 1_785_163_201_000,
        },
      })
    ).not.toBeNull();
  });

  it("recognises only the typed durable idle reply", () => {
    const message: Message = {
      id: "00000000-0000-7000-8000-000000000901",
      channelId: CHANNEL_ID,
      rootId: ROOT_ID,
      seq: 41,
      hlcTs: transition.ts,
      hlcCount: 0,
      authorMemberId: transition.payload.member_id,
      type: "system",
      body: "작업 완료",
      createdAtMs: transition.ts,
      props: {
        kind: "work_session_idle",
        session_id: SESSION_ID,
        owner_member_id: transition.payload.member_id,
      },
    };
    expect(workSessionIdleNotice(message)).toMatchObject({
      sessionId: SESSION_ID,
      eventLabel: "대기 전환",
    });
    expect(workSessionIdleNotice({ ...message, rootId: undefined })).toBeNull();
    expect(
      workSessionIdleNotice({
        ...message,
        props: { ...message.props, session_id: 7 },
      })
    ).toBeNull();
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

  // The projection carries ONE slice per agent.partial (`text_delta`, no
  // cumulative field) and a host emits one per transcript chunk, up to 200 for
  // a single answer. These are the shapes momowebqa relayed for one sentence.
  it("folds a run of deltas into one message row, clocked at the first", () => {
    const folded = foldSessionEvents(
      events(
        reply("agent.status", { terminal_event: "created" }, 1_784_998_548_500),
        reply("agent.partial", { text_delta: "워커 로그를 읽었습니" }, 1_784_998_549_000),
        reply("agent.partial", { text_delta: "다. 재시작 루프가 1" }, 1_784_998_549_200),
        reply("agent.partial", { text_delta: "건 있었고," }, 1_784_998_549_400)
      ),
      session({ status: "ended" })
    );
    expect(folded.rows.map((row) => [row.kind, row.headline])).toEqual([
      ["lifecycle", "세션을 시작함"],
      ["message", "워커 로그를 읽었습니다. 재시작 루프가 1건 있었고,"],
    ]);
    expect(folded.rows[1].atMs).toBe(1_784_998_549_000);
  });

  it("marks an open stream running and closes it on the next typed event", () => {
    const open = foldSessionEvents(
      events(
        reply("agent.partial", { text_delta: "확인해 보겠습니다" }),
        reply("agent.partial", { text_delta: ". 잠시만요." })
      ),
      session()
    );
    expect(open.rows).toHaveLength(1);
    expect(open.rows[0].state).toBe("running");

    const closed = foldSessionEvents(
      events(
        reply("agent.partial", { text_delta: "확인해 보겠습니다" }),
        reply("agent.status", { tool_call_name: "read_file", detail: "api.ts" }),
        reply("agent.partial", { text_delta: "다시 시작합니다" })
      ),
      session()
    );
    expect(closed.rows.map((row) => [row.kind, row.state])).toEqual([
      ["message", "done"],
      ["tool", "done"],
      ["message", "running"],
    ]);
  });

  it("drops an agent.status that carries nothing a row could say", () => {
    const folded = foldSessionEvents(
      events(
        reply("agent.status", {
          phase: "thinking",
          run_status: "running",
          has_plan: true,
          plan: [{ content: "관전 패널 반려 정리", status: "in_progress" }],
        }),
        reply("agent.status", { phase: "thinking", run_status: "running" })
      ),
      session()
    );
    expect(folded.rows).toEqual([]);
    expect(folded.plan).toEqual([
      { content: "관전 패널 반려 정리", status: "in_progress" },
    ]);
  });

  it("promotes nothing to 진행 중 when the newest rows were not fetched", () => {
    const stream = events(
      reply("agent.status", { tool_call_name: "shell", detail: "빌드" }),
      reply("agent.partial", { text_delta: "빌드를 걸었습니다" })
    );
    expect(
      foldSessionEvents(stream, session()).rows.map((row) => row.state)
    ).toEqual(["done", "running"]);
    // `truncated`: the thread was longer than the panel read, so the last row
    // held is the last row FETCHED and may be a thousand events old.
    expect(
      foldSessionEvents(stream, session(), true).rows.map((row) => row.state)
    ).toEqual(["done", "done"]);
  });

  it("keeps the last tool result out of both step and session failure states", () => {
    const folded = foldSessionEvents(
      events(reply("agent.status", { tool_call_name: "shell", detail: "빌드" })),
      session({ status: "ended", exitCode: 1 })
    );
    expect(folded.rows[0].state).toBe("done");
    expect(workSessionStatus(session({ status: "ended", exitCode: 1 })).key).toBe(
      "done"
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

  // The heartbeat is a different channel from the relay, and that is measured
  // rather than assumed: momowebqa answers online:false / lastSeenAtMs:null for
  // every host, including the one that had just relayed 15 agent.partial events
  // into the session on screen. Folding it into trust would paint a visibly
  // streaming session as unverified.
  it("keeps the heartbeat out of the relay judgement", () => {
    expect(workHostTrust(session(), [host({ online: false })])).toBe("local");
    expect(workHostOnline(session(), [host({ online: false })])).toBe(false);
    expect(workHostOnline(session(), [host()])).toBe(true);
    expect(workHostOnline(session(), [])).toBeNull();
    expect(workHostOnline(session(), undefined)).toBeNull();
  });

  it("does not present a running session on an offline host as active", () => {
    expect(
      workSessionContinuityStatus(session(), [host({ online: false })])
    ).toEqual({ key: "unavailable", label: "호스트 응답 없음" });
    expect(workSessionContinuityStatus(session(), [host()]).key).toBe("running");
    expect(
      workSessionContinuityStatus(
        session({ status: "idle" }),
        [host({ online: false })]
      ).key
    ).toBe("unavailable");
    expect(canReattachWorkSession(session({ status: "idle" }), [host()])).toBe(
      true
    );
    expect(
      canReattachWorkSession(
        session({ status: "orphaned" }),
        [host()]
      )
    ).toBe(false);
  });

  it("offers only eligible online hosts for an orphaned lineage resume", () => {
    const viewer = "00000000-0000-7000-8000-000000000101";
    const source = session({ status: "orphaned" });
    const candidates = [
      host({ id: HOST_ID, displayName: "죽은 원본", online: true }),
      host({
        id: "00000000-0000-7000-8000-000000000201",
        displayName: "나의 온라인 호스트",
      }),
      host({
        id: "00000000-0000-7000-8000-000000000202",
        ownerMemberId: "00000000-0000-7000-8000-000000000999",
        displayName: "다른 멤버 호스트",
      }),
      host({
        id: "00000000-0000-7000-8000-000000000203",
        ownerMemberId: "00000000-0000-7000-8000-000000000999",
        scope: "workspace",
        displayName: "공용 온라인 호스트",
      }),
      host({
        id: "00000000-0000-7000-8000-000000000204",
        displayName: "폐기된 호스트",
        revokedAtMs: 1,
      }),
    ];
    expect(
      workSessionResumeTargets(source, candidates, viewer).map((item) => item.id)
    ).toEqual([
      "00000000-0000-7000-8000-000000000203",
      "00000000-0000-7000-8000-000000000201",
    ]);
    expect(
      workSessionResumeTargets(session({ status: "idle" }), candidates, viewer)
    ).toEqual([]);
  });

  it("drops the promise of coming steps when nobody has heard the host", () => {
    const promise = "에이전트가 첫 단계를 보고하면 여기에 한 줄씩 쌓입니다.";
    expect(emptyStepsDetail(session(), [host()])).toBe(promise);
    // A finished session is history: the host's heartbeat now says nothing
    // about the steps it already did or did not deliver.
    expect(
      emptyStepsDetail(session({ status: "ended" }), [host({ online: false })])
    ).toBe(promise);
    // No answer from the registry is not evidence either way.
    expect(emptyStepsDetail(session(), undefined)).toBe(promise);
    expect(emptyStepsDetail(session(), [host({ online: false })])).toBe(
      "이 호스트에서 최근 신호를 받은 기록이 없습니다. 새 단계가 도착하지 않을 수 있습니다."
    );
  });
});

describe("list surfaces", () => {
  it("puts running, idle and orphaned sessions ahead of ended ones", () => {
    const ordered = sortSessions([
      session({ id: "a", status: "ended", startedAtMs: 300 }),
      session({ id: "b", status: "running", startedAtMs: 100 }),
      session({ id: "c", status: "orphaned", startedAtMs: 200 }),
      session({ id: "d", status: "idle", startedAtMs: 50 }),
    ]);
    expect(ordered.map((s) => s.id)).toEqual(["b", "d", "c", "a"]);
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

  it("shows only the viewer's non-ended sessions in the mine scope", () => {
    const mine = session();
    const other = session({
      id: "other-running",
      memberId: "00000000-0000-7000-8000-000000000999",
    });
    const ended = session({ id: "mine-ended", status: "ended" });
    expect(
      scopeSessions(
        [mine, other, ended],
        "mine",
        CHANNEL_ID,
        mine.memberId.toUpperCase()
      ).map((row) => row.id)
    ).toEqual([SESSION_ID]);
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

  it("flattens a streamed answer into the one line a row can hold", () => {
    const folded = foldSessionEvents(
      events(
        reply("agent.partial", { text_delta: "정리했습니다.\n\n" }),
        reply("agent.partial", { text_delta: "  다음은 게이트입니다." })
      ),
      session({ status: "ended" })
    );
    expect(lastLine(folded.rows)).toBe("정리했습니다. 다음은 게이트입니다.");
  });

  it("states the measured silence, never the threshold that triggered it", () => {
    const at = 1_784_998_548_000;
    expect(silenceLabel(at, at + 12_000)).toBe("12초");
    expect(silenceLabel(at, at + 300_000)).toBe("5분 0초");
    expect(silenceLabel(at, at + 3_840_000)).toBe("1시간 4분");
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

  it("keeps idle channels subscribed for resumed-to-running frames", () => {
    const idleChannel = "00000000-0000-7000-8000-000000000299";
    const result = workChannelsToWatch(
      [session({ status: "idle", channelId: idleChannel })],
      null
    );
    expect(result.watched).toEqual([idleChannel]);
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

  // Sharing writes into the channel thread, permanently. Before the deltas were
  // folded, this wrote the agent's answer chopped at whatever byte the
  // transport happened to cut, one fragment per line, into the ledger.
  it("shares the whole answer, not the slices it arrived in", () => {
    const folded = foldSessionEvents(
      events(
        reply("agent.partial", { text_delta: "재시작 루프는 outbox_dr" }),
        reply("agent.partial", { text_delta: "ain 타임아웃이었습니다." })
      ),
      session({ status: "ended" })
    );
    expect(composeExcerpt(session(), folded.rows)).toBe(
      [
        "세션 발췌: clients/web 관전 패널 왕복 확인",
        "",
        "재시작 루프는 outbox_drain 타임아웃이었습니다.",
      ].join("\n")
    );
  });
});
