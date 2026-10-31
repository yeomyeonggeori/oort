import {buildTimelineItems} from '@momo/core/features/timeline/model';
import {DEFAULT_UNFURL_SIZE} from '@momo/core/features/timeline/unfurl';
import {act, renderHook} from '@testing-library/react-native';
import fs from 'node:fs';
import path from 'node:path';

import {
  isLinkPreviewChoice,
  LINK_PREVIEW_CHOICES,
  linkPreviewPreference,
  setLinkPreviewPreference,
  useLinkPreviewPreference,
} from '../src/features/conversation/linkPreviewPreference';
import {
  createRowViewability,
  messageRowKey,
  RowViewabilityContext,
  useRowSeen,
} from '../src/features/conversation/rowViewability';
import {NON_SECRET_KEYS} from '../src/storage/kv';
import React from 'react';

// =============================================================================
// 「링크 미리보기」 기기 설정(#4883) — 웹과 **같은 값 이름·같은 기본값·같은 저장 방식**이다.
// 그리고 카드의 「줄이 보였는가」 저장소(`rowViewability.ts`): 한 번 보이면 계속 보인 것으로 친다.
// =============================================================================

const mmkv = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;
const KEY = 'momo.mobile.link-preview.v1';

beforeEach(() => mmkv.clear());

describe('값 이름·기본값·저장 키', () => {
  it('저장 키가 정해진 이름이고, 값 이름과 순서가 웹의 것과 같다 — 웹 소스를 읽어 맞댄다', () => {
    expect(NON_SECRET_KEYS.linkPreview).toBe(KEY);
    const web = fs.readFileSync(
      path.join(__dirname, '../../web/src/features/timeline/linkPreviewPreference.ts'),
      'utf8',
    );
    const declared = /LINK_PREVIEW_PREFERENCES\s*=\s*\[([^\]]+)\]/.exec(web)?.[1] ?? '';
    const webChoices = [...declared.matchAll(/"([a-z]+)"/g)].map(found => found[1]);
    expect(webChoices).toEqual(['compact', 'rich', 'off']);
    expect([...LINK_PREVIEW_CHOICES]).toEqual(webChoices);
  });

  it('저장된 값이 없으면 코어의 기본(작게) 한 곳이다 — 폰이 따로 기본을 쥐지 않는다', () => {
    expect(DEFAULT_UNFURL_SIZE).toBe('compact');
    expect(linkPreviewPreference()).toBe(DEFAULT_UNFURL_SIZE);
  });

  it('세 값은 그대로 읽고, 모르는 값(옛 판·손상)은 기본으로 읽되 되쓰지 않는다', () => {
    for (const value of ['compact', 'rich', 'off']) {
      mmkv.set(KEY, value);
      expect(linkPreviewPreference()).toBe(value);
    }
    for (const junk of ['', 'big', 'Rich', 'true', ' rich']) {
      mmkv.set(KEY, junk);
      expect(linkPreviewPreference()).toBe('compact');
      expect(mmkv.get(KEY)).toBe(junk);
      expect(isLinkPreviewChoice(junk)).toBe(false);
    }
    expect(isLinkPreviewChoice(null)).toBe(false);
    expect(isLinkPreviewChoice(undefined)).toBe(false);
  });
});

describe('고르기', () => {
  it('기본을 직접 골라도 저장한다 — 나중에 기본이 바뀌어도 이 기기가 따라 움직이지 않는다', () => {
    expect(mmkv.has(KEY)).toBe(false);
    setLinkPreviewPreference('compact');
    expect(mmkv.get(KEY)).toBe('compact');
  });

  it('모르는 값은 쓰지 않는다', () => {
    setLinkPreviewPreference('rich');
    setLinkPreviewPreference('huge' as never);
    expect(mmkv.get(KEY)).toBe('rich');
  });

  it('구독자는 값이 바뀔 때만 다시 그린다', () => {
    let renders = 0;
    const {result} = renderHook(() => {
      renders += 1;
      return useLinkPreviewPreference();
    });
    expect(result.current).toBe('compact');
    const first = renders;
    act(() => setLinkPreviewPreference('compact'));
    expect(renders).toBe(first);
    act(() => setLinkPreviewPreference('rich'));
    expect(result.current).toBe('rich');
    expect(renders).toBe(first + 1);
    act(() => setLinkPreviewPreference('off'));
    expect(result.current).toBe('off');
  });
});

describe('줄이 한 번이라도 보였는가 (rowViewability)', () => {
  it('목록 항목의 키 모양은 코어가 실제로 만든 메시지 줄의 키와 같다 — 어긋나면 아이콘이 영영 안 켜진다', () => {
    const items = buildTimelineItems([
      {
        id: 'm',
        channelId: 'c',
        seq: 41,
        hlcTs: 1,
        hlcCount: 0,
        authorMemberId: 'a',
        type: 'text',
        body: '글',
        state: 'sent',
        createdAtMs: 1_700_000_000_000,
      },
    ]);
    const message = items.find(item => item.kind === 'message');
    expect(message?.key).toBe(messageRowKey(41));
  });

  it('새로 보인 줄이 있을 때만 구독자를 깨우고, 한 번 보인 줄은 계속 보인 것이다', () => {
    const store = createRowViewability();
    const wake = jest.fn();
    store.subscribe(wake);
    expect(store.seen('m-1')).toBe(false);
    store.update(['m-1', 'm-2']);
    expect(wake).toHaveBeenCalledTimes(1);
    store.update(['m-2']);
    store.update([]);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(store.seen('m-1')).toBe(true);
    expect(store.seen('m-3')).toBe(false);
  });

  it('목록(제공자)이 없으면 보였다고 친다, 있으면 그 줄이 보이기 전까지는 아니다', () => {
    const bare = renderHook(() => useRowSeen('m-9'));
    expect(bare.result.current).toBe(true);

    const store = createRowViewability();
    const wrapper = ({children}: {children: React.ReactNode}) => (
      <RowViewabilityContext.Provider value={store}>{children}</RowViewabilityContext.Provider>
    );
    const inList = renderHook(() => useRowSeen('m-9'), {wrapper});
    expect(inList.result.current).toBe(false);
    act(() => store.update(['m-9']));
    expect(inList.result.current).toBe(true);
  });
});
