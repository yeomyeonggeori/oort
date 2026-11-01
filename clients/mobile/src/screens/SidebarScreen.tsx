import {ApiError, openDirectMessage, uuidEq} from '@momo/core/lib/api';
import {NetworkError} from '@momo/core/lib/http';
import {attachParticle} from '@momo/core/lib/koreanParticle';
import {serverSurface} from '@momo/core/features/capabilities/serverSurfaces';
import {channelLabel, channelLabelParts, idKey, memberFor} from '@momo/core/features/workspace/directory';
import {readProjectionPhase, rosterLoaded} from '@momo/core/features/sidebar/goneDm';
import {DM_CLOSED_LIST_LABEL, dmCloseOffered} from '@momo/core/features/sidebar/dmVisibility';
import {mayActOnLiveness} from '@momo/core/features/agents/liveness';
import {isUntakenHumanRun} from '@momo/core/features/agents/runWaiting';
import {
  dmPeerStatusDot,
  type StatusDot as StatusDotModel,
} from '@momo/core/features/presence/statusDot';
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
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
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
  STACK_PILL_SCALE,
} from '../design/atoms';
import {GlassSurface} from '../design/glass';
import {HOME_ICONS, HOME_ICON_SIZE, type HomeIconName} from '../design/icons';
import {PULL_FILL, usePullRefresh, withPullScroll} from '../design/refresh';
import {type Directory} from '@momo/core/features/workspace/directory';
import {
  ds2Radius,
  font,
  radius,
  SAFE_GUTTER,
  slopTo,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../design/tokens';
import {useKeyboardAppearance, usePalette, useStyles} from '../design/theme';
import {useAgentLiveness} from '../features/agents/useAgentLiveness';
import {
  useAgentWorkingSignals,
  withApprovalWaits,
} from '../features/agents/workingSignal';
import {useWorkspaceApprovalWaits} from '../features/conversation/usePendingApprovals';
import {StatusDot} from '../features/presence/StatusDot';
import {useCollapsedSections, visibleRows} from '../features/home/collapsedSections';
import {
  buildWorkingCard,
  cardCancelRunId,
  leadWorkingTurn,
  revealOverflow,
  type WorkingCardModel,
} from '../features/home/workingCard';
import {WorkingCardStop} from '../features/home/WorkingCardStop';
import {workspaceHeading, type WorkspaceLogo} from '../features/home/workspaceLogo';
import {
  buildSidebarSections,
  CHANNEL_LIST_FAILED,
  type SidebarRow,
  type SidebarSection,
} from '../features/sidebar/rows';
import {CHIP_TONE, type ChipTone, type RowChip} from '../features/sidebar/rowEmphasis';
import {useGoneUnreadVerdicts} from '../features/sidebar/useGoneUnreadVerdicts';
import {dmClosedEntries, dmClosureMode, dmVerdicts} from '../features/sidebar/dmVerdicts';
import {DmClosedSheet} from '../features/sidebar/DmClosedSheet';
import {useDmClosedCacheInitial, useDmClosedCacheWrite} from '../features/sidebar/dmClosedCache';
import {useDmReopen} from '../features/sidebar/useDmReopen';
import {
  useChannels,
  useDirectory,
  useReadStates,
  useRememberOpenedDm,
  useWorkspaceIdentity,
} from '../features/workspace/queries';
import {Avatar} from '../features/conversation/Avatar';
import type {ChannelActionKey} from '@momo/core/features/channels/actionModel';
import {useLongPress} from '../features/conversation/useLongPress';
import {ChannelActionSheet} from '../features/sidebar/ChannelActionSheet';
import {
  channelRowAccessibilityActions,
  channelRowActionItems,
  channelRowActionKeyOf,
  type ChannelRowTarget,
} from '../features/sidebar/channelRowActions';
import {useChannelRowActions} from '../features/sidebar/useChannelRowActions';
import {
  AppUpdateBanner,
  AppUpdateSheet,
} from '../features/appUpdate/AppUpdateBanner';
import {useAppUpdateOffer} from '../features/appUpdate/useAppUpdateOffer';
import {haptics} from '../lib/haptics';
import {useReduceMotion} from '../lib/useReduceMotion';
import {useTabBarClearance} from '../shell/ShellChrome';
import {useRealtime} from '../realtime/RealtimeProvider';
import {useSession} from '../session/useSession';
import {apiBase} from '../storage/serverBase';

/**
 * 브랜드 배지(코메토 K6, `docs/brand/kometto/K6-flat-dark.png`)를 44 원으로 오려 낸 판.
 *
 * 다시 만드는 법: 원본의 배지 원(중심 626.5·625.5, 반지름 530.5 — `docs/brand/mark/
 * README.md`)을 상자 (96,95)–(1157,1156)로 오리고, 44·88·132 로 줄인 뒤 원 밖을 투명하게.
 * 다시 그리지 않는다. 웹 `render-brand-icons.mjs` 의 검사 밖이라 그 파이프라인에 올리는
 * 것은 후속이다(PR 남은 일).
 */
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
 * 머리 오른쪽의 내 얼굴 — 「설정」 페이지를 여는 문 (#2702 → #4457).
 *
 * Buzz·Slack 모바일이 같은 자리에 둔다: 계정은 매일 보는 목록의 발치가 아니라
 * 머리 한구석에 작게 있고, 누르면 전체 화면 설정 페이지(상태·알림·테마·로그아웃)가 열린다.
 * 시트이던 시절(#2702)과 문은 같고 열리는 것만 페이지가 되었다.
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
      accessibilityHint="상태·알림·테마·로그아웃이 있는 설정 페이지를 엽니다."
      onPress={() => {
        // 페이지가 열리는 그 프레임에 — 시각이 단독으로도 선다(시스템 햅틱을 끈 사람 포함).
        haptics.light();
        onPress();
      }}
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
  onOpenWorkList,
  onOpenSettings,
  onChannelLeft,
  notificationNotice = null,
  onDismissNotificationNotice,
  active = true,
}: {
  openChannelId: string | null;
  /** 채널을 나간 뒤·DM 을 닫은 뒤. 열려 있던 그 대화를 걷는다(웹은 `/` 로 착지한다). */
  onChannelLeft?: (channelId: string) => void;
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
   * DM 섹션 메뉴가 부른다(홈 맨 위의 「에이전트 부르기」 한 줄은 2026-10-16에 없앴다). 셸 밖(하네스)
   * 에서는 없을 수 있고, 그때 그 문들은 서지 않는다.
   */
  onOpenAgentList?: () => void;
  /**
   * 「작업」 층을 연다(ADR-0202 D6, U1 #3842): 「작업 중」 카드 머리의 「모두 보기」. + 메뉴의
   * 「작업」과 같은 화면·같은 줄이다. 작업 표면이 없는 서버·셸 밖(하네스)에서는 없고, 그때 이
   * 문은 서지 않는다.
   */
  onOpenWorkList?: () => void;
  /**
   * 「설정」 페이지 층을 연다(#4457): 머리 오른쪽 내 얼굴. 셸 밖(하네스)에서는 없을 수 있고, 그때
   * 얼굴은 눌러도 아무 일이 없다 — 설정은 셸의 층이라 이 화면이 스스로 세우지 않는다.
   */
  onOpenSettings?: () => void;
  /**
   * 알림을 눌렀는데 그 대화로 갈 수 없었던 이유, 한 문장 (#2569).
   *
   * 이 목록에 서는 이유는 이곳이 그 대화가 **있었어야 할 자리**이기 때문이다.
   * 셸이 탭을 판정하고 이 화면은 그 문장을 그릴 뿐이다.
   */
  notificationNotice?: string | null;
  onDismissNotificationNotice?: () => void;
  /**
   * 지금 이 탭이 보이는가 (#3992). 이 화면은 언마운트되지 않고 `AppShell` 이 탭을 숨기기만 하므로, 당겨서
   * 새로고침의 실패 안내(「화면을 떠날 때까지」 남는다)는 이 값이 거짓이 될 때 거둔다. 기본 `true`: 셸 밖에서
   * 단독으로 마운트하는 하네스·시험에서는 「안 보인다」가 조용한 기본이 되지 않게.
   */
  active?: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const keyboardAppearance = useKeyboardAppearance();
  const {member, workspaceId} = useSession();
  const realtime = useRealtime();
  // 새 버전 배너(#3905): 피드를 못 읽었거나 이미 최신이면 `null` 이라 아무것도 서지 않는다.
  const updateOffer = useAppUpdateOffer();
  const [updateSheetOpen, setUpdateSheetOpen] = useState(false);
  // 셸 안의 탭이면 바닥 위에 투명하게 서고, 목록 끝을 탭바만큼 비운다(ADR-0189 D1).
  const clearance = useTabBarClearance();
  const channelsQuery = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);
  const readStates = useReadStates(workspaceId);
  const identity = useWorkspaceIdentity(workspaceId);
  const heading = workspaceHeading(identity);
  const {collapsed, toggle} = useCollapsedSections(workspaceId);
  const readPhase = readProjectionPhase(readStates);
  // 행 이름과 보임 판정이 같은 답을 읽는다(`rows.ts` `rosterReady`).
  const rosterReady = rosterLoaded(directoryQuery);
  // 서버가 닫기를 싣는가(읽음 투영 행이 말한다). 싣지 않는 서버에서는 닫기를 내밀지 않는다(폰에는 기기 로컬 닫기가 없다).
  const closureMode = dmClosureMode(readStates.data);

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

  // 서버가 「사람이 읽을 마지막 seq」를 싣는 동안은 메시지를 다시 읽지 않는다(웹 `useDmVisibility` 와 같다): 후보가 비도록 국면을
  // 오는 중으로 준다. 옛 서버에서만, 안 읽음이 있는 나간 멤버 DM 의 안 읽음이 사람이 읽을 것인지 한 번 읽어 가른다.
  const goneUnreadVerdicts = useGoneUnreadVerdicts({
    workspaceId,
    groups: channelsQuery.groups,
    directory: directoryQuery.directory,
    selfMemberId: member.id,
    unreadByChannel: readStates.byChannel,
    openChannelId,
    readPhase: closureMode === 'server' ? 'loading' : readPhase,
    rosterReady,
  });

  // 마지막 투영의 닫힘 id: 첫 프레임에만 쓰는 캐시(원장 아님, `dmClosedCache.ts`).
  const cachedClosed = useDmClosedCacheInitial(workspaceId);

  // DM 이 목록에 서는가: 코어 `dmVisibility` 한 함수(웹과 같다). 숨은 DM 은 「⋯ › 닫은 대화」가 연다.
  const verdicts = useMemo(
    () =>
      dmVerdicts({
        dms: channelsQuery.groups.dms,
        directory: directoryQuery.directory,
        selfMemberId: member.id,
        byChannel: readStates.byChannel,
        openChannelId,
        phase: readPhase,
        rosterReady,
        mode: closureMode,
        goneVerdicts: goneUnreadVerdicts,
        cachedClosed,
      }),
    [
      channelsQuery.groups.dms,
      directoryQuery.directory,
      member.id,
      readStates.byChannel,
      openChannelId,
      readPhase,
      rosterReady,
      closureMode,
      goneUnreadVerdicts,
      cachedClosed,
    ],
  );
  useDmClosedCacheWrite(workspaceId, readPhase, closureMode === 'server', verdicts);
  const closedEntries = useMemo(
    () => dmClosedEntries(channelsQuery.groups.dms, verdicts),
    [channelsQuery.groups.dms, verdicts],
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
        readPhase,
        rosterReady,
        dmVerdicts: verdicts,
      }),
    [
      channelsQuery.groups,
      agents,
      directoryQuery.directory,
      member.id,
      readStates.byChannel,
      openChannelId,
      query,
      readPhase,
      rosterReady,
      verdicts,
    ],
  );

  // ---- 「작업 중」 카드 (시안 A `.a-now`) -------------------------------------
  // 시계는 두지 않는다 — 카드는 경과 숫자를 그리지 않고, 스토어가 발행·해제마다
  // 다시 그리게 하며, 90초가 지난 턴은 레일의 15초 청소가 지운다(에이전트 목록과
  // 같은 거래, `AgentsScreen` 의 주석). 렌더 때의 벽시계가 TTL 을 한 번 더 건다.
  const railSignals = useAgentWorkingSignals();
  const approvalWaitList = useWorkspaceApprovalWaits();
  const railLive = realtime.status === 'connected';
  const allChannels = useMemo(
    () => [...channelsQuery.groups.channels, ...channelsQuery.groups.dms],
    [channelsQuery.groups],
  );
  // 카드가 아무도 가져가지 않은 사람 요청을 말하면, 그 에이전트의 서버 생존 판정(D4)을 읽어 근거
  // 줄 맨 앞에 싣는다(#4285). 누구를 읽을지는 카드를 만들기 전에 알아야 한다. 읽지 않는 때(다른
  // 상태의 카드)는 쿼리가 서지 않는다.
  const cardNowMs = Date.now();
  // 승인 원장이 레일보다 이긴다(#3738, 대화 화면의 자리표시·레일과 같은 덮어쓰기 — #5066·#5085). 서버는 승인에 걸린 run 을 레일
  // 프레임으로 알리지 않아서(중간 프레임은 늘 `running`) 레일만 보면 사람을 기다리는 에이전트도 「작업 중」이다. 아래 두 호출이 **같은**
  // 덮은 목록을 읽어야 한다: 근거 줄의 생존 판정을 카드와 다른 에이전트에게서 읽지 않게.
  const signals = withApprovalWaits(railSignals, approvalWaitList, cardNowMs);
  const leadTurn = leadWorkingTurn(signals, cardNowMs);
  const waitingAgentId =
    leadTurn !== undefined && isUntakenHumanRun(leadTurn.server)
      ? leadTurn.memberId
      : null;
  const waitingLiveness = useAgentLiveness(waitingAgentId);
  const card = buildWorkingCard({
    signals,
    nowMs: cardNowMs,
    directory: directoryQuery.directory,
    channels: allChannels,
    selfMemberId: member.id,
    live: railLive,
    liveness: waitingAgentId === null ? undefined : waitingLiveness.liveness,
  });
  // 「취소」를 내는 카드(아무도 가져가지 않은 채 N분을 넘은 요청, 연결이 살아 있을 때)와 그 실행.
  const cardCancelId = card === null ? null : cardCancelRunId(card);

  // 당겨서 새로고침 (goal RN-B4b / #1026). 채널·명부·읽음 상태 — 이 목록이 그리는
  // 세 가지 전부다. 안 읽음 배지만 30초 폴링을 갖고 있는데(`useReadStates`), 당긴
  // 사람이 기다리는 것은 그 30초가 아니라 지금이다.
  //
  // 재조회 함수만 따로 집는 이유는 `useInbox` 의 같은 주석과 같다: 이 훅들이
  // 돌려주는 객체는 `{...query, …}` 라 렌더마다 새 신원이고, `refetch` 는 아니다.
  const refetchChannels = channelsQuery.refetch;
  const refetchDirectory = directoryQuery.refetch;
  const refetchReadStates = readStates.refetch;
  // 목록의 현재 오프셋을 따라간다: 「취소」의 확인 줄이 열려 카드가 자라면 결정 단추까지 내릴 때 상대 거리를 절대 오프셋으로
  // 바꾸는 데 쓴다(아래 `revealCardEnd`, design-review #4285 r1 H1). 당김의 `onScroll`과 `withPullScroll`로 합친다.
  const scrollYRef = useRef(0);
  const trackScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollYRef.current = event.nativeEvent.contentOffset.y;
  }, []);
  const {refreshControl, scrollProps: pullScrollProps, notice} = usePullRefresh(
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
    {active},
  );
  // 두 목록은 합친 `scrollProps`를 그대로 펼친다(`pullRefresh.test.tsx`가 모양을 하나로 둔다).
  const scrollProps = useMemo(
    () => withPullScroll(trackScroll, pullScrollProps),
    [trackScroll, pullScrollProps],
  );

  const rememberOpenedDm = useRememberOpenedDm(workspaceId);
  const openDm = useMutation({
    mutationFn: (memberId: string) => openDirectMessage(workspaceId, memberId),
    onSuccess: opened => {
      rememberOpenedDm(opened.channel);
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

  // 행을 길게 누르면 열리는 시트(#4229). 항목은 코어 표가 정하고(`channelRowActionItems`), 시트는 화면에 하나다.
  const rowActions = useChannelRowActions(workspaceId, member.id, onChannelLeft);
  const channelById = useMemo(
    () =>
      new Map(
        [...channelsQuery.groups.channels, ...channelsQuery.groups.dms].map(channel => [
          idKey(channel.id),
          channel,
        ]),
      ),
    [channelsQuery.groups],
  );
  const selfRole = memberFor(directoryQuery.directory, member.id)?.role;
  const actionTargetFor = useCallback(
    (row: SidebarRow): ChannelRowTarget | null => {
      // 아직 DM 이 없는 에이전트 줄은 채널이 아니다(누르면 DM 을 연다) — 열 시트가 없다.
      if (row.kind === 'agent') return null;
      const channel = channelById.get(idKey(row.targetId));
      if (channel === undefined) return null;
      return {
        channel,
        title: row.title,
        muted: row.muted,
        selfRole,
        readState: readStates.byChannel.get(idKey(row.targetId)) ?? null,
        // 「대화 닫기」: 코어 `dmCloseOffered` 한 함수(웹 호버 X·행 메뉴와 같다) + 서버가 닫기를 싣는 동안만(기기 로컬 닫기는 없다).
        closeOffered:
          row.kind === 'dm' &&
          closureMode === 'server' &&
          dmCloseOffered({
            phase: readPhase,
            unreadCount: row.unreadCount,
            mentionCount: row.mentionCount,
            starredOrSectioned: false,
          }),
      };
    },
    [channelById, selfRole, readStates.byChannel, closureMode, readPhase],
  );

  // 「⋯ › 닫은 대화」 시트(ADR-0177 증보 D11, #4367). 내가 닫은 대화와 상대가 나간 대화를 다시 연다.
  const [closedListOpen, setClosedListOpen] = useState(false);
  const closedItems = useMemo(
    () =>
      closedEntries.map(entry => ({
        entry,
        name: channelLabelParts(
          entry.channel,
          directoryQuery.directory,
          member.id,
          {rosterReady},
        ).text,
      })),
    [closedEntries, directoryQuery.directory, member.id, rosterReady],
  );
  const onClosedReopened = useCallback(
    (entry: {channel: {id: string}}) => {
      setClosedListOpen(false);
      const item = closedItems.find(candidate => candidate.entry.channel.id === entry.channel.id);
      onOpenConversation(entry.channel.id, item?.name ?? '다이렉트 메시지');
    },
    [closedItems, onOpenConversation],
  );
  const dmReopen = useDmReopen(workspaceId, readStates.byChannel, onClosedReopened);
  // 시트가 열린 채 목록이 비면(다른 기기에서 다시 열었다) 빈 상태를 말한다 - 시트가 스스로 닫히지 않는다.
  const closeClosedList = useCallback(() => {
    setClosedListOpen(false);
    dmReopen.clearError();
  }, [dmReopen]);

  // 섹션 머리의 ⋯ (시안 `.a-sec-h .ctl`). 장식이 아니라 문이다: 헤더에서 내려온
  // 두 검색(이름·메시지)과, DM 섹션에서는 에이전트 목록·닫은 대화로 간다.
  const openSectionMenu = useCallback(
    (section: Pick<SidebarSection, 'key' | 'label'>) => {
      const items: {label: string; run: () => void}[] = [
        {label: FILTER_ACTION, run: () => setFilterOpen(true)},
      ];
      if (section.key === 'channels') {
        items.push({label: SEARCH_SURFACE_NAME, run: () => onOpenSearch()});
      } else {
        if (onOpenAgentList) {
          items.push({label: AGENT_LIST_ACTION, run: onOpenAgentList});
        }
        // 닫은 대화가 없으면 문이 서지 않는다(웹 `DmClosedMenu` 와 같다): 항목이 없는 문은 문이 아니다.
        if (closedEntries.length > 0) {
          items.push({label: DM_CLOSED_LIST_LABEL, run: () => setClosedListOpen(true)});
        }
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
    [closedEntries.length, onOpenAgentList, onOpenSearch],
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

  // 「취소」의 확인 줄이 열리면(카드가 자라면) 결정 단추까지 목록을 내린다. 가장 큰 글씨(AX5)에서는 읽는 글자인 확인
  // 문장이 카드를 한 화면보다 크게 늘려, 방금 누른 「취소」 아래의 단추가 접힌 아래로 밀려난다(design-review
  // #4285 r1 H1). 사람이 컨트롤을 건드렸을 때만 부른다(`WorkingCardStop.onGrow`).
  const listRef = useRef<SectionList<SidebarRow, (typeof shownSections)[number]>>(null);
  const cardBlockRef = useRef<View>(null);
  const reduceMotionHome = useReduceMotion();
  const {height: windowHeight} = useWindowDimensions();
  const revealCardEnd = useCallback(() => {
    const node = cardBlockRef.current;
    if (node === null || typeof node.measureInWindow !== 'function') return;
    node.measureInWindow((_x, y, _width, height) => {
      const overflow = revealOverflow({
        cardBottom: y + height,
        viewportBottom: windowHeight - clearance,
        gap: space.md,
      });
      if (overflow <= 0) return;
      listRef.current?.getScrollResponder()?.scrollTo({
        y: scrollYRef.current + overflow,
        animated: !reduceMotionHome,
      });
    });
  }, [clearance, reduceMotionHome, windowHeight]);

  // 읽음 투영을 한 번도 못 읽었으면 접을 근거가 없어 나간 멤버 DM 이 도로 보인다(코어 `dmVisibility` 2번: 모를 때 숨기는 쪽이 최악이다).
  // 그때 「목록은 그대로」라고 말하면 거짓이라 이유를 말한다(웹 DM 구역의 같은 안내와 같은 뜻, design-review #4252 Low).
  const goneUnfoldedByReadFailure =
    readPhase === 'error' &&
    rosterReady &&
    sections.some(
      section =>
        section.key === 'dms' && section.data.some(row => row.labelKind === 'gone'),
    );

  // 목록이 비었나: 행이 없어도 숨은 DM 만 있는 DM 섹션은 선다(`rows.ts`) - 그 머리의 ⋯ 가 닫은 대화로 가는 문이다.
  const nothingToShow = sections.length === 0;
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
        keyboardAppearance={keyboardAppearance}
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
        // 나간 멤버 DM 이 도로 보일 때는 새 문장이라 제목과 설명이 같은 말투(해요체)다. 그 밖에는 이 화면의 기존 문장 그대로다.
        <NoticeBlock
          headline={
            goneUnfoldedByReadFailure
              ? '안 읽음 표시를 불러오지 못했어요.'
              : '안 읽음 표시를 불러오지 못했습니다.'
          }
          detail={
            goneUnfoldedByReadFailure
              ? '안 읽은 개수를 알 수 없어서 나간 멤버와의 대화도 접지 못했어요.'
              : '목록은 그대로이고, 안 읽은 개수만 지금 알 수 없습니다.'
          }
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

      {/* 당겨서 새로고침이 실패했다는 한 줄(#3992). 시간으로 사라지지 않고, 다음 당김·성공 재조회·화면을
          떠날 때 거둔다. */}
      {notice}
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
          onPress={() => onOpenSettings?.()}
        />
      </View>

      {/* 고지는 목록 상태와 무관하게 선다 — 알림 탭이 막힌 이유는 목록이 실패했을 때
          가장 필요하다(#2584 M-1, `CHANNEL_LIST_FAILED` 가 두 곳에서 말한다). */}
      <View style={styles.noticeWrap}>{notices}</View>

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
      ) : nothingToShow && !searching ? (
        <EmptyState
          headline="아직 참여한 채널이 없습니다."
          // 채널 범위의 행위는 「추가」다 (#1573 예약 · #1584). 「초대」는
          // 워크스페이스에 새 사람을 부르는 낱말이고, 이 문장이 가리키는
          // 데스크톱의 문은 「멤버 추가」 다이얼로그다. 채널 만들기는 폰의 + 메뉴에도
          // 생겼다(DS2-2b #2750) — 소유자·관리자에게만 서므로 그 조건을 함께 말한다.
          detail="아래 +에서 새 DM을 시작하고, 소유자·관리자는 새 채널도 만들 수 있습니다. 멤버 추가는 데스크톱에서 할 수 있습니다."
          refreshControl={refreshControl}
          scrollProps={scrollProps}
          testID="channels-empty"
        />
      ) : (
        <SectionList
          ref={listRef}
          sections={shownSections}
          keyExtractor={row => row.key}
          ListHeaderComponent={
            <>
              {/* 성재 결재 2026-10-16: 홈 맨 위의 새 버전 배너. 검색 중에는 목록이
                  검색 결과이므로 서지 않는다. 닫기·나중에는 없다. */}
              {updateOffer && !searching ? (
                <AppUpdateBanner
                  offer={updateOffer}
                  onPress={() => setUpdateSheetOpen(true)}
                  testID="home-update-banner"
                  flush
                />
              ) : null}
              {/* 「작업 중」은 **지금 도는 턴이 있을 때만** 선다 (성재 2026-10-16: 「저 작업이
                  모호해요, 상시 떠 있는 건가요?」). 머리 줄(에이전트 작업 · 모두 보기)과 카드가 한
                  묶음이고, 턴이 없으면 둘 다 없다 — 비어 있는 「작업」 머리 아래에 다른 문(에이전트
                  부르기)이 서 있던 것이 모호함의 원인이었다. 에이전트 목록·작업 목록으로 가는 문은
                  + 메뉴(「AI」·「작업」)와 DM 섹션 메뉴에 그대로 있다. */}
              {card ? (
                <>
                  {onOpenWorkList && !searching ? (
                    <WorkSeeAllRow onPress={onOpenWorkList} />
                  ) : null}
                  <View ref={cardBlockRef} collapsable={false}>
                  <WorkingCard
                    card={card}
                    directory={directoryQuery.directory}
                    onPress={() =>
                      onOpenConversation(card.channelId, card.conversationTitle)
                    }
                    // 아무도 가져가지 않은 채 N분을 넘은 요청에만 「취소」가 선다(`cardCancelRunId`).
                    stop={
                      cardCancelId !== null ? (
                        <WorkingCardStop
                          // run마다 새로 선다: 앞 run을 취소하면 같은 카드가 다음 run으로 이어지는데(같은 에이전트·같은
                          // 대화의 대기 요청은 한 카드로 합쳐진다), 상태가 남으면 앞 run의 영수증을 든 채 다음 요청의
                          // 「취소」가 숨는다(design-review #4285 r1 H4). 웹 패널은 `key={runId}`다.
                          key={cardCancelId}
                          runId={cardCancelId}
                          channelId={card.channelId}
                          agentName={card.name}
                          runCount={card.runCount ?? undefined}
                          onGrow={revealCardEnd}
                        />
                      ) : undefined
                    }
                  />
                  </View>
                </>
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
              actionTarget={actionTargetFor(item)}
              onOpenActions={rowActions.open}
              onRunAction={rowActions.run}
            />
          )}
          stickySectionHeadersEnabled={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={[styles.listContent, {paddingBottom: HOME.scrollBottom + clearance}]}
          refreshControl={refreshControl}
          {...scrollProps}
          testID="sidebar-list"
        />
      )}

      {closedListOpen ? (
        <DmClosedSheet
          items={closedItems}
          pendingId={dmReopen.pendingId}
          error={dmReopen.error}
          onReopen={dmReopen.reopen}
          onClose={closeClosedList}
        />
      ) : null}

      {rowActions.active !== null ? (
        <ChannelActionSheet
          target={rowActions.active}
          items={channelRowActionItems(rowActions.active, rowActions.copied)}
          confirmingLeave={rowActions.confirmingLeave}
          isPending={rowActions.isPending}
          error={rowActions.error}
          leave={rowActions.leave}
          onRun={key => rowActions.run(rowActions.active as ChannelRowTarget, key)}
          onConfirmLeave={rowActions.confirmLeave}
          onCancelLeave={rowActions.cancelLeave}
          onClose={rowActions.close}
        />
      ) : null}

      {updateSheetOpen && updateOffer ? (
        <AppUpdateSheet
          offer={updateOffer}
          onClose={() => setUpdateSheetOpen(false)}
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
  section: Pick<SidebarSection, 'key' | 'label'>;
  collapsed: boolean;
  onToggle: () => void;
  onMenu: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  // 머리의 아이콘은 줄의 아이콘(`#`·자물쇠, #4953)과 달라야 「채널 묶음」으로 읽힌다 (#4979). 한 줄이라 바꾸기 쉽다.
  const icon: HomeIconName = section.key === 'channels' ? 'layers' : 'dms';
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
          onPress={() => {
            haptics.selection();
            onToggle();
          }}
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

/**
 * 상대를 알아볼 수 없는 DM 의 기본 아바타 (#4252, 웹 `DmAvatar` 의 「점선 테두리 원 + 사람 윤곽」). 모를 때 이니셜을
 * 지어내지 않는다는 코어의 규칙(`avatar.ts`)은 그대로이고, 이니셜이 아닌 것이 서는 자리가 빈 원이 아니게 할 뿐이다.
 * 점선은 웹의 `--line-strong` 자리(`textFaint`, 3:1)다. 보조기술에는 나가지 않는다: 행의 라벨이 이름을 이미 말한다.
 */
function DefaultFace(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  return (
    <View
      style={styles.defaultFace}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="home-default-face">
      <Image
        source={HOME_ICONS.user}
        style={[styles.icon18, {tintColor: palette.textMuted}]}
      />
    </View>
  );
}

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

/**
 * DM 줄의 상대 상태 점 (#3964). 판정은 core 의 한 함수(`dmPeerStatusDot`)이고 웹 `DmAvatar` 와 같다:
 * 사람은 스스로 정한 자리 비움·방해 금지가 먼저이고 그 밖에는 서버가 명부에 실은 접속 여부(`online`, #4692),
 * 에이전트는 서버의 생존 판정(`useAgentLiveness`: 쿼리 키가 웹과
 * 같고 같은 에이전트를 묻는 다른 표면과 한 요청을 나눠 쓴다). 채널 줄에는 점이 없다. 모르면 점이 없다.
 *
 * 행마다 훅이지만 `SectionList` 가 보이는 줄만 그리므로 쿼리도 보이는 에이전트만큼만 선다. 사람 줄에는
 * 쿼리가 서지 않는다.
 */
function useRowStatusDot(row: SidebarRow, directory: Directory): StatusDotModel | null {
  const {member} = useSession();
  const peer =
    row.kind === 'channel' || row.avatarMemberId === null
      ? null
      : memberFor(directory, row.avatarMemberId);
  const agentId = peer?.kind === 'agent' ? peer.id : null;
  const read = useAgentLiveness(agentId);
  return dmPeerStatusDot({
    member: peer,
    liveness: agentId === null ? undefined : read.liveness,
    mayAct: mayActOnLiveness(memberFor(directory, member.id)?.role),
    nowMs: agentId === null ? Date.now() : read.nowMs,
  });
}

function Row({
  row,
  directory,
  selected,
  busy,
  onPress,
  actionTarget,
  onOpenActions,
  onRunAction,
}: {
  row: SidebarRow;
  directory: Directory;
  selected: boolean;
  busy: boolean;
  onPress: () => void;
  /** 이 줄이 길게 누르면 여는 시트의 대상. 채널이 아닌 줄(DM 이 아직 없는 에이전트)은 `null` — 무장하지 않는다. */
  actionTarget: ChannelRowTarget | null;
  onOpenActions: (target: ChannelRowTarget) => void;
  onRunAction: (target: ChannelRowTarget, key: ChannelActionKey) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const status = useRowStatusDot(row, directory);
  // 길게 누르기와 VoiceOver 로터가 **같은 항목 배열**을 쓴다(코어 표의 답). 손가락에만 있는 동작은 없다.
  const actionItems = useMemo(
    () => (actionTarget === null ? [] : channelRowActionItems(actionTarget)),
    [actionTarget],
  );
  const accessibilityActions = useMemo(
    () => channelRowAccessibilityActions(actionItems),
    [actionItems],
  );
  const longPress = useLongPress({
    enabled: actionTarget !== null && actionItems.length > 0,
    onFire: () => {
      if (actionTarget !== null) onOpenActions(actionTarget);
    },
  });
  // 이름·아이콘의 회색과 굵기, 오른쪽 칩은 `rows.ts` 가 줄마다 계산해 둔 한 값이다(`rowEmphasis.ts`).
  const {emphasis} = row;
  let lead: React.ReactNode;
  if (row.kind === 'channel') {
    lead = (
      <Image
        source={row.isPrivate ? HOME_ICONS.lock : HOME_ICONS.hash}
        style={[styles.icon22, {tintColor: emphasis.dim ? palette.textMuted : palette.text}]}
        testID={row.isPrivate ? 'home-row-lock' : 'home-row-hash'}
      />
    );
  } else if (row.avatarMemberId !== null) {
    // 에이전트도 같은 `Avatar` 다 (성재 2026-10-16: 에이전트 목록에는 사진이 보이는데 DM 줄은
    // 로봇이었다). 예전에는 `isAgent` 가 먼저 걸려 `avatarMemberId` 가 있어도 로봇 사각을
    // 그렸다. 사진이 없으면 `Avatar` 가 에이전트 모양(둥근 사각)에 이니셜을 세운다.
    lead = <Avatar directory={directory} memberId={row.avatarMemberId} size={HOME.rowFace} />;
  } else if (row.isAgent) {
    // 명부에서 상대를 못 찾은 에이전트 줄만 로봇 사각으로 남는다.
    lead = (
      <AgentSquare size={HOME.rowFace} corner={HOME.rowAgentCorner} glyph={HOME.rowAgentGlyph} />
    );
  } else if (row.labelKind === 'gone' || row.labelKind === 'pending') {
    // 상대를 알아볼 수 없는 DM(「나간 멤버」, 명부를 받는 중)은 빈 원이 아니라 기본 아바타다(웹 `DmAvatar` 와 같다, #4252).
    lead = <DefaultFace />;
  } else {
    lead = <View style={styles.faceBlank} />;
  }
  // 상태 점은 얼굴 모서리에 앉는다. 점이 있는 줄만 얼굴 크기의 상자로 감싸므로(점 없는 줄의 구조는 그대로다)
  // 얼굴의 자리는 움직이지 않는다.
  const face =
    status === null ? (
      lead
    ) : (
      <View style={styles.face} testID="home-row-face">
        {lead}
        <View style={styles.statusAnchor}>
          <StatusDot tone={status.tone} testID="home-row-status-dot" />
        </View>
      </View>
    );
  return (
    <Pressable
      accessibilityRole="button"
      // 글자 라벨(「꺼짐」)은 줄에서 뺐다: 상태는 점이 눈에, 이 낭독 라벨이 귀에 말한다.
      accessibilityLabel={
        status === null
          ? row.accessibilityLabel
          : `${row.accessibilityLabel}, ${status.label}`
      }
      accessibilityState={{selected, busy}}
      accessibilityActions={accessibilityActions.length > 0 ? accessibilityActions : undefined}
      onAccessibilityAction={event => {
        const key = channelRowActionKeyOf(event.nativeEvent.actionName);
        if (key !== null && actionTarget !== null) onRunAction(actionTarget, key);
      }}
      onPress={onPress}
      {...longPress.pressTiming}
      onLongPress={longPress.onLongPress}
      {...longPress.handlers}
      style={({pressed}) => [
        styles.row,
        selected && styles.rowSelected,
        pressed && styles.rowPressed,
      ]}
      testID={`sidebar-row-${row.key}`}>
      {face}
      <View style={styles.rowName}>
        <Text
          style={[
            styles.rowTitle,
            emphasis.bold && styles.rowTitleUnread,
            emphasis.dim && styles.rowTitleMuted,
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
      ) : emphasis.chip !== null ? (
        <RowChipView chip={emphasis.chip} />
      ) : null}
    </Pressable>
  );
}

/** 칩마다의 testID. 키가 이름 붙은 숫자(`CHIP_TONE`)라 이 표에는 문자열 비교가 없다. */
const CHIP_TEST_ID: Readonly<Record<ChipTone, string>> = {
  [CHIP_TONE.mention]: 'home-badge-mention',
  [CHIP_TONE.count]: 'home-badge-unread',
  [CHIP_TONE.muted]: 'home-badge-muted',
};

/**
 * 줄 오른쪽의 개수 칩(시안 `.a-badge`). 셋 중 하나다: 멘션은 잉크 `@N`(시안 `.a-badge.at`), 안 읽음은 신호색 `N`, 음소거는
 * 중성으로 흐린 칩(`surfaceMuted` 위 `textMuted`) — 신호색·잉크를 입지 않는다. 칩 둘을 나란히 세우지 않는다: 멘션이 있으면
 * 하나(`@N`)이고 안 읽은 수는 굵은 이름과 낭독 라벨이 함께 진다.
 *
 * 큰 글씨에서 잘리지 않는 이유(구조): 높이·너비는 `minHeight`·`minWidth` 뿐이라 글자가 크면 칩이 **자란다**, 줄어들지 않는
 * flex 자식이라 모자란 폭은 이름(`flexShrink: 1`, 한 줄 말줄임)이 먼저 내준다, 글자는 이름 아닌 컨트롤 글자의 상한
 * (`BAR_CONTROL_MAX_SCALE`)을 따른다.
 */
function RowChipView({chip}: {chip: RowChip}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const box =
    chip.tone === CHIP_TONE.mention
      ? styles.badgeAt
      : chip.tone === CHIP_TONE.muted
        ? styles.badgeMuted
        : null;
  const ink =
    chip.tone === CHIP_TONE.mention
      ? styles.badgeAtText
      : chip.tone === CHIP_TONE.muted
        ? styles.badgeMutedText
        : null;
  return (
    <View style={[styles.badge, box]} testID={CHIP_TEST_ID[chip.tone]}>
      <Text style={[styles.badgeText, ink]} maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
        {chip.glyphs}
      </Text>
    </View>
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
  directory,
  onPress,
  stop,
}: {
  card: WorkingCardModel;
  /** 있으면 에이전트의 프로필 사진이 서고, 없거나 사진이 없으면 로봇 사각이 선다. */
  directory?: Directory;
  onPress: () => void;
  /**
   * 카드 아래에 서는 「취소」 컨트롤 (#4285). 카드는 만들지 않고 자리만 내준다 — 취소는 워크스페이스와
   * react-query를 아는 화면의 일이다(`AgentActivityBar.renderStop`과 같은 이유). 있으면 카드 본문만
   * 대화를 여는 면이 되고, 컨트롤은 그 면 **밖**에 선다(누르는 면 안에 누르는 면을 겹치지 않는다).
   */
  stop?: React.ReactNode;
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
      : card.state === 'queued'
        ? palette.textMuted
        : palette.agent;
  const pulse = card.live && card.state === 'working' && !reduceMotion;
  // 큰 글씨(`STACK_PILL_SCALE`부터)에서는 상태 낱말이 이름 아래 제 줄로 내려간다. 한 줄에 아바타·이름·태그·
  // 낱말이 같이 서면, 새 낱말 「아직 받지 않았어요」(9음절)가 폭을 먹어 이름이 「달…」 한 글자로
  // 잘린다(design-review #4285 r1 H1 — 「김…」 절단을 막으려 건 `BAR_CONTROL_MAX_SCALE` 상한이 못 지킨 폭).
  const {fontScale} = useWindowDimensions();
  const stackLive = fontScale >= STACK_PILL_SCALE;
  const liveNode = (
    <View style={[styles.live, stackLive && styles.liveStacked]} testID="home-working-live">
      <LiveDot pulse={pulse} color={tone} />
      <Text
        style={[styles.liveText, stackLive && styles.liveTextStacked, {color: tone}]}
        maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
        testID="home-working-state">
        {card.liveText}
      </Text>
    </View>
  );
  const body = (
    <>
      <View style={styles.cardTop}>
        {directory ? (
          <Avatar directory={directory} memberId={card.memberId} size={HOME.cardFace} />
        ) : (
          <AgentSquare size={HOME.cardFace} corner={HOME.cardAgentCorner} glyph={HOME_ICON_SIZE.bot} />
        )}
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
        {stackLive ? null : liveNode}
      </View>
      {stackLive ? (
        <View style={styles.liveRow} testID="home-working-live-stack">
          {liveNode}
        </View>
      ) : null}
      {/* 문장이라 어절에서 끊는다(`Sentence`, 리뷰 H1 — 「…상태입 / 니다」). 큰
          글씨에서 한 줄이 두 줄로 잘려 할 일이 사라지지 않게 넷까지 연다(M4). */}
      <Sentence
        style={[styles.cardLine, !card.live && styles.cardLineStale]}
        numberOfLines={4}
        testID="home-working-line">
        {card.place ? <Text style={styles.cardPlace}>{card.place}</Text> : null}
        {card.place && card.headline ? ' · ' : null}
        {card.headline ?? (card.place ? null : '대화')}
        {/* 앞에는 언제나 무엇인가 선다(장소·한 줄, 둘 다 없으면 「대화」). */}
        {card.detail ? ` · ${card.detail}` : null}
        {card.others > 0 ? ` · 그 밖에 ${card.others}건` : null}
      </Sentence>
      {/* 아무도 가져가지 않은 채 N분을 넘은 요청의 이유 한 문장(#4285). 서버 판정에 근거가 있을
          때만 선다 — 근거 없이 「연결이 꺼져 있을 수 있어요」를 말하지 않는다. */}
      {card.reason !== null ? (
        <Sentence style={styles.cardStale} testID="home-working-reason">
          {card.reason}
        </Sentence>
      ) : null}
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
    </>
  );
  if (stop === undefined || stop === null) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={card.accessibilityLabel}
        accessibilityHint="그 대화를 엽니다."
        onPress={onPress}
        style={({pressed}) => [styles.cardPress, pressed && styles.rowPressed]}
        testID="home-working-card">
        <GlassSurface radius={HOME.cardRadius} style={styles.card}>
          {body}
        </GlassSurface>
      </Pressable>
    );
  }
  // 「취소」가 있는 카드: 본문만 대화를 여는 면이고, 컨트롤은 그 면 밖(같은 유리 안, 본문 아래)에
  // 선다. 누르는 면 안에 누르는 면을 겹치면 컨트롤 탭이 대화를 여는 탭과 겨룬다.
  return (
    <View style={styles.cardPress}>
      <GlassSurface radius={HOME.cardRadius} style={[styles.card, styles.cardSplit]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={card.accessibilityLabel}
          accessibilityHint="그 대화를 엽니다."
          onPress={onPress}
          style={({pressed}) => [styles.cardBody, pressed && styles.rowPressed]}
          testID="home-working-card">
          {body}
        </Pressable>
        <View style={styles.cardStop} testID="home-working-card-stop">
          {stop}
        </View>
      </GlassSurface>
    </View>
  );
}

/**
 * 「작업 중」 카드 머리의 「모두 보기」 (ADR-0202 D6, U1 #3842). 카드는 지금 도는 턴 하나만
 * 말하고, 맡긴 일 전부(결과 포함)는 「작업」 화면이 말한다. 카드 자체가 누르는 면이라 이 문은
 * 카드 안이 아니라 그 위의 머리 줄에 선다(누르는 면 안에 누르는 면을 겹치지 않는다).
 */
function WorkSeeAllRow({onPress}: {onPress: () => void}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.workHead}>
      <Text
        accessibilityRole="header"
        style={styles.workHeadLabel}
        // 컨트롤 줄이라 상한이 있다(`BAR_CONTROL_MAX_SCALE`): 가장 큰 글씨에서 「모두 보」로 잘리던 것(캡처가 드러낸 기존
        // 머리 줄의 결함, design-review #4285 r1 M1 증거).
        maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
        testID="home-work-head">
        에이전트 작업
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="에이전트 작업 모두 보기"
        onPress={onPress}
        hitSlop={space.sm}
        style={({pressed}) => [styles.workSeeAll, pressed && styles.rowPressed]}
        testID="home-work-see-all">
        <Text style={styles.workSeeAllLabel} maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
          모두 보기 ›
        </Text>
      </Pressable>
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
  cardNameTracking: -0.155,
  tagRadius: 6,
  tagPadY: 2,
  tagPadX: 6,
  liveGap: 6,
  liveDot: 7,
  pulseMs: 1600,
  pulseLow: 0.35,
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
  rowTracking: -0.17,
  rowFace: 28,
  rowAgentCorner: 9,
  rowAgentGlyph: 16,
  badge: 22,
  badgePadX: 7,
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
    fontSize: font.display,
    fontWeight: '700',
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
  listContent: {paddingTop: HOME.scrollTop, paddingHorizontal: HOME.scrollX, ...PULL_FILL},
  bannerWrap: {paddingBottom: space.sm, paddingHorizontal: HOME.scrollX},
  noticeWrap: {paddingTop: space.md},
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
    fontSize: font.heading,
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
  icon18: {width: HOME_ICON_SIZE.user, height: HOME_ICON_SIZE.user},
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
    fontSize: font.heading,
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
  // 기본 아바타: 점선 테두리 원(웹 `border-dashed border-line-strong`) 안에 사람 윤곽.
  defaultFace: {
    width: HOME.rowFace,
    height: HOME.rowFace,
    borderRadius: HOME.rowFace / 2,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: color.textFaint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 상태 점이 있는 줄의 얼굴 상자(점의 절대 위치 기준). 크기는 얼굴과 같다.
  face: {width: HOME.rowFace, height: HOME.rowFace},
  statusAnchor: {position: 'absolute', right: -2, bottom: -2},
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
  // 음소거한 줄의 칩: 신호색도 잉크도 아닌 중성 채움 위의 흐린 글자. 새 토큰 없이 기존 둘의 조합이라 대비(AA 4.5)는 `home.test.tsx` 의 음소거 시험이 두 스킴에서 잰다.
  badgeMuted: {backgroundColor: color.surfaceMuted},
  badgeText: {fontSize: font.meta, fontWeight: '700', color: color.onAccent},
  badgeAtText: {color: color.onPrimary},
  badgeMutedText: {color: color.textMuted},

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
    fontSize: font.body,
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
  tagText: {fontSize: font.caption, fontWeight: '700', color: color.agent},
  live: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: HOME.liveGap,
  },
  liveDot: {width: HOME.liveDot, height: HOME.liveDot, borderRadius: HOME.liveDot / 2},
  liveText: {fontSize: font.meta, fontWeight: '600'},
  // 큰 글씨: 낱말이 이름 아래 제 줄에 서고(본문 글자 기둥에 맞춘다), 폭이 모자라면 줄을 바꾼다.
  liveRow: {marginLeft: HOME.indent, marginTop: space.xs, flexDirection: 'row'},
  liveStacked: {marginLeft: 0, flexShrink: 1},
  liveTextStacked: {flexShrink: 1},
  cardLine: {
    fontSize: font.label,
    lineHeight: HOME.lineBox,
    color: color.textMuted,
    marginTop: HOME.lineTop,
    marginBottom: HOME.lineBottom,
    marginLeft: HOME.indent,
  },
  cardLineStale: {marginBottom: space.xs},
  cardPlace: {color: color.text, fontWeight: '600'},
  // 끊긴 레일의 문장과 아무도 가져가지 않은 요청의 이유 한 문장(#4285)이 같은 자리·같은 글자를 쓴다.
  cardStale: {
    fontSize: font.meta,
    color: color.textMuted,
    marginLeft: HOME.indent,
    marginBottom: HOME.lineBottom,
  },
  // 「취소」가 있는 카드(#4285): 유리의 안쪽 여백을 본문과 컨트롤 줄이 나눠 갖는다. 본문만 눌리는
  // 면이라 눌림 배경이 카드의 윗모서리를 따른다.
  cardSplit: {paddingTop: 0, paddingHorizontal: 0, paddingBottom: 0},
  cardBody: {
    paddingTop: HOME.cardPadTop,
    paddingHorizontal: HOME.cardPadX,
    paddingBottom: space.xs,
    borderTopLeftRadius: HOME.cardRadius,
    borderTopRightRadius: HOME.cardRadius,
  },
  // 컨트롤 줄이 본문 글자 기둥(`HOME.indent`)에서 시작한다: 확인 문장과 두 단추가 기둥에 서고, 첫 탭의
  // 글자는 상자를 `space.sm` 밀어(`WorkingCardStop` 의 `armFlush`) 같은 기둥에 선다.
  cardStop: {
    paddingRight: HOME.cardPadX,
    paddingLeft: HOME.cardPadX + HOME.indent,
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
  workHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.xs,
  },
  workHeadLabel: {fontSize: font.label, color: color.textMuted, fontWeight: '600'},
  workSeeAll: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
  },
  workSeeAllLabel: {fontSize: font.label, color: color.accentText, fontWeight: '600'},
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
