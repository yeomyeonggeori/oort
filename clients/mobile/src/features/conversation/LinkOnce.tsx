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
// 복사가 실패하면 라벨이 바뀌지 않는다(웹 `useClipboardCopy` 와 같다).
//
// ## 값은 고를 수 없다 — 웹의 `select-all` 을 옮기지 않은 이유 (design-review M-3)
//
// 이 컴포넌트는 메시지 행 **안**에 선다. 그 행은 길게 누르면 액션 시트를 열고,
// iOS 의 텍스트 선택은 그 자체가 길게 누르기라 둘이 같은 제스처를 다툰다 — 그래서
// 시트가 있는 행은 선택을 끈다는 것이 이 행의 규칙이다(`MessageRow` 의
// `selectable={!actionable}`). 여기서만 켜면, 링크를 길게 눌러 복사하려던 사람은
// 시트를 만나고 시트의 「메시지 복사하기」는 링크가 아니라 메시지 본문을 준다.
// 옮기는 길은 둘이고 둘 다 값을 정확히 준다: 이 버튼, 그리고 VoiceOver 로터의
// 「링크 복사하기」(`MessageRow` 의 `momoCopyLinkOnce`).
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
        <Text style={styles.value} testID={`${testIDPrefix}-link-once-value`}>
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
    wrap: {gap: space.xs, paddingTop: space.xs},
    // 영수증(`cardNote`, 12pt/600)과 **같은 크기**다. 위계는 무게로만 선다 — 영수증이
    // 굵고 이 문장은 보통이다(`MessageRow` 의 노트 격 규칙: 크기는 안 쓴다).
    lead: {fontSize: font.meta, lineHeight: line.meta, color: color.text},
    // 값을 버튼 높이 가운데에 세우면 값이 아래로 밀려 리드가 값보다 영수증 쪽에
    // 붙는다(design-review M-1 실측: 리드→URL 20pt). 위로 붙여 리드가 값을 설명하게.
    row: {flexDirection: 'row', alignItems: 'flex-start', gap: space.sm},
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
