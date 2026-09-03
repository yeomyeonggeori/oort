/** Keep in sync with src/lib/qrModulePitch.ts. Capture runs as plain Node. */

export function qrModulePitch(contentWidthPx, modules) {
  if (!Number.isFinite(contentWidthPx) || contentWidthPx <= 0) {
    throw new Error("qr module pitch: empty geometry (cannot measure)");
  }
  if (!Number.isFinite(modules) || modules <= 0) {
    throw new Error("qr module pitch: missing module count");
  }
  return contentWidthPx / modules;
}

export function assertQrModulePitch(contentWidthPx, modules, floorPx, label = "QR") {
  const pitch = qrModulePitch(contentWidthPx, modules);
  if (pitch < floorPx) {
    throw new Error(
      `${label}: pitch ${pitch.toFixed(3)}px < floor ${floorPx}px (${modules} modules, content ${contentWidthPx}px)`
    );
  }
  return pitch;
}
