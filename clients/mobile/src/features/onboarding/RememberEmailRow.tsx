import React from 'react';
import {StyleSheet, View} from 'react-native';
import {ListRow} from '../../design/sheetParts';
import {useStyles} from '../../design/theme';
import {SHEET} from '../../design/tokens';
import {useMobileMessages} from '../../i18n/useMobileMessages';

// 로그인 폼(M-b)의 「이메일 기억하기」 한 줄 (#4669). 켜면 로그인에 성공한 뒤 이 서버의 이메일을 기억하고, 끄면 저장된
// 이메일을 **그 자리에서** 지운다(규칙은 코어 `rememberedLogin`). 줄은 앱의 토글 행(`ListRow accessory="toggle"`)과 같은
// 부품이다: 줄 전체가 스위치(`switch`, 켬·끔 상태)이고 안쪽 `Switch`는 보조기술에서 숨는다. 그 행의 안쪽 여백만큼 바깥으로
// 내어 놓아(`bleed`) 라벨과 스위치가 위아래 입력 칸의 가장자리에 선다. 이 기기에만 저장한다는 말은 읽는 도구에만 보탠다:
// 키보드가 올라온 폼에서 눈으로 읽을 둘째 줄을 늘리지 않는다(#2678).
export function RememberEmailRow({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const messages = useMobileMessages();
  return (
    <View style={styles.bleed}>
      <ListRow
        title={messages.formatMessage('connect.rememberEmail.label')}
        accessibilityHint={messages.formatMessage('connect.rememberEmail.hint')}
        accessory="toggle"
        toggle={{value: checked, onValueChange: onChange}}
        testID="remember-email-row"
      />
    </View>
  );
}

// 색이 없어도 `StyleSheet`는 `useStyles`로 받는다: 모듈에서 바로 만든 스타일시트는 스킴을 못 따라가는 한 벌짜리가 되는 길이라
// 시험(`themeSwitch.test.tsx`)이 막는다.
const buildStyles = () => StyleSheet.create({
  bleed: {marginHorizontal: -SHEET.cardInset},
});
