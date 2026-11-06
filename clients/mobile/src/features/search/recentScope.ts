import {channelLabel, type Directory} from '@momo/core/features/workspace/directory';
import {uuidEq, type Channel} from '@momo/core/lib/api';

// =============================================================================
// 최근 검색 줄의 범위 칩 (#5384) — 줄이 들고 있는 대화 id 를 사람이 읽는 이름과 글리프로 푼다.
//
// 최근 검색은 홈 검색과 대화 안 검색이 **한 목록**이다(`searchRecents`). 범위가 있는 줄(한 대화 안에서 찾은 말)은 두 화면 모두 그 대화를 범위 칩으로 보여 준다. 저장은 id 만 든다 —
// 이름이 바뀌거나 나간 대화가 낡은 글자로 남지 않게 보여 줄 때 내가 든 목록에서 푼다(`searchRecents` 의 「최근 연 대화」와 같은 규율).
//
// 내가 든 목록에 없는 대화(나갔거나 닫아 둔 DM)는 `null` 이다: 줄은 범위 없는 말로 서고 칩이 없다 — 이름을 지어내지도, 못 찾을 범위를 되살리지도 않는다
// (「대화 고르기」 시트가 같은 목록에서 고르므로 그곳에 없는 대화는 범위로 쓸 수 없는 대화다).
// =============================================================================

export interface RecentScope {
  channelId: string;
  /** 칩에 적는 이름. 채널은 채널 이름, DM 은 상대 이름이다. */
  title: string;
  /** 공개 채널 `false`(#)·비공개 `true`(자물쇠)·DM `null`(글리프 없음). */
  isPrivate: boolean | null;
}

export function recentScopeOf(
  groups: {channels: readonly Channel[]; dms: readonly Channel[]},
  directory: Directory,
  selfMemberId: string,
  channelId: string,
  fallbackTitle: string,
): RecentScope | null {
  const channel = [...groups.channels, ...groups.dms].find(candidate => uuidEq(candidate.id, channelId));
  if (channel === undefined) return null;
  if (channel.kind === 'dm') {
    return {channelId: channel.id, title: channelLabel(channel, directory, selfMemberId), isPrivate: null};
  }
  return {
    channelId: channel.id,
    title: channel.name ?? fallbackTitle,
    isPrivate: channel.kind === 'private',
  };
}
