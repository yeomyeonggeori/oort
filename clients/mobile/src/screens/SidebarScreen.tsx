import {ApiError, openDirectMessage, uuidEq} from '@momo/core/lib/api';
import {NetworkError} from '@momo/core/lib/http';
import {attachParticle} from '@momo/core/lib/koreanParticle';
import {channelLabel} from '@momo/core/features/workspace/directory';
import {useMutation} from '@tanstack/react-query';
import React, {useCallback, useMemo, useState} from 'react';
import {
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  CountBadge,
  EmptyState,
  ErrorState,
  FailureBanner,
  LoadingState,
  NoticeBlock,
  Screen,
  ScreenHeader,
  SectionLabel,
  TapRow,
} from '../design/atoms';
import {color, font, radius, SAFE_GUTTER, space, TOUCH_TARGET} from '../design/tokens';
import {buildSidebarSections, rowCount, type SidebarRow} from '../features/sidebar/rows';
import {useChannels, useDirectory, useReadStates} from '../features/workspace/queries';
import {useSession} from '../session/useSession';

// =============================================================================
// 대화 — the list of everywhere a person can talk.
//
// Naming, unread counts and grouping all come from
// `src/features/sidebar/rows.ts`, which is pure and tested; this file is the view
// over its answer. The split is what lets "두 김인턴이 한 줄로 보이면 안 된다" be
// an assertion rather than a screenshot review.
//
// ## No list here is reversed (spike #837 gate 5)
//
// On a physical device, a reversed list moved the reader's position by 46–91px
// when a row arrived while they were scrolled back; forward measured 0px. This
// list is forward, and `__tests__/projectShape.test.ts` fails the build if that
// word appears anywhere under `src/` — the guard exists because reaching for it
// is the default instinct when a chat list is next on the page.
//
// ## The search field is synchronous (spike #837 gate 1 case D)
//
// `query` is local state, read straight back into `value`, and filtering is a
// pure synchronous call. Routing it through a query or a debounce timer and back
// is what severed the iOS IME in the spike, and a Korean channel search is
// exactly where that would be discovered by a user rather than by us.
// =============================================================================

export default function SidebarScreen({
  openChannelId,
  onOpenConversation,
  onOpenSearch,
}: {
  openChannelId: string | null;
  onOpenConversation: (channelId: string, title: string) => void;
  /**
   * Open 메시지 검색, optionally carrying what was already typed here.
   *
   * The field on this screen filters channels and people by NAME. When that
   * finds nothing the words are usually something someone SAID, and the two
   * searches are one step apart — so the empty state hands the query over
   * rather than making the person type it again. Web reached the same answer
   * from the other direction (B12 R2: ⌘K falls through to message search
   * carrying `?q=`).
   */
  onOpenSearch: (initialQuery?: string) => void;
}): React.JSX.Element {
  const {member, workspaceId, signOut} = useSession();
  const channelsQuery = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);
  const readStates = useReadStates(workspaceId);

  // Synchronous. See the note above.
  const [query, setQuery] = useState('');

  const agents = useMemo(
    () =>
      directoryQuery.directory.members.filter(
        candidate => candidate.kind === 'agent' && candidate.status === 'active',
      ),
    [directoryQuery.directory],
  );

  const sections = useMemo(
    () =>
      buildSidebarSections({
        groups: channelsQuery.groups,
        agents,
        directory: directoryQuery.directory,
        selfMemberId: member.id,
        unreadByChannel: readStates.byChannel,
        openChannelId,
        query,
      }),
    [
      channelsQuery.groups,
      agents,
      directoryQuery.directory,
      member.id,
      readStates.byChannel,
      openChannelId,
      query,
    ],
  );

  const openDm = useMutation({
    mutationFn: (memberId: string) => openDirectMessage(workspaceId, memberId),
    onSuccess: opened => {
      // The SERVER decides which channel this pair maps to; the response is the
      // authority, and its label is resolved through the core exactly as a row's
      // would be so the header does not read differently from the list.
      onOpenConversation(
        opened.channel.id,
        channelLabel(opened.channel, directoryQuery.directory, member.id),
      );
    },
  });

  const onRowPress = useCallback(
    (row: SidebarRow) => {
      if (row.kind === 'agent') {
        openDm.mutate(row.targetId);
        return;
      }
      onOpenConversation(row.targetId, row.title);
    },
    [openDm, onOpenConversation],
  );

  const total = rowCount(sections);
  const searching = query.trim() !== '';
  const loading = channelsQuery.isLoading || directoryQuery.isLoading;
  // The ROSTER counts as a list failure, not a detail that degrades quietly.
  // Without it every DM falls back to the handle-less "다이렉트 메시지", the
  // 에이전트 section disappears, and the two 김인턴 collapse into one label —
  // which is the exact failure this screen is built around, rendered as if
  // nothing had gone wrong.
  const listFailed = channelsQuery.isError || directoryQuery.isError;
  const listError = channelsQuery.error ?? directoryQuery.error;

  return (
    <Screen>
      <ScreenHeader
        title="대화"
        right={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="메시지 검색"
            onPress={() => onOpenSearch()}
            style={({pressed}) => [styles.headerAction, pressed && styles.pressed]}
            testID="open-message-search">
            <Text style={styles.headerActionLabel}>메시지 찾기</Text>
          </Pressable>
        }
      />

      <View style={styles.searchWrap}>
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder="채널·사람 검색"
          placeholderTextColor={color.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
          accessibilityLabel="채널과 사람 검색"
          testID="sidebar-search"
        />
      </View>

      {/* Unread is server truth, so when the projection fails the badges simply
          are not there. Saying so is cheaper than letting someone conclude they
          have read everything. */}
      {readStates.isError && !listFailed ? (
        <NoticeBlock
          headline="안 읽음 표시를 불러오지 못했습니다."
          detail="목록은 그대로이고, 안 읽은 개수만 지금 알 수 없습니다."
          testID="read-state-error"
        />
      ) : null}

      {openDm.isError ? (
        <View style={styles.bannerWrap}>
          <FailureBanner
            message={openDmFailureCopy(openDm.error)}
            onRetry={() => openDm.reset()}
            testID="open-dm-error"
          />
        </View>
      ) : null}

      {loading ? (
        <LoadingState label="채널 목록을 불러오는 중입니다." testID="channels-loading" />
      ) : listFailed ? (
        <ErrorState
          headline="채널을 불러오지 못했습니다."
          detail={queryFailureDetail(listError)}
          onRetry={() => {
            void channelsQuery.refetch();
            void directoryQuery.refetch();
          }}
          testID="channels-error"
        />
      ) : total === 0 ? (
        searching ? (
          <View>
            <EmptyState
              headline={`'${query.trim()}' 검색 결과가 없습니다.`}
              detail="이름의 일부만 입력해도 찾을 수 있습니다. 이름이 아니라 오간 말을 찾는 중이라면:"
              testID="channels-no-match"
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`'${query.trim()}'로 메시지 검색`}
              onPress={() => onOpenSearch(query)}
              style={({pressed}) => [styles.fallthrough, pressed && styles.pressed]}
              testID="search-messages-instead">
              <Text style={styles.fallthroughLabel}>
                {/* 조사는 골라 붙인다. 레포에 이미 있는 규칙을 쓰고 여기서
                    두 번째 규칙을 세우지 않는다 (B12 R2 High-2). */}
                {`${attachParticle(`'${query.trim()}'`, 'subject')} 오간 메시지 찾기`}
              </Text>
            </Pressable>
          </View>
        ) : (
          <EmptyState
            headline="아직 참여한 채널이 없습니다."
            detail="채널 만들기와 초대는 데스크톱에서 할 수 있습니다."
            testID="channels-empty"
          />
        )
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={row => row.key}
          renderSectionHeader={({section}) => <SectionLabel label={section.label} />}
          renderItem={({item}) => (
            <Row
              row={item}
              // `uuidEq`, not `===`: ids cross the wire in mixed case, and the
              // unread suppression one file over already compares them this way.
              // Two different answers about the same row is how a highlighted
              // row keeps its badge.
              selected={uuidEq(item.targetId, openChannelId ?? undefined)}
              busy={openDm.isPending && openDm.variables === item.targetId}
              onPress={() => onRowPress(item)}
            />
          )}
          stickySectionHeadersEnabled={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={styles.listContent}
          testID="sidebar-list"
        />
      )}

      <AccountFooter
        name={member.displayName}
        handle={member.handle}
        onSignOut={signOut}
      />
    </Screen>
  );
}

function Row({
  row,
  selected,
  busy,
  onPress,
}: {
  row: SidebarRow;
  selected: boolean;
  busy: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <TapRow
      accessibilityLabel={row.accessibilityLabel}
      selected={selected}
      onPress={onPress}
      testID={`sidebar-row-${row.key}`}>
      {row.kind === 'channel' ? (
        <Text style={styles.hash}>#</Text>
      ) : (
        <View style={[styles.dot, row.isAgent && styles.dotAgent]} />
      )}
      <View style={styles.rowText}>
        <View style={styles.rowTitleLine}>
          <Text
            style={[
              styles.rowTitle,
              row.isAgent && styles.rowTitleAgent,
              row.unreadCount > 0 && styles.rowTitleUnread,
            ]}
            numberOfLines={1}
            ellipsizeMode="tail">
            {row.title}
          </Text>
          {row.handle ? (
            <Text style={styles.rowHandle} numberOfLines={1}>
              {row.handle}
            </Text>
          ) : null}
        </View>
        {row.isPrivate || row.muted || row.kind === 'agent' ? (
          <Text style={styles.rowMeta} numberOfLines={1}>
            {[
              row.kind === 'agent' ? '에이전트 · 대화 열기' : null,
              row.isPrivate ? '비공개' : null,
              row.muted ? '알림 꺼짐' : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        ) : null}
      </View>
      {busy ? <Text style={styles.rowMeta}>여는 중…</Text> : null}
      <CountBadge
        count={row.mentionCount}
        tone="mention"
        label={`멘션 ${row.mentionCount}개`}
      />
      <CountBadge
        count={row.unreadCount}
        label={`안 읽은 메시지 ${row.unreadCount}개`}
      />
    </TapRow>
  );
}

/**
 * The account line, and the only place a person can leave.
 *
 * A settings screen is outside v0 (ADR-0137 D5 puts 설정 on the desktop), so this
 * is deliberately one row and not the first plank of one. The confirmation is
 * inline rather than a native alert because signing out is the only irreversible
 * thing in this batch, and because an inline step is assertable in a test.
 */
function AccountFooter({
  name,
  handle,
  onSignOut,
}: {
  name: string;
  handle: string;
  onSignOut: () => void;
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  return (
    <View style={styles.footer}>
      <View style={styles.rowText}>
        <Text style={styles.footerName} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          @{handle}
        </Text>
      </View>
      {confirming ? (
        <View style={styles.confirmRow}>
          <Pressable
            accessibilityRole="button"
            onPress={() => setConfirming(false)}
            style={({pressed}) => [styles.footerButton, pressed && styles.pressed]}
            testID="sign-out-cancel">
            <Text style={styles.footerButtonLabel}>취소</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={onSignOut}
            style={({pressed}) => [
              styles.footerButton,
              styles.footerButtonDanger,
              pressed && styles.pressed,
            ]}
            testID="sign-out-confirm">
            <Text style={styles.footerButtonDangerLabel}>로그아웃</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          onPress={() => setConfirming(true)}
          style={({pressed}) => [styles.footerButton, pressed && styles.pressed]}
          testID="sign-out">
          <Text style={styles.footerButtonLabel}>로그아웃</Text>
        </Pressable>
      )}
    </View>
  );
}

/**
 * Why a DM could not be opened.
 *
 * The core carries per-surface failure copy for the surfaces it owns
 * (`createChannelFailure`, `joinFailureCopy`, `signInFailureCopy`) but has none
 * for `openDirectMessage`. That is a real gap and it is noted in the PR rather
 * than filled by adding to the frozen core in this batch. What is NOT invented
 * here is the transport sentence: `NetworkError.message` is the core's own copy,
 * deadline included, and is passed through rather than paraphrased.
 */
export function openDmFailureCopy(error: unknown): string {
  if (error instanceof NetworkError) return error.message;
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return '이 사람과는 대화를 열 수 없습니다. 워크스페이스 관리자에게 문의하세요.';
    }
    if (error.status === 429) {
      return '요청이 너무 잦습니다. 잠시 뒤에 다시 시도하세요.';
    }
    if (error.status >= 500) {
      return '서버에서 오류가 났습니다. 잠시 뒤에 다시 시도하세요.';
    }
  }
  return '대화를 열지 못했습니다. 잠시 뒤에 다시 시도하세요.';
}

/** The second line under a failed list. Transport copy only; never a raw body. */
export function queryFailureDetail(error: unknown): string | undefined {
  return error instanceof NetworkError ? error.message : undefined;
}

const styles = StyleSheet.create({
  searchWrap: {paddingHorizontal: SAFE_GUTTER, paddingVertical: space.sm},
  search: {
    minHeight: TOUCH_TARGET,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
    paddingHorizontal: space.md,
    fontSize: font.body,
    color: color.text,
  },
  bannerWrap: {paddingHorizontal: SAFE_GUTTER, paddingBottom: space.sm},
  listContent: {paddingBottom: space.lg},
  hash: {
    width: 18,
    textAlign: 'center',
    fontSize: font.body,
    color: color.textFaint,
  },
  dot: {
    width: 10,
    height: 10,
    marginHorizontal: 4,
    borderRadius: radius.pill,
    backgroundColor: color.textFaint,
  },
  dotAgent: {backgroundColor: color.agent},
  rowText: {flex: 1, gap: 2},
  rowTitleLine: {flexDirection: 'row', alignItems: 'center', gap: space.xs},
  rowTitle: {fontSize: font.body, color: color.text, flexShrink: 1},
  rowTitleAgent: {color: color.agent},
  rowTitleUnread: {fontWeight: '700'},
  rowHandle: {fontSize: font.meta, color: color.textFaint, flexShrink: 1},
  rowMeta: {fontSize: font.meta, color: color.textFaint},
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: SAFE_GUTTER,
    paddingVertical: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    backgroundColor: color.bg,
  },
  footerName: {fontSize: font.label, color: color.text, fontWeight: '600'},
  confirmRow: {flexDirection: 'row', gap: space.sm},
  footerButton: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.border,
  },
  footerButtonDanger: {borderColor: color.dangerBorder},
  footerButtonLabel: {fontSize: font.label, color: color.textMuted},
  footerButtonDangerLabel: {fontSize: font.label, color: color.danger, fontWeight: '600'},
  pressed: {backgroundColor: color.surfacePressed},
  headerAction: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: space.sm,
    marginRight: -space.sm,
    borderRadius: radius.sm,
  },
  headerActionLabel: {fontSize: font.label, color: color.accentText, fontWeight: '600'},
  fallthrough: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    marginHorizontal: SAFE_GUTTER,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
    alignSelf: 'flex-start',
  },
  fallthroughLabel: {fontSize: font.label, color: color.accentText, fontWeight: '600'},
});
