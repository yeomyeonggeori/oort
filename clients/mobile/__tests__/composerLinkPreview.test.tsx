import {ApiError} from '@momo/core/lib/api';
import * as api from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {UnfurlPreview} from '@momo/core/features/timeline/unfurl';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';
import {Composer} from '../src/features/conversation/Composer';
import {setLinkPreviewPreference} from '../src/features/conversation/linkPreviewPreference';
import {resetUnfurlImagesForTest} from '../src/features/conversation/unfurlImage';
import {resetAttachmentDraftsForTest} from '../src/features/attachments/draftStore';
import {installAppClock} from './fixtures/fakeClock';

// =============================================================================
// #5016: 폰 입력칸(채널·스레드)의 보내기 전 링크 미리보기. 웹 입력칸(#5005 `composerLinkPreview.test.tsx`)과 **같은
// 규칙**을 폰이 지키는지 잰다 — 진짜 `Composer`·진짜 훅·진짜 카드(`CardView`)를 올리고 서버 호출(`fetchUnfurlPreview`)만
// 손으로 여닫는다. 시계는 가짜다: 350ms 기다림과 429의 `Retry-After`가 매번 같은 시각에 선다.
//
// 채널과 스레드는 **같은 `Composer`** 이고 방(첨부 대상)만 다르다. 그래서 규칙은 채널 쪽에서 재고, 스레드는 방이
// 스레드의 것으로 읽히는지(어느 채널에 묻나 · ✕가 다른 스레드로 따라가지 않나)와 전송 호출(`useTimeline`,
// `ThreadPanel`)을 따로 잰다. 픽셀은 여기서 잴 수 없다(Jest에는 레이아웃이 없다) — 캡처는 스택 검증이 한다.
// =============================================================================

const WS = 'ws-1';
const CH = 'channel-1';
const A = 'https://a.example/one';
const B = 'https://b.example/two';
const mmkv = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;
const EMPTY = makeDirectory([]);

/** 서버로 나간 미리보기 요청 한 건. 답은 시험이 정한다. */
interface Asked {
  url: string;
  channelId: string;
  signal: AbortSignal | undefined;
  resolve: (preview: UnfurlPreview) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}
let asked: Asked[] = [];
const askedUrls = (): string[] => asked.map(request => request.url);

let serial = 0;
function ok(url: string): UnfurlPreview {
  serial += 1;
  const domain = new URL(url).hostname;
  return {id: `p-${serial}`, url, status: 'ok', title: `Title of ${domain}`, domain} as UnfurlPreview;
}

const ask = jest.spyOn(api, 'fetchUnfurlPreview');
const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');

beforeEach(() => {
  installAppClock();
  mmkv.clear();
  asked = [];
  ask.mockReset();
  ask.mockImplementation(
    (_ws: string, channelId: string, url: string, signal?: AbortSignal) =>
      new Promise<UnfurlPreview>((resolve, reject) => {
        const request: Asked = {
          url,
          channelId,
          signal,
          settled: false,
          resolve: preview => {
            request.settled = true;
            resolve(preview);
          },
          reject: error => {
            request.settled = true;
            reject(error);
          },
        };
        asked.push(request);
      }),
  );
  announce.mockClear();
  resetUnfurlImagesForTest(async () => 'data:image/png;base64,AAAA');
  resetAttachmentDraftsForTest();
  setLinkPreviewPreference('compact');
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
  resetUnfurlImagesForTest();
});

const CHANNEL_TARGET = {workspaceId: WS, channelId: CH};
const THREAD_TARGET = {workspaceId: WS, channelId: CH, rootId: 'root-1'};

function composer(
  attachmentTarget: {workspaceId: string; channelId: string; rootId?: string} | undefined,
  onSend: jest.Mock,
) {
  return (
    <Composer
      recipient="place"
      channelLabel="general"
      directory={EMPTY}
      {...(attachmentTarget === undefined ? {} : {attachmentTarget})}
      onSend={onSend}
    />
  );
}

const input = () => screen.getByTestId('composer-input');
const cardTitles = (): string[] =>
  screen.queryAllByTestId('unfurl-title').map(node => String(node.props.children));

async function type(value: string) {
  await act(async () => {
    fireEvent.changeText(input(), value);
  });
}

async function wait(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

/** 가장 먼저 걸린(아직 답 없는) `url`의 요청에 답한다. */
async function answer(url: string, preview: UnfurlPreview = ok(url)) {
  const request = asked.find(one => one.url === url && !one.settled);
  if (!request) throw new Error(`no request for ${url}`);
  await act(async () => {
    request.resolve(preview);
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** 링크를 넣고 350ms 기다려 요청이 나가고, 답이 와서 카드가 서기까지. */
async function showCard(url: string, body = url) {
  await type(body);
  await wait(350);
  await answer(url);
}

async function press(testID: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID));
  });
}

/** 화면 트리를 위에서 아래로 훑어 만난 testID 의 순서. */
function testIdOrder(): string[] {
  const order: string[] = [];
  const visit = (node: unknown) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const element = node as {props?: {testID?: string}; children?: unknown};
    if (typeof element.props?.testID === 'string') order.push(element.props.testID);
    visit(element.children);
  };
  visit(screen.toJSON());
  return order;
}

describe('폰 입력창의 링크 미리보기 (#5016) — 채널', () => {
  it('입력이 멈춘 뒤에만 묻고, 이 방의 채널로 묻고, 알약 위에 카드를 그린다', async () => {
    render(composer(CHANNEL_TARGET, jest.fn()));
    await type(`see ${A}`);
    await wait(349);
    expect(asked).toHaveLength(0);
    // 링크가 그대로여도 다음 글자가 기다림을 처음부터 다시 시작한다.
    await type(`see ${A} please`);
    await wait(349);
    expect(asked).toHaveLength(0);
    await wait(1);
    expect(askedUrls()).toEqual([A]);
    expect(ask).toHaveBeenCalledWith(WS, CH, A, expect.any(AbortSignal));
    // 답이 오기 전에는 아무것도 그리지 않는다: 카드가 안 생길 링크가 번쩍이면 안 된다.
    expect(screen.queryByTestId('composer-link-preview')).toBeNull();

    await answer(A);
    expect(cardTitles()).toEqual(['Title of a.example']);
    // 타임라인과 같은 카드(`unfurl-card`)이고, 알약(`composer-pill`) **위**에 선다.
    expect(screen.getByTestId('unfurl-card')).toBeTruthy();
    const order = testIdOrder();
    expect(order.indexOf('composer-link-preview')).toBeGreaterThan(-1);
    expect(order.indexOf('composer-link-preview')).toBeLessThan(order.indexOf('composer-pill'));
    // ✕는 접근 이름이 있는 단추 하나다.
    const dismiss = screen.getByTestId('composer-link-preview-dismiss');
    expect(dismiss.props.accessibilityRole).toBe('button');
    expect(String(dismiss.props.accessibilityLabel)).not.toBe('');
  });

  it('✕로 이번 메시지의 미리보기를 끄고, 그 전송만 억제 필드를 싣는다', async () => {
    const onSend = jest.fn();
    render(composer(CHANNEL_TARGET, onSend));
    await showCard(A);

    await press('composer-link-preview-dismiss');
    expect(screen.queryByTestId('composer-link-preview')).toBeNull();
    // 눌린 ✕가 사라지므로(iOS 에는 live region 이 없다) 결과를 소리로 알린다.
    expect(announce).toHaveBeenCalledTimes(1);
    expect(String(announce.mock.calls[0]?.[0])).not.toBe('');
    // 누름이 보내기를 일으키지 않는다.
    expect(onSend).not.toHaveBeenCalled();

    await press('composer-send');
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[0]).toBe(A);
    expect(onSend.mock.calls[0]?.[1]).toMatchObject({suppressUnfurl: true});

    // 다음 메시지는 처음부터다: 같은 링크의 카드가 다시 서고, 평범하게 나간다(예전과 같은 호출, 옵션 없음).
    await type(A);
    expect(cardTitles()).toEqual(['Title of a.example']);
    await press('composer-send');
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls[1]).toEqual([A]);
  });

  it('링크를 바꾸면 카드가 다시 뜨고, 문장만 고치면 ✕가 그대로다', async () => {
    render(composer(CHANNEL_TARGET, jest.fn()));
    await showCard(A);
    await press('composer-link-preview-dismiss');

    // 문장만 바뀐다: 선택은 그대로다.
    await type(`${A} and some more words`);
    await wait(2000);
    expect(screen.queryByTestId('composer-link-preview')).toBeNull();

    // 다른 링크는 다른 메시지다.
    await type(B);
    await wait(350);
    await answer(B);
    expect(cardTitles()).toEqual(['Title of b.example']);

    // 링크를 지웠다가 눌렀던 링크를 다시 쓰면 처음부터다. 그 링크의 답은 받아 둔 것이라 두 번째 요청 없이 카드가 돌아온다.
    await type('nothing here');
    await type(A);
    expect(cardTitles()).toEqual(['Title of a.example']);
    expect(askedUrls()).toEqual([A, B]);
  });

  it('429에는 조용하다: 카드도 문구도 없고 입력은 계속되며, 보내도 억제 필드가 없다', async () => {
    const onSend = jest.fn();
    render(composer(CHANNEL_TARGET, onSend));
    await type(A);
    await wait(350);
    await act(async () => {
      asked[0]?.reject(new ApiError(429, 'slow down', undefined, 2));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId('composer-link-preview')).toBeNull();
    expect(JSON.stringify(screen.toJSON())).not.toMatch(/slow down|429/);

    // 입력은 막히지 않고, 서버가 기다리라 한 동안은 묻지 않는다.
    await type(`${A} thanks`);
    expect(input().props.value).toBe(`${A} thanks`);
    await wait(1900);
    expect(askedUrls()).toEqual([A]);

    await press('composer-send');
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]).toEqual([`${A} thanks`]);
  });

  it('보낼 방을 모르면(첨부 대상이 없는 하네스) 아무것도 묻지 않는다', async () => {
    render(composer(undefined, jest.fn()));
    await type(`still ${A}`);
    await wait(2000);
    expect(asked).toHaveLength(0);
    expect(screen.queryByTestId('composer-link-preview')).toBeNull();
  });

  it('끄기인 기기는 아무것도 묻지 않고, ✕도 없고, 보낸 글에 억제 필드도 없다', async () => {
    // 카드를 못 그리는 기기는 초안의 링크를 서버로 보내지도, 보이지 않는 카드를 ✕로 끄지도 않는다.
    setLinkPreviewPreference('off');
    const onSend = jest.fn();
    render(composer(CHANNEL_TARGET, onSend));
    await type(`still ${A}`);
    await wait(2000);
    expect(asked).toHaveLength(0);
    expect(screen.queryByTestId('composer-link-preview')).toBeNull();
    await press('composer-send');
    expect(onSend.mock.calls[0]).toEqual([`still ${A}`]);
  });
});

describe('폰 입력창의 링크 미리보기 (#5016) — 스레드', () => {
  it('스레드가 선 채널로 묻고, ✕는 같은 채널의 다른 스레드로 따라가지 않는다', async () => {
    const onSend = jest.fn();
    const view = render(composer(THREAD_TARGET, onSend));
    await showCard(A);
    // 답글은 같은 채널로 나가므로 그 채널에 묻는다.
    expect(asked[0]?.channelId).toBe(CH);

    await press('composer-link-preview-dismiss');
    expect(screen.queryByTestId('composer-link-preview')).toBeNull();

    // 같은 입력창에 다른 스레드가 열려도(글은 그대로) ✕는 새 메시지에 걸리지 않는다: 카드가 돌아오고(주소의 답은
    // 나눠 쓰므로 새 요청 없이), 보내면 평범하게 나간다.
    view.rerender(composer({...THREAD_TARGET, rootId: 'root-2'}, onSend));
    await act(async () => {
      await Promise.resolve();
    });
    expect(cardTitles()).toEqual(['Title of a.example']);
    expect(askedUrls()).toEqual([A]);
    await press('composer-send');
    expect(onSend.mock.calls[0]).toEqual([A]);
  });
});
