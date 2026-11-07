import {canDeclareImageSize} from '@momo/core/lib/attachmentMedia';
import {Image} from 'react-native';

// =============================================================================
// 올릴 사진·GIF 의 **표시 크기**를 재는 폰 어댑터 (ADR-0151 증보 9 I7, #5469).
//
// 서버에 선언하는 가로세로는 **받는 쪽이 같은 바이트에서 재는 것과 같은 자**로 잰다. 받는 폰의 칸(`AttachmentList` 의 `ImageTile`)은
// 내려받은 파일을 `Image.getSize` 로 재므로, 보내는 폰도 **보낼 파일을 같은 `Image.getSize` 로** 잰다. 사진 고르개가 알려 주는 가로세로
// (`ImagePickerAsset.width/height`)는 쓰지 않는다 — 플랫폼에 따라 EXIF 방향을 적용하기 전의 값일 수 있어서, 세로로 찍은 사진의 칸이 가로로
// 서기 때문이다. 그 값이 같은 바이트의 표시 크기와 같은지는 실기기로 재지 못했다(`runtime-unverified`).
//
// 닫힌 목록(서버가 가로세로를 받는 JPEG·PNG·GIF·WebP) 밖의 종류는 **재지 않는다**: 서버가 400 으로 돌려줄 값을 재느라 사진을 읽을 이유가 없다.
// 어떤 실패도 던지지 않고 `null` 이다(선언하지 않음 — 요약 없이 가면 받는 쪽이 지금처럼 기기 기억을 쓴다).
// =============================================================================

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/** 이 파일의 표시 크기(픽셀). 선언할 수 없는 종류이거나 못 읽으면 `null`. */
export function measurePickedImage(
  uri: string,
  mime: string,
): Promise<ImageSize | null> {
  if (!canDeclareImageSize(mime)) return Promise.resolve(null);
  return new Promise(resolve => {
    try {
      Image.getSize(
        uri,
        (width, height) => resolve({width, height}),
        () => resolve(null),
      );
    } catch {
      resolve(null);
    }
  });
}
