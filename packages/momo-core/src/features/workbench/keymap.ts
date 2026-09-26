// =============================================================================
// 격자 단축키 판정 (#2773, ADR-0190 D5). 전체 단축키 표(도크 ⌃`, 새 세션 등)는
// #2774가 가진다. 여기는 격자가 직접 수행하는 줄만 둔다.
//
// 판정은 물리 키(`event.code`)로 한다. 한글 2벌식 입력 상태에서 ⌘D의 `key`는
// 「ㅇ」이고, ⌘]의 `key`는 배열에 따라 달라진다. `code`는 입력기와 배열에
// 상관없이 같은 자판 위치를 가리킨다. `code`가 없는 사건은 판정하지 않는다.
//
// 수식 키는 정확히 맞아야 한다. ⌘⇧D가 ⌘D로 새지 않고, ⌘⌥D가 어느 것에도
// 걸리지 않는다. macOS가 아니면 ⌘ 자리를 Ctrl로 읽는다(ADR-0190 D5).
// =============================================================================

import type { Direction, SplitAxis } from "./layoutTree";

export type WorkbenchCommand =
  | { type: "split"; axis: SplitAxis }
  | { type: "focus-direction"; direction: Direction }
  | { type: "focus-cycle"; delta: 1 | -1 }
  | { type: "focus-index"; index: number }
  | { type: "toggle-maximize" }
  | { type: "close" };

export interface WorkbenchKeyEvent {
  code?: string;
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export type KeyPlatform = "mac" | "other";

/** `navigator.platform`이나 userAgent 원문을 받아 판정한다(코어는 navigator를 읽지 않는다). */
export function keyPlatformOf(platformHint: string | null | undefined): KeyPlatform {
  return typeof platformHint === "string" && /mac|iphone|ipad/i.test(platformHint) ? "mac" : "other";
}

interface Modifiers {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/**
 * 사건의 수식 키를 「⌘ 자리」와 「⌃ 자리」로 읽는다. macOS가 아니면 ⌘ 자리가
 * Ctrl이므로, 그 플랫폼에서 ⌃ 자리 키(⌃1..9)는 ⌘ 자리와 같은 물리 키가 된다.
 */
function readModifiers(event: WorkbenchKeyEvent, platform: KeyPlatform): Modifiers {
  const meta = event.metaKey === true;
  const ctrl = event.ctrlKey === true;
  if (platform === "mac") {
    return { mod: meta, ctrl, alt: event.altKey === true, shift: event.shiftKey === true };
  }
  // macOS 밖에서 Meta(Windows 키)는 격자 키에 쓰지 않는다. 눌려 있으면 판정하지 않는다.
  return { mod: ctrl && !meta, ctrl: ctrl && !meta, alt: event.altKey === true, shift: event.shiftKey === true };
}

function exactly(m: Modifiers, want: { mod?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean }, platform: KeyPlatform): boolean {
  const wantMod = want.mod === true;
  const wantCtrl = want.ctrl === true;
  const wantAlt = want.alt === true;
  const wantShift = want.shift === true;
  if (m.alt !== wantAlt || m.shift !== wantShift) return false;
  if (platform === "mac") return m.mod === wantMod && m.ctrl === wantCtrl;
  // macOS 밖: ⌘ 자리와 ⌃ 자리가 모두 Ctrl이다.
  return m.ctrl === (wantMod || wantCtrl);
}

const ARROWS: Record<string, Direction> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/**
 * 키 사건 하나를 격자 명령으로 읽는다. 격자 키가 아니면 `null`.
 *
 * | 동작 | 키 | `code` |
 * |---|---|---|
 * | 오른쪽으로 분할 | ⌘D | KeyD |
 * | 아래로 분할 | ⌘⇧D | KeyD |
 * | 방향 이동 | ⌘⌥←↑→↓ | Arrow* |
 * | 순환 | ⌘] / ⌘[ | BracketRight / BracketLeft |
 * | 번호로 이동 | ⌃1..9 | Digit1..9 |
 * | 최대화 토글 | ⌘⇧↵ | Enter, NumpadEnter |
 * | 칸 닫기 | ⌘W | KeyW |
 */
export function resolveWorkbenchKey(
  event: WorkbenchKeyEvent,
  platform: KeyPlatform
): WorkbenchCommand | null {
  const code = event.code;
  if (typeof code !== "string" || code === "") return null;
  const m = readModifiers(event, platform);

  if (code === "KeyD") {
    if (exactly(m, { mod: true }, platform)) return { type: "split", axis: "row" };
    if (exactly(m, { mod: true, shift: true }, platform)) return { type: "split", axis: "column" };
    return null;
  }
  const arrow = ARROWS[code];
  if (arrow !== undefined) {
    return exactly(m, { mod: true, alt: true }, platform)
      ? { type: "focus-direction", direction: arrow }
      : null;
  }
  if (code === "BracketRight" || code === "BracketLeft") {
    return exactly(m, { mod: true }, platform)
      ? { type: "focus-cycle", delta: code === "BracketRight" ? 1 : -1 }
      : null;
  }
  const digit = /^Digit([1-9])$/.exec(code);
  if (digit !== null) {
    return exactly(m, { ctrl: true }, platform)
      ? { type: "focus-index", index: Number(digit[1]) }
      : null;
  }
  if (code === "Enter" || code === "NumpadEnter") {
    return exactly(m, { mod: true, shift: true }, platform) ? { type: "toggle-maximize" } : null;
  }
  if (code === "KeyW") {
    return exactly(m, { mod: true }, platform) ? { type: "close" } : null;
  }
  return null;
}

export interface WorkbenchBinding {
  id: WorkbenchCommand["type"] | "split-right" | "split-down";
  description: string;
  /** macOS 키캡. 다른 플랫폼은 ⌘를 Ctrl로 읽는다. */
  keycaps: readonly string[];
}

/** 도움말과 칸 머리 버튼의 툴팁이 같은 글을 쓰도록 한 곳에 둔다. */
export const WORKBENCH_BINDINGS: readonly WorkbenchBinding[] = [
  { id: "split-right", description: "오른쪽으로 분할", keycaps: ["⌘D"] },
  { id: "split-down", description: "아래로 분할", keycaps: ["⌘⇧D"] },
  { id: "focus-direction", description: "방향으로 칸 이동", keycaps: ["⌘⌥←", "⌘⌥↑", "⌘⌥→", "⌘⌥↓"] },
  { id: "focus-cycle", description: "다음 또는 이전 칸", keycaps: ["⌘]", "⌘["] },
  { id: "focus-index", description: "번호로 칸 이동", keycaps: ["⌃1", "⌃9"] },
  { id: "toggle-maximize", description: "칸 최대화 켜고 끄기", keycaps: ["⌘⇧↵"] },
  { id: "close", description: "칸 닫기", keycaps: ["⌘W"] },
];
