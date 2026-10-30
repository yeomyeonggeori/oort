import {describe, expect, it} from 'vitest';
import {initialStage, stageTransition, fitStageRect, stageExitRect, visibleStageRect} from './stageTransition';
const viewport = {width: 400, height: 800};
const thumbnail = {x: 30, y: 120, width: 136, height: 136};
const fitted = {x: 0, y: 200, width: 400, height: 400};

describe('stage transition #4775', () => {
  it('opens before exposing controls and closes only after arrival', () => {
    const opening = initialStage(false);
    expect(opening.phase).toBe('opening');
    const open = stageTransition(opening, {type: 'arrived', ticket: opening.ticket});
    expect(open.phase).toBe('open');
    const closing = stageTransition(open, {type: 'close', zoomed: false, reduceMotion: false});
    expect(closing.phase).toBe('closing');
    expect(stageTransition(closing, {type: 'arrived', ticket: closing.ticket}).phase).toBe('closed');
  });
  it('fits an enlarged stage before beginning its exit, and ignores duplicate close requests', () => {
    const fitting = stageTransition(initialStage(true), {type: 'close', zoomed: true, reduceMotion: false});
    expect(fitting.phase).toBe('fitting');
    expect(stageTransition(fitting, {type: 'arrived', ticket: fitting.ticket})).toBe(fitting);
    expect(stageTransition(fitting, {type: 'close', zoomed: false, reduceMotion: false})).toBe(fitting);
    expect(stageTransition(fitting, {type: 'fit'}).phase).toBe('closing');
  });
  it('a late opening completion cannot reopen an interrupted close', () => {
    const opening = initialStage(false);
    const closing = stageTransition(opening, {type: 'close', zoomed: false, reduceMotion: false});
    expect(stageTransition(closing, {type: 'arrived', ticket: opening.ticket})).toBe(closing);
    expect(stageTransition(closing, {type: 'close', zoomed: false, reduceMotion: false})).toBe(closing);
  });
  it('reduced motion opens and closes synchronously even when zoomed', () => {
    const open = initialStage(true);
    expect(open.phase).toBe('open');
    expect(stageTransition(open, {type: 'close', zoomed: true, reduceMotion: true}).phase).toBe('closed');
  });
  it('turning reduced motion on settles every moving state', () => {
    expect(stageTransition(initialStage(false), {type: 'reduce'}).phase).toBe('open');
    for (const phase of ['fitting', 'closing'] as const) {
      expect(stageTransition({phase, ticket: 2}, {type: 'reduce'})).toEqual({phase: 'closed', ticket: 3});
    }
  });
  it('fits portrait and landscape photos without stretching or including letterboxes in zoom bounds', () => {
    expect(fitStageRect({width: 800, height: 400}, viewport)).toEqual({x: 0, y: 300, width: 400, height: 200});
    expect(fitStageRect({width: 200, height: 800}, viewport)).toEqual({x: 100, y: 0, width: 200, height: 800});
  });
  it('uses the current measured source, and drops offscreen or unmounted sources below the viewport', () => {
    expect(stageExitRect(thumbnail, fitted, viewport)).toBe(thumbnail);
    for (const source of [null, {...thumbnail, y: -1}, {...thumbnail, y: 790}, {...thumbnail, x: 900}]) {
      expect(stageExitRect(source, fitted, viewport)).toEqual({...fitted, y: viewport.height});
    }
  });
  it('rejects failed native measurements instead of flying to a zero or NaN rectangle', () => {
    for (const source of [{...thumbnail, width: 0}, {...thumbnail, x: NaN}, {...thumbnail, y: Infinity}]) {
      expect(visibleStageRect(source, viewport)).toBe(false);
    }
  });
});
