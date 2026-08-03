import {
  PUSH_CATEGORY,
  PUSH_ENVELOPE_SCHEMA,
  PUSH_REASONS,
  type PushCategory,
  type PushReason,
} from './contract';

// =============================================================================
// The id-only envelope, parsed on the JS side (goal RN-N1).
//
// This is a deliberate second implementation of `MomoPushParser`
// (PushNotification.swift:136-212), not a shortcut around it. The two run in
// different processes for different reasons:
//
//   - Swift parses to decide what to FETCH and DISPLAY, before the app is awake.
//   - JS parses to decide what to DO when the person taps an action button.
//
// The guards are reproduced rather than relaxed because they are the security
// boundary, not validation hygiene. In particular the workspace check exists so
// a push for workspace A can never drive an approval in workspace B; the frozen
// kit checked it in three separate places (audit §7.3) and losing that as a
// side effect of moving to JS is the regression this file is written to avoid.
// =============================================================================

export interface PushEnvelope {
  serverId: string;
  workspaceId: string;
  channelId: string;
  messageId: string;
  collapseId: string;
  reason: PushReason;
  approvalId: string | null;
  threadId: string;
  category: PushCategory;
  badge: number;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CATEGORIES: readonly string[] = Object.values(PUSH_CATEGORY);

function str(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse an APNs `userInfo` payload into an envelope, or null if it is not one of
 * ours or does not satisfy every guard the extension applies.
 *
 * Returning null must always mean "do nothing but open the app" — never
 * "assume defaults and act".
 */
export function parsePushEnvelope(payload: unknown): PushEnvelope | null {
  const root = record(payload);
  if (!root) return null;

  const aps = record(root.aps);
  const momo = record(root.momo);
  if (!aps || !momo) return null;

  // PushNotification.swift:180 — an exact string, not a prefix or a range.
  if (str(momo, 'schema') !== PUSH_ENVELOPE_SCHEMA) return null;

  const workspaceId = str(momo, 'workspace_id');
  const channelId = str(momo, 'channel_id');
  const messageId = str(momo, 'message_id');
  const threadId = str(aps, 'thread-id');
  if (!workspaceId || !UUID.test(workspaceId)) return null;
  if (!channelId || !UUID.test(channelId)) return null;
  if (!messageId || !UUID.test(messageId)) return null;
  if (!threadId || !UUID.test(threadId)) return null;

  const serverId = str(momo, 'server_id');
  const collapseId = str(momo, 'collapse_id');
  if (!serverId || !collapseId) return null;

  const reason = str(momo, 'reason');
  if (!reason || !(PUSH_REASONS as readonly string[]).includes(reason)) {
    return null;
  }

  const category = str(aps, 'category');
  if (!category || !CATEGORIES.includes(category)) return null;

  const badge = aps.badge;
  if (typeof badge !== 'number' || !Number.isFinite(badge) || badge < 0) {
    return null;
  }

  const rawApprovalId = str(momo, 'approval_id')?.toLowerCase() ?? null;
  const approvalId = rawApprovalId && UUID.test(rawApprovalId) ? rawApprovalId : null;

  // PushNotification.swift:189-190, kept as one biconditional rather than two
  // loose checks: an approval push MUST carry a usable approval id, and a
  // non-approval push must NOT carry one. Splitting these lets an approval id
  // ride along on a plain message and be acted on by the wrong branch.
  const isApproval = category === PUSH_CATEGORY.approval;
  if (isApproval !== (approvalId !== null)) return null;

  return {
    serverId,
    workspaceId: workspaceId.toLowerCase(),
    channelId: channelId.toLowerCase(),
    messageId: messageId.toLowerCase(),
    collapseId,
    reason: reason as PushReason,
    approvalId,
    threadId: threadId.toLowerCase(),
    category: category as PushCategory,
    badge,
  };
}

/** The thread root, or null when the notification is not in a thread.
 *  Mirrors `MomoPushEnvelope.threadRootID` (PushNotification.swift:118-120). */
export function threadRootId(envelope: PushEnvelope): string | null {
  return envelope.threadId === envelope.channelId ? null : envelope.threadId;
}
