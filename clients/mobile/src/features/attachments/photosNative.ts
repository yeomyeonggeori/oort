import {Directory, File, Paths} from 'expo-file-system';
import {ImageManipulator, SaveFormat} from 'expo-image-manipulator';
import * as MediaLibrary from 'expo-media-library/legacy';
import {Linking} from 'react-native';

import {PHOTO_CARD} from './photoCardDesign';
import {
  permissionFromResponse,
  resolvePhotoWith,
  type PhotoAsset,
  type PhotoFileGateway,
  type PhotoLibraryPorts,
  type PhotoPage,
} from './photoLibrary';

// =============================================================================
// 사진 보관함의 네이티브 포트 — `expo-media-library` 가 닿는 **유일한** 파일 (ADR-0168 증보 1).
//
// `expo-media-library/legacy` 를 읽는 이유: Expo SDK 57 에서 패키지 루트(`expo-media-library`)는
// 클래스 기반 새 API(`Query`·`Asset`)로 바뀌었고, 옛 함수 이름(`getAssetsAsync`·
// `getAssetInfoAsync`·`presentPermissionsPickerAsync`)을 루트에서 부르면 **런타임에 던진다**
// (`legacyWarnings.ts`). 이 카드에 필요한 것은 커서 페이지(`after`)와 자산별 로컬 파일이고,
// 둘 다 옛 API 가 한 번의 호출로 준다 — 새 API 는 속성마다 비동기 호출이다. `./legacy` 는
// SDK 58 에서도 제공된다(패키지 `exports`). 새 API 로의 이행은 별도 일이다.
//
// 읽기만 한다. 쓰기·삭제·앨범 API(`saveToLibraryAsync`·`createAssetAsync` …)는 부르지 않으며,
// `projectShape.test.ts` 가 앱 소스에서 그 이름이 나타나면 빨개진다(Info.plist 의 「저장하지
// 않아요」 선언이 거짓이 되는 날을 알린다).
// =============================================================================

/** HEIC·HEIF 를 JPEG 로 다시 쓸 때의 품질. 사진에서 눈에 띄는 손실이 없는 값이고 크기는 원본 HEIC 의 2~3배다. */
export const HEIC_JPEG_QUALITY = 0.9;

/** 앱 캐시 아래 복사본이 사는 디렉터리. OS 가 용량이 모자라면 비우는 자리다. */
export const PHOTO_ATTACH_DIRECTORY = 'oort-photo-attach';

function toAsset(asset: MediaLibrary.Asset): PhotoAsset {
  return {
    id: asset.id,
    uri: asset.uri,
    filename: asset.filename,
    width: asset.width,
    height: asset.height,
    creationTimeMs: asset.creationTime,
  };
}

function attachDirectory(): Directory {
  const directory = new Directory(Paths.cache, PHOTO_ATTACH_DIRECTORY);
  if (!directory.exists) directory.create({intermediates: true, idempotent: true});
  return directory;
}

const gateway: PhotoFileGateway = {
  async info(id, download) {
    const info = await MediaLibrary.getAssetInfoAsync(id, {
      shouldDownloadFromNetwork: download,
    });
    return {localUri: info.localUri, isNetworkAsset: info.isNetworkAsset};
  },
  async copyToCache(uri, extension) {
    const target = new File(
      attachDirectory(),
      `${crypto.randomUUID()}.${extension === '' ? 'jpg' : extension}`,
    );
    await new File(uri).copy(target);
    return target.uri;
  },
  async toJpeg(uri) {
    const context = ImageManipulator.manipulate(uri);
    try {
      const rendered = await context.renderAsync();
      try {
        const saved = await rendered.saveAsync({
          compress: HEIC_JPEG_QUALITY,
          format: SaveFormat.JPEG,
        });
        return saved.uri;
      } finally {
        rendered.release();
      }
    } finally {
      context.release();
    }
  },
  sizeOf(uri) {
    try {
      const file = new File(uri);
      return file.exists && Number.isFinite(file.size) && file.size >= 0
        ? file.size
        : null;
    } catch {
      return null;
    }
  },
};

export const nativePhotoPorts: PhotoLibraryPorts = {
  async getPermission() {
    return permissionFromResponse(await MediaLibrary.getPermissionsAsync());
  },
  async requestPermission() {
    return permissionFromResponse(await MediaLibrary.requestPermissionsAsync());
  },
  async presentLimitedPicker() {
    await MediaLibrary.presentPermissionsPickerAsync(['photo']);
  },
  async listPhotos(after, first): Promise<PhotoPage> {
    const page = await MediaLibrary.getAssetsAsync({
      first: first > 0 ? first : PHOTO_CARD.pageSize,
      after: after ?? undefined,
      mediaType: ['photo'],
      sortBy: [['creationTime', false]],
    });
    return {
      assets: page.assets.map(toAsset),
      endCursor: page.endCursor ?? null,
      hasNextPage: page.hasNextPage,
    };
  },
  resolvePhoto(asset, hooks) {
    return resolvePhotoWith(gateway, asset, hooks);
  },
  subscribe(onChange) {
    const subscription = MediaLibrary.addListener(() => onChange());
    return () => subscription.remove();
  },
  openSettings() {
    void Linking.openSettings();
  },
};
