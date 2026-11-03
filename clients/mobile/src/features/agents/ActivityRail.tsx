import {uuidEq, type AgentRunProgress} from '@momo/core/lib/api';
import {
  activityRail,
  type ActivityRail,
  type RailAgent,
} from '@momo/core/features/agents/activityRail';
import {
  cancelWordingFor,
  type CancelOutcome,
  type CancelWording,
} from '@momo/core/features/agents/runCancel';
import {agentLabel, TURN_STALE_SENTENCE, UNKNOWN_AGENT_NAME} from '@momo/core/features/agents/turnCopy';
import type {AgentWorkingSignal} from '@momo/core/features/agents/workingSignal';
import {memberNameParts, type Directory} from '@momo/core/features/workspace/directory';
import React, {useContext, useEffect, useMemo, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {BAR_CONTROL_MAX_SCALE} from '../../design/atoms';
import {PageSheet, usePageSheetClose} from '../../design/PageSheet';
import {SheetHeader} from '../../design/SheetChrome';
import {GroupCard, ListRow, SheetScroll} from '../../design/sheetParts';
import {useStyles} from '../../design/theme';
import {font, line, space, type Palette} from '../../design/tokens';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {Avatar} from '../conversation/Avatar';
import {RAIL_HIT_SLOP, railSlotHeight} from './railClock';
import {RespondingDots} from './RespondingDots';
import {RunLedgerSheet} from './RunLedgerSheet';

// =============================================================================
// 입력창 레일 — 「에이전트가 지금 일하는 중」의 **유일한** 실시간 자리의 폰 판 (#4620, #4577 권장 A).
// 웹 `ActivityRail`과 같은 코어 모델(`activityRail`)을 같은 낱말로 그린다:
//
//   [얼굴] grok · 작업 중 · 설계 문서 읽는 중 ···        (한 에이전트)
//   [얼굴][얼굴] grok +1                                  (여럿은 합친다)
//   [얼굴] 모래시계봇 · 승인 대기 +1                       (이끄는 쪽이 사람을 기다리면 그 낱말을 남긴다)
//
// ## 칸은 예약돼 있다
//
// 칸(`composer-rail`)의 높이는 줄 상자 하나를 글자 배율만큼 키운 값(`railSlotHeight`)이고 **안이 비어도 한 줄이어도 합친 줄이어도
// 끊긴 문장이어도 같다**. 줄이 서고 사라지고 단계가 바뀌어도 그 위의 목록은 움직이지 않는다(이동 0). 칸은 에이전트가 있는 대화에서만
// 미리 잡힌다(`isRailReserved`, 사람만 있는 대화는 칸도 없다 — 죽은 세로 띠를 만들지 않는다).
//
// ## 줄은 가만히 있는다
//
// 초 단위 숫자도 분 단위 경과도 줄에 없다(경과는 시트의 근거 글에서만 1분 단위로). 점 셋(`RespondingDots`)은 일하는 동안에만
// 서고 투명도만 오가며 동작 줄이기에서는 멈춘 채 선다(#4020). **국면이 바뀔 때만** 보조기술에 알린다(`railPhaseKey`) — 단계 글이 바뀌거나
// 줄이 사라지는 것은 알리지 않는다. live region 은 걸지 않는다: 줄이 서 있는 동안의 갱신이 사람의 작업을 끊지 않게.
//
// ## 끊긴 레일
//
// 실시간 연결이 끊기면 얼굴·점이 걷히고 줄은 한정 문장(`TURN_STALE_SENTENCE`) 하나가 된다. 한 줄에 두 말이 못 들어가면 한정 문장이
// 남고 에이전트 글이 접힌다(웹은 폭에 따라 세 단계로 접는다 — 폰은 한정 문장만 세운다). 접힌 에이전트 글은 접근성 이름과 시트에 그대로 있다.
//
// ## 누르면
//
// 시트(「일하는 에이전트」)가 열린다: 에이전트마다 한 행(눌러서 작업 기록), 그 run의 중단·취소 컨트롤(옛 활동 줄이 들고 있던 것을 그대로
// 옮겼다 — `turn-stop-<id>-*` testID 그대로), 그리고 「활동 보기」(작업 목록). 활동 시트(#4579)가 생기면 도착지가 그쪽으로 바뀐다.
// =============================================================================

/** 얼굴 크기(dp): 줄 상자 높이와 같은 자리를 쓴다. */
const FACE = 16;
/** 시트 행의 얼굴. */
const ROW_FACE = 28;

/** 보조기술에 알릴 국면의 서명. 에이전트마다 국면이 바뀌면 바뀐다 — 단계 글·줄 사라짐은 서명이 아니다. */
export function railPhaseKey(rail: ActivityRail | null): string {
  return rail === null
    ? ''
    : rail.agents.map(agent => `${agent.key}:${agent.phase}`).join('|');
}

/** 칸 하나. 줄이 없어도(예약된 대화) 같은 높이의 빈 칸이 선다. 예약도 줄도 없으면 아무것도 그리지 않는다. */
export function ActivityRailSlot({
  rail,
  live,
  reserved,
  directory,
  onPress,
}: {
  rail: ActivityRail | null;
  live: boolean;
  reserved: boolean;
  directory: Directory;
  onPress?: () => void;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const {fontScale} = useWindowDimensions();
  if (!reserved && rail === null) return null;
  const height = railSlotHeight(fontScale);
  const spoken =
    rail === null ? '' : live ? rail.label : `${rail.label} ${TURN_STALE_SENTENCE}`;
  return (
    <View style={[styles.slot, {height}]} testID="composer-rail">
      {rail !== null ? (
        <Pressable
          accessibilityRole="button"
          // 이름을 명시한다: 자식에 맡기면 줄이 잘렸을 때 잘린 글이 접근성 이름이 된다.
          accessibilityLabel={formatMessage('timeline.agentRail.open', {label: spoken})}
          onPress={onPress}
          // 슬롭은 아래·옆으로만이다(`RAIL_HIT_SLOP`): 위로 넓히면 목록 마지막 행의 아랫부분 탭을 도크가 가로챈다.
          hitSlop={RAIL_HIT_SLOP}
          style={({pressed}) => [styles.line, pressed && styles.pressed]}
          testID="composer-working">
          {live ? (
            <View style={styles.faces} testID="composer-working-avatars">
              {rail.agents.slice(0, 2).map(agent => (
                <Avatar
                  key={agent.key}
                  directory={directory}
                  memberId={agent.memberId}
                  size={FACE}
                />
              ))}
            </View>
          ) : null}
          {live ? (
            <Text
              maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
              numberOfLines={1}
              style={[styles.text, rail.needsHuman && styles.textWarn]}
              testID="composer-working-text">
              <Text style={styles.name}>{rail.leadLabel}</Text>
              {rail.text.slice(rail.leadLabel.length)}
            </Text>
          ) : (
            <Text
              maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
              numberOfLines={1}
              style={[styles.text, styles.stale]}
              testID="composer-working-stale">
              {TURN_STALE_SENTENCE}
            </Text>
          )}
          {live && rail.active ? <RespondingDots /> : null}
        </Pressable>
      ) : null}
    </View>
  );
}

/** 시트의 행이 작업 기록을 여는 길. 시트 밖에서는 없다(그러면 행은 눌리지 않는 글이다). */
const RecordOpener = React.createContext<((run: AgentRunProgress) => void) | null>(null);

/** 화면이 쥔 중단·취소 결과(`ConversationScreen`의 `stopOutcome`). */
export interface StopOutcome {
  memberId: string;
  outcome: CancelOutcome;
}

type StopRender = (turn: {
  runId: string;
  memberId: string;
  name: string;
  runCount?: number;
  wording: CancelWording;
}) => React.ReactNode;

/** 시트의 에이전트 한 행: 얼굴·이름·국면 한 줄(1분 단위 근거까지)·눌러서 작업 기록, 그 아래 중단·취소 컨트롤. */
function RailAgentRows({
  agent,
  directory,
  turn,
  live,
  record,
  renderStop,
  outcome,
}: {
  agent: RailAgent;
  directory: Directory;
  turn: AgentWorkingSignal | undefined;
  live: boolean;
  record: AgentRunProgress | undefined;
  renderStop?: StopRender;
  /** 이 에이전트의 중단·취소 결과 한 문장. 시트가 화면의 영수증 자리를 덮으므로 시트 안에서도 말한다. */
  outcome?: CancelOutcome;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const name = agentLabel(agent.name);
  const detail = [agent.word, agent.stage, agent.detail]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ');
  const openRecord = useContext(RecordOpener);
  return (
    <View testID={`composer-working-agent-${agent.memberId}`}>
      <ListRow
        title={name}
        detail={detail}
        leading={<Avatar directory={directory} memberId={agent.memberId} size={ROW_FACE} />}
        leadingWidth={ROW_FACE}
        accessibilityLabel={`${name}, ${detail}`}
        {...(record !== undefined && openRecord !== null
          ? {
              onPress: () => openRecord(record),
              closesSheet: true,
              accessory: 'chevron' as const,
              accessibilityHint: formatMessage('timeline.agentRail.openRecord', {name}),
            }
          : {})}
        testID={`composer-working-row-${agent.memberId}`}
      />
      {live && agent.runId !== undefined && renderStop !== undefined ? (
        <View style={styles.stopRow}>
          {renderStop({
            runId: agent.runId,
            memberId: agent.memberId,
            name: agent.name.name,
            ...(turn?.runCount === undefined ? {} : {runCount: turn.runCount}),
            wording: cancelWordingFor(agent.server),
          })}
        </View>
      ) : null}
      {outcome !== undefined ? (
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.outcome, outcome.kind === 'error' && styles.outcomeError]}
          testID={`composer-working-outcome-${outcome.kind}`}>
          {outcome.sentence}
        </Text>
      ) : null}
    </View>
  );
}

function RailSheetBody({
  rail,
  turns,
  runs,
  live,
  directory,
  renderStop,
  stopOutcome,
  onOpenActivity,
}: {
  rail: ActivityRail;
  turns: readonly AgentWorkingSignal[];
  runs: readonly AgentRunProgress[];
  live: boolean;
  directory: Directory;
  renderStop?: StopRender;
  stopOutcome?: StopOutcome | null;
  onOpenActivity?: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const slideClose = usePageSheetClose();
  return (
    <View style={styles.sheet}>
      <SheetHeader
        title={formatMessage('timeline.agentRail.sheetTitle')}
        closeLabel={formatMessage('timeline.agentRail.sheetClose')}
        onClose={slideClose ?? undefined}
        closeTestID="composer-working-sheet-close"
      />
      <SheetScroll testID="composer-working-sheet-scroll">
        <GroupCard>
          {rail.agents.map(agent => (
            <RailAgentRows
              key={agent.key}
              agent={agent}
              directory={directory}
              turn={turns.find(turn => turn.memberId.toLowerCase() === agent.memberId.toLowerCase())}
              live={live}
              record={
                agent.runId === undefined
                  ? undefined
                  : runs.find(run => run.id.toLowerCase() === agent.runId?.toLowerCase())
              }
              renderStop={renderStop}
              outcome={
                stopOutcome != null && uuidEq(stopOutcome.memberId, agent.memberId)
                  ? stopOutcome.outcome
                  : undefined
              }
            />
          ))}
        </GroupCard>
        {onOpenActivity !== undefined ? (
          <GroupCard>
            <ListRow
              title={formatMessage('timeline.agentRail.openActivity')}
              accessory="chevron"
              onPress={onOpenActivity}
              closesSheet
              testID="composer-working-activity"
            />
          </GroupCard>
        ) : null}
      </SheetScroll>
    </View>
  );
}

/**
 * 화면이 꽂는 레일: 칸 + 누르면 열리는 시트(+ 시트에서 여는 작업 기록). 모델(`rail`)은 화면이 만든다 — 열린 턴·승인 원장·사라지는
 * 마감의 시계가 화면에 있기 때문이다(`useFireAt`).
 */
export function ConversationActivityRail({
  rail,
  turns,
  runs,
  live,
  reserved,
  directory,
  renderStop,
  stopOutcome,
  onOpenActivity,
}: {
  rail: ActivityRail | null;
  turns: readonly AgentWorkingSignal[];
  runs: readonly AgentRunProgress[];
  live: boolean;
  reserved: boolean;
  directory: Directory;
  renderStop?: StopRender;
  /** 화면이 쥔 가장 최근 중단·취소 결과. 시트가 화면의 영수증 자리를 덮으므로 시트 안 그 에이전트 행 아래에서도 말한다. */
  stopOutcome?: StopOutcome | null;
  /** 작업 목록(ADE)을 연다. 이 서버가 그 표면을 주지 않으면 없다. */
  onOpenActivity?: () => void;
}): React.JSX.Element | null {
  const formatMessage = useFormatMessage();
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<AgentRunProgress | null>(null);
  // 일이 다 끝나 줄이 사라지면 시트도 걷는다(비어 있는 시트는 말할 것이 없다).
  useEffect(() => {
    if (rail === null) setOpen(false);
  }, [rail]);
  // 국면이 바뀔 때만 알린다(처음 마운트는 알리지 않는다: 이미 일하는 대화에 들어온 것).
  const phaseKey = railPhaseKey(rail);
  const seen = useRef(phaseKey);
  useEffect(() => {
    if (seen.current === phaseKey) return;
    seen.current = phaseKey;
    if (rail !== null) {
      AccessibilityInfo.announceForAccessibility(live ? rail.label : `${rail.label} ${TURN_STALE_SENTENCE}`);
    }
    // 국면의 서명만 의존한다: 같은 국면의 단계 글·합친 줄의 이름은 알리지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phaseKey]);
  const opener = useMemo(
    () => (run: AgentRunProgress) => setRecord(run),
    [],
  );
  return (
    <>
      <ActivityRailSlot
        rail={rail}
        live={live}
        reserved={reserved}
        directory={directory}
        onPress={rail === null ? undefined : () => setOpen(true)}
      />
      {open && rail !== null ? (
        <PageSheet
          onClose={() => setOpen(false)}
          accessibilityLabel={formatMessage('timeline.agentRail.sheetTitle')}
          scrimLabel={formatMessage('timeline.agentRail.sheetClose')}
          height="fit"
          testID="composer-working-sheet">
          <RecordOpener.Provider value={opener}>
            <RailSheetBody
              rail={rail}
              turns={turns}
              runs={runs}
              live={live}
              directory={directory}
              renderStop={renderStop}
              stopOutcome={stopOutcome}
              onOpenActivity={onOpenActivity}
            />
          </RecordOpener.Provider>
        </PageSheet>
      ) : null}
      {record !== null ? (
        <RunLedgerSheet
          progress={record}
          directory={directory}
          onClose={() => setRecord(null)}
        />
      ) : null}
    </>
  );
}

/**
 * 열린 턴 목록에서 곧바로 레일을 세운다 — 화면의 배선(`ConversationScreen`)과 **같은 모델·같은 그림**이다. 계측 표면(`measure/`)과 시험이
 * 화면 전체를 세우지 않고도 배송되는 레일을 마운트하려고 쓴다. 시계는 없다: 시각(`nowMs`)은 부르는 쪽이 준다.
 */
export function TurnsActivityRail({
  turns,
  directory,
  nowMs,
  live = true,
  reserved = true,
  runs = [],
  renderStop,
  stopOutcome,
  onOpenActivity,
}: {
  turns: readonly AgentWorkingSignal[];
  directory: Directory;
  nowMs: number;
  live?: boolean;
  reserved?: boolean;
  runs?: readonly AgentRunProgress[];
  renderStop?: StopRender;
  stopOutcome?: StopOutcome | null;
  onOpenActivity?: () => void;
}): React.JSX.Element | null {
  const rail = useMemo(
    () =>
      activityRail(
        turns,
        memberId => memberNameParts(directory, memberId, UNKNOWN_AGENT_NAME),
        nowMs,
      ),
    [turns, directory, nowMs],
  );
  return (
    <ConversationActivityRail
      rail={rail}
      turns={turns}
      runs={runs}
      live={live}
      reserved={reserved}
      directory={directory}
      renderStop={renderStop}
      stopOutcome={stopOutcome}
      onOpenActivity={onOpenActivity}
    />
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    // 칸. 높이는 인라인(`railSlotHeight`)이다 — 글자 배율을 곱한 값이라 스타일시트에 못 박지 못한다.
    slot: {justifyContent: 'center', paddingHorizontal: space.lg},
    line: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      maxWidth: '100%',
      gap: space.sm,
      borderRadius: 6,
    },
    pressed: {backgroundColor: color.surfacePressed},
    faces: {flexDirection: 'row', gap: space.xs, alignItems: 'center'},
    text: {
      flexShrink: 1,
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },
    name: {color: color.agent},
    textWarn: {color: color.warn},
    stale: {color: color.warn},
    sheet: {},
    stopRow: {paddingHorizontal: space.lg, paddingBottom: space.sm},
    outcome: {
      paddingHorizontal: space.lg,
      paddingBottom: space.sm,
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },
    outcomeError: {color: color.danger},
  });
