import { useSyncExternalStore } from "react";
import {
  DOCK_ENTRY,
  clampDockRatio,
  defaultDockPrefs,
  parseDockPrefs,
  serializeDockPrefs,
} from "@momo/core/features/workbench/dockStore";

// =============================================================================
// 터미널 도크의 열림·전체 화면·높이 (#2774). 셸(AppShell)과 채널 머리
// 버튼(ChatShell)과 전역 키가 같은 도크를 연다. 셋이 각자 상태를 들면 하나가
// 낡으므로 모듈 저장소 하나에 둔다.
//
// 높이 비율만 이 기기에 저장한다(ADR-0174). 열림과 전체 화면은 저장하지 않는다:
// 앱을 열자마자 도크가 화면 절반을 덮고 있으면 첫 화면이 채팅이 아니게 된다.
// =============================================================================

export interface DockState {
  open: boolean;
  fullscreen: boolean;
  ratio: number;
  /** 높이를 이 기기에 저장하지 못했다. */
  storageFailed: boolean;
}

function readRatio(): { ratio: number; storageFailed: boolean } {
  try {
    const prefs = parseDockPrefs(window.localStorage.getItem(DOCK_ENTRY)) ?? defaultDockPrefs();
    return { ratio: prefs.ratio, storageFailed: false };
  } catch {
    return { ratio: defaultDockPrefs().ratio, storageFailed: true };
  }
}

let state: DockState = { open: false, fullscreen: false, ...readRatio() };
const listeners = new Set<() => void>();

function set(patch: Partial<DockState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function subscribeDock(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function dockSnapshot(): DockState {
  return state;
}

export function useDockState(): DockState {
  return useSyncExternalStore(subscribeDock, dockSnapshot, dockSnapshot);
}

/** 도크를 연 컨트롤. 닫을 때 캐럿을 돌려준다. */
let opener: HTMLElement | null = null;

export function openDock(from?: Element | null) {
  if (!state.open) {
    const active = from ?? (typeof document !== "undefined" ? document.activeElement : null);
    opener = active instanceof HTMLElement ? active : null;
  }
  set({ open: true });
}

export function closeDock() {
  if (!state.open) return;
  set({ open: false, fullscreen: false });
  const target = opener;
  opener = null;
  if (target && target.isConnected) target.focus({ preventScroll: true });
}

export function toggleDock(from?: Element | null) {
  if (state.open) closeDock();
  else openDock(from);
}

/** 전체 화면은 도크를 연 채로 판 전체로 키운다. 닫혀 있으면 열면서 키운다. */
export function toggleDockFullscreen(from?: Element | null) {
  if (!state.open) {
    openDock(from);
    set({ fullscreen: true });
    return;
  }
  set({ fullscreen: !state.fullscreen });
}

export function setDockRatio(ratio: number, containerPx: number) {
  const next = clampDockRatio(ratio, containerPx);
  if (next === state.ratio) return;
  let storageFailed = false;
  try {
    window.localStorage.setItem(DOCK_ENTRY, serializeDockPrefs({ v: 1, ratio: next }));
  } catch {
    storageFailed = true;
  }
  set({ ratio: next, storageFailed });
}

/** 시험용. */
export function resetDockStateForTest(next: Partial<DockState> = {}) {
  state = { open: false, fullscreen: false, ratio: defaultDockPrefs().ratio, storageFailed: false, ...next };
  opener = null;
  listeners.forEach((l) => l());
}
