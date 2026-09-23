import {
  LINK_ONCE_LEAD,
  type SecretOnce,
} from '@momo/core/features/approvals/secretOnce';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {font, line, radius, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {Sentence} from '../../design/atoms';
import {useStyles} from '../../design/theme';
import {COPY_RECEIPT_MS, copyText} from './copy';

// =============================================================================
// 1회 링크 — **폰 판** (ADR-0186 D4 · D8 · ADR-0182 ①, #2513)
//
// 웹 `ApprovalActions.tsx` 의 `LinkOnce` 와 같은 자리, 같은 규율이다. 승인이
// 기록되면 결정 버튼이 있던 자리에 영수증과 이것이 선다.
//
// ## 이 컴포넌트에는 값을 둘 자리가 없다
//
// 값은 호출자가 넘긴다. 호출자는 대화 화면의 영수증 표(React 상태)에서 읽고,
// 그 표가 1회 값이 사는 **유일한** 자리다(`approvalGate.ts` `ApprovalReceipt`).
// 여기에는 저장도, 캐시도, 로그도 없다 — 들고 있는 상태는 「복사됨」 한 순간뿐이고
// 그것은 값이 아니라 영수증이다. 대화를 닫거나 앱을 다시 띄우면 호출자의 표와
// 함께 사라지고, 그 뒤에 남는 것은 영속 카드의 「1회 표시됐습니다」뿐이다.
//
// ## 복사 한 벌
//
// 클립보드를 부르는 자리는 `copy.ts` 하나다(그 파일 머리말). 「복사됨」이 머무는
// 시간도 코드 상자와 액션 시트가 쓰는 `COPY_RECEIPT_MS` 그대로다 — 같은 동사가
// 한 화면에서 두 가지 계약을 갖지 않게.
//
// 복사가 실패하면 라벨이 바뀌지 않는다(웹 `useClipboardCopy` 와 같다). 대신 값이
// `selectable` 이라 길게 눌러 직접 고를 수 있다 — 클립보드 권한이 막힌 기기에서도
// 전달할 길이 하나는 남는다.
//
// ## 값은 자르지 않는다 (웹 R1 B1)
//
// `numberOfLines` 가 없다. 「지금 전달하세요」라고 말하면서 전달할 값의 꼬리를
// 말줄임에 먹히게 하면 그 문장이 거짓이 된다. 긴 URL 은 줄을 넘겨 감긴다.
// =============================================================================

export function LinkOnce({
  secret,
  testIDPrefix = 'card-approval',
}: {
  secret: SecretOnce;
  /** 타임라인에 카드가 여럿이어도 한 훅이 두 요소에 답하지 않게. */
  testIDPrefix?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const [copied, setCopied] = useState(false);
  // 되돌리는 타이머는 끄는 자리가 필요하다 — 복사하고 바로 대화를 닫으면 이
  // 컴포넌트는 사라지는데 1.5초 뒤 타이머는 살아 있다(`CodeCopyButton` 과 같은 이유).
  const revertRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (revertRef.current !== null) clearTimeout(revertRef.current);
    },
    [],
  );
  // 값이 바뀌면 영수증도 거둔다. 새 링크 옆에 「복사됨」이 서 있으면 사람은
  // 새 링크를 이미 복사한 줄 안다(웹 `useClipboardCopy` 가 같은 이유로 되돌린다).
  useEffect(() => {
    setCopied(false);
  }, [secret.value]);

  const onCopy = useCallback(() => {
    void copyText(secret.value).then(ok => {
      if (!ok) return;
      setCopied(true);
      if (revertRef.current !== null) clearTimeout(revertRef.current);
      revertRef.current = setTimeout(() => setCopied(false), COPY_RECEIPT_MS);
    });
  }, [secret.value]);

  return (
    <View style={styles.wrap} testID={`${testIDPrefix}-link-once`}>
      {/* 완성된 한국어 문장 — 어절에서 접는다(「지금 전달하 / 세요」가 캡처 실측). */}
      <Sentence style={styles.lead} testID={`${testIDPrefix}-link-once-lead`}>
        {LINK_ONCE_LEAD}
      </Sentence>
      <View style={styles.row}>
        <Text
          selectable
          style={styles.value}
          testID={`${testIDPrefix}-link-once-value`}>
          {secret.value}
        </Text>
        <Pressable
          accessibilityRole="button"
          // 이름은 `~기` 서술형, 영수증은 `~됨` (design-review N-1 — 코드 상자의
          // 「코드 복사하기」와 같은 규칙). 무엇을 복사하는지는 「링크」까지만
          // 말한다: 값의 갈래(`kind`)는 이 빌드가 해석하지 않는 서버 낱말이고,
          // 「초대 링크」라고 단정하면 다음 행동(웹훅 자격)에서 거짓이 된다.
          accessibilityLabel={copied ? '링크 복사됨' : '링크 복사하기'}
          onPress={onCopy}
          style={({pressed}) => [styles.copy, pressed && styles.pressed]}
          testID={`${testIDPrefix}-link-once-copy`}>
          <Text style={styles.copyLabel}>{copied ? '복사됨' : '복사하기'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    wrap: {gap: space.sm, paddingTop: space.xs},
    lead: {fontSize: font.label, lineHeight: line.label, color: color.text},
    row: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
    // 라틴 URL 한 덩어리다. 코드 상자와 같은 서체라 「이것은 값이다」가 모양으로
    // 읽힌다(`MessageBody` 의 `code`).
    value: {
      flex: 1,
      fontFamily: 'Menlo',
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.text,
    },
    // 이 순간 사람이 반드시 눌러야 하는 하나다 — 44pt 를 레이아웃으로 갖는다
    // (웹 R1 M6 가 같은 버튼을 `tap-target` 으로 올린 이유).
    copy: {
      minHeight: TOUCH_TARGET,
      minWidth: TOUCH_TARGET,
      paddingHorizontal: space.md,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: color.border,
    },
    copyLabel: {fontSize: font.label, fontWeight: '600', color: color.text},
    pressed: {backgroundColor: color.surfacePressed},
  });
