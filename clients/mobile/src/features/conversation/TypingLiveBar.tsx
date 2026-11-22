import {
  typingLabel,
  typingVisualSegments,
  TYPING_AGGREGATE_THRESHOLD_FALLBACK,
} from '@momo/core/features/chat/typing';
import {memberFor, memberNameParts, type Directory} from '@momo/core/features/workspace/directory';
import React, {memo, useCallback, useEffect, useMemo} from 'react';

import {TypingBar} from './TypingBar';
import {sweepTyping, useTypingNow, useTypists} from './typingSignals';

// 「작성 중」 줄과 그 시계를 한 부품에 묶는다 (#5756).
// 1초 시계(`useTypingNow`)가 이 부품만 다시 그리게 하려는 것이다 — 대화 화면은 분 눈금 그대로다.
export const TypingLiveBar = memo(function TypingLiveBarInner({
  channelId,
  myMemberId,
  directory,
}: {
  channelId: string;
  myMemberId: string;
  directory: Directory;
}) {
  const nowMs = useTypingNow();
  // 만료를 훑는다. 버릴 것이 없으면 아무 일도 일어나지 않는다(`sweepTyping`).
  useEffect(() => sweepTyping(nowMs), [nowMs]);

  // 에이전트·명부에 없는 id 는 화면에서 떨군다(「사람은 작성 중, 에이전트는 작업 중」).
  const isEligible = useCallback(
    (memberId: string) => memberFor(directory, memberId)?.kind === 'human',
    [directory],
  );
  const typists = useTypists({channelId, nowMs, myMemberId, isEligible});
  const names = useMemo(
    () => typists.map(id => memberNameParts(directory, id, '').name),
    [typists, directory],
  );
  const segments = useMemo(() => typingVisualSegments(names), [names]);
  const label = useMemo(
    () => typingLabel(names, TYPING_AGGREGATE_THRESHOLD_FALLBACK),
    [names],
  );
  return <TypingBar segments={segments} label={label} />;
});
