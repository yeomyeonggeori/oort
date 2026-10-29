import {useCallback, useRef} from 'react';
import type {View} from 'react-native';
import {validStageRect, type StageRect} from '@momo/core/lib/stageTransition';

export type MeasureHeroSource = (id: string) => Promise<StageRect | null>;
/** Per-message registry: stable attachment IDs survive paging; unmounted tiles have no destination. */
export function useHeroSources() {
  const nodes = useRef(new Map<string, View>());
  const register = useCallback((id: string, node: View | null) => {
    if (node) nodes.current.set(id, node);
    else nodes.current.delete(id);
  }, []);
  const measure = useCallback<MeasureHeroSource>(id => new Promise(resolve => {
    const node = nodes.current.get(id);
    if (!node) { resolve(null); return; }
    // Measurement must not strand the close control if Fabric drops a callback after unmount.
    const timeout = setTimeout(() => resolve(null), 100);
    node.measureInWindow((x, y, width, height) => {
      clearTimeout(timeout);
      const rect = {x, y, width, height};
      resolve(nodes.current.get(id) === node && validStageRect(rect) ? rect : null);
    });
  }), []);
  return {register, measure};
}
