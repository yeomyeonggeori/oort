import {
  decideApproval,
  newDecisionId,
  type DecisionOutcome,
} from '@momo/core/features/timeline/approvalDecision';
import type {SpawnExecutionPlan} from '@momo/core/lib/executionPlan';
import {
  decisionHostId,
  preselectedHostId,
  spawnHostGate,
} from '@momo/core/features/timeline/spawnHostChoice';
import React, {useCallback, useContext, useImperativeHandle, useRef, useState} from 'react';
import {QueryClientContext} from '@tanstack/react-query';
import {refreshProfileAfterApproval} from '@momo/core/features/approvals/profileChange';
import {replacePersistedMember} from '../../storage/secureSession';
import {AccessibilityInfo, Pressable, StyleSheet, Text, View} from 'react-native';
import {font, radius, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {Sentence} from '../../design/atoms';
import {useStyles} from '../../design/theme';
import {dismissApprovalNotifications} from '../../push/approvalNotifications';
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
// ## 한 번 탭하면 결정된다 (#3819)
//
// 성재(2026-10-14): 「승인을 누르면 그냥 승인이 되게 해줘 또 확정 같은 거 누르지
// 않아도 되게.」 이 파일이 오래 지키던 제자리 2단(첫 탭은 묻고 둘째 탭이 결정)은
// 걷혔다. 실수 방지는 탭 **전에** 카드가 보여 주는 사실 — 영향, 결정 권한, 고른
// 호스트, 기한 — 이 지고, 탭한 뒤에는 멱등 키와 `sending` 이 같은 결정이 두 번
// 나가는 것을 막는다. 잠금화면의 승인/거부는 Face ID 를 요구하는 별개의 통제이고
// (`src/push/categories.ts:31`) 그대로다.
//
// 결정 중에는 두 버튼이 모두 잠기고, 누른 쪽이 「보내는 중」으로 말한다. 서버의
// 결정은 되돌릴 수 없으므로 「되돌리기」는 두지 않는다 — 지연 전송으로 흉내 내면
// 앱을 닫는 순간 결정이 조용히 사라진다.
// =============================================================================

type Direction = 'approve' | 'reject';

/**
 * 버튼 밖에서 같은 결정을 부르는 손잡이 (#2595).
 *
 * 타임라인 행은 접근성 요소 하나다(`MessageRow` 의 「행 하나 = 요소 하나」). 그 안의
 * 버튼에는 VoiceOver 가 닿지 못하므로, 행이 로터 동작(「승인」·「거부」)을 내고 그
 * 동작이 이 손잡이를 부른다. **두 번째 결정 경로가 아니다** — 버튼이 부르는 바로 그
 * `commit` 이고, 멱등 키·보내는 중 잠금·호스트 판정·403 문장이 모두 같다.
 */
export interface ApprovalDecisionHandle {
  decide: (direction: Direction) => void;
}

/**
 * 확정 버튼이 뜬 뒤 탭을 받기까지. **승인 결정은 이제 이 값을 쓰지 않는다**(#3819):
 * 아직 읽는 곳은 턴 중단 확인(`StopTurnControl`) 하나다.
 */
export const CONFIRM_GUARD_MS = 400;

/**
 * 결정 뒤 컨트롤 아래 줄의 격 (ADR-0186 §5 · 웹 `ApprovalActions` 의 `errorTone`).
 *
 *   error  무엇인가 실패했다. `color.danger`.
 *   quiet  실패가 아니다 — 이 사람이 결정할 수 없다는 **사실**이고 요청은 여전히
 *          대기다. 사람이 할 수 있는 다음 행동(권한 있는 사람에게 알리기)이 있으므로
 *          사고의 색을 입히지 않는다. 웹의 `unavailable`(ink-muted)과 같은 자리다.
 */
type NoticeTone = 'error' | 'quiet';

/**
 * 컨트롤 머리의 기본 문장. 인박스와 도구 호출 승인 카드가 쓴다.
 *
 * 「회원님의 허가」는 **누구나 결정할 수 있는** 승인에서만 참이다 — 도구 호출
 * 승인은 채널의 사람 멤버면 누구나 결정한다(ADR-0186 §1.2). 역할이 걸린 행동
 * 승인에서 이 문장은 바로 위 「관리자만 승인할 수 있습니다」와 정면으로 부딪친다
 * (#2513 design-review H-1). 그래서 호출자가 바꾸거나 뺄 수 있다(`lead`).
 */
export const DEFAULT_DECISION_LEAD = '실행하기 전에 허가가 필요해요.';

export function ApprovalDecision({
  approvalId,
  deadlinePassed = false,
  execution = null,
  onSettled,
  testIDPrefix = 'inbox-approval',
  forbiddenCopy = null,
  lead = DEFAULT_DECISION_LEAD,
  shape = 'box',
  decisionRef,
  approveDisabled = false,
}: {
  /** 로터 동작이 같은 결정을 부를 손잡이 (#2595). 인박스는 버튼에 직접 닿으므로 넘기지 않는다. */
  decisionRef?: React.Ref<ApprovalDecisionHandle>;
  /** 사진이 실제로 표시되기 전에는 승인만 막는다. 거부는 계속 가능하다. */
  approveDisabled?: boolean;
  /**
   * 버튼 모양. `pill` 은 대화 안 에이전트 카드의 행동 줄(DS2-4, 시안 A `.a-pill`:
   * 주 = 잉크, 보조 = surface2, 반경 알약)이다. 인박스·잠금화면은 `box` 그대로다.
   */
  shape?: 'box' | 'pill';
  approvalId: string;
  /**
   * 기한이 이미 지난 대기 행인가 (2R M4).
   *
   * 이때 결정을 보내면 서버는 승인/거부가 아니라 **만료로 확정**한다
   * (`routes/approvals.rs:584`). 탭 전에 그 사실을 말한다(머리 문장을 대신한다).
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
   * 403 일 때 이 컨트롤이 대신 할 말 (ADR-0186 §5 · 웹 `forbiddenCopy`).
   *
   * `null`(기본)이면 코어의 문장이 붉게 선다. 넘기면 문장이 호출자의 것이 되고
   * (부록 A 의 `required_role` 을 아는 카드만 「관리자가 승인해야 해요」라고 말할 수
   * 있다), 붉지 않다 — 사고가 아니라 이 사람의 역할에 대한 사실이고 요청은 여전히
   * 대기다(`NoticeTone`). 버튼은 그대로 남는다. 서버가 이름을 댄 `role_required` 와
   * 이름 없는 `forbidden` 이 같은 갈래를 탄다.
   */
  forbiddenCopy?: string | null;
  /**
   * 버튼 위 머리 문장. `null` 이면 세우지 않는다 (#2513 design-review H-1).
   *
   * 행동 승인 카드는 누가 결정할 수 있는지를 이미 사실 행(「결정 권한」)으로
   * 말한다. 그 아래에서 컨트롤이 읽는 사람의 권한을 다시 단정하면 카드가 한 화면에서
   * 두 가지를 말한다. 웹의 `ApprovalActions` 가 같은 칸(`lead`)을 호출자에게 열어 둔
   * 것과 같은 모양이다.
   */
  lead?: string | null;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const pill = shape === 'pill';
  const {workspaceId} = useSession();
  const queryClient = useContext(QueryClientContext);
  /** 지금 서버에 나가 있는 결정의 방향. 없으면 `null`. */
  const [sending, setSending] = useState<Direction | null>(null);
  /** 같은 틱의 두 번째 탭을 거르는 동기 문. state 는 다음 렌더에야 바뀐다. */
  const sendingRef = useRef(false);
  const [errorCopy, setErrorCopy] = useState<string | null>(null);
  const [noticeTone, setNoticeTone] = useState<NoticeTone>('error');
  // (행, 방향)당 하나. 같은 결정을 다시 누르면 서버가 원래 영수증을 그대로
  // 재생하고, 두 번째 결정이 기록되지 않는다. 멱등 충돌일 때만 버린다 — 그
  // 키는 이미 다른 결정에 묶여 있어서 재시도해도 같은 충돌만 반복한다.
  const keys = useRef<{approve?: string; reject?: string}>({});
  // ---- 호스트 선택 (이슈 1114) ---------------------------------------------
  //
  // `null`은 "아무것도 안 골랐다"가 아니라 **"사람이 손대지 않았다"**이다. 찍혀
  // 있는 것은 언제나 코어가 답하는 기본값이고, 그 구분이 결정 본문을 정한다:
  // 손대지 않았으면 키를 안 싣고(서버가 카드의 기본값을 적용한다), 손댔으면
  // 명시적으로 싣는다. 판정은 웹과 **같은 함수**가 한다.
  const [pickedHostId, setPickedHostId] = useState<string | null>(null);
  const chosenHostId = pickedHostId ?? preselectedHostId(execution);
  const hostGate = spawnHostGate(execution);
  const canApprove = hostGate.canApprove && !approveDisabled;
  const busy = sending !== null;

  const commit = useCallback(
    async (direction: Direction, spoken = false) => {
      if (sendingRef.current) return;
      // 실행할 호스트가 하나도 없으면 승인은 나가지 않는다. 서버가 409로 답할 것을
      // 결정 전에 알고 있고(코어 `spawnHostGate`), 알면서 보내는 것은 헛걸음이다.
      // **거부는 막지 않는다** — 서버도 거부에는 호스트를 묻지 않고, 실행할 수 없는
      // 요청을 정리할 길까지 닫을 이유는 없다.
      if (direction === 'approve' && !canApprove) return;
      const approve = direction === 'approve';
      keys.current[direction] ??= newDecisionId();
      sendingRef.current = true;
      setSending(direction);
      setErrorCopy(null);
      try {
        const outcome = await decideApproval(
          workspaceId,
          approvalId,
          approve,
          keys.current[direction] as string,
          // 픽커가 없으면 `undefined`이고, 그때 키는 본문에 실리지 않는다. 서버는
          // 픽커 없는 승인에 실린 `hostId`를 400으로 거절한다 — 그 거절이 옳다.
          decisionHostId(execution, chosenHostId),
        );
        if (outcome.kind === 'error') {
          if (outcome.errorCode === 'idempotency_conflict') {
            delete keys.current[direction];
          }
          if (
            (outcome.errorCode === 'role_required' ||
              outcome.errorCode === 'forbidden') &&
            forbiddenCopy !== null
          ) {
            // 카드는 여전히 대기이므로 승인·거부는 그대로 남고, 이 사람에게 참인
            // 사실은 그 아래 한 줄이 진다. RN 에는 옮길 `focus()` 가 없으므로 화면을
            // 보지 않는 사람에게는 소리 하나로 알린다.
            setNoticeTone('quiet');
            setErrorCopy(forbiddenCopy);
            AccessibilityInfo.announceForAccessibility(forbiddenCopy);
            return;
          }
          setNoticeTone('error');
          const copy = outcome.errorCopy ?? '결정을 처리하지 못했어요.';
          setErrorCopy(copy);
          // 로터로 결정한 사람의 초점은 행 위에 있고, 이 줄은 그 행의 낭독 라벨에
          // 들어가지 않는다. 소리로 한 번 말하지 않으면 실패가 들리지 않는다.
          if (spoken) AccessibilityInfo.announceForAccessibility(copy);
          return;
        }
        // `superseded`도 결정된 것이다(다른 기기에서 이미 결정됐거나 만료됨).
        // 실패로 그리면 더는 바뀔 수 없는 것에 재시도를 권하게 된다 —
        // `src/push/notifications.ts`의 `decideFromNotification`이 같은 이유로
        // 같은 선택을 한다.
        //
        // 결정된 승인의 알림은 알림 센터에서 걷는다(#3926). 기다리지 않는다: 걷는
        // 일은 던지지 않고(`dismissApprovalNotifications`), 화면은 이미 결정을 안다.
        void dismissApprovalNotifications(approvalId);
        onSettled(outcome);
        void refreshProfileAfterApproval(outcome, replacePersistedMember, (workspace, rows) => {
          queryClient?.setQueryData(['roster', workspace], rows);
        });
        // 로터로 결정한 사람에게는 성공도 소리로 말한다(#3854 design-review H-2).
        // 카드에 서는 영수증은 행의 낭독 라벨에 들어가지 않고, 로터의 「승인」·
        // 「거부」는 말없이 사라진다. 낱말은 카드 영수증과 같은 함수가 짓는다.
        if (spoken) {
          AccessibilityInfo.announceForAccessibility(decisionReceiptCopy(outcome));
        }
      } finally {
        sendingRef.current = false;
        setSending(null);
      }
    },
    [
      approvalId,
      chosenHostId,
      execution,
      forbiddenCopy,
      canApprove,
      onSettled,
      queryClient,
      workspaceId,
    ],
  );

  useImperativeHandle(
    decisionRef,
    () => ({decide: (direction: Direction) => void commit(direction, true)}),
    [commit],
  );

  // 기한이 지난 요청에 보내는 결정은 승인도 거부도 아니다 — 서버가 만료로 확정한다.
  // 탭 **전에** 그 사실을 말한다. 목적지도 붙이지 않는다: 아무 데서도 실행되지 않는다.
  const headline = deadlinePassed ? DEADLINE_PASSED_LEAD : lead;

  return (
    <View style={[styles.bar, pill && styles.pillBar]} testID={`${testIDPrefix}-actions`}>
      {headline !== null ? <Sentence style={styles.lead}>{headline}</Sentence> : null}
      {execution !== null ? (
        <SpawnHostChoice
          plan={execution}
          pickedHostId={chosenHostId}
          onPick={setPickedHostId}
          locked={busy}
          testIDPrefix={testIDPrefix}
        />
      ) : null}
      <View style={styles.buttons}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="거부"
          accessibilityState={{disabled: busy, busy: sending === 'reject'}}
          disabled={busy}
          onPress={() => void commit('reject')}
          style={({pressed}) => [
            styles.button,
            styles.buttonQuiet,
            pill && styles.pillButton,
            pill && styles.pillQuiet,
            // 잠긴 모양은 **반대편**만 입는다. 자기 결정이 나가는 중인 버튼은 흐리지
            // 않는다 — 「보내는 중」은 지금 읽혀야 하는 낱말이다(#3829 M4).
            sending === 'approve' && styles.buttonInert,
            pressed && !busy && styles.pressed,
          ]}
          testID={`${testIDPrefix}-reject`}>
          <Text style={styles.buttonQuietLabel}>
            {sending === 'reject' ? '보내는 중' : '거부'}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="승인"
          // 진짜로 할 수 없다: 자격 있는 호스트가 하나도 없으면 서버는 이 승인에
          // 409로 답한다. 이유는 픽커 아래에 이미 서 있으므로, 꺼진 버튼이 설명
          // 없이 서 있는 경우가 아니다.
          accessibilityState={{
            disabled: busy || !canApprove,
            busy: sending === 'approve',
          }}
          disabled={busy || !canApprove}
          onPress={() => void commit('approve')}
          style={({pressed}) => [
            styles.button,
            // 이제 이 탭이 결정이다 — 주 액션은 채움으로 선다(웹 `variant="default"`).
            // 막힌 승인은 조용한 형태로 강등한다: 지금은 이것이 기본 액션이 아니다.
            canApprove ? styles.buttonCommit : styles.buttonQuiet,
            pill && styles.pillButton,
            pill && (canApprove ? styles.pillCommit : styles.pillQuiet),
            (sending === 'reject' || !canApprove) && styles.buttonInert,
            // 눌림은 **채움의 눌린 값**이다. 옅은 눌림 회색(`surfacePressed`)으로
            // 갈아 끼우면 채움의 흰 글자가 옅은 바탕에 앉는다(#3829 M4 — 라이트
            // 1:1 근처). 상자는 `accentPressed`(atoms `PrimaryButton` 과 같은 값),
            // 알약은 잉크 채움을 지키고 살짝 흐린다(웹 `hover:opacity-90` 의 짝).
            pressed &&
              !busy &&
              canApprove &&
              (pill ? styles.pillCommitPressed : styles.buttonCommitPressed),
          ]}
          testID={`${testIDPrefix}-approve`}>
          <Text
            style={[
              canApprove ? styles.buttonCommitLabel : styles.buttonQuietLabel,
              pill && canApprove && styles.pillCommitLabel,
            ]}>
            {sending === 'approve' ? '보내는 중' : '승인'}
          </Text>
        </Pressable>
      </View>
      {errorCopy !== null ? (
        <Sentence
          // 403 뒤의 안내는 **이 자리**에 선다. 격은 `noticeTone` 이 정한다 — 같은
          // testID 에 두 격이 서는 것은 웹과 같은 모양이다(`approval-error` +
          // `data-tone`). 두 문장짜리 안내라 어절에서 접는다.
          style={noticeTone === 'quiet' ? styles.hint : styles.error}
          testID={`${testIDPrefix}-error`}>
          {errorCopy}
        </Sentence>
      ) : null}
    </View>
  );
}

/** 기한이 지난 요청의 머리 문장. 결정하기 **전에** 말해야 하는 사실이다. */
const DEADLINE_PASSED_LEAD =
  '기한이 지난 요청이에요. 지금 보내면 승인도 거부도 아닌 만료로 기록돼요.';

const buildStyles = (color: Palette) => StyleSheet.create({
  bar: {gap: space.sm, paddingBottom: space.md},
  lead: {fontSize: font.meta, color: color.textMuted},
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
  buttonCommitPressed: {backgroundColor: color.accentPressed},
  buttonInert: {opacity: 0.6},
  /** 시안 `.a-pill{border-radius:19px}` — 높이는 엄지 바닥 44 를 지킨다. */
  pillButton: {borderRadius: radius.pill},
  /** 카드 안에서는 카드 패딩이 아래를 진다 — 인박스용 아래 여백을 겹치지 않는다(검수 L-2). */
  pillBar: {paddingBottom: 0},
  /** `.a-pill.sec{background:var(--surface2);color:var(--ink)}`. */
  pillQuiet: {borderWidth: 0, backgroundColor: color.surfaceMuted},
  /** `.a-pill.pri{background:var(--primary);color:var(--onPrimary)}`. */
  pillCommit: {backgroundColor: color.primary},
  pillCommitPressed: {opacity: 0.85},
  pillCommitLabel: {color: color.onPrimary},
  buttonQuietLabel: {fontSize: font.label, fontWeight: '600', color: color.text},
  buttonCommitLabel: {fontSize: font.label, fontWeight: '600', color: color.onAccent},
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
  if (outcome.kind === 'committed' && outcome.status === 'cancelled') {
    return '이 요청은 취소되어 있었어요.';
  }
  if (outcome.kind === 'superseded') {
    if (outcome.status === 'approved') {
      return '이미 승인으로 기록되어 있었어요.';
    }
    if (outcome.status === 'rejected') {
      return '이미 거부로 기록되어 있었어요.';
    }
    if (outcome.status === 'expired') {
      return '결정 전에 만료되어 만료로 기록되었어요.';
    }
    if (outcome.status === 'cancelled') {
      return '이 요청은 취소되어 있었어요.';
    }
    return outcome.note ?? '이 요청은 이미 결정되어 있었어요.';
  }
  if (outcome.status === 'approved') return '승인을 기록했어요.';
  if (outcome.status === 'rejected') return '거부를 기록했어요.';
  // 200을 받았지만 원장이 알아볼 수 없는 상태를 답했다. 무엇으로 기록됐는지 우리가
  // 모르므로, 안다고 말하지 않는다.
  return '결정을 보냈어요. 기록된 상태는 목록에서 확인해 주세요.';
}
