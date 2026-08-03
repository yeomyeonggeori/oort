import React, {useMemo} from 'react';
import {FlatList, StyleSheet, Text, View} from 'react-native';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NoticeBlock,
  Screen,
  ScreenHeader,
  TapRow,
} from '../design/atoms';
import {color, font, radius, space} from '../design/tokens';
import {RUNNING_SESSION_PILL} from '@momo/core/features/agents/agentOps';
import {
  agentTurnBadgeCopy,
  UNKNOWN_AGENT_NAME,
} from '@momo/core/features/agents/turnCopy';
import {memberNameParts} from '@momo/core/features/workspace/directory';
import {
  agentRowMeta,
  buildAgentRows,
  type AgentRow,
} from '../features/agents/rows';
import {useAgentProfiles, useWorkSessions} from '../features/agents/queries';
import {
  AgentTurnBadge,
  TURN_STALE_SENTENCE,
} from '../features/agents/turnSurfaces';
import {
  agentTurnsForMember,
  useAgentWorkingSignals,
} from '../features/agents/workingSignal';
import {useChannels, useDirectory} from '../features/workspace/queries';
import {useRealtime} from '../realtime/RealtimeProvider';
import {useSession} from '../session/useSession';
import {queryFailureDetail} from './SidebarScreen';

// =============================================================================
// 에이전트 — everyone in this workspace who is not a person.
//
// This tab is the whole point of goal RN-A1. Before it, the phone could talk to
// an agent and nothing else: no way to see whether it was awake, what it was
// doing, or where it could be reached. That is a chat with a bot in it, which is
// the shape ADR-0101 refused; the server has carried the other half for months
// (진단 2026-08-03: agents 7경로 · work-sessions 5경로, 모바일 표면 0).
//
// ## Agents are members, and this list proves it rather than working around it
//
// The rows come from `GET …/roster` with no agent-specific list endpoint
// anywhere in sight (하드 불변식: 에이전트=member). `agentMembers` — the web
// hub's own filter — decides which roster rows land here, so the two clients
// cannot disagree about who exists.
//
// ## What a row can and cannot say
//
// 상태 needs a SECOND request per agent, because the roster carries no pause
// state (measured on `server-rust`). That request is authorised per agent, so
// for an ordinary member some rows honestly read 상태를 볼 수 없음 rather than
// pretending to know. The list is not blocked on any of it: a name and its
// channels are already useful, and a screen that waits for a permission it will
// never get is a screen that never loads.
//
// ## 작업 중, at last — and still not the same fact as 세션 실행 중 (goal RN-T2)
//
// #980 left this screen able to say 세션 실행 중 and nothing more, with a note
// saying 작업 중 was the web's word for an open realtime TURN "which this client
// cannot observe". `AgentWorkingRail` observes it now, so the word arrives — and
// the two stay side by side rather than merging, because they diverge in both
// directions: a running work session with no open turn is an idle terminal, and
// an open turn with no session is an agent answering a message. Merging them
// would make each one wrong half the time.
//
// The badge is 승인 대기 whenever any of this agent's turns is parked on a
// decision, which is the ONE state on this row a person has to act on. It is
// never 작업 중: an indicator that treats the two alike tells the reader to wait
// for the agent while the agent is waiting for the reader.
// =============================================================================

export default function AgentsScreen({
  onOpenAgent,
}: {
  onOpenAgent: (agent: {
    memberId: string;
    displayName: string;
    handle: string;
  }) => void;
}): React.JSX.Element {
  const {workspaceId} = useSession();
  const directoryQuery = useDirectory(workspaceId);
  const channelsQuery = useChannels(workspaceId);
  const sessionsQuery = useWorkSessions(workspaceId);

  const members = directoryQuery.directory.members;
  const agentIds = useMemo(
    () => members.filter(member => member.kind === 'agent').map(member => member.id),
    [members],
  );
  const profiles = useAgentProfiles(workspaceId, agentIds);

  const rows = useMemo(
    () =>
      buildAgentRows({
        members,
        channels: channelsQuery.groups.channels,
        dms: channelsQuery.groups.dms,
        profiles,
        sessions: sessionsQuery.data,
      }),
    [members, channelsQuery.groups, profiles, sessionsQuery.data],
  );

  // The ROSTER is this list. Without it there are no rows at all, so its failure
  // is the screen's failure — unlike the ledger, which only costs the 작업 진행
  // 중 fragment and says so on its own line.
  const loading = directoryQuery.isLoading;
  const failed = directoryQuery.isError;

  // ---- the live half (goal RN-T2) ------------------------------------------
  // No ticking clock here, deliberately — unlike the conversation screen, which
  // prints an elapsed number and therefore needs one.
  //
  // This row prints WORDS only (`agentTurnBadgeCopy` carries no digits; that is
  // a measurement the web sidebar made about a 240px row and the phone inherits
  // the shape). What it needs is a render whenever the truth changed, and the
  // store already causes one on every publish and every clear. The TTL still has
  // to be applied at render time, which the wall clock read here does for free.
  //
  // The one gap a 1Hz tick would close — a signal aging past the TTL while the
  // store sits quiet — is closed by the rail's own 15s sweep, which deletes the
  // entry and emits. This tab stays MOUNTED behind the other two once visited,
  // so a per-second re-render of the whole list would run forever, in the
  // background of a screen nobody is looking at, to shave a window off a word
  // that would not change.
  const signals = useAgentWorkingSignals();
  const {status: railStatus} = useRealtime();
  const nowMs = Date.now();
  const railLive = railStatus === 'connected';

  return (
    <Screen>
      <ScreenHeader
        title="에이전트"
        subtitle="이 워크스페이스에서 일하는 에이전트"
        titleTestID="agents-title"
      />

      {sessionsQuery.isError && !failed ? (
        <NoticeBlock
          headline="작업 세션은 불러오지 못했습니다."
          detail="목록과 상태는 그대로입니다. 실행 중인 세션만 지금 알 수 없습니다."
          testID="agent-sessions-error"
        />
      ) : null}

      {loading ? (
        <LoadingState
          label="에이전트 목록을 불러오는 중입니다."
          testID="agents-loading"
        />
      ) : failed ? (
        <ErrorState
          headline="에이전트를 불러오지 못했습니다."
          detail={queryFailureDetail(directoryQuery.error)}
          onRetry={() => {
            void directoryQuery.refetch();
          }}
          testID="agents-error"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          headline="아직 에이전트가 없습니다."
          detail="에이전트를 만드는 것은 데스크톱에서 할 수 있습니다."
          testID="agents-empty"
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={row => row.key}
          renderItem={({item}) => (
            <Row
              row={item}
              turn={agentTurnBadgeCopy(
                agentTurnsForMember(signals, item.memberId, nowMs),
                memberId =>
                  memberNameParts(
                    directoryQuery.directory,
                    memberId,
                    UNKNOWN_AGENT_NAME,
                  ),
              )}
              railLive={railLive}
              onPress={() => onOpenAgent(item)}
            />
          )}
          contentContainerStyle={styles.listContent}
          testID="agents-list"
        />
      )}
    </Screen>
  );
}

function Row({
  row,
  turn,
  railLive,
  onPress,
}: {
  row: AgentRow;
  /** The one open turn this agent has, in words, or null when it has none. */
  turn: ReturnType<typeof agentTurnBadgeCopy>;
  railLive: boolean;
  onPress: () => void;
}): React.JSX.Element {
  // The turn sentence is folded into the ROW's label, not left on the badge.
  // `TapRow` is a `Pressable` with its own `accessibilityLabel`, so its subtree
  // is one accessibility element and nothing inside it is announced separately —
  // a badge that only labelled itself would be silent. Same reason the ledger's
  // 작업 세션 count already rides `agentRowMeta` rather than its own pill.
  const label = turn
    ? `${row.accessibilityLabel}, ${
        railLive ? turn.label : `${turn.label} ${TURN_STALE_SENTENCE}`
      }`
    : row.accessibilityLabel;
  return (
    <TapRow
      accessibilityLabel={label}
      onPress={onPress}
      testID={`agent-row-${row.memberId}`}>
      {/* The same mark the sidebar uses for an agent: the agent colour, on a
          dot rather than on an icon nobody has a name for. A row that looked
          like a person's would undo the one distinction this screen is for. */}
      <View style={[styles.dot, row.paused === true && styles.dotPaused]} />
      <View style={styles.rowText}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowTitle} numberOfLines={1} ellipsizeMode="tail">
            {row.displayName}
          </Text>
          <Text style={styles.rowHandle} numberOfLines={1}>
            @{row.handle}
          </Text>
        </View>
        <Text style={styles.rowMeta} numberOfLines={2}>
          {agentRowMeta(row)}
        </Text>
      </View>
      {/* Two pills, two facts, side by side and never merged.

          작업 중 / 승인 대기 is the open realtime TURN (this rail). 세션 실행 중
          is the work-session ledger. They diverge in both directions — an idle
          terminal is a session with no turn, and an agent answering a message is
          a turn with no session — so a row that showed only one of them would be
          wrong half the time. The core owns both strings, which is what stops
          the phone and the web from drifting into different words for them. */}
      {turn ? (
        <AgentTurnBadge
          state={turn.state}
          text={turn.text}
          label={turn.label}
          live={railLive}
          testID={`agent-turn-${row.memberId}`}
        />
      ) : null}
      {row.runningCount > 0 ? (
        <View style={styles.workingPill}>
          <Text style={styles.workingPillText}>{RUNNING_SESSION_PILL}</Text>
        </View>
      ) : null}
    </TapRow>
  );
}

const styles = StyleSheet.create({
  listContent: {paddingBottom: space.lg},
  dot: {
    width: 10,
    height: 10,
    marginHorizontal: 4,
    borderRadius: radius.pill,
    backgroundColor: color.agent,
  },
  // 재워진 에이전트는 색이 빠진다. 상태 문구가 이미 말하고 있으므로 이것은
  // 두 번째 신호이지 유일한 신호가 아니다 — 색만으로 말하지 않는다.
  dotPaused: {backgroundColor: color.textFaint},
  rowText: {flex: 1, gap: 2},
  rowTitleLine: {flexDirection: 'row', alignItems: 'center', gap: space.xs},
  rowTitle: {fontSize: font.body, color: color.agent, flexShrink: 1},
  rowHandle: {fontSize: font.meta, color: color.textFaint, flexShrink: 1},
  rowMeta: {fontSize: font.meta, color: color.textMuted, lineHeight: 17},
  workingPill: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: color.okSurface,
    borderWidth: 1,
    borderColor: color.okBorder,
  },
  workingPillText: {fontSize: font.meta, color: color.ok, fontWeight: '600'},
});
