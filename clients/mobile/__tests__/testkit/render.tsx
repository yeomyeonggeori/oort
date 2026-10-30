import {createFlush, createMount} from '@momo/core/testkit';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanupAsync, render} from '@testing-library/react-native';
import React from 'react';
import {StyleSheet} from 'react-native';

/**
 * 화면을 올리고 기다리는 길.
 *
 * 쿼리 클라이언트는 시험마다 새로 만들고(캐시가 새어 다음 시험을 오염시키지 않게), 재시도를
 * 끈다(실패가 재시도 뒤에 숨지 않게). `gcTime: 0` 은 시험이 끝났을 때 캐시가 남지 않게 한다.
 * 기존 시험의 `renderShell` 이 열두 곳에서 같은 모양으로 만들던 클라이언트다.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: 0},
      mutations: {retry: false, gcTime: 0},
    },
  });
}

/** `ui` 를 쿼리 클라이언트로 감싸 올린다. 클라이언트도 함께 돌려줘서 시험이 비울 수 있다. */
export function renderWithQuery(
  ui: React.ReactElement,
  client: QueryClient = makeQueryClient(),
) {
  return {client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)};
}

/** 스타일 배열·중첩을 한 객체로 편다. 없으면 빈 객체. */
export const flat = (style: unknown): Record<string, any> =>
  (StyleSheet.flatten(style as never) ?? {}) as Record<string, any>;

/**
 * 가짜 시계(`installAppClock`)에서 `ms` 만큼 흘리고 그 사이 끝난 일을 모두 비운다.
 * 진짜 시계를 쓰는 시험에서는 쓰지 않는다(`flush` 를 쓴다).
 */
export async function settle(ms = 25): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

/** 진짜 시계에서 이미 걸려 있는 약속과 한 번의 타이머 턴을 비운다. */
export const flush = createFlush(async work => { await act(work); });

/** Shared mount ownership; call cleanupMounts in afterEach for this entry point. */
const mounts = createMount(renderWithQuery, result => result.unmount());
export const mount = mounts.mount;
export const cleanupMounts = mounts.cleanup;

// RNTL 의 자동 정리와 똑같이, 시험이 가짜 시계를 켜기 전에 진짜 `setImmediate` 를 집어 둔다.
const realSetImmediate = setImmediate;

/**
 * RNTL 이 모든 시험 뒤에 하는 정리(`afterEach`: 한 턴 비우고 올려 둔 화면을 내린다)를 지금 한다.
 *
 * 왜 따로 있나: 시험 파일을 `describe` 로 감싸 합치면, 감싼 `afterEach` 가 루트에 있는 RNTL 의
 * `afterEach` 보다 **먼저** 돈다(안쪽 훅이 먼저). 원래 파일에서는 RNTL 정리가 먼저 돌고 그 뒤에
 * 파일 자신의 `afterEach` 가 돌았는데, 순서가 뒤집히면 그 훅의 동기 `cleanup()` 이 올려 둔 화면을
 * 기다리지 않고 내려서 다음 시험이 「overlapping act()」 로 깨진다. 정리가 먼저여야 하는 훅은
 * 첫 줄에서 이것을 `await` 한다 — 원래 순서와 같아진다.
 */
export async function drainRender(): Promise<void> {
  await new Promise(resolve => realSetImmediate(resolve));
  await cleanupAsync();
}
