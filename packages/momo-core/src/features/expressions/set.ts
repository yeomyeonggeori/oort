import { expressionChoice, matchesExpressionChoice } from "./cards";
import { matchesExpressionContract } from "./contracts";
import { recommendExpressionKind } from "./kind";
import { expressionSetCopy, expressionSetGrayLine } from "./setCopy";
import { EXPRESSION_KINDS, EXPRESSION_LIMITS } from "./types";
import type { ExpressionChoice, ExpressionDraft, ExpressionKind, ExpressionMedia, ExpressionResult } from "./types";

/**
 * ADR-0218 §12 (증보 6, #5442): the team AI ("oort 도우미") proposes a SET of pictures, a person approves it
 * once, and the server registers the pictures the person kept. This module is the executable form of that
 * contract for the clients and the fake server: the wire types (the schema is `set.schema.json`), the
 * numbers, and the pure rules (what the card shows, what a selection is, how one decision turns into
 * registered / skipped items). The server implements the same rules in Rust against
 * `docs/api/expression-set.vectors.json`; this file does not enforce anything by itself.
 */
export const EXPRESSION_SET_ACTION_ID = "expression.set.create" as const;

const MIB = 1024 * 1024;

/** Every number of the set proposal, with the section of §12 that explains it. */
export const EXPRESSION_SET_LIMITS = {
  /** L4: one proposal holds at most this many slots, the grey ones included (owner 2026-11-06). */
  slots: 40,
  /** L4: what the tool makes when the person names no number: 8 stills (6 with words, 2 without) and 2 GIFs. */
  defaultCaptionStills: 6,
  defaultPlainStills: 2,
  defaultGifs: 2,
  /** L9: the set's title, its name prefix and its shared tags. */
  titleChars: 40,
  prefixMin: 2,
  prefixMax: 12,
  commonTags: 3,
  slotTags: 5,
  promptChars: 2000,
  /** L8: sets one agent may have undecided (being made, or waiting for a person). General proposals keep their 3. */
  undecidedPerAgent: 1,
  /** L4: one picture as the model returns it (D3 input, ADR-0201 P6). */
  pictureInputBytes: 5 * MIB,
  /** L4: one slot once stored: small + large + thumb at their D3 ceilings. */
  slotStoredBytes: 256 * 1024 + MIB + 256 * 1024,
  /** L4: all renditions of all ready slots of one set. Measured worst case of 40 slots is about 19 MB. */
  storedBytes: 24 * MIB,
  /** L8: how long the server keeps a set that is still being made. The approval window is the approvals default. */
  stagingSeconds: 2 * 60 * 60,
} as const;

/** L7: why a slot has no picture. A closed list; the server maps its own reasons onto these four. */
export const EXPRESSION_SET_GRAY_CODES = ["refused", "failed", "not_made", "base_missing"] as const;
export type ExpressionSetGrayCode = (typeof EXPRESSION_SET_GRAY_CODES)[number];
/** L6: why a chosen slot was left out of a registration. */
export const EXPRESSION_SET_SKIP_REASONS = ["name_taken", "quota"] as const;
export type ExpressionSetSkipReason = (typeof EXPRESSION_SET_SKIP_REASONS)[number];
export type ExpressionSetKind = "still" | "gif";

export interface ExpressionSetReadySlot {
  index: number;
  kind: ExpressionSetKind;
  state: "ready";
  code: null;
  draftId: string;
  revision: string;
  name: string;
  displayName: string;
  tags: string[];
  media: ExpressionMedia;
}
/** A slot nothing was made for. It holds no picture, no draft and no id: nothing can name it in a choice. */
export interface ExpressionSetGraySlot {
  index: number;
  kind: ExpressionSetKind;
  state: "gray";
  code: ExpressionSetGrayCode;
  name: string;
  displayName: string;
  tags: string[];
}
export type ExpressionSetSlot = ExpressionSetReadySlot | ExpressionSetGraySlot;

/** `approval_request.props.action.expressionSet` (L5): authored only by the server. */
export interface ExpressionSetApproval {
  v: 1;
  workspaceId: string;
  setId: string;
  title: string;
  /** Every name of the set starts with `<prefix>_` (L9). */
  prefix: string;
  /** One face (or none) for the whole set, as for the candidates of `expression.create`. */
  subjectMemberId: string | null;
  /** The agent-written text every picture of the set is recorded with (its `origin.prompt`). */
  prompt: string;
  /** The server's own reading of the photo the pictures were made from; null = made from words alone. */
  sourceAttachmentId: string | null;
  expiresAtMs: number;
  slots: ExpressionSetSlot[];
}

export interface ExpressionSetPlanSlot {
  index: number;
  name: string;
  displayName: string;
  tags: string[];
}
/** What the team AI proposes (L5). No picture bytes: the pictures wait on the server under `setId` (L3). */
export interface ExpressionSetAction {
  action: typeof EXPRESSION_SET_ACTION_ID;
  args: {
    setId: string;
    title: string;
    prefix: string;
    tags: string[];
    subjectMemberId: string | null;
    prompt: string;
    slots: ExpressionSetPlanSlot[];
  };
}
/** The decision request's new field (L6), next to the single `expressionChoice` of `expression.create`. */
export interface ExpressionSetDecision {
  expressionChoices: ExpressionChoice[];
}
export interface ExpressionSetSkip {
  draftId: string;
  name: string;
  reason: ExpressionSetSkipReason;
}
/** `props.result.expressionSet` of the settled card and of the receipt (L6). */
export interface ExpressionSetResult {
  setId: string;
  registered: ExpressionResult[];
  skipped: ExpressionSetSkip[];
}
/** A card as the fake server hosts it: the approval row's id and what the card shows. */
export interface ExpressionSetCard {
  approvalId: string;
  approval: ExpressionSetApproval;
}
/** The part of the decision receipt the set adds; the real receipt carries more fields. */
export interface ExpressionSetDecisionReceipt {
  status: "executed" | "rejected";
  approvalId: string;
  result: { actionId: typeof EXPRESSION_SET_ACTION_ID; ref: { type: "expression_set"; id: string }; expressionSet: ExpressionSetResult } | null;
}

export function readySlots(set: ExpressionSetApproval): ExpressionSetReadySlot[] {
  return set.slots.filter((slot): slot is ExpressionSetReadySlot => slot.state === "ready");
}

/**
 * The `Draft` the server holds behind a ready slot (the pictures are drafts of the approval until it is
 * decided). The card carries the shared strings once, so the draft is put back together from the set: it
 * lets every draft-based helper (`expressionChoice`, `expressionDraftCard`, the preview URL) work as it does
 * for `expression.create`, and nothing in the set needs a second set of them.
 */
export function expressionSetSlotDraft(set: ExpressionSetApproval, slot: ExpressionSetReadySlot): ExpressionDraft {
  return {
    draftId: slot.draftId, workspaceId: set.workspaceId, revision: slot.revision,
    name: slot.name, displayName: slot.displayName, tags: slot.tags, subjectMemberId: set.subjectMemberId,
    origin: { kind: "generated", sourceUrl: null, prompt: set.prompt, sourceAttachmentId: set.sourceAttachmentId },
    expiresAtMs: set.expiresAtMs, state: "ready", code: null, media: slot.media,
  };
}

/** What a ready slot costs once stored: its three renditions. */
export function expressionSlotStoredBytes(slot: ExpressionSetReadySlot): number {
  return slot.media.small.bytes + slot.media.large.bytes + slot.media.thumb.bytes;
}
export function expressionSetStoredBytes(set: ExpressionSetApproval): number {
  return readySlots(set).reduce((sum, slot) => sum + expressionSlotStoredBytes(slot), 0);
}
export function expressionSetWithinBudget(set: ExpressionSetApproval): boolean {
  return set.slots.length <= EXPRESSION_SET_LIMITS.slots && expressionSetStoredBytes(set) <= EXPRESSION_SET_LIMITS.storedBytes;
}

export type ExpressionSetIssue =
  | { index: number; issue: "name_invalid" | "prefix_mismatch" | "duplicate_name" | "duplicate_index" | "kind_mime_mismatch" | "duplicate_draft" }
  | { index: null; issue: "over_slots" | "over_bytes" };

const NAME = /^[a-z0-9_-]{2,30}$/;

/**
 * The rules JSON Schema cannot say (L9, L5): the names of a set are unique and start with `<prefix>_`, an index
 * is used once, a picture's kind agrees with the file it is (a still is a PNG, a GIF is a GIF), a draft appears
 * once, and the whole set is inside its budget. The server enforces exactly these when it composes the card.
 */
export function expressionSetIssues(set: ExpressionSetApproval): ExpressionSetIssue[] {
  const issues: ExpressionSetIssue[] = [];
  const names = new Set<string>();
  const indexes = new Set<number>();
  const drafts = new Set<string>();
  for (const slot of set.slots) {
    if (indexes.has(slot.index)) issues.push({ index: slot.index, issue: "duplicate_index" });
    indexes.add(slot.index);
    if (!NAME.test(slot.name)) issues.push({ index: slot.index, issue: "name_invalid" });
    else if (!slot.name.startsWith(`${set.prefix}_`) || slot.name.length <= set.prefix.length + 1) issues.push({ index: slot.index, issue: "prefix_mismatch" });
    if (names.has(slot.name)) issues.push({ index: slot.index, issue: "duplicate_name" });
    names.add(slot.name);
    if (slot.state === "ready") {
      if (drafts.has(slot.draftId)) issues.push({ index: slot.index, issue: "duplicate_draft" });
      drafts.add(slot.draftId);
      if ((slot.kind === "gif") !== (slot.media.large.mime === "image/gif")) issues.push({ index: slot.index, issue: "kind_mime_mismatch" });
    }
  }
  if (set.slots.length > EXPRESSION_SET_LIMITS.slots) issues.push({ index: null, issue: "over_slots" });
  if (expressionSetStoredBytes(set) > EXPRESSION_SET_LIMITS.storedBytes) issues.push({ index: null, issue: "over_bytes" });
  return issues;
}

export interface ExpressionSetSlotView {
  index: number;
  kind: ExpressionSetKind;
  name: string;
  displayName: string;
  /** Only a ready slot of an open card can be kept. */
  selectable: boolean;
  /** A grey slot never offers an upload, a retry or a replacement (L7). */
  canUpload: false;
  grayCode: ExpressionSetGrayCode | null;
  /** The sentence under a grey slot; null for a ready one. */
  line: string | null;
  draftId: string | null;
}
export interface ExpressionSetCardView {
  state: "pending" | "settled" | "expired";
  total: number;
  ready: number;
  gray: number;
  stills: { ready: number; total: number };
  gifs: { ready: number; total: number };
  slots: ExpressionSetSlotView[];
  /** At least one ready slot on an open card. Nothing here is "pick one of N": the person keeps any number. */
  canApprove: boolean;
  question: string;
  rights: string;
  /** 「그림 n개」 and, when there are any, 「만들지 못한 장면 n개」; numbers only (ADR-0218 G5). */
  summary: string;
}

/** What the card of a set shows. `pending` is whether the approval is still open; expiry closes it too. */
export function expressionSetCard(set: ExpressionSetApproval, nowMs: number, pending = true): ExpressionSetCardView {
  const open = pending && nowMs < set.expiresAtMs;
  const slots = [...set.slots].sort((a, b) => a.index - b.index);
  const ready = slots.filter((slot) => slot.state === "ready");
  const count = (kind: ExpressionSetKind) => ({ ready: ready.filter((slot) => slot.kind === kind).length, total: slots.filter((slot) => slot.kind === kind).length });
  const gray = slots.length - ready.length;
  const parts = [expressionSetCopy("expressions.set.summary.ready", { count: ready.length })];
  if (gray > 0) parts.push(expressionSetCopy("expressions.set.summary.gray", { count: gray }));
  return {
    state: !pending ? "settled" : nowMs >= set.expiresAtMs ? "expired" : "pending",
    total: slots.length, ready: ready.length, gray, stills: count("still"), gifs: count("gif"),
    slots: slots.map((slot) => ({
      index: slot.index, kind: slot.kind, name: slot.name, displayName: slot.displayName,
      selectable: open && slot.state === "ready", canUpload: false as const,
      grayCode: slot.state === "gray" ? slot.code : null,
      line: slot.state === "gray" ? expressionSetGrayLine(slot.code) : null,
      draftId: slot.state === "ready" ? slot.draftId : null,
    })),
    canApprove: open && ready.length > 0,
    question: expressionSetCopy("expressions.set.question"),
    rights: expressionSetCopy("expressions.set.rights"),
    summary: parts.join(" · "),
  };
}

/**
 * The choices a decision sends for the slots the person kept (`only` = their indexes, default every ready slot).
 * Each carries what the person saw (draft, revision, the large picture's hash) and, if they chose one, a `kind`.
 * Null when nothing can be sent: the card is closed, or nothing kept names a ready slot. A grey slot or an index
 * the card does not have is not an error here, it is simply not a choice: there is no id to send for it.
 */
export function expressionSetChoices(
  set: ExpressionSetApproval,
  nowMs: number,
  options: { only?: readonly number[]; kinds?: Readonly<Record<number, ExpressionKind>> } = {},
): ExpressionChoice[] | null {
  const keep = options.only ? new Set(options.only) : null;
  const choices: ExpressionChoice[] = [];
  for (const slot of [...readySlots(set)].sort((a, b) => a.index - b.index)) {
    if (keep && !keep.has(slot.index)) continue;
    const choice = expressionChoice(expressionSetSlotDraft(set, slot), nowMs, options.kinds?.[slot.index]);
    if (choice) choices.push(choice);
  }
  return choices.length > 0 ? choices : null;
}

export interface ExpressionSetRegistration {
  draftId: string;
  name: string;
  kind: ExpressionKind;
}
export type ExpressionSetRefusal = "expression_choice_invalid" | "expression_preview_stale" | "expression_name_reserved" | "expression_quota";
export type ExpressionSetVerdict =
  | { ok: true; registered: ExpressionSetRegistration[]; skipped: ExpressionSetSkip[] }
  | { ok: false; status: 400 | 409; code: ExpressionSetRefusal };

export interface ExpressionSetDecisionInput {
  approval: ExpressionSetApproval;
  choices: readonly unknown[];
  nowMs: number;
  /** Every name the workspace ever registered: a deleted name stays taken for good (D1). */
  taken: ReadonlySet<string>;
  /** Registrations that are not deleted (active and hidden): what the 1,000 ceiling counts (D2). */
  live: number;
  quota?: number;
}

/**
 * One decision, turned into registered and skipped items (L6). The order of the request does not matter: the
 * items are taken in slot order, so the same card and the same workspace always give the same answer.
 *
 * - A malformed list, a duplicate draft, a kind outside the closed two: 400 `expression_choice_invalid`.
 * - A draft that is not a ready slot of this card, a revision or hash that is not what the card showed, a card that
 *   expired: 409 `expression_preview_stale` for the **whole** decision, and nothing is registered.
 * - A name the workspace already has is **skipped** (`name_taken`), and so is every item past the ceiling (`quota`).
 *   Those are races the person could not see. A skip never stops the others.
 * - Nothing registered at all: 409 `expression_name_reserved` (some name was taken) or `expression_quota`. The
 *   approval is not spent.
 */
export function decideExpressionSet(input: ExpressionSetDecisionInput): ExpressionSetVerdict {
  const quota = input.quota ?? EXPRESSION_LIMITS.workspace;
  const { approval, choices } = input;
  const invalid = { ok: false, status: 400, code: "expression_choice_invalid" } as const;
  const stale = { ok: false, status: 409, code: "expression_preview_stale" } as const;
  if (!Array.isArray(choices) || choices.length < 1 || choices.length > EXPRESSION_SET_LIMITS.slots) return invalid;
  const seen = new Set<string>();
  const picked: Array<{ slot: ExpressionSetReadySlot; choice: ExpressionChoice }> = [];
  const bySlot = new Map(readySlots(approval).map((slot) => [slot.draftId, slot]));
  for (const raw of choices) {
    if (!matchesExpressionContract("Choice", raw)) return invalid;
    const choice = raw as ExpressionChoice;
    if (choice.kind !== undefined && !EXPRESSION_KINDS.includes(choice.kind)) return invalid;
    if (seen.has(choice.draftId)) return invalid;
    seen.add(choice.draftId);
    const slot = bySlot.get(choice.draftId);
    if (!slot || !matchesExpressionChoice(expressionSetSlotDraft(approval, slot), choice, input.nowMs)) return stale;
    picked.push({ slot, choice });
  }
  picked.sort((a, b) => a.slot.index - b.slot.index);
  let live = input.live;
  const registered: ExpressionSetRegistration[] = [];
  const skipped: ExpressionSetSkip[] = [];
  for (const { slot, choice } of picked) {
    if (input.taken.has(slot.name)) skipped.push({ draftId: slot.draftId, name: slot.name, reason: "name_taken" });
    else if (live >= quota) skipped.push({ draftId: slot.draftId, name: slot.name, reason: "quota" });
    else {
      live += 1;
      registered.push({ draftId: slot.draftId, name: slot.name, kind: choice.kind ?? recommendExpressionKind(slot.media.large) });
    }
  }
  if (registered.length === 0) {
    return { ok: false, status: 409, code: skipped.some((skip) => skip.reason === "name_taken") ? "expression_name_reserved" : "expression_quota" };
  }
  return { ok: true, registered, skipped };
}

/** 「8개를 팀 보관함에 저장했어요」, or with the skipped ones named by count. */
export function expressionSetResultLine(result: ExpressionSetResult): string {
  return result.skipped.length === 0
    ? expressionSetCopy("expressions.set.result.saved", { count: result.registered.length })
    : expressionSetCopy("expressions.set.result.savedSkipped", { saved: result.registered.length, skipped: result.skipped.length });
}

/** The set result of a receipt, or null when the value is not exactly that shape. */
export function parseExpressionSetResult(value: unknown): ExpressionSetResult | null {
  return matchesExpressionContract("SetResult", value) ? (value as ExpressionSetResult) : null;
}
