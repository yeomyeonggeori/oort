// =============================================================================
// 작업 공간 단축키 판정 (#2773 격자, #2774 도크, ADR-0190 D5).
// `resolveWorkbenchKey`는 격자가 직접 수행하는 줄, `resolveDockKey`는 도크와
// 앱 전역 줄이다. 둘을 합친 것이 D5 표 전부이고(`TERMINAL_APP_BINDINGS`),
// 터미널에 포커스가 있을 때 앱이 가로채는 키는 정확히 이 표뿐이다
// (`isTerminalAppKey`). 나머지 키는 터미널 입력이 먼저다.
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

// ---- 도크와 앱 전역 키 (#2774) ------------------------------------------------

export type DockCommand =
  | { type: "toggle-dock" }
  | { type: "toggle-fullscreen" }
  | { type: "new-session" }
  | { type: "jump-palette" }
  | { type: "next-waiting" };

/**
 * 키 사건 하나를 도크 명령으로 읽는다. 도크 키가 아니면 `null`.
 *
 * | 동작 | 키 | `code` |
 * |---|---|---|
 * | 도크 열고 닫기 | ⌃` | Backquote |
 * | 전체 화면 켜고 끄기 | ⌃⇧` | Backquote |
 * | 새 세션 | ⌃⇧N (도크 포커스 중이면 ⌘T도) | KeyN, KeyT |
 * | 칸 목록 열기 | ⌘J | KeyJ |
 * | 다음 「나를 기다림」 | ⌃⇧J | KeyJ |
 *
 * ⌃`는 `key`가 아니라 `code`로 판정한다. 한글 2벌식에서 같은 자판은 「₩」를
 * 내고, ⌃⇧`의 `key`는 「~」다. `code`는 둘 다 `Backquote`다.
 */
export function resolveDockKey(
  event: WorkbenchKeyEvent,
  platform: KeyPlatform,
  options: { dockFocused?: boolean } = {}
): DockCommand | null {
  const code = event.code;
  if (typeof code !== "string" || code === "") return null;
  const m = readModifiers(event, platform);

  if (code === "Backquote") {
    if (exactly(m, { ctrl: true }, platform)) return { type: "toggle-dock" };
    if (exactly(m, { ctrl: true, shift: true }, platform)) return { type: "toggle-fullscreen" };
    return null;
  }
  if (code === "KeyN") {
    return exactly(m, { ctrl: true, shift: true }, platform) ? { type: "new-session" } : null;
  }
  if (code === "KeyT") {
    return options.dockFocused === true && exactly(m, { mod: true }, platform)
      ? { type: "new-session" }
      : null;
  }
  if (code === "KeyJ") {
    if (exactly(m, { mod: true }, platform)) return { type: "jump-palette" };
    if (exactly(m, { ctrl: true, shift: true }, platform)) return { type: "next-waiting" };
    return null;
  }
  return null;
}

/**
 * 터미널에 포커스가 있을 때 앱이 가로채는 키인가. D5 표의 키만 참이다.
 * 터미널 칸은 이것이 참인 키를 xterm에 주지 않고(앱 몫), 거짓인 키는 앱의
 * 다른 단축키(⌘K, ⌥↑ 등)에 넘기지 않는다(터미널 몫).
 */
export function isTerminalAppKey(event: WorkbenchKeyEvent, platform: KeyPlatform): boolean {
  return (
    resolveWorkbenchKey(event, platform) !== null ||
    resolveDockKey(event, platform, { dockFocused: true }) !== null
  );
}

export interface TerminalAppBinding {
  id: string;
  description: string;
  /** macOS 키캡. 다른 플랫폼은 ⌘를 Ctrl로 읽는다. */
  keycaps: readonly string[];
  /** 한 줄 보충. 설정의 표에 그대로 보인다. */
  note?: string;
}

/**
 * ADR-0190 D5 표 전부. 설정 「터미널」과 단축키 도움말이 이 배열을 그린다.
 * 키를 바꾸면 판정(위 두 함수)과 이 표가 같은 파일에서 움직인다. 시험이 이
 * 표의 모든 키캡을 사건으로 바꿔 `isTerminalAppKey`가 참인지 잰다.
 */
export const TERMINAL_APP_BINDINGS: readonly TerminalAppBinding[] = [
  { id: "toggle-dock", description: "터미널 도크 열고 닫기", keycaps: ["⌃`"], note: "한글 입력 중에도 같은 자판으로 됩니다." },
  { id: "toggle-fullscreen", description: "전체 화면 켜고 끄기", keycaps: ["⌃⇧`"], note: "도크를 본문 판 전체로 키웁니다." },
  { id: "new-session", description: "새 세션", keycaps: ["⌃⇧N", "⌘T"], note: "⌘T는 도크에 포커스가 있을 때만 됩니다." },
  ...WORKBENCH_BINDINGS.map((b) => ({ id: b.id, description: b.description, keycaps: b.keycaps })),
  { id: "jump-palette", description: "칸 목록 열기", keycaps: ["⌘J"] },
  { id: "next-waiting", description: "다음 「나를 기다림」으로", keycaps: ["⌃⇧J"] },
];

const KEYCAP_CODES: Record<string, string> = {
  "`": "Backquote",
  "]": "BracketRight",
  "[": "BracketLeft",
  "↵": "Enter",
  "←": "ArrowLeft",
  "→": "ArrowRight",
  "↑": "ArrowUp",
  "↓": "ArrowDown",
};

/**
 * macOS 키캡(「⌘⇧D」)을 키 사건 모양으로 바꾼다. 표와 판정이 같은 키를 말하는지
 * 재는 시험과, 설정의 표가 쓴다. 모르는 글자면 `null`.
 */
export function keycapToEvent(keycap: string): WorkbenchKeyEvent | null {
  const last = keycap.replace(/[⌘⌃⌥⇧]/g, "");
  let code: string | undefined = KEYCAP_CODES[last];
  if (code === undefined && /^[A-Z]$/.test(last)) code = `Key${last}`;
  if (code === undefined && /^[0-9]$/.test(last)) code = `Digit${last}`;
  if (code === undefined) return null;
  return {
    code,
    metaKey: keycap.includes("⌘"),
    ctrlKey: keycap.includes("⌃"),
    altKey: keycap.includes("⌥"),
    shiftKey: keycap.includes("⇧"),
  };
}
