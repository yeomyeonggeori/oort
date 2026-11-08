import React from 'react';

import {ListRow} from '../../design/sheetParts';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {useExpressionSuggestOn, writeExpressionSuggestOn} from '../expressions/useExpressionSuggestSetting';

// =============================================================================
// 설정 › 보기 › 「이모티콘 추천」 켜기·끄기 (#5493, 웹 설정 › 모양 › 대화 표시와 같은 낱말·같은 기본값 켜짐, owner 2026-11-07 「설정에서 다 끌 수도 있어요」).
//
// 글을 쓰다 멈추면 입력창 위에 뜨는 이모티콘 추천 줄(#5478)을 통째로 끄고 켜는 스위치 하나다. 이 기기 · 이 워크스페이스 · 이 사람에게만 저장되고 서버로 가지 않는다. 줄의 ✕(그 대화의 낱말 하나만
// 앱을 다시 켤 때까지 끄기)와는 다른 선택이라 서로를 바꾸지 않는다. 눌러서 바꾸면 열려 있는 대화·스레드 입력창이 바로 따라온다(앱을 다시 켤 필요가 없다).
//
// 같은 카드의 다른 줄(테마·링크 미리보기)과 같은 부품(`ListRow`)의 토글 줄이다: 이름 · 보조 줄 · 오른쪽 스위치, 줄 전체가 눌린다. 이 폰의 값은 동기로 읽혀서 「읽는 중」이 없다(그래서 스피너 자리를
// 가진 `SwitchRow` 가 아니라 토글 줄이다 - 새 설정 장들이 같은 부품을 쓴다). 이름과 설명은 사전 키(`expressions.suggest.settingLabel`·`settingHint`)이고 웹 설정이 같은 키를 쓴다.
// =============================================================================

export function ExpressionSuggestSettingRow({
  workspaceId,
  memberId,
}: {
  workspaceId: string;
  memberId: string;
}): React.JSX.Element {
  const formatMessage = useFormatMessage();
  const on = useExpressionSuggestOn(workspaceId, memberId);
  const title = formatMessage('expressions.suggest.settingLabel');
  const detail = formatMessage('expressions.suggest.settingHint');
  return (
    <ListRow
      accessibilityHint={detail}
      accessibilityLabel={title}
      accessory="toggle"
      detail={detail}
      testID="settings-expression-suggest-row"
      title={title}
      toggle={{value: on, onValueChange: next => writeExpressionSuggestOn(workspaceId, memberId, next)}}
    />
  );
}
