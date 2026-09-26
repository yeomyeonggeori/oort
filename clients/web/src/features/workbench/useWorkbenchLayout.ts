import { useCallback, useState } from "react";
import {
  defaultWorkbenchLayout,
  type WorkbenchLayout,
} from "@momo/core/features/workbench/layoutTree";
import {
  parseWorkbenchLayout,
  serializeWorkbenchLayout,
  workbenchLayoutEntry,
} from "@momo/core/features/workbench/layoutStore";

// =============================================================================
// 격자 배치를 세션(worktree)마다 이 기기에 둔다 (#2773, ADR-0174 「외양=이 기기」).
//
// 저장소는 없을 수도, 던질 수도 있다(사생활 모드, 막힌 사이트 데이터, 할당량).
// 어느 경우에도 격자는 그린다: 읽기가 실패하면 기본 배치, 쓰기가 실패하면 화면의
// 배치는 그대로 두고 `storage: "unavailable"`로 알린다. 호스트가 그것을 한 줄로
// 말한다(토스트 금지, ADR-0182).
// =============================================================================

/** `localStorage`에서 쓰는 두 메서드만. 시험과 하네스가 메모리 저장소를 넣는다. */
export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type LayoutStorageStatus = "ok" | "unavailable";

/** `window.localStorage`에 닿는 것 자체가 던질 수 있다(SecurityError). */
export function browserLayoutStorage(): LayoutStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function memoryLayoutStorage(seed: Record<string, string> = {}): LayoutStorage {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

export function readWorkbenchLayout(
  storage: LayoutStorage | null,
  sessionKey: string
): { layout: WorkbenchLayout; storage: LayoutStorageStatus } {
  if (storage === null) return { layout: defaultWorkbenchLayout(), storage: "unavailable" };
  let raw: string | null;
  try {
    raw = storage.getItem(workbenchLayoutEntry(sessionKey));
  } catch {
    return { layout: defaultWorkbenchLayout(), storage: "unavailable" };
  }
  return { layout: parseWorkbenchLayout(raw) ?? defaultWorkbenchLayout(), storage: "ok" };
}

export function writeWorkbenchLayout(
  storage: LayoutStorage | null,
  sessionKey: string,
  layout: WorkbenchLayout
): LayoutStorageStatus {
  if (storage === null) return "unavailable";
  try {
    storage.setItem(workbenchLayoutEntry(sessionKey), serializeWorkbenchLayout(layout));
    return "ok";
  } catch {
    return "unavailable";
  }
}

interface State {
  sessionKey: string;
  layout: WorkbenchLayout;
  storage: LayoutStorageStatus;
}

/**
 * 세션 키가 바뀌면 그 세션의 배치를 다시 읽는다. 앞 세션의 배치가 새 세션
 * 이름으로 저장되지 않게, 상태가 자기 세션 키를 같이 든다.
 */
export function useWorkbenchLayout(
  sessionKey: string,
  storage: LayoutStorage | null = browserLayoutStorage()
): {
  layout: WorkbenchLayout;
  storage: LayoutStorageStatus;
  setLayout: (next: WorkbenchLayout) => void;
} {
  const [state, setState] = useState<State>(() => ({
    sessionKey,
    ...readWorkbenchLayout(storage, sessionKey),
  }));

  let current = state;
  if (state.sessionKey !== sessionKey) {
    // 렌더 중에 파생 상태를 맞추는 React 권장 모양(이전 값과 비교해 한 번만 set).
    current = { sessionKey, ...readWorkbenchLayout(storage, sessionKey) };
    setState(current);
  }

  const setLayout = useCallback(
    (next: WorkbenchLayout) => {
      const status = writeWorkbenchLayout(storage, sessionKey, next);
      setState({ sessionKey, layout: next, storage: status });
    },
    [storage, sessionKey]
  );

  return { layout: current.layout, storage: current.storage, setLayout };
}
