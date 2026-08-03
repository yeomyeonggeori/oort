import {
  decideApproval,
  newDecisionId,
  type DecisionOutcome,
} from '@momo/core/features/timeline/approvalDecision';
import React, {useCallback, useRef, useState} from 'react';
import {AccessibilityInfo, Pressable, StyleSheet, Text, View} from 'react-native';
import {color, font, radius, space, TOUCH_TARGET} from '../../design/tokens';
import {useSession} from '../../session/useSession';

// =============================================================================
// 인앱 승인 결정 (goal M-AP1, ADR-0137 D5).
//
// ## 두 번째 구현이 아니라 두 번째 호출자
//
// 결정 자체는 `@momo/core`의 `decideApproval`이 전부 한다 — 멱등키의 의미, 409를
// "이미 결정됨"으로 읽는 규칙, 404/403의 문장까지. 이 파일에는 그 판단이 하나도
// 없고, 있어서도 안 된다. 이 폰에는 이미 결정 경로가 하나 있다(잠금화면 알림 →
// `src/push/notifications.ts:133`). 화면이 자기 버전을 따로 만들면 그 순간부터
// 두 경로는 서로 다른 멱등 정책과 서로 다른 409 해석을 갖게 되고, 갈라진 쪽은
// 아무도 보고 있지 않은 쪽이다.
//
// ## 확인 단계가 있는 이유 (되돌릴 수 없음)
//
// 잠금화면의 승인/거부 버튼은 Face ID나 암호를 요구한다
// (`src/push/categories.ts:31` — `isAuthenticationRequired`). 그 마찰은 예의가
// 아니라 통제다: 주운 폰이 배너에서 에이전트의 행동을 승인해 버리는 것을 막는다.
//
// 앱 안에서는 그 통제가 이미 값을 치렀다 — 여기까지 온 사람은 기기를 이미 열었다.
// 남는 위험은 다른 것이다: 목록을 훑는 엄지 밑에서 되돌릴 수 없는 행동이 한 번의
// 탭으로 실행되는 것. 그래서 같은 크기의 마찰을 다른 재료로 세운다. **첫 탭은
// 결정하지 않는다.** 무엇이 일어나는지 한 문장으로 말하고, 그 다음 탭이 결정한다.
//
// 시스템 `Alert`가 아닌 제자리 확인인 이유: 확인은 판단의 근거 옆에 있어야 한다.
// 모달은 누가 무엇을 언제까지 요청했는지를 화면 밖으로 밀어내고, 그러면 사람은
// 자기가 무엇을 승인하는지 못 보는 채로 확정 버튼을 누른다.
//
// ## 그런데 제자리 확인에는 폰에만 있는 구멍이 하나 있다
//
// 확정 버튼이 방금 누른 버튼 **바로 그 자리**에 뜬다. 마우스라면 상관없지만
// 엄지에게는 그 둘이 같은 지점이고, 빠른 두 번 탭은 확인 단계를 통째로 건너뛴다 —
// 원클릭 즉발을 금지하고 얻은 것이 더블탭 즉발이면 아무것도 얻지 못한 것이다.
// (이 결함은 「행 안의 모든 버튼을 눌러 본다」는 red proof가 실제로 잡아냈다.)
//
// 그래서 확정 버튼은 나타난 직후 `CONFIRM_GUARD_MS` 동안 탭을 받지 않는다.
// 이 값은 사람이 한 문장을 읽는 시간보다 짧고, 의도 없이 이어지는 두 번째 탭보다
// 길다. 자리를 옮기는 방식은 쓰지 않았다: 확인은 두 자리뿐인 줄에 있고, 두 자리
// 모두 방금까지 버튼이었다.
// =============================================================================

export type Armed = 'approve' | 'reject' | null;

/**
 * 확정 버튼이 뜬 뒤 탭을 받기까지. 되돌릴 수 없는 행동에 붙는 마찰이므로 짧게
 * 잡되 0은 아니다 — 0이면 확인 단계는 그림이고, 결정은 여전히 두 번의 빠른 탭이다.
 */
export const CONFIRM_GUARD_MS = 400;

export function ApprovalDecision({
  approvalId,
  reversible = true,
  onSettled,
  testIDPrefix = 'inbox-approval',
}: {
  approvalId: string;
  /** 서버가 되돌릴 수 없다고 표시한 요청이면 확정 문장이 그 사실을 재진술한다. */
  reversible?: boolean;
  onSettled: (outcome: DecisionOutcome) => void;
  /**
   * 한 목록에 여러 행이 동시에 떠 있으므로 test id는 행마다 달라야 한다. 접두사
   * 하나로 두 행이 같은 id를 답하면 테스트는 자기가 어느 행을 눌렀는지 말할 수
   * 없다.
   */
  testIDPrefix?: string;
}): React.JSX.Element {
  const {workspaceId} = useSession();
  const [armed, setArmed] = useState<Armed>(null);
  const [busy, setBusy] = useState(false);
  const [errorCopy, setErrorCopy] = useState<string | null>(null);
  // (행, 방향)당 하나. 같은 결정을 다시 누르면 서버가 원래 영수증을 그대로
  // 재생하고, 두 번째 결정이 기록되지 않는다. 멱등 충돌일 때만 버린다 — 그
  // 키는 이미 다른 결정에 묶여 있어서 재시도해도 같은 충돌만 반복한다.
  const keys = useRef<{approve?: string; reject?: string}>({});
  /** 확정 버튼이 이 자리에 뜬 시각. 위의 더블탭 구멍을 막는 데만 쓴다. */
  const armedAtMs = useRef(0);

  const arm = useCallback((next: Exclude<Armed, null>) => {
    setArmed(next);
    armedAtMs.current = Date.now();
    setErrorCopy(null);
    // 엄지 밑의 버튼이 방금 의미를 바꿨다. 화면을 보지 않는 사람에게 그 변화는
    // 소리로만 전달된다 — RN에는 포커스를 옮길 웹의 `focus()`가 없다.
    AccessibilityInfo.announceForAccessibility(
      next === 'approve'
        ? '승인을 확정할지 묻습니다.'
        : '거부를 확정할지 묻습니다.',
    );
  }, []);

  const commit = useCallback(async () => {
    // 이 함수는 확인 단계 뒤에만 있다. `armed`가 null이면 확정 버튼이 그려지지도
    // 않았다는 뜻이므로, 여기서 한 번 더 막는 것은 방어가 아니라 계약의 진술이다:
    // 무장하지 않은 결정은 전송되지 않는다.
    if (armed === null || busy) return;
    // 방금 무장한 그 탭의 꼬리다. 확정 버튼이 앞선 버튼 자리에 떴으므로, 이 창
    // 안의 탭은 확인이 아니라 같은 한 번의 동작으로 본다.
    if (Date.now() - armedAtMs.current < CONFIRM_GUARD_MS) return;
    const slot = armed;
    const approve = slot === 'approve';
    keys.current[slot] ??= newDecisionId();
    setBusy(true);
    setErrorCopy(null);
    try {
      const outcome = await decideApproval(
        workspaceId,
        approvalId,
        approve,
        keys.current[slot] as string,
      );
      if (outcome.kind === 'error') {
        if (outcome.errorCode === 'idempotency_conflict') {
          delete keys.current[slot];
        }
        setErrorCopy(outcome.errorCopy ?? '결정을 처리하지 못했습니다.');
        return;
      }
      // `superseded`도 결정된 것이다(다른 기기에서 이미 결정됐거나 만료됨).
      // 실패로 그리면 더는 바뀔 수 없는 것에 재시도를 권하게 된다 —
      // `src/push/notifications.ts:142`가 같은 이유로 같은 선택을 한다.
      setArmed(null);
      onSettled(outcome);
    } finally {
      setBusy(false);
    }
  }, [approvalId, armed, busy, onSettled, workspaceId]);

  if (armed === null) {
    return (
      <View style={styles.bar} testID={`${testIDPrefix}-actions`}>
        <Text style={styles.lead}>실행 전에 회원님의 허가가 필요합니다.</Text>
        <View style={styles.buttons}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="거부"
            onPress={() => arm('reject')}
            style={({pressed}) => [
              styles.button,
              styles.buttonQuiet,
              pressed && styles.pressed,
            ]}
            testID={`${testIDPrefix}-reject`}>
            <Text style={styles.buttonQuietLabel}>거부</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="승인"
            onPress={() => arm('approve')}
            style={({pressed}) => [
              styles.button,
              styles.buttonQuiet,
              pressed && styles.pressed,
            ]}
            testID={`${testIDPrefix}-approve`}>
            <Text style={styles.buttonQuietLabel}>승인</Text>
          </Pressable>
        </View>
        {errorCopy !== null ? (
          <Text style={styles.error} testID={`${testIDPrefix}-error`}>
            {errorCopy}
          </Text>
        ) : null}
      </View>
    );
  }

  const consequence =
    armed === 'approve'
      ? reversible
        ? '승인하면 에이전트가 바로 실행합니다.'
        : '승인하면 에이전트가 바로 실행합니다. 되돌릴 수 없습니다.'
      : '거부하면 이 실행은 취소됩니다.';

  return (
    <View style={styles.bar} testID={`${testIDPrefix}-confirm`}>
      <Text style={styles.consequence}>{consequence}</Text>
      <View style={styles.buttons}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="취소"
          accessibilityState={{disabled: busy}}
          disabled={busy}
          onPress={() => setArmed(null)}
          style={({pressed}) => [
            styles.button,
            styles.buttonQuiet,
            busy && styles.buttonInert,
            pressed && !busy && styles.pressed,
          ]}
          testID={`${testIDPrefix}-cancel`}>
          <Text style={styles.buttonQuietLabel}>취소</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={armed === 'approve' ? '승인 확정' : '거부 확정'}
          accessibilityState={{disabled: busy, busy}}
          disabled={busy}
          onPress={() => void commit()}
          style={({pressed}) => [
            styles.button,
            armed === 'approve' ? styles.buttonCommit : styles.buttonReject,
            busy && styles.buttonInert,
            pressed && !busy && styles.pressed,
          ]}
          testID={`${testIDPrefix}-commit`}>
          <Text style={styles.buttonCommitLabel}>
            {busy ? '보내는 중' : armed === 'approve' ? '승인 확정' : '거부 확정'}
          </Text>
        </Pressable>
      </View>
      {errorCopy !== null ? (
        <Text style={styles.error} testID={`${testIDPrefix}-error`}>
          {errorCopy}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {gap: space.sm, paddingBottom: space.md},
  lead: {fontSize: font.meta, color: color.textMuted},
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
  buttonCommit: {backgroundColor: color.accent},
  buttonReject: {backgroundColor: color.dangerBorder},
  buttonInert: {opacity: 0.6},
  buttonQuietLabel: {fontSize: font.label, fontWeight: '600', color: color.text},
  buttonCommitLabel: {fontSize: font.label, fontWeight: '600', color: '#ffffff'},
  error: {fontSize: font.meta, color: color.danger, lineHeight: 18},
  pressed: {backgroundColor: color.surfacePressed},
});
