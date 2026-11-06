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
 * `set.vectors.json` next to this file (the core cannot read outside itself, so the server slice reads it from here or from a byte-equal
 * copy under `docs/api/`; which of the two is the planner's call, #5442 handoff); this file does not enforce anything by itself.
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
  /**
   * The set's shared description (`prompt`, recorded as the `origin.prompt` of every registered picture). Every slot's request to Hermes is
   * this + a line break + that slot's `scene` (at most `sceneChars`), and ADR-0201 P1 caps one request at `requestChars`:
   * 800 + 1 + 300 = 1,101 fits inside 1,200 whatever the scene says (ADR-0218 §12 L2.4-2, security review H2).
   */
  promptChars: 800,
  sceneChars: 300,
  requestChars: 1200,
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

/**
 * L20 (owner 2026-11-06): who makes the pictures. `hermes` is on. `team_image_model` (the team's own image key,
 * ADR-0218 §8 H9) is a **reserved name**: a plan may carry it, the server refuses it, and no code path exists
 * behind it yet. The card, the approval and the registration are the same whatever the backend is.
 */
export const EXPRESSION_SET_BACKENDS = ["hermes", "team_image_model"] as const;
export type ExpressionSetBackend = (typeof EXPRESSION_SET_BACKENDS)[number];
export const EXPRESSION_SET_BACKEND_ENABLED: Readonly<Record<ExpressionSetBackend, boolean>> = { hermes: true, team_image_model: false };
/** True only for a backend that may make pictures now. A word this build does not know is off, never on. */
export function expressionSetBackendEnabled(backend: unknown): boolean {
  return typeof backend === "string" && Object.hasOwn(EXPRESSION_SET_BACKEND_ENABLED, backend) && EXPRESSION_SET_BACKEND_ENABLED[backend as ExpressionSetBackend];
}

/**
 * L18 (owner 2026-11-06): the reference pictures one set is made from. The SERVER picks them from the trigger
 * message of the run (the requester's own images on the request itself); no model, agent or client names an
 * attachment id. Every slot of a set uses the same bundle. Numbers and where they come from:
 *  - pictures 4: the planner's recommendation; more dilutes the reference and multiplies tokens.
 *  - input: what a requester attachment read already allows (`SELF_MEDIA_MAX_BYTES` 5 MiB) and the D3 still-picture
 *    input (a side up to 4096, 16,000,000 pixels in all). PNG, JPEG, WebP only.
 *  - prepared: the isolated decoder's `prepare` step as it is (EXIF upright, long edge 1024, encoded again from the
 *    pixels, alpha stays PNG else JPEG q90, at most 4 MiB each); the bundle is held to that same 4 MiB in total,
 *    so what leaves for Hermes never exceeds what one photo already sends to an image model (H11).
 */
export const EXPRESSION_SET_REFERENCE_LIMITS = {
  pictures: 4,
  inputBytes: 5 * MIB,
  inputEdge: 4096,
  inputPixels: 16_000_000,
  preparedEdge: 1024,
  preparedBytesEach: 4 * MIB,
  bundleBytes: 4 * MIB,
  mimes: ["image/png", "image/jpeg", "image/webp"],
} as const;

/** L7.7 (owner 2026-11-06, O2): three refusals in a row close every still not yet tried. */
export const EXPRESSION_SET_REFUSAL_STREAK = 3;

/** L7: why a slot has no picture. A closed list; the server maps its own reasons onto these four. */
export const EXPRESSION_SET_GRAY_CODES = ["refused", "failed", "not_made", "base_missing"] as const;
export type ExpressionSetGrayCode = (typeof EXPRESSION_SET_GRAY_CODES)[number];
/** L6: why a chosen slot was left out of a registration. */
export const EXPRESSION_SET_SKIP_REASONS = ["name_taken", "quota"] as const;
export type ExpressionSetSkipReason = (typeof EXPRESSION_SET_SKIP_REASONS)[number];
export type ExpressionSetKind = "still" | "gif";

/** A reference picture as the card records it: a pointer into the conversation, never a key to open it (G1). */
export interface ExpressionSetReference {
  attachmentId: string;
}

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
  /**
   * The reference pictures the set was made from, in the order they were sent: the server's own reading of the
   * trigger message (L18). Empty = made from words alone. Pointers only; the pictures open through the conversation.
   */
  references: ExpressionSetReference[];
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
    /** The server's word, not the model's: which backend makes the pictures (L20). */
    backend: ExpressionSetBackend;
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
    // The first reference stands for the bundle: an expression has one pointer (G1) and no set (L18).
    origin: { kind: "generated", sourceUrl: null, prompt: set.prompt, sourceAttachmentId: set.references[0]?.attachmentId ?? null },
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

// ---------------------------------------------------------------------------------------------------------------
// L18: the reference bundle. The server reads rows first (mime, bytes, size), asks the person, and only then reads
// bytes; `prepared` is absent until the isolated decoder has run. One failing picture refuses the whole bundle:
// nothing is dropped quietly, because "the same bundle for every slot" must mean the bundle the person attached.
// ---------------------------------------------------------------------------------------------------------------
export interface ExpressionSetReferenceProbe {
  attachmentId: string;
  /** The type the attachment row records. */
  mime: string;
  bytes: number;
  width: number;
  height: number;
  /** What the isolated decoder's prepare step made of it; absent while no byte has been read yet. */
  prepared?: { mime: "image/png" | "image/jpeg"; bytes: number };
}
/** In the order the verdict lists them. */
export const EXPRESSION_SET_REFERENCE_ISSUES = ["too_many", "duplicate", "format", "input_bytes", "input_pixels", "prepared_bytes", "bundle_bytes"] as const;
export type ExpressionSetReferenceIssueKind = (typeof EXPRESSION_SET_REFERENCE_ISSUES)[number];
export interface ExpressionSetReferenceIssue {
  /** The picture it is about, or null for a rule about the bundle. */
  index: number | null;
  issue: ExpressionSetReferenceIssueKind;
}

export function expressionSetReferenceIssues(probes: readonly ExpressionSetReferenceProbe[]): ExpressionSetReferenceIssue[] {
  const limits = EXPRESSION_SET_REFERENCE_LIMITS;
  const issues: ExpressionSetReferenceIssue[] = [];
  const seen = new Set<string>();
  let bundle = 0;
  probes.forEach((probe, index) => {
    if (seen.has(probe.attachmentId)) issues.push({ index, issue: "duplicate" });
    seen.add(probe.attachmentId);
    if (!(limits.mimes as readonly string[]).includes(probe.mime)) issues.push({ index, issue: "format" });
    if (probe.bytes > limits.inputBytes) issues.push({ index, issue: "input_bytes" });
    const sized = probe.width >= 1 && probe.height >= 1;
    if (!sized || probe.width > limits.inputEdge || probe.height > limits.inputEdge || probe.width * probe.height > limits.inputPixels) issues.push({ index, issue: "input_pixels" });
    if (probe.prepared) {
      if (probe.prepared.bytes > limits.preparedBytesEach) issues.push({ index, issue: "prepared_bytes" });
      bundle += probe.prepared.bytes;
    }
  });
  if (probes.length > limits.pictures) issues.push({ index: null, issue: "too_many" });
  if (bundle > limits.bundleBytes) issues.push({ index: null, issue: "bundle_bytes" });
  return issues;
}

export type ExpressionSetReferenceVerdict =
  | { ok: true; count: number; bundleBytes: number }
  | { ok: false; refused: ExpressionSetReferenceIssueKind[] };

/** 「첨부한 그림 N장이 Hermes의 그림 모델로 전송돼요」: shown before any byte leaves, once per request, naming no company (F10). */
export function expressionSetReferenceNotice(count: number): string {
  return expressionSetCopy("expressions.set.reference.notice", { count });
}

/** What the requester is told when the bundle was not sent: one line per thing to fix, never a retry hint about moderation. */
export function expressionSetReferenceLine(issue: ExpressionSetReferenceIssueKind): string {
  const limits = EXPRESSION_SET_REFERENCE_LIMITS;
  return expressionSetCopy(`expressions.set.reference.refused.${issue}`, { max: limits.pictures, mb: limits.inputBytes / MIB });
}

/** No picture at all is a fine bundle (words alone); any issue refuses the whole bundle. */
export function expressionSetReferenceVerdict(probes: readonly ExpressionSetReferenceProbe[]): ExpressionSetReferenceVerdict {
  const issues = expressionSetReferenceIssues(probes);
  if (issues.length > 0) {
    const kinds = new Set(issues.map((entry) => entry.issue));
    return { ok: false, refused: EXPRESSION_SET_REFERENCE_ISSUES.filter((kind) => kinds.has(kind)) };
  }
  return { ok: true, count: probes.length, bundleBytes: probes.reduce((sum, probe) => sum + (probe.prepared?.bytes ?? 0), 0) };
}

// ---------------------------------------------------------------------------------------------------------------
// L7.7: stills are made in index order, one delegation each (ADR-0201 P4-5: at most once). The streak closes the set.
// ---------------------------------------------------------------------------------------------------------------
export type ExpressionSetAttempt = "made" | "refused" | "failed";
export type ExpressionSetStillOutcome = ExpressionSetAttempt | "not_made";

/**
 * May the server make another delegation, given how the attempts so far ended? Not once three refusals in a row have been seen:
 * a made or failed attempt starts the count over (a timeout says nothing about whether the model will draw the next scene), but a
 * set that reached three in a row stays closed whatever came after. This is the one decision the server's loop asks before every
 * call, and the one the vectors measure.
 */
export function expressionSetMayTryNext(attempts: readonly ExpressionSetAttempt[]): boolean {
  let streak = 0;
  for (const attempt of attempts) {
    streak = attempt === "refused" ? streak + 1 : 0;
    if (streak >= EXPRESSION_SET_REFUSAL_STREAK) return false;
  }
  return true;
}

/**
 * What every still ended as, given the outcomes of the attempts in the order they were made. A still that the server
 * was not allowed to try ([`expressionSetMayTryNext`]) or never got to (time, a cap, a cancel) is `not_made`, and an attempt
 * that somehow comes after the set closed is ignored (the server stops there).
 */
export function settleExpressionSetStills(total: number, attempts: readonly ExpressionSetAttempt[]): ExpressionSetStillOutcome[] {
  const outcomes: ExpressionSetStillOutcome[] = [];
  for (let index = 0; index < total; index += 1) {
    outcomes.push(index < attempts.length && expressionSetMayTryNext(attempts.slice(0, index)) ? attempts[index] : "not_made");
  }
  return outcomes;
}

/**
 * A GIF is not made by Hermes: the server moves a still. So a closed streak does not stop a GIF whose still exists,
 * and a GIF whose still is grey (refused, failed or never made) is `base_missing` (L7.3-4). Out-of-range = missing.
 */
export function settleExpressionSetGifs(stills: readonly ExpressionSetStillOutcome[], bases: readonly number[]): Array<"made" | "base_missing"> {
  return bases.map((base) => (stills[base] === "made" ? "made" : "base_missing"));
}

/** The grey code a still that did not become a picture shows. */
export function expressionSetGrayCodeOf(outcome: Exclude<ExpressionSetStillOutcome, "made">): ExpressionSetGrayCode {
  return outcome;
}
