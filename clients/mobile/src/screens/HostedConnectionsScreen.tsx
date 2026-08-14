import {
  HOSTED_LIST_DENIED_DETAIL,
  HOSTED_LIST_DENIED_HEADLINE,
  HOSTED_LIST_EMPTY_DETAIL,
  HOSTED_LIST_EMPTY_HEADLINE,
  HOSTED_LIST_ERROR_HEADLINE,
  HOSTED_LIST_LEAD,
  HOSTED_OFFLINE_NOTE,
  HOSTED_READONLY_NOTE,
  HOSTED_STALE_LABEL,
  hostedListRow,
  type HostedListRow,
} from '@momo/core/features/hostedAgents/status';
import {isHostedOperatorDenied} from '@momo/core/features/hostedAgents/model';
import {memberFor, memberNameParts} from '@momo/core/features/workspace/directory';
import React, {useCallback, useMemo} from 'react';
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
import {useRefreshControl} from '../design/refresh';
import {font, line, SAFE_GUTTER, space, type Palette} from '../design/tokens';
import {useStyles} from '../design/theme';
import {StatusChip} from '../features/hostedAgents/StatusChip';
import {useHostedConnections} from '../features/hostedAgents/queries';
import {explicitTimeLabel} from '../features/work/model';
import {useDirectory} from '../features/workspace/queries';
import {useOnline} from '../features/inbox/useOnline';
import {useSession} from '../session/useSession';
import type {OpenHostedConnection} from '../nav/state';

// =============================================================================
// 호스티드 연결 목록 — 폰이 이 연결들을 처음 보는 자리 (goal HAP-UX3 / #1359).
//
// 관전 표면이다. 여기서 만들지도, 해제하지도, 정리를 확인하지도 않는다 — 그 일들은
// 데스크톱에서 하고, 이 화면은 그 말을 상단에 한 번 한다(`HOSTED_READONLY_NOTE`).
//
// ## 네 상태 + 권한 + 오프라인
//
// 로딩·오류·빈 목록·데이터는 다른 화면과 같은 어휘로 갈린다. 여기에 둘이 더 있다:
//   * 권한 — 목록은 owner/admin 만 볼 수 있어 일반 멤버에게는 403 이다. 그것은
//     장애가 아니라 답이라 붉은 오류가 아니라 `NoticeBlock` 으로 선다.
//   * 오프라인 — 끊긴 화면과 살아 있는 화면은 다르다. 캐시된 목록을 그릴 때 그것이
//     캐시임을 말하고, 마지막으로 확인한 시각을 붙인다.
// =============================================================================

export default function HostedConnectionsScreen({
  onBack,
  onOpenConnection,
}: {
  onBack: () => void;
  onOpenConnection: (connection: OpenHostedConnection) => void;
}): React.JSX.Element {
  const {workspaceId} = useSession();
  const connectionsQuery = useHostedConnections(workspaceId);
  const directoryQuery = useDirectory(workspaceId);
  const online = useOnline();

  const rows = useMemo<HostedRowItem[]>(() => {
    const connections = connectionsQuery.data ?? [];
    return connections.map(connection => {
      const parts = memberNameParts(
        directoryQuery.directory,
        connection.agentMemberId,
        UNKNOWN_AGENT_LABEL,
      );
      const member = memberFor(directoryQuery.directory, connection.agentMemberId);
      return {
        row: hostedListRow(connection, parts.name),
        handle: member?.handle ?? null,
      };
    });
  }, [connectionsQuery.data, directoryQuery.directory]);

  const refetch = connectionsQuery.refetch;
  const refreshControl = useRefreshControl(
    useCallback(() => refetch().then(() => undefined), [refetch]),
    'hosted-connections-refresh',
  );

  const denied = isHostedOperatorDenied(connectionsQuery.error);

  return (
    <HostedConnectionsView
      state={
        connectionsQuery.isPending
          ? 'loading'
          : denied
            ? 'denied'
            : connectionsQuery.isError
              ? 'error'
              : 'ready'
      }
      rows={rows}
      offline={!online}
      staleAtMs={connectionsQuery.dataUpdatedAt}
      onBack={onBack}
      onRetry={() => {
        void connectionsQuery.refetch();
      }}
      onOpenConnection={onOpenConnection}
      refreshControl={refreshControl}
    />
  );
}

export const UNKNOWN_AGENT_LABEL = '이름 확인 안 됨';

export interface HostedRowItem {
  row: HostedListRow;
  handle: string | null;
}

/**
 * 순수 표현부. 훅 없이 props 로만 그린다 — 테스트가 상태·오프라인·비밀 노출을
 * 프로바이더 없이 직접 검사할 수 있게 한다.
 */
export function HostedConnectionsView({
  state,
  rows,
  offline,
  staleAtMs,
  onBack,
  onRetry,
  onOpenConnection,
  refreshControl,
}: {
  state: 'loading' | 'denied' | 'error' | 'ready';
  rows: HostedRowItem[];
  offline: boolean;
  staleAtMs?: number;
  onBack: () => void;
  onRetry: () => void;
  onOpenConnection: (connection: OpenHostedConnection) => void;
  refreshControl?: React.ComponentProps<typeof EmptyState>['refreshControl'];
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Screen>
      <ScreenHeader
        title="호스티드 연결"
        subtitle="다른 인프라의 에이전트"
        onBack={onBack}
        backLabel="에이전트로"
        titleTestID="hosted-list-title"
      />
      {offline && (state === 'ready' || state === 'error') ? (
        <NoticeBlock
          headline={HOSTED_OFFLINE_NOTE}
          detail={
            staleAtMs && staleAtMs > 0
              ? `${HOSTED_STALE_LABEL}: ${explicitTimeLabel(staleAtMs)}`
              : undefined
          }
          testID="hosted-list-offline"
        />
      ) : null}

      {state === 'loading' ? (
        <LoadingState
          label="호스티드 연결을 불러오는 중입니다."
          testID="hosted-list-loading"
        />
      ) : state === 'denied' ? (
        <NoticeBlock
          headline={HOSTED_LIST_DENIED_HEADLINE}
          detail={HOSTED_LIST_DENIED_DETAIL}
          testID="hosted-list-denied"
        />
      ) : state === 'error' ? (
        <ErrorState
          headline={HOSTED_LIST_ERROR_HEADLINE}
          detail="지금 어떤 연결이 있는지 알 수 없습니다."
          onRetry={onRetry}
          testID="hosted-list-error"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          headline={HOSTED_LIST_EMPTY_HEADLINE}
          detail={HOSTED_LIST_EMPTY_DETAIL}
          refreshControl={refreshControl}
          testID="hosted-list-empty"
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={item => item.row.connectionId}
          ListHeaderComponent={
            <View style={styles.lead}>
              <Text style={styles.leadText}>{HOSTED_LIST_LEAD}</Text>
              <Text style={styles.readonlyText}>{HOSTED_READONLY_NOTE}</Text>
            </View>
          }
          renderItem={({item}) => (
            <Row item={item} onPress={() => onOpenConnection(toOpen(item))} />
          )}
          contentContainerStyle={styles.listContent}
          refreshControl={refreshControl}
          testID="hosted-list"
        />
      )}
    </Screen>
  );
}

function toOpen(item: HostedRowItem): OpenHostedConnection {
  return {
    connectionId: item.row.connectionId,
    agentMemberId: item.row.agentMemberId,
    title: item.row.title,
  };
}

function Row({
  item,
  onPress,
}: {
  item: HostedRowItem;
  onPress: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {row, handle} = item;
  // The whole row is one accessibility element: title, handle, status word, and
  // the status sentence read as one utterance rather than four silent children.
  const label = `${row.title}${handle ? `, @${handle}` : ''}, ${row.statusLabel}. ${row.statusDetail}`;
  return (
    <TapRow
      accessibilityLabel={label}
      onPress={onPress}
      testID={`hosted-row-${row.connectionId}`}>
      <View style={styles.rowText}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowTitle} numberOfLines={1} ellipsizeMode="tail">
            {row.title}
          </Text>
          {handle ? (
            <Text style={styles.rowHandle} numberOfLines={1}>
              @{handle}
            </Text>
          ) : null}
        </View>
        <Text style={styles.rowDetail} numberOfLines={2}>
          {row.statusDetail}
        </Text>
      </View>
      <StatusChip
        tone={row.statusTone}
        label={row.statusLabel}
        testID={`hosted-row-chip-${row.connectionId}`}
      />
    </TapRow>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    listContent: {paddingBottom: space.lg},
    lead: {
      paddingHorizontal: SAFE_GUTTER,
      paddingTop: space.md,
      paddingBottom: space.sm,
      gap: space.xs,
    },
    leadText: {fontSize: font.label, color: color.textMuted, lineHeight: line.label},
    readonlyText: {fontSize: font.meta, color: color.textFaint, lineHeight: line.meta},
    rowText: {flex: 1, gap: space.xs},
    rowTitleLine: {flexDirection: 'row', alignItems: 'center', gap: space.xs},
    rowTitle: {fontSize: font.body, color: color.agent, flexShrink: 1},
    rowHandle: {fontSize: font.meta, color: color.textFaint, flexShrink: 1},
    rowDetail: {fontSize: font.meta, color: color.textMuted, lineHeight: line.meta},
  });
