// @vitest-environment jsdom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
vi.mock('@/app/session', () => ({useSession: () => ({workspaceId: 'ws', connStatus: 'connected'})}));
vi.mock('./content', () => ({useAttachmentPreview: () => ({status: 'ready', dataUrl: 'data:image/png;base64,AAAA', retry: vi.fn()})}));
const {AttachmentList} = await import('../timeline/AttachmentList');
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let reduce = false;
let motions: Array<{node: HTMLElement; frames: Keyframe[]; finish: () => void}>;
const q = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const click = (node: HTMLElement) => act(() => node.click());
const stage = () => q('[data-testid="image-lightbox"]');
const photo = () => q<HTMLImageElement>('.lightbox-photo');
async function finish() {
  await act(async () => { motions.splice(0).forEach(motion => motion.finish()); });
}
function open(index = 0) {
  act(() => root.render(<AttachmentList channelId="ch" attachments={['a', 'b'].map(id => ({id, name: `${id}.png`, mime: 'image/png', sizeBytes: 1024}))} />));
  click(host.querySelectorAll<HTMLButtonElement>('[data-testid="attachment-image"] button')[index]);
  act(() => photo().dispatchEvent(new Event('load')));
}
beforeEach(() => {
  reduce = false;
  motions = [];
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.stubGlobal('matchMedia', () => ({matches: reduce, addEventListener: vi.fn(), removeEventListener: vi.fn()}));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const tile = this.closest('[data-testid="attachment-image"]');
    const index = tile ? [...host.querySelectorAll('[data-testid="attachment-image"]')].indexOf(tile) : -1;
    const rect = tile ? {x: 30 + index * 150, y: 120, width: 136, height: 136} :
      this.matches('.lightbox-photo') ? {x: 200, y: 150, width: 600, height: 400} : {x: 0, y: 0, width: 1024, height: 768};
    return {...rect, left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON: () => rect};
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function(this: HTMLElement) {return this.matches('.lightbox-photo') ? 600 : 1024;});
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function(this: HTMLElement) {return this.matches('.lightbox-photo') ? 400 : 768;});
  vi.stubGlobal('Animation', class {});
  Object.defineProperty(HTMLElement.prototype, 'animate', {configurable: true, writable: true, value: vi.fn(function(this: HTMLElement, frames: Keyframe[]) {
    let finish!: () => void;
    const finished = new Promise<void>(resolve => {finish = resolve;});
    motions.push({node: this, frames, finish});
    return {finished, cancel: vi.fn()};
  })});
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  delete (HTMLElement.prototype as unknown as {animate?: unknown}).animate;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
describe('hero4775', () => {
  it('animates from the clicked thumbnail and returns to the current page, while the blur only changes opacity', async () => {
    open();
    expect(stage().dataset.stagePhase).toBe('opening');
    const entry = motions.find(motion => motion.node.matches('.stage-hero'))!;
    expect(entry.frames[0]).toMatchObject({left: '30px', top: '120px', width: '136px'});
    expect(entry.frames.at(-1)).toMatchObject({left: '200px', top: '150px', width: '600px'});
    const scrim = motions.find(motion => motion.node.dataset.overlayLayer === 'scrim')!;
    expect(scrim.frames).toEqual([{opacity: 0}, {opacity: 1}]);
    await finish();
    expect(stage().dataset.stagePhase).toBe('open');
    click(q('[data-testid="image-lightbox-next"]'));
    click(q('[data-testid="image-lightbox-close"]'));
    // #4775 close contract: the dialog is gone; only a noninteractive snapshot exits.
    expect(stage()).toBeNull();
    expect(motions.find(motion => motion.node.matches('.stage-hero'))!.frames.at(-1)).toMatchObject({left: '180px', top: '120px', width: '136px'});
    await finish();
    expect(document.querySelector('[data-testid="image-lightbox"]')).toBeNull();
  });
  it('closes the dialog immediately, then fits the detached snapshot before its exit on Escape', async () => {
    open(); await finish();
    act(() => photo().dispatchEvent(new MouseEvent('dblclick', {bubbles: true, clientX: 500, clientY: 350})));
    expect(photo().dataset.zoomed).toBe('');
    act(() => stage().dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})));
    // #4775: fit/exit now belongs to an inert layer outside the already closed Dialog.
    expect(stage()).toBeNull();
    expect(q('.stage-hero-layer').inert).toBe(true);
    expect(q('.stage-hero-layer').getAttribute('aria-hidden')).toBe('true');
    const fit = motions.find(motion => motion.node.matches('.stage-hero'))!;
    expect(fit.frames.at(-1)).toMatchObject({width: '600px', height: '400px'});
    await finish(); // fit completion starts the return to the thumbnail
    expect(motions.find(motion => motion.node.matches('.stage-hero'))!.frames.at(-1))
      .toMatchObject({left: '30px', top: '120px', width: '136px'});
    await finish();
    expect(document.querySelector('.stage-hero-layer')).toBeNull();
  });
  it('fits from the currently painted pan when a smooth zoom is interrupted', async () => {
    open(); await finish();
    act(() => photo().dispatchEvent(new MouseEvent('dblclick', {bubbles: true, clientX: 600, clientY: 350})));
    photo().style.setProperty('--lightbox-pan-x', '-100px'); // target, still in flight
    const nativeStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(node => {
      const style = nativeStyle(node);
      if (node === photo()) Object.defineProperty(style, 'transform', {value: 'matrix(2, 0, 0, 2, -30, 0)'});
      return style;
    });
    vi.spyOn(photo(), 'getBoundingClientRect').mockReturnValue({
      x: -130, y: -50, width: 1200, height: 800,
      left: -130, top: -50, right: 1070, bottom: 750, toJSON: () => ({}),
    });
    click(q('[data-testid="image-lightbox-close"]'));
    expect(stage()).toBeNull();
    expect(motions.find(motion => motion.node.matches('.stage-hero'))!.frames.at(-1))
      .toMatchObject({left: '200px', top: '150px', width: '600px', height: '400px'});
    await finish(); await finish();
  });
  it('reduced motion opens and closes immediately without any WAAPI animation', () => {
    reduce = true;
    open(1);
    expect(stage().dataset.stagePhase).toBe('open');
    expect(motions).toHaveLength(0);
    click(q('[data-testid="image-lightbox-close"]'));
    expect(document.querySelector('[data-testid="image-lightbox"]')).toBeNull();
    expect(motions).toHaveLength(0);
  });
});
