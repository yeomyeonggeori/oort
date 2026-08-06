import type {SpawnExecutionPlan} from '@momo/core/lib/executionPlan';
import {
  candidateLabel,
  HOST_CHOICE_LABEL,
  spawnHostGate,
  tierLabel,
} from '@momo/core/features/timeline/spawnHostChoice';
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {color, font, line, radius, space, TOUCH_TARGET} from '../../design/tokens';

// =============================================================================
// 승인 카드의 호스트 선택기 — 폰 (ADR-0125 D6-A, 이슈 1114).
//
// 웹과 **같은 코어**를 소비한다: 어떤 줄이 서고, 무엇이 미리 찍히고, 무엇이 결정
// 본문에 실리는지는 전부 `@momo/core`의 `spawnHostChoice`가 답한다. 이 파일에는
// 그 판단이 한 줄도 없고, 있어서도 안 된다 — 이 화면의 형제 파일
// (`ApprovalDecision.tsx`)이 `decideApproval`에 대해 이미 한 말과 같다. 두 표면이
// 각자 판정하면 같은 카드가 기기마다 다른 호스트를 미리 골라 두고, 그 차이는
// 아무도 보고 있지 않은 쪽에서 자란다.
//
// ## 폰에는 `<input type="radio">`가 없다
//
// RN은 라디오 프리미티브를 주지 않으므로 여기서는 손으로 그린다. 그 대신 **역할은
// 손으로 그리지 않는다**: `accessibilityRole="radio"` + `accessibilityState`가
// VoiceOver에게 "N 중 하나, 지금 선택됨/선택 안 됨/사용 불가"를 그대로 말한다.
// 시각적 표식만 그리고 역할을 비워 두면, 화면을 보지 않는 사람에게 이 목록은
// 버튼 네 개가 된다.
//
// ## 못 고르는 줄을 지우지 않는다
//
// 서버가 자격 없는 호스트를 사유와 함께 싣기로 한 결정(이슈 1132)을 화면이 무효로
// 만들지 않는다. 「낡은 맥 (오프라인)」이 서 있는 것이 "왜 내 랩탑이 없지"의 답이고,
// 짧은 목록은 그 답이 아니다. 대신 그 줄은 눌리지 않고(`disabled`), 눌러도 선택이
// 옮겨 가지 않으며, 글자는 `textMuted`다 — 투명도로 낮추지 않는 이유는 그 줄을
// 세워 둔 유일한 이유인 **사유**까지 함께 읽기 어려워지기 때문이다.
//
// ## 히트 타깃
//
// 줄 하나가 `TOUCH_TARGET`(44pt)이다. 표식이 작다고 표식만 누르게 하면 엄지가
// 12pt 원을 겨냥하게 되고, 그 다음에 일어나는 일은 옆 호스트가 선택되는 것이다.
// =============================================================================

export function SpawnHostChoice({
  plan,
  pickedHostId,
  onPick,
  locked,
  testIDPrefix,
}: {
  plan: SpawnExecutionPlan;
  /** 지금 찍혀 있는 호스트. 자격 후보가 없으면 `null`. */
  pickedHostId: string | null;
  onPick: (hostId: string) => void;
  /** 무장했거나 전송 중이다 — 목적지를 더 이상 바꿀 수 없다. */
  locked: boolean;
  testIDPrefix: string;
}): React.JSX.Element {
  const gate = spawnHostGate(plan);
  return (
    <View style={styles.group} testID={`${testIDPrefix}-host-group`}>
      {/* 보이는 라벨이다. 라디오 목록이 무엇을 묻는지 모른 채 기계 이름 서너 개만
          보는 화면은 선택기가 아니라 수수께끼다. */}
      <Text style={styles.legend}>{HOST_CHOICE_LABEL}</Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={HOST_CHOICE_LABEL}
        style={styles.list}>
        {plan.candidates.map((candidate, index) => {
          const checked = candidate.hostId === pickedHostId;
          const disabled = !candidate.selectable || locked;
          const tier = tierLabel(candidate.tier);
          return (
            <Pressable
              key={candidate.hostId}
              accessibilityRole="radio"
              // 사유는 라벨 안에 있다(`candidateLabel`). 별도 힌트로 떼면
              // VoiceOver가 이름을 읽고 잠시 뒤 사유를 읽어, 목록을 훑는 사람은
              // 왜 이 줄이 안 눌리는지 모른 채 지나간다.
              accessibilityLabel={candidateLabel(candidate)}
              accessibilityState={{
                checked,
                disabled,
                selected: checked,
              }}
              disabled={disabled}
              onPress={() => onPick(candidate.hostId)}
              style={({pressed}) => [
                styles.row,
                // 첫 줄에는 구분선이 없다. 상자 테두리 바로 안쪽에 헤어라인을
                // 하나 더 그으면 두 줄이 겹쳐 보이는 두꺼운 선이 된다.
                index > 0 && styles.rowDivided,
                checked && candidate.selectable && styles.rowChecked,
                pressed && !disabled && styles.rowPressed,
              ]}
              testID={`${testIDPrefix}-host-option-${candidate.hostId}`}>
              <View
                style={[
                  styles.mark,
                  checked && candidate.selectable && styles.markChecked,
                ]}>
                {checked && candidate.selectable ? (
                  <View style={styles.markDot} />
                ) : null}
              </View>
              <View style={styles.rowText}>
                <Text
                  style={[
                    styles.name,
                    !candidate.selectable && styles.nameUnavailable,
                  ]}>
                  {candidateLabel(candidate)}
                </Text>
                {tier !== null ? <Text style={styles.tier}>{tier}</Text> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
      {gate.blockedCopy !== undefined ? (
        <Text style={styles.blocked} testID={`${testIDPrefix}-host-blocked`}>
          {gate.blockedCopy}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  group: {gap: space.sm, paddingBottom: space.sm},
  legend: {fontSize: font.meta, color: color.textMuted},
  list: {
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  row: {
    minHeight: TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  rowDivided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  rowChecked: {backgroundColor: color.accentSurface},
  rowPressed: {backgroundColor: color.surfacePressed},
  mark: {
    width: 18,
    height: 18,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markChecked: {borderColor: color.accentText},
  markDot: {
    width: 8,
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: color.accentText,
  },
  // 한 줄이다. tier를 자기 줄에 내리면 후보 넷이 카드 안에서 두 배 높이를 먹고,
  // 결정에 필요한 나머지 사실이 엄지 아래에서 화면 밖으로 밀린다.
  rowText: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: space.sm,
  },
  name: {fontSize: font.label, color: color.text, lineHeight: line.label},
  nameUnavailable: {color: color.textMuted},
  tier: {fontSize: font.meta, color: color.textFaint, lineHeight: line.meta},
  blocked: {fontSize: font.meta, color: color.textMuted, lineHeight: line.label},
});
