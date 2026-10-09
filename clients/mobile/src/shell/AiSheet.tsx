import React, {useMemo} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';

import {GroupRow, GroupSection} from '../design/atoms';
import {PageSheet, usePageSheetClose} from '../design/PageSheet';
import {useStyles} from '../design/theme';
import {ds2Type, space, type Palette} from '../design/tokens';
import {
  aiSheetSections,
  macChip,
  myToolsGateOpen,
  PERSONAL_BADGE,
  personalAgentRows,
} from '../features/ai/aiSheetModel';
import {useWorkHosts} from '../features/agents/queries';
import {macState, ownMacs} from '../features/work/ask/model';
import {useDirectory} from '../features/workspace/queries';
import {haptics} from '../lib/haptics';
import {useSession} from '../session/useSession';
import {SheetTitleRow} from './NewMessageSheet';

// =============================================================================
// 「AI」 시트 — + 메뉴의 AI 행들이 하나로 모인 자리 (N10 #3598, ADR-0198 D1·D3·D7).
//
// 4번째 탭은 없다(ADR-0189 D1). + 메뉴에 「AI」 한 줄이 서고, 그 줄이 이 시트를 연다.
// 시트는 **어디로 이어지는 문**일 뿐 새 일을 하지 않는다: 각 줄은 이미 있는 시트·목록을
// 연다.
//
// ## 구획과 게이트 (판정은 `features/ai/aiSheetModel.ts` 한 곳)
//
//   | 구획        | 줄                         | 서는 조건                                    |
//   |-------------|----------------------------|----------------------------------------------|
//   | 에이전트    | 작업 맡기기(N8) · 에이전트 목록 | 늘                                           |
//   | 내 도구     | 내 맥에 물어보기(T6b)        | 내 맥으로 보내는 길이 연결됨(`spawnPort`)    |
//   | 개인 에이전트 | 내 개인 에이전트 줄          | 위 + 로스터에 내 `personalAgent`가 있음      |
//
// 아래 두 구획은 engine 승격(#3638) 전에는 서지 않는다. 막힌 줄을 흐리게 세워 두지 않고
// **세우지 않는다** — 누를 수 없는 줄은 이 시트가 풀어 줄 수 없는 약속이다.
//
// ## 표식
//
// 개인 에이전트 줄은 「개인」 표식과 「내 맥 켜짐/꺼짐」 칩을 늘 단다(칩은 맥이 등록돼 값이
// 있을 때). 칩은 색만으로 말하지 않는다 — 글자가 켜짐/꺼짐을 말하고 점은 거든다.
//
// ## 햅틱
//
// 줄을 고르는 누름 한 번 = `selection` 한 번, 눌림 핸들러 안에서 동기로(`lib/haptics.ts`).
// 시트가 열리는 햅틱은 + 메뉴의 줄이 낸다(열기 = 사용자 행동 한 번).
// =============================================================================

export function AiSheet({
  onClose,
  onDelegate,
  onOpenAgentList,
  onAskMac,
  gateOpen,
}: {
  onClose: () => void;
  /** 「작업 맡기기」 — N8 시트로. */
  onDelegate: () => void;
  /** 「에이전트 부르기」 — 에이전트 목록으로. */
  onOpenAgentList: () => void;
  /** 「내 맥에 물어보기」 — T6b 시트로. */
  onAskMac: () => void;
  /** 시험·캡처가 게이트를 강제한다. 앱은 넘기지 않는다. */
  gateOpen?: boolean;
}): React.JSX.Element {
  return (
    <PageSheet onClose={onClose} accessibilityLabel="AI" testID="ai-sheet">
      <SheetBody
        onClose={onClose}
        onDelegate={onDelegate}
        onOpenAgentList={onOpenAgentList}
        onAskMac={onAskMac}
        gateOpen={gateOpen}
      />
    </PageSheet>
  );
}

function SheetBody({
  onClose,
  onDelegate,
  onOpenAgentList,
  onAskMac,
  gateOpen,
}: {
  onClose: () => void;
  onDelegate: () => void;
  onOpenAgentList: () => void;
  onAskMac: () => void;
  gateOpen?: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {member, workspaceId} = useSession();
  const slideClose = usePageSheetClose() ?? onClose;
  const open = gateOpen ?? myToolsGateOpen();

  const directory = useDirectory(workspaceId);
  const personal = useMemo(
    () => personalAgentRows(directory.directory.members, member.id),
    [directory.directory.members, member.id],
  );
  const sections = aiSheetSections({gateOpen: open, personal});

  // 호스트 목록은 맥 칩이 설 구획이 있을 때만 읽는다.
  const hostsQuery = useWorkHosts(workspaceId, sections.myTools);
  const chip = macChip(
    hostsQuery.data === undefined
      ? null
      : macState(ownMacs(hostsQuery.data, member.id)),
  );

  const choose = (go: () => void) => () => {
    haptics.selection();
    go();
  };

  return (
    <View style={styles.fill}>
      <SheetTitleRow
        title="AI"
        closeLabel="AI 닫기"
        onClose={slideClose}
        testID="ai"
      />
      <ScrollView contentContainerStyle={styles.list} testID="ai-body">
        <GroupSection label="에이전트" testID="ai-section-agents">
          <GroupRow
            title="작업 맡기기"
            detail="에이전트에게 맡길 작업을 써요."
            chevron
            onPress={choose(onDelegate)}
            accessibilityHint="작업을 맡기는 시트를 엽니다."
            testID="ai-row-delegate"
          />
          <GroupRow
            title="에이전트 부르기"
            detail="에이전트 목록을 열어요."
            chevron
            separated
            onPress={choose(onOpenAgentList)}
            accessibilityHint="에이전트 목록을 엽니다."
            testID="ai-row-agents"
          />
        </GroupSection>

        {sections.myTools ? (
          <View style={styles.gap}>
            <GroupSection label="내 도구" testID="ai-section-tools">
              <GroupRow
                title="내 맥에 물어보기"
                detail="내 맥의 Claude Code 같은 도구에 물어보거나 일을 시켜요."
                chevron
                onPress={choose(onAskMac)}
                accessibilityHint="내 맥에 보내는 시트를 엽니다."
                trailing={
                  chip === null ? undefined : (
                    <MacChip on={chip.on} label={chip.label} testID="ai-mac-chip" />
                  )
                }
                testID="ai-row-ask-mac"
              />
            </GroupSection>
          </View>
        ) : null}

        {sections.personal ? (
          <View style={styles.gap}>
            <GroupSection label="개인 에이전트" testID="ai-section-personal">
              {personal.map((agent, index) => (
                <GroupRow
                  key={agent.id}
                  title={agent.label}
                  detail={`${agent.harnessLabel} · 나만 쓸 수 있어요.`}
                  separated={index > 0}
                  onPress={choose(onAskMac)}
                  accessibilityHint="내 맥에 보내는 시트를 엽니다."
                  trailing={
                    <View style={styles.marks}>
                      <Text style={styles.personal} testID={`ai-personal-${agent.id}`}>
                        {PERSONAL_BADGE}
                      </Text>
                      {chip === null ? null : (
                        <MacChip
                          on={chip.on}
                          label={chip.label}
                          testID={`ai-personal-mac-${agent.id}`}
                        />
                      )}
                    </View>
                  }
                  testID={`ai-row-personal-${agent.id}`}
                />
              ))}
            </GroupSection>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function MacChip({
  on,
  label,
  testID,
}: {
  on: boolean;
  label: string;
  testID: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View
      style={[styles.chip, on ? styles.chipOn : styles.chipOff]}
      testID={testID}>
      <View style={[styles.dot, on ? styles.dotOn : styles.dotOff]} />
      <Text
        style={[styles.chipLabel, on ? styles.chipLabelOn : styles.chipLabelOff]}
        numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    fill: {flex: 1},
    list: {paddingBottom: space.xl * 2},
    gap: {marginTop: space.lg},
    marks: {alignItems: 'flex-end', gap: space.xs},
    personal: {
      fontSize: ds2Type.caption,
      fontWeight: '700',
      color: color.agent,
      backgroundColor: color.agentSurface,
      borderRadius: 999,
      paddingHorizontal: space.sm,
      paddingVertical: 2,
      overflow: 'hidden',
    },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      borderRadius: 999,
      paddingHorizontal: space.sm,
      paddingVertical: 2,
      marginHorizontal: 0,
      borderWidth: StyleSheet.hairlineWidth,
    },
    chipOn: {backgroundColor: color.okSurface, borderColor: color.okBorder},
    chipOff: {backgroundColor: 'transparent', borderColor: color.border},
    dot: {width: 6, height: 6, borderRadius: 3},
    dotOn: {backgroundColor: color.ok},
    dotOff: {backgroundColor: color.textFaint},
    chipLabel: {fontSize: ds2Type.caption, fontWeight: '600'},
    chipLabelOn: {color: color.text},
    chipLabelOff: {color: color.textMuted},
  });
