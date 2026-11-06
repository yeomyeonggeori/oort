import {Keyboard, type KeyboardEvent} from 'react-native';
import {NON_SECRET_KEYS, nonSecretStore} from '../storage/kv';

// =============================================================================
// 마지막으로 본 소프트 키보드의 높이 (#5452).
//
// 이모티콘 창은 키보드가 있던 **그 자리 그 높이**로 선다(카카오톡처럼). 그래서 창이 서기 전에 「키보드는 얼마나 컸나」를 알아야 하고, 키보드가 내려가 있을 때도(앱을 막
// 켜고 곧바로 ☺ 를 누른 경우) 답이 있어야 한다. 그 답은 키보드가 뜰 때마다 한 번 적어 두는 숫자 하나다 — 이 기기에 남겨 앱을 다시 켠 뒤에도 쓴다.
//
// 구독은 모듈 안에서 **한 번**, 처음 부른 때 건다(`startKeyboardMemory`). 대화 레이아웃은 키보드 이벤트에서 아무 JS 도 돌리지 않는다는 계약이 있어서(`conversationLayout.test`),
// 구독은 레이아웃이 아니라 입력창이 처음 선 때 걸리고 리액트 상태를 건드리지 않는다(숫자 하나만 쓴다).
// 높이 0 은 「없다」다: 하드웨어 키보드가 붙은 기기가 그렇게 보고하는 경우가 있다.
// =============================================================================

let remembered = 0;
let started = false;

function readStored(): number {
  try {
    const raw = nonSecretStore().getString(NON_SECRET_KEYS.keyboardHeight);
    const value = raw === undefined ? 0 : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function remember(event: KeyboardEvent): void {
  const height = event.endCoordinates.height;
  if (!(height > 0) || height === remembered) return;
  remembered = height;
  try {
    nonSecretStore().set(NON_SECRET_KEYS.keyboardHeight, String(height));
  } catch {
    // 기억은 덤이다 - 못 적어도 다음 키보드가 다시 채운다.
  }
}

/** 키보드 높이를 적어 두기 시작한다. 여러 번 불러도 구독은 한 번이다. */
export function startKeyboardMemory(): void {
  if (started) return;
  started = true;
  remembered = readStored();
  Keyboard.addListener('keyboardWillShow', remember);
  Keyboard.addListener('keyboardDidShow', remember);
}

/** 키보드가 지금 가린 높이(pt). 내려가 있으면 0 이다. */
export function visibleKeyboardHeight(): number {
  return Keyboard.isVisible() ? Keyboard.metrics()?.height ?? 0 : 0;
}

/**
 * 이모티콘 창이 설 높이: 키보드가 올라와 있으면 **지금 그 높이**(창이 그 자리를 그대로 받는다), 아니면 마지막으로 본 높이, 한 번도 못 봤으면 `fallback`.
 */
export function keyboardSlotHeight(fallback: number): number {
  const live = visibleKeyboardHeight();
  if (live > 0) return live;
  return remembered > 0 ? remembered : fallback;
}

/** 시험이 기억을 비운다. */
export function __resetKeyboardMemory(): void {
  remembered = 0;
  started = false;
}
