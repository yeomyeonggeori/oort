import {
  arrayField,
  bool,
  num,
  record,
  str,
  stringArrayField,
  WireShapeError,
} from "../../lib/wire";

// =============================================================================
// Team memory v2 (ADR-0196 / #3164) — wire types and total parsers.
//
// Visibility is decided by the server (database row-level security): a digest
// or receipt the caller may not read is simply absent (a 404 for a single one,
// an empty list for a channel). The client never re-filters and must not treat
// an empty list as proof that a channel has no memory.
// =============================================================================

export type MemoryDigestLevel = "window" | "day" | "week";

/** The source message a digest line rests on, for a link back to the message. */
export interface MemoryEvidenceLink {
  messageId: string;
  channelId: string;
  /** Channel sequence of the source message. */
  seq: number;
}

export interface MemoryDigest {
  id: string;
  channelId: string;
  threadRootId?: string;
  level: MemoryDigestLevel;
  fromSeq: number;
  toSeq: number;
  body: string;
  /** Number of evidence messages. */
  sourceCount: number;
  model?: string;
  createdAtMs: number;
  evidence: MemoryEvidenceLink[];
}

export interface MemoryDigestPage {
  digests: MemoryDigest[];
  /** Effective anchor: every digest has `toSeq > afterSeq`. */
  afterSeq: number;
  /** How far the summary worker has processed the channel, when known. */
  summarizedThroughSeq?: number;
  nextCursor?: string;
}

export type MemoryItemKind = "decision" | "fact" | "commitment" | "preference" | "procedure";
export type MemoryItemOrigin = "extracted" | "confirmed" | "curated" | "synthesized";

/** An item a receipt names (#3169), as the caller may read it today. */
export interface MemoryReceiptItem {
  id: string;
  channelId: string;
  kind: MemoryItemKind;
  origin: MemoryItemOrigin;
  body: string;
  /** The fact's own time (the newest evidence message), not when it was recorded. */
  validFromMs: number;
  sourceCount: number;
}

export interface MemoryReceipt {
  runId: string;
  channelId: string;
  /** Everything the run was served (digests and items) — the chip's n. */
  servedCount: number;
  /** Served digests the caller can read today. */
  digestIds: string[];
  digests: MemoryDigest[];
  /**
   * Served items the caller can read today (#3169). Optional only so a fixture or an older
   * server without the field still parses; the server always sends both (empty when none).
   */
  itemIds?: string[];
  items?: MemoryReceiptItem[];
  /** Requester only; a count, never content. */
  withheldCount?: number;
  budgetChars: number;
  usedChars: number;
  createdAtMs: number;
}

/** A 「기억해 둘게요」 proposal (#3169): an agent proposes, a person accepts or rejects. */
export type MemoryProposalStatus = "pending" | "accepted" | "rejected";

export interface MemoryProposalEvidence {
  messageId: string;
  seq: number;
  authorMemberId: string;
}

export interface MemoryProposal {
  id: string;
  channelId: string;
  /** The agent run that proposed it — the reply the card belongs under. */
  runId?: string;
  agentMemberId: string;
  /** The person the agent was answering (derived by the server). */
  requesterMemberId: string;
  kind: MemoryItemKind;
  status: MemoryProposalStatus;
  /** The proposed memory. Only while `pending`; a decided proposal keeps no text. */
  text?: string;
  subject?: string;
  /** Source message ids. Empty once decided. */
  evidenceMessageIds: string[];
  /**
   * Author and channel sequence of each source message (pending only) for a card line like
   * 「밥 · #41」. Ids and numbers only: fetch the text through the normal message path.
   */
  evidence: MemoryProposalEvidence[];
  /** The caller is the person the agent answered: warn before a self-accept (advice only). */
  callerIsRequester: boolean;
  createdAtMs: number;
  expiresAtMs: number;
  decidedBy?: string;
  decidedAtMs?: number;
  /** The confirmed item an accepted proposal became. */
  itemId?: string;
}

export interface ListMemoryProposalsOptions {
  /** Defaults to `pending` on the server. */
  status?: MemoryProposalStatus;
  /** Only the proposals of one agent run — the cards under one reply. */
  runId?: string;
  limit?: number;
}

export interface WorkspaceMemorySettings {
  enabled: boolean;
  paused: boolean;
  dailyTokenCap?: number;
  /** Read only. */
  resetEpoch: number;
}

export interface ChannelMemorySettings {
  channelId: string;
  excluded: boolean;
  paused: boolean;
}

export interface MemberMemorySettings {
  paused: boolean;
}

export interface MemorySettings {
  workspace: WorkspaceMemorySettings;
  /** Channels with an explicit row that the caller can read. */
  channels: ChannelMemorySettings[];
  me: MemberMemorySettings;
}

export interface ListMemoryDigestsOptions {
  level?: MemoryDigestLevel;
  threadRootId?: string;
  sinceSeq?: number;
  /** Anchor at the caller's own read cursor — the missed-conversation shape. */
  sinceLastRead?: boolean;
  cursor?: string;
  limit?: number;
}

export interface PatchWorkspaceMemorySettingsInput {
  enabled?: boolean;
  paused?: boolean;
}

export interface PatchChannelMemorySettingsInput {
  excluded?: boolean;
  paused?: boolean;
}

const ITEM_KINDS: readonly string[] = ["decision", "fact", "commitment", "preference", "procedure"];
const ITEM_ORIGINS: readonly string[] = ["extracted", "confirmed", "curated", "synthesized"];
const PROPOSAL_STATUSES: readonly string[] = ["pending", "accepted", "rejected"];

function isItemKind(value: string | undefined): value is MemoryItemKind {
  return value !== undefined && ITEM_KINDS.includes(value);
}

function isItemOrigin(value: string | undefined): value is MemoryItemOrigin {
  return value !== undefined && ITEM_ORIGINS.includes(value);
}

function isProposalStatus(value: string | undefined): value is MemoryProposalStatus {
  return value !== undefined && PROPOSAL_STATUSES.includes(value);
}

function isLevel(value: string | undefined): value is MemoryDigestLevel {
  return value === "window" || value === "day" || value === "week";
}

export function parseMemoryEvidenceLink(value: unknown): MemoryEvidenceLink | null {
  const messageId = str(value, "messageId");
  const channelId = str(value, "channelId");
  const seq = num(value, "seq");
  if (messageId === undefined || channelId === undefined || seq === undefined) return null;
  return { messageId, channelId, seq };
}

export function parseMemoryDigest(value: unknown): MemoryDigest | null {
  const id = str(value, "id");
  const channelId = str(value, "channelId");
  const level = str(value, "level");
  const fromSeq = num(value, "fromSeq");
  const toSeq = num(value, "toSeq");
  const body = str(value, "body");
  const sourceCount = num(value, "sourceCount");
  const createdAtMs = num(value, "createdAtMs");
  const rawEvidence = arrayField(value, "evidence");
  if (
    id === undefined ||
    channelId === undefined ||
    !isLevel(level) ||
    fromSeq === undefined ||
    toSeq === undefined ||
    body === undefined ||
    sourceCount === undefined ||
    createdAtMs === undefined ||
    rawEvidence === null
  ) {
    return null;
  }
  const evidence: MemoryEvidenceLink[] = [];
  for (const row of rawEvidence) {
    const link = parseMemoryEvidenceLink(row);
    if (link === null) return null;
    evidence.push(link);
  }
  const digest: MemoryDigest = {
    id,
    channelId,
    level,
    fromSeq,
    toSeq,
    body,
    sourceCount,
    createdAtMs,
    evidence,
  };
  const threadRootId = str(value, "threadRootId");
  if (threadRootId !== undefined) digest.threadRootId = threadRootId;
  const model = str(value, "model");
  if (model !== undefined) digest.model = model;
  return digest;
}

function digestList(source: unknown, key: string): MemoryDigest[] {
  const rows = arrayField(source, key);
  if (rows === null) throw new WireShapeError();
  const digests: MemoryDigest[] = [];
  for (const row of rows) {
    const parsed = parseMemoryDigest(row);
    if (parsed === null) throw new WireShapeError();
    digests.push(parsed);
  }
  return digests;
}

export function parseMemoryDigestPage(value: unknown): MemoryDigestPage {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const digests = digestList(source, "digests");
  const afterSeq = num(source, "afterSeq");
  if (afterSeq === undefined) throw new WireShapeError();
  const page: MemoryDigestPage = { digests, afterSeq };
  const summarizedThroughSeq = num(source, "summarizedThroughSeq");
  if (summarizedThroughSeq !== undefined) page.summarizedThroughSeq = summarizedThroughSeq;
  const nextCursor = str(source, "nextCursor");
  if (nextCursor !== undefined) page.nextCursor = nextCursor;
  return page;
}

export function parseMemoryDigestResponse(value: unknown): MemoryDigest {
  const parsed = parseMemoryDigest(record(value)?.digest);
  if (parsed === null) throw new WireShapeError();
  return parsed;
}

export function parseMemoryReceiptItem(value: unknown): MemoryReceiptItem | null {
  const id = str(value, "id");
  const channelId = str(value, "channelId");
  const kind = str(value, "kind");
  const origin = str(value, "origin");
  const body = str(value, "body");
  const validFromMs = num(value, "validFromMs");
  const sourceCount = num(value, "sourceCount");
  if (
    id === undefined ||
    channelId === undefined ||
    !isItemKind(kind) ||
    !isItemOrigin(origin) ||
    body === undefined ||
    validFromMs === undefined ||
    sourceCount === undefined
  ) {
    return null;
  }
  return { id, channelId, kind, origin, body, validFromMs, sourceCount };
}

export function parseMemoryProposal(value: unknown): MemoryProposal | null {
  const id = str(value, "id");
  const channelId = str(value, "channelId");
  const agentMemberId = str(value, "agentMemberId");
  const requesterMemberId = str(value, "requesterMemberId");
  const kind = str(value, "kind");
  const status = str(value, "status");
  const evidenceMessageIds = stringArrayField(value, "evidenceMessageIds");
  const createdAtMs = num(value, "createdAtMs");
  const expiresAtMs = num(value, "expiresAtMs");
  const callerIsRequester = bool(value, "callerIsRequester");
  const rawEvidence = arrayField(value, "evidence");
  if (rawEvidence === null || callerIsRequester === undefined) return null;
  const evidence: MemoryProposalEvidence[] = [];
  for (const row of rawEvidence) {
    const messageId = str(row, "messageId");
    const seq = num(row, "seq");
    const authorMemberId = str(row, "authorMemberId");
    if (messageId === undefined || seq === undefined || authorMemberId === undefined) return null;
    evidence.push({ messageId, seq, authorMemberId });
  }
  if (
    id === undefined ||
    channelId === undefined ||
    agentMemberId === undefined ||
    requesterMemberId === undefined ||
    !isItemKind(kind) ||
    !isProposalStatus(status) ||
    evidenceMessageIds === null ||
    createdAtMs === undefined ||
    expiresAtMs === undefined
  ) {
    return null;
  }
  const proposal: MemoryProposal = {
    id,
    channelId,
    agentMemberId,
    requesterMemberId,
    kind,
    status,
    evidenceMessageIds,
    evidence,
    callerIsRequester,
    createdAtMs,
    expiresAtMs,
  };
  const runId = str(value, "runId");
  if (runId !== undefined) proposal.runId = runId;
  const text = str(value, "text");
  if (text !== undefined) proposal.text = text;
  const subject = str(value, "subject");
  if (subject !== undefined) proposal.subject = subject;
  const decidedBy = str(value, "decidedBy");
  if (decidedBy !== undefined) proposal.decidedBy = decidedBy;
  const decidedAtMs = num(value, "decidedAtMs");
  if (decidedAtMs !== undefined) proposal.decidedAtMs = decidedAtMs;
  const itemId = str(value, "itemId");
  if (itemId !== undefined) proposal.itemId = itemId;
  return proposal;
}

export function parseMemoryProposalList(value: unknown): MemoryProposal[] {
  const rows = arrayField(record(value), "proposals");
  if (rows === null) throw new WireShapeError();
  const proposals: MemoryProposal[] = [];
  for (const row of rows) {
    const parsed = parseMemoryProposal(row);
    if (parsed === null) throw new WireShapeError();
    proposals.push(parsed);
  }
  return proposals;
}

export function parseMemoryProposalDecision(value: unknown): MemoryProposal {
  const parsed = parseMemoryProposal(record(value)?.proposal);
  if (parsed === null) throw new WireShapeError();
  return parsed;
}

export function parseMemoryReceiptResponse(value: unknown): MemoryReceipt {
  const source = record(record(value)?.receipt);
  if (source === null) throw new WireShapeError();
  const runId = str(source, "runId");
  const channelId = str(source, "channelId");
  const servedCount = num(source, "servedCount");
  const digestIds = stringArrayField(source, "digestIds");
  const budgetChars = num(source, "budgetChars");
  const usedChars = num(source, "usedChars");
  const createdAtMs = num(source, "createdAtMs");
  if (
    runId === undefined ||
    channelId === undefined ||
    servedCount === undefined ||
    digestIds === null ||
    budgetChars === undefined ||
    usedChars === undefined ||
    createdAtMs === undefined
  ) {
    throw new WireShapeError();
  }
  const receipt: MemoryReceipt = {
    runId,
    channelId,
    servedCount,
    digestIds,
    digests: digestList(source, "digests"),
    budgetChars,
    usedChars,
    createdAtMs,
  };
  const itemIds = stringArrayField(source, "itemIds");
  if (itemIds !== null) receipt.itemIds = itemIds;
  const rawItems = arrayField(source, "items");
  if (rawItems !== null) {
    const items: MemoryReceiptItem[] = [];
    for (const row of rawItems) {
      const parsed = parseMemoryReceiptItem(row);
      if (parsed === null) throw new WireShapeError();
      items.push(parsed);
    }
    receipt.items = items;
  }
  const withheldCount = num(source, "withheldCount");
  if (withheldCount !== undefined) receipt.withheldCount = withheldCount;
  return receipt;
}

export function parseWorkspaceMemorySettings(value: unknown): WorkspaceMemorySettings {
  const enabled = bool(value, "enabled");
  const paused = bool(value, "paused");
  const resetEpoch = num(value, "resetEpoch");
  if (enabled === undefined || paused === undefined || resetEpoch === undefined) {
    throw new WireShapeError();
  }
  const settings: WorkspaceMemorySettings = { enabled, paused, resetEpoch };
  const dailyTokenCap = num(value, "dailyTokenCap");
  if (dailyTokenCap !== undefined) settings.dailyTokenCap = dailyTokenCap;
  return settings;
}

export function parseChannelMemorySettings(value: unknown): ChannelMemorySettings {
  const channelId = str(value, "channelId");
  const excluded = bool(value, "excluded");
  const paused = bool(value, "paused");
  if (channelId === undefined || excluded === undefined || paused === undefined) {
    throw new WireShapeError();
  }
  return { channelId, excluded, paused };
}

export function parseMemberMemorySettings(value: unknown): MemberMemorySettings {
  const paused = bool(value, "paused");
  if (paused === undefined) throw new WireShapeError();
  return { paused };
}

export function parseMemorySettings(value: unknown): MemorySettings {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const channels = arrayField(source, "channels");
  if (channels === null) throw new WireShapeError();
  return {
    workspace: parseWorkspaceMemorySettings(source.workspace),
    channels: channels.map(parseChannelMemorySettings),
    me: parseMemberMemorySettings(source.me),
  };
}

/**
 * The missed-conversation card shows nothing until the worker has caught up to
 * the reader's cursor; `summarizedThroughSeq` tells "nothing to summarize" from
 * "not summarized yet".
 */
export function memoryIsCaughtUp(page: MemoryDigestPage, latestSeq: number): boolean {
  return page.summarizedThroughSeq !== undefined && page.summarizedThroughSeq >= latestSeq;
}
