import { stripJpegMetadata } from "@momo/core/design/jpegMetadata";
import type { DecodedPhoto, EncodedPhoto, PhotoPorts } from "@momo/core/design/wallpaper";

// =============================================================================
// 내 사진 → 상한 안의 JPEG 한 장: 브라우저 쪽 포트 (ADR-0189 증보 3 D4, AP-4 #4191).
//
// 계단의 산수(긴 변 2560, 1.5MB, 품질 → 해상도)와 실패 갈래는 core `importPhoto`가 갖고, 이 파일은 그
// 계단이 부르는 두 동작만 브라우저로 구현한다.
//
//   decode  `createImageBitmap`. 주소(URL)가 필요 없으므로 배포 CSP(`img-src 'self' data:`)와 부딪히지 않는다.
//   encode  캔버스에 그리고 `toBlob("image/jpeg", 품질)`.
//
// ## EXIF가 벗겨지는 이유와 회전
//
// 캔버스는 원본의 EXIF를 옮기지 않는다. 그러므로 **항상 다시 쓰는 것**이 위치(GPS)·촬영 기기·시각 태그를 벗기는 길이다
// (원본 바이트를 그대로 저장하지 않는다). 그러나 인코더가 자기 메타데이터를 쓰는 엔진이 있다: 실측(Playwright WebKit, 데스크탑
// 앱의 WKWebView와 같은 엔진)으로 `toBlob("image/jpeg")` 출력에 Exif APP1과 Photoshop APP13이 든다. 그래서 인코딩이 끝난 바이트를
// core `stripJpegMetadata`로 한 번 더 걸러 메타데이터 세그먼트를 전부 걷고, 걸러지지 않는 출력은 저장하지 않는다(fail-closed).
//
// 다시 쓰는 대가는 회전이다: EXIF `Orientation`을 무시하고 벗기면 세로로 찍은 사진이 옆으로 눕는다. 그래서 디코드가 회전을
// **픽셀에 굽는다**(`imageOrientation: "from-image"`). 이 옵션을 모르는 엔진은 던지므로 옵션 없는 호출로 한 번 더 시도한다(그런
// 엔진은 기본이 이미 `from-image`다).
//
// 투명 PNG는 JPEG에 알파가 없어서 검게 저장되므로 흰 바탕 위에 그린다. 어차피 그 위에 scrim이 얹힌다.
//
// 이 모듈에는 `fetch`·`XMLHttpRequest`·업로드 경로가 없다(시험이 소스를 읽어 단정한다). 사진은 이 기기를 떠나지 않는다.
// =============================================================================

export type PhotoSource = Blob;
export type PhotoBytes = Blob;

async function decodeBitmap(file: Blob): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
  } catch {
    // 옵션을 모르는 엔진이거나 읽을 수 없는 파일이다. 옵션 없이 한 번 더 시도하고, 그래도 안 되면 읽을 수 없다.
  }
  try {
    return await createImageBitmap(file);
  } catch {
    return null;
  }
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
    } catch {
      resolve(null);
    }
  });
}

export const canvasPhotoPorts: PhotoPorts<PhotoSource, ImageBitmap, PhotoBytes> = {
  async decode(file): Promise<DecodedPhoto<ImageBitmap> | null> {
    const bitmap = await decodeBitmap(file);
    if (bitmap === null) return null;
    return { handle: bitmap, width: bitmap.width, height: bitmap.height };
  },

  async encode(bitmap, { longSide, quality }): Promise<EncodedPhoto<PhotoBytes> | null> {
    const longest = Math.max(bitmap.width, bitmap.height);
    // 더 작은 사진은 키우지 않는다.
    const scale = Math.min(1, longSide / longest);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) return null;
    context.fillStyle = "white";
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await toJpeg(canvas, quality);
    if (blob === null || blob.size === 0) return null;
    // 인코더가 쓴 메타데이터까지 걷는다. 구조를 읽지 못한 출력은 저장하지 않는다.
    const stripped = stripJpegMetadata(new Uint8Array(await blob.arrayBuffer()));
    if (stripped === null) return null;
    // `stripJpegMetadata`는 새 배열을 만든다(바이트 소유가 `ArrayBuffer`다).
    const clean = new Blob([stripped as Uint8Array<ArrayBuffer>], { type: "image/jpeg" });
    return { bytes: clean, size: clean.size, width, height };
  },

  release(bitmap) {
    try {
      bitmap.close();
    } catch {
      // 이미 놓였거나 없는 메서드다. 놓는 일이 흐름을 막으면 안 된다.
    }
  },

  now: () => Date.now(),
};
