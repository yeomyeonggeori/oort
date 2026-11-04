// @vitest-environment jsdom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// 라이트박스의 첫 초점 (#5275).
//
// 재는 것 (되돌리면 실패해야 하는 것들):
//   1. 움직임 줄이기로 열어도 Radix FocusScope가 「마지막으로 안에 있던 초점」(닫기)을 기억한다: 초점이 밖으로 나가면 닫기로 되돌아온다.
//      WebKit은 단추를 건너뛰는 탭 순서라 Shift+Tab 한 번에 무대 뒤 입력창으로 나가는데, 이 기억이 비어 있으면 아무도 되돌리지 않았다.
//   2. 열기 단추를 키보드(click.detail 0)로 눌렀으면 입력 방식 표지가 keyboard로 올라가 첫 초점에 링이 서고, 마우스(detail 1)로
//      눌렀으면 pointer 그대로라 링이 서지 않는다.
// 진짜 엔진(Chromium·WebKit)에서의 Tab 순환과 계산된 링은 `scripts/capture-5190.mjs`의 「키보드로 열기」 묶음이 잰다.
vi.mock('@/app/session', () => ({useSession: () => ({workspaceId: 'ws', connStatus: 'connected'})}));
vi.mock('./content', () => ({useAttachmentPreview: () => ({status: 'ready', dataUrl: 'data:image/png;base64,AAAA', retry: vi.fn()})}));
const {AttachmentList} = await import('../timeline/AttachmentList');
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let outside: HTMLInputElement;
const images = ['a', 'b'].map(id => ({id, name: `${id}.png`, mime: 'image/png', sizeBytes: 1024}));
const q = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const closeButton = () => q('[data-testid="image-lightbox-close"]');
const modality = () => document.documentElement.getAttribute('data-focus-modality');
/** 열기 단추를 누른다. `detail`: 키보드(Enter·Space)에서 온 click은 0, 마우스는 1이다(Chromium·WebKit 실측). */
function press(detail: 0 | 1) {
  act(() => {
    host.querySelector('[data-testid="attachment-image"] button')!.dispatchEvent(new MouseEvent('click', {bubbles: true, detail}));
  });
}

beforeEach(() => {
  // 움직임 줄이기: 펼침 없이 곧바로 `open` 단계라 `interactive`가 대화상자가 서는 같은 틱에 참이 된다(경쟁이 나는 길).
  vi.stubGlobal('matchMedia', () => ({matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn()}));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  outside = document.createElement('input'); outside.setAttribute('data-testid', 'outside-input'); document.body.append(outside);
  document.documentElement.setAttribute('data-focus-modality', 'pointer');
  act(() => root.render(<AttachmentList channelId="ch" attachments={images} />));
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); outside.remove();
  document.documentElement.removeAttribute('data-focus-modality');
  vi.unstubAllGlobals();
});

describe('image lightbox first focus #5275', () => {
  it('remembers the close button as the last focus inside, so focus that leaves is pulled back (reduced motion)', () => {
    press(0);
    expect(document.activeElement, 'the close button takes the first focus').toBe(closeButton());
    act(() => outside.focus());
    expect(document.activeElement, 'focus that left the lightbox comes back to the close button').toBe(closeButton());
  });

  it('raises the focus modality to keyboard only when the opener was pressed from the keyboard', () => {
    press(1);
    expect(modality(), 'a mouse press leaves the stamp alone, so no ring on the first focus').toBe('pointer');
    act(() => closeButton().click());
    press(0);
    expect(modality(), 'a keyboard press makes the first focus ring show').toBe('keyboard');
  });
});
