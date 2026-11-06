import type {Channel} from '@momo/core/lib/api';
import React, {useState} from 'react';
import {StyleSheet, View} from 'react-native';
import {Sentence} from '../../design/atoms';
import {PageSheet} from '../../design/PageSheet';
import {SheetHeader} from '../../design/SheetChrome';
import {GroupCard, ListRow} from '../../design/sheetParts';
import {useStyles} from '../../design/theme';
import {font, line, SAFE_GUTTER, space, type Palette} from '../../design/tokens';
import {useCanAddExpression} from './ExpressionAddMenu';
import {ExpressionImportForm} from './ExpressionImportForm';
import {ExpressionMakeEntry} from './ExpressionMakeEntry';
import {useExpressions} from './ExpressionProvider';
import {useExpressionMessages} from './useExpressionMessages';

// =============================================================================
// 이모티콘 창의 「＋」 (#5452) - 가져오기 · AI와 만들기.
//
// 두 길은 글자 칸이 있는 폼이라 키보드를 부른다. 키보드 자리의 창 안에서 열면 창이 서 있어야 할 바로 그 자리를 키보드가 덮으므로, 창 **밖**의 시트로 연다(창은 그대로 남는다).
// 안쪽 폼(`ExpressionImportForm`·`ExpressionMakeEntry`)은 그대로이고 앞 판의 고르개 시트가 쓰던 것과 같은 부품이다. 시트는 문 둘을 보여 주고, 끝나면(`onDone`) 닫혀 창으로 돌아온다
// (등록된 그림은 보관함 갱신으로 창의 격자에 들어온다). 권한(관리자만)과 오프라인 규칙은 문 앞에서 말한다.
// =============================================================================

type Chapter = 'doors' | 'import' | 'make';

export function ExpressionAddSheet({
  onClose,
  onOpenConversation,
}: {
  onClose: () => void;
  /** 「AI와 만들기」 요청을 보낸 뒤 그 에이전트 DM 으로 간다. 호스트가 길을 줄 때만 선다. */
  onOpenConversation?: (channel: Channel) => void;
}) {
  const formatMessage = useExpressionMessages();
  const styles = useStyles(buildStyles);
  const {state} = useExpressions();
  const canAdd = useCanAddExpression();
  const [chapter, setChapter] = useState<Chapter>('doors');
  const offline = state === 'offline';
  return (
    <PageSheet onClose={onClose} accessibilityLabel={formatMessage('expressions.add.trigger')}>
      {chapter === 'import' ? (
        <ExpressionImportForm onBack={() => setChapter('doors')} onDone={onClose} />
      ) : chapter === 'make' ? (
        <ExpressionMakeEntry
          onBack={() => setChapter('doors')}
          onDone={onClose}
          onImport={() => setChapter('import')}
          onOpenConversation={onOpenConversation}
        />
      ) : (
        <>
          <SheetHeader
            title={formatMessage('expressions.add.trigger')}
            closeLabel={formatMessage('expressions.sheet.close')}
            onClose={onClose}
            closeTestID="expression-add-sheet-close"
          />
          <View style={styles.body} testID="expression-add-sheet">
            {!canAdd ? (
              <Sentence style={styles.note} testID="expression-add-admins-only">
                {formatMessage('expressions.add.adminsOnly')}
              </Sentence>
            ) : offline ? (
              <Sentence style={styles.note} testID="expression-add-offline">
                {formatMessage('expressions.add.offlineHint')}
              </Sentence>
            ) : (
              <GroupCard testID="expression-add-doors">
                <ListRow
                  title={formatMessage('expressions.add.import')}
                  detail={formatMessage('expressions.add.importDetail')}
                  accessory="chevron"
                  onPress={() => setChapter('import')}
                  testID="expression-add-import"
                />
                <ListRow
                  title={formatMessage('expressions.add.make')}
                  detail={formatMessage('expressions.add.makeDetail')}
                  accessory="chevron"
                  onPress={() => setChapter('make')}
                  testID="expression-add-make"
                />
              </GroupCard>
            )}
          </View>
        </>
      )}
    </PageSheet>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    body: {paddingHorizontal: SAFE_GUTTER, paddingBottom: space.xl, gap: space.sm},
    note: {fontSize: font.body, lineHeight: line.body, color: color.textMuted},
  });
