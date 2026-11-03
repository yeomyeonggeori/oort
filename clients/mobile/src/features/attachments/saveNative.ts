import {Directory, File} from 'expo-file-system';

import {nativeLibrarySave} from './photosNative';
import {fileNameFor, uniqueName, type SavePorts} from './saveAttachment';

// =============================================================================
// 첨부 「저장」의 파일 앱 쪽 — 새 의존 없이 `expo-file-system` 의 폴더 고르기로 (#5209, ADR-0168 증보 3).
//
// 「파일에 저장」은 파일 앱에서 **위치를 고르게** 한다: `Directory.pickDirectoryAsync()` 가 시스템 폴더 선택 창
// (`UIDocumentPickerViewController`, 폴더)을 열고, 사람이 고른 폴더에 받은 파일을 복사한다. 고른 폴더는 보안 범위 URL 이고
// 네이티브가 고르는 순간 접근을 연다(`FilePickingUtils.swift`) — 앱이 따로 접근을 열고 닫지 않는다. 폴더 선택 창의 완료 단추 글자는 시스템이
// 정한다(「열기」) — 우리가 바꿀 수 없고, 사람이 폴더를 고르는 일의 이름은 우리 단추(「파일에 저장」)가 이미 말했다.
//
// 이 파일은 사진 보관함에 닿지 않는다: 그쪽은 `expo-media-library` 에 닿는 **유일한** 파일 `photosNative.ts`(`projectShape.test.ts`)가 맡고,
// 여기서는 그 포트를 모아 한 벌(`nativeSavePorts`)로 준다.
// =============================================================================

/**
 * 폴더 선택 창을 고르지 않고 닫았다(취소 단추·아래로 밀어 닫기). 네이티브 예외 `FilePickingCancelledException` 의 코드다 — 코드는 클래스 이름에서
 * 정해진다(`expo-modules-core` 의 `errorCodeFromString`). 메시지 글자를 읽지 않는다: 글자는 버전마다 바뀐다.
 */
export const PICKER_CANCELLED_CODE = 'ERR_FILE_PICKING_CANCELLED';

export function isPickerCancel(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as {code?: unknown}).code === PICKER_CANCELLED_CODE
  );
}

export const nativeFileSave: Pick<SavePorts, 'saveToFiles'> = {
  async saveToFiles(file) {
    let directory: Directory;
    try {
      directory = await Directory.pickDirectoryAsync();
    } catch (error) {
      // 닫은 것은 실패가 아니다 — 아무 말도 하지 않는다. 그 밖의 예외는 실패로 올린다.
      if (isPickerCancel(error)) return 'cancelled';
      throw error;
    }
    // 받은 캐시 파일의 이름 앞에는 첨부 id 가 붙어 있다 — 사람의 폴더에는 사람이 보던 이름으로 둔다. 같은 이름이 있으면 번호를 붙인다.
    const name = uniqueName(fileNameFor(file.name), candidate => new File(directory, candidate).exists);
    await new File(file.uri).copy(new File(directory, name));
    return 'saved';
  },
};

/** 앱이 쓰는 저장 포트 한 벌 — 사진 보관함(추가 전용)과 파일 앱. 시험·하네스는 이것을 통째로 바꿔 끼운다. */
export const nativeSavePorts: SavePorts = {...nativeLibrarySave, ...nativeFileSave};
