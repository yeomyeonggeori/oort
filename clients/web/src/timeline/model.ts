import type { Message } from "../api/client";

export const AUTHOR_GROUP_WINDOW_MS = 300_000;

export interface TimelineMessage {
  id: string;
  seq: number;
  type: string;
  body?: string;
  state?: Message["state"];
  authorMemberId: string;
  createdAtMs: number;
  editedAtMs?: number;
  deletedAtMs?: number;
  props?: Record<string, unknown>;
}

export type ReactionSnapshot = Record<string, Record<string, string[]>>;

export interface ReactionDelta {
  action: "added" | "removed";
  messageId: string;
  memberId: string;
  emoji: string;
}

export function fromRestMessage(message: Message): TimelineMessage {
  return {
    id: message.id,
    seq: message.seq,
    type: message.type,
    ...(message.body !== undefined ? { body: message.body } : {}),
    ...(message.state !== undefined ? { state: message.state } : {}),
    authorMemberId: message.authorMemberId,
    createdAtMs: message.createdAtMs,
    ...(message.editedAtMs !== undefined
      ? { editedAtMs: message.editedAtMs }
      : {}),
    ...(message.deletedAtMs !== undefined
      ? { deletedAtMs: message.deletedAtMs }
      : {}),
    ...(message.props !== undefined ? { props: message.props } : {}),
  };
}

export function reconcileMessages(
  existing: TimelineMessage[],
  incoming: TimelineMessage[]
): TimelineMessage[] {
  if (incoming.length === 0) return existing;
  const bySeq = new Map(existing.map((message) => [message.seq, message]));
  for (const message of incoming) bySeq.set(message.seq, message);
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

/** Backward-compatible name for the ordinary realtime append path. */
export const mergeMessages = reconcileMessages;

export function startsAuthorGroup(
  previous: TimelineMessage | undefined,
  current: TimelineMessage
): boolean {
  if (previous === undefined) return true;
  return (
    previous.authorMemberId.toLowerCase() !==
      current.authorMemberId.toLowerCase() ||
    current.createdAtMs - previous.createdAtMs > AUTHOR_GROUP_WINDOW_MS ||
    !isSameLocalDate(previous.createdAtMs, current.createdAtMs)
  );
}

export function isSameLocalDate(leftMs: number, rightMs: number): boolean {
  const left = new Date(leftMs);
  const right = new Date(rightMs);
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

export function mentionsMember(
  props: Record<string, unknown> | undefined,
  memberId: string
): boolean {
  const ids = props?.["mention_member_ids"];
  if (!Array.isArray(ids)) return false;
  return ids.some(
    (candidate) =>
      typeof candidate === "string" &&
      candidate.toLowerCase() === memberId.toLowerCase()
  );
}

export function applyReactionDelta(
  snapshot: ReactionSnapshot,
  delta: ReactionDelta
): ReactionSnapshot {
  const messageKey = Object.keys(snapshot).find(
    (key) => key.toLowerCase() === delta.messageId.toLowerCase()
  ) ?? delta.messageId;
  const currentMessage = snapshot[messageKey] ?? {};
  const members = currentMessage[delta.emoji] ?? [];
  const memberExists = members.some(
    (member) => member.toLowerCase() === delta.memberId.toLowerCase()
  );
  const nextMembers =
    delta.action === "added"
      ? memberExists
        ? members
        : [...members, delta.memberId]
      : members.filter(
          (member) => member.toLowerCase() !== delta.memberId.toLowerCase()
        );
  const nextMessage = { ...currentMessage };
  if (nextMembers.length === 0) delete nextMessage[delta.emoji];
  else nextMessage[delta.emoji] = nextMembers;
  const next = { ...snapshot };
  if (Object.keys(nextMessage).length === 0) delete next[messageKey];
  else next[messageKey] = nextMessage;
  return next;
}

export function removeMessageReactions(
  snapshot: ReactionSnapshot,
  messageId: string
): ReactionSnapshot {
  const key = Object.keys(snapshot).find(
    (candidate) => candidate.toLowerCase() === messageId.toLowerCase()
  );
  if (key === undefined) return snapshot;
  const next = { ...snapshot };
  delete next[key];
  return next;
}
