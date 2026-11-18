import type {BrowseChannel, ChannelBrowseFailure} from '@momo/core/features/channels/browse';
import React from 'react';
import {ChannelBrowseView, type ChannelBrowseViewState} from '../src/screens/ChannelBrowseScreen';

// =============================================================================
// 폰 「채널 둘러보기」 캡처 표면 (#5846, ADR-0224 화면 폰 줄). 배송되는 `ChannelBrowseView` 를 서버 없이 고정 데이터로 세운다
// (훅이 하는 일 — 읽기 · 참여 · 캐시 — 은 `channelBrowse.test.tsx` 가 잰다). 채널 이름은 가상이다.
//
//   xcrun simctl launch <udid> app.momo.ios --args -momoMeasure CHANNELBROWSE-<which>   (라이트: LIGHT-CHANNELBROWSE-<which>)
//
// which: list · empty · empty-admin · loading · error · joining · failed(429 · 404 한 줄씩) · no-match · more
// =============================================================================

const row = (
  id: string,
  name: string,
  memberCount: number,
  extra: Partial<BrowseChannel> = {},
): BrowseChannel => ({id, name, memberCount, isMember: false, isDefault: false, ...extra});

const NOT_JOINED: BrowseChannel[] = [
  row('b-design', '디자인-리뷰', 8, {topic: '주간 시안 리뷰와 피드백'}),
  row('b-launch', '출시-준비', 5, {topic: '다음 판 체크리스트'}),
  row('b-books', '독서-모임', 3),
];
const JOINED: BrowseChannel[] = [
  row('b-general', 'general', 12, {isMember: true, isDefault: true, topic: '팀 전체 공지'}),
  row('b-release', '릴리스', 6, {isMember: true}),
];

const RATE_LIMITED: ChannelBrowseFailure = {kind: 'rateLimited', key: 'channels.browse.rateLimited'};
const GONE: ChannelBrowseFailure = {kind: 'notFound', key: 'channels.browse.joinNotFound'};
const LOAD_NETWORK: ChannelBrowseFailure = {
  kind: 'network',
  key: 'channels.browse.loadNetwork',
  values: {reason: '서버에 닿지 못했어요.'},
};

const NOOP = () => {};
const NONE = new Set<string>();
const NO_FAILURES = new Map<string, ChannelBrowseFailure>();

export function ChannelBrowseSurface({which}: {which: string}): React.JSX.Element {
  const state: ChannelBrowseViewState =
    which === 'loading' ? 'loading' : which === 'error' ? 'error' : 'ready';
  const rows =
    which === 'empty' || which === 'empty-admin'
      ? JOINED
      : which === 'no-match'
        ? []
        : [...NOT_JOINED, ...JOINED];
  return (
    <ChannelBrowseView
      state={state}
      rows={rows}
      typed={which === 'no-match' ? '마케팅' : ''}
      onChangeTyped={NOOP}
      loadFailure={which === 'error' ? LOAD_NETWORK : undefined}
      onRetry={NOOP}
      isAdmin={which === 'empty-admin'}
      offline={false}
      pending={which === 'joining' ? new Set(['b-design']) : NONE}
      failures={
        which === 'failed'
          ? new Map([
              ['b-design', RATE_LIMITED],
              ['b-launch', GONE],
            ])
          : NO_FAILURES
      }
      onJoin={NOOP}
      onOpen={NOOP}
      hasMore={which === 'more'}
      loadingMore={false}
      moreFailed={false}
      onLoadMore={NOOP}
      onClose={NOOP}
    />
  );
}
