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

export const CLOUD_BODIES: readonly CloudBody[] = [
  { index: 0, top: 50, left: 92, size: 22, rotate: -24, kind: "comet", tone: "accent" },
  { index: 1, top: 64, left: 91, size: 24, rotate: -7, kind: "asteroid", tone: "ink" },
  { index: 2, top: 77, left: 86, size: 26, rotate: 10, kind: "star", tone: "accent" },
  { index: 3, top: 88, left: 77, size: 28, rotate: -22, kind: "comet", tone: "ink" },
  { index: 4, top: 96, left: 64, size: 30, rotate: -5, kind: "asteroid", tone: "accent" },
  { index: 5, top: 93, left: 75, size: 32, rotate: 12, kind: "star", tone: "ink" },
  { index: 6, top: 91, left: 59, size: 34, rotate: -20, kind: "comet", tone: "accent" },
  { index: 7, top: 93, left: 45, size: 36, rotate: -3, kind: "asteroid", tone: "ink" },
  { index: 8, top: 91, left: 31, size: 22, rotate: 14, kind: "star", tone: "accent" },
  { index: 9, top: 84, left: 18, size: 24, rotate: -18, kind: "comet", tone: "ink" },
  { index: 10, top: 92, left: 26, size: 26, rotate: -1, kind: "asteroid", tone: "accent" },
  { index: 11, top: 83, left: 13, size: 28, rotate: 16, kind: "star", tone: "ink" },
  { index: 12, top: 67, left: 11, size: 30, rotate: -16, kind: "comet", tone: "accent" },
  { index: 13, top: 54, left: 7, size: 32, rotate: 1, kind: "asteroid", tone: "ink" },
  { index: 14, top: 40, left: 6, size: 34, rotate: 18, kind: "star", tone: "accent" },
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
  { index: 27, top: 32, left: 93, size: 28, rotate: -6, kind: "comet", tone: "ink" },
  { index: 28, top: 46, left: 96, size: 30, rotate: 11, kind: "asteroid", tone: "accent" },
  { index: 29, top: 61, left: 96, size: 32, rotate: -21, kind: "star", tone: "ink" },
];

/** Inner 40% square of the field, in percent (30–70 on both axes). */
export function isInEmptyCentre(body: CloudBody): boolean {
  return body.left >= 30 && body.left <= 70 && body.top >= 30 && body.top <= 70;
}
