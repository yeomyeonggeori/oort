import {useSyncExternalStore} from 'react';
import {Share, type ShareAction, type ShareContent, type ShareOptions} from 'react-native';

// =============================================================================
// iOS 공유 시트를 여는 유일한 문 (#5207).
//
// ## 무엇이 틀렸나
//
// `Share.share` 는 iOS 의 `UIActivityViewController` 를 올린다. 이 시트는 **뒤 화면을 어둡게 하지도 막지도 않는다** — iOS 26 에서 시트 위쪽은 대화가
// 그대로 비치고, 그곳을 누르면 시트가 내려가는 **동시에** 같은 터치가 RN 의 눌림 면에도 닿는다. 시뮬레이터(iOS 26.5)에서 쟀다: 시트가 서 있는 동안 시트 바로
// 위의 「↳ ○○님에게 답글」 줄을 누르자 앱은 터치 시작을 받았고(`onTouchStart`), 줄의 `onPress` 가 불려 스레드가 열렸고, 그 0.57초 뒤에야 `Share.share` 가
// `dismissedAction` 으로 끝났다. 사람이 시트를 닫으려고 시트 바로 위를 누르면 시트가 닫히면서 스레드가 열렸다는 보고와 같은 모양이다.
//
// ## 무엇으로 막나
//
// 뒤 화면을 앱이 막는다. 시트가 서 있는 동안(과 막 걷힌 직후 `SHARE_SHEET_TAP_GRACE_MS`)을 이 모듈이 알고, `ShareSheetTouchShield`(셸 맨 위의 투명한 판)가 그동안
// 모든 터치를 삼킨다. 시트를 닫는 일은 UIKit 이 따로 하므로 막이는 그 길을 건드리지 않는다 — 막는 것은 **RN 쪽으로 새는 터치**뿐이다.
//
// 이 시트를 여는 곳은 전부 `presentShareSheet` 를 지난다. `Share.share` 를 곧바로 부르면 그 호출만 터치가 샌다.
// =============================================================================

/**
 * 시트가 걷힌 뒤에도 막이를 거두지 않는 시간(ms). `Share.share` 는 시트가 **다 내려간 뒤** 끝나지만(시뮬레이터에서 닫는 탭 0.57초 뒤), 내려가는 동안·직후에 오는 둘째
 * 탭(닫으려고 두 번 누르기)이 뒤 화면에 닿지 않게 한다. 이보다 길면 시트를 닫자마자 누르려는 사람이 눌림이 먹는 것을 느낀다.
 */
export const SHARE_SHEET_TAP_GRACE_MS = 400;

/**
 * 막이가 서 있을 수 있는 가장 긴 시간(ms). `Share.share` 가 끝나지 않는 일은 없어야 하지만(iOS 는 시트가 내려갈 때 반드시 완료 처리기를 부른다), 끝나지 않으면 **앱 전체가
 * 눌리지 않는다**. 막이가 앱을 가두는 쪽이 더 나쁜 실패라서 천장을 둔다 — 5분 동안 열려 있는 공유 시트는 사람이 두고 간 것이다.
 */
export const SHARE_SHEET_MAX_HOLD_MS = 5 * 60_000;

let held = 0;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach(listener => listener());
}

/** 시트 하나분의 막이를 세운다. 돌려주는 함수는 **한 번만** 거둔다(천장 타이머와 정상 종료가 둘 다 불러도 두 번 거두지 않는다). */
function hold(): () => void {
  held += 1;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held -= 1;
    notify();
  };
}

/** 공유 시트가 떠 있거나 막 걷혔는가 — 이 동안은 뒤 화면이 터치를 받지 않아야 한다. */
export function isShareSheetHeld(): boolean {
  return held > 0;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `isShareSheetHeld` 를 읽는 훅. 막이 컴포넌트(`ShareSheetTouchShield`)가 쓴다. */
export function useShareSheetHeld(): boolean {
  return useSyncExternalStore(subscribe, isShareSheetHeld, isShareSheetHeld);
}

/**
 * iOS 공유 시트를 연다. `Share.share` 와 같은 약속(시트가 닫히면 끝나고, 실패하면 거절한다)이고, 그동안 뒤 화면을 막는다.
 *
 * 막이는 시트를 **열기 전에** 선다(시트가 올라오는 동안에도 뒤 화면은 눌리지 않는다). 끝나면(성공이든 거절이든) `SHARE_SHEET_TAP_GRACE_MS` 뒤에 거둔다.
 */
export async function presentShareSheet(
  content: ShareContent,
  options?: ShareOptions,
): Promise<ShareAction> {
  const release = hold();
  const ceiling = setTimeout(release, SHARE_SHEET_MAX_HOLD_MS);
  try {
    // 옵션이 없으면 `Share.share` 를 인자 하나로 부른다 — 끝에 `undefined` 를 얹어 부르면 호출 모양이 바뀐다(시험·계측이 인자 목록을 본다).
    return await (options === undefined ? Share.share(content) : Share.share(content, options));
  } finally {
    clearTimeout(ceiling);
    setTimeout(release, SHARE_SHEET_TAP_GRACE_MS);
  }
}

/** 시험 사이에 모듈 전역 상태가 흘러가지 않게 한다. */
export function resetShareSheetForTest(): void {
  held = 0;
  listeners.clear();
}
