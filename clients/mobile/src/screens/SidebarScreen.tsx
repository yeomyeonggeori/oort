import {ApiError, openDirectMessage, uuidEq} from '@momo/core/lib/api';
import {NetworkError} from '@momo/core/lib/http';
import {attachParticle} from '@momo/core/lib/koreanParticle';
import {serverSurface} from '@momo/core/features/capabilities/serverSurfaces';
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
import {useRefreshControl} from '../design/refresh';
import {AVATAR_SIZE} from '@momo/core/features/workspace/avatar';
import {type Directory} from '@momo/core/features/workspace/directory';
import {font, radius, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from '../design/tokens';
import {usePalette, useStyles} from '../design/theme';
import {
  buildSidebarSections,
  CHANNEL_LIST_FAILED,
  rowCount,
  type SidebarRow,
} from '../features/sidebar/rows';
import {useChannels, useDirectory, useReadStates} from '../features/workspace/queries';
import {Avatar} from '../features/conversation/Avatar';
import {ProfileSheet} from '../features/profile/ProfileSheet';
import {useRealtime} from '../realtime/RealtimeProvider';
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
//
// ## 그 목적지의 이름은 하나다 (이슈 #1146 N4)
//
// 이 화면이 여는 곳은 「메시지 검색」이고, 그것은 도착한 화면이 자기 제목으로
// 쓰는 말이자 코어의 표면 판정표가 「사용자가 이 표면을 부르는 이름」으로 들고
// 있는 말이다. 1차의 이 화면은 그 문을 **눈에는 「메시지 찾기」로, 귀에는
// 「메시지 검색」으로** 내놓았다 — 한 컨트롤이 이름을 둘 가진 것이고, 화면을
// 되짚어 볼 수 없는 사람에게는 자기가 들은 것이 화면에 없다. 웹의 사이드바가
// 같은 자리에서 「검색」이라고 적어 셋째 이름을 만들고 있었고, 그래서 이름은
// 세 표면 모두 코어의 그 한 줄에서 받아 온다.
// =============================================================================

/** 이 화면이 여는 목적지의 이름. 눈과 귀가 같은 말을 듣는다 (이슈 #1146 N4). */
const SEARCH_SURFACE_NAME = serverSurface('messageSearch').label;

/**
 * 이름으로 못 찾았을 때 같은 문으로 넘겨주는 줄.
 *
 * 조사는 골라 붙인다 — 레포에 이미 있는 규칙을 쓰고 여기서 두 번째 규칙을
 * 세우지 않는다 (B12 R2 High-2). 한 문자열인 것은 눈과 귀가 갈리지 않게 하기
 * 위해서다.
 */
function fallthroughLabel(query: string): string {
  const quoted = `'${query.trim()}'`;
  return `${attachParticle(quoted, 'subject')} 오간 ${SEARCH_SURFACE_NAME}`;
}

/**
 * 이 화면의 머리에 서는 문 — 언제나 열려 있는 쪽.
 *
 * 자기 컴포넌트인 것은 **사진을 찍기 위해서**다(`measure/surfaces.tsx`). 이
 * 화면 전체는 세션·질의 클라이언트·명부를 세워야 뜨는데, 리뷰가 봐야 하는 것은
 * 그 셋이 아니라 이 컨트롤이 무슨 낱말을 어느 폭으로 내놓는가다. 목업을 그리지
 * 않는 것이 하네스의 규칙이므로, 찍히는 것은 배송되는 바로 이 컴포넌트다.
 */
export function SearchEntryAction({
  onPress,
}: {
  onPress: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Pressable
      accessibilityRole="button"
      // 라벨과 글자가 같은 문자열이다: 하나를 듣고 하나를 보는 사람에게
      // 이름이 둘이면 컨트롤도 둘이다 (고정 목록 버튼과 같은 규칙).
      accessibilityLabel={SEARCH_SURFACE_NAME}
      onPress={onPress}
      style={({pressed}) => [styles.headerAction, pressed && styles.pressed]}
      testID="open-message-search">
      <Text style={styles.headerActionLabel}>{SEARCH_SURFACE_NAME}</Text>
    </Pressable>
  );
}

/**
 * 이름으로 못 찾은 사람에게 열리는 두 번째 문.
 *
 * 1차는 눈에 「…가 오간 메시지 찾기」, 귀에 「…로 메시지 검색」을 주었다 — 이름이
 * 갈렸을 뿐 아니라 조사도 손으로 적혀 있어서, 「두 번째 규칙을 세우지 않는다」가
 * 보이는 글자에만 지켜지고 낭독 라벨에서는 깨져 있었다. 이제 한 문자열이다.
 */
export function SearchFallthrough({
  query,
  onPress,
}: {
  query: string;
  onPress: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const label = fallthroughLabel(query);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({pressed}) => [styles.fallthrough, pressed && styles.pressed]}
      testID="search-messages-instead">
      <Text style={styles.fallthroughLabel}>{label}</Text>
    </Pressable>
  );
}

/**
 * 머리 오른쪽의 내 얼굴 — 내 프로필 시트를 여는 문 (#2702).
 *
 * Buzz·Slack 모바일이 같은 자리에 둔다: 계정은 매일 보는 목록의 발치가 아니라
 * 머리 한구석에 작게 있고, 누르면 그 안에서 테마·알림·로그아웃이 열린다.
 *
 * 얼굴 자체(`Avatar`)는 보조기술에서 숨는다 — 그래서 이 버튼이 라벨을 **직접**
 * 진다. 라벨이 없으면 VoiceOver 는 이름 없는 버튼 하나를 읽는다.
 */
export function ProfileAvatarButton({
  directory,
  memberId,
  name,
  onPress,
}: {
  directory: Directory;
  memberId: string;
  name: string;
  onPress: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`내 프로필, ${name}`}
      accessibilityHint="테마·알림·로그아웃을 엽니다."
      onPress={onPress}
      style={({pressed}) => [styles.avatarButton, pressed && styles.avatarPressed]}
      testID="profile-avatar">
      <Avatar directory={directory} memberId={memberId} />
    </Pressable>
  );
}

export default function SidebarScreen({
  openChannelId,
  onOpenConversation,
  onOpenSearch,
  notificationNotice = null,
  onDismissNotificationNotice,
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
  /**
   * 알림을 눌렀는데 그 대화로 갈 수 없었던 이유, 한 문장 (#2569).
   *
   * 이 목록에 서는 이유는 이곳이 그 대화가 **있었어야 할 자리**이기 때문이다.
   * 셸이 탭을 판정하고 이 화면은 그 문장을 그릴 뿐이다.
   */
  notificationNotice?: string | null;
  onDismissNotificationNotice?: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const {member, workspaceId, signOut} = useSession();
  const realtime = useRealtime();
  const [profileOpen, setProfileOpen] = useState(false);
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

  // 당겨서 새로고침 (goal RN-B4b / #1026). 채널·명부·읽음 상태 — 이 목록이 그리는
  // 세 가지 전부다. 안 읽음 배지만 30초 폴링을 갖고 있는데(`useReadStates`), 당긴
  // 사람이 기다리는 것은 그 30초가 아니라 지금이다.
  //
  // 재조회 함수만 따로 집는 이유는 `useInbox` 의 같은 주석과 같다: 이 훅들이
  // 돌려주는 객체는 `{...query, …}` 라 렌더마다 새 신원이고, `refetch` 는 아니다.
  const refetchChannels = channelsQuery.refetch;
  const refetchDirectory = directoryQuery.refetch;
  const refetchReadStates = readStates.refetch;
  const refreshControl = useRefreshControl(
    useCallback(
      () =>
        Promise.all([
          refetchChannels(),
          refetchDirectory(),
          refetchReadStates(),
        ]),
      [refetchChannels, refetchDirectory, refetchReadStates],
    ),
    'sidebar-refresh',
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
          <View style={styles.headerActions}>
            <SearchEntryAction onPress={() => onOpenSearch()} />
            <ProfileAvatarButton
              directory={directoryQuery.directory}
              memberId={member.id}
              name={member.displayName}
              onPress={() => setProfileOpen(true)}
            />
          </View>
        }
      />

      <View style={styles.searchWrap}>
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder="채널·사람 검색"
          placeholderTextColor={palette.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
          accessibilityLabel="채널과 사람 검색"
          testID="sidebar-search"
        />
      </View>

      {/* 알림 탭의 영수증 (#2569). 방금 한 행동에 대한 답이라 닫을 수 있고,
          다른 고지보다 위에 선다 — 사람이 이 화면에 온 이유가 이것이다. */}
      {notificationNotice ? (
        <NoticeBlock
          headline={notificationNotice}
          onDismiss={onDismissNotificationNotice}
          testID="notification-tap-notice"
        />
      ) : null}

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
            // 「다시 시도」가 실제로 다시 시도한다. 이전 판은 `reset()`이라
            // 배너만 사라졌고, 라벨이 하지 않는 일을 약속했다 (goal RN-A1
            // R1 High-3 — 그 리뷰가 이 자리를 선례로 지목했다). `variables`는
            // 마지막으로 누른 멤버 id다.
            onRetry={
              openDm.variables === undefined
                ? undefined
                : () => openDm.mutate(openDm.variables as string)
            }
            testID="open-dm-error"
          />
        </View>
      ) : null}

      {loading ? (
        <LoadingState label="채널 목록을 불러오는 중입니다." testID="channels-loading" />
      ) : listFailed ? (
        <ErrorState
          headline={CHANNEL_LIST_FAILED}
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
            {/* 같은 문이므로 같은 이름을 쓴다 (이슈 #1146 N4). */}
            <SearchFallthrough
              query={query}
              onPress={() => onOpenSearch(query)}
            />
          </View>
        ) : (
          <EmptyState
            headline="아직 참여한 채널이 없습니다."
            // 채널 범위의 행위는 「추가」다 (#1573 예약 · #1584). 「초대」는
            // 워크스페이스에 새 사람을 부르는 낱말이고, 이 문장이 가리키는
            // 데스크톱의 문은 「멤버 추가」 다이얼로그다.
            detail="채널 만들기와 멤버 추가는 데스크톱에서 할 수 있습니다."
            refreshControl={refreshControl}
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
          refreshControl={refreshControl}
          testID="sidebar-list"
        />
      )}

      {profileOpen ? (
        <ProfileSheet
          member={member}
          directory={directoryQuery.directory}
          connected={realtime.status === 'connected'}
          onSignOut={signOut}
          onClose={() => setProfileOpen(false)}
        />
      ) : null}
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
  const styles = useStyles(buildStyles);
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

const buildStyles = (color: Palette) => StyleSheet.create({
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
  pressed: {backgroundColor: color.surfacePressed},
  headerActions: {flexDirection: 'row', alignItems: 'center', gap: space.xs},
  headerAction: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
  },
  // 44 상자 안의 32 얼굴. 오른쪽으로 남는 6 을 거둬 얼굴의 가장자리가 목록의
  // 거터(`SAFE_GUTTER`)에 맞선다 — 검색 글자가 전에 `-space.sm` 로 하던 일이다.
  avatarButton: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: -(TOUCH_TARGET - AVATAR_SIZE) / 2,
    borderRadius: radius.pill,
  },
  avatarPressed: {opacity: 0.6},
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
