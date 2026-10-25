import {
  UNTAKEN_WORDING,
  type CancelOutcome,
} from '@momo/core/features/agents/runCancel';
import React, {useCallback, useRef, useState} from 'react';
import {StyleSheet, View, type LayoutChangeEvent} from 'react-native';
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
  onGrow,
}: {
  runId: string;
  /** 이 run의 채널. 취소가 끝나면 이 채널의 진행을 다시 읽는다. */
  channelId: string;
  /** 영수증이 부를 이름. 카드가 보이는 그 이름이다. */
  agentName: string;
  /** 카드로 합쳐진 동시 요청의 수. 확인 문장이 둘 이상이면 그 사실을 미리 말한다. */
  runCount?: number;
  /**
   * 컨트롤 줄이 **자란** 뒤(확인 줄이 열림·오류 문장이 섬)에 부른다. 카드가 서는 목록이 결정 단추까지 내려가
   * 보이게 하는 자리다(가장 큰 글씨에서 확인 줄이 카드를 한 화면보다 크게 늘린다). 처음 그려질 때는 부르지
   * 않는다 — 사람이 건드리지 않은 카드를 스스로 스크롤하지 않는다.
   */
  onGrow?: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const [outcome, setOutcome] = useState<CancelOutcome | null>(null);
  const onOutcome = useCallback(
    (next: CancelOutcome) => {
      setOutcome(next);
      // 결과의 낭독은 컨트롤이 한다(`StopTurnControl.commit`): 서버가 끝낸 run은 카드째 사라지므로(영수증도 함께)
      // 결과는 말로 알려야 들린다(design-review #4285 r1 H2).
      if (next.kind !== 'error') {
        nudgeRunProgress(channelId);
      }
    },
    [channelId],
  );
  // 답을 받았으면(취소됨·이미 끝남) 더 권하지 않는다 — 「취소했어요」 바로 옆에 「취소」가 남지 않는다.
  // 실패(`error`)만 다시 누를 수 있다. 웹의 `StopRunControl`과 같은 규칙이다(`settled`).
  const settled = outcome !== null && outcome.kind !== 'error';
  const lastHeight = useRef<number | null>(null);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const height = event.nativeEvent.layout.height;
      const grew = lastHeight.current !== null && height > lastHeight.current;
      lastHeight.current = height;
      if (grew) onGrow?.();
    },
    [onGrow],
  );
  return (
    // 한 줄에 감겨 서는 행이다: 확인 줄(`flexBasis: '100%'`)이 열리면 자기 줄을 통째로 받는다. 활동
    // 줄과 같은 모양이다(`turnSurfaces` 의 `activityRow` 주석).
    <View
      style={[styles.stop, settled && styles.stopSettled]}
      onLayout={onLayout}
      testID="home-working-stop">
      {settled ? null : (
        <StopTurnControl
          runId={runId}
          agentName={agentName}
          runCount={runCount}
          wording={UNTAKEN_WORDING}
          onOutcome={onOutcome}
          armStyle={styles.armFlush}
          confirmStyle={styles.confirmFlush}
          testIDPrefix="home-working-stop"
        />
      )}
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
    // 첫 탭의 글자가 가로 여백 `space.sm`을 가지므로 상자를 그만큼 밀어 글자가 본문 글자 기둥에 선다.
    // 확인 줄(문장·두 단추)은 밀리지 않고 기둥에 그대로 선다.
    // 세로 숨 `space.sm`은 보통 크기에서는 보이지 않고(상자가 44pt 바닥을 지킨다) 가장 큰 글씨(AX5)에서 글자가
    // 위의 진행 막대·아래의 카드 모서리와 붙지 않게 한다 — 캡처에서 「취소」가 막대와 모서리 사이에 낀 채 찍혔다.
    armFlush: {marginLeft: -space.sm, paddingVertical: space.sm},
    // 확인 줄 아래: 카드의 아래 여백(`HOME.cardPadBottom` 13)과 같은 숨. 첫 탭은 44pt 상자 안에서 글자가 가운데에
    // 앉아 그 숨이 이미 있다.
    confirmFlush: {paddingBottom: space.md},
    // 컨트롤 없이 문장만 서는 때(취소됨·이미 끝남)의 위아래 숨.
    stopSettled: {paddingTop: space.xs},
    // 컨트롤보다 넓은 자리: 한 줄을 통째로 받는다. 카드의 아래 모서리와 붙지 않게 아래에 숨을 둔다.
    outcome: {
      flexBasis: '100%',
      fontSize: font.meta,
      lineHeight: 18,
      color: color.textMuted,
      paddingBottom: space.sm,
    },
    // 「이미 끝났어요」는 이 색을 쓰지 않는다. 실패가 아니라 답이다.
    outcomeError: {color: color.danger},
  });
