import { useSyncExternalStore } from "react";
import {
  derivePaneStatus,
  attentionCopy,
  attentionTransitions,
  shouldNotifyAttention,
  type AttentionStatus,
  type PaneSignal,
} from "@momo/core/features/workbench/paneStatus";
import type { SessionStatus } from "@momo/core/features/workbench/sessionList";
import { focusPane } from "@momo/core/features/workbench/layoutTree";
import { isDesktop, showNotification } from "@/lib/tauri";
import {
  browserLayoutStorage,
  readWorkbenchLayout,
  writeWorkbenchLayout,
  type LayoutStorage,
} from "../useWorkbenchLayout";
import { DOCK_SESSION_KEY, type LocalSessionView } from "./localSessions";

// =============================================================================
// 「나를 기다림」·「끝남」의 합류점 (#2776, 제안서 §3.4).
//
// 칸 상태가 **새로** 「나를 기다림」이나 「끝남」이 되면:
//   - 인박스의 「이 기기의 칸」 줄에 오른다(`useLocalPaneAttention`). 그 칸을 보면
//     (격자의 활성 칸이 되면) 내려간다.
//   - 사람이 그 칸을 보고 있지 않으면 OS 알림을 한 번 띄운다. 권한이 없으면
//     `showNotification`이 조용히 false를 돌려준다. 토스트는 없다(ADR-0182).
//
// 이 기기에만 있다. 서버 호출도 저장도 없다(ADR-0190 D2). 앱에 하나다: 도크와
// 「내 작업」 탭이 번갈아 마운트돼도 같은 이전 판정을 보므로 알림이 두 번 뜨지 않는다.
// =============================================================================

/** 칸 하나의 상태(#2776): 생명주기와 하네스 hook 신호만. 출력은 읽지 않는다. */
export function paneStatusOf(view: LocalSessionView | null | undefined): SessionStatus | undefined {
  if (!view) return undefined;
  return derivePaneStatus({
    phase: view.phase,
    exitCode: view.exit?.code ?? null,
    exitSignal: view.exit?.signal ?? null,
    signal: view.signal,
  });
}

export interface PaneAttentionEntry {
  paneId: string;
  status: AttentionStatus;
  signal: PaneSignal | null;
  index: number;
  name: string;
  atMs: number;
}

export interface PaneObservation {
  paneId: string;
  index: number;
  name: string;
  status: SessionStatus;
  signal: PaneSignal | null;
}

export interface PaneAttentionDeps {
  notify: (title: string, body: string) => Promise<boolean>;
  windowFocused: () => boolean;
  now: () => number;
}

export function createPaneAttention(deps: PaneAttentionDeps) {
  let previous = new Map<string, SessionStatus>();
  let entries: readonly PaneAttentionEntry[] = [];
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());

  const api = {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    entries(): readonly PaneAttentionEntry[] {
      return entries;
    },

    /**
     * 지금 칸 판정 전부와 사람이 보고 있는 칸. 새로 기다림·끝남이 된 칸만 알린다.
     * 판정에서 빠진 칸(닫은 칸)과 더는 기다림·끝남이 아닌 칸은 인박스에서 내린다.
     */
    observe(panes: readonly PaneObservation[], viewing: string | null): void {
      const next = new Map(panes.map((p) => [p.paneId, p.status] as const));
      const fresh = attentionTransitions(previous, next);
      previous = next;
      const byId = new Map(panes.map((p) => [p.paneId, p] as const));
      let changed = false;
      let kept = entries.filter((e) => {
        const p = byId.get(e.paneId);
        const keep = p !== undefined && p.status === e.status && e.paneId !== viewing;
        if (!keep) changed = true;
        return keep;
      });
      const focused = deps.windowFocused();
      for (const t of fresh) {
        const p = byId.get(t.paneId)!;
        const inView = t.paneId === viewing;
        if (!inView) {
          kept = [
            ...kept.filter((e) => e.paneId !== t.paneId),
            { paneId: t.paneId, status: t.status, signal: p.signal, index: p.index, name: p.name, atMs: deps.now() },
          ];
          changed = true;
        }
        if (shouldNotifyAttention({ windowFocused: focused, paneInView: inView })) {
          const copy = attentionCopy(t.status, { index: p.index, name: p.name }, p.signal);
          void deps.notify(copy.title, copy.body).catch(() => false);
        }
      }
      // 번호·이름은 배치가 바뀌면 따라간다.
      kept = kept.map((e) => {
        const p = byId.get(e.paneId);
        if (!p || (p.index === e.index && p.name === e.name)) return e;
        changed = true;
        return { ...e, index: p.index, name: p.name };
      });
      if (changed) {
        entries = kept;
        emit();
      }
    },

  };
  return api;
}

export type PaneAttention = ReturnType<typeof createPaneAttention>;

let shared: PaneAttention | null = null;

export function paneAttention(): PaneAttention {
  shared ??= createPaneAttention({
    notify: (title, body) => (isDesktop() ? showNotification(title, body) : Promise.resolve(false)),
    windowFocused: () => typeof document !== "undefined" && document.hasFocus() && document.visibilityState === "visible",
    now: () => Date.now(),
  });
  return shared;
}

export function useLocalPaneAttention(store: PaneAttention = paneAttention()): readonly PaneAttentionEntry[] {
  return useSyncExternalStore(store.subscribe, store.entries, store.entries);
}

/**
 * 인박스에서 칸을 골랐다: 저장된 배치의 활성 칸을 그 칸으로 바꾼다. 곧 「내 작업」이
 * 이 배치로 마운트되므로 첫 그림부터 그 칸이 활성이다(마운트 뒤에 바꾸면 전의 활성
 * 칸 터미널이 캐럿을 먼저 잡아 되돌린다). 없는 칸이면 아무것도 하지 않는다.
 */
export function focusStoredPane(
  paneId: string,
  storage: LayoutStorage | null = browserLayoutStorage(),
  sessionKey: string = DOCK_SESSION_KEY
): boolean {
  const { layout } = readWorkbenchLayout(storage, sessionKey);
  const result = focusPane(layout, paneId);
  if (!result.ok) return false;
  writeWorkbenchLayout(storage, sessionKey, result.layout);
  return true;
}
