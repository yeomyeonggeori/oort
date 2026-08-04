import {cancelAgentRun} from '@momo/core/lib/api';
import {
  CANCEL_ACTION_LABEL,
  CANCEL_BUSY_LABEL,
  CANCEL_COMMIT_LABEL,
  CANCEL_CONFIRM_SENTENCE,
  cancelFailureOutcome,
  cancelSucceeded,
  type CancelOutcome,
} from '@momo/core/features/agents/runCancel';
import React, {useCallback, useRef, useState} from 'react';
import {AccessibilityInfo, Pressable, StyleSheet, Text, View} from 'react-native';
import {color, font, radius, space, TOUCH_TARGET} from '../../design/tokens';
import {CONFIRM_GUARD_MS} from '../inbox/ApprovalDecision';
import {useSession} from '../../session/useSession';

// =============================================================================
// 「멈춰라」 — 사람이 도는 실행을 세운다 (goal RN-C1, ADR-0132 D1).
//
// ## 확인은 한 겹이고, 그 한 겹은 승인의 것과 크기가 다르다
//
// 승인은 되돌릴 수 없는 쪽으로 되돌릴 수 없다: 예라고 하면 에이전트가 세상에
// 무언가를 하고, 두 번째 탭으로 취소되지 않는다. 중단도 비가역이지만 **잃는 것이
// 다시 만들 수 있는 종류**다 — 이 실행은 여기서 끝나고 하던 것은 이어지지 않지만,
// 같은 일을 다시 시킬 수 있다. 그래서 확인은 정확히 한 겹이고, 문장이 그 차이를
// 말한다(`CANCEL_CONFIRM_SENTENCE`). 행위보다 무거운 경고는 사람에게 경고를
// 무시하는 법을 가르친다.
//
// ## 그런데 폰의 구멍은 승인과 똑같다
//
// 확정 버튼이 방금 누른 버튼 **그 자리**에 뜬다. 엄지에게 그 둘은 같은 지점이고,
// 빠른 두 번 탭은 확인 단계를 통째로 건너뛴다. `ApprovalDecision`이 이미 그 값을
// 재고 상수로 뒀으므로(`CONFIRM_GUARD_MS`) 여기서는 그것을 **가져다 쓴다** — 두
// 번째 숫자를 두면 두 확인 단계가 서로 다른 마찰을 갖게 되고, 어느 쪽이 옳은지
// 아무도 다시 재지 않는다.
//
// ## 판단은 하나도 여기 없다
//
// 무엇을 보내고(`cancelAgentRun`), 409를 어떻게 읽고, 실패를 무슨 문장으로 말할지는
// 전부 `@momo/core/features/agents/runCancel`에 있다. 특히 **409는 오류가 아니다**:
// 배지를 그린 순간과 엄지가 닿은 순간 사이에 실행이 스스로 끝났다는 뜻이고, 사람이
// 원한 것(이 실행이 돌지 않는 것)은 참이 됐다. 그것을 빨간 글씨와 재시도로 그리면
// 이미 이긴 경주를 다시 뛰라고 시키는 것이다.
// =============================================================================

export function StopTurnControl({
  runId,
  onOutcome,
  testIDPrefix = 'turn-stop',
}: {
  runId: string;
  /**
   * 결과를 화면에 알린다. 영수증·이미 끝남·실패를 **부르는 쪽이** 그리는 이유는,
   * 이 컨트롤이 한 줄 안에 들어앉은 작은 버튼이고 문장은 그 줄보다 길기 때문이다.
   */
  onOutcome: (outcome: CancelOutcome) => void;
  testIDPrefix?: string;
}): React.JSX.Element {
  const {workspaceId} = useSession();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 가드 창 안에서 확정 탭이 실제로 있었는가. 죽은 버튼처럼 보이지 않게. */
  const [tooFast, setTooFast] = useState(false);
  const armedAtMs = useRef(0);

  const arm = useCallback(() => {
    setArmed(true);
    setTooFast(false);
    armedAtMs.current = Date.now();
    // 엄지 밑의 버튼이 방금 의미를 바꿨다. 화면을 보지 않는 사람에게 그 변화는
    // 소리로만 전달된다 — RN에는 포커스를 옮길 웹의 `focus()`가 없다.
    AccessibilityInfo.announceForAccessibility(
      `${CANCEL_CONFIRM_SENTENCE} 중단할지 묻습니다.`,
    );
  }, []);

  const commit = useCallback(async () => {
    // 무장하지 않은 중단은 전송되지 않는다. `armed`가 false면 확정 버튼이
    // 그려지지도 않았다는 뜻이므로, 이 줄은 방어가 아니라 계약의 진술이다.
    if (!armed || busy) return;
    // 방금 무장한 그 탭의 꼬리다. 확정 버튼이 앞선 버튼 자리에 떴으므로, 이 창
    // 안의 탭은 확인이 아니라 같은 한 번의 동작으로 본다. 조용히 무시하지는
    // 않는다: 아무 일도 일어나지 않는 버튼은 고장난 버튼과 구별되지 않는다.
    if (Date.now() - armedAtMs.current < CONFIRM_GUARD_MS) {
      setTooFast(true);
      return;
    }
    setTooFast(false);
    setBusy(true);
    try {
      const result = await cancelAgentRun(workspaceId, runId);
      setArmed(false);
      onOutcome(cancelSucceeded(result));
    } catch (error) {
      const outcome = cancelFailureOutcome(error);
      // 이미 끝난 실행은 더 물어볼 것이 없다. 확인 단계를 접는다 — 남겨 두면
      // 존재하지 않는 실행을 다시 멈추라고 권하는 버튼이 화면에 남는다.
      if (outcome.kind === 'alreadyOver') setArmed(false);
      onOutcome(outcome);
    } finally {
      setBusy(false);
    }
  }, [armed, busy, onOutcome, runId, workspaceId]);

  if (!armed) {
    return (
      <Pressable
        accessibilityRole="button"
        // 이 탭은 중단하지 않는다 — 중단할지 묻는다. 라벨이 행동을 약속하면
        // 화면을 보지 않는 사람은 이미 멈춘 줄 알고 손을 뗀다.
        accessibilityLabel="실행 중단, 확인 필요"
        accessibilityHint="누르면 중단 확정 여부를 묻습니다."
        onPress={arm}
        hitSlop={8}
        style={({pressed}) => [styles.quiet, pressed && styles.pressed]}
        testID={`${testIDPrefix}-arm`}>
        <Text style={styles.quietLabel}>{CANCEL_ACTION_LABEL}</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.confirm} testID={`${testIDPrefix}-confirm`}>
      <Text style={styles.consequence}>{CANCEL_CONFIRM_SENTENCE}</Text>
      <View style={styles.buttons}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="중단하지 않기"
          accessibilityState={{disabled: busy}}
          disabled={busy}
          onPress={() => setArmed(false)}
          style={({pressed}) => [
            styles.button,
            styles.buttonQuiet,
            busy && styles.inert,
            pressed && !busy && styles.pressed,
          ]}
          testID={`${testIDPrefix}-dismiss`}>
          <Text style={styles.quietLabel}>그대로 두기</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={CANCEL_COMMIT_LABEL}
          accessibilityState={{disabled: busy, busy}}
          disabled={busy}
          onPress={() => void commit()}
          style={({pressed}) => [
            styles.button,
            styles.buttonCommit,
            busy && styles.inert,
            pressed && !busy && styles.pressed,
          ]}
          testID={`${testIDPrefix}-commit`}>
          <Text style={styles.commitLabel}>
            {busy ? CANCEL_BUSY_LABEL : CANCEL_COMMIT_LABEL}
          </Text>
        </Pressable>
      </View>
      {tooFast ? (
        <Text style={styles.hint} testID={`${testIDPrefix}-too-fast`}>
          방금 누른 탭과 이어진 동작이라 보내지 않았습니다. 문장을 확인하고 다시
          누르세요.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  quiet: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: space.sm,
  },
  quietLabel: {fontSize: font.meta, color: color.accentText, fontWeight: '600'},
  confirm: {flexBasis: '100%', gap: space.xs, paddingTop: space.xs},
  consequence: {fontSize: font.meta, color: color.text, lineHeight: 18},
  buttons: {flexDirection: 'row', gap: space.sm},
  button: {
    flex: 1,
    minHeight: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
  },
  buttonQuiet: {borderWidth: 1, borderColor: color.border},
  buttonCommit: {backgroundColor: color.dangerBorder},
  commitLabel: {fontSize: font.label, fontWeight: '600', color: '#ffffff'},
  inert: {opacity: 0.6},
  hint: {fontSize: font.meta, color: color.textMuted, lineHeight: 18},
  pressed: {backgroundColor: color.surfacePressed},
});
