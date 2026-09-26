import {ApiError, openDirectMessage, uuidEq} from '@momo/core/lib/api';
import {NetworkError} from '@momo/core/lib/http';
import {attachParticle} from '@momo/core/lib/koreanParticle';
import {serverSurface} from '@momo/core/features/capabilities/serverSurfaces';
import {channelLabel} from '@momo/core/features/workspace/directory';
import {TURN_STALE_SENTENCE} from '@momo/core/features/agents/turnCopy';
import {coreSession} from '@momo/core/runtime/host';
import {useMutation} from '@tanstack/react-query';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  BAR_CONTROL_MAX_SCALE,
  EmptyState,
  ErrorState,
  Sentence,
  FailureBanner,
  LoadingState,
  NoticeBlock,
  Screen,
} from '../design/atoms';
import {GlassSurface} from '../design/glass';
import {HOME_ICONS, HOME_ICON_SIZE, type HomeIconName} from '../design/icons';
import {useRefreshControl} from '../design/refresh';
import {type Directory} from '@momo/core/features/workspace/directory';
import {
  ds2Radius,
  ds2Type,
  font,
  radius,
  SAFE_GUTTER,
  slopTo,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../design/tokens';
import {usePalette, useStyles} from '../design/theme';
import {useAgentWorkingSignals} from '../features/agents/workingSignal';
import {useCollapsedSections, visibleRows} from '../features/home/collapsedSections';
import {buildWorkingCard, type WorkingCardModel} from '../features/home/workingCard';
import {workspaceHeading, type WorkspaceLogo} from '../features/home/workspaceLogo';
import {
  buildSidebarSections,
  CHANNEL_LIST_FAILED,
  rowCount,
  type SidebarRow,
  type SidebarSection,
} from '../features/sidebar/rows';
import {
  useChannels,
  useDirectory,
  useReadStates,
  useWorkspaceIdentity,
} from '../features/workspace/queries';
import {Avatar} from '../features/conversation/Avatar';
import {ProfileSheet} from '../features/profile/ProfileSheet';
import {useReduceMotion} from '../lib/useReduceMotion';
import {useTabBarClearance} from '../shell/ShellChrome';
import {useRealtime} from '../realtime/RealtimeProvider';
import {useSession} from '../session/useSession';
import {apiBase} from '../storage/serverBase';

/** 브랜드 배지(코메토 K6, `docs/brand/kometto`)를 44 원으로 오려 낸 판. */
const BRAND_BADGE = require('../design/brand/kometto-badge.png');

// =============================================================================
// 홈 — 시안 A `#a-home` (DS2-3 #2715, ADR-0189 D1).
//
// 머리(워크스페이스 로고 자리 · 큰 제목 30/800 · 내 아바타), 「작업 중」 에이전트
// 카드, 섹션 목록(채널 · DM), 섹션 사이 구분선. 에이전트 탭은 없어졌고 그 내용은
// 카드와 DM 섹션(에이전트는 둥근 사각)으로 들어왔다. 시안 CSS 값은 아래 `HOME` 에
// 줄마다 원문과 함께 있다.
//
// 아래는 이 화면이 「대화」 목록이던 때부터의 규칙이고, 전부 그대로 산다.
//
// ## The list of everywhere a person can talk
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
      <Text
        style={styles.headerActionLabel}
        maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
        {SEARCH_SURFACE_NAME}
      </Text>
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
      {/* 사진 없는 이니셜 얼굴은 바탕 위 1.07:1 이다 — 이 앱의 계정 문이 이것
          하나이므로 3:1 을 넘는 가장자리(`textFaint`)를 두른다 (리뷰 M1). */}
      <View style={styles.avatarRing}>
        <Avatar directory={directory} memberId={memberId} size={HOME.selfFace} />
      </View>
    </Pressable>
  );
}

export default function SidebarScreen({
  openChannelId,
  onOpenConversation,
  onOpenSearch,
  onOpenAgentList,
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
   * 에이전트 목록 층을 연다 (ADR-0189 D1 — 에이전트 탭이 홈으로 흡수된 뒤의 문).
   * 작업 중인 에이전트가 없을 때의 한 줄과 DM 섹션 메뉴가 부른다. 셸 밖(하네스)
   * 에서는 없을 수 있고, 그때 그 문들은 서지 않는다.
   */
  onOpenAgentList?: () => void;
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
  // 셸 안의 탭이면 바닥 위에 투명하게 서고, 목록 끝을 탭바만큼 비운다(ADR-0189 D1).
  const clearance = useTabBarClearance();
  const channelsQuery = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);
  const readStates = useReadStates(workspaceId);
  const identity = useWorkspaceIdentity(workspaceId);
  const heading = workspaceHeading(identity);
  const {collapsed, toggle} = useCollapsedSections(workspaceId);

  // Synchronous. See the note above.
  const [query, setQuery] = useState('');
  // 이름 찾기 칸은 시안에 없다 — 섹션 메뉴의 「이름으로 찾기」가 연다. 글자가 남아
  // 있는 동안은 닫히지 않는다: 걸러진 목록 위에서 그 이유가 사라지면 안 된다.
  const [filterOpen, setFilterOpen] = useState(false);
  const filterVisible = filterOpen || query !== '';

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

  // ---- 「작업 중」 카드 (시안 A `.a-now`) -------------------------------------
  // 시계는 두지 않는다 — 카드는 경과 숫자를 그리지 않고, 스토어가 발행·해제마다
  // 다시 그리게 하며, 90초가 지난 턴은 레일의 15초 청소가 지운다(에이전트 목록과
  // 같은 거래, `AgentsScreen` 의 주석). 렌더 때의 벽시계가 TTL 을 한 번 더 건다.
  const signals = useAgentWorkingSignals();
  const railLive = realtime.status === 'connected';
  const allChannels = useMemo(
    () => [...channelsQuery.groups.channels, ...channelsQuery.groups.dms],
    [channelsQuery.groups],
  );
  const card = buildWorkingCard({
    signals,
    nowMs: Date.now(),
    directory: directoryQuery.directory,
    channels: allChannels,
    selfMemberId: member.id,
    live: railLive,
  });

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

  // 섹션 머리의 ⋯ (시안 `.a-sec-h .ctl`). 장식이 아니라 문이다: 헤더에서 내려온
  // 두 검색(이름·메시지)과, DM 섹션에서는 에이전트 목록으로 간다.
  const openSectionMenu = useCallback(
    (section: SidebarSection) => {
      const items: {label: string; run: () => void}[] = [
        {label: FILTER_ACTION, run: () => setFilterOpen(true)},
      ];
      if (section.key === 'channels') {
        items.push({label: SEARCH_SURFACE_NAME, run: () => onOpenSearch()});
      } else if (onOpenAgentList) {
        items.push({label: AGENT_LIST_ACTION, run: onOpenAgentList});
      }
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: `${section.label} 섹션`,
          options: [...items.map(item => item.label), '취소'],
          cancelButtonIndex: items.length,
        },
        index => items[index]?.run(),
      );
    },
    [onOpenAgentList, onOpenSearch],
  );

  const shownSections = useMemo(
    () =>
      sections.map(section => ({
        ...section,
        data: visibleRows(section, collapsed.has(section.key), row =>
          uuidEq(row.targetId, openChannelId ?? undefined),
        ),
      })),
    [sections, collapsed, openChannelId],
  );

  const total = rowCount(sections);
  const searching = query.trim() !== '';
  const loading = channelsQuery.isLoading || directoryQuery.isLoading;
  // The ROSTER counts as a list failure, not a detail that degrades quietly.
  // Without it every DM falls back to the handle-less "다이렉트 메시지", the
  // agents disappear from the DM section, and the two 김인턴 collapse into one
  // label — which is the exact failure this screen is built around, rendered as
  // if nothing had gone wrong.
  const listFailed = channelsQuery.isError || directoryQuery.isError;
  const listError = channelsQuery.error ?? directoryQuery.error;

  const filterField = filterVisible ? (
    <View style={styles.filterWrap}>
      <TextInput
        style={styles.filter}
        value={query}
        onChangeText={setQuery}
        placeholder="채널·사람 이름"
        placeholderTextColor={palette.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={filterOpen && query === ''}
        returnKeyType="search"
        clearButtonMode="while-editing"
        onBlur={() => {
          if (query === '') setFilterOpen(false);
        }}
        accessibilityLabel="채널과 사람 이름으로 찾기"
        testID="sidebar-search"
      />
    </View>
  ) : null;

  const notices = (
    <>
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
    </>
  );

  return (
    <Screen onCanvas={clearance > 0}>
      <View style={styles.top}>
        <WorkspaceLogoSlot logo={heading.logo} />
        <Text
          accessibilityRole="header"
          accessibilityLabel={heading.accessibilityLabel}
          style={styles.largeTitle}
          numberOfLines={1}
          ellipsizeMode="tail"
          maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
          testID="home-title">
          {heading.title}
        </Text>
        <ProfileAvatarButton
          directory={directoryQuery.directory}
          memberId={member.id}
          name={member.displayName}
          onPress={() => setProfileOpen(true)}
        />
      </View>

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
      ) : total === 0 && !searching ? (
        <EmptyState
          headline="아직 참여한 채널이 없습니다."
          // 채널 범위의 행위는 「추가」다 (#1573 예약 · #1584). 「초대」는
          // 워크스페이스에 새 사람을 부르는 낱말이고, 이 문장이 가리키는
          // 데스크톱의 문은 「멤버 추가」 다이얼로그다.
          detail="채널 만들기와 멤버 추가는 데스크톱에서 할 수 있습니다."
          refreshControl={refreshControl}
          testID="channels-empty"
        />
      ) : (
        <SectionList
          sections={shownSections}
          keyExtractor={row => row.key}
          ListHeaderComponent={
            <>
              {notices}
              {card ? (
                <WorkingCard
                  card={card}
                  onPress={() =>
                    onOpenConversation(card.channelId, card.conversationTitle)
                  }
                />
              ) : agents.length > 0 && onOpenAgentList && !searching ? (
                <IdleAgentsRow count={agents.length} onPress={onOpenAgentList} />
              ) : null}
              {filterField}
            </>
          }
          ListEmptyComponent={
            <View>
              <EmptyState
                headline={`'${query.trim()}' 검색 결과가 없습니다.`}
                detail="이름의 일부만 입력해도 찾을 수 있습니다. 이름이 아니라 오간 말을 찾는 중이라면:"
                testID="channels-no-match"
              />
              {/* 같은 문이므로 같은 이름을 쓴다 (이슈 #1146 N4). */}
              <SearchFallthrough query={query} onPress={() => onOpenSearch(query)} />
            </View>
          }
          renderSectionHeader={({section}) => (
            <SectionHead
              section={section}
              collapsed={collapsed.has(section.key)}
              onToggle={() => toggle(section.key)}
              onMenu={() => openSectionMenu(section)}
            />
          )}
          renderSectionFooter={({section}) => (
            <View>
              <View style={styles.sectionGap} />
              {section.key !== shownSections[shownSections.length - 1]?.key ? (
                <View style={styles.divider} testID="home-divider" />
              ) : null}
            </View>
          )}
          renderItem={({item}) => (
            <Row
              row={item}
              directory={directoryQuery.directory}
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
          contentContainerStyle={[styles.listContent, {paddingBottom: HOME.scrollBottom + clearance}]}
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

/** 섹션 메뉴의 두 낱말. 시험이 같은 상수를 누른다. */
export const FILTER_ACTION = '이름으로 찾기';
export const AGENT_LIST_ACTION = '에이전트 목록';

// ---- 머리 ---------------------------------------------------------------------

/**
 * 로고 자리 (시안 `.a-top .logo`, 44 원). 무엇을 그릴지는 `workspaceHeading` 이
 * 정했다. 옆의 큰 제목이 이름을 말하므로 이 그림은 보조기술에서 숨는다.
 */
function WorkspaceLogoSlot({logo}: {logo: WorkspaceLogo}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const [failed, setFailed] = useState(false);
  const base = apiBase();
  let content: React.ReactNode = null;
  if (logo.kind === 'avatar' && !failed && base !== '') {
    const token = coreSession().getAccessToken();
    content = (
      <Image
        source={{
          uri: `${base}${logo.path}`,
          headers: token === null ? undefined : {Authorization: `Bearer ${token}`},
        }}
        onError={() => setFailed(true)}
        style={styles.logoImage}
        testID="home-logo-avatar-image"
      />
    );
  } else if (logo.kind !== 'pending') {
    content = (
      <Image source={BRAND_BADGE} style={styles.logoImage} testID="home-logo-brand-image" />
    );
  }
  return (
    <View
      style={styles.logo}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={`home-logo-${logo.kind}`}>
      {content}
    </View>
  );
}

// ---- 섹션 머리 (시안 `.a-sec-h`) ------------------------------------------------

function SectionHead({
  section,
  collapsed,
  onToggle,
  onMenu,
}: {
  section: SidebarSection;
  collapsed: boolean;
  onToggle: () => void;
  onMenu: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const icon: HomeIconName = section.key === 'channels' ? 'hash' : 'dms';
  return (
    <View style={styles.secHead} testID={`home-section-${section.key}`}>
      <Image
        source={HOME_ICONS[icon]}
        style={[styles.icon22, {tintColor: palette.text}]}
      />
      <Text accessibilityRole="header" style={styles.secTitle} numberOfLines={1}>
        {section.label}
      </Text>
      <View style={styles.secCtl}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${section.label} 섹션 메뉴`}
          onPress={onMenu}
          // 두 글리프 사이가 14 라 대칭 여유(12+12)는 가운데 10pt 를 둘이 함께 갖는다
          // (리뷰 M3). 바깥쪽으로 더 주고 안쪽은 틈의 절반(7)에서 멈춘다 — 두 상자 모두
          // 44 이고 겹치지 않는다.
          hitSlop={CTL_SLOP_MORE}
          style={({pressed}) => pressed && styles.pressedGlyph}
          testID={`home-section-menu-${section.key}`}>
          <Image
            source={HOME_ICONS.more}
            style={[styles.icon20, {tintColor: palette.icon}]}
          />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${section.label} 섹션`}
          accessibilityState={{expanded: !collapsed}}
          accessibilityHint={collapsed ? '펼칩니다.' : '접습니다. 안 읽은 대화는 남습니다.'}
          onPress={onToggle}
          hitSlop={CTL_SLOP_DOWN}
          style={({pressed}) => pressed && styles.pressedGlyph}
          testID={`home-section-toggle-${section.key}`}>
          <Image
            source={HOME_ICONS.down}
            style={[
              styles.icon20,
              {tintColor: palette.icon},
              collapsed && styles.chevronCollapsed,
            ]}
          />
        </Pressable>
      </View>
    </View>
  );
}

// ---- 행 (시안 `.a-row`) --------------------------------------------------------

/** 에이전트의 둥근 사각 (시안 `.a-ag`). 사람의 원과 모양으로 갈린다. */
function AgentSquare({
  size,
  corner,
  glyph,
}: {
  size: number;
  corner: number;
  glyph: number;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  return (
    <View
      style={[styles.agentSquare, {width: size, height: size, borderRadius: corner}]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="home-agent-square">
      <Image
        source={HOME_ICONS.bot}
        style={{width: glyph, height: glyph, tintColor: palette.agent}}
      />
    </View>
  );
}

function Row({
  row,
  directory,
  selected,
  busy,
  onPress,
}: {
  row: SidebarRow;
  directory: Directory;
  selected: boolean;
  busy: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const unread = row.unreadCount > 0 || row.mentionCount > 0;
  let lead: React.ReactNode;
  if (row.kind === 'channel') {
    lead = (
      <Image
        source={row.isPrivate ? HOME_ICONS.lock : HOME_ICONS.hash}
        style={[styles.icon22, {tintColor: unread ? palette.text : palette.icon}]}
        testID={row.isPrivate ? 'home-row-lock' : 'home-row-hash'}
      />
    );
  } else if (row.isAgent) {
    lead = (
      <AgentSquare size={HOME.rowFace} corner={HOME.rowAgentCorner} glyph={HOME.rowAgentGlyph} />
    );
  } else if (row.avatarMemberId !== null) {
    lead = <Avatar directory={directory} memberId={row.avatarMemberId} size={HOME.rowFace} />;
  } else {
    lead = <View style={styles.faceBlank} />;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={row.accessibilityLabel}
      accessibilityState={{selected, busy}}
      onPress={onPress}
      style={({pressed}) => [
        styles.row,
        selected && styles.rowSelected,
        pressed && styles.rowPressed,
      ]}
      testID={`sidebar-row-${row.key}`}>
      {lead}
      <View style={styles.rowName}>
        <Text
          style={[
            styles.rowTitle,
            unread && styles.rowTitleUnread,
            row.muted && !unread && styles.rowTitleMuted,
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
      {busy ? (
        <ActivityIndicator color={palette.textMuted} testID="home-row-busy" />
      ) : row.mentionCount > 0 ? (
        // 멘션이 있으면 잉크 `@N` 하나가 선다(시안 `.a-badge.at`). 안 읽은 수는
        // 굵은 이름과 낭독 라벨이 함께 진다 — 배지 둘을 나란히 세우지 않는다.
        <View style={[styles.badge, styles.badgeAt]} testID="home-badge-mention">
          <Text style={[styles.badgeText, styles.badgeAtText]} maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
            @{row.mentionCount > 99 ? '99+' : row.mentionCount}
          </Text>
        </View>
      ) : row.unreadCount > 0 ? (
        <View style={styles.badge} testID="home-badge-unread">
          <Text style={styles.badgeText} maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
            {row.unreadCount > 99 ? '99+' : row.unreadCount}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

// ---- 「작업 중」 카드 (시안 `.a-now`) -------------------------------------------

/** 7pt 점. 1.6초 맥박(시안 `pulse`), 동작 줄이기·끊김·승인 대기에서는 멈춘다. */
function LiveDot({pulse, color}: {pulse: boolean; color: string}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!pulse) {
      opacity.setValue(1);
      return;
    }
    const half = HOME.pulseMs / 2;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: HOME.pulseLow,
          duration: half,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: half,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, opacity]);
  return (
    <Animated.View
      style={[styles.liveDot, {backgroundColor: color, opacity}]}
      testID={pulse ? 'home-live-dot-pulse' : 'home-live-dot-still'}
    />
  );
}

export function WorkingCard({
  card,
  onPress,
}: {
  card: WorkingCardModel;
  onPress: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const reduceMotion = useReduceMotion();
  // 승인 대기는 「사람을 보라」라서 신호색이다. 끊긴 레일 위의 낱말은 확인된 사실이
  // 아니므로 색을 벗는다(에이전트 목록 `AgentTurnBadge live=false` 와 같은 규칙).
  const tone = !card.live
    ? palette.textMuted
    : card.state === 'awaiting_approval'
      ? palette.accentText
      : palette.agent;
  const pulse = card.live && card.state === 'working' && !reduceMotion;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={card.accessibilityLabel}
      accessibilityHint="그 대화를 엽니다."
      onPress={onPress}
      style={({pressed}) => [styles.cardPress, pressed && styles.rowPressed]}
      testID="home-working-card">
      <GlassSurface radius={HOME.cardRadius} style={styles.card}>
        <View style={styles.cardTop}>
          <AgentSquare size={HOME.cardFace} corner={HOME.cardAgentCorner} glyph={HOME_ICON_SIZE.bot} />
          <Text
            style={styles.cardName}
            numberOfLines={1}
            // 카드의 머리 줄은 이름 · 태그 · 상태 셋이 한 줄에 선다. 큰 글씨에서 이름만
            // 끝없이 자라면 「김…」 한 글자로 잘린다(AX 캡처) — 바의 글자와 같은 상한.
            maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
            {card.name}
            {card.handle ? <Text style={styles.rowHandle}> {card.handle}</Text> : null}
          </Text>
          <View style={styles.tag}>
            <Text style={styles.tagText} maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
              에이전트
            </Text>
          </View>
          <View style={styles.live}>
            <LiveDot pulse={pulse} color={tone} />
            <Text
              style={[styles.liveText, {color: tone}]}
              maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
              testID="home-working-state">
              {card.liveText}
            </Text>
          </View>
        </View>
        {/* 문장이라 어절에서 끊는다(`Sentence`, 리뷰 H1 — 「…상태입 / 니다」). 큰
            글씨에서 한 줄이 두 줄로 잘려 할 일이 사라지지 않게 넷까지 연다(M4). */}
        <Sentence
          style={[styles.cardLine, !card.live && styles.cardLineStale]}
          numberOfLines={4}
          testID="home-working-line">
          {card.place ? <Text style={styles.cardPlace}>{card.place}</Text> : null}
          {card.place && card.headline ? ' · ' : null}
          {card.headline ?? (card.place ? null : '대화')}
          {card.others > 0 ? ` · 그 밖에 ${card.others}건` : null}
        </Sentence>
        {card.live ? null : (
          <Sentence style={styles.cardStale} testID="home-working-stale">
            {TURN_STALE_SENTENCE}
          </Sentence>
        )}
        <View style={styles.prog} testID={`home-working-steps-${card.step}`}>
          {([1, 2, 3] as const).map(step => (
            <View
              key={step}
              style={[
                styles.progStep,
                !card.live && styles.progStepStale,
                step <= card.step && (card.live ? styles.progStepOn : styles.progStepOnStale),
              ]}
            />
          ))}
        </View>
      </GlassSurface>
    </Pressable>
  );
}

/**
 * 작업 중인 에이전트가 없을 때 카드 자리에 서는 한 줄 (PR 「빈 상태」 결정).
 *
 * 카드를 통째로 비우지 않는 이유: 이 자리는 에이전트 탭이 흡수된 곳이라(ADR-0189
 * D1) 비우면 에이전트 목록·호스티드 연결로 가는 문이 FAB 시트 한 곳에만 남는다.
 * 빈 유리 카드를 두지 않는 이유: 「아무도 일하지 않음」을 카드 크기로 말하면 목록을
 * 한 화면 아래로 밀어 매일 여는 채널이 첫 화면에서 빠진다. 그래서 행 한 줄 — 시안의
 * `.a-row` 문법 그대로, 에이전트 사각과 함께.
 */
function IdleAgentsRow({
  count,
  onPress,
}: {
  count: number;
  onPress: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`에이전트 부르기, 지금 작업 중인 에이전트 없음, 에이전트 ${count}명`}
      onPress={onPress}
      style={({pressed}) => [styles.row, styles.idleRow, pressed && styles.rowPressed]}
      testID="home-agents-idle">
      <AgentSquare size={HOME.rowFace} corner={HOME.rowAgentCorner} glyph={HOME.rowAgentGlyph} />
      <View style={styles.idleText}>
        {/* 동사가 잘리면 문이 무엇인지 사라진다(AX, 리뷰 M4) — 두 줄까지 감는다. */}
        <Text style={styles.rowTitle} numberOfLines={2}>
          에이전트 부르기
        </Text>
        {/* 보조 줄은 이름 **아래**에 선다. 오른쪽 끝에 두면 큰 글씨에서 이름이
            「에…」로 먹힌다(AX 캡처). */}
        <Text
          style={styles.idleMeta}
          numberOfLines={1}
          maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
          {`지금 작업 중인 에이전트 없음 · ${count}명`}
        </Text>
      </View>
    </Pressable>
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


/**
 * 시안 A 의 수치 (`claudedocs/design-2.0/mockups.html`, 390×844). 캡처와 시험이 같은
 * 이름을 읽는다. 원문:
 *
 *   .a-top   padding 14 20 0 · gap 12 · .logo 44 원 surface + sh1 ·
 *            h1 30/800 · -0.035em · line-height 1.1 · .av 42 + 2px surface 고리 + sh1
 *   .a-scroll top 128(= 머리 아래 16) · padding 6 16 140
 *   .a-now   glass + 1px glassLine + sh1 · radius 22 · padding 14 14 13 · 아래 22
 *            .t gap 10 · .a-ag 36/11 · .n 15.5/700 · .a-tag 11/700 radius 6 pad 2 6 ·
 *            .a-live 12.5/600 gap 6 · 점 7 · p 14 ink2 margin 9 0 10 46 · lh 1.45 ·
 *            .a-prog 왼쪽 46 · 3칸 gap 4 · 높이 4 radius 2 · 끔 agent 22%
 *   .a-sec   아래 14 · .a-sec-h 44 · pad 0 6 · gap 12 · b 17/700 -0.015em · .ctl gap 14
 *   .a-row   46 · gap 13 · pad 0 8 0 7 · radius 14 · 17 -0.01em · .av·.a-ag 28 (ag 9)
 *   .a-badge 22 · radius 11 · pad 0 7 · 12.5/700 · signal / .at primary
 *   .a-div   1 · ink 10% · margin 6 8 10
 */
export const HOME = {
  topPadTop: 14,
  topPadX: 20,
  topGap: 12,
  logo: 44,
  largeTitleLine: 33,
  largeTitleTracking: -1.05,
  selfFace: 42,
  /** `.a-scroll` 의 위: 머리 상자 끝(112)에서 128 + 6. */
  scrollTop: 22,
  scrollX: 16,
  scrollBottom: 6,
  cardRadius: 22,
  cardPadTop: 14,
  cardPadX: 14,
  cardPadBottom: 13,
  cardBelow: 22,
  cardGap: 10,
  cardFace: 36,
  cardAgentCorner: 11,
  cardName: 15.5,
  cardNameTracking: -0.155,
  tag: 11,
  tagRadius: 6,
  tagPadY: 2,
  tagPadX: 6,
  live: 12.5,
  liveGap: 6,
  liveDot: 7,
  pulseMs: 1600,
  pulseLow: 0.35,
  line: 14,
  lineBox: 20,
  lineTop: 9,
  lineBottom: 10,
  indent: 46,
  progGap: 4,
  progHeight: 4,
  progRadius: 2,
  secBelow: 14,
  secHead: 44,
  secPadX: 6,
  secGap: 12,
  secTitleTracking: -0.255,
  ctlGap: 14,
  row: 46,
  rowGap: 13,
  rowPadLeft: 7,
  rowPadRight: 8,
  rowRadius: 14,
  rowText: 17,
  rowTracking: -0.17,
  rowFace: 28,
  rowAgentCorner: 9,
  rowAgentGlyph: 16,
  badge: 22,
  badgePadX: 7,
  badgeText: 12.5,
  dividerTop: 6,
  dividerX: 8,
  dividerBottom: 10,
} as const;

/** 섹션 머리 두 컨트롤의 누르는 상자: 각각 44×44, 서로 겹치지 않는다. */
const CTL_INNER = HOME.ctlGap / 2;
const CTL_VERTICAL = slopTo(HOME_ICON_SIZE.more);
export const CTL_SLOP_MORE = {
  top: CTL_VERTICAL,
  bottom: CTL_VERTICAL,
  left: TOUCH_TARGET - HOME_ICON_SIZE.more - CTL_INNER,
  right: CTL_INNER,
};
export const CTL_SLOP_DOWN = {
  top: CTL_VERTICAL,
  bottom: CTL_VERTICAL,
  left: CTL_INNER,
  right: TOUCH_TARGET - HOME_ICON_SIZE.down - CTL_INNER,
};

/** `#rrggbb` 에 알파 두 자리를 붙인다. 시안의 `color-mix(… N%, transparent)`. */
function alpha(hex: string, fraction: number): string {
  return `${hex.slice(0, 7)}${Math.round(fraction * 255)
    .toString(16)
    .padStart(2, '0')}`;
}

const buildStyles = (color: Palette) => StyleSheet.create({
  // ---- 머리 ------------------------------------------------------------------
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: HOME.topGap,
    paddingTop: HOME.topPadTop,
    paddingHorizontal: HOME.topPadX,
  },
  logo: {
    width: HOME.logo,
    height: HOME.logo,
    borderRadius: HOME.logo / 2,
    backgroundColor: color.surface,
    boxShadow: color.elevationRest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoImage: {width: HOME.logo, height: HOME.logo, borderRadius: HOME.logo / 2},
  largeTitle: {
    flex: 1,
    fontSize: ds2Type.largeTitle,
    fontWeight: '800',
    letterSpacing: HOME.largeTitleTracking,
    lineHeight: HOME.largeTitleLine,
    color: color.text,
  },
  // 44 상자 안의 42 얼굴. 오른쪽으로 남는 1 을 거둬 얼굴의 가장자리가 머리의
  // 여백(20)에 맞선다.
  avatarButton: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: -(TOUCH_TARGET - HOME.selfFace) / 2,
    borderRadius: radius.pill,
  },
  avatarPressed: {opacity: 0.6},
  // 사진 없는 이니셜 얼굴은 바탕 위 1.07:1 이다 — 이 앱의 계정 문이 이것 하나이므로
  // 3:1 을 넘는 가장자리(`textFaint`)를 두르고(리뷰 M1), 시안의 `sh1` 을 더한다.
  avatarRing: {
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.textFaint,
    boxShadow: color.elevationRest,
  },

  // ---- 목록 ------------------------------------------------------------------
  listContent: {paddingTop: HOME.scrollTop, paddingHorizontal: HOME.scrollX},
  bannerWrap: {paddingBottom: space.sm},
  filterWrap: {paddingBottom: space.md},
  filter: {
    minHeight: TOUCH_TARGET,
    borderRadius: ds2Radius.row,
    borderWidth: 1,
    borderColor: color.textFaint,
    backgroundColor: color.surface,
    paddingHorizontal: space.md,
    fontSize: font.body,
    color: color.text,
  },
  secHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: HOME.secGap,
    minHeight: HOME.secHead,
    paddingHorizontal: HOME.secPadX,
  },
  secTitle: {
    flex: 1,
    fontSize: ds2Type.headline,
    fontWeight: '700',
    letterSpacing: HOME.secTitleTracking,
    color: color.text,
  },
  secCtl: {flexDirection: 'row', alignItems: 'center', gap: HOME.ctlGap},
  pressedGlyph: {opacity: 0.5},
  chevronCollapsed: {transform: [{rotate: '-90deg'}]},
  sectionGap: {height: HOME.secBelow},
  divider: {
    height: 1,
    backgroundColor: alpha(color.text, 0.1),
    // 시안의 `.a-sec` 아래 14 와 `.a-div` 위 6 은 CSS 에서 겹쳐 14 가 된다(마진 상쇄).
    // 위의 섹션 틈이 이미 14 이므로 여기서 더하지 않는다(리뷰 M2).
    marginTop: Math.max(0, HOME.dividerTop - HOME.secBelow),
    marginHorizontal: HOME.dividerX,
    marginBottom: HOME.dividerBottom,
  },
  icon22: {width: HOME_ICON_SIZE.hash, height: HOME_ICON_SIZE.hash},
  icon20: {width: HOME_ICON_SIZE.more, height: HOME_ICON_SIZE.more},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: HOME.rowGap,
    minHeight: HOME.row,
    paddingLeft: HOME.rowPadLeft,
    paddingRight: HOME.rowPadRight,
    borderRadius: HOME.rowRadius,
  },
  rowSelected: {backgroundColor: color.glass, boxShadow: color.elevationRest},
  rowPressed: {backgroundColor: color.surfacePressed},
  rowName: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.xs},
  rowTitle: {
    flexShrink: 1,
    fontSize: HOME.rowText,
    letterSpacing: HOME.rowTracking,
    color: color.text,
  },
  rowTitleUnread: {fontWeight: '700'},
  rowTitleMuted: {color: color.textMuted},
  rowHandle: {fontSize: font.meta, color: color.textMuted, flexShrink: 1},
  faceBlank: {
    width: HOME.rowFace,
    height: HOME.rowFace,
    borderRadius: HOME.rowFace / 2,
    borderWidth: 1,
    borderColor: color.border,
  },
  agentSquare: {
    backgroundColor: color.agentSurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    minWidth: HOME.badge,
    minHeight: HOME.badge,
    borderRadius: HOME.badge / 2,
    paddingHorizontal: HOME.badgePadX,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.accent,
  },
  badgeAt: {backgroundColor: color.primary},
  badgeText: {fontSize: HOME.badgeText, fontWeight: '700', color: color.onAccent},
  badgeAtText: {color: color.onPrimary},

  // ---- 카드 ------------------------------------------------------------------
  cardPress: {marginBottom: HOME.cardBelow, borderRadius: HOME.cardRadius},
  card: {
    borderRadius: HOME.cardRadius,
    borderWidth: 1,
    borderColor: color.glassLine,
    boxShadow: color.elevationRest,
    paddingTop: HOME.cardPadTop,
    paddingHorizontal: HOME.cardPadX,
    paddingBottom: HOME.cardPadBottom,
  },
  cardTop: {flexDirection: 'row', alignItems: 'center', gap: HOME.cardGap},
  cardName: {
    flexShrink: 1,
    fontSize: HOME.cardName,
    fontWeight: '700',
    letterSpacing: HOME.cardNameTracking,
    color: color.text,
  },
  tag: {
    flexShrink: 0,
    borderRadius: HOME.tagRadius,
    paddingVertical: HOME.tagPadY,
    paddingHorizontal: HOME.tagPadX,
    backgroundColor: color.agentSurface,
  },
  tagText: {fontSize: HOME.tag, fontWeight: '700', color: color.agent},
  live: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: HOME.liveGap,
  },
  liveDot: {width: HOME.liveDot, height: HOME.liveDot, borderRadius: HOME.liveDot / 2},
  liveText: {fontSize: HOME.live, fontWeight: '600'},
  cardLine: {
    fontSize: HOME.line,
    lineHeight: HOME.lineBox,
    color: color.textMuted,
    marginTop: HOME.lineTop,
    marginBottom: HOME.lineBottom,
    marginLeft: HOME.indent,
  },
  cardLineStale: {marginBottom: space.xs},
  cardPlace: {color: color.text, fontWeight: '600'},
  cardStale: {
    fontSize: font.meta,
    color: color.textMuted,
    marginLeft: HOME.indent,
    marginBottom: HOME.lineBottom,
  },
  prog: {
    marginLeft: HOME.indent,
    flexDirection: 'row',
    gap: HOME.progGap,
  },
  progStep: {
    flex: 1,
    height: HOME.progHeight,
    borderRadius: HOME.progRadius,
    backgroundColor: alpha(color.agent, 0.22),
  },
  progStepOn: {backgroundColor: color.agent},
  // 끊긴 레일 위의 단계는 확인된 사실이 아니다 — 점·낱말과 함께 색을 벗는다(리뷰 L1).
  progStepStale: {backgroundColor: color.border},
  progStepOnStale: {backgroundColor: color.textFaint},

  // ---- 빈 카드 자리 · 이름 찾기 --------------------------------------------
  idleRow: {marginBottom: HOME.secBelow},
  idleText: {flex: 1},
  idleMeta: {fontSize: font.label, color: color.textMuted},
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
  pressed: {backgroundColor: color.surfacePressed},
  headerAction: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
  },
  headerActionLabel: {fontSize: font.label, color: color.accentText, fontWeight: '600'},
});
