// =============================================================================
// 웹 단축키 정본 (#1687).
//
// 도움말에 키 문자열을 다시 적으면 실제 등록처와 반드시 갈라진다. 아래 정의는
// 각 window/row/dialog 핸들러가 `matches`로 직접 소비하고, 도움말은 같은 객체의
// keycaps와 description을 그린다. 키가 바뀌면 동작과 설명이 한 diff에서 움직인다.
// =============================================================================

import {
  DEFAULT_COMBOS,
  comboKeycap,
  effectiveCombo,
  getOverride,
  matchesCombo,
} from "@/app/shortcutBindings";

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
  /**
   * 사용자가 설정 › 단축키에서 키를 바꿀 수 있는가 (#3281). 참인 줄의 `keycaps`·`matches`는
   * 재지정을 읽는다(`shortcutBindings.ts`). 거짓인 줄은 고정이고, 설정에는 읽기 전용으로 선다.
   */
  rebindable?: boolean;
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

/**
 * 재지정 가능한 줄을 만든다 (#3281). `matches`는 재지정이 없으면 **원래의 판정**
 * (`defaultMatches`)을 그대로 돌고, 있으면 그 조합을 물리 키로 맞춘다. `keycaps`는 읽을 때마다
 * 지금 유효한 조합에서 그린다(도움말·팔레트가 재그림을 구독한다).
 */
function rebindableShortcut(
  def: Omit<KeyboardShortcut, "keycaps" | "matches" | "rebindable"> & {
    defaultMatches: (event: ShortcutEvent) => boolean;
  }
): KeyboardShortcut {
  const { defaultMatches, ...rest } = def;
  return {
    ...rest,
    rebindable: true,
    get keycaps(): readonly string[] {
      return [comboKeycap(effectiveCombo(def.id) ?? DEFAULT_COMBOS[def.id])];
    },
    matches(event) {
      const override = getOverride(def.id);
      return override !== undefined
        ? matchesCombo(event, override)
        : defaultMatches(event);
    },
  };
}

export const OPEN_QUICK_SWITCHER_SHORTCUT: KeyboardShortcut = rebindableShortcut({
  id: "open-quick-switcher",
  description: "검색과 이동 열기",
  defaultMatches: (event) =>
    commandOrControl(event) && !event.shiftKey && lowerKey(event) === "k",
});

export const OPEN_NEW_DM_SHORTCUT: KeyboardShortcut = rebindableShortcut({
  id: "open-new-dm",
  description: "새 다이렉트 메시지 시작",
  defaultMatches: (event) =>
    commandOrControl(event) && event.shiftKey === true && lowerKey(event) === "k",
});

export const OPEN_SETTINGS_SHORTCUT: KeyboardShortcut = rebindableShortcut({
  id: "open-settings",
  description: "설정 열기",
  paletteCommandId: "nav.settings",
  defaultMatches: (event) => commandOrControl(event) && event.key === ",",
});

export const OPEN_INBOX_SHORTCUT: KeyboardShortcut = rebindableShortcut({
  id: "open-inbox",
  description: "인박스 열기",
  paletteCommandId: "nav.inbox",
  defaultMatches: (event) =>
    event.metaKey === true &&
    event.shiftKey === true &&
    !event.ctrlKey &&
    !event.altKey &&
    lowerKey(event) === "a",
});

/**
 * 탐색 패널(목록 열) 접고 펴기 (#3280). 정본은 이 한 줄이다: 도움말·타이틀바 툴팁·
 * 셸 핸들러가 모두 여기서 읽는다(#3281이 재바인딩을 얹을 자리).
 *
 * `matches`는 키 모양만 본다(⌘ 또는 Ctrl + B, 물리 키 `code`: 한글 2벌식에서 `key`는
 * 「ㅠ」). **누가 언제 가져가는가**는 `shouldToggleSidebar`가 정한다 — 컴포저의 굵게
 * (⌘B)가 우선이고, 터미널은 macOS에서만 넘긴다.
 *
 * 팔레트 명령(`paletteCommandId`)은 없다: 팔레트의 `client` 명령은 코어 레지스트리·
 * 폰과 함께 움직이는 표라(`CommandContext`에 접기 훅이 없다) 이 줄의 범위 밖이다(#3281).
 */
function matchesDefaultSidebarKey(event: ShortcutEvent): boolean {
  return (
    commandOrControl(event) &&
    !(event.metaKey === true && event.ctrlKey === true) &&
    !event.shiftKey &&
    !event.altKey &&
    (event.code === "KeyB" || (event.code === undefined && lowerKey(event) === "b"))
  );
}

export const TOGGLE_SIDEBAR_SHORTCUT: KeyboardShortcut = rebindableShortcut({
  id: "toggle-sidebar",
  description: "탐색 패널 접고 펴기",
  defaultMatches: matchesDefaultSidebarKey,
});

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
      TOGGLE_SIDEBAR_SHORTCUT,
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

/** 이 창의 수식 키 규약: macOS는 ⌘, 그 밖은 Ctrl. */
export type ShortcutPlatform = "mac" | "other";

/**
 * 전역 ⌘B(Ctrl+B)가 탐색 패널을 접고 펼 것인가 (#3280).
 *
 * 순서가 계약이다.
 * 1. 키 모양: macOS는 ⌘B만(⌃B는 아니다), 그 밖은 Ctrl+B만. Shift·Alt가 붙으면 아니다.
 * 2. IME 조합 중이거나 키를 누르고 있는 반복이면 아니다.
 * 3. 모달·다이얼로그가 열려 있으면 아니다(`overlayOpen`).
 * 4. **터미널**(`.xterm`): macOS ⌘B만 앱이 가져간다(PTY로 갈 바이트가 없는 키, ADR-0190 D5
 *    증보 `TERMINAL_APP_BINDINGS`). 그 밖의 플랫폼 Ctrl+B는 tmux prefix라 터미널 몫이다.
 *    이 칸에서는 재지정을 보지 않는다: 키는 항상 기본 ⌘B다(#3281).
 * 5. **입력 칸**(컴포저 textarea·`contenteditable`·input): 건드리지 않는다. 컴포저의 ⌘B는
 *    「굵게」다(`useComposerFormat`).
 */
export function shouldToggleSidebar(
  event: ShortcutEvent & {
    target: EventTarget | null;
    isComposing?: boolean;
    repeat?: boolean;
  },
  platform: ShortcutPlatform,
  context: { overlayOpen?: boolean } = {}
): boolean {
  const target = event.target as TextEntryTarget | null;
  const inTerminal =
    target !== null &&
    typeof target.closest === "function" &&
    target.closest(".xterm") !== null;
  // 터미널 안에서는 키가 **고정**이다(ADR-0190 D5 증보): 재지정은 터미널이 앱으로 넘기는
  // 키를 넓히지 않으므로, 이 자리는 항상 기본 ⌘B만 본다. 재지정한 조합은 터미널을 통과하지 않는다.
  const shapeMatches = inTerminal
    ? matchesDefaultSidebarKey(event)
    : TOGGLE_SIDEBAR_SHORTCUT.matches(event);
  if (!shapeMatches) return false;
  const exactModifier =
    platform === "mac"
      ? event.metaKey === true && event.ctrlKey !== true
      : event.ctrlKey === true && event.metaKey !== true;
  if (!exactModifier) return false;
  if (event.isComposing === true || event.repeat === true) return false;
  if (context.overlayOpen === true) return false;
  if (inTerminal) return platform === "mac";
  return !isTextEntryTarget(event.target);
}
