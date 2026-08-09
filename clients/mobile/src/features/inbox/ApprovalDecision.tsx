import {
  decideApproval,
  newDecisionId,
  type DecisionOutcome,
} from '@momo/core/features/timeline/approvalDecision';
import type {SpawnExecutionPlan} from '@momo/core/lib/executionPlan';
import {
  decisionHostId,
  findCandidate,
  preselectedHostId,
  spawnApproveLead,
  spawnHostGate,
} from '@momo/core/features/timeline/spawnHostChoice';
import React, {useCallback, useRef, useState} from 'react';
import {AccessibilityInfo, Pressable, StyleSheet, Text, View} from 'react-native';
import {font, radius, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {useSession} from '../../session/useSession';
import {SpawnHostChoice} from './SpawnHostChoice';

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
  reversible = false,
  deadlinePassed = false,
  execution = null,
  onSettled,
  testIDPrefix = 'inbox-approval',
  initialArmed = null,
}: {
  approvalId: string;
  /**
   * 서버가 **명시적으로** 되돌릴 수 있다고 말했는가 (2R B1).
   *
   * 기본값이 `false`인 것이 이 prop의 전부다: 아무도 말해 주지 않았으면 되돌릴 수
   * 없는 것으로 다룬다. 예전 기본값은 `true`였고, 그래서 값을 넘기지 않는 호출자
   * 하나가 생기는 순간 비가역 승인이 조용히 "되돌릴 수 있음"이 됐다. 모르는 것을
   * 위험한 쪽으로 읽는 기본값은 되돌릴 수 없는 행동 앞에서 특히 나쁘다.
   */
  reversible?: boolean;
  /**
   * 기한이 이미 지난 대기 행인가 (2R M4).
   *
   * 이때 결정을 보내면 서버는 승인/거부가 아니라 **만료로 확정**한다
   * (`routes/approvals.rs:584`). 확정 문장이 그 사실을 말해야 한다.
   */
  deadlinePassed?: boolean;
  /**
   * 이 승인이 **어디서 실행할지**까지 묻는가 (ADR-0125 D6-A, 이슈 1114).
   *
   * 기본값이 `null`인 것이 이 prop의 전부다: 픽커가 없는 승인은 압도적 다수이고,
   * 없는 것을 없다고 말하는 데 값이 필요하지 않다. 스폰 승인에서만 실린다.
   */
  execution?: SpawnExecutionPlan | null;
  onSettled: (outcome: DecisionOutcome) => void;
  /**
   * 한 목록에 여러 행이 동시에 떠 있으므로 test id는 행마다 달라야 한다. 접두사
   * 하나로 두 행이 같은 id를 답하면 테스트는 자기가 어느 행을 눌렀는지 말할 수
   * 없다.
   */
  testIDPrefix?: string;
  /**
   * 확인 단계에서 시작한다. **`measure/` 하네스 전용이고 앱은 절대 넘기지 않는다.**
   *
   * 왜 필요한가 (#1210 D2): 확정 버튼은 사람이 한 번 탭해야 나타나고, 시뮬레이터는
   * 스크립트로 누를 수 없다(스파이크 #837 — RN 요소가 접근성 트리에 없고 좌표 클릭도
   * 닿지 않는다. `measure/surfaces.tsx` 머리말이 이 하네스가 존재하는 이유로 적어 둔
   * 바로 그 사실이다). 그래서 이 제품에서 **되돌릴 수 없는 두 버튼이 나란히 서는
   * 유일한 화면**은 한 번도 사진으로 리뷰된 적이 없고, 감사가 잰 「거부가 승인보다
   * 5배 조용하다」는 그동안 아무 캡처에도 나타나지 않았다. 다른 상태는 전부 prop 으로
   * 세울 수 있는데 이 하나만 그럴 수 없었던 것이 그 결함이 오래 산 이유다.
   *
   * 기본값이 `null` 이라 앱의 행동은 한 바이트도 바뀌지 않는다. 그리고 넘기면 안 되는
   * 이유가 하나 더 있다: 여기서 시작하면 `armedAtMs` 가 0 이라 `CONFIRM_GUARD_MS`
   * 더블탭 가드를 지나친 상태가 된다. 그래서 규칙을 기억에 맡기지 않고 기계가 진다 —
   * `__tests__/fillTokens.test.ts` 가 `src/` 전수에서 이 prop 의 사용을 0 으로 단정한다.
   */
  initialArmed?: Armed;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {workspaceId} = useSession();
  const [armed, setArmed] = useState<Armed>(initialArmed);
  const [busy, setBusy] = useState(false);
  const [errorCopy, setErrorCopy] = useState<string | null>(null);
  /** 가드 창 안에서 확정 탭이 실제로 있었는가 (2R M1). 죽은 버튼처럼 보이지 않게. */
  const [tooFast, setTooFast] = useState(false);
  // (행, 방향)당 하나. 같은 결정을 다시 누르면 서버가 원래 영수증을 그대로
  // 재생하고, 두 번째 결정이 기록되지 않는다. 멱등 충돌일 때만 버린다 — 그
  // 키는 이미 다른 결정에 묶여 있어서 재시도해도 같은 충돌만 반복한다.
  const keys = useRef<{approve?: string; reject?: string}>({});
  /** 확정 버튼이 이 자리에 뜬 시각. 위의 더블탭 구멍을 막는 데만 쓴다. */
  const armedAtMs = useRef(0);
  // ---- 호스트 선택 (이슈 1114) ---------------------------------------------
  //
  // `null`은 "아무것도 안 골랐다"가 아니라 **"사람이 손대지 않았다"**이다. 찍혀
  // 있는 것은 언제나 코어가 답하는 기본값이고, 그 구분이 결정 본문을 정한다:
  // 손대지 않았으면 키를 안 싣고(서버가 카드의 기본값을 적용한다), 손댔으면
  // 명시적으로 싣는다. 판정은 웹과 **같은 함수**가 한다.
  const [pickedHostId, setPickedHostId] = useState<string | null>(null);
  const chosenHostId = pickedHostId ?? preselectedHostId(execution);
  const hostGate = spawnHostGate(execution);
  const chosenHostName =
    findCandidate(execution, chosenHostId)?.displayName ?? null;

  const arm = useCallback(
    (next: Exclude<Armed, null>) => {
    // 실행할 호스트가 하나도 없으면 승인은 무장조차 하지 않는다. 서버가 409로
    // 답할 것을 결정 전에 알고 있고(코어 `spawnHostGate`), 알면서 확정 화면을
    // 세우는 것은 헛걸음을 시키는 것이다. **거부는 막지 않는다** — 서버도 거부에는
    // 호스트를 묻지 않고, 실행할 수 없는 요청을 정리할 길까지 닫을 이유는 없다.
    if (next === 'approve' && !hostGate.canApprove) return;
    setArmed(next);
    armedAtMs.current = Date.now();
    setErrorCopy(null);
    setTooFast(false);
    // 엄지 밑의 버튼이 방금 의미를 바꿨다. 화면을 보지 않는 사람에게 그 변화는
    // 소리로만 전달된다 — RN에는 포커스를 옮길 웹의 `focus()`가 없다.
    AccessibilityInfo.announceForAccessibility(
      next === 'approve'
        ? '승인을 확정할지 묻습니다.'
        : '거부를 확정할지 묻습니다.',
    );
    },
    [hostGate.canApprove],
  );

  const commit = useCallback(async () => {
    // 이 함수는 확인 단계 뒤에만 있다. `armed`가 null이면 확정 버튼이 그려지지도
    // 않았다는 뜻이므로, 여기서 한 번 더 막는 것은 방어가 아니라 계약의 진술이다:
    // 무장하지 않은 결정은 전송되지 않는다.
    if (armed === null || busy) return;
    // 방금 무장한 그 탭의 꼬리다. 확정 버튼이 앞선 버튼 자리에 떴으므로, 이 창
    // 안의 탭은 확인이 아니라 같은 한 번의 동작으로 본다.
    //
    // 조용히 무시하지는 않는다(2R M1): 아무 일도 일어나지 않는 버튼은 고장난
    // 버튼과 구별되지 않고, 그 자리에서 사람이 하는 다음 행동은 더 세게 두 번
    // 누르는 것이다. 무엇이 일어났는지 한 줄로 말한다.
    if (Date.now() - armedAtMs.current < CONFIRM_GUARD_MS) {
      setTooFast(true);
      return;
    }
    setTooFast(false);
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
        // 픽커가 없으면 `undefined`이고, 그때 키는 본문에 실리지 않는다. 서버는
        // 픽커 없는 승인에 실린 `hostId`를 400으로 거절한다 — 그 거절이 옳다.
        decisionHostId(execution, chosenHostId),
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
  }, [approvalId, armed, busy, chosenHostId, execution, onSettled, workspaceId]);

  if (armed === null) {
    return (
      <View style={styles.bar} testID={`${testIDPrefix}-actions`}>
        <Text style={styles.lead}>실행 전에 회원님의 허가가 필요합니다.</Text>
        {execution !== null ? (
          <SpawnHostChoice
            plan={execution}
            pickedHostId={chosenHostId}
            onPick={setPickedHostId}
            locked={false}
            testIDPrefix={testIDPrefix}
          />
        ) : null}
        <View style={styles.buttons}>
          <Pressable
            accessibilityRole="button"
            // 이 탭은 거부하지 않는다 — 거부할지 묻는다. 라벨이 행동을 약속하면
            // 화면을 보지 않는 사람은 이미 결정한 줄 알고 손을 뗀다 (2R M2).
            accessibilityLabel="거부, 확인 필요"
            accessibilityHint="누르면 거부 확정 여부를 묻습니다."
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
            accessibilityLabel="승인, 확인 필요"
            accessibilityHint="누르면 승인 확정 여부를 묻습니다."
            // 진짜로 할 수 없다: 자격 있는 호스트가 하나도 없으면 서버는 이 승인에
            // 409로 답한다. 이유는 픽커 아래에 이미 서 있으므로, 꺼진 버튼이 설명
            // 없이 서 있는 경우가 아니다.
            accessibilityState={{disabled: !hostGate.canApprove}}
            disabled={!hostGate.canApprove}
            onPress={() => arm('approve')}
            style={({pressed}) => [
              styles.button,
              styles.buttonQuiet,
              !hostGate.canApprove && styles.buttonInert,
              pressed && hostGate.canApprove && styles.pressed,
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

  const consequence = confirmCopy(
    armed,
    reversible,
    deadlinePassed,
    armed === 'approve' ? chosenHostName : null,
  );

  return (
    <View style={styles.bar} testID={`${testIDPrefix}-confirm`}>
      <Text style={styles.consequence}>{consequence}</Text>
      {/* 픽커는 확정 화면에서도 자리를 지킨다. 사라지면 사람은 자기가 무엇을 고른
          채 확정하는지 볼 수 없고, 확인이 판단의 근거 옆에 있어야 한다는 이 파일의
          원칙이 무너진다. 대신 잠긴다 — 확정 문장이 이미 목적지를 말했고, 그 아래에서
          목적지가 바뀌면 읽은 문장과 나가는 요청이 달라진다. */}
      {execution !== null ? (
        <SpawnHostChoice
          plan={execution}
          pickedHostId={chosenHostId}
          onPick={setPickedHostId}
          locked
          testIDPrefix={testIDPrefix}
        />
      ) : null}
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
          <Text
            style={
              armed === 'approve'
                ? styles.buttonCommitLabel
                : styles.buttonRejectLabel
            }>
            {busy ? '보내는 중' : armed === 'approve' ? '승인 확정' : '거부 확정'}
          </Text>
        </Pressable>
      </View>
      {tooFast ? (
        <Text style={styles.hint} testID={`${testIDPrefix}-too-fast`}>
          방금 누른 탭과 이어진 동작이라 보내지 않았습니다. 문장을 확인하고 다시
          누르세요.
        </Text>
      ) : null}
      {errorCopy !== null ? (
        <Text style={styles.error} testID={`${testIDPrefix}-error`}>
          {errorCopy}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * 확정 버튼 위에 놓일 한 문장 — **서버가 실제로 하는 일만** (2R H4/M4).
 *
 * 예전 문장은 "승인하면 에이전트가 바로 실행합니다"였다. 이 서버는 그것을 약속할
 * 수 없다: 승인은 run이 hold를 떠났으면 resume job 없이 200을 답하고
 * (`routes/approvals.rs`의 `approve_run` — `requeue_run_from_approval_in_tx`가
 * false면 아무 job도 넣지 않는다), 정상 경로에서도 실행은 outbox를 거치는 비동기다.
 * "바로"는 우리가 지킬 수 없는 말이고, 승인 화면은 지킬 수 없는 말을 하기에 가장
 * 나쁜 자리다.
 *
 * 거부는 반대로 **같은 트랜잭션**에서 일어난다(`reject_run` → `end_parked_run_in_tx`).
 * 다만 이미 hold를 떠난 run은 취소할 것이 없으므로 문장을 「대기 중인 실행」으로
 * 한정한다.
 */
export function confirmCopy(
  armed: Exclude<Armed, null>,
  reversible: boolean,
  deadlinePassed: boolean,
  /**
   * 스폰 승인에서 지금 찍혀 있는 호스트의 이름 (이슈 1114). 픽커가 없거나 고를 수
   * 있는 것이 없으면 `null`이고, 그때 목적지 절은 통째로 빠진다 — 「어딘가에서
   * 실행합니다」는 문장이 아니라 소음이다.
   */
  hostName: string | null = null,
): string {
  if (deadlinePassed) {
    // 기한이 지난 요청에 보내는 결정은 승인도 거부도 아니다 — 서버가 만료로
    // 확정한다. 승인 문장을 그대로 두면 일어나지 않을 일을 약속하게 된다.
    // 목적지도 붙이지 않는다: 아무 데서도 실행되지 않는다.
    return '기한이 지난 요청입니다. 지금 보내면 승인도 거부도 아닌 만료로 기록됩니다.';
  }
  if (armed === 'approve') {
    // 목적지는 **조건절 안**에 있다. 별도 문장으로 앞세우면("…에서 실행합니다")
    // 이 승인이 지킬 수 없는 약속을 현재 직설로 단언하게 되고, 바로 뒤에 오는
    // 조건과 서로를 반박한다 — 근거는 코어 `spawnApproveLead`에 있다.
    const base = spawnApproveLead(hostName);
    return reversible ? base : `${base} 되돌릴 수 없습니다.`;
  }
  return '거부하면 대기 중인 실행이 취소됩니다.';
}

const buildStyles = (color: Palette) => StyleSheet.create({
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
  // 채움은 `dangerBorder` 였다 (#1210 D2). 폰에 파괴 **채움** 토큰이 없어서 테두리
  // 토큰을 바탕으로 쓰고 있었고, 그래서 다크에서 되돌릴 수 없는 「거부 확정」이 이
  // 카드(`surface`) 위 1.64:1 · 그 옆의 「승인 확정」이 8.12:1 이었다 — 파괴 쪽이
  // 5배 조용했다. `dangerFill` 은 웹 `--danger-fill` 의 두 항이고, 같은 카드 위
  // 다크 5.83:1 · 라이트 7.52:1 이면서 채도는 accent 아래다(다크 0.1130 대
  // 0.1336): 보이되 주 액션을 이기지 않는다.
  buttonReject: {backgroundColor: color.dangerFill},
  buttonInert: {opacity: 0.6},
  buttonQuietLabel: {fontSize: font.label, fontWeight: '600', color: color.text},
  buttonCommitLabel: {fontSize: font.label, fontWeight: '600', color: color.onAccent},
  // 두 확정 버튼의 채움이 갈라졌으므로 그 위의 글자도 갈라진다. `onAccent` 하나가
  // 두 채움을 다 덮던 동안 거부 라벨은 다크에서 어두운 잉크(#17161a)가 어두운
  // 바탕(#623635) 위에 얹혀 1.80:1 이었다 — AA 는커녕 3:1 도 아니다.
  buttonRejectLabel: {fontSize: font.label, fontWeight: '600', color: color.onDangerFill},
  error: {fontSize: font.meta, color: color.danger, lineHeight: 18},
  hint: {fontSize: font.meta, color: color.textMuted, lineHeight: 18},
  pressed: {backgroundColor: color.surfacePressed},
});

// -----------------------------------------------------------------------------
// 결정 뒤에 무엇이라 말하는가
//
// 이 문구는 `InboxScreen` 안에 있었다. U4-4 M1 이 타임라인 승인 카드에 같은
// 컨트롤을 세우면서 **호출자가 둘**이 됐고, 화면 안에 두면 두 번째 호출자는
// 화면에서 화면을 import 하거나(순환) 문장을 복제하게 된다. 복제된 순간 두
// 경로는 같은 원장 응답에 서로 다른 말을 하기 시작하고, 갈라진 쪽은 아무도 보고
// 있지 않은 쪽이다 — 이 파일 머리말이 `decideApproval` 에 대해 이미 한 말과 같다.
// -----------------------------------------------------------------------------
/**
 * 원장이 답한 것을 한 문장으로 (2R H4/M3).
 *
 * 두 가지가 1R과 다르다. 첫째, **약속하지 않는다**: "에이전트가 이어서 실행합니다"는
 * 서버가 보장하지 않는 후속(`approve_run`은 run이 hold를 떠났으면 job 없이 200)이라
 * 영수증은 원장에 무엇이 적혔는지까지만 말한다. 둘째, superseded일 때 **실제로
 * 기록된 방향**을 말한다 — 내가 승인을 눌렀는데 원장에 거부가 적혀 있을 수 있고,
 * 그때 "이미 결정되었습니다"만 말하면 사람은 자기가 누른 대로 됐다고 읽는다.
 */
export function decisionReceiptCopy(outcome: DecisionOutcome): string {
  if (outcome.kind === 'superseded') {
    if (outcome.status === 'approved') {
      return '이미 승인으로 기록되어 있었습니다.';
    }
    if (outcome.status === 'rejected') {
      return '이미 거부로 기록되어 있었습니다.';
    }
    if (outcome.status === 'expired') {
      return '결정 전에 만료되어 만료로 기록되었습니다.';
    }
    if (outcome.status === 'cancelled') {
      return '이 요청은 취소되어 있었습니다.';
    }
    return outcome.note ?? '이 요청은 이미 결정되어 있었습니다.';
  }
  if (outcome.status === 'approved') return '승인을 기록했습니다.';
  if (outcome.status === 'rejected') return '거부를 기록했습니다.';
  // 200을 받았지만 원장이 알아볼 수 없는 상태를 답했다. 무엇으로 기록됐는지 우리가
  // 모르므로, 안다고 말하지 않는다.
  return '결정을 보냈습니다. 기록된 상태는 목록에서 확인하세요.';
}
