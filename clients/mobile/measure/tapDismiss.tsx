import type {Message, RosterMember} from '@momo/core/lib/api';
import type {PendingMessage} from '@momo/core/features/timeline/model';
import type {ReactionMap} from '@momo/core/features/timeline/reactions';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Keyboard, Linking, Settings, StyleSheet, TextInput, View} from 'react-native';
import type {GestureResponderEvent} from 'react-native';
import {Screen} from '../src/design/atoms';
import {Composer} from '../src/features/conversation/Composer';
import {ConversationHeader} from '../src/features/conversation/ConversationHeader';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {CONV} from '../src/features/conversation/convDesign';
import {clearDraft, saveDraft} from '../src/features/conversation/drafts';
import {Timeline} from '../src/features/conversation/Timeline';
import type {MessageRowActions} from '../src/features/conversation/MessageRow';

// =============================================================================
// 대화 목록을 눌러 자판·입력창을 내리는 규칙(#4614)의 캡처·계측 표면.
//
//   xcrun simctl launch <udid> app.momo.ios --args -momoMeasure TAP-<FLAGS> \
//        -RCT_jsLocation 127.0.0.1:<metro> [-momoGapSink 127.0.0.1:<port>]
//   (라이트: LIGHT-TAP-<FLAGS>; `-momoGapSink` 는 `measure/gap-sink.mjs` 가 받는다 — 없으면 로그만 남는다)
//
//   FLAGS (`+` 로 겹친다)
//     up      1.5초 뒤 입력창에 포커스(자판 올림). 키보드가 있는 시뮬레이터라야 한다.
//     typed   초안이 있는 채(한 줄 글).
//     long    초안이 여러 줄이고 첫 줄이 길다(접힘의 「첫 줄 + …」).
//     short   행이 셋뿐이다 — 목록 위쪽에 **빈 곳**이 선다(탭이 아무 행에도 안 닿는 자리).
//     link    링크가 든 행이 맨 끝에 선다.   chip  반응 칩이 붙은 행이 맨 끝에 선다.
//     pend    서버가 아직 안 받은 낙관적 메아리(`PendingRow`)가 맨 끝에 하나 서 있다.
//     slow    보내면 메아리가 60초 남는다(기본은 1.2초 뒤 서버 사본이 대신한다).
//
// **대화 화면이 세우는 그대로** 세운다 — 머리 · 레이아웃(목록 / 도크) · 행 동작(`actions`, 행이 눌리는 표면).
// 다른 하네스(`dockGap`)는 `actions` 가 없어서 행이 **비활성**(`disabled`)이라, 행을 누르는 길을 못 잰다.
//
// 기록: 키보드 이벤트 · 목록 터치(좌표·자판 판정) · `Keyboard.dismiss` 호출 · 행 동작 호출(스레드·프로필·링크·반응)을
// 싱크로 보낸다. 전부 지어낸 인물·문구다.
// =============================================================================

const WS = '00000000-0000-7000-8000-0000000000f0';
const SELF = '00000000-0000-7000-8000-0000000000f1';
const PEER = '00000000-0000-7000-8000-0000000000f2';
const CHANNEL = 'tap-dismiss-capture';
const DRAFT_KEY = 'measure:tap-dismiss';
const NO_TOP = {paddingTop: 0} as const;
const styles = StyleSheet.create({fill: {flex: 1}});

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

const NOW = Date.now();

function message(seq: number, author: string, body: string, ageSec: number): Message {
  return {
    id: `00000000-0000-7000-8000-00000000c${String(seq).padStart(3, '0')}`,
    channelId: CHANNEL,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: author,
    type: 'text',
    body,
    state: 'sent',
    createdAtMs: NOW - ageSec * 1000,
  } as Message;
}

const LINK = 'https://example.com/studio/schedule';
const ALL: Message[] = [
  message(1, PEER, '내일 오전에 디자인 리뷰 가능할까요', 900),
  message(2, SELF, '네, 열 시 괜찮아요', 860),
  message(3, PEER, '좋아요. 자료는 공유 폴더에 올려 둘게요', 820),
  message(4, PEER, `일정표는 이 링크에서 보세요 ${LINK}`, 780),
  message(5, SELF, '확인했어요', 700),
  message(6, PEER, '달무리 스튜디오 쪽 의견도 같이 받아 둘게요', 500),
  message(7, SELF, '고마워요', 400),
  message(8, PEER, '리뷰 끝나면 바로 정리해서 남길게요', 300),
  message(9, SELF, '네 기다릴게요', 200),
  message(10, PEER, '참석자 명단도 한 번 봐 주세요', 120),
];

// 스레드: 8번(루트)에 답글 하나 — 8번 밑에 「답글 1개」 롤업 단추가 선다.
const REPLY: Message = {
  ...message(11, SELF, '명단은 오후에 보낼게요', 90),
  rootId: ALL[7].id,
} as Message;
// 반응: 6번에 👍 하나(칩은 자기 `onPress` 를 가진다).
const REACTIONS: ReactionMap = {[ALL[5].id]: {'👍': [PEER]}};

const DRAFTS = {
  typed: '오늘 리뷰 끝나면 알려줄게요',
  long: '리뷰 일정은 오전 열 시로 잡았고 자료는 공유 폴더에 올려 두었어요.\n빠진 항목이 있으면 알려 주세요.\n끝나면 여기에 정리해서 남길게요.',
} as const;

type Sink = (record: Record<string, unknown>) => void;

function makeSink(): Sink {
  const sink = Settings.get('momoGapSink');
  const t0 = Date.now();
  return record => {
    const full = {t: Date.now() - t0, ...record};
    console.log(`TAP4614 ${JSON.stringify(full)}`);
    if (typeof sink !== 'string' || sink === '') return;
    fetch(`http://${sink}/tap`, {method: 'POST', body: JSON.stringify(full)}).catch(() => {
      // 받는 쪽이 없으면 로그만 남는다. 계측이 앱을 죽이지 않는다.
    });
  };
}

export function TapDismissSurface({which}: {which: string}): React.JSX.Element {
  const flags = new Set(which.split('+'));
  const has = (name: string) => flags.has(name);
  const inputRef = useRef<TextInput | null>(null);
  const sinkRef = useRef<Sink | null>(null);
  if (sinkRef.current === null) sinkRef.current = makeSink();
  const sink = sinkRef.current;

  useState(() => {
    const draft = has('long') ? DRAFTS.long : has('typed') ? DRAFTS.typed : undefined;
    if (draft === undefined) clearDraft(DRAFT_KEY);
    else saveDraft(DRAFT_KEY, draft);
    return null;
  });

  const [messages, setMessages] = useState<Message[]>(() => {
    if (has('short')) return ALL.slice(0, 3);
    // `link`·`chip`: 그 행을 맨 끝으로 옮긴다(자판이 올라온 창에는 끝 행 서넛만 든다). id 는 그대로라 반응 지도가 따라온다.
    const tail = has('link') ? ALL[3] : has('chip') ? ALL[5] : null;
    if (tail === null) return [...ALL, REPLY];
    const moved = {...tail, seq: 12, hlcTs: 12, createdAtMs: NOW - 30_000} as Message;
    return [...ALL.filter(entry => entry.id !== tail.id), REPLY, moved];
  });
  // 낙관적 메아리(`PendingRow`) — `pend` 는 처음부터 하나 세운다(서버가 안 받은 채 오래 남는 장면), 보내면 `slow` 는 60초, 아니면 1.2초 뒤 서버 사본이 대신한다.
  const [pending, setPending] = useState<PendingMessage[]>(() =>
    has('pend')
      ? [
          {
            clientMsgId: 'seed-pending',
            channelId: CHANNEL,
            authorMemberId: SELF,
            body: '보내는 중인 메시지예요',
            createdAtMs: NOW,
            sinceSeq: 11,
            status: 'sending',
          },
        ]
      : [],
  );

  useEffect(() => {
    if (!has('up')) return undefined;
    const timer = setTimeout(() => inputRef.current?.focus(), 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 자판 이벤트와 `Keyboard.dismiss` 호출을 남긴다 — 원본은 그대로 부른다. 이 표면은 `__DEV__` 의 `-momoMeasure` 에서만 선다(`measure/root.ts`)라 앱에는 이 덮어쓰기가 없고,
  // 표면이 사라지면(언마운트) 원래대로 돌려 놓는다. `Linking.openURL` 은 시뮬레이터에서 Safari 로 나가 앱이 배경이 되는 것만 막는다(어디로 가려 했는지는 기록한다).
  useEffect(() => {
    const subs = (['keyboardWillShow', 'keyboardDidShow', 'keyboardWillHide', 'keyboardDidHide'] as const).map(
      name =>
        Keyboard.addListener(name, event =>
          sink({k: 'kb', name, h: event.endCoordinates.height, visible: Keyboard.isVisible()}),
        ),
    );
    const original = Keyboard.dismiss;
    Keyboard.dismiss = () => {
      sink({
        k: 'dismiss',
        visible: Keyboard.isVisible(),
        focused: TextInput.State.currentlyFocusedInput() != null,
      });
      original.call(Keyboard);
    };
    const openURL = Linking.openURL;
    Linking.openURL = (url: string) => {
      sink({k: 'link', url});
      return Promise.resolve(true);
    };
    return () => {
      subs.forEach(subscription => subscription.remove());
      Keyboard.dismiss = original;
      Linking.openURL = openURL;
    };
  }, [sink]);

  const actions = useRef<MessageRowActions>({
    myMemberId: SELF,
    onToggleReaction: async (m, emoji) => sink({k: 'reaction', seq: m.seq, emoji}),
    onEdit: async () => {},
    onDelete: async () => {},
    onOpenThread: m => sink({k: 'thread', seq: m.seq}),
    onOpenProfile: id => sink({k: 'profile', id}),
  }).current;

  const touch = useCallback(
    (kind: 'start' | 'end') => (event: GestureResponderEvent) =>
      sink({
        k: 'touch',
        kind,
        x: Math.round(event.nativeEvent.pageX),
        y: Math.round(event.nativeEvent.pageY),
        visible: Keyboard.isVisible(),
        focused: TextInput.State.currentlyFocusedInput() != null,
      }),
    [sink],
  );

  const onSend = useCallback(
    (body: string) => {
      sink({k: 'send', body: body.length});
      const clientMsgId = `echo-${Date.now()}`;
      setPending(previous => [
        ...previous,
        {
          clientMsgId,
          channelId: CHANNEL,
          authorMemberId: SELF,
          body,
          createdAtMs: Date.now(),
          sinceSeq: 11,
          status: 'sending',
        },
      ]);
      setTimeout(
        () => {
          setPending(previous => previous.filter(entry => entry.clientMsgId !== clientMsgId));
          setMessages(previous => [...previous, message(previous.length + 1, SELF, body, 0)]);
        },
        has('slow') ? 60_000 : 1_200,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sink],
  );

  return (
    <Screen style={NO_TOP}>
      <ConversationHeader
        title="이도현"
        kind="dm"
        peerId={PEER}
        directory={DIRECTORY}
        onBack={() => {}}
        menu={[{label: '고정', run: () => {}}]}
        railStatus="connected"
      />
      <ConversationLayout
        list={
          <View style={styles.fill} onTouchStart={touch('start')} onTouchEnd={touch('end')} testID="tap-probe-list">
            <Timeline
              messages={messages}
              directory={DIRECTORY}
              status="ready"
              channelKind="dm"
              channelId={CHANNEL}
              myMemberId={SELF}
              nowMs={NOW}
              actions={actions}
              pending={pending}
              reactions={REACTIONS}
              tailGap={CONV.conversationTail}
              jumpPills
            />
          </View>
        }
        composer={
          <View collapsable={false}>
            <Composer
              recipient="person"
              channelLabel="이도현"
              directory={DIRECTORY}
              draftKey={DRAFT_KEY}
              attachmentTarget={{workspaceId: WS, channelId: CHANNEL}}
              inputRef={inputRef}
              onSend={onSend}
            />
          </View>
        }
      />
    </Screen>
  );
}
