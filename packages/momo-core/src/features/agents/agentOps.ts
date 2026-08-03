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
  | { kind: "failed" };

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
 */
export function agentStateLabel(
  agent: RosterMember,
  read: AgentProfileRead
): string {
  if (agent.status !== "active") return lifecycleLabel(agent, null, false, false);
  if (read.kind === "forbidden") return "상태를 볼 수 없음";
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
 *   - The Rust server has NO run-cancel route at all (the Swift server's
 *     `POST …/agent-runs/{run}/cancel` was not ported), so there is not even a
 *     second call this screen could offer to stop the work.
 *
 * That is why the second sentence exists. A person who reads "일시정지" and
 * assumes the running job dies has been misled by us, not by the server, and
 * "되돌릴 수 없는 인상을 주지 마라" cuts both ways: this is reversible, and it
 * is also weaker than it sounds.
 */
export const PAUSE_EFFECT_NOTICE =
  "재우면 새 실행이 시작되지 않습니다. 멘션해도 답하지 않고 그 사실을 채널에 알립니다. 이미 실행 중인 작업은 그대로 끝까지 갑니다.";

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
  /**
   * The answer to "지금 이거 꺼도 되나", stated about the HOST rather than about
   * the phone: no session in this product runs on the phone, so the honest
   * subject is always the machine the session is on.
   */
  survival: string;
}

const TIERS: Record<Exclude<HostTierKey, "unknown">, Omit<HostTier, "key">> = {
  // ADR-0137 D5, verbatim: `type=app`(맥)은 기기를 끄면 죽는다.
  app: {
    label: "데스크톱 앱",
    survival: "그 컴퓨터를 끄거나 앱을 닫으면 이 작업도 멈춥니다.",
  },
  workd: {
    label: "상시 서버",
    survival: "이 작업은 서버에서 돕니다. 폰을 꺼도 계속됩니다.",
  },
  cloud: {
    label: "클라우드",
    survival: "이 작업은 클라우드에서 돕니다. 폰을 꺼도 계속됩니다.",
  },
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
    return { key: type, ...TIERS[type] };
  }
  // A type the registry grew after this client shipped lands here too, and that
  // is the right side to fail on: a new tier we cannot name is exactly as
  // unanswerable as a host we never found.
  return {
    key: "unknown",
    label: "호스트 확인 안 됨",
    survival:
      "이 작업이 어디서 도는지 확인하지 못했습니다. 무엇을 꺼도 되는지 말할 수 없습니다.",
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
 * The line under an agent that owns no sessions.
 *
 * It has to say two different things, because two different facts produce the
 * same empty list and only one of them is about this agent. This server does not
 * serve the run history at all (`serverSurfaces.agentRunHistory`), so "아무것도
 * 안 하고 있습니다" would be a claim built out of a route that does not exist.
 */
export function noSessionsDetail(runHistoryProvided: boolean): string {
  return runHistoryProvided
    ? "이 에이전트가 연 작업 세션이 없습니다."
    : "이 에이전트가 연 작업 세션이 없습니다. 이 서버는 그 밖의 실행 기록을 아직 보여주지 못하므로, 조용한 것인지 안 보이는 것인지는 여기서 알 수 없습니다.";
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
