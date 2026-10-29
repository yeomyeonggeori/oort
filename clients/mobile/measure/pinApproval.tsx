import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import React from 'react';
import {ScrollView, StyleSheet} from 'react-native';
import {Screen} from '../src/design/atoms';
import type {ApprovalGate, ApprovalReceipt} from '../src/features/conversation/approvalGate';
import {MessageRow, type MessageRowActions} from '../src/features/conversation/MessageRow';

// =============================================================================
// 먼저 제안한 고정 카드와 만료 줄 캡처 표면 (#4705, ADR-0186 증보 v5 U-c·U-e). 진짜 MessageRow 가 선다.
//
//   xcrun simctl launch <udid> app.momo.ios --args -momoMeasure PIN-APPROVAL[-APPROVED|-EXPIRED]
//   (라이트: LIGHT-PIN-APPROVAL[-…])
//
//   (없음)     a. 아무도 부르지 않았는데 플래너가 올린 고정 카드, 결정 전
//              (제목 꼬리표 · 「에이전트가 쓴 글」 이름표 · 전문 보기 링크 · 승인·거부)
//   -approved  b. 같은 카드, 승인한 뒤(링크가 사라지고 꼬리표는 남는다)
//   -expired   c. 소유자 1:1 대화: 아무도 결정하지 않아 만료된 카드와, 서버 스윕이 남긴 한 줄
//
// 픽스처는 서버가 쓰는 모양 그대로다(`props.origin`, `props.action.preview`, 스윕 줄의 `status: "expired"`).
// 이름은 가상 인물이고 회사는 「달무리 스튜디오」다.
// =============================================================================

const WS = '00000000-0000-7000-8000-0000000000a9';
const SELF = '00000000-0000-7000-8000-0000000000a1';
const PLANNER = '00000000-0000-7000-8000-0000000004a1';
const APPROVAL_ID = '00000000-0000-7000-8000-00000000ca01';
const RUN_ID = '00000000-0000-7000-8000-00000000ca02';
const TARGET_CHANNEL = '00000000-0000-7000-8000-000000000302';
const TARGET_MESSAGE = '00000000-0000-7000-8000-00000000c101';
const DM_CHANNEL = 'pin-approval-capture';
const NOW = Date.now();
const EXPIRY_BODY = 'Tool call expired without a human approval.';

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 1,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '이도현', handle: 'dohyun'}),
  member({id: PLANNER, kind: 'agent', displayName: '플래너', handle: 'planner'}),
]);

const ACTIONS: MessageRowActions = {
  myMemberId: SELF,
  onToggleReaction: async () => {},
  onEdit: async () => {},
  onDelete: async () => {},
  // 캡처에는 열 곳이 있다 — 링크가 서는 표면이다(누르는 동작은 시험이 잰다).
  onOpenMessage: () => {},
};

function pinCard(over: Record<string, unknown> = {}): Message {
  return {
    id: '00000000-0000-7000-8000-0000000ba201',
    channelId: DM_CHANNEL,
    seq: 11,
    hlcTs: 11,
    hlcCount: 0,
    authorMemberId: PLANNER,
    type: 'approval_request',
    body: 'Approve message.pin',
    state: 'sent',
    createdAtMs: NOW - 5 * 60_000,
    props: {
      approval_id: APPROVAL_ID,
      run_id: RUN_ID,
      channel_id: DM_CHANNEL,
      action_type: 'workspace_action',
      status: 'pending',
      expires_at_ms: NOW + 50 * 60_000,
      title: '메시지 고정',
      summary: '플래너가 먼저 제안했어요. 승인하면 관리자 권한으로 이 메시지를 채널 맨 위에 고정해요.',
      origin: 'agent_initiated',
      action: {
        id: 'message.pin',
        rows: [
          {label: '채널', value: '#공지'},
          {label: '쓴 사람', value: '박서연'},
          {label: '쓴 시각', value: '오늘 오전 9:12'},
          {
            label: '앞 120자',
            value:
              '이번 주 목요일 오후 3시에 달무리 스튜디오 전체 회의가 있어요. 안건은 다음 분기 일정과 휴가 신청 방법이에요. 참석이 어려우면 …',
          },
          {label: '글자 수', value: '1,234자'},
          {label: '지금 고정된 수', value: '2개'},
        ],
        rationale: '이번 주 회의 안내라서 채널 맨 위에 두면 놓치는 사람이 줄 것 같아요.',
        required_role: 'admin',
        preview: {
          kind: 'message',
          messageId: TARGET_MESSAGE,
          channelId: TARGET_CHANNEL,
          totalChars: 1234,
          truncated: true,
        },
      },
      ...over,
    },
  } as unknown as Message;
}

/** 서버 만료 스윕이 만료한 승인마다 남기는 줄. 본문은 영어 기본 문구, props 는 `is_error` + `expired` 다. */
function expiryLine(): Message {
  return {
    id: '00000000-0000-7000-8000-0000000ba202',
    channelId: DM_CHANNEL,
    seq: 12,
    hlcTs: 12,
    hlcCount: 0,
    authorMemberId: PLANNER,
    type: 'tool_result',
    body: EXPIRY_BODY,
    state: 'sent',
    createdAtMs: NOW - 60_000,
    props: {
      call_id: '',
      output: EXPIRY_BODY,
      is_error: true,
      approval_id: APPROVAL_ID,
      run_id: RUN_ID,
      status: 'expired',
      decided_at_ms: NOW - 60_000,
    },
  } as unknown as Message;
}

const NO_GATES: ReadonlyMap<string, ApprovalGate> = new Map();

const styles = StyleSheet.create({content: {paddingVertical: 24}});

export function PinApprovalSurface({which}: {which: string}): React.JSX.Element {
  const gates = new Map<string, ApprovalGate>([
    [APPROVAL_ID, {approvalId: APPROVAL_ID, reversible: true, expiresAtMs: NOW + 50 * 60_000}],
  ]);
  const rows: React.JSX.Element[] = [];
  if (which === 'expired') {
    // 소유자 1:1 대화: 카드는 만료됐고(스냅샷의 `status`), 그 아래 스윕 줄이 한 줄 남는다.
    rows.push(
      <MessageRow
        key="card"
        message={pinCard({status: 'expired', approval_status: 'expired'})}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={NOW}
        approvalGates={NO_GATES}
        approvalsProvided
        actions={ACTIONS}
      />,
      <MessageRow
        key="line"
        message={expiryLine()}
        startsGroup={false}
        directory={DIRECTORY}
        chips={[]}
        nowMs={NOW}
        approvalGates={NO_GATES}
        approvalsProvided
        actions={ACTIONS}
      />,
    );
  } else {
    const approved = which === 'approved';
    const receipts: ReadonlyMap<string, ApprovalReceipt> = approved
      ? new Map<string, ApprovalReceipt>([
          [APPROVAL_ID, {note: '승인을 기록했어요.', status: 'approved'}],
        ])
      : new Map();
    rows.push(
      <MessageRow
        key="card"
        message={pinCard()}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={NOW}
        approvalGates={approved ? NO_GATES : gates}
        approvalReceipts={receipts}
        approvalsProvided
        actions={ACTIONS}
      />,
    );
  }
  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>{rows}</ScrollView>
    </Screen>
  );
}
