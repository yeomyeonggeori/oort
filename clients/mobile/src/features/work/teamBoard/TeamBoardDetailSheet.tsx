import type {SharedWorkSession} from '@momo/core/lib/api';
import {
  TEAM_BOARD_COPY,
  channelLabel,
  diffFacts,
  harnessLabel,
  isAwaitingApproval,
  isRunItem,
  prFacts,
  sessionTitle,
  stageMarkers,
  stateSentence,
  whereLabel,
} from '@momo/core/features/workbench/teamBoard';
import React from 'react';
import {Linking, StyleSheet, Text, View} from 'react-native';
import {Sentence} from '../../../design/atoms';
import {
  PageSheet,
  usePageSheetAction,
  usePageSheetClose,
} from '../../../design/PageSheet';
import {SheetHeader} from '../../../design/SheetChrome';
import {GroupCard, GroupLabel, ListRow, SheetScroll} from '../../../design/sheetParts';
import {useStyles} from '../../../design/theme';
import {
  font,
  line,
  radius,
  SHEET,
  space,
  type Palette,
} from '../../../design/tokens';
import {LaneLabel, StateChip} from './TeamBoardParts';
import {WORK_JOBS_COPY} from '@momo/core/features/workbench/workJobs';
import {ReportedFacts} from '../jobs/WorkJobParts';

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
//
// ## 공용 시트로 (#4458)
//
// 머리는 오른쪽 원형 X 의 `SheetHeader` 다(옛 글자 「닫기」 단추는 없다). 이름은 「작업 상세 닫기」 —
// 코어 `drawerClose` 는 웹 서랍과 공용인 맨 「닫기」라 어느 시트를 닫는지 말하지 못해, 폰은 화면 이름에 「 닫기」를
// 붙인다(코어는 건드리지 않는다). 몸은 묶음 카드다: 요약 카드, 진행·로그·결과는 라벨 + 카드, 이동은 **행**(셰브론)이고
// 눌리면 시트가 **먼저 내려간 뒤** 이동한다. 읽기 전용 상세라 규칙상 페이지 후보다(`phone-sheets.md` §1) — 이 이슈는
// 시트로 둔 채 머리·부품만 옮겼다.
// =============================================================================

/** X·스크림의 보조기술 이름. */
const DETAIL_CLOSE_LABEL = `${TEAM_BOARD_COPY.drawerLabel} 닫기`;

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
      scrimLabel={DETAIL_CLOSE_LABEL}
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
  const slideClose = usePageSheetClose() ?? onClose;
  const afterClose = usePageSheetAction();
  const where = whereLabel(item);
  const whereText = [where.primary, where.secondary]
    .filter((part): part is string => part !== null)
    .join(' / ');
  const facts = diffFacts(item.diff);
  const markers = stageMarkers(item);
  const pr = prFacts(item.prUrl);
  const channel = channelLabel(item);
  const approval = isAwaitingApproval(item);
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
  // 다른 화면으로 가는 행: 시트를 먼저 내린 뒤 부른 쪽의 일을 한 번 부른다(부른 쪽이 곧바로 걷어도 스냅으로 사라지지 않는다).
  const openChannel = () => afterClose(() => onOpenChannel(item.homeChannel.id));

  return (
    <View style={styles.root}>
      <SheetHeader
        title={TEAM_BOARD_COPY.drawerLabel}
        closeLabel={DETAIL_CLOSE_LABEL}
        onClose={slideClose}
        closeTestID="team-detail-close"
      />

      <SheetScroll testID="team-detail-scroll">
        <GroupCard>
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
                {approval ? WORK_JOBS_COPY.approvalHint : stateSentence(item, nowMs)}
              </Text>
            </View>
          </View>
        </GroupCard>

        {/* 승인 대기(ADR-0202 D1): 결정 단추는 여기 없다. 카드가 있는 채널로 간다(D5). */}
        {approval ? (
          <GroupCard>
            <ListRow
              title={WORK_JOBS_COPY.approvalAction}
              detail={channel}
              accessory="chevron"
              accessibilityLabel={`${WORK_JOBS_COPY.approvalAction}, ${channel}`}
              onPress={openChannel}
              testID="team-detail-approval-link"
            />
          </GroupCard>
        ) : null}

        {markers.length > 0 ? (
          <Section heading={TEAM_BOARD_COPY.progressHeading}>
            <GroupCard testID="team-detail-stages">
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
            </GroupCard>
          </Section>
        ) : null}

        {logParts.length > 0 ? (
          <Section heading={TEAM_BOARD_COPY.logHeading}>
            <GroupCard>
              <View style={styles.body}>
                <Text style={styles.log} testID="team-detail-log">
                  {logParts.join(' · ')}
                </Text>
                <Text style={styles.hint}>{TEAM_BOARD_COPY.logHint}</Text>
              </View>
            </GroupCard>
          </Section>
        ) : null}

        {/* 웹 서랍과 같은 순서: 진행 → 로그 요약 → 에이전트 보고 → 결과(design-review M-6). */}
        {item.agentReported != null ? (
          <ReportedFacts reported={item.agentReported} />
        ) : null}

        <Section heading={TEAM_BOARD_COPY.resultHeading}>
          <GroupCard>
            {pr !== null ? (
              <ListRow
                title={pr.number}
                detail={pr.repo}
                accessory="chevron"
                // 이 앱 밖(브라우저)으로 나가는 행이라 「버튼」이 아니라 「링크」로 읽힌다(옛 줄과 같다).
                accessibilityRole="link"
                accessibilityLabel={`${pr.number}, ${pr.repo}, 브라우저에서 열기`}
                onPress={() => void Linking.openURL(pr.href)}
                testID="team-detail-pr"
              />
            ) : (
              <View style={styles.body} testID="team-detail-no-pr">
                <Text style={styles.cardTitle}>{TEAM_BOARD_COPY.noPr}</Text>
                <Text style={styles.cardSub}>
                  {isRunItem(item)
                    ? TEAM_BOARD_COPY.runNoPrBody
                    : TEAM_BOARD_COPY.noPrBody}
                </Text>
              </View>
            )}
          </GroupCard>
        </Section>

        <Sentence style={styles.terminalNote} testID="team-detail-terminal-note">
          {isRunItem(item)
            ? TEAM_BOARD_COPY.runNote
            : TEAM_BOARD_COPY.terminalNote}
        </Sentence>

        {/* 행동은 대화에서 한다. 바닥에는 이동만 있다. */}
        <GroupCard>
          <ListRow
            title={`${channel}에서 보기`}
            accessory="chevron"
            onPress={openChannel}
            testID="team-detail-open-channel"
          />
          {onOpenAgentSession !== undefined && item.origin === 'host' ? (
            <ListRow
              title="내 에이전트 세션 화면"
              accessory="chevron"
              accessibilityLabel="내 에이전트 세션 화면으로 이동"
              onPress={() => afterClose(() => onOpenAgentSession(item.sessionId))}
              testID="team-detail-open-agent-session"
            />
          ) : null}
        </GroupCard>
      </SheetScroll>
    </View>
  );
}

function Section({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.section}>
      <GroupLabel>{heading}</GroupLabel>
      {children}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {flex: 1},
    // 카드 안의 요약·본문 — 안쪽 가로 여백은 카드 행과 같은 값이다.
    head: {
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.md,
      gap: space.sm,
    },
    body: {
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.md,
      gap: space.xs,
    },
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
    // 섹션 라벨과 그 아래 카드는 한 묶음이다(`GroupCard` 의 라벨과 같은 간격).
    section: {gap: space.sm},
    stage: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.md,
    },
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
    hint: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    cardTitle: {
      fontSize: font.body,
      lineHeight: line.body,
      fontWeight: '600',
      color: color.text,
    },
    cardSub: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
    // 카드가 아니라 각주다 — 터미널 원문이 어디에 있는지 말하는 한 문단.
    terminalNote: {
      paddingHorizontal: space.xs,
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
    },
  });
