import type {Channel} from '@momo/core/lib/api';
import React, {useState} from 'react';
import {ExpressionMakeForm} from './ExpressionMakeForm';
import {ExpressionPhotoForm} from './ExpressionPhotoForm';

// =============================================================================
// 「AI와 만들기」의 입구 (ADR-0218 §8 H9, #4941 · 폰 #4984) — 웹 `ExpressionMakeEntry` 와 같은 약속이다.
//
// 기본은 팀에 연결된 이미지 모델로 사진을 바로 만드는 양식(`ExpressionPhotoForm`)이고, 에이전트에게 부탁하는 길
// (#4820 B — 대화로 요청을 보내고 승인 카드로 받는다)은 그 양식 안의 단추 하나(「에이전트에게 부탁하기」)로 남는다.
// 에이전트 길의 「‹」는 목록이 아니라 그 단추를 누른 양식으로 돌아온다(한 겹만 벗긴다 — `ExpressionChapter` 머리말).
// =============================================================================

export function ExpressionMakeEntry({
  onBack,
  onDone,
  onImport,
  onOpenConversation,
}: {
  onBack: () => void;
  onDone: () => void;
  onImport: () => void;
  onOpenConversation?: (channel: Channel) => void;
}): React.JSX.Element {
  const [agent, setAgent] = useState(false);
  return agent ? (
    <ExpressionMakeForm
      onBack={() => setAgent(false)}
      onDone={onDone}
      onImport={onImport}
      onOpenConversation={onOpenConversation}
    />
  ) : (
    <ExpressionPhotoForm
      onBack={onBack}
      onImport={onImport}
      onAgent={() => setAgent(true)}
      onDone={onDone}
    />
  );
}
