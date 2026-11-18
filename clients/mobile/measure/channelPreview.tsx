import {type ChannelPreviewFailure, type PreviewMessage} from '@momo/core/features/channels/browse';
import type {ChannelBrowseFailure} from '@momo/core/features/channels/browse';
import React from 'react';
import {ChannelPreviewView, type ChannelPreviewViewState} from '../src/screens/ChannelPreviewScreen';

// =============================================================================
// 폰 「채널 미리 보기」 캡처 표면 (#5847, ADR-0224 D5). 배송되는 `ChannelPreviewView` 를 서버 없이 고정 데이터로 세운다(읽기 · 참여 ·
// 캐시는 `channelBrowse.test.tsx` 가 잰다). 채널 · 사람 이름은 가상이다.
//
//   xcrun simctl launch <udid> app.momo.ios --args -momoMeasure CHANNELPREVIEW-<which>   (라이트: LIGHT-CHANNELPREVIEW-<which>)
//
// which: list · loading · empty · notfound · error · joining · failed(참여 429)
// =============================================================================

const msg = (
  id: string,
  at: number,
  body: string | undefined,
  extra: Partial<PreviewMessage> = {},
): PreviewMessage => ({
  id,
  ...(body === undefined ? {} : {body}),
  author: {displayName: '김도현', kind: 'human'},
  createdAtMs: at,
  edited: false,
  deleted: false,
  replyCount: 0,
  attachmentNames: [],
  ...extra,
});

const NOW = Date.now();
const MIN = 60_000;
// 읽는 차례(오래된 글이 위).
const MESSAGES: PreviewMessage[] = [
  msg('p1', NOW - 190 * MIN, '이번 주 시안 리뷰는 목요일 오후에 해요. 안건은 스레드에 모아 주세요.', {replyCount: 3}),
  msg('p2', NOW - 150 * MIN, '지난 회의 메모 올려요. https://example.com/notes 에도 같은 내용이 있어요.', {
    author: {displayName: '박서연', kind: 'human'},
    attachmentNames: ['회의록.pdf', '시안-v3.png'],
  }),
  msg('p3', NOW - 120 * MIN, undefined, {deleted: true}),
  msg('p4', NOW - 90 * MIN, '@박서연 확인했어요. 색 대비만 한 번 더 볼게요.', {edited: true}),
  msg('p5', NOW - 40 * MIN, '나간 사람이 남긴 글이에요. 이름은 서버가 빼서 보내요.', {author: {kind: 'human'}}),
  msg('p6', NOW - 5 * MIN, '내일 점심 같이 하실 분? 글이 길어지면 아래로 쭉 이어져서 줄이 접혀요. 큰 글자에서는 더 많이 접혀요.'),
];

// #5961: 열릴 때 위치를 재는 장면 — 글이 3 · 30 · 50개(`few` · `long` · `long50`). 글 번호가 글에 적혀 있어 마지막 글이 보이는지 눈으로도 읽힌다.
const numbered = (count: number): PreviewMessage[] =>
  Array.from({length: count}, (_, index) =>
    msg(`n${index + 1}`, NOW - (count - index) * 4 * MIN, `글 ${index + 1}번 — ${index % 3 === 0 ? '짧은 글이에요.' : '조금 긴 글이에요. 줄이 접히면 높이가 달라져서 열린 뒤에야 줄 높이가 재져요.'}`),
  );

const RATE_LIMITED: ChannelBrowseFailure = {kind: 'rateLimited', key: 'channels.browse.rateLimited'};

export function ChannelPreviewSurface({which}: {which: string}): React.JSX.Element {
  const state: ChannelPreviewViewState =
    which === 'loading' ? 'loading' : which === 'notfound' || which === 'error' ? 'error' : 'ready';
  const loadFailure: ChannelPreviewFailure | undefined =
    which === 'notfound'
      ? {kind: 'notFound', key: 'channels.preview.notFound'}
      : which === 'error'
        ? {kind: 'network', key: 'channels.preview.loadNetwork', values: {reason: '서버에 닿지 못했어요.'}}
        : undefined;
  return (
    <ChannelPreviewView
      state={state}
      name="디자인-리뷰"
      memberCount={8}
      topic="주간 시안 리뷰와 피드백"
      messages={which === 'empty' ? [] : which === 'few' ? numbered(3) : which === 'long' ? numbered(30) : which === 'long50' ? numbered(50) : MESSAGES}
      loadFailure={loadFailure}
      onRetry={() => {}}
      isMember={false}
      pending={which === 'joining'}
      joinFailure={which === 'failed' ? RATE_LIMITED : undefined}
      onJoin={() => {}}
      onOpen={() => {}}
      onClose={() => {}}
    />
  );
}
