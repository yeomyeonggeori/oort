import type {Channel} from '@momo/core/lib/api';
import {
  channelPreviewFailure,
  previewInReadingOrder,
  type ChannelBrowseFailure,
  type ChannelPreviewFailure,
  type PreviewMessage,
} from '@momo/core/features/channels/browse';
import {DELETED_TOMBSTONE_KEY} from '@momo/core/features/timeline/deletedFold';
import {GONE_MEMBER_LABEL} from '@momo/core/features/workspace/directory';
import React, {useCallback, useMemo, useRef, useState} from 'react';
import {FlatList, StyleSheet, Text, View, type RefreshControlProps} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {
  EmptyState,
  ErrorState,
  LoadingState,
  PrimaryButton,
  Screen,
  Sentence,
} from '../design/atoms';
import {PULL_FILL, usePullRefresh, type PullScrollProps} from '../design/refresh';
import {PageHeader} from '../design/SheetChrome';
import {useStyles} from '../design/theme';
import {font, line, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from '../design/tokens';
import {
  useChannelPreviewQuery,
  useJoinBrowsedChannel,
} from '../features/channelBrowse/useChannelBrowse';
import type {OpenChannelPreview} from '../nav/state';
import {useFormatMessage} from '../i18n/useFormatMessage';
import {useLocaleService} from '../i18n/useLocaleService';
import {useSession} from '../session/useSession';

// =============================================================================
// 폰 「채널 미리 보기」 (ADR-0224 D5 · 화면 폰 줄, #5847). 참여하지 않은 켜진 공개 채널의 최근 글을 **읽기만** 하게 보여 주고, 아래
// 띠의 「참여」 하나로 들어간다. 둘러보기(#5846) 위에 서는 층이다 — 뒤로 한 번이면 둘러보기(목록 · 거르기 칸 그대로).
//
// ## 누를 수 있는 것은 셋뿐이다: 닫기 · 「참여」 · 「다시 시도」
// 입력창 · 반응 · 길게 누르기 메뉴 · 스레드 열기 · 첨부 열기 · 링크 카드 · 멘션 · 링크가 없다. 그래서 대화 화면의 글 그리기 부품
// (`MessageRow` 5천 줄 — 행동 · 인용 · 카드 · 반응을 한 몸에 지닌다, `MessageBody` — 링크 · 멘션이 눌리는 길을 연다)을 다시 쓰지
// **못했다**. 그 부품의 표 값(글자 크기 · 줄 높이 · 묘비 모양 · 「수정됨」 낱말)만 같은 토큰 · 같은 코어 문장으로 읽기 전용 한 줄에
// 다시 그렸다. 글은 평문 그대로다.
//
// ## 열기 · 차례
// 서버는 최신 먼저 준다(`previewInReadingOrder` 로 뒤집는다): 오래된 글이 위, 최신이 아래, 열리면 맨 아래에 선다. 최대 50개에 쪽 나눔이
// 없어 모두 그리고, 내용 · 목록 높이가 재질 때마다 끝 자리를 다시 잡는다(사람이 끌기 전까지 — #5961).
//
// ## 움직이지 않는 것
// 머리(`#이름` · 멤버 수 · 주제)는 둘러보기 줄에서 이미 아는 값을 nav 로 받아 글을 읽기 전에 서 있다. 아래 띠는 네 상태 모두에 같은
// 자리를 지킨다(404 에서는 단추만 빠지고 띠의 높이는 그대로).
// =============================================================================

export default function ChannelPreviewScreen({
  channel,
  onClose,
  onOpenChannel,
}: {
  channel: OpenChannelPreview;
  onClose: () => void;
  /** 참여했거나 이미 든 채널로 간다. 셸이 둘러보기와 이 층을 걷고 그 대화를 연다. */
  onOpenChannel: (channelId: string, title: string) => void;
}): React.JSX.Element {
  const {member, workspaceId} = useSession();
  const query = useChannelPreviewQuery(workspaceId, channel.channelId);
  const onJoined = useCallback(
    (joined: Channel) => onOpenChannel(joined.id, joined.name ?? ''),
    [onOpenChannel],
  );
  const join = useJoinBrowsedChannel(workspaceId, member.id, onJoined);
  const {refreshControl, scrollProps, notice} = usePullRefresh(() => query.refetch(), 'channel-preview-refresh');

  const messages = useMemo(
    () => (query.data ? previewInReadingOrder(query.data.messages) : []),
    [query.data],
  );
  const state: ChannelPreviewViewState = query.isPending
    ? 'loading'
    : query.isError && !query.data
      ? 'error'
      : 'ready';
  const loaded = query.data?.channel;

  return (
    <ChannelPreviewView
      state={state}
      name={channel.name}
      memberCount={loaded?.memberCount ?? channel.memberCount}
      topic={loaded ? loaded.topic : channel.topic}
      messages={messages}
      loadFailure={query.isError ? channelPreviewFailure(query.error) : undefined}
      onRetry={() => void query.refetch()}
      isMember={loaded?.isMember === true}
      pending={join.pending.has(channel.channelId)}
      joinFailure={join.failures.get(channel.channelId)}
      onJoin={() => void join.join(channel.channelId)}
      onOpen={() => onOpenChannel(channel.channelId, channel.name)}
      refreshControl={refreshControl}
      scrollProps={scrollProps}
      notice={notice}
      onClose={onClose}
    />
  );
}

export type ChannelPreviewViewState = 'loading' | 'error' | 'ready';

/** 순수 표현부. 훅 없이 props 로만 그린다 — 측정 장면과 시험이 서버 없이 네 상태를 세운다. */
export function ChannelPreviewView({
  state,
  name,
  memberCount,
  topic,
  messages,
  loadFailure,
  onRetry,
  isMember,
  pending,
  joinFailure,
  onJoin,
  onOpen,
  refreshControl,
  scrollProps,
  notice,
  onClose,
}: {
  state: ChannelPreviewViewState;
  name: string;
  memberCount: number;
  topic?: string;
  /** 읽는 차례(오래된 글이 위). */
  messages: PreviewMessage[];
  loadFailure?: ChannelPreviewFailure;
  onRetry: () => void;
  /** 그 사이 이미 들어 있는 채널이면 「참여」 자리가 「참여 중」(누르면 그 채널로)이 된다. */
  isMember: boolean;
  pending: boolean;
  joinFailure?: ChannelBrowseFailure;
  onJoin: () => void;
  onOpen: () => void;
  /** 당겨서 새로 고침(`usePullRefresh`) — 측정 장면은 주지 않는다. */
  refreshControl?: React.ReactElement<RefreshControlProps>;
  scrollProps?: PullScrollProps;
  notice?: React.ReactNode;
  onClose: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<PreviewMessage>>(null);
  // 열리면 최신 글(맨 아래)에 서고, 사람이 손으로 스크롤한 뒤에는 자리를 건드리지 않는다(#5961). 줄 높이는 그린 뒤에야 재져서
  // 처음 한 번의 scrollToEnd 는 이동이 0이었다 — 그래서 네이티브가 알려 주는 내용 높이 · 목록 높이로 끝 자리를 직접 셈하고,
  // 높이가 바뀔 때마다 사람이 끌기 전까지 그 끝에 다시 선다. 자리를 잡기 전에는 목록을 투명하게 둬서 맨 위가 한 프레임 비치지 않는다.
  const size = useRef({content: 0, layout: 0});
  const userMoved = useRef(false);
  const [placed, setPlaced] = useState(false);
  const stickToEnd = useCallback(() => {
    const {content, layout} = size.current;
    if (userMoved.current || content <= 0 || layout <= 0) return;
    listRef.current?.scrollToOffset({offset: Math.max(0, content - layout), animated: false});
    setPlaced(true);
  }, []);
  const gone = state === 'error' && loadFailure?.kind === 'notFound';
  const meta = [formatMessage('channels.browse.memberCount', {count: memberCount}), topic]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ');

  let body: React.ReactNode;
  if (state === 'loading') {
    body = <LoadingState label={formatMessage('channels.preview.loading')} testID="channel-preview-loading" />;
  } else if (state === 'error') {
    body = (
      <ErrorState
        headline={formatMessage(
          (loadFailure ?? channelPreviewFailure(undefined)).key,
          loadFailure?.values as never,
        )}
        onRetry={gone ? undefined : onRetry}
        testID="channel-preview-error"
      />
    );
  } else if (messages.length === 0) {
    body = (
      <EmptyState
        headline={formatMessage('channels.preview.empty')}
        refreshControl={refreshControl}
        scrollProps={scrollProps}
        testID="channel-preview-empty"
      />
    );
  } else {
    body = (
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={message => message.id}
        renderItem={({item}) => <PreviewRow message={item} />}
        // 최대 50개라 모두 그린다 — 내용 높이가 곧 실제 높이다.
        initialNumToRender={50}
        onLayout={event => {
          size.current.layout = event.nativeEvent.layout.height;
          stickToEnd();
        }}
        onContentSizeChange={(_width, height) => {
          size.current.content = height;
          stickToEnd();
        }}
        onScrollBeginDrag={() => {
          userMoved.current = true;
        }}
        style={placed ? undefined : styles.unplaced}
        refreshControl={refreshControl}
        {...scrollProps}
        contentContainerStyle={[styles.list, PULL_FILL]}
        testID="channel-preview-list"
      />
    );
  }

  const joinSentence = joinFailure
    ? formatMessage(joinFailure.key, joinFailure.values as never)
    : undefined;

  return (
    <Screen>
      <PageHeader
        title={`#${name}`}
        closeLabel={formatMessage('channels.preview.closeAria')}
        onClose={onClose}
        closeTestID="channel-preview-close"
        titleTestID="channel-preview-title"
      />
      <View style={styles.sub}>
        <Sentence style={styles.subText} numberOfLines={1} testID="channel-preview-meta">
          {meta}
        </Sentence>
      </View>
      {notice}
      <View style={styles.body} testID={`channel-preview-body-${state}`}>
        {body}
      </View>
      <View style={[styles.bar, {paddingBottom: Math.max(insets.bottom, space.md)}]} testID="channel-preview-bar">
        {joinSentence ? (
          <Sentence style={styles.barError} accessibilityLiveRegion="polite" testID="channel-preview-join-error">
            {joinSentence}
          </Sentence>
        ) : null}
        <View style={styles.barSlot}>
          {gone ? null : isMember ? (
            <PrimaryButton
              label={formatMessage('channels.browse.joined')}
              accessibilityLabel={formatMessage('channels.browse.openAria', {name})}
              onPress={onOpen}
              testID="channel-preview-open"
            />
          ) : (
            <PrimaryButton
              label={formatMessage(joinFailure && joinFailure.kind !== 'notFound' ? 'channels.browse.retry' : 'channels.browse.join')}
              accessibilityLabel={formatMessage('channels.browse.joinAria', {name})}
              busy={pending}
              busyLabel={formatMessage('channels.browse.joining')}
              onPress={onJoin}
              testID="channel-preview-join"
            />
          )}
        </View>
      </View>
    </Screen>
  );
}

/** 오늘이면 시각만, 아니면 날짜와 시각(대화 화면의 시각 문장과 같은 언어 서비스). */
function useStamp(): (ms: number) => string {
  const locale = useLocaleService();
  return useCallback(
    (ms: number) => {
      const time = locale.formatTime(ms);
      return locale.formatDate(ms) === locale.formatDate(Date.now())
        ? time
        : `${locale.formatDate(ms)} ${time}`;
    },
    [locale],
  );
}

/** 읽기 전용 글 한 줄. 눌리는 것이 없고, 낭독은 한 덩어리(글쓴이 · 시각 · 본문 · 첨부 · 답글)다. */
export function PreviewRow({message}: {message: PreviewMessage}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const stamp = useStamp();
  const author = message.author.displayName ?? GONE_MEMBER_LABEL;
  const time = stamp(message.createdAtMs);
  const edited = message.edited && !message.deleted ? formatMessage('timeline.edited.mark') : undefined;
  const locked = message.attachmentNames.length > 0 ? formatMessage('channels.preview.attachmentLocked') : undefined;
  const replies = message.replyCount > 0 ? formatMessage('timeline.thread.replyCount', {count: message.replyCount}) : undefined;
  const text = message.deleted ? formatMessage(DELETED_TOMBSTONE_KEY) : (message.body ?? '').trim();
  const spoken = [author, time, edited, text, ...message.attachmentNames, locked, replies]
    .filter(Boolean)
    .join(', ');

  return (
    <View style={styles.msg} accessible accessibilityLabel={spoken} testID={`channel-preview-message-${message.id}`}>
      <View style={styles.msgHead}>
        <Text style={styles.author} numberOfLines={1}>
          {author}
        </Text>
        <Text style={styles.time}>{time}</Text>
      </View>
      {message.deleted ? (
        <Text style={styles.tombstone} testID="tombstone">
          {text}
        </Text>
      ) : (
        <Sentence style={styles.bodyText}>{text}</Sentence>
      )}
      {edited ? <Text style={styles.tail}>{edited}</Text> : null}
      {message.attachmentNames.map((fileName, index) => (
        <Text key={`${index}-${fileName}`} style={styles.file} numberOfLines={1}>
          {fileName}
        </Text>
      ))}
      {locked ? <Sentence style={styles.tail}>{locked}</Sentence> : null}
      {replies ? <Text style={styles.tail}>{replies}</Text> : null}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    sub: {paddingHorizontal: SAFE_GUTTER, paddingBottom: space.sm},
    subText: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted, textAlign: 'center'},
    body: {flex: 1},
    unplaced: {opacity: 0},
    list: {paddingHorizontal: SAFE_GUTTER, paddingVertical: space.md, gap: space.md},
    msg: {gap: space.xs / 2},
    msgHead: {flexDirection: 'row', alignItems: 'baseline', gap: space.sm},
    author: {flexShrink: 1, fontSize: font.body, lineHeight: line.body, fontWeight: '600', color: color.text},
    time: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    bodyText: {fontSize: font.body, lineHeight: line.body, color: color.text},
    tombstone: {fontSize: font.label, color: color.textMuted, lineHeight: line.label},
    tail: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    file: {fontSize: font.label, lineHeight: line.label, color: color.text},
    bar: {
      paddingHorizontal: SAFE_GUTTER,
      paddingTop: space.sm,
      gap: space.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: color.border,
    },
    barSlot: {minHeight: TOUCH_TARGET, justifyContent: 'center'},
    barError: {fontSize: font.meta, lineHeight: line.meta, color: color.danger},
  });
