import {
  MEMBER_AVATAR_TOO_LARGE,
  memberAvatarUploadError,
} from '@momo/core/features/settings/memberAvatarCopy';
import {uploadMyAvatarWith} from '@momo/core/features/settings/memberAvatarUpload';
import {MEMBER_AVATAR_MAX_BYTES, type RosterMember} from '@momo/core/lib/api';

// =============================================================================
// 내 프로필 사진 바꾸기 — 고르기 → 정사각 → 512 로 줄이기 → 올리기 (#4384).
//
// 서버는 이미 있다(`POST …/members/me/avatar/uploads` → Drive PUT → `…/complete`,
// ADR-0161 증보). 이 파일은 폰이 그것을 부르기 전에 하는 일의 순서와 약속이다:
//
//   * 자르기는 시스템 편집기(`allowsEditing`)가 한다 — 가운데가 기본이고 끌어 맞춘다. 그 결과가
//     정사각이 아니면(편집기를 건너뛰는 길) 여기서 가운데를 정사각으로 자른다.
//   * **언제나 다시 인코딩한다.** 작은 사진도 그대로 올리지 않는다 — 재인코딩이 EXIF(위치 정보)를
//     벗기고 HEIC·PNG·GIF 를 JPEG 로 정규화한다. 긴 변은 512 를 넘지 않는다(더 작으면 키우지 않는다).
//   * 줄인 파일이 5MiB 를 넘으면 서버를 부르지 않는다(세션을 열지 않는다).
//   * Drive PUT 이 실패하면 complete 를 부르지 않는다(코어 `uploadMyAvatarWith`).
//   * 임시 파일(고른 것·줄인 것)은 어느 길로 끝나든 지운다.
//
// 고르기·줄이기·올리기·지우기는 포트(`AvatarPhotoPorts`)로 받는다. 네이티브 구현은
// `avatarPhotoNative.ts` 에만 있고, 시험은 포트를 바꿔 호출 인자와 순서를 잰다.
// =============================================================================

export const AVATAR_LONG_SIDE = 512;
export const AVATAR_JPEG_QUALITY = 0.85;
export const AVATAR_MIME = 'image/jpeg';
export const AVATAR_FILE_NAME = 'avatar.jpg';

export type AvatarSource = 'library' | 'camera';

export type AvatarPickOutcome =
  | {kind: 'picked'; uri: string; width: number; height: number}
  | {kind: 'cancelled'}
  | {kind: 'denied'}
  /** 카메라가 열리지 못했다(시뮬레이터·제한). 올린 적은 없다. */
  | {kind: 'camera-unavailable'}
  | {kind: 'error'};

export interface SquareCrop {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

export interface AvatarShrinkRequest {
  /** 먼저 가운데를 정사각으로 자른다. 이미 정사각이면 `null`. */
  crop: SquareCrop | null;
  /** 자른 뒤의 긴 변이 이 값을 넘으면 이 값으로 줄인다. 아니면 `null`(키우지 않는다). */
  resizeLongSide: number | null;
  quality: number;
}

export interface AvatarPhotoPorts {
  pick(source: AvatarSource): Promise<AvatarPickOutcome>;
  /** 자르고 줄여 JPEG 한 장으로 다시 쓴다(EXIF 없음). 새 파일의 주소를 준다. */
  shrink(
    uri: string,
    request: AvatarShrinkRequest,
  ): Promise<{uri: string; width: number; height: number}>;
  /** 바이트 수. 읽지 못하면 `null`. */
  sizeOf(uri: string): number | null;
  /** capability URL 로 바이트를 PUT 한다. */
  put(uploadUrl: string, uri: string, mime: string): Promise<{ok: boolean}>;
  /** 임시 파일을 지운다. 실패해도 던지지 않는다. */
  discard(uri: string): void;
}

export type AvatarFailure =
  | {kind: 'denied'; source: AvatarSource}
  | {kind: 'camera-unavailable'}
  | {kind: 'unreadable'}
  | {kind: 'too-large'}
  | {kind: 'upload'; message: string};

export type AvatarOutcome =
  | {ok: true; avatarUrl: string}
  | {ok: false; cancelled: true}
  | {ok: false; cancelled: false; failure: AvatarFailure};

/** 정사각이 아니면 가운데 정사각. 1px 차이는 정사각으로 본다(반올림 차이). */
export function centerSquareCrop(width: number, height: number): SquareCrop | null {
  if (Math.abs(width - height) <= 1) return null;
  const side = Math.min(width, height);
  return {
    originX: Math.floor((width - side) / 2),
    originY: Math.floor((height - side) / 2),
    width: side,
    height: side,
  };
}

export function shrinkRequestFor(width: number, height: number): AvatarShrinkRequest {
  const crop = centerSquareCrop(width, height);
  const side = crop === null ? Math.max(width, height) : crop.width;
  return {
    crop,
    resizeLongSide: side > AVATAR_LONG_SIDE ? AVATAR_LONG_SIDE : null,
    quality: AVATAR_JPEG_QUALITY,
  };
}

export const AVATAR_DENIED_COPY: Record<AvatarSource, string> = {
  library: '사진 접근이 꺼져 있어요. 설정에서 사진을 허용하면 프로필 사진을 고를 수 있어요.',
  camera: '카메라 접근이 꺼져 있어요. 설정에서 카메라를 허용하면 사진을 찍을 수 있어요.',
};
export const AVATAR_CAMERA_UNAVAILABLE_COPY = '이 기기에서는 카메라를 열 수 없어요. 사진 고르기를 써 주세요.';
export const AVATAR_UNREADABLE_COPY = '이 사진을 읽지 못했어요. 다른 사진을 골라 주세요.';

export function avatarFailureCopy(failure: AvatarFailure): string {
  switch (failure.kind) {
    case 'denied':
      return AVATAR_DENIED_COPY[failure.source];
    case 'camera-unavailable':
      return AVATAR_CAMERA_UNAVAILABLE_COPY;
    case 'unreadable':
      return AVATAR_UNREADABLE_COPY;
    case 'too-large':
      return MEMBER_AVATAR_TOO_LARGE;
    case 'upload':
      return failure.message;
  }
}

export async function changeAvatarPhoto(
  workspaceId: string,
  source: AvatarSource,
  ports: AvatarPhotoPorts,
): Promise<AvatarOutcome> {
  const fail = (failure: AvatarFailure): AvatarOutcome => ({
    ok: false,
    cancelled: false,
    failure,
  });

  const picked = await ports.pick(source);
  if (picked.kind === 'cancelled') return {ok: false, cancelled: true};
  if (picked.kind === 'denied') return fail({kind: 'denied', source});
  if (picked.kind === 'camera-unavailable') return fail({kind: 'camera-unavailable'});
  if (picked.kind === 'error') return fail({kind: 'unreadable'});
  if (
    !Number.isFinite(picked.width) ||
    !Number.isFinite(picked.height) ||
    picked.width <= 0 ||
    picked.height <= 0
  ) {
    ports.discard(picked.uri);
    return fail({kind: 'unreadable'});
  }

  let shrunkUri: string | null = null;
  try {
    let shrunk: {uri: string; width: number; height: number};
    try {
      shrunk = await ports.shrink(
        picked.uri,
        shrinkRequestFor(picked.width, picked.height),
      );
    } catch {
      return fail({kind: 'unreadable'});
    }
    shrunkUri = shrunk.uri;

    const size = ports.sizeOf(shrunk.uri);
    if (size === null || size <= 0) return fail({kind: 'unreadable'});
    if (size > MEMBER_AVATAR_MAX_BYTES) return fail({kind: 'too-large'});

    try {
      const media = await uploadMyAvatarWith(
        workspaceId,
        {name: AVATAR_FILE_NAME, mime: AVATAR_MIME, size},
        uploadUrl => ports.put(uploadUrl, shrunk.uri, AVATAR_MIME),
      );
      return {ok: true, avatarUrl: media.avatarUrl};
    } catch (error: unknown) {
      return fail({kind: 'upload', message: memberAvatarUploadError(error)});
    }
  } finally {
    ports.discard(picked.uri);
    if (shrunkUri !== null && shrunkUri !== picked.uri) ports.discard(shrunkUri);
  }
}

/**
 * roster 에서 **나만** 아바타 주소를 바꾼다(`undefined` 면 지운다). 남의 행은 같은 객체로 둔다 —
 * 사이드바·대화·프로필이 같은 roster 를 읽어서 이 한 번의 교체가 「모든 표면에서 바로」의 전부다.
 * 주소의 `?v=` 가 바뀌어 `memberAvatarImage` 캐시는 새 파일을 받는다.
 */
export function withMyAvatar(
  rows: RosterMember[] | undefined,
  memberId: string,
  avatarUrl: string | undefined,
): RosterMember[] | undefined {
  if (rows === undefined) return rows;
  return rows.map(row => {
    if (row.id !== memberId) return row;
    const next: RosterMember = {...row};
    if (avatarUrl === undefined) delete next.avatarUrl;
    else next.avatarUrl = avatarUrl;
    return next;
  });
}
