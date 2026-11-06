import { FIXTURE_MEDIA } from "./fixtureMedia";
import { FIXTURE_NOW_MS, FIXTURE_WORKSPACE_ID } from "./fixtures";
import type {
  ExpressionSetAction, ExpressionSetApproval, ExpressionSetCard, ExpressionSetGrayCode, ExpressionSetGraySlot, ExpressionSetKind,
  ExpressionSetReadySlot, ExpressionSetReference, ExpressionSetReferenceProbe, ExpressionSetSlot,
} from "./set";
import type { ExpressionMedia } from "./types";

/**
 * Fixtures of the set proposal (ADR-0218 §12, #5442). The names are plain words on purpose: a set is
 * `cat_*`, and nothing here names a real character, person or conversation.
 *
 * Four cards, each one a case the server and the screens must handle:
 *  - `FIXTURE_SET_NORMAL`: the default set, 8 stills (6 with words, 2 without) and 2 GIFs, all ready;
 *  - `FIXTURE_SET_REFUSED`: the same plan where the model refused two scenes, a third failed, one was never
 *    made, and the GIF that needed a refused still has no base: five grey slots of all four codes;
 *  - `FIXTURE_SET_SAME_NAME`: one name of the set is already in the team library (`thumbs_up`);
 *  - `fixtureSetOverLimit()`: 41 slots, one past the ceiling (it must be refused, never shown).
 * And the pieces of the reference input and the closing rule (ADR-0218 §12 L18, L7.7, L20):
 *  - `FIXTURE_SET_REFERENCE_PROBES`: two attached pictures that pass; `...TOO_MANY` (5), `...BAD_FORMAT` (a GIF and a
 *    HEIC next to a PNG), `...OVER_BYTES` (four that fit one by one and not together), `...TOO_BIG_INPUT` are refused;
 *  - `FIXTURE_SET_STREAK_CLOSED`: three refusals in a row closed the rest of the stills;
 *  - `FIXTURE_SET_ACTION_RESERVED_BACKEND`: a plan that names the reserved backend, which the server must refuse.
 */
export const FIXTURE_SET_ID = "00000000-0000-4000-8000-000000000401";
export const FIXTURE_SET_APPROVAL_ID = "00000000-0000-4000-8000-000000000411";
export const FIXTURE_SET_REFUSED_APPROVAL_ID = "00000000-0000-4000-8000-000000000412";
export const FIXTURE_SET_SAME_NAME_APPROVAL_ID = "00000000-0000-4000-8000-000000000413";
export const FIXTURE_SET_PROMPT = "둥근 얼굴의 고양이가 인사하고 기뻐하는 메신저 스티커 세트";

export function fixtureSetDraftId(index: number): string {
  return `00000000-0000-4000-8000-0000000003${index.toString(16).padStart(2, "0")}`;
}

function mediaOf(kind: ExpressionSetKind): ExpressionMedia {
  return kind === "gif"
    ? { small: { ...FIXTURE_MEDIA.gif.image }, large: { ...FIXTURE_MEDIA.gif.image }, thumb: { ...FIXTURE_MEDIA.png.image } }
    : { small: { ...FIXTURE_MEDIA.png.image }, large: { ...FIXTURE_MEDIA.png.image }, thumb: { ...FIXTURE_MEDIA.png.image } };
}

export function fixtureSetReadySlot(index: number, kind: ExpressionSetKind, name: string, displayName: string, tags: string[] = []): ExpressionSetReadySlot {
  return { index, kind, state: "ready", code: null, draftId: fixtureSetDraftId(index), revision: "1", name, displayName, tags, media: mediaOf(kind) };
}
export function fixtureSetGraySlot(index: number, kind: ExpressionSetKind, code: ExpressionSetGrayCode, name: string, displayName: string, tags: string[] = []): ExpressionSetGraySlot {
  return { index, kind, state: "gray", code, name, displayName, tags };
}

/** Two attachments of the request message: the set below was made from both (ADR-0218 §12 L18). */
export const FIXTURE_SET_REFERENCE_IDS = ["00000000-0000-4000-8000-000000000431", "00000000-0000-4000-8000-000000000432"] as const;
export const FIXTURE_SET_REFERENCES: ExpressionSetReference[] = FIXTURE_SET_REFERENCE_IDS.map((attachmentId) => ({ attachmentId }));

/** One attached picture as the server's rows describe it (and, once read, what the isolated decoder made of it). */
export function fixtureSetReferenceProbe(n: number, over: Partial<ExpressionSetReferenceProbe> = {}): ExpressionSetReferenceProbe {
  return {
    attachmentId: `00000000-0000-4000-8000-0000000004${(0x30 + n).toString(16)}`, mime: "image/png", bytes: 320_000, width: 800, height: 600,
    prepared: { mime: "image/png", bytes: 310_000 }, ...over,
  };
}
/** Two pictures that pass: a PNG and a JPEG, together under a megabyte once prepared. */
export const FIXTURE_SET_REFERENCE_PROBES: ExpressionSetReferenceProbe[] = [
  fixtureSetReferenceProbe(1),
  fixtureSetReferenceProbe(2, { mime: "image/jpeg", bytes: 180_000, width: 1024, height: 768, prepared: { mime: "image/jpeg", bytes: 150_000 } }),
];
/** One picture more than the bundle takes (five). The server refuses all of them; it does not keep the first four. */
export function fixtureSetReferenceProbesTooMany(): ExpressionSetReferenceProbe[] {
  return [1, 2, 3, 4, 5].map((n) => fixtureSetReferenceProbe(n));
}
/** A PNG that would pass, a GIF and a HEIC that cannot: the whole bundle is refused. */
export const FIXTURE_SET_REFERENCE_PROBES_BAD_FORMAT: ExpressionSetReferenceProbe[] = [
  fixtureSetReferenceProbe(1),
  fixtureSetReferenceProbe(2, { mime: "image/gif", bytes: 90_000, width: 400, height: 400, prepared: undefined }),
  fixtureSetReferenceProbe(3, { mime: "image/heic", bytes: 400_000, width: 3000, height: 2000, prepared: undefined }),
];
/** Four pictures that each fit (1.2 MiB prepared, under the 4 MiB each) and do not fit together (4.8 MiB, over the 4 MiB bundle). */
export function fixtureSetReferenceProbesOverBytes(): ExpressionSetReferenceProbe[] {
  return [1, 2, 3, 4].map((n) => fixtureSetReferenceProbe(n, { prepared: { mime: "image/png", bytes: 1_258_291 } }));
}
/** One upload past the 5 MiB input ceiling and the 16,000,000 pixels: refused before a byte is read. */
export const FIXTURE_SET_REFERENCE_PROBES_TOO_BIG_INPUT: ExpressionSetReferenceProbe[] = [
  fixtureSetReferenceProbe(1, { bytes: 6 * 1024 * 1024, width: 5000, height: 4000, prepared: undefined }),
];

/** The plan: six stills with words, two with a face or a gesture only, then two GIFs made from stills 0 and 5. */
const PLAN: Array<[ExpressionSetKind, string, string]> = [
  ["still", "cat_hello", "안녕"], ["still", "cat_thanks", "고마워"], ["still", "cat_sorry", "미안해"],
  ["still", "cat_ok", "좋아요"], ["still", "cat_later", "나중에"], ["still", "cat_done", "다 했어요"],
  ["still", "cat_happy", "기쁨"], ["still", "cat_sleepy", "졸림"],
  ["gif", "cat_hello_bounce", "안녕 통통"], ["gif", "cat_done_wobble", "다 했어요 흔들"],
];

function approvalOf(slots: ExpressionSetSlot[], over: Partial<ExpressionSetApproval> = {}): ExpressionSetApproval {
  return {
    v: 1, workspaceId: FIXTURE_WORKSPACE_ID, setId: FIXTURE_SET_ID, title: "고양이 세트", prefix: "cat", subjectMemberId: null,
    prompt: FIXTURE_SET_PROMPT, references: [], expiresAtMs: FIXTURE_NOW_MS + 3_600_000, slots, ...over,
  };
}

export const FIXTURE_SET_NORMAL: ExpressionSetApproval = approvalOf(
  PLAN.map(([kind, name, displayName], index) => fixtureSetReadySlot(index, kind, name, displayName, ["고양이"])),
  { references: FIXTURE_SET_REFERENCES },
);

const GRAY_AT: Record<number, ExpressionSetGrayCode> = { 2: "refused", 3: "refused", 4: "failed", 7: "not_made", 8: "base_missing" };
/**
 * The five grey slots, each from a different cause. Stills 2 and 3 were refused and still 4 failed (a made attempt, still 5, would have started
 * the count over, so no streak closed anything); still 7 was never tried (time ran out). The GIF at index 8 was to move still 2, a refused one,
 * so it is `base_missing`; the GIF at 9 moves still 5 and was made. The test derives all five from `settleExpressionSetStills` and
 * `settleExpressionSetGifs` with these attempts and bases, so the card cannot drift from the rules.
 */
export const FIXTURE_SET_REFUSED_ATTEMPTS = ["made", "made", "refused", "refused", "failed", "made", "made"] as const;
export const FIXTURE_SET_REFUSED_GIF_BASES = [2, 5] as const;
export const FIXTURE_SET_REFUSED: ExpressionSetApproval = approvalOf(
  PLAN.map(([kind, name, displayName], index) => GRAY_AT[index]
    ? fixtureSetGraySlot(index, kind, GRAY_AT[index], name, displayName, ["고양이"])
    : fixtureSetReadySlot(index, kind, name, displayName, ["고양이"])),
  { references: FIXTURE_SET_REFERENCES },
);

/**
 * Three refusals in a row (stills 2, 3 and 4) closed the rest: stills 5, 6 and 7 were never tried (`not_made`). The GIF whose
 * still exists (index 8, from still 0) was still made, because a GIF is moved by the server and never refused; the GIF whose still is
 * grey (index 9, from still 5) is `base_missing`.
 */
export const FIXTURE_SET_STREAK_ATTEMPTS = ["made", "made", "refused", "refused", "refused"] as const;
export const FIXTURE_SET_STREAK_GIF_BASES = [0, 5] as const;
export const FIXTURE_SET_STREAK_CLOSED: ExpressionSetApproval = approvalOf(
  PLAN.map(([kind, name, displayName], index) => {
    const code: ExpressionSetGrayCode | undefined = ({ 2: "refused", 3: "refused", 4: "refused", 5: "not_made", 6: "not_made", 7: "not_made", 9: "base_missing" } as Record<number, ExpressionSetGrayCode>)[index];
    return code ? fixtureSetGraySlot(index, kind, code, name, displayName, ["고양이"]) : fixtureSetReadySlot(index, kind, name, displayName, ["고양이"]);
  }),
  { references: FIXTURE_SET_REFERENCES },
);

/** `thumbs_up` is in the team library already (the first fixture list); the other three are free. */
export const FIXTURE_SET_SAME_NAME: ExpressionSetApproval = approvalOf(
  [["thumbs_up", "엄지"], ["thumbs_wave", "손 흔들기"], ["thumbs_clap", "박수"], ["thumbs_heart", "하트"]]
    .map(([name, displayName], index) => fixtureSetReadySlot(index, "still", name, displayName)),
  { prefix: "thumbs", title: "엄지 세트" },
);

/** One slot more than the ceiling. The wire schema, the card builder and the server all refuse it. */
export function fixtureSetOverLimit(): ExpressionSetApproval {
  return approvalOf(Array.from({ length: 41 }, (_, index) => fixtureSetReadySlot(index % 40, "still", `cat_scene_${index}`, `장면 ${index}`)));
}

/**
 * A set that is inside the 40 slots and the wire schema but past the byte budget: seventeen GIF slots with every
 * rendition at its D3 ceiling is 17 × 1.5 MiB. Only the whole-set sum can refuse it (L4).
 */
export function fixtureSetBytesHeavy(): ExpressionSetApproval {
  const heavy = (index: number) => {
    const slot = fixtureSetReadySlot(index, "gif", `cat_big_${index}`, `큰 움직임 ${index}`);
    slot.media = {
      small: { ...slot.media.small, bytes: 262_144 },
      large: { ...slot.media.large, bytes: 1_048_576 },
      thumb: { ...slot.media.thumb, bytes: 262_144 },
    };
    return slot;
  };
  return approvalOf(Array.from({ length: 17 }, (_, index) => heavy(index)));
}

export const FIXTURE_SET_CARDS: ExpressionSetCard[] = [
  { approvalId: FIXTURE_SET_APPROVAL_ID, approval: FIXTURE_SET_NORMAL },
  { approvalId: FIXTURE_SET_REFUSED_APPROVAL_ID, approval: { ...FIXTURE_SET_REFUSED, setId: "00000000-0000-4000-8000-000000000402" } },
  { approvalId: FIXTURE_SET_SAME_NAME_APPROVAL_ID, approval: { ...FIXTURE_SET_SAME_NAME, setId: "00000000-0000-4000-8000-000000000403" } },
];

/** What the team AI sends for the normal set: names and labels for every staged index, and no picture. */
export const FIXTURE_SET_ACTION: ExpressionSetAction = {
  action: "expression.set.create",
  args: {
    setId: FIXTURE_SET_ID, title: "고양이 세트", prefix: "cat", tags: ["고양이"], backend: "hermes", subjectMemberId: null, prompt: FIXTURE_SET_PROMPT,
    slots: FIXTURE_SET_NORMAL.slots.map((slot) => ({ index: slot.index, name: slot.name, displayName: slot.displayName, tags: [] })),
  },
};
/** The same plan naming the team's own image key: valid on the wire, **off** in the server (ADR-0218 §12 L20). */
export const FIXTURE_SET_ACTION_RESERVED_BACKEND: ExpressionSetAction = { ...FIXTURE_SET_ACTION, args: { ...FIXTURE_SET_ACTION.args, backend: "team_image_model" } };
