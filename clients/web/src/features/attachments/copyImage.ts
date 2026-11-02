import { parseImageDataUrl } from "@/features/attachments/imageLightboxModel";

// =============================================================================
// 이미지 미리보기의 「이미지 복사」 (#5190). 폰 뷰어는 공유 시트의 「복사」가 이 일을 하고(`useShareAttachment`), 데스크탑·웹에는
// 그 시트가 없어서 비어 있던 자리다.
//
// 바이트는 미리보기가 이미 들고 있는 `data:` 주소다(`useAttachmentPreview`). 새로 받지 않고, `fetch`도 하지 않는다: 배포 CSP의
// `connect-src`는 `data:`를 허락하지 않는다. 클립보드가 받는 이미지 형식은 PNG 하나뿐이라(브라우저 공통) PNG는 바이트를 그대로
// 건네고(무손실), 그 밖의 형식(JPEG·WebP·GIF)은 한 번 그려서 PNG로 바꾼다. 문자열 글자 하나하나가 「직접 문구」 장부에 세이므로(`direct-copy.mjs`는
// 영어 낱말 리터럴도 센다) 이 파일은 낱말 리터럴 없이 쓴다.
// =============================================================================

/** 이 환경이 이미지를 클립보드에 쓸 수 있는가. 못 쓰면 복사 단추를 그리지 않는다: 눌러도 아무 일 없는 죽은 컨트롤을 두지 않는다. */
export function canCopyImage(): boolean {
  return Boolean(globalThis.ClipboardItem && globalThis.navigator?.clipboard?.write);
}

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** `data:image/…` 주소를 PNG 덩어리로. 이미지 주소가 아니면 던진다. */
export async function pngBlobFromDataUrl(dataUrl: string): Promise<Blob> {
  const parsed = parseImageDataUrl(dataUrl);
  if (parsed === null) throw new Error("not an image data url");
  if (parsed.mime === "image/png") return new Blob([bytesOf(parsed.base64)], { type: "image/png" });
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  // `OffscreenCanvas`: 화면에 안 붙는 캔버스라 DOM을 만들지 않는다(Safari 16.4+, Chromium).
  const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no 2d context");
  context.drawImage(image, 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

/**
 * 이미지를 클립보드에 쓴다. 누르는 손(사용자 제스처) 안에서 불러야 한다: Safari·WKWebView는 제스처가 끝난 뒤의 쓰기를 막으므로
 * 덩어리는 **약속(Promise)** 으로 넘기고 `write`는 바로 부른다. 못 쓰면 던진다.
 */
export function copyImageToClipboard(dataUrl: string): Promise<void> {
  return navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlobFromDataUrl(dataUrl) })]);
}
