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

export interface MemoryReceipt {
  runId: string;
  channelId: string;
  /** Everything the run was served — the chip's n. */
  servedCount: number;
  /** Served digests the caller can read today. */
  digestIds: string[];
  digests: MemoryDigest[];
  /** Requester only; a count, never content. */
  withheldCount?: number;
  budgetChars: number;
  usedChars: number;
  createdAtMs: number;
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

export type MemoryItemKind = "decision" | "fact" | "commitment" | "preference" | "procedure";
export type MemoryItemOrigin = "extracted" | "confirmed" | "curated" | "synthesized";
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

function isItemKind(value: string | undefined): value is MemoryItemKind {
  return (
    value === "decision" ||
    value === "fact" ||
    value === "commitment" ||
    value === "preference" ||
    value === "procedure"
  );
}

function isItemOrigin(value: string | undefined): value is MemoryItemOrigin {
  return (
    value === "extracted" || value === "confirmed" || value === "curated" || value === "synthesized"
  );
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

/** How many item rows a forget removed (the item plus its older versions). */
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
