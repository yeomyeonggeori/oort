import {DM_LEAVE_KEYS, dmLeaveConfirmCopy} from '@momo/core/features/channels/dmLeave';
import React from 'react';

import {ConfirmStep} from '../../design/sheetParts';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import type {DmLeaveStepView} from './useChannelRowActions';

// =============================================================================
// 1:1 「대화 나가기」의 확인 단계 (ADR-0177 증보 2026-11-14 D21, #5826).
//
// 세 자리(사이드바 행 시트 · 대화 ⋮ 시트 · 대화 정보 페이지)가 같은 단계를 세운다 — 채널 나가기와 같은 공용 `ConfirmStep`(시트·페이지 안의
// 카드 + 「취소」·위험 단추)이고, 문장은 코어 사전의 D21 문장 그대로다(`dmLeaveConfirmCopy`: 제목 · 본문 · 다시 이어짐 · 되돌릴 수 없음 ·
// 예약 N개는 N>0 일 때만). 줄마다 한 문단으로 선다.
//
// 「취소」가 앞(왼쪽)이다. 확정은 단계가 선 뒤 잠깐 눌림을 받지 않고(훅 `DM_LEAVE_CONFIRM_ARM_MS`), 진행 중에는 확정과 「취소」가 모두 잠기고(흐림·`disabled`) 확정 낱말이 사전의 「나가는 중…」(`DM_LEAVE_KEYS.busy`)로 바뀐다.
// =============================================================================

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
    scheduledCount: step.scheduledCount,
  });
  return (
    <ConfirmStep
      testID={testID}
      headline={copy.title}
      detail={copy.lines.join('\n')}
      error={step.error}
      errorTestID={`${testID}-error`}
      confirmLabel={copy.confirm}
      pendingLabel={formatMessage(DM_LEAVE_KEYS.busy)}
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
