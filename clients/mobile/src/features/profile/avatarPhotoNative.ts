import {File} from 'expo-file-system';
import * as Device from 'expo-device';
import * as ImagePicker from 'expo-image-picker';
import {ImageManipulator, SaveFormat} from 'expo-image-manipulator';

import {memberAvatarGeneration, seedMemberAvatar} from '../conversation/memberAvatarImage';
import {putAttachmentBytes} from '../attachments/uploadTransport';
import type {AvatarPhotoPorts, AvatarPickOutcome, AvatarSource} from './avatarPhoto';

// =============================================================================
// 프로필 사진의 네이티브 포트 — 실제 expo 모듈이 닿는 유일한 파일 (#4384).
//
// 자르기는 시스템 편집기다(`allowsEditing`, iOS 는 항상 정사각 — 가운데가 기본이고 끌어
// 맞춘다). 새 의존이 없다: 첨부·배경이 이미 쓰는 `expo-image-picker`·`expo-image-manipulator`.
// 권한 문구는 Info.plist 의 기존 키(`NSPhotoLibraryUsageDescription`·`NSCameraUsageDescription`).
//
// 사진 보관함: 편집기를 쓰는 길은 PHPicker 가 아니라 `UIImagePickerController` 라 선택만으로
// 권한을 묻지 않는다. 실패한 **뒤에만** 권한 상태를 물어 거부일 때 안내로 잇는다.
// 카메라: 첨부의 `pickCamera`(#4180)와 같은 순서 — 권한을 먼저 받고, **실기기가 아니면 열지
// 않는다**(시뮬레이터에서 `sourceType = .camera` 가 네이티브 예외로 앱을 죽인다).
// =============================================================================

const EDIT_OPTIONS = {
  mediaTypes: ['images'] as ImagePicker.MediaType[],
  allowsEditing: true,
  aspect: [1, 1] as [number, number],
  exif: false,
  quality: 1,
};

function outcomeOf(result: ImagePicker.ImagePickerResult): AvatarPickOutcome {
  if (result.canceled || result.assets.length === 0) return {kind: 'cancelled'};
  const asset = result.assets[0];
  return {kind: 'picked', uri: asset.uri, width: asset.width, height: asset.height};
}

async function pickLibrary(): Promise<AvatarPickOutcome> {
  try {
    return outcomeOf(await ImagePicker.launchImageLibraryAsync(EDIT_OPTIONS));
  } catch {
    try {
      const permission = await ImagePicker.getMediaLibraryPermissionsAsync();
      if (permission.status === 'denied') return {kind: 'denied'};
    } catch {
      // 권한을 못 물어도 고르기 실패로 접는다.
    }
    return {kind: 'error'};
  }
}

async function pickCamera(): Promise<AvatarPickOutcome> {
  try {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return {kind: 'denied'};
    if (!Device.isDevice) return {kind: 'camera-unavailable'};
    return outcomeOf(await ImagePicker.launchCameraAsync(EDIT_OPTIONS));
  } catch {
    return {kind: 'camera-unavailable'};
  }
}

// 고르기 시작할 때의 캐시 세대. 올리는 사이 로그아웃·계정 교체로 캐시가 비워졌으면 시드하지 않는다
// (앞 사람의 사진이 비운 뒤 디스크에 다시 쓰이지 않게).
let pickedGeneration = memberAvatarGeneration();

export const nativeAvatarPhotoPorts: AvatarPhotoPorts = {
  pick: (source: AvatarSource) => {
    pickedGeneration = memberAvatarGeneration();
    return source === 'camera' ? pickCamera() : pickLibrary();
  },
  async shrink(uri, {crop, resizeLongSide, quality}) {
    const context = ImageManipulator.manipulate(uri);
    if (crop !== null) context.crop(crop);
    // 자른 뒤는 정사각(많아야 1px 차이)이라 가로로 줄이면 긴 변이 줄어든다.
    if (resizeLongSide !== null) context.resize({width: resizeLongSide});
    const rendered = await context.renderAsync();
    const saved = await rendered.saveAsync({compress: quality, format: SaveFormat.JPEG});
    return {uri: saved.uri, width: saved.width, height: saved.height};
  },
  sizeOf(uri) {
    try {
      const file = new File(uri);
      return file.exists && Number.isFinite(file.size) ? file.size : null;
    } catch {
      return null;
    }
  },
  async put(uploadUrl, uri, mime) {
    const result = await putAttachmentBytes(uploadUrl, uri, mime, () => undefined).done;
    return {ok: result.ok};
  },
  seed(avatarUrl, uri) {
    seedMemberAvatar(avatarUrl, uri, pickedGeneration);
  },
  // 시뮬레이터에서 `sourceType = .camera` 는 네이티브 예외다 — 실기기만 줄을 세운다.
  cameraAvailable: () => Device.isDevice,
  discard(uri) {
    try {
      const file = new File(uri);
      if (file.exists) file.delete();
    } catch {
      // 임시 파일이다 — OS 가 거둔다.
    }
  },
};
