import {act, render, screen} from '@testing-library/react-native';
import React from 'react';
import {Text} from 'react-native';

// 훅의 실물은 전역 설정이 null 로 덮어 둔다. 여기서는 실물과 가짜 fetch/빌드로 잰다.
jest.unmock('../src/features/appUpdate/useAppUpdateOffer');
jest.mock('expo-application', () => ({
  nativeBuildVersion: '3035',
  nativeApplicationVersion: '0.1.28',
}));

import {resetIosFeedCacheForTest} from '../src/features/appUpdate/feed';
import {useAppUpdateOffer} from '../src/features/appUpdate/useAppUpdateOffer';

function Probe() {
  const offer = useAppUpdateOffer();
  return <Text testID="probe">{offer ? `${offer.version}|${offer.currentBuild}|${offer.testflight}` : 'none'}</Text>;
}

async function mountWith(body: unknown, ok = true) {
  globalThis.fetch = jest.fn(async () => ({ok, json: async () => body})) as unknown as typeof fetch;
  render(<Probe />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => resetIosFeedCacheForTest());

it('피드가 더 새 빌드를 말하면 제안을 만든다', async () => {
  await mountWith({ios: {latest_build: 3036, version: '0.1.29', testflight: true}});
  expect(screen.getByTestId('probe').props.children).toBe('0.1.29|3035|true');
});

it('같은 빌드면 없다', async () => {
  await mountWith({ios: {latest_build: 3035, version: '0.1.28', testflight: true}});
  expect(screen.getByTestId('probe').props.children).toBe('none');
});

it('읽지 못하면(HTTP 오류) 없다', async () => {
  await mountWith({ios: {latest_build: 9999, version: '9.9.9', testflight: true}}, false);
  expect(screen.getByTestId('probe').props.children).toBe('none');
});
