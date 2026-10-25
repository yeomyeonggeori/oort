import {
  UNTAKEN_WORDING,
  type CancelOutcome,
} from '@momo/core/features/agents/runCancel';
import React, {useCallback, useState} from 'react';
import {StyleSheet, View} from 'react-native';
import {Sentence} from '../../design/atoms';
import {useStyles} from '../../design/theme';
import {font, space, type Palette} from '../../design/tokens';
import {StopTurnControl} from '../agents/StopTurnControl';
import {nudgeRunProgress} from '../agents/agentRunProgressStore';

// =============================================================================
// 홈 「작업 중」 카드의 「취소」 (#4285, ADR-0200 증보 3 E6).
//
// 카드는 아무도 가져가지 않은 요청을 「아직 받지 않았어요」라고 말하면서 그 요청을 거둘 수단이
// 없었다 — 멈추기(`StopTurnControl`)는 대화 화면의 진행 줄에만 있었다(2026-10-23 폰 홈 캡처,
// 5시간째 대기). 이 컴포넌트는 같은 컨트롤을 카드 아래에 놓는다. 호출·한 겹의 확인·409와 오류를 읽는
// 규칙은 그대로이고(`cancelAgentRun`, 채널의 사람 멤버만), 달라지는 것은 낱말뿐이다: 가져간 적 없는
// 요청에 「중단」은 거짓이라 「취소」다(`UNTAKEN_WORDING`).
//
// 카드 안이 아니라 **카드의 누르는 면 밖**에 선다. 카드 본문은 대화를 여는 `Pressable`이고, 누르는
// 면 안에 누르는 면을 겹치지 않는다(`WorkSeeAllRow` 주석의 같은 규칙).
//
// 결과 문장(취소했어요·이미 끝났어요·실패)은 컨트롤 밖, 줄보다 넓은 자리에 말한다 — 대화 화면의
// 영수증과 같은 이유다. 성공하거나 이미 끝났으면 이 채널의 진행을 바로 다시 읽어 카드가 곧
// 사라지게 한다(서버가 끝낸 run은 서버가 말한다 — 카드가 스스로 지우지 않는다).
// =============================================================================

export function WorkingCardStop({
  runId,
  channelId,
  agentName,
  runCount,
}: {
  runId: string;
  /** 이 run의 채널. 취소가 끝나면 이 채널의 진행을 다시 읽는다. */
  channelId: string;
  /** 영수증이 부를 이름. 카드가 보이는 그 이름이다. */
  agentName: string;
  /** 카드로 합쳐진 동시 요청의 수. 확인 문장이 둘 이상이면 그 사실을 미리 말한다. */
  runCount?: number;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const [outcome, setOutcome] = useState<CancelOutcome | null>(null);
  const onOutcome = useCallback(
    (next: CancelOutcome) => {
      setOutcome(next);
      if (next.kind !== 'error') {
        nudgeRunProgress(channelId);
      }
    },
    [channelId],
  );
  return (
    // 한 줄에 감겨 서는 행이다: 확인 줄(`flexBasis: '100%'`)이 열리면 자기 줄을 통째로 받는다. 활동
    // 줄과 같은 모양이다(`turnSurfaces` 의 `activityRow` 주석).
    <View style={styles.stop} testID="home-working-stop">
      <StopTurnControl
        runId={runId}
        agentName={agentName}
        runCount={runCount}
        wording={UNTAKEN_WORDING}
        onOutcome={onOutcome}
        testIDPrefix="home-working-stop"
      />
      {outcome !== null ? (
        <Sentence
          style={[styles.outcome, outcome.kind === 'error' && styles.outcomeError]}
          accessibilityLiveRegion="polite"
          testID={`home-working-stop-outcome-${outcome.kind}`}>
          {outcome.sentence}
        </Sentence>
      ) : null}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    stop: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: space.xs,
    },
    // 컨트롤보다 넓은 자리: 한 줄을 통째로 받는다.
    outcome: {
      flexBasis: '100%',
      fontSize: font.meta,
      lineHeight: 18,
      color: color.textMuted,
    },
    // 「이미 끝났어요」는 이 색을 쓰지 않는다. 실패가 아니라 답이다.
    outcomeError: {color: color.danger},
  });
