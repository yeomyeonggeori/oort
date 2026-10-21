import * as DocumentPicker from 'expo-document-picker';
import {File} from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

import type {UploadIssue} from '@momo/core/features/attachments/model';

export interface PickedAttachmentFile {
  uri: string;
  name: string;
  mime: string;
  sizeBytes: number;
  /** provider 값 또는 읽을 수 있는 native 파일에서 실제로 잰 값인가. */
  sizeKnown: boolean;
}

export type AttachmentPickerOutcome =
  | {kind: 'picked'; files: PickedAttachmentFile[]}
  | {kind: 'issue'; issue: UploadIssue};

function fileNameFromUri(uri: string, fallback: string): string {
  const last = uri.split('/').pop();
  if (!last) return fallback;
  try {
    return decodeURIComponent(last) || fallback;
  } catch {
    return last;
  }
}

function fileSize(
  uri: string,
  reported: number | undefined,
): {sizeBytes: number; sizeKnown: boolean} {
  if (reported !== undefined && Number.isFinite(reported) && reported >= 0) {
    return {sizeBytes: reported, sizeKnown: true};
  }
  try {
    const file = new File(uri);
    const measured = file.size;
    if (file.exists && Number.isFinite(measured) && measured >= 0) {
      return {sizeBytes: measured, sizeKnown: true};
    }
  } catch {
    // 아래의 명시적인 unknown으로 접는다.
  }
  return {sizeBytes: 0, sizeKnown: false};
}

/** 사진 한 장을 고른(또는 찍은) 결과를 첨부 입력으로. picker 둘이 같은 모양으로 답한다. */
function photoOutcome(
  result: ImagePicker.ImagePickerResult,
): AttachmentPickerOutcome {
  if (result.canceled || result.assets.length === 0) {
    return {kind: 'issue', issue: 'selection-cancelled'};
  }
  const asset = result.assets[0];
  const size = fileSize(asset.uri, asset.fileSize);
  return {
    kind: 'picked',
    files: [
      {
        uri: asset.uri,
        name: asset.fileName ?? fileNameFromUri(asset.uri, 'photo.jpg'),
        mime: asset.mimeType ?? 'image/jpeg',
        ...size,
      },
    ],
  };
}

/**
 * PHPicker 사진 선택. iOS 14+에서는 읽기 권한을 선제 요청하지 않는다.
 *
 * 계약상 거부 상태는 버리지 않는다. 정상 경로를 막는 사전 권한 확인 대신 picker
 * 자체가 실패한 뒤에만 실제 권한 상태를 물어, 그 답이 거부일 때 설정 안내로 잇는다.
 */
export async function pickPhoto(): Promise<AttachmentPickerOutcome> {
  try {
    return photoOutcome(
      await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: false,
        quality: 1,
      }),
    );
  } catch {
    try {
      const permission = await ImagePicker.getMediaLibraryPermissionsAsync();
      if (
        permission.status === 'denied' ||
        permission.accessPrivileges === 'none'
      ) {
        return {kind: 'issue', issue: 'permission-denied'};
      }
    } catch {
      // 권한 상태조차 읽지 못하면 아래의 일반 실패로 접는다.
    }
    return {kind: 'issue', issue: 'unavailable'};
  }
}

/**
 * 카메라로 사진 한 장 (#4180, ADR-0168 범위). 사진 보관함과 달리 카메라는 **먼저 권한을 받아야** 한다:
 * `launchCameraAsync` 는 권한이 없으면 묻지 않고 거절한다(`MissingCameraPermissionException`). 그래서
 * 여기서 묻고, 거부면 시스템 카메라를 띄우지 않고 곧장 `camera-permission-denied` 로 접는다. 기존
 * `permission-denied` 와 같은 트레이 길(문장 + 기기 설정 링크)이지만 **문장은 카메라라고 말한다** —
 * 설정의 oort 페이지에 「카메라」와 「사진」은 다른 행이라, 카메라를 거부한 사람에게 「사진 접근을 허용」
 * 하라고 하면 같은 실패가 반복된다(design-review High-1). 첫 요청은 시스템 알림이 서고, 거부한 뒤에는
 * 묻지 않고 거부로 답한다.
 *
 * 사진만 찍는다(`mediaTypes: ['images']`) — 동영상 모드는 마이크를 쓰고, 앱은 마이크를 요청하지 않는다
 * (`Info.plist` · `projectShape.test.ts`). 시뮬레이터에는 카메라가 없어 허용 뒤의 촬영은 `unavailable`
 * 로 접힌다(실기기에서만 열린다).
 */
export async function pickCamera(): Promise<AttachmentPickerOutcome> {
  try {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      return {kind: 'issue', issue: 'camera-permission-denied'};
    }
    return photoOutcome(
      await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 1,
      }),
    );
  } catch {
    return {kind: 'issue', issue: 'unavailable'};
  }
}

/** 파일 provider에서 한 건을 앱 캐시로 받아 네이티브 업로더가 바로 읽게 한다. */
export async function pickDocument(): Promise<AttachmentPickerOutcome> {
  try {
    const result = await DocumentPicker.getDocumentAsync({
      type: '*/*',
      multiple: false,
      copyToCacheDirectory: true,
    });
    if (result.canceled || result.assets.length === 0) {
      return {kind: 'issue', issue: 'selection-cancelled'};
    }
    const asset = result.assets[0];
    const size = fileSize(asset.uri, asset.size);
    return {
      kind: 'picked',
      files: [
        {
          uri: asset.uri,
          name: asset.name,
          mime: asset.mimeType ?? 'application/octet-stream',
          ...size,
        },
      ],
    };
  } catch {
    return {kind: 'issue', issue: 'unavailable'};
  }
}
