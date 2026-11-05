import type {Message, RosterMember} from '@momo/core/lib/api';
import type {PendingMessage} from '@momo/core/features/timeline/model';
import type {ReactionMap} from '@momo/core/features/timeline/reactions';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import React, {useEffect, useRef, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Screen} from '../src/design/atoms';
import {Composer} from '../src/features/conversation/Composer';
import {ConversationHeader} from '../src/features/conversation/ConversationHeader';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {CONV} from '../src/features/conversation/convDesign';
import {clearDraft} from '../src/features/conversation/drafts';
import {JumpSeekLine} from '../src/features/conversation/JumpSeekLine';
import {seekSettleMs} from '../src/features/conversation/jumpSeek';
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
//   `-far`   `landed`·`run`·`run-fast` 의 끝에 붙인다(`landed-far`·`run-far`·`run-fast-far`). **상한 가까운 거리**: 머리 30줄 위
//            1,800줄에 목적지가 있고 합쳐지는 줄이 1,820개다(한 번의 읽기가 닿는 가장 먼 쪽에 가깝다 - `jumpSeek.ts` 의 2,000줄).
//            먼 이동이 목적지에 앉는지 보는 표면이다. `-far<줄 수>` 는 그 거리를 바꾼다(`run-fast-far800`).
//   `-d<ms>` 맨 끝에 붙이면 쪽이 합쳐진 뒤 점프를 **다른 커밋에서** 그만큼 늦게 건다 - 합친 직후의 먼 점프가 앉는지 재는 손잡이.
//            없으면 대화 화면과 같다: 합친 줄이 300줄 이하면 같은 커밋, 넘으면 `seekSettleMs` 만큼 늦게(`jumpSeek.ts` 머리말의 실측).
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

/** 방의 모양: 목적지 seq · 처음 든 가장 오래된 줄 · 가장 새 줄. */
interface Room {
  target: number;
  headFirst: number;
  last: number;
}
const NEAR: Room = {target: 45, headFirst: 71, last: 100};
/** `-far`(1,800줄 위)·`-far<줄 수>`: 머리 30줄 위 `rows`줄에 목적지가 있는 방. */
function farRoom(rows: number): Room {
  const target = 300;
  return {target, headFirst: target + rows, last: target + rows + 29};
}

function row(seq: number, room: Room): Message {
  return {
    id: `00000000-0000-7000-8000-00000000${String(seq).padStart(4, '0')}`,
    channelId: CHANNEL,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: seq % 3 === 0 ? SELF : PEER,
    type: 'text',
    body: seq === room.target ? '배포 로그 확인했습니다 - 롤백 절차까지 정리해서 올렸어요' : LINES[seq % LINES.length],
    state: 'sent',
    createdAtMs: NOW - (room.last - seq) * 60_000,
  } as Message;
}

function range(from: number, to: number, room: Room): Message[] {
  const out: Message[] = [];
  for (let seq = from; seq <= to; seq += 1) out.push(row(seq, room));
  return out;
}

const probeStyles = StyleSheet.create({
  probe: {position: 'absolute', top: 54, left: 150, zIndex: 999, fontSize: 28, fontWeight: '700', color: '#ffffff', backgroundColor: '#000000'},
});

export function JumpSeekSurface({which}: {which: string}): React.JSX.Element {
  // `-d<ms>`: 쪽이 합쳐진 뒤 **다른 커밋에서** 점프를 다시 거는 간격(없으면 같은 커밋). 먼 거리에서 두 커밋을 나누면 앉는지 보는 실험 손잡이.
  const delayMatch = /-d(\d+)$/.exec(which);
  const jumpDelay = delayMatch === null ? null : Number(delayMatch[1]);
  const named = delayMatch === null ? which : which.slice(0, delayMatch.index);
  const farMatch = /-far(\d*)$/.exec(named);
  const kind = farMatch === null ? named : named.slice(0, farMatch.index);
  const room = farMatch === null ? NEAR : farRoom(farMatch[1] === '' ? 1800 : Number(farMatch[1]));
  const failed = kind === 'failed';
  const landed = kind === 'landed';
  const run = kind === 'run' || kind === 'run-fast';
  const [messages, setMessages] = useState<Message[]>(() =>
    landed ? range(room.target - 20, room.last, room) : range(room.headFirst, room.last, room),
  );
  const [reading, setReading] = useState(!landed);
  const [jump, setJump] = useState<{messageId: string; seq: number | null; token: number} | undefined>(
    landed ? {messageId: row(room.target, room).id, seq: room.target, token: 1} : undefined,
  );
  // 측정 손잡이: 6초 뒤 목적지 줄의 창 안 세로 중앙(pt)을 화면 위에 적는다. 줄이 그려져 있지 않으면 NONE.
  const anchorRef = useRef<View | null>(null);
  const [probe, setProbe] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => {
      const node = anchorRef.current;
      if (node === null) setProbe('NONE');
      else node.measureInWindow((_x, y, _w, h) => setProbe(`Y${Math.round(y + h / 2)}`));
    }, 6000);
    return () => clearTimeout(timer);
  }, []);
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
    let second: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      setReading(false);
      setMessages(range(room.target - 20, room.last, room));
      const fire = () => setJump({messageId: row(room.target, room).id, seq: room.target, token: 1});
      // 대화 화면과 같은 규칙: 합친 줄 수(머리 맨 위 줄에서 목적지까지)에 따라 기다린다. `-d<ms>` 가 있으면 그 값(0 이어도 다른 커밋).
      const wait = jumpDelay ?? seekSettleMs(room.headFirst - room.target);
      if (jumpDelay === null && wait === 0) fire();
      else second = setTimeout(fire, wait);
    }, kind === 'run-fast' ? 300 : 3000);
    return () => {
      clearTimeout(timer);
      if (second !== undefined) clearTimeout(second);
    };
  }, [run, kind, room, jumpDelay]);

  // `landed`: 사진을 찍는 쪽이 틴트가 서 있는 때를 맞출 수 있게 점프를 4초마다 다시 건다.
  useEffect(() => {
    if (!landed) return undefined;
    const timer = setInterval(() => {
      setJump(current => ({messageId: row(room.target, room).id, seq: room.target, token: (current?.token ?? 0) + 1}));
    }, 4000);
    return () => clearInterval(timer);
  }, [landed, room]);

  return (
    <Screen style={NO_TOP}>
      <Text style={probeStyles.probe} testID="jump-seek-probe">{probe}</Text>
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
            anchorSeq={room.target}
            anchorRef={anchorRef}
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
