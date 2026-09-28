import { useSyncExternalStore } from "react";
import {
  AGENT_PANE_BINDINGS_KEY,
  bindAgentPane,
  parseAgentPaneBindings,
  pruneAgentPanes,
  unbindAgentPane,
  type AgentPaneBindings,
} from "@momo/core/features/workbench/agentPane";

// =============================================================================
// 칸 ↔ A 세션 묶음(#2779). 이 기기 localStorage 한 항목이다(배치와 같은 자리).
// 저장소가 없거나 막혀 있으면 이번 실행에만 기억한다. 서버에 올리지 않는다.
// =============================================================================

export interface AgentPaneStore {
  get(): AgentPaneBindings;
  subscribe(listener: () => void): () => void;
  bind(paneId: string, sessionId: string): void;
  unbind(paneId: string): void;
  prune(livePaneIds: readonly string[]): void;
}

export function createAgentPaneStore(
  storage: () => Pick<Storage, "getItem" | "setItem"> | null = () => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }
): AgentPaneStore {
  let current: AgentPaneBindings = (() => {
    try {
      return parseAgentPaneBindings(storage()?.getItem(AGENT_PANE_BINDINGS_KEY) ?? null);
    } catch {
      return {};
    }
  })();
  const listeners = new Set<() => void>();
  const set = (next: AgentPaneBindings) => {
    if (next === current) return;
    current = next;
    try {
      storage()?.setItem(AGENT_PANE_BINDINGS_KEY, JSON.stringify(next));
    } catch {
      /* 이번 실행에만 기억한다 */
    }
    for (const listener of listeners) listener();
  };
  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    bind: (paneId, sessionId) => set(bindAgentPane(current, paneId, sessionId)),
    unbind: (paneId) => set(unbindAgentPane(current, paneId)),
    prune: (ids) => set(pruneAgentPanes(current, ids)),
  };
}

let shared: AgentPaneStore | null = null;

/** 앱 전체에 하나. 도크와 「내 작업」 탭이 같은 배치를 그리므로 같은 묶음을 본다. */
export function agentPaneStore(): AgentPaneStore {
  shared ??= createAgentPaneStore();
  return shared;
}

export function useAgentPaneBindings(store: AgentPaneStore): AgentPaneBindings {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
