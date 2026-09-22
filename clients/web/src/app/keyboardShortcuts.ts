// =============================================================================
// 웹 단축키 정본 (#1687).
//
// 도움말에 키 문자열을 다시 적으면 실제 등록처와 반드시 갈라진다. 아래 정의는
// 각 window/row/dialog 핸들러가 `matches`로 직접 소비하고, 도움말은 같은 객체의
// keycaps와 description을 그린다. 키가 바뀌면 동작과 설명이 한 diff에서 움직인다.
// =============================================================================

export interface ShortcutEvent {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export interface KeyboardShortcut {
  id: string;
  description: string;
  keycaps: readonly string[];
  matches: (event: ShortcutEvent) => boolean;
  /**
   * 이 단축키와 **같은 일을 하는** ⌘K 명령의 id (ADR-0186 D1).
   *
   * 키 정의가 아니라 표시다. 이것이 붙은 단축키는 팔레트에도 줄이 있어야 하고,
   * 그 줄은 여기 keycaps를 힌트로 그린다. 드리프트 가드
   * (`commandRegistry.test.ts`)가 양방향으로 잰다: 여기가 가리키는 명령은
   * 레지스트리에 실존해야 하고, 레지스트리의 `shortcutId`는 아래 등록표에
   * 실존해야 한다.
   *
   * **같은 일**이 기준이다. ⌘⇧K(새 다이렉트 메시지)는 멤버 목록으로 데려가지만
   * 그 줄의 이름은 「멤버」이고 이 키의 이름은 「새 다이렉트 메시지 시작」이라,
   * 둘을 같다고 적으면 팔레트가 「멤버」 옆에 ⌘⇧K를 그리고 키캡이 거짓말을
   * 한다. 그래서 비워 둔다.
   */
  paletteCommandId?: string;
}

export interface ShortcutHelpGroup {
  id: string;
  title: string;
  shortcuts: readonly KeyboardShortcut[];
}

function commandOrControl(event: ShortcutEvent): boolean {
  return event.metaKey === true || event.ctrlKey === true;
}

function lowerKey(event: ShortcutEvent): string {
  return event.key.toLowerCase();
}

export const OPEN_QUICK_SWITCHER_SHORTCUT: KeyboardShortcut = {
  id: "open-quick-switcher",
  description: "검색과 이동 열기",
  keycaps: ["⌘K"],
  matches: (event) =>
    commandOrControl(event) && !event.shiftKey && lowerKey(event) === "k",
};

export const OPEN_NEW_DM_SHORTCUT: KeyboardShortcut = {
  id: "open-new-dm",
  description: "새 다이렉트 메시지 시작",
  keycaps: ["⌘⇧K"],
  matches: (event) =>
    commandOrControl(event) && event.shiftKey === true && lowerKey(event) === "k",
};

export const OPEN_SETTINGS_SHORTCUT: KeyboardShortcut = {
  id: "open-settings",
  description: "설정 열기",
  keycaps: ["⌘,"],
  paletteCommandId: "nav.settings",
  matches: (event) => commandOrControl(event) && event.key === ",",
};

export const OPEN_INBOX_SHORTCUT: KeyboardShortcut = {
  id: "open-inbox",
  description: "인박스 열기",
  keycaps: ["⌘⇧A"],
  paletteCommandId: "nav.inbox",
  matches: (event) =>
    event.metaKey === true &&
    event.shiftKey === true &&
    !event.ctrlKey &&
    !event.altKey &&
    lowerKey(event) === "a",
};

export const MOVE_UNREAD_CHANNEL_SHORTCUT: KeyboardShortcut = {
  id: "move-unread-channel",
  description: "이전 또는 다음 안 읽은 채널로 이동",
  keycaps: ["⌥↑", "⌥↓"],
  matches: (event) =>
    event.altKey === true &&
    !event.metaKey &&
    !event.ctrlKey &&
    (event.key === "ArrowUp" || event.key === "ArrowDown"),
};

export const PRIMARY_ACTION_SHORTCUT: KeyboardShortcut = {
  id: "primary-action",
  description: "보내기 또는 기본 동작 실행",
  keycaps: ["⌘↵"],
  matches: (event) => commandOrControl(event) && event.key === "Enter",
};

export const ROW_ACTIONS_SHORTCUT: KeyboardShortcut = {
  id: "row-actions",
  description: "메시지 행의 이전 또는 다음 동작으로 이동",
  keycaps: ["←", "→"],
  matches: (event) =>
    event.key === "ArrowLeft" || event.key === "ArrowRight",
};

export const OPEN_SHORTCUT_HELP_SHORTCUT: KeyboardShortcut = {
  id: "open-shortcut-help",
  description: "단축키 도움말 열기",
  keycaps: ["?"],
  matches: (event) =>
    event.shiftKey === true &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    (event.key === "?" || event.code === "Slash"),
};

export const SHORTCUT_HELP_GROUPS: readonly ShortcutHelpGroup[] = [
  {
    id: "navigation",
    title: "탐색",
    shortcuts: [
      OPEN_QUICK_SWITCHER_SHORTCUT,
      OPEN_NEW_DM_SHORTCUT,
      OPEN_SETTINGS_SHORTCUT,
      OPEN_INBOX_SHORTCUT,
      MOVE_UNREAD_CHANNEL_SHORTCUT,
      OPEN_SHORTCUT_HELP_SHORTCUT,
    ],
  },
  {
    id: "actions",
    title: "작성과 동작",
    shortcuts: [PRIMARY_ACTION_SHORTCUT],
  },
  {
    id: "rows",
    title: "메시지 행",
    shortcuts: [ROW_ACTIONS_SHORTCUT],
  },
];

export const REGISTERED_SHORTCUTS: readonly KeyboardShortcut[] =
  SHORTCUT_HELP_GROUPS.flatMap((group) => group.shortcuts);

interface TextEntryTarget {
  tagName?: unknown;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

/** 입력 중인 `?`는 도움말 명령이 아니라 사람의 문자다. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (target === null) return false;
  const candidate = target as TextEntryTarget;
  const tagName =
    typeof candidate.tagName === "string" ? candidate.tagName.toUpperCase() : "";
  if (tagName === "INPUT" || tagName === "TEXTAREA") return true;
  if (candidate.isContentEditable === true) return true;
  if (typeof candidate.closest !== "function") return false;
  return candidate.closest('[contenteditable="true"], [role="textbox"]') !== null;
}

export function shouldOpenShortcutHelp(
  event: ShortcutEvent & {
    target: EventTarget | null;
    defaultPrevented?: boolean;
    isComposing?: boolean;
  }
): boolean {
  return (
    !event.defaultPrevented &&
    !event.isComposing &&
    !isTextEntryTarget(event.target) &&
    OPEN_SHORTCUT_HELP_SHORTCUT.matches(event)
  );
}
