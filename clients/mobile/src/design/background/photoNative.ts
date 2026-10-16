import {Directory, File, Paths} from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import {ImageManipulator, SaveFormat} from 'expo-image-manipulator';

import type {PhotoPorts, PickOutcome} from './photo';

// =============================================================================
// 내 사진의 네이티브 포트 — 실제 expo 모듈이 닿는 유일한 파일 (ADR-0189 증보 2).
//
// PHPicker 라 iOS 14+ 에서는 선택만으로 권한을 묻지 않는다(첨부 picker 와 같다,
// ADR-0168). picker 가 실패한 **뒤에만** 권한 상태를 물어 거부일 때 안내로 잇는다.
// =============================================================================

export const BACKGROUND_DIRECTORY = 'oort-background';

let cachedDirectory: Directory | null = null;

/** 앱 샌드박스의 Documents 아래. OS 가 용량 부족 때 비우는 캐시 디렉터리가 아니다. */
export function backgroundDirectory(): Directory {
  if (cachedDirectory === null) {
    const dir = new Directory(Paths.document, BACKGROUND_DIRECTORY);
    if (!dir.exists) dir.create({intermediates: true, idempotent: true});
    cachedDirectory = dir;
  }
  return cachedDirectory;
}

export function backgroundFileUri(name: string): string {
  return new File(backgroundDirectory(), name).uri;
}

export function backgroundFileExists(name: string): boolean {
  try {
    return new File(backgroundDirectory(), name).exists;
  } catch {
    return false;
  }
}

/** 파일 하나를 지운다. 없거나 실패해도 던지지 않는다 — 지우는 일이 흐름을 막으면 안 된다. */
export function removeBackgroundFile(name: string): void {
  try {
    const file = new File(backgroundDirectory(), name);
    if (file.exists) file.delete();
  } catch {
    // 남은 파일은 다음 `clearBackgroundFiles` 가 거둔다.
  }
}

/** 디렉터리째 비운다(로그아웃·초기화). */
export function clearBackgroundFiles(): void {
  try {
    const dir = new Directory(Paths.document, BACKGROUND_DIRECTORY);
    if (dir.exists) dir.delete();
  } catch {
    // 삭제 실패는 삼킨다 — 다음 실행의 `adopt` 가 이름 규칙에 안 맞는 파일을 무시한다.
  }
  cachedDirectory = null;
}

async function pick(): Promise<PickOutcome> {
  try {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: false,
      allowsEditing: false,
      exif: false,
      quality: 1,
    });
    if (result.canceled || result.assets.length === 0) return {kind: 'cancelled'};
    const asset = result.assets[0];
    return {kind: 'picked', uri: asset.uri, width: asset.width, height: asset.height};
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

export const nativePhotoPorts: PhotoPorts = {
  pick,
  async shrink(uri, {longSide, quality, width, height}) {
    const context = ImageManipulator.manipulate(uri);
    // 더 작은 사진은 키우지 않는다 — 재인코딩만 한다.
    if (Math.max(width, height) > longSide) {
      context.resize(width >= height ? {width: longSide} : {height: longSide});
    }
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
  keep(uri, name) {
    const destination = new File(backgroundDirectory(), name);
    new File(uri).move(destination);
  },
  discard(uri) {
    try {
      const file = new File(uri);
      if (file.exists) file.delete();
    } catch {
      // 임시 파일이다 — OS 가 거둔다.
    }
  },
  now: () => Date.now(),
};
