import {
  aiExternalRow,
  glossaryEntry,
} from '@momo/core/features/ai/aiHubModel';
import {isSurfaceProvided} from '@momo/core/features/capabilities/serverSurfaces';
import React, {useMemo} from 'react';
import {StyleSheet, Text, useWindowDimensions, View} from 'react-native';

import {
  PageSheet,
  usePageSheetAction,
  usePageSheetClose,
} from '../design/PageSheet';
import {STACK_PILL_SCALE} from '../design/atoms';
import {SheetHeader} from '../design/SheetChrome';
import {GroupCard, ListRow, SheetScroll} from '../design/sheetParts';
import {useStyles} from '../design/theme';
import {font, space, type Palette} from '../design/tokens';
import {
  aiSheetSections,
  macChip,
  myToolsGateOpen,
  PERSONAL_BADGE,
  personalAgentRows,
} from '../features/ai/aiSheetModel';
import {useWorkHosts} from '../features/agents/queries';
import {macState, ownMacs, type HarnessKey} from '../features/work/ask/model';
import {useDirectory} from '../features/workspace/queries';
import {haptics} from '../lib/haptics';
import {useSession} from '../session/useSession';

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
//   | 외부 연결   | 앱(읽기)                    | 서버가 앱 목록을 싣는다(`plugins` 표면)      |
//
// 「앱」 줄은 U-4(#3951)가 더했다: 폰의 읽기 화면으로 가는 문 하나. 폰에는 동의 창이 없어서 설치·허용은
// 데스크탑·웹에서 한다. #3388(AI 허브)이 폰에 서면 이 줄은 그 허브의 「외부 연결」로 옮겨 간다.
//
// 아래 두 구획은 내 맥으로 보내는 길이 꽂히기(#3638 이후 부팅) 전에는 서지 않는다. 막힌 줄을 흐리게 세워 두지 않고
// **세우지 않는다** — 누를 수 없는 줄은 이 시트가 풀어 줄 수 없는 약속이다.
//
// ## 표식
//
// 개인 에이전트 줄은 「개인」 표식과 「내 맥 켜짐/꺼짐」 칩을 늘 단다(칩은 맥이 등록돼 값이
// 있을 때). 칩은 색만으로 말하지 않는다 — 글자가 켜짐/꺼짐을 말하고 점은 거든다. 표식은 공용 행(`ListRow`)의 **오른쪽
// 임의 노드(`trailing`)** 로 선다(#4458 — 1단계가 부품에 자리가 없어 오른쪽 값 한 줄로 접었던 것을 되살렸다). `trailing` 은
// 보조기술의 기본 이름에 들어가지 않으므로 **행의 이름에 표식의 글자를 직접 잇는다**(`spoken` — 접었던 때의 낭독을 잃지
// 않는다. 옛 줄은 칩이 Pressable 안에 있어 이름만 읽혔고, 지금은 이름·보조 줄·표식을 함께 읽는다).
//
// **큰 글씨(`STACK_PILL_SCALE` 1.5 부터)에서는 표식을 행 오른쪽에 두지 않는다.** 오른쪽 칩이 폭을 먹으면 이름 칸이 한 글자
// 폭으로 접혀 「에/물/어/보/기」로 세로로 쌓였다(AX5·SE 캡처 — 옛 `GroupRow` 의 오른쪽 칩도 같은 구조였다). 그 배율부터
// 표식의 글자(「개인 · 내 맥 켜짐」)는 **보조 줄 아래 제 줄**로 내려가고 칩의 모양(점·채움)은 접는다 — 글자가 상태를 말하는
// 것은 그대로고, 보조기술 이름도 같다(홈 카드·사이드바의 상태 낱말이 같은 문턱에서 이름 아래로 내려가는 것과 같은 처방).
//
// ## 공용 시트로 (#4458)
//
// 그릇은 `PageSheet`(내용 맞춤 단 — 행이 다섯 이하인 문 모음이라 큰 단이 필요 없다), 머리는 오른쪽 원형 X 의 `SheetHeader`,
// 구획은 `GroupCard`(라벨 + 묶음 카드)이고 줄은 `ListRow`(셰브론)다. 줄은 모두 **다른 곳으로 가는 문**이라 누르면 시트가
// 먼저 미끄러져 내려간 뒤에 그곳이 열린다(`usePageSheetAction` — 부모가 곧바로 걷으면 시트가 스냅으로 사라진다).
//
// ## 햅틱
//
// 줄을 고르는 누름 한 번 = `selection` 한 번, 눌림 핸들러 안에서 동기로(`lib/haptics.ts`) — 슬라이드가 끝나기를 기다리지
// 않는다. 시트가 열리는 햅틱은 + 메뉴의 줄이 낸다(열기 = 사용자 행동 한 번).
// =============================================================================

export function AiSheet({
  onClose,
  onDelegate,
  onOpenAgentList,
  onAskMac,
  onOpenApps,
  gateOpen,
}: {
  onClose: () => void;
  /** 「작업 맡기기」 — N8 시트로. */
  onDelegate: () => void;
  /** 「에이전트 부르기」 — 에이전트 목록으로. */
  onOpenAgentList: () => void;
  /** 「앱」 — 앱 읽기 화면으로. */
  onOpenApps: () => void;
  /** 「내 맥에 물어보기」 — T6b 시트로. */
  onAskMac: (harness?: HarnessKey) => void;
  /** 시험·캡처가 게이트를 강제한다. 앱은 넘기지 않는다. */
  gateOpen?: boolean;
}): React.JSX.Element {
  return (
    <PageSheet
      height="fit"
      onClose={onClose}
      accessibilityLabel="AI"
      scrimLabel="AI 닫기"
      testID="ai-sheet">
      <SheetBody
        onClose={onClose}
        onDelegate={onDelegate}
        onOpenAgentList={onOpenAgentList}
        onAskMac={onAskMac}
        onOpenApps={onOpenApps}
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
  onOpenApps,
  gateOpen,
}: {
  onClose: () => void;
  onDelegate: () => void;
  onOpenAgentList: () => void;
  onAskMac: (harness?: HarnessKey) => void;
  onOpenApps: () => void;
  gateOpen?: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {fontScale} = useWindowDimensions();
  const stackMarks = fontScale >= STACK_PILL_SCALE;
  const {member, workspaceId} = useSession();
  const slideClose = usePageSheetClose() ?? onClose;
  const afterClose = usePageSheetAction();
  const open = gateOpen ?? myToolsGateOpen();

  const directory = useDirectory(workspaceId);
  const personal = useMemo(
    () => personalAgentRows(directory.directory.members, member.id),
    [directory.directory.members, member.id],
  );
  const sections = aiSheetSections({
    gateOpen: open,
    personal,
    appsProvided: isSurfaceProvided('plugins'),
  });

  // 호스트 목록은 맥 칩이 설 구획이 있을 때만 읽는다.
  const hostsQuery = useWorkHosts(workspaceId, sections.myTools);
  const chip = macChip(
    hostsQuery.data === undefined
      ? null
      : macState(ownMacs(hostsQuery.data, member.id)),
  );

  // 햅틱은 누르는 순간 동기로 한 번, 이동은 시트가 내려간 뒤에 한 번.
  const choose = (go: () => void) => () => {
    haptics.selection();
    afterClose(go);
  };

  return (
    <>
      <SheetHeader
        title="AI"
        closeLabel="AI 닫기"
        onClose={slideClose}
        closeTestID="ai-close"
      />
      <SheetScroll testID="ai-body">
        <GroupCard label="에이전트" testID="ai-section-agents">
          <ListRow
            title="작업 맡기기"
            detail="에이전트에게 맡길 작업을 써요."
            accessory="chevron"
            onPress={choose(onDelegate)}
            accessibilityHint="작업을 맡기는 시트를 엽니다."
            testID="ai-row-delegate"
          />
          <ListRow
            title="에이전트 부르기"
            detail="에이전트 목록을 열어요."
            accessory="chevron"
            onPress={choose(onOpenAgentList)}
            accessibilityHint="에이전트 목록을 엽니다."
            testID="ai-row-agents"
          />
        </GroupCard>

        {sections.myTools ? (
          <GroupCard label="내 도구" testID="ai-section-tools">
            <ListRow
              title={ASK_MAC_TITLE}
              detail={
                stackMarks && chip !== null
                  ? `${ASK_MAC_DETAIL}\n${chip.label}`
                  : ASK_MAC_DETAIL
              }
              accessory="chevron"
              accessibilityLabel={spoken(ASK_MAC_TITLE, ASK_MAC_DETAIL, chip?.label)}
              onPress={choose(() => onAskMac())}
              accessibilityHint="내 맥에 보내는 시트를 엽니다."
              trailing={
                chip === null || stackMarks ? undefined : (
                  <MacChip on={chip.on} label={chip.label} testID="ai-mac-chip" />
                )
              }
              testID="ai-row-ask-mac"
            />
          </GroupCard>
        ) : null}

        {sections.personal ? (
          <GroupCard label="개인 에이전트" testID="ai-section-personal">
            {personal.map(agent => {
              const detail = `${agent.harnessLabel} · 나만 쓸 수 있어요.`;
              // 큰 글씨에서 보조 줄 아래로 내려가는 표식 줄: 「개인 · 내 맥 켜짐」(맥이 없으면 「개인」뿐).
              const markLine = [PERSONAL_BADGE, chip?.label]
                .filter((part): part is string => Boolean(part))
                .join(' · ');
              return (
                <ListRow
                  key={agent.id}
                  title={agent.label}
                  detail={stackMarks ? `${detail}\n${markLine}` : detail}
                  accessory="chevron"
                  accessibilityLabel={spoken(
                    agent.label,
                    detail,
                    PERSONAL_BADGE,
                    chip?.label,
                  )}
                  // 고른 에이전트의 하네스를 시트가 미리 고른다 — 행을 고른 뜻이 시트까지 간다.
                  onPress={choose(() => onAskMac(agent.harness ?? undefined))}
                  accessibilityHint="내 맥에 보내는 시트를 엽니다."
                  trailing={
                    stackMarks ? undefined : (
                      <View style={styles.marks}>
                        <Text
                          style={styles.personal}
                          testID={`ai-personal-${agent.id}`}>
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
                    )
                  }
                  testID={`ai-row-personal-${agent.id}`}
                />
              );
            })}
          </GroupCard>
        ) : null}

        {sections.apps ? (
          <GroupCard
            label={glossaryEntry('externalConnection').term}
            testID="ai-section-external">
            <ListRow
              title={aiExternalRow('apps').title}
              detail={aiExternalRow('apps').summary}
              accessory="chevron"
              onPress={choose(onOpenApps)}
              accessibilityHint="공식 앱이 할 수 있는 일을 읽는 화면을 엽니다."
              testID="ai-row-apps"
            />
          </GroupCard>
        ) : null}
      </SheetScroll>
    </>
  );
}

const ASK_MAC_TITLE = '내 맥에 물어보기';
const ASK_MAC_DETAIL = '내 맥의 Claude Code 같은 도구에 물어보거나 일을 시켜요.';

/**
 * 행의 보조기술 이름. `ListRow` 의 `trailing` 은 기본 이름에 들어가지 않으므로 표식(「개인」·「내 맥 켜짐」)의 글자를
 * 이름·보조 줄 뒤에 쉼표로 잇는다 — `ListRow` 의 기본 이름(제목, 보조 줄, 값)과 같은 모양이다.
 */
function spoken(...parts: (string | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(', ');
}

/** 「내 맥 켜짐/꺼짐」 칩. 색만으로 말하지 않는다 — 글자가 상태를 말하고 점은 거든다. */
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
    marks: {alignItems: 'flex-end', gap: space.xs},
    personal: {
      fontSize: font.meta,
      fontWeight: '700',
      color: color.agent,
      backgroundColor: color.agentSurface,
      borderRadius: 999,
      paddingHorizontal: space.sm,
      paddingVertical: space.xs,
      overflow: 'hidden',
    },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.xs,
      borderRadius: 999,
      paddingHorizontal: space.sm,
      paddingVertical: space.xs,
      borderWidth: StyleSheet.hairlineWidth,
    },
    chipOn: {backgroundColor: color.okSurface, borderColor: color.okBorder},
    chipOff: {backgroundColor: 'transparent', borderColor: color.border},
    dot: {width: 6, height: 6, borderRadius: 999},
    dotOn: {backgroundColor: color.ok},
    dotOff: {backgroundColor: color.textFaint},
    chipLabel: {fontSize: font.meta, fontWeight: '600'},
    chipLabelOn: {color: color.text},
    chipLabelOff: {color: color.textMuted},
  });
