// Placement for the S0 Oort-cloud scatter. Positions live here so tests can
// assert the empty centre without reading CSS; tokens.css repeats the same
// numbers as custom properties (no inline style).

export type CloudBodyKind = "comet" | "asteroid" | "star";
export type CloudBodyTone = "accent" | "ink";

export interface CloudBody {
  index: number;
  /** Percent of the field, 0–100. */
  top: number;
  left: number;
  /** Pixel size in the 22–36 band. */
  size: number;
  rotate: number;
  kind: CloudBodyKind;
  tone: CloudBodyTone;
}

/** Wander amplitude (px). Must match the rAF loop in OortCloudField. */
export const CLOUD_WANDER_X = 26;
export const CLOUD_WANDER_Y = 20;
/** Pointer-repel push (px). Must match the rAF loop in OortCloudField. */
export const CLOUD_REPEL_STRENGTH = 110;

/**
 * Empty-centre radius, in percent of the field. #1869 used a 20-unit half-side
 * square (30–70). The #1882 lockup grew twice: 1.5× mark, then H-1/M-1 (wordmark
 * at 1/3 mark + one-line copy ~307px). Rest poses sit outside a 32-unit circle
 * around 50,50. Capture AABB is the live check; this circle is the rest-pose
 * heuristic. Closest live body hypot is still > 40.
 */
export const CENTRE_RADIUS = 32;

/** Rest band of the two landing CTAs: top 86%+, centred 30–70. */
const CTA_TOP = 86;
const CTA_LEFT = 30;
const CTA_RIGHT = 70;

/** Pad the CTA hole by wander ±26 plus repel ~110 at the 1280×800 review viewport. */
const EXCLUSION_VIEWPORT = { width: 1280, height: 800 };
const CTA_PAD_X =
  ((CLOUD_WANDER_X + CLOUD_REPEL_STRENGTH) / EXCLUSION_VIEWPORT.width) * 100;
const CTA_PAD_Y =
  ((CLOUD_WANDER_X + CLOUD_REPEL_STRENGTH) / EXCLUSION_VIEWPORT.height) * 100;

export const CLOUD_BODIES: readonly CloudBody[] = [
  { index: 0, top: 50, left: 96, size: 22, rotate: -24, kind: "comet", tone: "accent" },
  { index: 1, top: 64, left: 91, size: 24, rotate: -7, kind: "asteroid", tone: "ink" },
  { index: 2, top: 77, left: 86, size: 26, rotate: 10, kind: "star", tone: "accent" },
  { index: 3, top: 81, left: 88, size: 28, rotate: -22, kind: "comet", tone: "ink" },
  { index: 4, top: 78, left: 10, size: 30, rotate: -5, kind: "asteroid", tone: "accent" },
  { index: 5, top: 79, left: 90, size: 32, rotate: 12, kind: "star", tone: "ink" },
  { index: 6, top: 62, left: 5, size: 34, rotate: -20, kind: "comet", tone: "accent" },
  { index: 7, top: 76, left: 93, size: 36, rotate: -3, kind: "asteroid", tone: "ink" },
  { index: 8, top: 58, left: 6, size: 22, rotate: 14, kind: "star", tone: "accent" },
  { index: 9, top: 70, left: 16, size: 24, rotate: -18, kind: "comet", tone: "ink" },
  { index: 10, top: 73, left: 8, size: 26, rotate: -1, kind: "asteroid", tone: "accent" },
  { index: 11, top: 66, left: 12, size: 28, rotate: 16, kind: "star", tone: "ink" },
  { index: 12, top: 67, left: 11, size: 30, rotate: -16, kind: "comet", tone: "accent" },
  { index: 13, top: 54, left: 4, size: 32, rotate: 1, kind: "asteroid", tone: "ink" },
  { index: 14, top: 40, left: 4, size: 34, rotate: 18, kind: "star", tone: "accent" },
  { index: 15, top: 50, left: 4, size: 36, rotate: -14, kind: "comet", tone: "ink" },
  { index: 16, top: 35, left: 4, size: 22, rotate: 3, kind: "asteroid", tone: "accent" },
  { index: 17, top: 20, left: 10, size: 24, rotate: 20, kind: "star", tone: "ink" },
  { index: 18, top: 16, left: 26, size: 26, rotate: -12, kind: "comet", tone: "accent" },
  { index: 19, top: 8, left: 37, size: 28, rotate: 5, kind: "asteroid", tone: "ink" },
  { index: 20, top: 11, left: 27, size: 30, rotate: 22, kind: "star", tone: "accent" },
  { index: 21, top: 4, left: 41, size: 32, rotate: -10, kind: "comet", tone: "ink" },
  { index: 22, top: 2, left: 56, size: 34, rotate: 7, kind: "asteroid", tone: "accent" },
  { index: 23, top: 5, left: 71, size: 36, rotate: 24, kind: "star", tone: "ink" },
  { index: 24, top: 19, left: 79, size: 22, rotate: -8, kind: "comet", tone: "accent" },
  { index: 25, top: 12, left: 72, size: 24, rotate: 9, kind: "asteroid", tone: "ink" },
  { index: 26, top: 20, left: 84, size: 26, rotate: -23, kind: "star", tone: "accent" },
  { index: 27, top: 32, left: 96, size: 28, rotate: -6, kind: "comet", tone: "ink" },
  { index: 28, top: 46, left: 96, size: 30, rotate: 11, kind: "asteroid", tone: "accent" },
  { index: 29, top: 61, left: 96, size: 32, rotate: -21, kind: "star", tone: "ink" },
];

export function isInEmptyCentre(body: CloudBody): boolean {
  return Math.hypot(body.left - 50, body.top - 50) < CENTRE_RADIUS;
}

/** Rest pose sits inside the CTA band (no drift). */
export function isInCtaBand(body: CloudBody): boolean {
  return body.top >= CTA_TOP && body.left >= CTA_LEFT && body.left <= CTA_RIGHT;
}

/**
 * Rest pose plus wander ±26px and a ~110px repel, measured at 1280×800 so a
 * glyph parked on the hole's lip cannot drift or be pushed onto the buttons.
 */
export function isInCtaExclusion(body: CloudBody): boolean {
  return (
    body.top >= CTA_TOP - CTA_PAD_Y &&
    body.left >= CTA_LEFT - CTA_PAD_X &&
    body.left <= CTA_RIGHT + CTA_PAD_X
  );
}
