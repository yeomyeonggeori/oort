import {
  HOSTED_DETAIL_ERROR_HEADLINE,
  HOSTED_LIST_DENIED_DETAIL,
  HOSTED_LIST_DENIED_HEADLINE,
  HOSTED_LIVENESS_NOTE,
  HOSTED_OFFLINE_NOTE,
  HOSTED_READONLY_NOTE,
  HOSTED_STALE_LABEL,
  hostedDetailView,
  type HostedDetailView,
} from '@momo/core/features/hostedAgents/status';
import {isHostedOperatorDenied} from '@momo/core/features/hostedAgents/model';
import {memberNameParts} from '@momo/core/features/workspace/directory';
import React from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {
  ErrorState,
  LoadingState,
  NoticeBlock,
  Screen,
  ScreenHeader,
  SectionLabel,
} from '../design/atoms';
import {font, line, radius, SAFE_GUTTER, space, type Palette} from '../design/tokens';
import {useStyles} from '../design/theme';
import {StatusChip} from '../features/hostedAgents/StatusChip';
import {useHostedConnection} from '../features/hostedAgents/queries';
import {explicitTimeLabel} from '../features/work/model';
import {useDirectory} from '../features/workspace/queries';
import {useOnline} from '../features/inbox/useOnline';
import {useSession} from '../session/useSession';
import {UNKNOWN_AGENT_LABEL} from './HostedConnectionsScreen';
import type {OpenHostedConnection} from '../nav/state';

// =============================================================================
// 한 호스티드 연결 — 상태·시각·정리 목록을 읽기만 한다 (goal HAP-UX3 / #1359).
//
// 이 화면에는 버튼이 하나도 없다(뒤로가기 말고). 해제·정리 확인은 데스크톱의 일이고
// (ADR-0162 out-of-scope), 그래서 정리 목록의 각 줄은 라디오도 저장도 없이 **지금
// 무엇이 남았는지**만 말한다.
//
// ## 「detected ≠ active」와 「provider 를 못 들여다본다」
//
// 상태 문장은 코어가 준다(`hostedStatusDetail`) — 승인만 하고 아직 증명이 안 온
// `detected` 는 활성이 아니라는 그 한 문장이 이 표면의 정직함이다. 시각도 마찬가지다:
// 읽기 모델은 「마지막 상태 변화」만 싣고 실시간 heartbeat 는 싣지 않으므로, 이
// 화면은 그 시각을 정확한 이름으로 세우고 「지금 살아 있는가」를 답하는 척하지 않는다
// (`HOSTED_LIVENESS_NOTE`).
// =============================================================================

export default function HostedConnectionDetailScreen({
  connection,
  onBack,
}: {
  connection: OpenHostedConnection;
  onBack: () => void;
}): React.JSX.Element {
  const {workspaceId} = useSession();
  const detailQuery = useHostedConnection(workspaceId, connection.connectionId);
  const directoryQuery = useDirectory(workspaceId);
  const online = useOnline();

  const agentLabel = memberNameParts(
    directoryQuery.directory,
    connection.agentMemberId,
    connection.title || UNKNOWN_AGENT_LABEL,
  ).name;

  const view =
    detailQuery.data !== undefined
      ? hostedDetailView(detailQuery.data, agentLabel)
      : undefined;
  const denied = isHostedOperatorDenied(detailQuery.error);

  return (
    <HostedConnectionDetailView
      title={connection.title || agentLabel}
      state={
        detailQuery.isPending
          ? 'loading'
          : denied
            ? 'denied'
            : detailQuery.isError || view === undefined
              ? 'error'
              : 'ready'
      }
      view={view}
      offline={!online}
      staleAtMs={detailQuery.dataUpdatedAt}
      onBack={onBack}
      onRetry={() => {
        void detailQuery.refetch();
      }}
    />
  );
}

/**
 * 순수 표현부. 훅 없이 props 만으로 그린다.
 */
export function HostedConnectionDetailView({
  title,
  state,
  view,
  offline,
  staleAtMs,
  onBack,
  onRetry,
}: {
  title: string;
  state: 'loading' | 'denied' | 'error' | 'ready';
  view?: HostedDetailView;
  offline: boolean;
  staleAtMs?: number;
  onBack: () => void;
  onRetry: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Screen>
      <ScreenHeader
        title={title}
        subtitle="호스티드 연결"
        onBack={onBack}
        backLabel="연결 목록으로"
        titleTestID="hosted-detail-title"
      />
      <ScrollView
        contentContainerStyle={styles.body}
        testID="hosted-detail-scroll">
        {offline && (state === 'ready' || state === 'error') ? (
          <NoticeBlock
            headline={HOSTED_OFFLINE_NOTE}
            detail={
              staleAtMs && staleAtMs > 0
                ? `${HOSTED_STALE_LABEL}: ${explicitTimeLabel(staleAtMs)}`
                : undefined
            }
            testID="hosted-detail-offline"
          />
        ) : null}

        {state === 'loading' ? (
          <LoadingState
            label="연결 상태를 불러오는 중입니다."
            testID="hosted-detail-loading"
          />
        ) : state === 'denied' ? (
          <NoticeBlock
            headline={HOSTED_LIST_DENIED_HEADLINE}
            detail={HOSTED_LIST_DENIED_DETAIL}
            testID="hosted-detail-denied"
          />
        ) : state === 'error' || view === undefined ? (
          <ErrorState
            headline={HOSTED_DETAIL_ERROR_HEADLINE}
            detail="지금 이 연결이 어떤 상태인지 알 수 없습니다."
            onRetry={onRetry}
            testID="hosted-detail-error"
          />
        ) : (
          <Ready view={view} />
        )}
      </ScrollView>
    </Screen>
  );
}

function Ready({view}: {view: HostedDetailView}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View>
      {/* ---- 상태 ------------------------------------------------------- */}
      <SectionLabel label="상태" />
      <View
        style={styles.card}
        accessible
        accessibilityLabel={`${view.statusLabel}. ${view.statusDetail}`}
        testID="hosted-detail-status">
        <StatusChip
          tone={view.statusTone}
          label={view.statusLabel}
          testID="hosted-detail-status-chip"
        />
        <Text style={styles.sentence}>{view.statusDetail}</Text>
      </View>
      <Text style={styles.footnote}>{HOSTED_READONLY_NOTE}</Text>

      {/* ---- 연결 ------------------------------------------------------- */}
      <SectionLabel label="연결" />
      <View style={styles.card} testID="hosted-detail-facts">
        {view.facts.map(fact => (
          <Field key={fact.key} label={fact.key} value={fact.value} />
        ))}
      </View>

      {/* ---- 시각 ------------------------------------------------------- */}
      <SectionLabel label="시각" />
      <View style={styles.card} testID="hosted-detail-times">
        {view.times.map(time => (
          <Field
            key={time.label}
            label={time.label}
            value={explicitTimeLabel(time.atMs)}
          />
        ))}
        <Text style={styles.meta}>{HOSTED_LIVENESS_NOTE}</Text>
      </View>

      {/* ---- 정리 목록 -------------------------------------------------- */}
      <SectionLabel label="정리 목록" />
      <View style={styles.progress} testID="hosted-detail-progress">
        <Text style={styles.sentence}>{view.progressSentence}</Text>
        {view.hasCleanup ? (
          <Text
            style={styles.meta}
            testID="hosted-detail-unresolved-count">
            {`미확인 필수 ${view.progress.remainingRequired}개 · 전체 ${view.progress.total}개`}
          </Text>
        ) : null}
      </View>
      {view.rows.map(row => (
        <View
          key={row.id}
          style={styles.artifactRow}
          accessible
          accessibilityLabel={`${row.title}, ${row.stateLabel}. ${row.detail}`}
          testID={`hosted-artifact-${row.id}`}>
          <View style={styles.artifactHead}>
            <Text
              style={styles.artifactTitle}
              numberOfLines={2}
              ellipsizeMode="tail">
              {row.title}
            </Text>
            <StatusChip
              tone={row.tone}
              label={row.stateLabel}
              testID={`hosted-artifact-chip-${row.id}`}
            />
          </View>
          <Text style={styles.meta}>{row.detail}</Text>
          {row.evidence ? (
            <Text style={styles.evidence} testID={`hosted-artifact-evidence-${row.id}`}>
              {row.evidence}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function Field({label, value}: {label: string; value: string}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue}>{value}</Text>
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    body: {paddingBottom: space.xl},
    card: {
      marginHorizontal: SAFE_GUTTER,
      padding: space.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.surface,
      gap: space.sm,
    },
    sentence: {fontSize: font.label, color: color.text, lineHeight: line.label},
    meta: {fontSize: font.meta, color: color.textMuted, lineHeight: line.meta},
    footnote: {
      marginHorizontal: SAFE_GUTTER,
      marginTop: space.sm,
      fontSize: font.meta,
      color: color.textFaint,
      lineHeight: line.meta,
    },
    field: {gap: space.xs},
    fieldLabel: {fontSize: font.meta, color: color.textFaint},
    fieldValue: {fontSize: font.label, color: color.text, lineHeight: line.label},
    progress: {
      marginHorizontal: SAFE_GUTTER,
      marginTop: space.sm,
      marginBottom: space.sm,
      gap: space.xs,
    },
    artifactRow: {
      marginHorizontal: SAFE_GUTTER,
      marginBottom: space.sm,
      padding: space.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.surface,
      gap: space.xs,
    },
    artifactHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: space.sm,
    },
    artifactTitle: {
      fontSize: font.label,
      color: color.text,
      fontWeight: '600',
      flex: 1,
    },
    evidence: {
      fontSize: font.meta,
      color: color.textMuted,
      lineHeight: line.meta,
      fontStyle: 'italic',
    },
  });
