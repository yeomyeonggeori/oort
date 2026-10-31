import React from 'react';
import {PageSheet, usePageSheetAction} from '../../design/PageSheet';
import {EmojiPicker} from '../emoji/EmojiPicker';
import {TeamExpressionPicker} from './TeamExpressionPicker';

export function ExpressionComposerPicker({
  onClose,
  onInsert,
  onSend,
  onOpenConversation,
}: {
  onClose: () => void;
  onInsert: (glyph: string) => void;
  onSend: (body: string) => void;
  /** 「AI와 만들기」 요청을 보낸 뒤 그 DM 으로 간다. 호스트(입력창)가 대화로 가는 길을 줄 때만 선다. */
  onOpenConversation?: React.ComponentProps<
    typeof TeamExpressionPicker
  >['onOpenConversation'];
}) {
  const afterClose = usePageSheetAction();
  return (
    <EmojiPicker
      onClose={onClose}
      onSelect={glyph => afterClose(() => onInsert(glyph))}
      team={{
        render: ({query}) => (
          <TeamExpressionPicker
            query={query}
            mode="message"
            onSelect={token => afterClose(() => onSend(token))}
            onOpenConversation={onOpenConversation}
          />
        ),
      }}
    />
  );
}

/** The sheet owns its modal so the composer's unrelated scroll views stay outside it. */
export function ExpressionComposerModal(
  {onClose, onInsert, onSend, onOpenConversation}: React.ComponentProps<typeof ExpressionComposerPicker>,
) {
  return (
    <PageSheet onClose={onClose} accessibilityLabel="이모지 고르기">
      <ExpressionComposerPicker onClose={onClose} onInsert={onInsert} onSend={onSend} onOpenConversation={onOpenConversation} />
    </PageSheet>
  );
}
