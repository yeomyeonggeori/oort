import type {Message, RosterMember} from '@momo/core/lib/api';
import {sendMessage} from '@momo/core/lib/api';
import {installCoreHost} from '@momo/core/runtime/host';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Pressable, Settings, StyleSheet, Text, TextInput, View} from 'react-native';
import {Screen} from '../src/design/atoms';
import {Composer} from '../src/features/conversation/Composer';
import {ConversationHeader} from '../src/features/conversation/ConversationHeader';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {clearDraft, readDraft} from '../src/features/conversation/drafts';
import {Timeline} from '../src/features/conversation/Timeline';

// =============================================================================
// 줄바꿈 측정 표면 (#4321). 「가 ⏎ 나」를 치고 보내면 줄바꿈이 어느 단계에서 사라지는가.
//
//   node measure/newline-sink.mjs /tmp/nl.jsonl /tmp/nl.port        # 받는 쪽(줄 단위 JSON 으로 적는다)
//   xcrun simctl launch <udid> app.momo.ios --args \
//     -momoMeasure COMPOSER-NEWLINE[-<WHICH>] -momoGapSink 127.0.0.1:$(cat /tmp/nl.port) -RCT_jsLocation 127.0.0.1:<metro>
//   (선택) -momoNewlineBusy 300   JS 스레드를 300ms 씩 붙잡는다 — 입력 이벤트가 밀려도 줄바꿈이 남는지
//
//   (빈 이름)   배송되는 `Composer` 를 대화 화면과 같은 순서로 세운다. 보내기는 코어의 진짜
//               `sendMessage` 이고, 받는 쪽은 `-momoGapSink` 의 모의 API 다.
//   bare        `Composer` 의 입력창과 **같은 props** 의 맨 `TextInput` — RN·iOS 가 줄바꿈을
//               넘기는지만 따로 본다. 키 이벤트·제출 이벤트까지 받아 적는다.
//
// 단계 이름은 PR 의 재현 매트릭스와 같다:
//   ① onChangeText 값   ② 보내기 직전 body   ③ 요청 JSON   ⑤ 말풍선(폰 렌더)
// ④(서버 저장)는 이 표면 밖이다 — 모의 API 는 받은 본문을 그대로 돌려줄 뿐이다.
// =============================================================================

const WS = '00000000-0000-7000-8000-0000000000e0';
const SELF = '00000000-0000-7000-8000-0000000000e1';
const PEER = '00000000-0000-7000-8000-0000000000e2';
const CHANNEL = '00000000-0000-7000-8000-0000000000e3';
const DRAFT_KEY = 'measure:composer-newline';

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

const SEED: Message[] = [
  {
    id: '00000000-0000-7000-8000-00000000e101',
    channelId: CHANNEL,
    seq: 1,
    hlcTs: 1,
    hlcCount: 0,
    authorMemberId: PEER,
    type: 'text',
    body: '줄바꿈 시험이에요. 아래 입력창에 두 줄을 쳐 보내 주세요.',
    state: 'sent',
    createdAtMs: NOW - 60_000,
  } as Message,
];

function sinkAddress(): string | undefined {
  const sink = Settings.get('momoGapSink');
  return typeof sink === 'string' && sink !== '' ? sink : undefined;
}

/** 받는 쪽이 없으면 조용히 버린다 — 계측이 앱을 죽이지 않는다. */
function probe(surface: string, record: Record<string, unknown>): void {
  const sink = sinkAddress();
  const line = {surface, ...record};
  console.log(`NL4321 ${JSON.stringify(line)}`);
  if (sink === undefined) return;
  void fetch(`http://${sink}/probe`, {method: 'POST', body: JSON.stringify(line)}).catch(() => {});
}

/** 화면에 같이 찍어 사진 한 장으로도 단계가 읽히게 한다. 눈에 안 보이는 `\n` 은 `⏎` 로 적는다. */
function show(text: string): string {
  return `${JSON.stringify(text).slice(1, -1).replace(/\\n/g, '⏎')} (${text.length}자, 줄바꿈 ${
    text.split('\n').length - 1
  }개)`;
}

/**
 * JS 스레드 부하 흉내. `-momoNewlineBusy <ms>` 면 그 길이만큼 JS 를 붙잡는 일을 0.1초 쉬고 되풀이한다 — #4292 의
 * 「대화 화면이 저절로 다시 그려진다」처럼 JS 가 바쁜 때 입력 이벤트가 밀려도 줄바꿈이 남는지 본다.
 */
function useBusyJs(): void {
  useEffect(() => {
    const raw = Settings.get('momoNewlineBusy');
    const ms = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(ms) || ms <= 0) return undefined;
    const timer = setInterval(() => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        // 일부러 붙잡는다.
      }
    }, ms + 100);
    return () => clearInterval(timer);
  }, []);
}

function useReadout(): [Record<string, string>, (stage: string, text: string) => void] {
  const [lines, setLines] = useState<Record<string, string>>({});
  const set = useCallback((stage: string, text: string) => {
    setLines(current => ({...current, [stage]: show(text)}));
  }, []);
  return [lines, set];
}

function Readout({lines}: {lines: Record<string, string>}) {
  return (
    <View style={styles.readout} testID="nl-readout">
      {Object.keys(lines)
        .sort()
        .map(stage => (
          <Text key={stage} style={styles.readoutLine} testID={`nl-readout-${stage[0]}`}>
            {stage} {lines[stage]}
          </Text>
        ))}
    </View>
  );
}

/** 코어의 진짜 보내기 경로를 `-momoGapSink` 의 모의 API 에 건다. */
function useCoreSend(surface: string, onConfirmed: (message: Message) => void, mark: (s: string, t: string) => void) {
  useState(() => {
    const sink = sinkAddress();
    if (sink !== undefined) {
      installCoreHost({
        apiBase: () => `http://${sink}`,
        absoluteApiBase: () => `http://${sink}`,
        buildMode: () => 'development',
        session: {
          getAccessToken: () => 'measure-token',
          getRefreshToken: () => null,
          getPersistedSession: () => null,
          applyLogin: () => {},
          applyRotation: () => {},
          markAuthExpired: () => {},
          clearSession: () => {},
        },
      });
    }
    return null;
  });
  return useCallback(
    (body: string) => {
      mark('②', body);
      probe(surface, {stage: '2-before-send', body, hasNewline: body.includes('\n')});
      const clientMsgId = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      void sendMessage(WS, CHANNEL, clientMsgId, body)
        .then(confirmed => {
          probe(surface, {stage: '5-confirmed-body', body: confirmed.body, hasNewline: (confirmed.body ?? '').includes('\n')});
          mark('⑤', confirmed.body ?? '');
          onConfirmed(confirmed);
        })
        .catch(error => probe(surface, {stage: 'send-failed', error: String(error)}));
    },
    [surface, onConfirmed, mark],
  );
}

/** 배송되는 `Composer` — 대화 화면과 같은 순서. */
function RealComposerSurface({probeLayout = false}: {probeLayout?: boolean}): React.JSX.Element {
  useBusyJs();
  const [messages, setMessages] = useState<Message[]>(SEED);
  const [lines, mark] = useReadout();
  const lastDraft = useRef<string | null>(null);
  useState(() => {
    clearDraft(DRAFT_KEY);
    return null;
  });
  // ① 은 `Composer` 가 `onChangeText` 마다 `saveDraft(next)` 로 적는 그 값을 읽는다(초안은 글자 그대로 저장된다).
  useEffect(() => {
    const timer = setInterval(() => {
      const draft = readDraft(DRAFT_KEY);
      if (draft === lastDraft.current) return;
      lastDraft.current = draft;
      if (draft === '') return; // 보낸 뒤 비워진 것은 ① 이 아니다.
      mark('①', draft);
      probe('composer', {stage: '1-onChangeText(draft)', body: draft, hasNewline: draft.includes('\n')});
    }, 120);
    return () => clearInterval(timer);
  }, [mark]);
  const onConfirmed = useCallback((message: Message) => {
    setMessages(current => [...current, message]);
  }, []);
  const send = useCoreSend('composer', onConfirmed, mark);
  const inputRef = useRef<TextInput | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 1500);
    return () => clearTimeout(timer);
  }, []);
  return (
    <Screen style={NO_TOP}>
      <ConversationHeader
        title="이도현"
        kind="dm"
        peerId={PEER}
        peerStatusTone="ok"
        directory={DIRECTORY}
        onBack={() => {}}
        onOpenMenu={() => {}}
        railStatus="connected"
      />
      <Readout lines={lines} />
      <ConversationLayout
        list={
          <Timeline
            messages={messages}
            directory={DIRECTORY}
            status="ready"
            channelKind="dm"
            myMemberId={SELF}
            nowMs={NOW}
          />
        }
        composer={
          <View
            onLayout={event => {
              // #4305: 도크(컴포저 전체)의 실제 높이를 레이아웃이 바뀔 때마다 적는다 — 「보낸 뒤 한 줄로 돌아오는가」를 숫자로 잰다.
              if (probeLayout) {
                probe('twostate', {stage: 'dock-height', height: event.nativeEvent.layout.height, at: Date.now()});
              }
            }}>
            <Composer
              recipient="person"
              channelLabel="이도현"
              directory={DIRECTORY}
              draftKey={DRAFT_KEY}
              attachmentTarget={{workspaceId: WS, channelId: CHANNEL}}
              inputRef={inputRef}
              onSend={send}
            />
          </View>
        }
      />
    </Screen>
  );
}

/** `Composer` 의 입력창과 같은 props 의 맨 `TextInput`. */
function BareSurface(): React.JSX.Element {
  useBusyJs();
  const surface = 'bare';
  const [text, setText] = useState('');
  const textRef = useRef('');
  const [lines, mark] = useReadout();
  const [events, setEvents] = useState<string[]>([]);
  const log = useCallback(
    (name: string, detail: Record<string, unknown>) => {
      probe(surface, {stage: `evt:${name}`, ...detail});
      setEvents(current => [...current.slice(-5), `${name} ${JSON.stringify(detail)}`]);
    },
    [surface],
  );
  const inputRef = useRef<TextInput | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 1500);
    return () => clearTimeout(timer);
  }, []);
  const onSend = useCoreSend(surface, () => {}, mark);
  return (
    <Screen style={NO_TOP}>
      <View style={styles.bare}>
        <Text style={styles.readoutLine}>맨 입력창 시험 ({surface})</Text>
        <Readout lines={lines} />
        {events.map((line, index) => (
          <Text key={`${index}-${line}`} style={styles.eventLine}>
            {line}
          </Text>
        ))}
        <TextInput
          ref={inputRef}
          style={styles.bareInput}
          value={text}
          onChangeText={next => {
            textRef.current = next;
            setText(next);
            mark('①', next);
            probe(surface, {stage: '1-onChangeText', body: next, hasNewline: next.includes('\n')});
          }}
          onKeyPress={event => log('keyPress', {key: event.nativeEvent.key})}
          onSubmitEditing={() => log('submitEditing', {})}
          onEndEditing={() => log('endEditing', {})}
          multiline
          submitBehavior="newline"
          lineBreakStrategyIOS="hangul-word"
          textAlignVertical="top"
          testID="composer-input"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="보내기"
          onPress={() => {
            const body = textRef.current.trim();
            onSend(body);
            textRef.current = '';
            setText('');
          }}
          style={styles.bareSend}
          testID="composer-send">
          <Text style={styles.readoutLine}>보내기</Text>
        </Pressable>
      </View>
    </Screen>
  );
}

const NO_TOP = {paddingTop: 0} as const;

export function ComposerNewlineSurface({which}: {which: string}): React.JSX.Element {
  if (which === 'bare') return <BareSurface />;
  return <RealComposerSurface probeLayout={which === 'twostate'} />;
}

const styles = StyleSheet.create({
  readout: {paddingHorizontal: 12, paddingVertical: 6},
  readoutLine: {fontSize: 12, color: '#888888'},
  eventLine: {fontSize: 10, color: '#888888'},
  bare: {flex: 1, paddingTop: 80, paddingHorizontal: 12, gap: 6},
  bareInput: {
    minHeight: 44,
    maxHeight: 130,
    borderWidth: 1,
    borderColor: '#888888',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 16,
    color: '#888888',
  },
  bareSend: {alignSelf: 'flex-start', padding: 10, borderWidth: 1, borderColor: '#888888', borderRadius: 12},
});
