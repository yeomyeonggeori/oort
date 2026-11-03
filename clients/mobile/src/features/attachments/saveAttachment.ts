import type {MessageAttachment} from '@momo/core/features/attachments/model';

import {extensionOf} from './photoLibrary';

// =============================================================================
// 첨부 「저장」의 순수 절반 — 길 두 갈래·권한 순서·파일 이름 (#5209, ADR-0168 증보 3).
//
// 이 파일에는 expo 모듈이 한 줄도 없다. 네이티브에 닿는 것은 `photosNative.ts`(사진 보관함 — `expo-media-library` 에 닿는 유일한 파일)와
// `saveNative.ts`(파일 앱 — `expo-file-system`)뿐이고, 훅(`useSaveAttachment.ts`)과 화면은 아래 `SavePorts` 만 안다. 시험은 expo 목 없이 포트를
// 바꿔 끼운다.
//
// ## 두 갈래 (owner 결정 2026-11-03)
//
//   사진·영상  →  **사진 보관함에 바로 추가**한다(추가 전용 권한 — 처음 한 번만 묻고, 보관함을 읽지 않는다). 끝나면 「사진에 저장했어요」.
//   그 밖의 파일(PDF 등)  →  **파일 앱에서 위치를 고르고** 거기에 복사한다. 끝나면 「파일에 저장했어요」.
//   「공유」는 이 파일의 일이 아니다 — 공유 시트(`useShareAttachment`)가 그대로 맡는다.
//
// 사진 보관함이 받는 형식은 iOS 가 정한다: 이미지는 `UIImage(data:)` 가 읽는 것, 영상은 `UIVideoAtPathIsCompatibleWithSavedPhotosAlbum`
// 이 받는 것(mp4·mov·m4v)이다. 그 밖(SVG·WebM·PSD …)은 보관함에 넣으려 하면 **언제나** 실패하므로 처음부터 「파일에 저장」으로 간다 —
// 다시 눌러도 낫지 않는 실패를 「다시 시도」로 안내하지 않는다.
//
// ## 권한 순서 — 사진 갈래만, 내려받기보다 먼저
//
//   읽기(프롬프트 없음) → 미결정이면 시스템 프롬프트 한 번 → 허용이 아니면 **내려받지 않고** 「설정 열기」 안내.
//
// 거부된 사람에게 58 MB 영상을 받게 한 뒤 「저장할 수 없어요」라고 말하지 않는다. iOS 는 한 번 거부한 앱에 다시 묻지 않으므로 거부에는 프롬프트를
// 세우지 않고 설정으로 보낸다(`PHOTO_COPY.deniedDetail` 과 같은 규칙). 권한은 **사람이 저장을 누른 순간에만** 묻는다 — 앱 시작·뷰어 열기·카드
// 그리기에서는 묻지도 읽지도 않는다(`projectShape.test.ts` 가 호출처를 지킨다).
// =============================================================================

/** 어디에 저장하는가. */
export type SaveRoute = 'photos' | 'files';

/** 추가 전용 권한. 사진 읽기 권한(`PhotoPermission`)과 달리 「일부 허용」이 없다 — 추가에는 범위가 없다. */
export type AddPermission = 'undetermined' | 'denied' | 'granted';

/** 내려받아 둔 파일 한 건. `name` 은 사람이 보는 첨부 이름이다(캐시 파일 이름은 앞에 id 가 붙어 있다). */
export interface SaveFile {
  uri: string;
  name: string;
  mime: string;
}

/** 저장이 네이티브에 닿는 유일한 면. 시험·하네스는 이것을 바꿔 끼운다. */
export interface SavePorts {
  /** 추가 전용 권한의 프롬프트 없는 읽기. */
  getAddPermission(): Promise<AddPermission>;
  /** 시스템 프롬프트. 미결정일 때만 부른다. */
  requestAddPermission(): Promise<AddPermission>;
  /** 사진 보관함에 더한다. 확장자가 형식과 어긋나면 포트가 맞는 임시 사본으로 바꿔 넘긴다. */
  saveToLibrary(file: SaveFile): Promise<void>;
  /** 파일 앱에서 위치를 고르게 하고 복사한다. 고르지 않고 닫으면 `cancelled` — 실패가 아니다. */
  saveToFiles(file: SaveFile): Promise<'saved' | 'cancelled'>;
  /** 기기 설정 앱의 oort 화면. */
  openSettings(): void;
}

export type SaveOutcome =
  | {kind: 'saved'; route: SaveRoute}
  | {kind: 'denied'}
  | {kind: 'cancelled'}
  | {kind: 'failed'};

/** expo 의 `{status}` → 3상태. 추가에는 범위가 없어서 `accessPrivileges`(전체·일부)는 보지 않는다 — 허용이면 더할 수 있다. */
export function addPermissionFromResponse(response: {status: string}): AddPermission {
  if (response.status === 'granted') return 'granted';
  if (response.status === 'denied') return 'denied';
  return 'undetermined';
}

// ---- 길 -----------------------------------------------------------------------

/**
 * 사진 보관함이 받는 형식(MIME 본체 → 정식 확장자와 받아들이는 확장자). `saveToLibraryAsync` 는 확장자로 이미지·영상을 가르므로(`assetType(for:)`)
 * 확장자가 형식과 어긋난 파일은 「지원하지 않는 형식」으로 던진다 — 어긋나면 맞는 확장자의 사본을 만들어 넘긴다(`libraryExtension`).
 */
const LIBRARY_TYPES: Readonly<Record<string, {canonical: string; accepts: readonly string[]}>> = {
  'image/jpeg': {canonical: 'jpg', accepts: ['jpg', 'jpeg']},
  'image/jpg': {canonical: 'jpg', accepts: ['jpg', 'jpeg']},
  'image/png': {canonical: 'png', accepts: ['png']},
  'image/gif': {canonical: 'gif', accepts: ['gif']},
  'image/heic': {canonical: 'heic', accepts: ['heic', 'heif', 'hif']},
  'image/heif': {canonical: 'heif', accepts: ['heif', 'heic', 'hif']},
  'image/webp': {canonical: 'webp', accepts: ['webp']},
  'image/tiff': {canonical: 'tiff', accepts: ['tiff', 'tif']},
  'image/bmp': {canonical: 'bmp', accepts: ['bmp']},
  'image/avif': {canonical: 'avif', accepts: ['avif']},
  'video/mp4': {canonical: 'mp4', accepts: ['mp4', 'm4v']},
  'video/quicktime': {canonical: 'mov', accepts: ['mov', 'qt']},
  'video/x-m4v': {canonical: 'm4v', accepts: ['m4v', 'mp4']},
};

/** `image/png; charset=…` → `image/png`. 대소문자·매개변수는 보지 않는다. */
export function mimeEssence(mime: string): string {
  return mime.trim().toLowerCase().split(';')[0]?.trim() ?? '';
}

/** 이 첨부는 어디로 저장하는가. */
export function saveRouteFor(attachment: Pick<MessageAttachment, 'mime'>): SaveRoute {
  return mimeEssence(attachment.mime) in LIBRARY_TYPES ? 'photos' : 'files';
}

/**
 * 사진 보관함에 넘길 파일의 확장자를 고쳐야 하는가. 이름의 확장자가 형식에 맞으면 `null`(그대로 넘긴다), 없거나 어긋나면 그 형식의 정식
 * 확장자(그 확장자로 임시 사본을 만든다). 사진 갈래가 아닌 형식에는 `null` 이다.
 */
export function libraryExtension(mime: string, name: string): string | null {
  const type = LIBRARY_TYPES[mimeEssence(mime)];
  if (type === undefined) return null;
  return type.accepts.includes(extensionOf(name)) ? null : type.canonical;
}

// ---- 파일 이름 ----------------------------------------------------------------

/** 경로 구분자·제어 문자를 걷은 파일 이름. 비면 `attachment`. 사용자가 고른 폴더 안에서 이름이 경로가 되지 않게 한다. */
export function fileNameFor(name: string): string {
  const cleaned = Array.from(name.normalize('NFC').replace(/[\\/:]/g, '-'))
    .map(character => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? '-' : character;
    })
    .join('')
    .trim();
  return cleaned === '' ? 'attachment' : cleaned.slice(0, 120);
}

/** 같은 이름이 이미 있는 폴더에 저장할 때의 이름: `a.pdf` → `a 2.pdf` → `a 3.pdf` …. 같은 파일을 두 번 저장해도 덮어쓰지도 실패하지도 않는다. */
export function uniqueName(name: string, exists: (candidate: string) => boolean): string {
  if (!exists(name)) return name;
  const dot = name.lastIndexOf('.');
  const hasExtension = dot > 0 && name.length - dot <= 9;
  const stem = hasExtension ? name.slice(0, dot) : name;
  const tail = hasExtension ? name.slice(dot) : '';
  for (let count = 2; count <= 99; count += 1) {
    const candidate = `${stem} ${count}${tail}`;
    if (!exists(candidate)) return candidate;
  }
  // 백 번째 같은 이름은 사람이 아니라 기계의 일이다 — 시간으로 겹침을 피한다.
  return `${stem} ${Date.now()}${tail}`;
}

// ---- 실행 ---------------------------------------------------------------------

/**
 * 저장 한 번. 사진 갈래는 권한 → 내려받기 → 보관함, 파일 갈래는 내려받기 → 파일 앱 위치 고르기다. 던지지 않는다 — 결과(`SaveOutcome`)가 말한다.
 * `download` 는 호출 순서가 시험의 대상이라 인자로 받는다(권한이 내려받기보다 **먼저**다).
 */
export async function runSave(
  route: SaveRoute,
  {ports, download}: {ports: SavePorts; download: () => Promise<SaveFile>},
): Promise<SaveOutcome> {
  try {
    if (route === 'photos') {
      let permission = await ports.getAddPermission();
      if (permission === 'undetermined') permission = await ports.requestAddPermission();
      if (permission !== 'granted') return {kind: 'denied'};
      await ports.saveToLibrary(await download());
      return {kind: 'saved', route};
    }
    const outcome = await ports.saveToFiles(await download());
    return outcome === 'saved' ? {kind: 'saved', route} : {kind: 'cancelled'};
  } catch {
    return {kind: 'failed'};
  }
}
