import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/app/session";
import { Button } from "@/design/ui/button";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import type { Message } from "@momo/core/lib/api";
import type { MemoryProposal } from "@momo/core/features/memory/model";
import {
  PROPOSAL_ACCEPT_LABEL,
  PROPOSAL_ACCEPTED,
  PROPOSAL_EVIDENCE_GONE,
  PROPOSAL_EVIDENCE_HEADING,
  PROPOSAL_EVIDENCE_LOADING,
  PROPOSAL_EVIDENCE_UNAVAILABLE,
  PROPOSAL_HEADING,
  PROPOSAL_NOT_SAVED_YET,
  PROPOSAL_OPEN_MEMORY,
  PROPOSAL_REJECT_LABEL,
  PROPOSAL_REJECTED,
  PROPOSAL_SELF_ACCEPT_WARNING,
  PROPOSAL_UNKNOWN_MEMBER,
  deriveProposalCard,
  memoryKindLabel,
  proposalByLine,
  proposalDecisionError,
  type ProposalErrorView,
  PROPOSAL_FORBIDDEN_MESSAGE,
} from "@momo/core/features/memory/browser";
import {
  memoryKeys,
  useEvidenceMessages,
  useProposalDecision,
  useRunProposals,
} from "./useMemory";

// =============================================================================
// 「기억해 둘게요」 제안 카드 (ADR-0196 D4 · D12 V3, #3170).
//
// Under an agent reply, the card turns what the agent said into an action a person
// takes: 기억하기 or 아니요. An agent only proposes; nothing is a memory until a
// person presses the first button, and the card says so in its own words.
//
// States, each a function of what the server returned or refused:
//   pending    text, kind, source messages, the two buttons
//   deciding   the pressed button keeps its shape (aria-busy), both are guarded
//   accepted / rejected   the outcome, who decided, a link to the new memory
//   conflict   409: decided by someone else, expired, or the text was forgotten
//   readOnly   a guest sees the whole card without buttons and is told why; a 403
//              on a member who looked like one moves the card here too
//   error      the request failed; the buttons stay so the person can retry
//
// A card the server no longer lists (someone else decided) is kept on screen
// while it carries an outcome, so the message that explains it is not deleted
// under the reader's eyes.
// =============================================================================

type Outcome =
  | { kind: "accepted"; itemId?: string }
  | { kind: "rejected" }
  | { kind: "conflict"; message: string }
  | { kind: "forbidden"; message: string }
  | { kind: "error"; message: string };

export function RunProposalCards({
  workspaceId,
  channelId,
  runId,
  onJump,
}: {
  workspaceId: string;
  channelId: string;
  runId: string;
  onJump?: (messageId: string, seq: number) => void;
}) {
  const query = useRunProposals(workspaceId, channelId, runId, true);
  // Proposals ever listed, so a card with an outcome survives the refetch that
  // no longer returns it.
  const known = useRef(new Map<string, MemoryProposal>());
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  for (const proposal of query.data ?? []) known.current.set(proposal.id, proposal);

  const listed = new Set((query.data ?? []).map((proposal) => proposal.id));
  const shown: MemoryProposal[] = [];
  for (const [id, proposal] of known.current) {
    if (listed.has(id) || outcomes[id] !== undefined) shown.push(proposal);
  }
  if (shown.length === 0) return null;

  return (
    <div className="mt-2 flex min-w-0 flex-col gap-2" data-testid="memory-proposals">
      {shown.map((proposal) => (
        <ProposalCard
          key={proposal.id}
          workspaceId={workspaceId}
          channelId={channelId}
          runId={runId}
          proposal={proposal}
          outcome={outcomes[proposal.id] ?? null}
          onOutcome={(outcome) =>
            setOutcomes((current) => ({ ...current, [proposal.id]: outcome }))
          }
          onClearOutcome={() =>
            setOutcomes((current) => {
              const next = { ...current };
              delete next[proposal.id];
              return next;
            })
          }
          onJump={onJump}
        />
      ))}
    </div>
  );
}

export function ProposalCard({
  workspaceId,
  channelId,
  runId,
  proposal,
  outcome,
  onOutcome,
  onClearOutcome,
  onJump,
}: {
  workspaceId: string;
  channelId: string;
  runId: string;
  proposal: MemoryProposal;
  outcome: Outcome | null;
  onOutcome: (outcome: Outcome) => void;
  onClearOutcome: () => void;
  onJump?: (messageId: string, seq: number) => void;
}) {
  const { session } = useSession();
  const client = useQueryClient();
  const directory = useDirectory(workspaceId).directory;
  const role = memberFor(directory, session.member.id)?.role;
  const decision = useProposalDecision(workspaceId);
  const headingId = useId();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const model = deriveProposalCard({ proposal, role });
  const decided = outcome?.kind === "accepted" || outcome?.kind === "rejected";
  const forbidden = outcome?.kind === "forbidden";
  const readOnlyReason =
    model.readOnlyReason ?? (forbidden ? PROPOSAL_FORBIDDEN_MESSAGE : null);
  const showButtons =
    model.canDecide && !decided && outcome?.kind !== "conflict" && !forbidden;
  const agentName =
    memberFor(directory, proposal.agentMemberId)?.displayName ?? PROPOSAL_UNKNOWN_MEMBER;

  // Buttons leave when the card is decided; the caret goes to the sentence that
  // says what happened instead of falling back to the page.
  useEffect(() => {
    if (outcome !== null) statusRef.current?.focus();
  }, [outcome]);

  function decide(kind: "accept" | "reject") {
    if (decision.isPending) return;
    onClearOutcome();
    decision.mutate(
      { proposalId: proposal.id, decision: kind },
      {
        onSuccess: (result) => {
          onOutcome(
            kind === "accept"
              ? {
                  kind: "accepted",
                  ...(result.itemId !== undefined ? { itemId: result.itemId } : {}),
                }
              : { kind: "rejected" }
          );
          void client.invalidateQueries({
            queryKey: memoryKeys.proposals(workspaceId, channelId, runId),
            refetchType: "none",
          });
        },
        onError: (error) => {
          const view: ProposalErrorView = proposalDecisionError(error);
          onOutcome({ kind: view.kind === "failed" ? "error" : view.kind, message: view.message });
          if (view.refetch) {
            void client.invalidateQueries({
              queryKey: memoryKeys.proposals(workspaceId, channelId, runId),
              refetchType: "none",
            });
          }
        },
      }
    );
  }

  const state = decided
    ? outcome.kind
    : outcome?.kind === "conflict"
      ? "conflict"
      : readOnlyReason !== null
        ? "readOnly"
        : outcome?.kind === "error"
          ? "error"
          : decision.isPending
            ? "deciding"
            : "pending";

  return (
    <section
      aria-labelledby={headingId}
      data-testid="memory-proposal"
      data-state={state}
      className="flex min-w-0 max-w-prose flex-col gap-3 rounded-xl border border-line bg-surface px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="text-body font-semibold text-ink">
          {PROPOSAL_HEADING}
        </h3>
        <span
          className="rounded-full bg-surface-muted px-2 py-1 text-meta text-ink-muted"
          data-testid="memory-proposal-kind"
        >
          {memoryKindLabel(proposal.kind)}
        </span>
        <span className="text-meta text-ink-muted">{proposalByLine(agentName)}</span>
      </div>

      {proposal.text !== undefined ? (
        <p
          className="whitespace-pre-line break-keep text-body text-ink"
          data-testid="memory-proposal-text"
        >
          {proposal.text}
        </p>
      ) : null}

      {proposal.evidence.length > 0 && (
        <ProposalEvidence
          workspaceId={workspaceId}
          channelId={proposal.channelId}
          proposal={proposal}
          onJump={onJump}
        />
      )}

      {model.warnSelfAccept && showButtons && (
        <p
          role="note"
          className="break-keep rounded-lg bg-surface-muted px-3 py-2 text-meta text-ink"
          data-testid="memory-proposal-self-warning"
        >
          {PROPOSAL_SELF_ACCEPT_WARNING}
        </p>
      )}

      {showButtons && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="tap-target"
              aria-busy={decision.isPending || undefined}
              data-testid="memory-proposal-accept"
              onClick={() => decide("accept")}
            >
              {decision.isPending && decision.variables?.decision === "accept" && (
                <Loader2 aria-hidden="true" className="spinner-busy" />
              )}
              {PROPOSAL_ACCEPT_LABEL}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="tap-target"
              aria-busy={decision.isPending || undefined}
              data-testid="memory-proposal-reject"
              onClick={() => decide("reject")}
            >
              {PROPOSAL_REJECT_LABEL}
            </Button>
          </div>
          <p className="break-keep text-meta text-ink-muted">{PROPOSAL_NOT_SAVED_YET}</p>
        </>
      )}

      {readOnlyReason !== null && !decided && outcome?.kind !== "conflict" && (
        <p
          ref={statusRef}
          tabIndex={-1}
          className="break-keep text-meta text-ink-muted focus-visible:focus-ring"
          data-testid="memory-proposal-readonly"
        >
          {readOnlyReason}
        </p>
      )}

      {outcome?.kind === "accepted" && (
        <div className="flex flex-wrap items-center gap-3">
          <p
            ref={statusRef}
            tabIndex={-1}
            className="break-keep text-body text-ink focus-visible:focus-ring"
            data-testid="memory-proposal-accepted"
          >
            {PROPOSAL_ACCEPTED}
          </p>
          {outcome.itemId !== undefined && (
            <Link
              to={`/memory?item=${encodeURIComponent(outcome.itemId)}`}
              className="inline-flex h-control-sm tap-target items-center rounded-md bg-surface-muted px-3 text-meta text-ink press hover:bg-surface-hover focus-visible:focus-ring"
              data-testid="memory-proposal-open"
            >
              {PROPOSAL_OPEN_MEMORY}
            </Link>
          )}
        </div>
      )}
      {outcome?.kind === "rejected" && (
        <p
          ref={statusRef}
          tabIndex={-1}
          className="break-keep text-body text-ink focus-visible:focus-ring"
          data-testid="memory-proposal-rejected"
        >
          {PROPOSAL_REJECTED}
        </p>
      )}
      {outcome?.kind === "conflict" && (
        <p
          ref={statusRef}
          tabIndex={-1}
          role="status"
          className="break-keep text-body text-ink focus-visible:focus-ring"
          data-testid="memory-proposal-conflict"
        >
          {outcome.message}
        </p>
      )}
      {outcome?.kind === "error" && (
        <p
          ref={statusRef}
          tabIndex={-1}
          role="alert"
          className="break-keep text-body text-danger focus-visible:focus-ring"
          data-testid="memory-proposal-error"
        >
          {outcome.message}
        </p>
      )}
    </section>
  );
}

function ProposalEvidence({
  workspaceId,
  channelId,
  proposal,
  onJump,
}: {
  workspaceId: string;
  channelId: string;
  proposal: MemoryProposal;
  onJump?: (messageId: string, seq: number) => void;
}) {
  const { session } = useSession();
  const directory = useDirectory(workspaceId).directory;
  const texts = useEvidenceMessages(workspaceId, channelId, proposal.evidence, true);
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="memory-proposal-evidence">
      <p className="text-meta font-medium text-ink-muted">{PROPOSAL_EVIDENCE_HEADING}</p>
      <ul className="flex min-w-0 flex-col gap-2">
        {proposal.evidence.map((row) => {
          const author =
            memberFor(directory, row.authorMemberId)?.displayName ??
            (row.authorMemberId === session.member.id
              ? session.member.displayName
              : PROPOSAL_UNKNOWN_MEMBER);
          const message: Message | null | undefined = texts.data?.[row.messageId];
          return (
            <li
              key={row.messageId}
              className="flex min-w-0 flex-col gap-1 rounded-lg bg-surface-muted px-3 py-2"
              data-testid="memory-proposal-evidence-row"
            >
              <span className="text-meta font-medium text-ink">{author}</span>
              {texts.isPending ? (
                <span className="text-meta text-ink-muted">{PROPOSAL_EVIDENCE_LOADING}</span>
              ) : texts.isError ? (
                <span className="text-meta text-ink-muted">{PROPOSAL_EVIDENCE_UNAVAILABLE}</span>
              ) : message ? (
                <span className="line-clamp-3 whitespace-pre-line break-words text-body text-ink">
                  {message.body}
                </span>
              ) : (
                <span className="text-meta text-ink-muted">{PROPOSAL_EVIDENCE_GONE}</span>
              )}
              {onJump !== undefined && message ? (
                <button
                  type="button"
                  className="tap-target self-start rounded-sm text-meta text-ink-muted press hover:text-ink focus-visible:focus-ring"
                  onClick={() => onJump(row.messageId, row.seq)}
                  data-testid="memory-proposal-evidence-jump"
                >
                  원본으로 이동
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
