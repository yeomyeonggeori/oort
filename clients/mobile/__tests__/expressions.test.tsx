import {File} from 'expo-file-system';
import 'react-native-url-polyfill/auto';
import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import {AppState, Dimensions, StyleSheet, Text} from 'react-native';
import * as api from '@momo/core/lib/api';
import * as host from '@momo/core/runtime/host';
import {expressionTransport} from '../src/features/expressions/transport';
import {
  createExpressionFixtureServer,
  type ExpressionFixtureRequest,
  type ExpressionFixtureResponse,
} from '@momo/core/features/expressions/fixtureServer';
import {
  FIXTURE_EXPRESSIONS,
  FIXTURE_LIST,
  FIXTURE_MEMBER_ID,
  FIXTURE_WORKSPACE_ID,
} from '@momo/core/features/expressions/fixtures';
import {PhoneExpressions} from '../src/features/expressions/ExpressionProvider';
import {
  createPhoneExpressionStore,
  type PhoneExpressionStore,
} from '../src/features/expressions/store';
import {TeamExpressionPicker} from '../src/features/expressions/TeamExpressionPicker';
import {ExpressionImage} from '../src/features/expressions/ExpressionImage';
import {MessageBody} from '../src/features/conversation/MessageBody';
import {prepareExpressionBody} from '../src/features/expressions/ExpressionText';
import {pinReduceMotion} from './fixtures/reduceMotion';

const base = `/v1/workspaces/${FIXTURE_WORKSPACE_ID}/expressions`;
const parrot = FIXTURE_EXPRESSIONS[0];
let release: (() => void) | undefined;
const stores: PhoneExpressionStore[] = [];
function setup(
  requestOverride?: (
    request: ExpressionFixtureRequest,
  ) => Promise<ExpressionFixtureResponse>,
) {
  const server = createExpressionFixtureServer();
  const request = jest.fn(
    requestOverride ?? (async input => server.request(input)),
  );
  const files = {
    write: jest.fn(
      (key: string, _bytes: Uint8Array) => `file:///fixture/${key}`,
    ),
    remove: jest.fn(),
  };
  const storage = {read: () => null, write: jest.fn()};
  const store = createPhoneExpressionStore(
    FIXTURE_WORKSPACE_ID,
    FIXTURE_MEMBER_ID,
    {request},
    files,
    storage,
  );
  stores.push(store);
  return {server, request, files, store, storage};
}
function mount(store: PhoneExpressionStore, children: React.ReactNode) {
  return render(
    <PhoneExpressions.Provider value={store}>
      {children}
    </PhoneExpressions.Provider>,
  );
}
beforeEach(async () => {
  release = await pinReduceMotion(true);
  AppState.currentState = 'active';
});
afterEach(async () => {
  await act(async () => {});
  cleanup();
  stores.splice(0).forEach(store => store.dispose());
  release?.();
  release = undefined;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('uses the core fixture through the same transport port and deduplicates private image requests', async () => {
  const {store, files, request} = setup();
  await store.refresh(true);
  expect(store.snapshot().items).toHaveLength(3);
  const [first, second] = await Promise.all([
    store.image(parrot, 'thumb'),
    store.image(parrot, 'thumb'),
  ]);
  expect(first).toBe(second);
  expect(files.write).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenLastCalledWith({
    method: 'GET',
    path: `${base}/${parrot.id}/image?size=thumb&v=${
      parrot.media!.thumb.sha256
    }`,
  });
  expect(
    await store.image({...parrot, id: 'another-tenant'}, 'thumb'),
  ).toBeNull();
});

it('revokes loaded and in-flight images on hide, reconnect and session disposal', async () => {
  let complete!: (value: ExpressionFixtureResponse) => void;
  const server = createExpressionFixtureServer();
  const {store, files} = setup(async input =>
    input.path.includes('size=small')
      ? new Promise(resolve => {
          complete = resolve;
        })
      : server.request(input),
  );
  await store.refresh(true);
  await store.image(parrot, 'thumb');
  const late = store.image(parrot, 'small');
  const response = server.request({
    method: 'GET',
    path: `${base}/${parrot.id}/image?size=small&v=${
      parrot.media!.small.sha256
    }`,
  });
  server.request({
    method: 'POST',
    path: `${base}/${parrot.id}/report`,
    body: {reason: 'other'},
  });
  act(() => store.changed());
  complete(response);
  expect(await late).toBeNull();
  await waitFor(() => expect(store.snapshot().state).toBe('ready'));
  expect(store.snapshot().items.some(item => item.id === parrot.id)).toBe(
    false,
  );
  expect(files.remove).toHaveBeenCalledTimes(1);
  expect(files.write).toHaveBeenCalledTimes(1);
  store.dispose();
  expect(await store.image(FIXTURE_EXPRESSIONS[1], 'thumb')).toBeNull();
});

it('fails closed for malformed/foreign snapshots, errors, and offline, then recovers from the fixture', async () => {
  const {store, request, server} = setup();
  request.mockResolvedValueOnce({
    status: 200,
    json: {...FIXTURE_LIST, workspaceId: 'foreign'},
  });
  await store.refresh(true);
  expect(store.snapshot().state).toBe('error');
  expect(request).toHaveBeenCalledTimes(1);
  await store.refresh(true);
  expect(store.snapshot().state).toBe('ready');
  store.setOnline(false);
  expect(store.snapshot()).toMatchObject({state: 'offline', items: []});
  expect(await store.image(parrot, 'thumb')).toBeNull();
  request.mockResolvedValueOnce({status: 500});
  store.setOnline(true);
  await waitFor(() => expect(store.snapshot().state).toBe('error'));
  request.mockImplementation(async input => server.request(input));
  await store.refresh(true);
  expect(store.snapshot().items).toHaveLength(3);
});

it('records only confirmed receipts once and scopes persisted usage to the member/workspace', async () => {
  const {store, storage} = setup();
  await store.refresh(true);
  expect(storage.write).not.toHaveBeenCalled();
  store.recordSuccess('send:1', ':party_parrot: :party_parrot:');
  store.recordSuccess('send:1', ':party_parrot:');
  expect(store.snapshot().usage?.entries).toEqual([
    {id: parrot.id, count: 1, lastUsedAtMs: expect.any(Number)},
  ]);
  expect(storage.write).toHaveBeenCalledTimes(1);
  storage.write.mockImplementationOnce(() => { throw new Error('disk unavailable'); });
  expect(() => store.recordSuccess('send:2', ':party_parrot:')).not.toThrow();
  expect(store.snapshot().usage?.entries[0].count).toBe(2);
  const other = createPhoneExpressionStore(
    'other-workspace',
    FIXTURE_MEMBER_ID,
    {request: async () => ({status: 500})},
    {write: () => '', remove: () => {}},
    {read: () => store.snapshot().usage, write: () => {}},
  );
  await other.refresh(true);
  expect(other.snapshot().usage?.entries).toEqual([]);
  other.dispose();
});

it('searches Korean initials and presents emoji/sticker/GIF as views over the same items using static thumbnails', async () => {
  const {store, request} = setup();
  await store.refresh(true);
  const onSelect = jest.fn();
  const ui = mount(
    store,
    <TeamExpressionPicker query="ㅍㅌ" onSelect={onSelect} />,
  );
  await screen.findByTestId('expression-pick-party_parrot');
  expect(screen.queryByTestId('expression-pick-ki_jeol')).toBeNull();
  fireEvent.press(screen.getByLabelText('스티커'));
  expect(screen.getByText('파티 앵무새')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('우리 팀 GIF'));
  expect(screen.getByTestId('expression-pick-party_parrot')).toBeTruthy();
  await waitFor(() =>
    expect(
      request.mock.calls.some(([input]) => input.path.includes('size=thumb')),
    ).toBe(true),
  );
  expect(
    request.mock.calls
      .filter(([input]) => input.path.includes('/image?'))
      .every(([input]) => input.path.includes('size=thumb')),
  ).toBe(true);
  fireEvent.press(screen.getByTestId('expression-pick-party_parrot'));
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith(':party_parrot:'));
  ui.unmount();
});

it('shows loading/error/retry/empty/offline states inside the picker', async () => {
  const {store, request} = setup();
  mount(store, <TeamExpressionPicker query="" onSelect={jest.fn()} />);
  expect(screen.getByTestId('expression-loading')).toBeTruthy();
  request.mockResolvedValueOnce({status: 500});
  await act(async () => store.refresh(true));
  expect(screen.getByTestId('expression-error')).toBeTruthy();
  fireEvent.press(screen.getByText('다시 시도'));
  await screen.findByTestId('expression-pick-party_parrot');
  fireEvent.press(screen.getByLabelText('최근'));
  expect(screen.getByTestId('emoji-team-empty')).toBeTruthy();
  act(() => store.setOnline(false));
  expect(screen.getByTestId('expression-offline')).toBeTruthy();
});

it('previews a large send first and refuses confirmation after the fixture deletes the selected item', async () => {
  const {store, server} = setup();
  await store.refresh(true);
  const send = jest.fn();
  mount(
    store,
    <TeamExpressionPicker query="" onSelect={send} mode="message" />,
  );
  fireEvent.press(screen.getByTestId('expression-pick-party_parrot'));
  expect(screen.getByTestId('expression-send-preview')).toBeTruthy();
  expect(send).not.toHaveBeenCalled();
  server.request({method: 'DELETE', path: `${base}/${parrot.id}`});
  fireEvent.press(screen.getByTestId('expression-confirm-send'));
  await screen.findByText('이 표현을 지금 쓸 수 없어요. 다시 골라 주세요.');
  expect(send).not.toHaveBeenCalled();
});

it('confirms an active preview once with only the canonical body token', async () => {
  const {store} = setup();
  await store.refresh(true);
  const send = jest.fn();
  mount(
    store,
    <TeamExpressionPicker query="" onSelect={send} mode="message" />,
  );
  fireEvent.press(screen.getByTestId('expression-pick-party_parrot'));
  fireEvent.press(screen.getByTestId('expression-confirm-send'));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(send).toHaveBeenCalledWith(':party_parrot:');
});

it('uses large/medium/inline sizes, keeps large sends outside bubbles and returns to strings after hide', async () => {
  const {store, server} = setup();
  await store.refresh(true);
  const ui = mount(store, <MessageBody body=":party_parrot:" bubble="mine" />);
  expect(screen.getByTestId('expression-body-large')).toBeTruthy();
  expect(screen.queryByTestId('message-bubble')).toBeNull();
  ui.rerender(
    <PhoneExpressions.Provider value={store}>
      <MessageBody body={':party_parrot: '.repeat(2)} />
    </PhoneExpressions.Provider>,
  );
  expect(screen.getByTestId('expression-body-medium')).toBeTruthy();
  ui.rerender(
    <PhoneExpressions.Provider value={store}>
      <MessageBody body={':party_parrot: '.repeat(7)} />
    </PhoneExpressions.Provider>,
  );
  expect(
    screen.getAllByTestId('expression-image-party_parrot-inline'),
  ).toHaveLength(7);
  server.request({
    method: 'POST',
    path: `${base}/${parrot.id}/report`,
    body: {reason: 'other'},
  });
  await act(async () => store.refresh());
  expect(
    screen.queryAllByTestId('expression-image-party_parrot-inline'),
  ).toHaveLength(0);
  expect(screen.getByText(':party_parrot: '.repeat(7))).toBeTruthy();
});

it('does not replace Markdown code, escaped tokens or URL destinations and never exposes internal markers', async () => {
  const {store} = setup();
  await store.refresh(true);
  const body =
    '글 *:party_parrot:* `:party_parrot:` \\:party_parrot: [링크](https://example.com/:party_parrot:)';
  expect(
    prepareExpressionBody(body, store.snapshot().items).replacements.size,
  ).toBe(1);
  const ui = mount(store, <MessageBody body={body} />);
  expect(
    screen.getAllByTestId('expression-image-party_parrot-inline'),
  ).toHaveLength(1);
  expect(screen.getByTestId('message-inline-code').props.children).toBe(
    ':party_parrot:',
  );
  expect(screen.queryByText(/\uE000/)).toBeNull();
  ui.rerender(
    <PhoneExpressions.Provider value={store}>
      <MessageBody body={'`:party_parrot:``'} />
    </PhoneExpressions.Provider>,
  );
  expect(screen.queryByText(/\uE000/)).toBeNull();
  expect(screen.getByTestId('message-inline-code').props.children).toBe(
    ':party_parrot:',
  );
  await act(async () => {});
});

it('uses thumb for reduced motion/offscreen/grid and stops animated large media after four cycles with tap replay', async () => {
  release?.();
  release = await pinReduceMotion(false);
  jest.useFakeTimers();
  const {store, request} = setup();
  await store.refresh(true);
  const ui = mount(
    store,
    <ExpressionImage expression={parrot} size="large" visible />,
  );
  await act(async () => {});
  const image = screen.getByTestId('expression-image-party_parrot-large');
  expect(image.props.source.uri).toMatch(/gif$/);
  fireEvent(image, 'load');
  await act(async () =>
    jest.advanceTimersByTime(parrot.media!.large.durationMs * 4 - 1),
  );
  expect(
    screen.getByTestId('expression-image-party_parrot-large').props.source.uri,
  ).toMatch(/gif$/);
  await act(async () => jest.advanceTimersByTime(1));
  expect(
    screen.getByTestId('expression-image-party_parrot-large').props.source.uri,
  ).toMatch(/png$/);
  expect(
    request.mock.calls.some(([input]) => input.path.includes('size=large')),
  ).toBe(true);
  expect(
    request.mock.calls.some(([input]) => input.path.includes('size=thumb')),
  ).toBe(true);
  fireEvent.press(screen.getByLabelText('파티 앵무새 · 축하'));
  await act(async () => {});
  expect(
    screen.getByTestId('expression-image-party_parrot-large').props.source.uri,
  ).toMatch(/gif$/);
  ui.rerender(
    <PhoneExpressions.Provider value={store}>
      <ExpressionImage expression={parrot} size="reaction" visible={false} />
    </PhoneExpressions.Provider>,
  );
  await act(async () => {});
  expect(request).toHaveBeenLastCalledWith(
    expect.objectContaining({path: expect.stringContaining('size=thumb')}),
  );
});

it('preserves aspect ratio, reaction size and VoiceOver name, with literal fallback for unavailable media', async () => {
  const {store} = setup();
  await store.refresh(true);
  mount(
    store,
    <Text>
      <ExpressionImage expression={parrot} size="reaction" visible />
    </Text>,
  );
  await waitFor(() =>
    expect(
      screen.getByTestId('expression-image-party_parrot-reaction').props.source
        ?.uri,
    ).toMatch(/^file:/),
  );
  const geometry = StyleSheet.flatten(
    screen.getByTestId('expression-image-party_parrot-reaction').props.style,
  );
  expect(Math.max(geometry.width, geometry.height)).toBe(20);
  expect(screen.getByLabelText('파티 앵무새 · 축하')).toBeTruthy();
  act(() => store.setOnline(false));
  expect(screen.getByText(':party_parrot:')).toBeTruthy();
});

it('uses authenticated live JSON and binary adapters through the fixture-compatible port', async () => {
  const json = jest
    .spyOn(api, 'authedResponse')
    .mockResolvedValue({status: 200, jsonOrNull: () => FIXTURE_LIST} as Awaited<
      ReturnType<typeof api.authedResponse>
    >);
  expect(
    (await expressionTransport.request({method: 'GET', path: base})).json,
  ).toBe(FIXTURE_LIST);
  expect(json).toHaveBeenCalledWith(base, {method: 'GET'});
  const session = host.coreSession();
  jest.spyOn(host, 'coreSession').mockReturnValue({
    ...session,
    getAccessToken: () => 'fixture-access-token',
    getRefreshToken: () => 'fixture-refresh-token',
  });
  jest.spyOn(host, 'apiBase').mockReturnValue('https://fixture.invalid');
  const rotate = jest
    .spyOn(api, 'rotateAfterUnauthorized')
    .mockResolvedValue(true);
  const nativeDownload = jest
    .spyOn(File, 'downloadFileAsync')
    .mockRejectedValueOnce(new Error('HTTP 401'))
    .mockResolvedValueOnce({
      size: 3,
      bytes: async () => Uint8Array.from([1, 2, 3]),
    } as File);
  const path = `${base}/${parrot.id}/image?size=thumb&v=${
    parrot.media!.thumb.sha256
  }`;
  const result = await expressionTransport.request({method: 'GET', path});
  expect(result.bytes).toEqual(Uint8Array.from([1, 2, 3]));
  expect(rotate).toHaveBeenCalledTimes(1);
  expect(nativeDownload).toHaveBeenLastCalledWith(
    `https://fixture.invalid${path}`,
    expect.any(File),
    expect.objectContaining({
      headers: {Authorization: 'Bearer fixture-access-token'},
      idempotent: true,
      signal: expect.any(AbortSignal),
    }),
  );
  await expect(
    expressionTransport.request({
      method: 'GET',
      path: 'https://outside.invalid/image',
    }),
  ).rejects.toThrow('Invalid expression path');
  expect(nativeDownload).toHaveBeenCalledTimes(2);
});

it('cancels pending confirmation when choosing again or closing the picker', async () => {
  const {store, request, server} = setup();
  await store.refresh(true);
  let complete!: () => void;
  request.mockImplementation(async input =>
    input.path.includes('?since=')
      ? new Promise(resolve => {
          complete = () => resolve(server.request(input));
        })
      : server.request(input),
  );
  const send = jest.fn();
  const ui = mount(
    store,
    <TeamExpressionPicker query="" onSelect={send} mode="message" />,
  );
  fireEvent.press(screen.getByTestId('expression-pick-party_parrot'));
  fireEvent.press(screen.getByTestId('expression-confirm-send'));
  fireEvent.press(screen.getByText('다시 고르기'));
  await act(async () => complete());
  expect(send).not.toHaveBeenCalled();
  fireEvent.press(screen.getByTestId('expression-pick-party_parrot'));
  fireEvent.press(screen.getByTestId('expression-confirm-send'));
  ui.unmount();
  await act(async () => complete());
  expect(send).not.toHaveBeenCalled();
});

it('scales inline expressions with large text while preserving the reaction/medium/large limits', async () => {
  const previous = Dimensions.get('window');
  const larger = {...previous, width: 390, height: 844, fontScale: 3};
  act(() => Dimensions.set({window: larger, screen: larger}));
  try {
    const {store} = setup();
    await store.refresh(true);
    mount(
      store,
      <>
        <ExpressionImage expression={parrot} size="inline" visible />
        <ExpressionImage expression={parrot} size="reaction" visible />
        <ExpressionImage expression={parrot} size="medium" visible />
        <ExpressionImage expression={parrot} size="large" visible />
      </>,
    );
    await act(async () => {});
    const maximum = (size: string) => {
      const style = StyleSheet.flatten(
        screen.getByTestId(`expression-image-party_parrot-${size}`).props.style,
      );
      return Math.max(style.width, style.height);
    };
    expect(maximum('inline')).toBe(48);
    expect(maximum('reaction')).toBe(20);
    expect(maximum('medium')).toBe(48);
    expect(maximum('large')).toBe(160);
  } finally {
    cleanup();
    act(() => Dimensions.set({window: previous, screen: previous}));
  }
});
