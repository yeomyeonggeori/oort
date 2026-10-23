import {MAX_ATTACHMENTS_PER_MESSAGE} from '@momo/core/features/attachments/model';

import type {PickedAttachmentFile} from './picker';

// =============================================================================
// 사진 보관함의 순수 절반 — 권한 4상태·선택·자산→파일 계획 (#4181, ADR-0168 증보 1).
//
// 이 파일에는 expo 모듈이 한 줄도 없다. 네이티브에 닿는 것은 `photosNative.ts` 하나뿐이고
// (`projectShape.test.ts` 가 그 한 파일임을 지킨다), 카드와 훅은 아래 `PhotoLibraryPorts`
// 만 안다. 그래서 시험은 expo 목 없이 포트를 바꿔 끼우고, 캡처 하네스는 시뮬레이터에서
// **일부 허용·미결정 상태를 주입**한다 — `xcrun simctl privacy` 는 허용·거부·초기화만
// 있고 「일부 허용」을 만들지 못한다.
//
// ## 권한 규칙 (ADR-0168 증보 1 D3)
//
//   카드가 닫혀 있는 동안  → 권한 API 호출 0 (앱 시작·메뉴 열기·컴포저 마운트 포함)
//   카드를 열면            → `getPermission` 한 번(프롬프트 없는 상태 읽기), 요청 0
//   「허용」을 누르면      → `requestPermission` 한 번. **미결정일 때만 그 버튼이 선다**
//
// iOS 는 한 번 거부한 앱에 다시 묻지 않는다. 그러므로 거부 상태에 「허용」을 세우면 누를
// 때마다 아무 일도 안 일어난다 — 거부에는 「설정 열기」만 선다.
// =============================================================================

/** 사진 보관함 읽기 권한의 4상태. `limited`(일부 허용)는 정상 경로다. */
export type PhotoPermission = 'undetermined' | 'denied' | 'limited' | 'granted';

/** 그리드가 그리는 사진 한 장. `uri` 는 `ph://`(작은 썸네일용, 파일이 아니다). */
export interface PhotoAsset {
  id: string;
  uri: string;
  filename: string;
  width: number;
  height: number;
  /** 촬영 시각(ms). 낭독용 날짜에만 쓴다. */
  creationTimeMs: number;
}

export interface PhotoPage {
  assets: PhotoAsset[];
  /** 다음 쪽을 부를 때 `after` 로 넘기는 마지막 자산 id. 없으면 null. */
  endCursor: string | null;
  hasNextPage: boolean;
}

/** 파일로 바꾸다 실패한 이유. 화면이 말하는 문장이 갈린다. */
export type PhotoResolveReason = 'unavailable' | 'cloud';

export class PhotoResolveError extends Error {
  constructor(readonly reason: PhotoResolveReason) {
    super(`photo resolve failed: ${reason}`);
    this.name = 'PhotoResolveError';
  }
}

/** 카드가 네이티브에 닿는 유일한 면. 시험·하네스는 이것을 바꿔 끼운다. */
export interface PhotoLibraryPorts {
  /** 프롬프트 없는 상태 읽기. */
  getPermission(): Promise<PhotoPermission>;
  /** 시스템 프롬프트. 미결정일 때만 부른다. */
  requestPermission(): Promise<PhotoPermission>;
  /** 일부 허용에서 보여 줄 사진을 시스템 창에서 바꾼다. 끝을 알려 주지 않는다. */
  presentLimitedPicker(): Promise<void>;
  /** 최신순 한 쪽. `after` 가 사라진 자산이면 던진다(호출자가 첫 쪽으로 되돌린다). */
  listPhotos(after: string | null, first: number): Promise<PhotoPage>;
  /** 한 장을 올릴 수 있는 로컬 파일로. iCloud 에 있으면 받기 직전에 `onDownloading` 을 부른다. */
  resolvePhoto(
    asset: PhotoAsset,
    hooks: {onDownloading: () => void},
  ): Promise<PickedAttachmentFile>;
  /** 보관함 변경(허용 사진을 바꾼 것 포함)을 듣는다. 해제 함수를 돌려준다. */
  subscribe(onChange: () => void): () => void;
  /** 기기 설정 앱의 oort 화면. */
  openSettings(): void;
}

// ---- 권한 --------------------------------------------------------------------

/** expo 의 `{status, accessPrivileges}` → 4상태. `limited` 는 status 가 granted 여도 따로 선다. */
export function permissionFromResponse(response: {
  status: string;
  accessPrivileges?: string;
}): PhotoPermission {
  if (response.accessPrivileges === 'limited') return 'limited';
  if (response.status === 'granted') return 'granted';
  if (response.status === 'denied') return 'denied';
  return 'undetermined';
}

/** 사진을 읽을 수 있는 상태인가. 그리드가 서는 두 상태다. */
export function canReadPhotos(permission: PhotoPermission): boolean {
  return permission === 'granted' || permission === 'limited';
}

// ---- 선택 --------------------------------------------------------------------

/**
 * 이 메시지에 더 붙일 수 있는 수. 트레이에 이미 있는 것을 뺀다.
 *
 * `addPickedFiles` 는 한 건이라도 거절되면 던진다(`draftStore.ts`: 「rejected 는 도달 불가
 * 불변식」). 여러 장을 한 번에 넘기는 이 카드가 그 불변식을 지키는 방법은 **고르는 순간
 * 상한을 건다**는 것이다 — 그래서 상한은 20 이 아니라 `20 - 트레이 개수`다.
 */
export function photoRoom(draftCount: number): number {
  return Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - draftCount);
}

export interface SelectionResult {
  next: string[];
  /** 상한 때문에 더하지 못했다. 화면이 이유를 말한다. */
  blocked: boolean;
}

/**
 * 탭 = 선택 토글. 순서가 곧 순번이라 배열이 정본이다(빼면 뒤 사진의 번호가 하나씩 당겨진다).
 * 이미 고른 것을 다시 누르는 것은 언제나 허용된다 — 상한에서 막히는 것은 **더하기**뿐이다.
 */
export function toggleSelection(
  selected: readonly string[],
  id: string,
  room: number,
): SelectionResult {
  if (selected.includes(id)) {
    return {next: selected.filter(value => value !== id), blocked: false};
  }
  if (selected.length >= room) return {next: [...selected], blocked: true};
  return {next: [...selected, id], blocked: false};
}

/** 사진의 순번(1부터). 고르지 않았으면 0. */
export function selectionOrder(selected: readonly string[], id: string): number {
  return selected.indexOf(id) + 1;
}

/** 상한이 줄었을 때(첨부가 다른 경로로 늘었다) 뒤쪽 선택부터 걷어 낸다. */
export function clampSelection(selected: readonly string[], room: number): string[] {
  return selected.length <= room ? [...selected] : selected.slice(0, room);
}

// ---- 낭독용 날짜 -------------------------------------------------------------

/** 「10월 21일」. `Intl` 에 기대지 않는다(Hermes 의 로케일 지원은 빌드마다 다르다). */
export function photoDateLabel(creationTimeMs: number): string | null {
  if (!Number.isFinite(creationTimeMs) || creationTimeMs <= 0) return null;
  const date = new Date(creationTimeMs);
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

// ---- 자산 → 파일 ------------------------------------------------------------

/** 확장자(소문자, 점 없음). 없으면 빈 문자열. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  avif: 'image/avif',
  dng: 'image/x-adobe-dng',
};

/** 사진의 MIME 은 확장자로 가른다. 모르는 확장자는 사진이므로 `image/jpeg` 가 아니라 바이트 그대로다. */
export function mimeForExtension(extension: string): string {
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/**
 * HEIC·HEIF 는 JPEG 로 바꿔 올린다.
 *
 * 아이폰 카메라 사진의 대부분이 HEIC 이고, 웹(크롬)과 안드로이드는 그것을 인라인으로 못
 * 그린다(웹 `draftThumbnail.ts`: 디코드 못 하는 이미지는 아이콘으로 돌아간다). 기존 시스템
 * picker 경로(`pickPhoto`)가 같은 사진을 어떤 형식으로 주는지는 PHPicker 의 `automatic`
 * 모드가 「시스템이 고른 최선」이라 실기기로 확인하기 전에는 단정하지 못한다 — 그래서
 * 이 규칙은 **한 곳**에 두고 시험이 못 박는다. 반대로 판명되면 이 함수 하나가 `false` 를
 * 돌려주면 된다.
 */
export function needsJpeg(extension: string): boolean {
  return extension === 'heic' || extension === 'heif';
}

/** `IMG_0412.HEIC` → `IMG_0412.jpg`. */
export function jpegName(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  return `${stem === '' ? 'photo' : stem}.jpg`;
}

/** 파일 이름이 없는 자산(드물다)의 이름. */
export function fallbackName(asset: PhotoAsset, extension: string): string {
  return `photo-${asset.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'asset'}.${
    extension === '' ? 'jpg' : extension
  }`;
}

/** `resolvePhotoWith` 가 실제 네이티브에서 빌리는 다섯 가지. */
export interface PhotoFileGateway {
  /** 자산의 원본 로컬 파일. `download` 가 false 면 기기에 있는 것만 본다. */
  info(
    id: string,
    download: boolean,
  ): Promise<{localUri?: string | null; isNetworkAsset?: boolean}>;
  /** 원본을 앱 캐시로 복사한다(보관함 파일을 업로드 시점까지 붙들지 않는다). */
  copyToCache(uri: string, extension: string): Promise<string>;
  /** 이미지를 JPEG 로 다시 쓴다. 결과는 앱 캐시의 새 파일이다. */
  toJpeg(uri: string): Promise<string>;
  /** 파일 크기. 모르면 null. */
  sizeOf(uri: string): number | null;
}

/**
 * 한 장을 `PickedAttachmentFile` 로 — 이름·MIME·크기는 기존 picker 계약 그대로다.
 *
 * 순서가 이 함수의 내용이다:
 *   1. 기기에 있는 원본을 먼저 찾는다(`download:false`). 있으면 그것으로 끝.
 *   2. 없고 iCloud 에 있다고 하면 **그때만** `onDownloading` 을 부르고 내려받는다. 화면은
 *      그 순간에만 「iCloud에서 내려받는 중」을 말한다 — 기기에 있는 사진에 그 문장이 서면
 *      거짓이다.
 *   3. 그래도 파일이 없으면 던진다. 이유가 iCloud 였는지가 사람의 다음 행동(연결 확인)을 가른다.
 */
export async function resolvePhotoWith(
  gateway: PhotoFileGateway,
  asset: PhotoAsset,
  hooks: {onDownloading: () => void},
): Promise<PickedAttachmentFile> {
  let found = await gateway.info(asset.id, false);
  const inCloud = found.isNetworkAsset === true;
  if (!found.localUri && inCloud) {
    hooks.onDownloading();
    found = await gateway.info(asset.id, true);
  }
  const source = found.localUri;
  if (!source) {
    throw new PhotoResolveError(inCloud ? 'cloud' : 'unavailable');
  }

  const extension = extensionOf(asset.filename) || extensionOf(source);
  const baseName = asset.filename === '' ? fallbackName(asset, extension) : asset.filename;

  let uri: string;
  let name: string;
  let mime: string;
  if (needsJpeg(extension)) {
    uri = await gateway.toJpeg(source);
    name = jpegName(baseName);
    mime = 'image/jpeg';
  } else {
    uri = await gateway.copyToCache(source, extension);
    name = baseName;
    mime = mimeForExtension(extension);
  }
  const measured = gateway.sizeOf(uri);
  return {
    uri,
    name,
    mime,
    sizeBytes: measured ?? 0,
    sizeKnown: measured !== null,
  };
}
