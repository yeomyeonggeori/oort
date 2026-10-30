import { fetchRoster, type Member, type RosterMember } from "../../lib/api";
import { coreSession } from "../../runtime/host";
import type { DecisionOutcome } from "../timeline/approvalDecision";

const PROFILE_ACTIONS = new Set([
  "member.display_name.set", "member.avatar.set", "agent.rename", "agent.profile.update",
]);

/** Refresh from server facts after approval, never from a proposal's strings. */
export async function refreshProfileAfterApproval(
  outcome: DecisionOutcome,
  replaceSelf: (member: Member) => void,
  cacheRoster: (workspaceId: string, rows: RosterMember[]) => void,
): Promise<void> {
  if (outcome.kind !== "committed" || outcome.status !== "approved" ||
      !outcome.result || !PROFILE_ACTIONS.has(outcome.result.actionId)) return;
  const started = coreSession().getPersistedSession()?.member;
  if (!started) return;
  try {
    const rows = await fetchRoster(started.workspaceId);
    const current = coreSession().getPersistedSession()?.member;
    // A late response must never put the previous account's profile on this one.
    if (!current || current.id !== started.id || current.workspaceId !== started.workspaceId) return;
    cacheRoster(current.workspaceId, rows);
    const own = rows.find(row => row.id.toLowerCase() === current.id.toLowerCase());
    if (own && own.kind === current.kind && own.status === "active") {
      replaceSelf({ ...current, displayName: own.displayName, handle: own.handle });
    }
  } catch {
    // The decision is already durable. Normal roster revalidation retries the read.
  }
}
