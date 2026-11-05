import type {Message, RosterMember} from '@momo/core/lib/api';
import type {PendingMessage} from '@momo/core/features/timeline/model';
import type {ReactionMap} from '@momo/core/features/timeline/reactions';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import React, {useEffect, useRef, useState} from 'react';
import {Screen} from '../src/design/atoms';
import {Composer} from '../src/features/conversation/Composer';
import {ConversationHeader} from '../src/features/conversation/ConversationHeader';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {CONV} from '../src/features/conversation/convDesign';
import {clearDraft} from '../src/features/conversation/drafts';
import {JumpSeekLine} from '../src/features/conversation/JumpSeekLine';
import type {MessageRowActions} from '../src/features/conversation/MessageRow';
import {Timeline} from '../src/features/conversation/Timeline';

// =============================================================================
// 불러온 범위 밖 점프의 캡처 표면 (#5383). 실제 `Timeline`·`JumpSeekLine`·`Composer` 를 대화 화면과 같은 순서로 세운다. 서버·레일이 없다.
//
//   xcrun simctl launch <udid> app.momo.ios --args -momoMeasure JUMP-SEEK-<WHICH> -RCT_jsLocation 127.0.0.1:<metro>
//   (라이트: LIGHT-JUMP-SEEK-…)
//
//   reading  머리 30줄만 든 방에서 입력창 위 「찾는 중 · 취소」(정지)
//   failed   읽다가 실패 - 「다시 시도 · 닫기」(정지)
//   landed   읽은 쪽이 합쳐진 방(목적지 위 20줄 포함)에서 같은 목적지로 점프가 4초마다 다시 걸려 **착지·강조**(틴트는 1.5초 남짓 서고 물러난다)
//   run      reading → 3초 뒤 읽은 쪽이 합쳐지고 같은 목적지로 점프가 다시 걸려 착지(실제 화면의 두 발과 같은 순서). `run-fast` 는 300ms 뒤 -
//            진입 수렴이 끝나기 전에 읽은 쪽이 붙는 경우(옛 페이지가 진입 수렴 중에 붙으면 목록이 밀리던 #2604 의 자리)
//
// 전부 지어낸 인물·문구다.
// =============================================================================

const WS = '00000000-0000-7000-8000-000000005383';
const SELF = '00000000-0000-7000-8000-000000005384';
const PEER = '00000000-0000-7000-8000-000000005385';
const CHANNEL = 'jump-seek-capture';
const DRAFT_KEY = 'measure:jump-seek';
const NO_TOP = {paddingTop: 0} as const;
const NOOP = () => {};
const NO_PENDING: PendingMessage[] = [];
const NO_REACTIONS: ReactionMap = {};
const NOW = Date.now();

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
  member({id: SELF, displayName: '박서연', handle: 'seoyeon'}),
  member({id: PEER, displayName: '이도현', handle: 'dohyun'}),
]);

const LINES = [
  '오전 회의에서 나온 시안 두 가지를 비교해 봤어요',
  '배포 로그 확인했습니다',
  '공유 폴더에 최신 버전을 올려 뒀으니 한 번 봐 주세요',
  '네 확인했어요',
  '견적서는 내일 오전까지 정리해서 남길게요',
  '좋아요',
] as const;

const TARGET_SEQ = 45;
const HEAD_FIRST = 71;
const LAST = 100;

function row(seq: number): Message {
  return {
    id: `00000000-0000-7000-8000-00000000${String(seq).padStart(4, '0')}`,
    channelId: CHANNEL,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: seq % 3 === 0 ? SELF : PEER,
    type: 'text',
    body: seq === TARGET_SEQ ? '배포 로그 확인했습니다 - 롤백 절차까지 정리해서 올렸어요' : LINES[seq % LINES.length],
    state: 'sent',
    createdAtMs: NOW - (LAST - seq) * 60_000,
  } as Message;
}

function range(from: number, to: number): Message[] {
  const out: Message[] = [];
  for (let seq = from; seq <= to; seq += 1) out.push(row(seq));
  return out;
}

export function JumpSeekSurface({which}: {which: string}): React.JSX.Element {
  const failed = which === 'failed';
  const landed = which === 'landed';
  const run = which === 'run' || which === 'run-fast';
  const [messages, setMessages] = useState<Message[]>(() =>
    landed ? range(TARGET_SEQ - 20, LAST) : range(HEAD_FIRST, LAST),
  );
  const [reading, setReading] = useState(!landed);
  const [jump, setJump] = useState<{messageId: string; seq: number | null; token: number} | undefined>(
    landed ? {messageId: row(TARGET_SEQ).id, seq: TARGET_SEQ, token: 1} : undefined,
  );
  const actions = useRef<MessageRowActions>({
    myMemberId: SELF,
    onToggleReaction: async () => {},
    onEdit: async () => {},
    onDelete: async () => {},
    onOpenThread: NOOP,
    onOpenProfile: NOOP,
  }).current;

  // 라이트/다크는 `-momoMeasure LIGHT-…` 접두가 정한다(`measure/root.ts`). 초안만 비운다(MMKV 라 실행을 넘어 남는다).
  useState(() => {
    clearDraft(DRAFT_KEY);
    return null;
  });

  useEffect(() => {
    if (!run) return undefined;
    // 읽는 동안(3초) 화면은 그대로이고, 닿으면 읽은 쪽이 한 번에 합쳐지고 같은 문으로 다시 쏜다.
    const timer = setTimeout(() => {
      setReading(false);
      setMessages(range(TARGET_SEQ - 20, LAST));
      setJump({messageId: row(TARGET_SEQ).id, seq: TARGET_SEQ, token: 1});
    }, which === 'run-fast' ? 300 : 3000);
    return () => clearTimeout(timer);
  }, [run, which]);

  // `landed`: 사진을 찍는 쪽이 틴트가 서 있는 때를 맞출 수 있게 점프를 4초마다 다시 건다.
  useEffect(() => {
    if (!landed) return undefined;
    const timer = setInterval(() => {
      setJump(current => ({messageId: row(TARGET_SEQ).id, seq: TARGET_SEQ, token: (current?.token ?? 0) + 1}));
    }, 4000);
    return () => clearInterval(timer);
  }, [landed]);

  return (
    <Screen style={NO_TOP}>
      <ConversationHeader
        title="디자인-리뷰"
        kind="public"
        directory={DIRECTORY}
        onBack={NOOP}
        onOpenMenu={NOOP}
        onOpenInfo={NOOP}
        railStatus="connected"
      />
      <ConversationLayout
        list={
          <Timeline
            messages={messages}
            directory={DIRECTORY}
            status="ready"
            channelKind="public"
            channelId={CHANNEL}
            myMemberId={SELF}
            nowMs={NOW}
            actions={actions}
            pending={NO_PENDING}
            reactions={NO_REACTIONS}
            reachedStart={false}
            tailGap={CONV.conversationTail}
            jumpPills
            jumpTarget={jump}
          />
        }
        composer={
          <>
            {failed || (run && reading) || which === 'reading' ? (
              <JumpSeekLine failed={failed} onCancel={NOOP} onRetry={NOOP} onDismiss={NOOP} />
            ) : null}
            <Composer
              recipient="place"
              channelLabel="디자인-리뷰"
              directory={DIRECTORY}
              draftKey={DRAFT_KEY}
              onSend={NOOP}
            />
          </>
        }
      />
    </Screen>
  );
}
