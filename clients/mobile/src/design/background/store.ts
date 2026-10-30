import {NON_SECRET_KEYS, nonSecretStore} from '../../storage/kv';
import {
  NO_BACKGROUND,
  parseBackground,
  serializeBackground,
  type BackgroundChoice,
} from '@momo/core/design/mobileBackground';
import {importPhoto, type ImportOutcome, type PhotoPorts} from './photo';

// =============================================================================
// 배경 선택의 저장소 — React 밖의 한 곳 (ADR-0189 증보 2, #3907).
//
// 프로바이더(`design/theme.tsx`)는 이것을 구독해 읽고, **로그아웃은 React 밖에서 이것을
// 부른다**(`session/useSession.tsx`). 그래서 상태가 컨텍스트 안이 아니라 모듈에 있다:
// 세션이 끝날 때 프로바이더는 살아 있지만 세션 훅은 그것을 모른다.
//
// 디스크(파일 연산)는 `DiskPort` 로 받는다. 네이티브 실제 구현은 `photoNative.ts` 다.
// =============================================================================

export interface DiskPort {
  uri(name: string): string;
  exists(name: string): boolean;
  remove(name: string): void;
  clearAll(): void;
}

let disk: DiskPort | null = null;

function port(): DiskPort {
  if (disk === null) {
    // 지연 require — 네이티브 모듈이 없는 환경(일부 하네스)이 이 파일을 import 만 해도
    // 깨지지 않게 한다.
    const native = require('./photoNative') as typeof import('./photoNative');
    disk = {
      uri: native.backgroundFileUri,
      exists: native.backgroundFileExists,
      remove: native.removeBackgroundFile,
      clearAll: native.clearBackgroundFiles,
    };
  }
  return disk;
}

/** 시험 전용: 디스크 포트를 바꾼다. */
export function __setDiskPort(next: DiskPort | null): void {
  disk = next;
}

let current: BackgroundChoice | null = null;
const listeners = new Set<() => void>();

function readStored(): BackgroundChoice {
  try {
    return parseBackground(nonSecretStore().getString(NON_SECRET_KEYS.background));
  } catch {
    return NO_BACKGROUND;
  }
}

function writeStored(choice: BackgroundChoice): void {
  try {
    if (choice.kind === 'none') nonSecretStore().remove(NON_SECRET_KEYS.background);
    else nonSecretStore().set(NON_SECRET_KEYS.background, serializeBackground(choice));
  } catch {
    // 이번 실행에는 적용되고 다음 실행에는 잊힌다.
  }
}

/**
 * 지금 선택. 첫 읽기에서 한 번 저장소를 읽고, 사진이 가리키는 파일이 사라졌으면(OS 가
 * 지웠거나 손댔거나) **없음**으로 되돌린다 — 파일 없는 사진 선택이 화면에 남아
 * 이미지 없는 바닥을 그리지 않게.
 */
export function getBackground(): BackgroundChoice {
  if (current === null) {
    let stored = readStored();
    if (stored.kind === 'photo') {
      let present = false;
      try {
        present = port().exists(stored.file);
      } catch {
        present = false;
      }
      if (!present) {
        stored = NO_BACKGROUND;
        writeStored(stored);
      }
    }
    current = stored;
  }
  return current;
}

/** 사진 파일의 이미지 주소(`file://`). */
export function backgroundPhotoUri(name: string): string {
  return port().uri(name);
}

export function subscribeBackground(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function removePhotoIfReplaced(previous: BackgroundChoice, next: BackgroundChoice): void {
  if (previous.kind !== 'photo') return;
  if (next.kind === 'photo' && next.file === previous.file) return;
  try {
    port().remove(previous.file);
  } catch {
    // 남은 파일은 다음 로그아웃의 `clearAll` 이 거둔다.
  }
}

export function setBackground(next: BackgroundChoice): void {
  const previous = getBackground();
  current = next;
  writeStored(next);
  removePhotoIfReplaced(previous, next);
  emit();
}

/** 「기본으로」 — 선택을 지우고 사진 파일도 지운다. */
export function resetBackground(): void {
  setBackground(NO_BACKGROUND);
}

/**
 * 로그아웃·세션 경계(토큰 만료·계정 교체)에서 부른다. **사진은 사람의 것**이라 다음 사람의
 * 기기에 남지 않게 디렉터리째 지우고, 사진 선택이면 없음으로 되돌린다. 단색·기본 제공은
 * 취향일 뿐 데이터가 아니라 남긴다.
 */
export function forgetBackgroundOnSignOut(): void {
  const previous = getBackground();
  try {
    port().clearAll();
  } catch {
    // 디렉터리 삭제가 실패해도 선택은 되돌린다 — 이름 규칙에 안 맞는 파일은 읽지 않는다.
  }
  if (previous.kind === 'photo') {
    current = NO_BACKGROUND;
    writeStored(NO_BACKGROUND);
    emit();
  }
}

/** 시험 전용: 메모리 상태를 버려 다음 읽기가 저장소에서 다시 읽게 한다. */
export function __resetBackgroundStoreForTests(): void {
  current = null;
  listeners.clear();
  disk = null;
}

/** 사진을 골라 처리하고, 성공하면 선택으로 올린다. 실패 이유는 호출부가 문장으로 바꾼다. */
export async function chooseBackgroundPhoto(ports?: PhotoPorts): Promise<ImportOutcome> {
  const resolved =
    ports ?? (require('./photoNative') as typeof import('./photoNative')).nativePhotoPorts;
  const outcome = await importPhoto(resolved);
  if (outcome.ok) setBackground(outcome.choice);
  return outcome;
}
