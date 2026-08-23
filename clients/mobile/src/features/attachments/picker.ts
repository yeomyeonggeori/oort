import * as DocumentPicker from 'expo-document-picker';
import {File} from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

import type {UploadIssue} from '@momo/core/features/attachments/model';

export interface PickedAttachmentFile {
  uri: string;
  name: string;
  mime: string;
  sizeBytes: number;
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

function fileSize(uri: string, reported: number | undefined): number {
  if (reported !== undefined && Number.isFinite(reported) && reported >= 0) {
    return reported;
  }
  try {
    const measured = new File(uri).size;
    return Number.isFinite(measured) && measured >= 0 ? measured : 0;
  } catch {
    return 0;
  }
}

/**
 * PHPicker 사진 선택. iOS 14+에서는 읽기 권한을 선제 요청하지 않는다.
 *
 * 계약상 거부 상태는 버리지 않는다. 정상 경로를 막는 사전 권한 확인 대신 picker
 * 자체가 실패한 뒤에만 실제 권한 상태를 물어, 그 답이 거부일 때 설정 안내로 잇는다.
 */
export async function pickPhoto(): Promise<AttachmentPickerOutcome> {
  try {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: false,
      quality: 1,
    });
    if (result.canceled || result.assets.length === 0) {
      return {kind: 'issue', issue: 'selection-cancelled'};
    }
    const asset = result.assets[0];
    return {
      kind: 'picked',
      files: [
        {
          uri: asset.uri,
          name: asset.fileName ?? fileNameFromUri(asset.uri, 'photo.jpg'),
          mime: asset.mimeType ?? 'image/jpeg',
          sizeBytes: fileSize(asset.uri, asset.fileSize),
        },
      ],
    };
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
    return {
      kind: 'picked',
      files: [
        {
          uri: asset.uri,
          name: asset.name,
          mime: asset.mimeType ?? 'application/octet-stream',
          sizeBytes: fileSize(asset.uri, asset.size),
        },
      ],
    };
  } catch {
    return {kind: 'issue', issue: 'unavailable'};
  }
}
