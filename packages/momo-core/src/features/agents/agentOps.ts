import {
  ApiError,
  uuidEq,
  type AgentProfile,
  type RosterMember,
  type WorkHost,
  type WorkSession,
} from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { attachParticle } from "../../lib/koreanParticle";
import { serverSurface } from "../capabilities/serverSurfaces";
import { lifecycleLabel } from "./hubModel";

// =============================================================================
// 에이전트를 부린다 — the judgements behind the phone's 「에이전트」 surface
// (goal RN-A1, 진단 2026-08-03 A안).
//
// Everything here is measured against `server-rust` rather than assumed, because
// this surface's whole job is to answer two questions a person asks OUT LOUD
// and cannot check themselves:
//
//   "김인턴 지금 자고 있나?"        -> `agentStateLabel`
//   "지금 이 세션, 폰 꺼도 되나?"   -> `hostTier`
//
// Both answers are refusals as often as they are facts, and the refusals are
// the point. A roster row cannot prove pause state and a work session cannot
// prove its host's tier, so this module names what is unknown instead of
// picking the reassuring branch.
// =============================================================================

// ---- 상태 한 줄 --------------------------------------------------------------

/**
 * What this client managed to learn about one agent's profile.
 *
 * `forbidden` is its own arm and not a flavour of `failed`, and that distinction
 * is forced by the server rather than chosen here: `GET …/agents/{id}/profile`
 * is gated on workspace owner/admin OR the agent's own `owner_human_id`
 * (server-rust `routes/agents.rs` `require_profile_editor_in_tx`, 403 "agent
 * owner or workspace admin required"). An ordinary member therefore gets a 403
 * for an agent that is working perfectly. Drawing that as "상태 확인 실패" tells
 * them something is broken and invites a retry that can only fail again.
 */
export type AgentProfileRead =
  | { kind: "pending" }
  | { kind: "ready"; profile: AgentProfile }
  | { kind: "forbidden" }
  | { kind: "failed" }
  /**
   * This surface never asked (goal RN-C1).
   *
   * The 에이전트 목록 stopped reading one profile per agent the day the roster
   * started carrying `paused` (goal SRV-R2): a request per row, gated so that an
   * ordinary member collected one 403 per agent, to draw one column that was
   * already in a list we had.
   *
   * It is NOT `pending`: nothing is in flight and nothing will arrive, so
   * "상태 확인 중" would be a spinner for a request nobody made. Against a server
   * whose roster carries `paused` this arm is never consulted — `lifecycleLabel`
   * answers from the roster first. Against an older one it is what makes a row
   * say 상태를 볼 수 없음 instead of quietly reporting every agent awake.
   */
  | { kind: "unread" };

/** What a list surface passes: it read the roster and asked for nothing else. */
export const PROFILE_UNREAD: AgentProfileRead = { kind: "unread" };

/**
 * Is this agent asleep, according to the ROSTER (goal SRV-R2)?
 *
 * Three answers, not two. `null` means the list did not carry the fact — a human
 * (who has no such state) or a server that predates the projection — and reading
 * it as `false` is exactly the leak the server side wrote a red proof against.
 */
export function rosterPaused(agent: RosterMember): boolean | null {
  return agent.kind === "agent" && agent.paused !== undefined
    ? agent.paused
    : null;
}

/** Classify a profile read failure into the arms above. */
export function agentProfileRead(
  profile: AgentProfile | undefined,
  isPending: boolean,
  error: unknown
): AgentProfileRead {
  if (profile !== undefined) return { kind: "ready", profile };
  if (isPending) return { kind: "pending" };
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return { kind: "forbidden" };
  }
  return { kind: "failed" };
}

/**
 * 상태 한 단어, for a list row.
 *
 * The four words this shares with the desktop hub are NOT re-spelled here: it
 * delegates to `lifecycleLabel`, which is the same function `clients/web`'s
 * 에이전트 허브 renders. Two clients calling the same agent 활성 and 사용 가능
 * would be a defect, and the only way to be sure is to have one function.
 *
 * The one word it adds is the one `lifecycleLabel` has no arm for, because the
 * desktop hub is only ever opened by someone who may read the profile.
 *
 * `unread` lands in that same arm and for the same reason: a surface that never
 * asked knows exactly as much as a surface that was refused. Both are only
 * reached when the roster itself is silent — when it carries `paused`,
 * `lifecycleLabel` answers before either one is consulted.
 */
export function agentStateLabel(
  agent: RosterMember,
  read: AgentProfileRead
): string {
  if (agent.status !== "active") return lifecycleLabel(agent, null, false, false);
  if (agent.paused !== undefined) return lifecycleLabel(agent, null, false, false);
  if (read.kind === "forbidden" || read.kind === "unread") {
    return "상태를 볼 수 없음";
  }
  return lifecycleLabel(
    agent,
    read.kind === "ready" ? read.profile : null,
    read.kind === "pending",
    read.kind === "failed"
  );
}

/** Is this agent asleep right now, or is that not yet known? */
export function isAgentPaused(read: AgentProfileRead): boolean | null {
  return read.kind === "ready" ? read.profile.paused : null;
}

// ---- 재우기 / 깨우기 ---------------------------------------------------------

/**
 * What pausing actually does, as a sentence.
 *
 * **Read this before changing the wording.** It is not a paraphrase of the
 * button; it is the measured behaviour of `PUT …/agents/{agent}/pause` on
 * `server-rust`, and every clause below has a line number behind it:
 *
 *   - The write touches ONE column in ONE table (`agent_profile.paused`,
 *     `crates/momo-agent/src/provisioning.rs` `set_agent_paused_in_tx`). It
 *     emits no outbox row, cancels nothing and notifies no host.
 *   - It is consulted in exactly three creation paths: `POST …/channels/{ch}/
 *     agent-runs` answers 409 "agent is paused" (`routes/agent_runs.rs`), an
 *     @mention creates no run and posts a system line instead
 *     (`routes/agent_mentions.rs` -> `paused_mention_body`), and the agent→agent
 *     path does the same (`momo-agent-worker/src/a2a.rs`).
 *   - The BYOA gateway routes (`routes/agent_gateway.rs`: pending-jobs, lease
 *     renew/release, run events, complete) never read the column, so a job
 *     already claimed keeps running to completion.
 *   - `routes/work_sessions.rs` never reads it either: a work session is not
 *     touched by pausing its agent.
 *
 * That is why the second sentence exists. A person who reads "일시정지" and
 * assumes the running job dies has been misled by us, not by the server, and
 * "되돌릴 수 없는 인상을 주지 마라" cuts both ways: this is reversible, and it
 * is also weaker than it sounds.
 *
 * ## 세 번째 문장이 바뀐 이유 (goal RN-C1)
 *
 * 이 상수는 「이미 실행 중인 작업은 그대로 끝까지 갑니다」로 끝나고 있었다. 그때는
 * 참이었다 — 이 서버에는 실행을 멈출 라우트 자체가 없었고, 그래서 그 문장은 "재우기가
 * 약한 도구"라는 뜻이자 동시에 **"멈출 방법이 없다"**는 뜻이었다.
 *
 * goal SRV-C2가 `POST …/agent-runs/{run}/cancel`을 이식하면서 두 번째 뜻이 거짓이
 * 됐다. 첫 번째 뜻은 여전히 참이다: 재우기는 지금도 컬럼 하나만 쓰고 도는 실행에
 * 손대지 않는다. 그래서 문장을 지우지 않고 **정확히 그 절반만** 고친다 — 재우기가
 * 무엇을 하지 않는지는 그대로 말하고, 그 다음에 무엇을 할 수 있는지를 덧붙인다.
 * 재우기를 취소로 재포장하는 것은 반대 방향의 같은 거짓말이다.
 *
 * 두 사실은 마침표로 나뉜다. 처음에는 줄표(em-dash)로 이었는데, 그것은 두 절을 하나의
 * 대립쌍으로 묶어 읽히게 만든다 — 여기서 필요한 것은 대립이 아니라 **순서**다: 재우기가
 * 닿지 않는다는 사실이 먼저 있고, 그 다음에 닿는 방법이 있다.
 */
export const PAUSE_EFFECT_NOTICE =
  "재우면 새 실행이 시작되지 않습니다. 멘션해도 답하지 않고 그 사실을 채널에 알립니다. 이미 실행 중인 작업은 재우기로 멈추지 않습니다. 그 실행은 대화에서 따로 중단할 수 있습니다.";

/** 깨우면 무엇이 돌아오는가. The exact inverse of the three gates above. */
export const RESUME_EFFECT_NOTICE =
  "깨우면 멘션과 새 실행을 다시 받습니다.";

export function pauseEffectNotice(paused: boolean): string {
  return paused ? RESUME_EFFECT_NOTICE : PAUSE_EFFECT_NOTICE;
}

/** The button, in both directions and in both states. */
export function pauseActionLabel(paused: boolean, busy: boolean): string {
  if (paused) return busy ? "깨우는 중…" : "깨우기";
  return busy ? "재우는 중…" : "재우기";
}

/**
 * Why the switch did not move, as a sentence the reader can act on.
 *
 * Same grammar as `placementFailure` one file over: name the act that failed,
 * then the one thing about this server that explains it. No status code reaches
 * the screen — that rule predates this batch and the phone inherits it rather
 * than re-deciding it.
 *
 * The 403 branch carries the weight. Pause is owner/admin-only on the server, so
 * the most common refusal an ordinary member meets is a permission and not a
 * fault, and "다시 시도하세요" would send them into a loop that cannot end.
 */
export function pauseFailureCopy(paused: boolean, error: unknown): string {
  // `paused` is the state being MOVED TO, so the verb is the act attempted.
  const verb = paused ? "재우지" : "깨우지";
  if (error instanceof NetworkError) return `${verb} 못했습니다. ${error.message}`;
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return `${verb} 못했습니다. 에이전트를 재우고 깨우는 것은 워크스페이스 관리자나 그 에이전트를 맡은 사람만 할 수 있습니다.`;
    }
    if (error.status === 404 || error.status === 405) {
      return `${verb} 못했습니다. 이 서버가 에이전트 상태 변경을 아직 받지 않거나, 그 에이전트가 사라졌습니다.`;
    }
    if (error.status === 429) {
      return `${verb} 못했습니다. 요청이 너무 잦습니다. 잠시 뒤에 다시 시도하세요.`;
    }
    if (error.status >= 500) {
      return `${verb} 못했습니다. 서버가 오류로 답했습니다.`;
    }
  }
  return `${verb} 못했습니다. 잠시 뒤에 다시 시도하세요.`;
}

/** The receipt. Named, because "저장됨" says nothing about what changed. */
export function pauseReceipt(agentName: string, paused: boolean): string {
  const subject = attachParticle(agentName, "object");
  return paused
    ? `${subject} 재웠습니다. ${PAUSE_EFFECT_NOTICE}`
    : `${subject} 깨웠습니다. ${RESUME_EFFECT_NOTICE}`;
}

// ---- 모델 -------------------------------------------------------------------

/**
 * The models this agent may actually be given, as a list to show.
 *
 * `null` from `fetchAgentAllowedModels` means the server did not send a usable
 * list, and that is NOT the same as "no models": the core's own decoder returns
 * null for an empty, blank or duplicated array precisely so a caller cannot
 * render an empty select as a fact. The phone does not offer a picker in this
 * batch, so what it owes is the honest reading of that null.
 */
export function allowedModelsSummary(models: readonly string[] | null): string {
  if (models === null) return "이 서버가 고를 수 있는 모델 목록을 주지 않았습니다.";
  return models.join(", ");
}

// ---- 호스트 등급: "지금 이거 꺼도 되나" ---------------------------------------

/**
 * ADR-0125 D1's registry `type`, which ADR-0137 D5 makes mandatory on a session
 * row. `unknown` is a real answer and the most common one on a phone: the host
 * list is a second request and it can be refused (it is `require_human` plus
 * active membership on `server-rust`).
 */
export type HostTierKey = "app" | "workd" | "cloud" | "unknown";

export interface HostTier {
  key: HostTierKey;
  /** The tier, in the words a person uses. */
  label: string;
}

/** ADR-0137 D5's three grades, named. `app`(맥)은 기기를 끄면 죽는다. */
const TIER_LABELS: Record<Exclude<HostTierKey, "unknown">, string> = {
  app: "데스크톱 앱",
  workd: "상시 서버",
  cloud: "클라우드",
};

/**
 * Which tier a session is running on.
 *
 * The join is client-side and unavoidable: `GET …/work-sessions` carries only
 * `hostId`, and the registry `type` lives on `GET …/work-hosts`. Measured on
 * `server-rust` 2026-08-03 — `WorkSessionDto` has no host type field of any
 * name, and `WorkHostDto` serialises the column as `type` with the closed set
 * `app | workd | cloud` (`routes/work_hosts.rs` `validated_type`).
 *
 * `hosts === undefined` (not yet read, or refused) and a host id the registry
 * does not name both answer `unknown`, and they say the same thing on screen,
 * because for the reader they are one situation: nobody can tell them whether
 * turning something off will kill this.
 */
export function hostTier(
  session: Pick<WorkSession, "hostId">,
  hosts: readonly WorkHost[] | undefined
): HostTier {
  const host = hosts?.find((candidate) => uuidEq(candidate.id, session.hostId));
  const type = host?.type;
  if (type === "app" || type === "workd" || type === "cloud") {
    return { key: type, label: TIER_LABELS[type] };
  }
  // A type the registry grew after this client shipped lands here too, and that
  // is the right side to fail on: a new tier we cannot name is exactly as
  // unanswerable as a host we never found.
  return { key: "unknown", label: "호스트 확인 안 됨" };
}

/**
 * The answer to "지금 이거 꺼도 되나", for ONE session.
 *
 * ## Why the tier alone cannot answer it (R1 High-1)
 *
 * The first version of this surface printed the tier's sentence on every row,
 * whatever the ledger said the session was. So a session that had ENDED an hour
 * ago carried "그 컴퓨터를 끄거나 앱을 닫으면 이 작업도 멈춥니다" in warning
 * orange, and an ended cloud session promised "폰을 꺼도 계속됩니다" about work
 * that was already over. One card contradicting itself is how a badge stops
 * being an answer and becomes a label people learn to ignore — and this badge is
 * the one D5 made mandatory.
 *
 * The tier is a fact about the HOST. Whether anything is at stake is a fact
 * about the SESSION. Both are needed, so both are read.
 *
 * ## The arms, and what each one is grounded in
 *
 *   running   the host is executing it. This is the D5 sentence proper.
 *   idle      the run finished but the host still HOLDS the session and its PTY
 *             (`WorkSessionStatusWire`: "idle still belongs to the live host and
 *             keeps its PTY attached. It is not an ended session"). So there is
 *             still something to lose, but it is the session, not a running job.
 *   ended     the question does not apply, and saying so IS the answer. Going
 *             silent here would be its own small dishonesty: the reader came to
 *             this row with a question and would leave without one.
 *   orphaned  the host is already gone; the loss has happened. What is useful
 *             now is where it can be picked up (`resumeWorkSession` needs an
 *             explicitly chosen host, which this client does not offer).
 *
 * A tier we could not resolve refuses to answer for a live session — never the
 * reassuring branch — but an ENDED session is answerable without the registry,
 * because nothing is at stake regardless of where it ran.
 *
 * `atRisk` is what earns a warning colour, and only the app-tier live arms set
 * it. Colour is never the only signal: the sentence says it too.
 */
export interface SessionSurvival {
  tier: HostTier;
  /** One sentence. Always true, always about this session's actual state. */
  sentence: string;
  /** Is something lost by turning that machine off right now? */
  atRisk: boolean;
}

export function sessionSurvival(
  session: Pick<WorkSession, "hostId"> & { status: string },
  hosts: readonly WorkHost[] | undefined
): SessionSurvival {
  const tier = hostTier(session, hosts);

  if (session.status === "ended") {
    return {
      tier,
      sentence: "끝난 작업입니다. 지금 무엇을 꺼도 이 작업에는 영향이 없습니다.",
      atRisk: false,
    };
  }
  if (session.status === "orphaned") {
    return {
      tier,
      sentence:
        // 「이어받기」가 아니라 「인수」다 (ADR-0154 D3). 이 문장은 폰이 읽지만
        // 가리키는 곳은 데스크톱이고, 거기 서 있는 버튼의 이름이 인수다. 화면마다
        // 다른 낱말로 같은 act 를 부르던 것이 이 티켓의 원인이라, 소비 표면이
        // 어디든 낱말은 하나여야 한다. 뜻은 그대로다.
        "호스트와 연결이 끊겼습니다. 인수는 데스크톱에서 할 수 있습니다.",
      atRisk: false,
    };
  }

  const live = session.status === "running";
  const held = session.status === "idle";
  if (!live && !held) {
    // A fifth state the ledger grew. `workSessionStatus` already answers
    // "상태 확인 필요" for it, and a survival claim built on a state we cannot
    // name would be exactly the guess this function exists to refuse.
    return {
      tier,
      sentence: "이 작업의 상태를 확인하지 못해, 무엇을 꺼도 되는지 말할 수 없습니다.",
      atRisk: false,
    };
  }

  if (tier.key === "unknown") {
    return {
      tier,
      sentence:
        "이 작업이 어디서 도는지 확인하지 못했습니다. 무엇을 꺼도 되는지 말할 수 없습니다.",
      atRisk: false,
    };
  }
  if (tier.key === "app") {
    return {
      tier,
      sentence: live
        ? "그 컴퓨터를 끄거나 앱을 닫으면 이 작업도 멈춥니다."
        : "그 컴퓨터를 끄거나 앱을 닫으면 이 세션도 닫힙니다.",
      atRisk: true,
    };
  }
  const subject = attachParticle(tier.label, "subject");
  return {
    tier,
    sentence: live
      ? `이 작업은 ${tier.label}에서 돕니다. 폰을 꺼도 계속됩니다.`
      : `이 세션은 ${subject} 들고 있습니다. 폰을 꺼도 남아 있습니다.`,
    atRisk: false,
  };
}

// ---- 그 에이전트가 지금 하는 일 ------------------------------------------------

/**
 * Work sessions this agent owns.
 *
 * `WorkSession.memberId` is the member who started the session, and agents ARE
 * members (하드 불변식), so this is an id comparison and not a heuristic. It is
 * also the ONLY link that exists: `GET …/work-sessions` takes no agent filter
 * (only `active=0|1`, measured on `server-rust`), so the narrowing happens here.
 *
 * Case-folded through `uuidEq` for the usual reason — ids cross this wire in
 * mixed case.
 */
export function sessionsForAgent(
  sessions: readonly WorkSession[],
  agentMemberId: string
): WorkSession[] {
  return sessions.filter((session) => uuidEq(session.memberId, agentMemberId));
}

/**
 * How many of an agent's sessions the ledger still calls running.
 *
 * Kept beside `sessionsForAgent` rather than counted at each call site, because
 * the word this number is allowed to carry is the subject of the whole section
 * below.
 */
export function runningSessionCount(
  sessions: readonly WorkSession[],
  agentMemberId: string
): number {
  return sessionsForAgent(sessions, agentMemberId).filter(
    (session) => session.status === "running"
  ).length;
}

// ---- 「작업 중」은 이 화면의 말이 아니다 (R1 High-2) --------------------------
//
// `clients/web` already owns that phrase, and it means something this client
// cannot see. There, 작업 중 is an OPEN TURN — a live `agent.status` frame on the
// realtime rail — and the web is explicit that a turn parked on an approval is
// NOT 작업 중 but 승인 대기 (`features/agents/turnCopy.ts`: an indicator that
// treats the two alike "tells the reader to wait for the agent while the agent
// is waiting for the reader").
//
// The phone has no agent rail yet. What it has is the work-session ledger, which
// answers a different question: has this agent got a session a host is executing?
// The two diverge in both directions — an agent answering a mention right now
// has an open turn and usually NO work session, and a long-running session can
// sit there while the agent is parked on a decision.
//
// That second direction is not a worry, it is measured. `work_session.status`
// and `agent_run.status` are independent state machines with NO foreign key
// between them (`work_session` has no `run_id`, `agent_run` has no
// `work_session_id`; the only shared coordinate is `channel_id`). Every
// statement that writes `work_session.status` lives in `crates/momo-t3`
// (`lifecycle.rs` create/end/resume, `reconcile.rs` cloud pause/resume,
// `sweep.rs` host-loss) and none of them is reachable from an approval:
// `park_run_for_approval_in_tx` writes `agent_run` alone, and
// `routes/approvals.rs` contains no reference to `work_session` at all.
//
// So a session stays `running` for the WHOLE duration of an approval hold. Had
// this surface kept the word, it would have said 작업 중 about an agent that had
// stopped and was waiting for a person — the exact lie the web module says it
// exists to prevent.
//
// So the phone stops using the word. It names the thing it actually read: 작업
// 세션. Wiring the realtime rail into RN is a batch of its own (a subscription
// port, the `agentRail` fold that this PR moved into the core, and a store the
// core deliberately does not have) and it is recorded in the PR as the follow-up
// rather than half-done here.

/** The row pill. Says which ledger this came from, not what the agent is doing. */
export const RUNNING_SESSION_PILL = "세션 실행 중";

/** The same fact with its count, for the row's second line and its spoken name. */
export function runningSessionMeta(count: number): string {
  return `작업 세션 ${count}개 실행 중`;
}

/**
 * The line under an agent that owns no sessions.
 *
 * It has to say two different things, because two different facts produce the
 * same empty list and only one of them is about this agent. Where the run
 * history cannot be read, "아무것도 안 하고 있습니다" would be a claim built out
 * of a route that does not answer.
 *
 * **The false branch did not stop being reachable when #1223 ported the reads.**
 * The table's verdict is about *this repository's* server; the instance a client
 * is actually talking to may be older, and `serverSaysAbsent` folds that case
 * back onto exactly this sentence. So the branch stays, and it stays borrowing
 * its words from `serverSurfaces` rather than writing them again — that table is
 * where a batch that ports a route goes to flip one line, and a second copy of
 * the sentence would survive the flip. The caller passes the verdict
 * (`isSurfaceProvided("agentRunHistory")`) so this stays a pure function of it.
 */
export function noSessionsDetail(runHistoryProvided: boolean): string {
  if (runHistoryProvided) return "이 에이전트가 연 작업 세션이 없습니다.";
  const surface = serverSurface("agentRunHistory");
  return `이 에이전트가 연 작업 세션이 없습니다. ${surface.absentReason} 조용한 것인지 안 보이는 것인지는 여기서 알 수 없습니다. ${surface.fallback}`;
}

/**
 * Where a raw terminal belongs.
 *
 * ADR-0137 D5 demoted the PTY on the phone — reading 80 columns on a 390pt
 * screen is the problem, not the transport — so this surface never opens one. It
 * is a sentence rather than a link because there is nothing to link to: the
 * attach grant is minted for a client that can speak the terminal protocol, and
 * this one deliberately cannot.
 */
export const TERMINAL_ON_DESKTOP =
  "터미널 화면은 데스크톱 앱에서 엽니다.";
