import {File} from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import {EXPRESSION_LIMITS} from '@momo/core/features/expressions/types';

// =============================================================================
// 팀 이모지에 쓸 그림 한 장을 사진 앨범에서 고른다 (#4891).
//
// 시스템 사진 창(PHPicker)은 사진 접근 권한 없이도 돈다 — 사진 첨부(`attachments/picker.ts`)와 같은 길이다.
// 권한 문구(`NSPhotoLibraryUsageDescription`)는 앱 설정에 이미 있고 이 길은 새 문구를 요구하지 않는다.
//
// 첨부 고르개와 다른 점 둘:
//   · **호환 표현을 요구한다.** 서버는 PNG·JPEG·WebP·GIF 만 받는다(`EXPRESSION_ACCEPTED_MIMES`). iPhone 사진은 기본이
//     HEIC 라서, 호환 표현(JPEG)을 달라고 하지 않으면 가장 흔한 사진이 형식 검사에서 떨어진다.
//   · **가로세로를 함께 돌려준다.** 「AI와 만들기」의 원본 한도(한 변 4096·1600만 화소)를 올리기 전에 잰다.
//
// 한도와 허용 형식은 웹의 `media.ts`(`validExpressionFile`)와 같은 값이다: 시험이 웹 소스와 맞는지 대조한다.
// =============================================================================

/** 서버가 받는 그림 형식. 웹 `EXPRESSION_FILE_ACCEPT` 와 같은 네 가지다. */
export const EXPRESSION_ACCEPTED_MIMES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

export interface PickedPhoto {
  uri: string;
  name: string;
  mime: string;
  /** 바이트 수. 앨범도 파일도 말해 주지 않으면 `null` — 그때는 서버가 판정한다. */
  bytes: number | null;
  /** 0 이면 시스템이 말해 주지 않은 것이다. */
  width: number;
  height: number;
}

export type PhotoPickOutcome =
  | {kind: 'picked'; photo: PickedPhoto}
  | {kind: 'cancelled'}
  | {kind: 'denied'}
  | {kind: 'unavailable'};

/** 고른 그림이 한도 안인가. 웹 `validExpressionFile` 과 같은 규칙: 비어 있지 않고, 5 MiB 이하이고, 허용 형식이다. */
export type PhotoIssue = 'empty' | 'type' | 'size';

export function photoIssueOf(
  photo: Pick<PickedPhoto, 'mime' | 'bytes'>,
): PhotoIssue | null {
  if (!EXPRESSION_ACCEPTED_MIMES.includes(photo.mime)) return 'type';
  if (photo.bytes === 0) return 'empty';
  if (photo.bytes !== null && photo.bytes > EXPRESSION_LIMITS.inputBytes) {
    return 'size';
  }
  return null;
}

function nameFromUri(uri: string): string {
  const last = uri.split('/').pop();
  if (!last) return 'picture';
  try {
    return decodeURIComponent(last) || last;
  } catch {
    return last;
  }
}

function measuredBytes(uri: string, reported: number | undefined) {
  if (reported !== undefined && Number.isFinite(reported) && reported >= 0) {
    return reported;
  }
  try {
    const file = new File(uri);
    if (file.exists && Number.isFinite(file.size) && file.size >= 0) {
      return file.size;
    }
  } catch {
    // 모르면 모른다고 답한다 — 서버가 마지막에 판정한다.
  }
  return null;
}

export async function pickAlbumPhoto(): Promise<PhotoPickOutcome> {
  try {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: false,
      quality: 1,
      preferredAssetRepresentationMode:
        'compatible' as ImagePicker.UIImagePickerPreferredAssetRepresentationMode,
    });
    if (result.canceled || result.assets.length === 0) {
      return {kind: 'cancelled'};
    }
    const asset = result.assets[0];
    return {
      kind: 'picked',
      photo: {
        uri: asset.uri,
        name: asset.fileName ?? nameFromUri(asset.uri),
        mime: asset.mimeType ?? 'image/jpeg',
        bytes: measuredBytes(asset.uri, asset.fileSize),
        width: asset.width,
        height: asset.height,
      },
    };
  } catch {
    // 열리지 못했을 때만 권한 상태를 묻는다 — 정상 경로를 막는 사전 확인은 하지 않는다(첨부 고르개와 같다).
    try {
      const permission = await ImagePicker.getMediaLibraryPermissionsAsync();
      if (
        permission.status === 'denied' ||
        permission.accessPrivileges === 'none'
      ) {
        return {kind: 'denied'};
      }
    } catch {
      // 권한 상태조차 못 읽으면 일반 실패로 접는다.
    }
    return {kind: 'unavailable'};
  }
}
