import {DM_LEAVE_KEYS, dmLeaveConfirmCopy} from '@momo/core/features/channels/dmLeave';
import {SCHEDULED_COPY} from '@momo/core/features/scheduled/copy';
import React from 'react';

import {ConfirmStep} from '../../design/sheetParts';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import type {DmLeaveStepView} from './useChannelRowActions';

// =============================================================================
// 1:1 「대화 나가기」의 확인 단계 (ADR-0177 증보 2026-11-14 D21, #5826).
//
// 세 자리(사이드바 행 시트 · 대화 ⋮ 시트 · 대화 정보 페이지)가 같은 단계를 세운다 — 채널 나가기와 같은 공용 `ConfirmStep`(시트·페이지 안의
// 카드 + 「취소」·위험 단추)이고, 문장과 차례는 코어가 내준 그대로다(`dmLeaveConfirmCopy`, 웹과 같은 함수: 제목 · 본문 · 다시 이어짐 ·
// 예약 N개 · 마지막에 「되돌릴 수 없어요」). 줄마다 한 문단으로 선다.
//
// 「예약 N개」 자리는 **늘 한 줄을 잡아 둔다**(웹의 `ScheduledSlot` 과 같다, #5876): 목록을 아직 모를 때 「확인 중…」, 못 읽었을 때 그 까닭,
// 알았을 때 N 개 문장(없으면 빈 줄)이 같은 자리에 서서 문장이 바뀌어도 시트 높이·단추 자리가 움직이지 않는다. 모르거나 못 읽은 동안과 다시 눌러도 같은
// 답(409·405)인 뒤에는 확정이 잠긴다(`confirmDisabled`) — 이유는 그 자리의 문장과 실패 줄이 말한다.
//
// 「취소」가 앞(왼쪽)이다. 확정은 단계가 선 뒤 잠깐 눌림을 받지 않고(훅 `DM_LEAVE_CONFIRM_ARM_MS`), 진행 중에는 확정과 「취소」가 모두 잠기고(흐림·`disabled`) 확정 낱말이 사전의 「나가는 중…」(`DM_LEAVE_KEYS.busy`)로 바뀐다.
// =============================================================================

/**
 * 진행 중(요청이 이미 나갔다)에 시트가 몸짓으로 닫히지 않게 하는 `PageSheet.onDiscardPrompt` — 「버릴까요?」를 묻지도 않고 `discard` 도 안 부른다.
 * 두 시트(행 시트·⋮ 시트)가 `dirty={dmLeave?.pending === true}` 와 함께 쓴다.
 */
export function ignoreDiscard(): void {}

/** 알았지만 예약이 없을 때 그 자리를 비워 둔 한 줄(줄 높이만 남긴다). */
const EMPTY_SLOT = '\u00A0';

export function DmLeaveConfirm({
  step,
  onConfirm,
  onCancel,
  testID,
}: {
  step: DmLeaveStepView;
  onConfirm: () => void;
  onCancel: () => void;
  /** 단계의 testID 머리. 카드 `<testID>`, 설명 `<testID>-detail`, 단추 `<testID>-cancel`·`<testID>-button`, 실패 `<testID>-error`. */
  testID: string;
}): React.JSX.Element {
  const formatMessage = useFormatMessage();
  const copy = dmLeaveConfirmCopy(formatMessage, {
    name: step.name,
    scheduledCount: step.scheduled === 'known' ? step.scheduledCount : 0,
  });
  const slot =
    step.scheduled === 'checking'
      ? formatMessage(DM_LEAVE_KEYS.checking)
      : step.scheduled === 'failed'
        ? SCHEDULED_COPY.load.error
        : (copy.scheduled ?? EMPTY_SLOT);
  return (
    <ConfirmStep
      testID={testID}
      headline={copy.title}
      detail={[...copy.body, slot, copy.warning].join('\n')}
      error={step.error}
      errorTestID={`${testID}-error`}
      confirmLabel={copy.confirm}
      pendingLabel={formatMessage(DM_LEAVE_KEYS.busy)}
      confirmDisabled={step.scheduled !== 'known' || step.unavailable}
      cancelDisabled={step.pending}
      cancelLabel={copy.cancel}
      pending={step.pending}
      onCancel={onCancel}
      onConfirm={onConfirm}
      cancelTestID={`${testID}-cancel`}
      confirmTestID={`${testID}-button`}
    />
  );
}
