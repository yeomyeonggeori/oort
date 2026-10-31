/** Platform-free stage lifecycle. Native and web own measurement/animation, never the list's layout.
 * Reusable for photo and decision stages. Completion tickets reject interrupted animations. */
export type StagePhase = 'opening' | 'open' | 'fitting' | 'closing' | 'closed';
export interface StageTransition { phase: StagePhase; ticket: number }
export type StageEvent =
  | { type: 'close'; zoomed: boolean; reduceMotion: boolean }
  | { type: 'arrived'; ticket: number }
  | { type: 'fit' }
  | { type: 'reduce' };

export function initialStage(reduceMotion: boolean): StageTransition {
  return { phase: reduceMotion ? 'open' : 'opening', ticket: 0 };
}
export function stageTransition(state: StageTransition, event: StageEvent): StageTransition {
  const go = (phase: StagePhase): StageTransition => ({ phase, ticket: state.ticket + 1 });
  switch (event.type) {
    case 'close':
      if (state.phase === 'closed' || state.phase === 'closing' || state.phase === 'fitting') return state;
      if (event.reduceMotion) return go('closed');
      return go(event.zoomed ? 'fitting' : 'closing');
    case 'fit':
      return state.phase === 'fitting' ? go('closing') : state;
    case 'arrived':
      if (event.ticket !== state.ticket) return state;
      if (state.phase === 'opening') return go('open');
      if (state.phase === 'closing') return go('closed');
      return state;
    case 'reduce':
      if (state.phase === 'opening') return go('open');
      if (state.phase === 'fitting' || state.phase === 'closing') return go('closed');
      return state;
  }
}

export interface StageRect { x: number; y: number; width: number; height: number }
export interface StageSize { width: number; height: number }
export function validStageRect(rect: StageRect | null): rect is StageRect {
  return rect !== null && Object.values(rect).every(Number.isFinite) && rect.width > 0 && rect.height > 0;
}
/** A partially clipped source also exits downwards: never fly behind a conversation's chrome. */
export function visibleStageRect(rect: StageRect | null, viewport: StageSize): rect is StageRect {
  return validStageRect(rect) && rect.x >= 0 && rect.y >= 0 &&
    rect.x + rect.width <= viewport.width && rect.y + rect.height <= viewport.height;
}
export function fitStageRect(photo: StageSize | null, viewport: StageSize): StageRect {
  if (!photo || !(photo.width > 0 && photo.height > 0)) return { x: 0, y: 0, ...viewport };
  const scale = Math.min(viewport.width / photo.width, viewport.height / photo.height);
  const width = photo.width * scale;
  const height = photo.height * scale;
  return { x: (viewport.width - width) / 2, y: (viewport.height - height) / 2, width, height };
}
export function stageExitRect(source: StageRect | null, fitted: StageRect, viewport: StageSize): StageRect {
  return visibleStageRect(source, viewport) ? source : { ...fitted, y: viewport.height };
}
