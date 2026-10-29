/** A native Text mirror measures glyphs; this pure function owns the height/scroll decision. */
export type ComposerTextGeometry = Readonly<{
  text: string;
  width: number;
  fontSize: number;
  lineHeight: number;
  fontScale: number;
}>;

export type ComposerTextMeasurement = Readonly<{
  geometry: ComposerTextGeometry;
  lineHeights: readonly number[];
}>;

export function sameComposerGeometry(a: ComposerTextGeometry, b: ComposerTextGeometry): boolean {
  return a.text === b.text && a.width === b.width && a.fontSize === b.fontSize &&
    a.lineHeight === b.lineHeight && a.fontScale === b.fontScale;
}

export function composerInputLayout(
  geometry: ComposerTextGeometry,
  limits: Readonly<{minHeight: number; maxHeight: number; chrome: number}>,
  measurement: ComposerTextMeasurement | null,
): Readonly<{rows: number; height: number; scrollEnabled: boolean}> {
  // Keep the last height while the next keystroke's mirror layout is pending;
  // otherwise every keystroke would briefly collapse an already-grown editor.
  // Width/font changes invalidate that provisional measurement. Empty resets below.
  const heights = measurement && sameComposerGeometry(
    {...geometry, text: measurement.geometry.text}, measurement.geometry,
  )
    ? measurement.lineHeights : [];
  // Uncapped: the fifth explicit newline must enable scrolling even before measurement.
  const rows = geometry.text === '' ? 1 : Math.max(geometry.text.split('\n').length, heights.length);
  const textHeight = geometry.text === '' ? 0 : Math.max(
    rows * geometry.lineHeight * geometry.fontScale,
    heights.reduce((sum, height) => sum + height, 0),
  );
  const wanted = Math.max(limits.minHeight, textHeight + limits.chrome);
  return {
    rows,
    height: Math.min(limits.maxHeight, wanted),
    // Summing fractional Dynamic Type line heights can exceed the same row cap
    // by ~1e-13pt. That is not a fifth line.
    scrollEnabled: geometry.text !== '' && wanted - limits.maxHeight > 0.001,
  };
}
