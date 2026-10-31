import React from 'react';
import {PageSheet, usePageSheetAction} from '../../design/PageSheet';
import {EmojiPicker} from '../emoji/EmojiPicker';
import {TeamExpressionPicker} from './TeamExpressionPicker';

export function ExpressionComposerPicker({
  onClose,
  onInsert,
  onSend,
}: {
  onClose: () => void;
  onInsert: (glyph: string) => void;
  onSend: (body: string) => void;
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
          />
        ),
      }}
    />
  );
}

/** The sheet owns its modal so the composer's unrelated scroll views stay outside it. */
export function ExpressionComposerModal(
  {onClose, onInsert, onSend}: React.ComponentProps<typeof ExpressionComposerPicker>,
) {
  return (
    <PageSheet onClose={onClose} accessibilityLabel="이모지 고르기">
      <ExpressionComposerPicker onClose={onClose} onInsert={onInsert} onSend={onSend} />
    </PageSheet>
  );
}
