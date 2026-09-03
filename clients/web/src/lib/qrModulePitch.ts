/** Content-box module pitch. Empty geometry must throw — jsdom cannot measure. */

export function qrModulePitch(contentWidthPx: number, modules: number): number {
  if (!Number.isFinite(contentWidthPx) || contentWidthPx <= 0) {
    throw new Error("qr module pitch: empty geometry (cannot measure)");
  }
  if (!Number.isFinite(modules) || modules <= 0) {
    throw new Error("qr module pitch: missing module count");
  }
  return contentWidthPx / modules;
}

export function assertQrModulePitch(
  contentWidthPx: number,
  modules: number,
  floorPx: number,
  label = "QR"
): number {
  const pitch = qrModulePitch(contentWidthPx, modules);
  if (pitch < floorPx) {
    throw new Error(
      `${label}: pitch ${pitch.toFixed(3)}px < floor ${floorPx}px (${modules} modules, content ${contentWidthPx}px)`
    );
  }
  return pitch;
}
