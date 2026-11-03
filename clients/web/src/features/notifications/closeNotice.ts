import { showNotification } from "@/lib/tauri";

// =============================================================================
// 창을 닫아도 메뉴 막대에 남는다는 안내를 처음 한 번만 (#5196, owner 결정).
//
// 셸이 빨간 단추로 창을 치웠을 때(`window-hidden`) 한 번만 OS 알림 한 줄로 말한다: 「창을 닫아도 메뉴 막대에서 계속 알림을
// 받아요」. 치운 창에는 안내를 그릴 수 없고, 닫는 순간을 붙들어 확인을 받는 길은 창이 안 닫히는 고장을 낳는다 — 그래서
// 창이 사라진 뒤의 배너다. 두 가지를 지킨다:
//   * 「한 번」은 **보인 뒤에** 센다. OS 알림이 꺼져 있으면(권한 없음) 말하지 않고, 쓰지도 않는다: 알림을 못 받는 사람에게
//     「계속 알림을 받아요」는 거짓이고, 나중에 켜면 그때 첫 안내가 된다. 권한 창을 이 순간에 띄우지도 않는다
//     (`showNotification`의 `ask: false`는 권한을 묻지 않고 읽기만 한다).
//   * 저장소가 말을 안 하면(읽기 실패) 이미 본 것으로 친다. 안내가 매번 뜨는 것이 안 뜨는 것보다 나쁘다.
// 보였다는 사실은 이 설치(웹뷰 저장소)에 남는다: 계정이 아니라 앱의 동작에 대한 안내이므로 로그아웃·계정 전환과 무관하다.
// =============================================================================

/** 이 설치에서 안내를 보였다는 표시(`momo.web.*` 저장소 키 모양, preference.ts와 같다). */
export const CLOSE_NOTICE_STORAGE_KEY = "momo.web.closeNotice.v1";

export interface CloseNoticeDeps {
  /** 이미 보였는가. 읽을 수 없으면 `true`다(안 뜨는 쪽이 안전하다). */
  seen: () => boolean;
  markSeen: () => void;
  /** 배너를 띄웠는가. 알림이 꺼져 있으면(권한을 묻지 않는다) 거짓이다. */
  show: (text: string) => Promise<boolean>;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export const closeNoticeDeps: CloseNoticeDeps = {
  seen: () => {
    try {
      return storage()?.getItem(CLOSE_NOTICE_STORAGE_KEY) !== null;
    } catch {
      return true;
    }
  },
  markSeen: () => {
    try {
      storage()?.setItem(CLOSE_NOTICE_STORAGE_KEY, "1");
    } catch {
      // 못 쓰면 다음에 또 뜰 수 있다. 읽기도 막혔다면 이미 `seen`이 true라 여기까지 오지 않는다.
    }
  },
  show: (text) => showNotification(text, undefined, { ask: false }),
};

/**
 * 안내를 만든다. 돌려주는 함수는 안내를 띄웠으면 `true`다. 이미 보였거나, 이미 하나가 뜨는 중이거나(치웠다 열었다 치우는 사이에
 * 이벤트가 겹쳐도 배너는 하나), 배너가 안 떴으면(알림이 꺼져 있다) `false`이고 아무것도 쓰지 않는다.
 */
export function createCloseNotice(deps: CloseNoticeDeps = closeNoticeDeps) {
  let busy = false;
  return async (text: string): Promise<boolean> => {
    if (busy || deps.seen()) return false;
    busy = true;
    try {
      if (!(await deps.show(text))) return false;
      deps.markSeen();
      return true;
    } finally {
      busy = false;
    }
  };
}
