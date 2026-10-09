// =============================================================================
// 설정 › 단축키의 줄 모델 (#3281). 줄은 **두 정본**에서만 나온다: 웹 등록표
// (`keyboardShortcuts.ts`, 도움말·팔레트와 같은 객체)와 core `TERMINAL_APP_BINDINGS`
// (ADR-0190 D5, 데스크탑 작업 공간·터미널 키). 이 파일은 키 문자열을 새로 적지 않는다.
// =============================================================================

import { TERMINAL_APP_BINDINGS, type KeyPlatform } from "@momo/core/features/workbench/keymap";
import { SHORTCUT_HELP_GROUPS } from "@/app/keyboardShortcuts";
import { isCustomized } from "@/app/shortcutBindings";

export interface ShortcutRow {
  id: string;
  name: string;
  groupId: string;
  groupTitle: string;
  /** macOS 표기 키캡(등록표가 쓰는 표기). 화면은 플랫폼에 맞게 바꿔 적는다. */
  keycaps: readonly string[];
  /** 「⌃1 … ⌃9」처럼 처음과 끝만 적힌 범위인가. */
  range: boolean;
  rebindable: boolean;
  customized: boolean;
  /** 데스크탑 앱에서만 동작하는 키. */
  desktopOnly: boolean;
  /** 이 줄이 터미널에서 어떻게 되는지(데스크탑에서만 보인다). */
  terminalNote: string | null;
}

export const TERMINAL_GROUP_ID = "workspace-terminal";
const TERMINAL_GROUP_TITLE = "작업 공간과 터미널";

/** 묶음 머리 아래 한 번만 적는 설명. 줄마다 같은 문장을 되풀이하지 않는다. */
export function groupDescription(groupId: string, desktop: boolean): string | null {
  if (groupId !== TERMINAL_GROUP_ID) return null;
  return desktop
    ? "터미널에 포커스가 있어도 앱이 받는 키예요. 바꿀 수 없고, 같은 키를 다른 항목에 지정할 수도 없어요."
    : "데스크탑 앱의 작업 공간과 터미널에서 쓰는 키예요. 이 브라우저에서는 동작하지 않아요.";
}

const SIDEBAR_TERMINAL_NOTE =
  "macOS에서는 터미널 안에서도 ⌘B로 접혀요. 이 키를 바꿔도 터미널 안의 동작은 그대로예요. 다른 플랫폼의 Ctrl+B는 터미널이 받아요.";

export function buildShortcutRows(desktop: boolean): ShortcutRow[] {
  const rows: ShortcutRow[] = [];
  for (const group of SHORTCUT_HELP_GROUPS) {
    for (const shortcut of group.shortcuts) {
      // 터미널 안내는 터미널에서 다르게 움직이는 줄만 단다(⌘B). 나머지 줄은 같은 규칙
      // (포커스가 터미널에 있으면 터미널이 키를 가진다)이라 구역 머리말이 한 번 말한다.
      const terminalNote = desktop && shortcut.id === "toggle-sidebar" ? SIDEBAR_TERMINAL_NOTE : null;
      rows.push({
        id: shortcut.id,
        name: shortcut.description,
        groupId: group.id,
        groupTitle: group.title,
        keycaps: shortcut.keycaps,
        range: false,
        rebindable: shortcut.rebindable === true,
        customized: isCustomized(shortcut.id),
        desktopOnly: false,
        terminalNote,
      });
    }
  }
  const registered = new Set(rows.map((row) => row.id));
  for (const binding of TERMINAL_APP_BINDINGS) {
    // ⌘B는 웹 등록표가 정본이다(위에서 한 번 적었다). 표를 두 번 그리지 않는다.
    if (registered.has(binding.id)) continue;
    rows.push({
      id: `terminal:${binding.id}`,
      name: binding.description,
      groupId: TERMINAL_GROUP_ID,
      groupTitle: TERMINAL_GROUP_TITLE,
      keycaps: binding.keycaps,
      range: binding.id === "focus-index",
      rebindable: false,
      customized: false,
      desktopOnly: true,
      terminalNote: desktop ? (binding.note ?? null) : null,
    });
  }
  return rows;
}

function strip(value: string): string {
  return value.toLowerCase().replace(/[\s+]/g, "");
}

/** 검색어를 이름 또는 키로 맞춘다. 키는 ⌘ 표기와 Ctrl 표기 둘 다 받는다. */
export function filterShortcutRows(
  rows: readonly ShortcutRow[],
  query: string,
  label: (platform: KeyPlatform, cap: string) => string,
  platform: KeyPlatform
): ShortcutRow[] {
  const needle = strip(query);
  if (needle === "") return [...rows];
  const alias = needle
    .replace(/command|cmd|meta/g, "⌘")
    .replace(/control|ctrl/g, platform === "mac" ? "⌃" : "⌘")
    .replace(/option|opt|alt/g, "⌥")
    .replace(/shift/g, "⇧");
  return rows.filter((row) => {
    const keyForms = row.keycaps.flatMap((cap) => [strip(cap), strip(label(platform, cap))]);
    return (
      strip(row.name).includes(needle) ||
      strip(row.groupTitle).includes(needle) ||
      keyForms.some((form) => form.includes(needle) || form.includes(alias))
    );
  });
}
