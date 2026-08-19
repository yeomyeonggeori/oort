import { ApiError, type AgentRunCancelResult } from "../../lib/api";
import { NetworkError } from "../../lib/http";

// =============================================================================
// 「멈춰라」 — what a human's stop actually does, and what it does not (goal
// RN-C1, ADR-0132 D1, server route landed by SRV-C2 / #989).
//
// Pure. `lib/api.ts` owns the request; this file owns every sentence and every
// reading of an answer, so the phone and any later client cannot disagree about
// what a 409 means.
//
// ## Why the confirm is ONE step and not the approval's ceremony
//
// An approval is irreversible in the direction that matters: saying yes lets an
// agent do a thing to the world, and no second tap un-does it. A cancel is
// irreversible too — the run ends where it stands and its partial work is not
// resumed — but it is the *recoverable* kind: the thing you lost is a request
// you can make again. So it gets exactly one confirm step, and the sentence has
// to carry that difference rather than borrowing the approval's weight. A
// warning that sounds heavier than the act teaches people to ignore warnings.
//
// The one thing the sentence must NOT do is imply everything stops. It does not:
// linked work sessions keep running, and the response says so in two fields.
// =============================================================================

/**
 * The confirm sentence. Both halves are load-bearing and neither may be dropped:
 * the first is the loss (this run ends here, its partial work is not resumed),
 * the second is the reason this is not an approval-sized decision.
 */
export const CANCEL_CONFIRM_SENTENCE =
  "중단하면 이 실행이 여기서 끝납니다. 다시 시킬 수 있습니다.";

/**
 * The confirm sentence, plus what it does NOT reach when the agent has more than
 * one run open in this channel (2R M3).
 *
 * `mergeAgentWorkingSignals` folds concurrent runs into one line and keeps the
 * EARLIEST run's id, which is the id this button carries. So with two runs open
 * the stop lands on one of them and the 작업 중 badge stays lit afterwards. The
 * first cut said nothing about that, and a stop whose visible effect is nothing
 * reads as a broken button — the reader's next move is to press it again, on a
 * run that is already cancelled.
 *
 * Naming the number is the whole fix. It is not a warning and it does not ask
 * for a second decision: it is the sentence that makes the badge's survival
 * legible in advance, so the person can decide whether one is what they meant.
 */
export function cancelConfirmSentence(runCount: number | undefined): string {
  if (runCount === undefined || runCount <= 1) return CANCEL_CONFIRM_SENTENCE;
  return `${CANCEL_CONFIRM_SENTENCE} 이 에이전트는 이 대화에서 실행 ${runCount}개를 열어 두고 있고, 그중 가장 먼저 시작한 하나만 멈춥니다.`;
}

/** The first tap, which asks rather than acts. */
export const CANCEL_ACTION_LABEL = "중단";

/** The second tap, which acts. */
export const CANCEL_COMMIT_LABEL = "중단 확정";

/** While the request is out. */
export const CANCEL_BUSY_LABEL = "중단 중";

/**
 * What happened, in one shape.
 *
 * `alreadyOver` is deliberately NOT an error arm. A 409 means the run reached a
 * terminal state on its own between the moment the badge was drawn and the
 * moment the person tapped — the thing they wanted (this run is not running) is
 * TRUE. Drawing that in red with a retry tells them to fight a race they already
 * won, and the retry can only ever answer 409 again.
 */
export type CancelOutcome =
  | { kind: "cancelled"; sentence: string }
  | { kind: "alreadyOver"; sentence: string }
  | { kind: "error"; sentence: string };

/**
 * The receipt. It names WHO, states what stopped, and states what did not.
 *
 * The name is not decoration (2R M2). This sentence lands under a list that can
 * hold three agents' turns at once, so an unattributed 「중단했습니다」 sits
 * directly beneath whichever line happens to be there and reads as a statement
 * about that one. The reader would be told that the agent still working has
 * stopped.
 *
 * `workSessionsTerminated` is `false` on this server and the linked ids are
 * listed precisely so a client can say the second half out loud. A receipt that
 * said only "중단했습니다" while a terminal kept running would be the same shape
 * of lie as a pause notice that claimed to kill a running job — which is the
 * sentence this very goal is here to correct.
 */
export function cancelReceipt(
  result: AgentRunCancelResult,
  agentName: string
): string {
  // 「의」는 받침에 따라 갈리지 않는 유일한 조사라 표를 거치지 않는다 —
  // `attachParticle`에 없는 것이 누락이 아니라, 고를 것이 없기 때문이다.
  const subject = `${agentName}의`;
  const linked = result.linkedWorkSessionIds.length;
  if (result.workSessionsTerminated) {
    return `${subject} 실행을 중단했습니다. 연결된 작업 세션도 함께 끝났습니다.`;
  }
  if (linked === 0) return `${subject} 실행을 중단했습니다.`;
  return `${subject} 실행을 중단했습니다. 이 실행에 연결된 작업 세션 ${linked}개는 계속 돕니다. 그것을 멈추는 것은 데스크톱에서 할 수 있습니다.`;
}

/** 200 → the receipt, as an outcome. */
export function cancelSucceeded(
  result: AgentRunCancelResult,
  agentName: string
): CancelOutcome {
  return { kind: "cancelled", sentence: cancelReceipt(result, agentName) };
}

/**
 * Which terminal state a 409 is reporting, if it said.
 *
 * The server does not answer a bare conflict — it answers `agent run is already
 * {status}` with the db label, and its own comment says why in as many words:
 * *"already succeeded" is not "stopped"*, and answering as if it were would tell
 * a person their stop worked when what really happened is that the agent
 * finished first (`routes/agent_runs.rs` cancel, :298-300 / :380-385).
 *
 * `cancelled` is deliberately absent from this table. A run already cancelled
 * never reaches a 409 at all — that is the idempotent 200 path, which answers
 * with the same body and writes nothing.
 *
 * Matching on the message is a soft read, so it fails soft: an unrecognised or
 * reworded message falls through to the plain sentence rather than to a guess.
 * The fact worth having is WHICH ending, and the fact we must never invent is
 * the same one.
 */
const TERMINAL_ENDINGS: ReadonlyArray<[string, string]> = [
  ["succeeded", "에이전트가 먼저 마쳤습니다."],
  ["timed_out", "시간이 초과돼 끝나 있었습니다."],
  ["failed", "실패로 끝나 있었습니다."],
];

export function alreadyOverSentence(message: string): string {
  const lowered = message.toLowerCase();
  for (const [label, ending] of TERMINAL_ENDINGS) {
    if (lowered.includes(label)) return `이 실행은 이미 끝났습니다. ${ending}`;
  }
  return "이 실행은 이미 끝났습니다.";
}

/**
 * Why the stop did not land, as a sentence the reader can act on.
 *
 * Same grammar as `pauseFailureCopy` one file over — name the act that failed,
 * then the one thing about this server that explains it — and the same rule: no
 * status code reaches the screen.
 *
 * The two arms worth reading twice:
 *
 *   409  The run is already terminal in some state other than cancelled. That is
 *        not a failure of anything; it is the answer — and WHICH terminal state
 *        it is matters, so the sentence names it (`alreadyOverSentence`).
 *   404  Two different servers answer 404 here and this client cannot tell them
 *        apart from the status alone: one has the route and does not have that
 *        run, the other does not have the route at all. So the sentence states
 *        BOTH readings instead of picking the one that sounds better, which is
 *        the same rule `unreadableAnswerOutcome` follows for approvals.
 */
export function cancelFailureOutcome(error: unknown): CancelOutcome {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return {
        kind: "alreadyOver",
        sentence: alreadyOverSentence(error.message),
      };
    }
    if (error.status === 401 || error.status === 403) {
      return {
        kind: "error",
        sentence:
          "중단하지 못했습니다. 이 실행이 일어나는 채널의 멤버만 중단할 수 있습니다.",
      };
    }
    if (error.status === 404 || error.status === 405) {
      return {
        kind: "error",
        sentence:
          "중단하지 못했습니다. 그 실행이 이미 사라졌거나, 이 서버가 실행 중단을 아직 받지 않습니다.",
      };
    }
    if (error.status === 429) {
      return {
        kind: "error",
        sentence: "중단하지 못했습니다. 요청이 너무 잦습니다. 잠시 뒤에 다시 시도하세요.",
      };
    }
    if (error.status >= 500) {
      return {
        kind: "error",
        sentence: "중단하지 못했습니다. 서버가 오류로 답했습니다.",
      };
    }
  }
  if (error instanceof NetworkError) {
    // The run is untouched — nothing was sent, so nothing half-happened. Saying
    // so is what stops someone from assuming it stopped anyway.
    return {
      kind: "error",
      sentence: `중단하지 못했습니다. ${error.message} 실행은 그대로입니다.`,
    };
  }
  return {
    kind: "error",
    sentence: "중단하지 못했습니다. 잠시 뒤에 다시 시도하세요.",
  };
}
