import {
  aiExternalRow,
  glossaryEntry,
} from '@momo/core/features/ai/aiHubModel';
import {isSurfaceProvided} from '@momo/core/features/capabilities/serverSurfaces';
import React, {useMemo} from 'react';

import {
  PageSheet,
  usePageSheetAction,
  usePageSheetClose,
} from '../design/PageSheet';
import {SheetHeader} from '../design/SheetChrome';
import {GroupCard, ListRow, SheetScroll} from '../design/sheetParts';
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
// 있을 때). 칩은 색만으로 말하지 않는다 — 글자가 켜짐/꺼짐을 말한다. **공용 행(#4458)에는 오른쪽 임의 노드 자리가
// 없어서** 두 표식은 행의 오른쪽 값 한 줄(「개인 · 내 맥 켜짐」)로 접혔고, 보조기술은 그것을 이름·보조 줄과 함께 읽는다
// (옛 줄은 칩이 Pressable 안에 있어 이름만 읽혔다). 점·테두리 알약은 없다 — 부품 공백은 phone-sheets.md 의 「#4318 후속」이다.
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
              title="내 맥에 물어보기"
              detail="내 맥의 Claude Code 같은 도구에 물어보거나 일을 시켜요."
              value={chip === null ? undefined : chip.label}
              accessory="chevron"
              onPress={choose(() => onAskMac())}
              accessibilityHint="내 맥에 보내는 시트를 엽니다."
              testID="ai-row-ask-mac"
            />
          </GroupCard>
        ) : null}

        {sections.personal ? (
          <GroupCard label="개인 에이전트" testID="ai-section-personal">
            {personal.map(agent => (
              <ListRow
                key={agent.id}
                title={agent.label}
                detail={`${agent.harnessLabel} · 나만 쓸 수 있어요.`}
                // 「개인」 표식과 맥 칩의 글자(켜짐/꺼짐)를 오른쪽 값 한 줄로.
                value={
                  chip === null
                    ? PERSONAL_BADGE
                    : `${PERSONAL_BADGE} · ${chip.label}`
                }
                accessory="chevron"
                // 고른 에이전트의 하네스를 시트가 미리 고른다 — 행을 고른 뜻이 시트까지 간다.
                onPress={choose(() => onAskMac(agent.harness ?? undefined))}
                accessibilityHint="내 맥에 보내는 시트를 엽니다."
                testID={`ai-row-personal-${agent.id}`}
              />
            ))}
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
