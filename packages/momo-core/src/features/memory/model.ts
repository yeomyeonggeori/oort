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

/** What one `POST …/memory/reset` removed, per table (counts only). */
export interface MemoryResetCounts {
  digests: number;
  items: number;
  evidence: number;
  topics: number;
  topicSummaries: number;
  embeddings: number;
  proposals: number;
  servings: number;
  consolidationPairs: number;
  consolidationState: number;
}

/** The result of a reset: the new `resetEpoch` and what was deleted. */
export interface MemoryResetResult {
  epoch: number;
  deleted: MemoryResetCounts;
}

/** Machine codes for what the summary worker reads (the client owns the wording). */
export type MemoryNoticeSends = "channel_message_text" | "author_display_name" | "agent_dm_message_text";
export type MemoryNoticeNeverSends =
  | "human_direct_messages"
  | "attachments"
  | "deleted_messages"
  | "excluded_channels"
  | "paused_members_dms";

/**
 * 「팀 고지」 (ADR-0196 D9 ②): what team memory sends to which provider. Provider and model only —
 * never a key or a link. `sending` = `enabled && !paused && summary.configured`.
 */
export interface MemoryNotice {
  enabled: boolean;
  paused: boolean;
  sending: boolean;
  resetEpoch: number;
  summary: {
    /** false = no 기본 AI summary row: the worker calls no model, nothing is sent. */
    configured: boolean;
    /** Preset name (OpenAI, Anthropic, …) or the host; `host` is the bare host. */
    provider?: { name: string; host: string };
    /** Absent = the link's default model. */
    modelId?: string;
  };
  embeddings: { model: string; location: "local"; sentToProvider: false };
  sends: MemoryNoticeSends[];
  neverSends: MemoryNoticeNeverSends[];
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

// -----------------------------------------------------------------------------
// Memory browser (ADR-0196 D9 / D12 V4, #3208) — items, evidence, events.
//
// The same rule as digests: the server decides visibility. A hidden item is
// absent from a list and a 404 everywhere else, identical to a missing id, so
// the client must not try to tell "hidden" from "gone". Edit and forget are
// permitted to anyone who can read the item (ADR D9); anyone else gets that same
// 404. Forget deletes for good — there is no undo and no "forgotten" state. UI copy must not
// promise a forgotten fact can never reappear: summaries may still carry it until regenerated.
// -----------------------------------------------------------------------------

export type MemoryItemSpace = "channel" | "personal";
/** `active` = current items (default); `history` = retired but readable (e.g. edited-away versions). */
export type MemoryItemStatus = "active" | "history" | "all";

export const MEMORY_ITEM_KINDS: readonly MemoryItemKind[] = [
  "decision",
  "fact",
  "commitment",
  "preference",
  "procedure",
];

export interface MemoryItem {
  id: string;
  channelId: string;
  spaceKind: MemoryItemSpace;
  kind: MemoryItemKind;
  origin: MemoryItemOrigin;
  body: string;
  subjectKey?: string;
  validFromMs: number;
  validToMs?: number;
  recordedAtMs: number;
  retiredAtMs?: number;
  /** Why it was retired (`edited` keeps it as history). */
  retiredReason?: string;
  /** The version this one replaced. */
  supersedesId?: string;
  /** The version that replaced this one. */
  supersededById?: string;
  confidence: number;
  sourceCount: number;
  /** Curated items only: who wrote the current text, and when. */
  editedByMemberId?: string;
  editedAtMs?: number;
  /** Search results only, best first. */
  score?: number;
}

export interface MemoryItemPage {
  items: MemoryItem[];
  /** Absent on the last page and for a search (no cursor). */
  nextCursor?: string;
}

export interface MemoryItemDetail {
  item: MemoryItem;
  evidence: MemoryEvidenceLink[];
}

export interface MemoryItemEvent {
  id: string;
  /** `created` | `edited` | `superseded` | … */
  action: string;
  actorMemberId?: string;
  /** Ids, kinds and counts only — the ledger never holds memory text. */
  detail: Record<string, unknown>;
  createdAtMs: number;
}

export interface EditedMemoryItem {
  /** The new curated item. */
  item: MemoryItem;
  evidence: MemoryEvidenceLink[];
  /** The item it replaced (now history). */
  supersededId: string;
}

export interface ListMemoryItemsOptions {
  channelId?: string;
  kind?: MemoryItemKind;
  status?: MemoryItemStatus;
  /** Keyword search over current items; ranked, no cursor, at most 50 hits. */
  q?: string;
  cursor?: string;
  limit?: number;
}

export interface EditMemoryItemInput {
  /** 1–600 characters. */
  body: string;
  kind?: MemoryItemKind;
}

export function parseMemoryItem(value: unknown): MemoryItem | null {
  const id = str(value, "id");
  const channelId = str(value, "channelId");
  const spaceKind = str(value, "spaceKind");
  const kind = str(value, "kind");
  const origin = str(value, "origin");
  const body = str(value, "body");
  const validFromMs = num(value, "validFromMs");
  const recordedAtMs = num(value, "recordedAtMs");
  const confidence = num(value, "confidence");
  const sourceCount = num(value, "sourceCount");
  if (
    id === undefined ||
    channelId === undefined ||
    (spaceKind !== "channel" && spaceKind !== "personal") ||
    !isItemKind(kind) ||
    !isItemOrigin(origin) ||
    body === undefined ||
    validFromMs === undefined ||
    recordedAtMs === undefined ||
    confidence === undefined ||
    sourceCount === undefined
  ) {
    return null;
  }
  const item: MemoryItem = {
    id,
    channelId,
    spaceKind,
    kind,
    origin,
    body,
    validFromMs,
    recordedAtMs,
    confidence,
    sourceCount,
  };
  const subjectKey = str(value, "subjectKey");
  if (subjectKey !== undefined) item.subjectKey = subjectKey;
  const validToMs = num(value, "validToMs");
  if (validToMs !== undefined) item.validToMs = validToMs;
  const retiredAtMs = num(value, "retiredAtMs");
  if (retiredAtMs !== undefined) item.retiredAtMs = retiredAtMs;
  const retiredReason = str(value, "retiredReason");
  if (retiredReason !== undefined) item.retiredReason = retiredReason;
  const supersedesId = str(value, "supersedesId");
  if (supersedesId !== undefined) item.supersedesId = supersedesId;
  const supersededById = str(value, "supersededById");
  if (supersededById !== undefined) item.supersededById = supersededById;
  const editedByMemberId = str(value, "editedByMemberId");
  if (editedByMemberId !== undefined) item.editedByMemberId = editedByMemberId;
  const editedAtMs = num(value, "editedAtMs");
  if (editedAtMs !== undefined) item.editedAtMs = editedAtMs;
  const score = num(value, "score");
  if (score !== undefined) item.score = score;
  return item;
}

function requireItem(value: unknown): MemoryItem {
  const item = parseMemoryItem(value);
  if (item === null) throw new WireShapeError();
  return item;
}

function requireEvidence(source: unknown): MemoryEvidenceLink[] {
  const rows = arrayField(source, "evidence");
  if (rows === null) throw new WireShapeError();
  const links: MemoryEvidenceLink[] = [];
  for (const row of rows) {
    const link = parseMemoryEvidenceLink(row);
    if (link === null) throw new WireShapeError();
    links.push(link);
  }
  return links;
}

export function parseMemoryItemPage(value: unknown): MemoryItemPage {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const rows = arrayField(source, "items");
  if (rows === null) throw new WireShapeError();
  const page: MemoryItemPage = { items: rows.map(requireItem) };
  const nextCursor = str(source, "nextCursor");
  if (nextCursor !== undefined) page.nextCursor = nextCursor;
  return page;
}

export function parseMemoryItemDetail(value: unknown): MemoryItemDetail {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  return { item: requireItem(source.item), evidence: requireEvidence(source) };
}

export function parseMemoryItemEvidence(value: unknown): MemoryEvidenceLink[] {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  return requireEvidence(source);
}

export function parseMemoryItemEvents(value: unknown): MemoryItemEvent[] {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const rows = arrayField(source, "events");
  if (rows === null) throw new WireShapeError();
  return rows.map((row) => {
    const id = str(row, "id");
    const action = str(row, "action");
    const createdAtMs = num(row, "createdAtMs");
    const detail = record(record(row)?.detail);
    if (id === undefined || action === undefined || createdAtMs === undefined || detail === null) {
      throw new WireShapeError();
    }
    const event: MemoryItemEvent = { id, action, detail, createdAtMs };
    const actorMemberId = str(row, "actorMemberId");
    if (actorMemberId !== undefined) event.actorMemberId = actorMemberId;
    return event;
  });
}

export function parseEditedMemoryItem(value: unknown): EditedMemoryItem {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const supersededId = str(source, "supersededId");
  if (supersededId === undefined) throw new WireShapeError();
  return { item: requireItem(source.item), evidence: requireEvidence(source), supersededId };
}

/** What a consolidation revert undid: a merge, a decision closing (`superseded`) or a decay. */
export type ConsolidationRevertKind = "merged" | "superseded" | "decayed";

export interface RevertedConsolidation {
  reverted: ConsolidationRevertKind;
  itemId: string;
}

export function parseRevertedConsolidation(value: unknown): RevertedConsolidation {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const reverted = str(source, "reverted");
  const itemId = str(source, "itemId");
  if (
    itemId === undefined ||
    (reverted !== "merged" && reverted !== "superseded" && reverted !== "decayed")
  ) {
    throw new WireShapeError();
  }
  return { reverted, itemId };
}

/** How many item rows a forget removed (the item plus its older versions). */
const RESET_COUNT_KEYS = [
  "digests",
  "items",
  "evidence",
  "topics",
  "topicSummaries",
  "embeddings",
  "proposals",
  "servings",
  "consolidationPairs",
  "consolidationState",
] as const;

export function parseMemoryResetResult(value: unknown): MemoryResetResult {
  const epoch = num(value, "epoch");
  const deleted = record(record(value)?.deleted);
  if (epoch === undefined || deleted === null) throw new WireShapeError();
  const counts: Record<string, number> = {};
  for (const key of RESET_COUNT_KEYS) {
    const count = num(deleted, key);
    if (count === undefined) throw new WireShapeError();
    counts[key] = count;
  }
  return { epoch, deleted: counts as unknown as MemoryResetCounts };
}

const NOTICE_SENDS: readonly string[] = [
  "channel_message_text",
  "author_display_name",
  "agent_dm_message_text",
];
const NOTICE_NEVER_SENDS: readonly string[] = [
  "human_direct_messages",
  "attachments",
  "deleted_messages",
  "excluded_channels",
  "paused_members_dms",
];

/** Known codes only: a code this client does not know is dropped (a newer server), not shown raw. */
function noticeCodes<T extends string>(source: unknown, key: string, known: readonly string[]): T[] {
  const raw = stringArrayField(source, key);
  if (raw === null) throw new WireShapeError();
  return raw.filter((code): code is T => known.includes(code));
}

export function parseMemoryNotice(value: unknown): MemoryNotice {
  const enabled = bool(value, "enabled");
  const paused = bool(value, "paused");
  const sending = bool(value, "sending");
  const resetEpoch = num(value, "resetEpoch");
  const summarySource = record(record(value)?.summary);
  const embeddingsSource = record(record(value)?.embeddings);
  if (
    enabled === undefined ||
    paused === undefined ||
    sending === undefined ||
    resetEpoch === undefined ||
    summarySource === null ||
    embeddingsSource === null
  ) {
    throw new WireShapeError();
  }
  const configured = bool(summarySource, "configured");
  const model = str(embeddingsSource, "model");
  if (configured === undefined || model === undefined) throw new WireShapeError();
  // The embeddings are local by contract; a server that says otherwise is a wire error, never a quiet "OK".
  if (str(embeddingsSource, "location") !== "local" || bool(embeddingsSource, "sentToProvider") !== false) {
    throw new WireShapeError();
  }
  const summary: MemoryNotice["summary"] = { configured };
  const providerSource = record(summarySource.provider);
  if (providerSource !== null) {
    const name = str(providerSource, "name");
    const host = str(providerSource, "host");
    if (name === undefined || host === undefined) throw new WireShapeError();
    summary.provider = { name, host };
  }
  const modelId = str(summarySource, "modelId");
  if (modelId !== undefined) summary.modelId = modelId;
  return {
    enabled,
    paused,
    sending,
    resetEpoch,
    summary,
    embeddings: { model, location: "local", sentToProvider: false },
    sends: noticeCodes<MemoryNoticeSends>(value, "sends", NOTICE_SENDS),
    neverSends: noticeCodes<MemoryNoticeNeverSends>(value, "neverSends", NOTICE_NEVER_SENDS),
  };
}

export function parseForgottenCount(value: unknown): number {
  const count = num(value, "forgottenCount");
  if (count === undefined) throw new WireShapeError();
  return count;
}

/**
 * The missed-conversation card shows nothing until the worker has caught up to
 * the reader's cursor; `summarizedThroughSeq` tells "nothing to summarize" from
 * "not summarized yet".
 */
export function memoryIsCaughtUp(page: MemoryDigestPage, latestSeq: number): boolean {
  return page.summarizedThroughSeq !== undefined && page.summarizedThroughSeq >= latestSeq;
}
