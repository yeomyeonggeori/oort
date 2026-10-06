import type {SharedWorkSession} from '@momo/core/lib/api';
import {
  TEAM_BOARD_COPY,
  channelLabel,
  diffFacts,
  harnessLabel,
  isRunItem,
  prFacts,
  sessionTitle,
  stageMarkers,
  stateSentence,
  whereLabel,
} from '@momo/core/features/workbench/teamBoard';
import React from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {BAR_CONTROL_MAX_SCALE} from '../../../design/atoms';
import {PageSheet, usePageSheetClose} from '../../../design/PageSheet';
import {useStyles} from '../../../design/theme';
import {
  ds2Radius,
  font,
  line,
  radius,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../../design/tokens';
import {LaneLabel, StateChip} from './TeamBoardParts';

// =============================================================================
// 세션 상세 시트 (#2864, 제안서 §4.3·T12, 웹 `TeamBoardDrawer`의 폰 짝).
//
// **큐레이션된 읽기 전용 뷰다.** 이 파일에는 터미널(PTY·관전·attach), 입력 칸, 멈춤·허락
// 단추가 없고 그것들을 끌어오는 import도 없다(소스 시험이 import를 잠근다). 공유 세션은
// 서버가 모든 컨트롤을 거부한다(ADR-0190 D4). 행동은 대화에서 한다: 바닥에는 집 채널로
// 가는 이동 하나뿐이다.
//
// 보이는 것은 서버가 준 S1 필드뿐이다: 레인, 이름, 주인·하네스·저장소/브랜치, 상태 문장,
// 단계 표지, 커밋·diff 숫자, PR. 커밋 제목은 어느 길로도 오지 않는다(Q2).
// =============================================================================

export function TeamBoardDetailSheet({
  item,
  nowMs,
  onClose,
  onOpenChannel,
  onOpenAgentSession,
}: {
  item: SharedWorkSession;
  nowMs: number;
  onClose: () => void;
  onOpenChannel: (channelId: string) => void;
  /**
   * 내가 시킨 에이전트 세션을 기존 에이전트 세션 화면으로 연다. 그 화면이 허락 서명 같은
   * 컨트롤을 쥐고 있으므로(#3128), 이 시트는 그곳으로 **이동**할 뿐 컨트롤을 들이지 않는다.
   * 주지 않으면 이동 행이 없다.
   */
  onOpenAgentSession?: (sessionId: string) => void;
}): React.JSX.Element {
  return (
    <PageSheet
      onClose={onClose}
      accessibilityLabel={TEAM_BOARD_COPY.drawerLabel}
      testID="team-detail-sheet">
      <SheetBody
        item={item}
        nowMs={nowMs}
        onClose={onClose}
        onOpenChannel={onOpenChannel}
        onOpenAgentSession={onOpenAgentSession}
      />
    </PageSheet>
  );
}

function SheetBody({
  item,
  nowMs,
  onClose,
  onOpenChannel,
  onOpenAgentSession,
}: {
  item: SharedWorkSession;
  nowMs: number;
  onClose: () => void;
  onOpenChannel: (channelId: string) => void;
  onOpenAgentSession?: (sessionId: string) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const slideClose = usePageSheetClose() ?? onClose;
  const where = whereLabel(item);
  const whereText = [where.primary, where.secondary]
    .filter((part): part is string => part !== null)
    .join(' / ');
  const facts = diffFacts(item.diff);
  const markers = stageMarkers(item);
  const pr = prFacts(item.prUrl);
  const channel = channelLabel(item);
  const logParts =
    facts === null
      ? []
      : [
          facts.commits !== null ? `커밋 ${facts.commits}개` : null,
          facts.added !== null && facts.deleted !== null
            ? `+${facts.added} −${facts.deleted}`
            : null,
          facts.files !== null ? `파일 ${facts.files}` : null,
        ].filter((part): part is string => part !== null);

  return (
    <View style={styles.root}>
      <View style={styles.nav}>
        <View style={styles.navSide} />
        <Text
          accessibilityRole="header"
          style={styles.navTitle}
          numberOfLines={1}
          maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
          {TEAM_BOARD_COPY.drawerLabel}
        </Text>
        <View style={[styles.navSide, styles.navSideEnd]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={TEAM_BOARD_COPY.drawerClose}
            onPress={slideClose}
            style={({pressed}) => [styles.navButton, pressed && styles.pressed]}
            testID="team-detail-close">
            <Text style={styles.navButtonLabel}>
              {TEAM_BOARD_COPY.drawerClose}
            </Text>
          </Pressable>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.content,
          {paddingBottom: insets.bottom + space.xl},
        ]}
        testID="team-detail-scroll">
        <View style={styles.head}>
          <LaneLabel item={item} testID="team-detail-lane" />
          <Text style={styles.title} testID="team-detail-title">
            {sessionTitle(item)}
          </Text>
          <Text style={styles.meta} testID="team-detail-meta">
            {item.owner.displayName} · {harnessLabel(item)}
          </Text>
          {whereText !== '' ? (
            <Text style={styles.where} testID="team-detail-where">
              {whereText}
            </Text>
          ) : null}
          <View style={styles.stateLine}>
            <StateChip item={item} testID="team-detail-state" />
            <Text style={styles.stateSentence} testID="team-detail-sentence">
              {stateSentence(item, nowMs)}
            </Text>
          </View>
        </View>

        {markers.length > 0 ? (
          <Section heading={TEAM_BOARD_COPY.progressHeading}>
            <View style={styles.stages} testID="team-detail-stages">
              {markers.map((marker, index) => (
                <View
                  key={`${index}-${marker.label}`}
                  accessible
                  accessibilityLabel={`${marker.tone === 'current' ? '지금 단계' : '지난 단계'}, ${marker.label}`}
                  style={styles.stage}>
                  <View
                    style={[
                      styles.stageDot,
                      marker.tone === 'current' && styles.stageDotCurrent,
                    ]}
                  />
                  <Text style={styles.stageLabel}>{marker.label}</Text>
                </View>
              ))}
            </View>
          </Section>
        ) : null}

        {logParts.length > 0 ? (
          <Section
            heading={TEAM_BOARD_COPY.logHeading}
            hint={TEAM_BOARD_COPY.logHint}>
            <Text style={styles.log} testID="team-detail-log">
              {logParts.join(' · ')}
            </Text>
          </Section>
        ) : null}

        <Section heading={TEAM_BOARD_COPY.resultHeading}>
          {pr !== null ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={`${pr.number}, ${pr.repo}, 브라우저에서 열기`}
              onPress={() => void Linking.openURL(pr.href)}
              style={({pressed}) => [styles.card, pressed && styles.pressed]}
              testID="team-detail-pr">
              <Text style={styles.cardTitle}>{pr.number}</Text>
              <Text style={styles.cardSub}>{pr.repo}</Text>
            </Pressable>
          ) : (
            <View style={styles.card} testID="team-detail-no-pr">
              <Text style={styles.cardTitle}>{TEAM_BOARD_COPY.noPr}</Text>
              <Text style={styles.cardSub}>
                {isRunItem(item)
                  ? TEAM_BOARD_COPY.runNoPrBody
                  : TEAM_BOARD_COPY.noPrBody}
              </Text>
            </View>
          )}
        </Section>

        <Text style={styles.terminalNote} testID="team-detail-terminal-note">
          {isRunItem(item)
            ? TEAM_BOARD_COPY.runNote
            : TEAM_BOARD_COPY.terminalNote}
        </Text>

        {/* 행동은 대화에서 한다. 바닥에는 이동만 있다. */}
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${channel}에서 보기`}
            onPress={() => onOpenChannel(item.homeChannel.id)}
            style={({pressed}) => [styles.action, pressed && styles.pressed]}
            testID="team-detail-open-channel">
            <Text style={styles.actionLabel} numberOfLines={1}>
              {channel}에서 보기
            </Text>
          </Pressable>
          {onOpenAgentSession !== undefined && item.origin === 'host' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="내 에이전트 세션 화면으로 이동"
              onPress={() => onOpenAgentSession(item.sessionId)}
              style={({pressed}) => [styles.action, pressed && styles.pressed]}
              testID="team-detail-open-agent-session">
              <Text style={styles.actionLabel} numberOfLines={1}>
                내 에이전트 세션 화면
              </Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function Section({
  heading,
  hint,
  children,
}: {
  heading: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.sectionHeading}>
        {heading}
        {hint !== undefined ? (
          <Text style={styles.sectionHint}>{`  ${hint}`}</Text>
        ) : null}
      </Text>
      {children}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {flex: 1},
    nav: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: TOUCH_TARGET + space.md,
      paddingHorizontal: space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: color.border,
    },
    navSide: {flex: 1, flexDirection: 'row'},
    navSideEnd: {justifyContent: 'flex-end'},
    navTitle: {
      flexShrink: 1,
      fontSize: font.body,
      fontWeight: '600',
      color: color.text,
      textAlign: 'center',
    },
    navButton: {
      minHeight: TOUCH_TARGET,
      justifyContent: 'center',
      paddingHorizontal: space.sm,
      borderRadius: radius.sm,
    },
    navButtonLabel: {
      fontSize: font.body,
      color: color.accentText,
      fontWeight: '600',
    },
    pressed: {backgroundColor: color.surfacePressed},
    content: {paddingTop: space.lg, gap: space.lg},
    head: {paddingHorizontal: SAFE_GUTTER, gap: space.sm},
    title: {
      fontSize: font.heading,
      lineHeight: line.body,
      fontWeight: '700',
      color: color.text,
    },
    meta: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
    where: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.text,
      fontVariant: ['tabular-nums'],
    },
    stateLine: {gap: space.sm, alignItems: 'flex-start'},
    stateSentence: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.text,
    },
    section: {paddingHorizontal: SAFE_GUTTER, gap: space.sm},
    sectionHeading: {
      fontSize: font.label,
      lineHeight: line.label,
      fontWeight: '600',
      color: color.textMuted,
    },
    sectionHint: {fontWeight: '400', color: color.textMuted},
    stages: {gap: space.sm},
    stage: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
    stageDot: {
      width: 8,
      height: 8,
      borderRadius: radius.pill,
      backgroundColor: color.textFaint,
    },
    stageDotCurrent: {backgroundColor: color.accent},
    stageLabel: {
      flex: 1,
      fontSize: font.body,
      lineHeight: line.body,
      color: color.text,
    },
    log: {
      fontSize: font.body,
      lineHeight: line.body,
      color: color.text,
      fontVariant: ['tabular-nums'],
    },
    card: {
      gap: space.xs,
      paddingHorizontal: space.md,
      paddingVertical: space.md,
      minHeight: TOUCH_TARGET,
      borderRadius: ds2Radius.row,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
      backgroundColor: color.surface,
    },
    cardTitle: {
      fontSize: font.body,
      lineHeight: line.body,
      fontWeight: '600',
      color: color.text,
    },
    cardSub: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
    terminalNote: {
      marginHorizontal: SAFE_GUTTER,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      borderRadius: ds2Radius.row,
      backgroundColor: color.surface,
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
    },
    actions: {paddingHorizontal: SAFE_GUTTER, gap: space.sm},
    action: {
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: space.lg,
      borderRadius: ds2Radius.pill,
      backgroundColor: color.surface,
      borderWidth: 1,
      borderColor: color.textFaint,
    },
    actionLabel: {
      fontSize: font.body,
      fontWeight: '600',
      color: color.text,
    },
  });
