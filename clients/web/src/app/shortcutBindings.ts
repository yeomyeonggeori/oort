// =============================================================================
// 단축키 재지정 저장소와 판정 (#3281).
//
// `keyboardShortcuts.ts`가 정본 등록표이고, 이 파일은 그 등록표가 **다시 지정된 키**를
// 읽는 자리다. 각 핸들러는 계속 `shortcut.matches(event)`만 부른다. 재지정이 없으면
// 원래의 판정 함수가 그대로 돈다(기본 키의 동작은 한 줄도 바뀌지 않는다).
//
// 한 조합(`ShortcutCombo`)은 「⌘(macOS) 또는 Ctrl(그 밖) + 선택적 ⌥·⇧ + 물리 키」다.
// 물리 키(`event.code`)로 적는다: 한글 2벌식에서 ⌘K의 `key`는 「ㅏ」다(core `keymap.ts`와
// 같은 이유). 수식 키 없는 조합은 글자 입력이므로 받지 않는다.
//
// 터미널(ADR-0190 D5): 터미널 칸이 앱으로 넘기는 키는 core `TERMINAL_APP_BINDINGS`로
// 고정이다. 재지정은 그 표를 **넓히지 않는다**: 이 표의 키와 겹치는 조합은 데스크탑에서
// 막고, 새 조합이 터미널을 통과하게 하지도 않는다.
// =============================================================================

import { useSyncExternalStore } from "react";
import {
  TERMINAL_APP_BINDINGS,
  isTerminalAppKey,
  keycapToEvent,
  type KeyPlatform,
} from "@momo/core/features/workbench/keymap";
import { isDesktop } from "@/lib/tauri";

export interface ShortcutCombo {
  /** 물리 키(`KeyboardEvent.code`). 예: `KeyK`, `Comma`, `Digit1`. */
  code: string;
  shift: boolean;
  alt: boolean;
}

export const SHORTCUT_STORAGE_KEY = "oort.shortcuts.v1";
const STORAGE_VERSION = 1;

/** 재지정할 수 있는 단축키와 그 기본 조합. 등록표(`keyboardShortcuts.ts`)가 이 표로 키캡을 만든다. */
export const DEFAULT_COMBOS: Readonly<Record<string, ShortcutCombo>> = {
  "open-quick-switcher": { code: "KeyK", shift: false, alt: false },
  "open-new-dm": { code: "KeyK", shift: true, alt: false },
  "open-settings": { code: "Comma", shift: false, alt: false },
  "open-inbox": { code: "KeyA", shift: true, alt: false },
  "toggle-sidebar": { code: "KeyB", shift: false, alt: false },
};

export const REBINDABLE_IDS: readonly string[] = Object.keys(DEFAULT_COMBOS);

// ---- 코드 ↔ 글자 ---------------------------------------------------------

const CODE_PATTERN =
  /^(Key[A-Z]|Digit[0-9]|Comma|Period|Slash|Semicolon|Quote|Backslash|BracketLeft|BracketRight|Minus|Equal|Backquote|Arrow(Up|Down|Left|Right)|F([1-9]|1[0-2]))$/;

const CODE_LABELS: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

export function isKnownCode(code: string): boolean {
  return CODE_PATTERN.test(code);
}

/** 키캡에 적는 글자. */
export function codeLabel(code: string): string {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  return CODE_LABELS[code] ?? code;
}

/** `code`가 없는 사건(시험·합성 사건)을 위한 `key` 값. */
function codeKey(code: string): string {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  return CODE_LABELS[code] ?? code;
}

/** macOS 표기의 키캡 한 줄. 등록표·도움말·팔레트가 이 표기를 쓴다. */
export function comboKeycap(combo: ShortcutCombo): string {
  return `⌘${combo.alt ? "⌥" : ""}${combo.shift ? "⇧" : ""}${codeLabel(combo.code)}`;
}

export interface ComboEvent {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export function matchesCombo(event: ComboEvent, combo: ShortcutCombo): boolean {
  if (!(event.metaKey === true || event.ctrlKey === true)) return false;
  if ((event.shiftKey === true) !== combo.shift) return false;
  if ((event.altKey === true) !== combo.alt) return false;
  if (event.code !== undefined && event.code !== "") return event.code === combo.code;
  return event.key.toLowerCase() === codeKey(combo.code);
}

export function sameCombo(a: ShortcutCombo, b: ShortcutCombo): boolean {
  return a.code === b.code && a.shift === b.shift && a.alt === b.alt;
}

// ---- 예약 키 -------------------------------------------------------------

export interface ReservedHit {
  reason: string;
}

const SYSTEM_RESERVED: Record<string, string> = {
  KeyQ: "앱 종료 키입니다.",
  KeyW: "창 닫기 키입니다.",
  KeyC: "복사 키입니다.",
  KeyV: "붙여넣기 키입니다.",
  KeyX: "잘라내기 키입니다.",
  KeyZ: "실행 취소 키입니다.",
  KeyY: "다시 실행 키입니다.",
  KeyA: "전체 선택 키입니다.",
  KeyM: "창 최소화 키입니다.",
  KeyH: "앱 숨기기 키입니다.",
  Backquote: "창 전환 키입니다.",
};

/** 입력 칸에서 글자 서식으로 쓰이는 키. 입력 중에 가로채면 서식을 쓸 수 없다. */
const COMPOSER_RESERVED: Record<string, string> = {
  KeyB: "메시지 입력 칸의 굵게 키입니다.",
  KeyI: "메시지 입력 칸의 기울임 키입니다.",
  KeyU: "입력 칸의 밑줄 키입니다.",
};

const BROWSER_RESERVED: Record<string, string> = {
  KeyT: "새 탭 키여서 브라우저가 먼저 받습니다.",
  KeyN: "새 창 키여서 브라우저가 먼저 받습니다.",
  KeyL: "주소창 키여서 브라우저가 먼저 받습니다.",
  KeyR: "새로고침 키여서 브라우저가 먼저 받습니다.",
  KeyP: "인쇄 키여서 브라우저가 먼저 받습니다.",
  KeyS: "저장 키여서 브라우저가 먼저 받습니다.",
  KeyF: "페이지 찾기 키여서 브라우저가 먼저 받습니다.",
  KeyD: "북마크 키여서 브라우저가 먼저 받습니다.",
  KeyG: "다음 찾기 키여서 브라우저가 먼저 받습니다.",
  KeyO: "파일 열기 키여서 브라우저가 먼저 받습니다.",
  KeyE: "검색 키여서 브라우저가 먼저 받습니다.",
  Minus: "화면 축소 키여서 브라우저가 먼저 받습니다.",
  Equal: "화면 확대 키여서 브라우저가 먼저 받습니다.",
  Digit0: "화면 크기 복원 키여서 브라우저가 먼저 받습니다.",
  BracketLeft: "뒤로 가기 키여서 브라우저가 먼저 받습니다.",
  BracketRight: "앞으로 가기 키여서 브라우저가 먼저 받습니다.",
};

/**
 * 이 조합을 쓸 수 없게 하는 예약 사유. 없으면 `null`.
 * 데스크탑 앱에는 브라우저 키가 없으므로 `desktop`이면 그 표는 보지 않는다.
 */
export function reservedReason(combo: ShortcutCombo, desktop: boolean): string | null {
  const plain = !combo.shift && !combo.alt;
  if (combo.alt && !combo.shift && combo.code === "KeyI") {
    return desktop ? null : "개발자 도구 키여서 브라우저가 먼저 받습니다.";
  }
  if (plain) {
    const system = SYSTEM_RESERVED[combo.code];
    if (system) return system;
    const composer = COMPOSER_RESERVED[combo.code];
    if (composer) return composer;
  }
  if (combo.shift && !combo.alt) {
    if (combo.code === "KeyZ") return "다시 실행 키입니다.";
    if (combo.code === "KeyQ") return "로그아웃 키입니다.";
  }
  if (!desktop) {
    if (plain) {
      const browser = BROWSER_RESERVED[combo.code];
      if (browser) return browser;
      if (/^Digit[1-9]$/.test(combo.code)) return "탭 전환 키여서 브라우저가 먼저 받습니다.";
    }
    if (combo.shift && !combo.alt && ["KeyT", "KeyN", "KeyW", "KeyR", "KeyP"].includes(combo.code)) {
      return "브라우저가 먼저 받는 키입니다.";
    }
  }
  return null;
}

// ---- 충돌 ---------------------------------------------------------------

export type BindingRejection =
  | { kind: "invalid"; message: string }
  | { kind: "reserved"; message: string }
  | { kind: "terminal"; message: string; terminalBindingId: string }
  | { kind: "conflict"; message: string; conflictId: string };

export type BindingCheck = { ok: true } | ({ ok: false } & BindingRejection);

function terminalEvent(combo: ShortcutCombo, platform: KeyPlatform) {
  return {
    code: combo.code,
    key: codeKey(combo.code),
    metaKey: platform === "mac",
    ctrlKey: platform !== "mac",
    altKey: combo.alt,
    shiftKey: combo.shift,
  };
}

/** 터미널이 앱으로 넘기는 키(D5 표)와 겹치면 그 줄의 id, 아니면 `null`. */
export function terminalConflict(
  combo: ShortcutCombo,
  platform: KeyPlatform
): { id: string; description: string } | null {
  const event = terminalEvent(combo, platform);
  if (!isTerminalAppKey(event, platform)) return null;
  for (const binding of TERMINAL_APP_BINDINGS) {
    for (const cap of binding.keycaps) {
      const target = keycapToEvent(cap);
      if (target === null) continue;
      const targetMod = target.metaKey === true || target.ctrlKey === true;
      if (
        target.code === combo.code &&
        targetMod &&
        (target.shiftKey === true) === combo.shift &&
        (target.altKey === true) === combo.alt
      ) {
        return { id: binding.id, description: binding.description };
      }
    }
  }
  return { id: "terminal", description: "터미널 단축키" };
}

export interface BindingContext {
  desktop: boolean;
  platform: KeyPlatform;
  /** id → 지금 유효한 조합(재지정 반영). 재지정 가능한 항목 전부. */
  effective: Readonly<Record<string, ShortcutCombo>>;
  /** id → 사람이 읽는 이름. 충돌 문구에 쓴다. */
  names?: Readonly<Record<string, string>>;
}

/**
 * `id`에 `combo`를 지정할 수 있는가. **판정은 이 한 함수다**(UI·저장소 읽기가 같이 쓴다).
 * 기본 조합으로 돌려놓는 것(초기화)은 이 검사를 거치지 않는다.
 */
export function checkBinding(id: string, combo: ShortcutCombo, ctx: BindingContext): BindingCheck {
  if (!isKnownCode(combo.code)) {
    return { ok: false, kind: "invalid", message: "지원하지 않는 키입니다." };
  }
  const reserved = reservedReason(combo, ctx.desktop);
  if (reserved !== null) {
    return { ok: false, kind: "reserved", message: `지정할 수 없습니다. ${reserved}` };
  }
  if (ctx.desktop) {
    const terminal = terminalConflict(combo, ctx.platform);
    if (terminal !== null) {
      return {
        ok: false,
        kind: "terminal",
        terminalBindingId: terminal.id,
        message: `지정할 수 없습니다. 터미널 안에서 앱이 받는 「${terminal.description}」 키입니다.`,
      };
    }
  }
  for (const other of REBINDABLE_IDS) {
    if (other === id) continue;
    const otherCombo = ctx.effective[other];
    if (otherCombo !== undefined && sameCombo(otherCombo, combo)) {
      const name = ctx.names?.[other] ?? other;
      return {
        ok: false,
        kind: "conflict",
        conflictId: other,
        message: `이미 「${name}」에 쓰고 있는 키입니다.`,
      };
    }
  }
  return { ok: true };
}

// ---- 저장소 --------------------------------------------------------------

type Overrides = Record<string, ShortcutCombo>;

let overrides: Overrides | null = null;
let storageFailed = false;
let version = 0;
const listeners = new Set<() => void>();

function currentPlatform(): KeyPlatform {
  if (typeof navigator === "undefined") return "other";
  return /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent) ? "mac" : "other";
}

export function effectiveCombos(source: Overrides = loaded()): Record<string, ShortcutCombo> {
  const result: Record<string, ShortcutCombo> = {};
  for (const id of REBINDABLE_IDS) result[id] = source[id] ?? DEFAULT_COMBOS[id];
  return result;
}

function parseCombo(value: unknown): ShortcutCombo | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.code !== "string" || !isKnownCode(record.code)) return null;
  if (typeof record.shift !== "boolean" || typeof record.alt !== "boolean") return null;
  return { code: record.code, shift: record.shift, alt: record.alt };
}

/**
 * 저장된 원문을 안전한 재지정 표로. 항목마다 걸러서, 한 항목이 깨져도 나머지는 산다.
 * 모르는 id·모르는 키·예약 키·터미널 키·서로 겹치는 항목은 기본 키로 돌아간다.
 */
export function parseStoredOverrides(
  raw: string | null,
  ctx: { desktop: boolean; platform: KeyPlatform } = {
    desktop: isDesktop(),
    platform: currentPlatform(),
  }
): Overrides {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const record = parsed as Record<string, unknown>;
  if (record.version !== STORAGE_VERSION) return {};
  const bindings = record.bindings;
  if (typeof bindings !== "object" || bindings === null) return {};

  const candidate: Overrides = {};
  for (const id of REBINDABLE_IDS) {
    const combo = parseCombo((bindings as Record<string, unknown>)[id]);
    if (combo === null) continue;
    if (sameCombo(combo, DEFAULT_COMBOS[id])) continue;
    candidate[id] = combo;
  }
  // 단독 검사(예약·터미널): 걸리면 그 항목만 기본으로.
  for (const id of Object.keys(candidate)) {
    const solo = checkBinding(id, candidate[id], { ...ctx, effective: DEFAULT_COMBOS });
    if (!solo.ok && (solo.kind === "reserved" || solo.kind === "terminal" || solo.kind === "invalid")) {
      delete candidate[id];
    }
  }
  // 서로 겹침: 겹치는 둘 중 재지정된 쪽을 기본으로 돌리고 다시 본다.
  for (let guard = 0; guard <= REBINDABLE_IDS.length; guard += 1) {
    const effective = effectiveCombos(candidate);
    let dropped = false;
    for (let i = 0; i < REBINDABLE_IDS.length && !dropped; i += 1) {
      for (let j = i + 1; j < REBINDABLE_IDS.length && !dropped; j += 1) {
        const a = REBINDABLE_IDS[i];
        const b = REBINDABLE_IDS[j];
        if (!sameCombo(effective[a], effective[b])) continue;
        const loser = candidate[b] !== undefined ? b : a;
        delete candidate[loser];
        dropped = true;
      }
    }
    if (!dropped) break;
  }
  return candidate;
}

function loaded(): Overrides {
  if (overrides !== null) return overrides;
  let raw: string | null = null;
  try {
    if (typeof localStorage !== "undefined") raw = localStorage.getItem(SHORTCUT_STORAGE_KEY);
  } catch {
    raw = null;
  }
  overrides = parseStoredOverrides(raw);
  return overrides;
}

function persist(): void {
  try {
    if (typeof localStorage === "undefined") return;
    const current = loaded();
    if (Object.keys(current).length === 0) {
      localStorage.removeItem(SHORTCUT_STORAGE_KEY);
    } else {
      localStorage.setItem(
        SHORTCUT_STORAGE_KEY,
        JSON.stringify({ version: STORAGE_VERSION, bindings: current })
      );
    }
    storageFailed = false;
  } catch {
    storageFailed = true;
  }
}

function commit(next: Overrides): void {
  overrides = next;
  version += 1;
  persist();
  for (const listener of [...listeners]) listener();
}

/** 지금 재지정된 조합. 없으면 `undefined`(기본 키). */
export function getOverride(id: string): ShortcutCombo | undefined {
  return loaded()[id];
}

export function effectiveCombo(id: string): ShortcutCombo | undefined {
  return effectiveCombos()[id];
}

export function isCustomized(id: string): boolean {
  return loaded()[id] !== undefined;
}

export function customizedCount(): number {
  return Object.keys(loaded()).length;
}

export function shortcutStorageFailed(): boolean {
  return storageFailed;
}

/** 검사 없이 지정한다. 호출하는 쪽이 `checkBinding`을 먼저 통과시켜야 한다. */
export function setBinding(id: string, combo: ShortcutCombo): void {
  if (!(id in DEFAULT_COMBOS)) return;
  const next = { ...loaded() };
  if (sameCombo(combo, DEFAULT_COMBOS[id])) delete next[id];
  else next[id] = combo;
  commit(next);
}

/** 두 항목의 조합을 맞바꾼다. 둘 다 한 번에 저장한다. */
export function swapBindings(a: string, b: string): void {
  if (!(a in DEFAULT_COMBOS) || !(b in DEFAULT_COMBOS)) return;
  const effective = effectiveCombos();
  const next = { ...loaded() };
  for (const [id, combo] of [
    [a, effective[b]],
    [b, effective[a]],
  ] as const) {
    if (sameCombo(combo, DEFAULT_COMBOS[id])) delete next[id];
    else next[id] = combo;
  }
  commit(next);
}

export function resetBinding(id: string): void {
  if (loaded()[id] === undefined) return;
  const next = { ...loaded() };
  delete next[id];
  commit(next);
}

export function resetAllBindings(): void {
  if (customizedCount() === 0) return;
  commit({});
}

export function subscribeShortcutBindings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 재지정이 바뀔 때마다 다시 그리게 한다. 도움말·팔레트·설정이 키캡을 다시 읽는다. */
export function useShortcutBindingsVersion(): number {
  return useSyncExternalStore(
    subscribeShortcutBindings,
    () => version,
    () => version
  );
}

/** 시험 전용: 메모리 상태를 비우고 저장소를 다시 읽게 한다. */
export function resetShortcutBindingsForTest(): void {
  overrides = null;
  storageFailed = false;
  version += 1;
  listeners.clear();
}
