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
  agentRowMeta,
  buildAgentRows,
  type AgentRow,
} from '../features/agents/rows';
import {useAgentProfiles, useWorkSessions} from '../features/agents/queries';
import {useChannels, useDirectory} from '../features/workspace/queries';
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
          renderItem={({item}) => <Row row={item} onPress={() => onOpenAgent(item)} />}
          contentContainerStyle={styles.listContent}
          testID="agents-list"
        />
      )}
    </Screen>
  );
}

function Row({
  row,
  onPress,
}: {
  row: AgentRow;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <TapRow
      accessibilityLabel={row.accessibilityLabel}
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
      {/* NOT 「작업 중」. That is the web's word for an open realtime TURN, and
          this pill is reading the work-session ledger — a different fact that
          diverges in both directions (R1 High-2). The core owns the string so
          the two clients cannot drift back together by accident. */}
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
