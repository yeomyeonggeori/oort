import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {AccessibilityInfo, Appearance, AppState, Dimensions, Keyboard, Settings, Share, StyleSheet, Text, View} from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import type {GestureResponderEvent} from 'react-native';
import {Screen} from '../src/design/atoms';
import {Composer} from '../src/features/conversation/Composer';
import {ConversationHeader} from '../src/features/conversation/ConversationHeader';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {CONV} from '../src/features/conversation/convDesign';
import type {MessageRowActions} from '../src/features/conversation/MessageRow';
import {Timeline} from '../src/features/conversation/Timeline';
import {ShareSheetTouchShield} from '../src/lib/ShareSheetTouchShield';
import {isShareSheetHeld, useShareSheetHeld} from '../src/lib/shareSheet';
import type {ScrollLogEntry} from '../src/features/conversation/Timeline';
import {setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 첨부 내려받기 공유 시트 캡처·계측 표면 (#5207). 진짜 머리·타임라인·컴포저가 선 대화에 파일(영상) 첨부 카드가 맨 끝에 있고, 카드를 누르는 것도
// 시트를 닫는 것도 Maestro 의 **실제 탭**이다(`maestro/5207-share-sheet.yaml`). 서버·레일만 없다 — 첨부 바이트는 `share-stub.mjs` 가 대신 답한다.
//
//   node measure/share-stub.mjs &                       # 첨부 바이트(영상 모양)와 기록 한 줄(POST /log)을 받는다. SHARE_STUB_LOG=<파일> 로 기록을 남긴다
//   xcrun simctl launch <udid> app.momo.ios --args -momoMeasure SHARE-ATTACH[-<FLAGS>] \
//     -RCT_jsLocation 127.0.0.1:$PORT [-momoShareStub 127.0.0.1:<스텁 포트>]
//   (라이트: LIGHT-SHARE-ATTACH)
//
//   FLAGS (`+` 로 겹친다)
//     probe   화면 맨 위에 probe 한 줄을 얹는다(아래). 기록(스텁의 `POST /log`)은 이 깃발과 상관없이 남는다. 캡처에는 켜지 않는다.
//     noshield  공유 시트 터치 막이(`ShareSheetTouchShield`)를 세우지 않는다 — 고치기 전과 같은 모양을 재는 대조군(사보타주)이다.
//     big     첨부가 보고된 영상의 크기(58.4 MB)다 — 내려받기 진행 줄이 여러 번 바뀐다. 기본은 6 MB.
//     flip    시트가 닫힐 때와 앱이 비활성→활성으로 돌아올 때 연결 흔들림 한 번(끊겼다 이어짐 = `realtimeConnected` 가 두 번 뒤집힘 — `centrifugeTransport` 의 `resume()` 이 만드는 복구 시작·끝)을
//             모형으로 얹는다. 방이 이력을 더 갖고 있어(`reachedStart` 거짓) 당김이 꺼진 목록이 연결에 따라 `refreshControl` 자리를 뒤집는 길(#4949)을 시트 여닫기에 겹쳐 잰다.
//             시뮬레이터의 시트는 앱 상태를 바꾸지 않으므로(`flips=0`) 이것은 **시트가 흔들림을 만든다는 측정이 아니다** — 흔들림이 목록을 흔드는가를 재는 모형이다.
//
// probe 한 줄(`share-probe`)은 **앱이 아는 그대로** 적는다:
//   app=<앱 상태 마지막> flips=<앱 상태 전이 수> share=<never|open|closed> thread=<스레드가 열린 횟수> touch=<RN 이 받은 터치 수>
//   base=<기준선 y> y=<지금 y> drift=<기준선 뒤 y 가 기준에서 벗어난 최댓값> moves=<기준선 뒤 스크롤 보고 수> flaps=<끝난 연결 흔들림 수(`flip` 일 때만 오른다)>
// 기준선(`base`)은 시트가 열려 있지 않을 때 **터치가 시작되는 순간** 목록의 자리로 다시 잡힌다 — 카드를 누르는 터치가 한 주기의 시작이고, 그 뒤 시트를 열고 닫는 동안 목록이 움직인 정도가
// `drift`(최댓값)·`moves`(보고 수)다. 시트가 열린 동안 받은 터치는 기준을 옮기지 않는다.
// 같은 기록이 스텁의 `POST /log` 로도 간다(시간순 한 줄씩: 앱 상태·시트 열림/닫힘·스레드·터치·스크롤).
//
// 인물·문구는 전부 지어낸 것이다(이도현·박서연, 회사 「달무리 스튜디오」) — 공개 저장소의 캡처에 실제 팀원·대화를 쓰지 않는다.
// =============================================================================

const WS = '00000000-0000-7000-8000-0000000000d0';
const SELF = '00000000-0000-7000-8000-0000000000d1';
const PEER = '00000000-0000-7000-8000-0000000000d2';
const CHANNEL = 'share-attach-capture';
const NO_TOP = {paddingTop: 0} as const;

/** 스텁 주소. 기본 18995 — 다른 워크트리의 스텁이 그 포트를 쥐고 있으면 `-momoShareStub host:port` 로 비켜 간다(`photoViewer.tsx` 와 같은 규칙). */
function stubHost(): string {
  const value = Settings.get('momoShareStub');
  return typeof value === 'string' && value !== '' ? value : '127.0.0.1:18995';
}

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
  member({id: PEER, displayName: '박서연', handle: 'seoyeon'}),
]);

const NOW = Date.now();
const START_OF_TODAY = new Date(NOW).setHours(0, 0, 0, 0);

type Draft = {author: string; body: string; rootSeq?: number; file?: string};

// 어제 하루(이력이 길어 위에 「어제」 구분선이 서고 목록이 스크롤된다) → 오늘. 스레드 하나(루트 + 답글 셋: 답글 줄 「↳ ○○님에게 답글」 이 줄줄이 선다), 그 뒤 몇 줄, 맨 끝은 파일 첨부 메시지다.
const SCRIPT: Draft[] = [
  ...[
    '어제 회의 정리해서 공유 폴더에 올렸어요',
    '확인했어요. 일정표는 오늘 안에 볼게요',
    '달무리 스튜디오 쪽 의견도 같이 받아 둘게요',
    '좋아요, 그쪽 답을 기다려요',
    '시안은 세 가지로 추렸어요',
    '첫 번째가 제일 낫네요',
    '저도 그렇게 봤어요',
    '그럼 그 방향으로 가요',
    '컨셉 영상 일정은 어떻게 돼요?',
    '이번 주 안에 초안이 나와요',
    '초안 나오면 바로 볼게요',
    '네, 나오는 대로 올릴게요',
    '자막은 따로 맡길까요?',
    '직접 넣을게요',
    '그럼 믿고 기다릴게요',
    '오늘은 여기까지 할게요',
  ].map<Draft>((body, index) => ({
    author: index % 2 === 0 ? PEER : SELF,
    body,
    // 어제의 중간 카드: 읽던 자리(맨 아래가 아닌 곳)에서 시트를 열어도 자리가 그대로인가를 잰다.
    ...(index === 9 ? {file: 'v0.mp4'} : {}),
  })),
  {author: SELF, body: '좋은 아침이에요. 오늘 일정부터 볼게요'},
  {author: PEER, body: '네, 열 시에 리뷰 있어요'},
  {author: SELF, body: '취소하는 API도 있으면 좋을 것 같아요'}, // 스레드 루트(seq 19, 아래 답글 셋이 이 줄을 가리킨다)
  {author: PEER, body: '반영하겠습니다', rootSeq: 19},
  {author: PEER, body: '정리해서 올릴게요', rootSeq: 19},
  {author: PEER, body: '엇', rootSeq: 19},
  {author: PEER, body: '메시지'},
  {author: SELF, body: '해결해 두겠습니다'},
  {author: SELF, body: '컨셉 영상 제작이 거의 막바지 단계가 되었습니다', file: 'v1.mp4'},
];

function build(big: boolean): Message[] {
  const todayFrom = SCRIPT.findIndex(entry => entry.body.startsWith('좋은 아침'));
  return SCRIPT.map((entry, index) => {
    const seq = index + 1;
    const createdAtMs =
      index < todayFrom
        ? START_OF_TODAY - (todayFrom - index) * 20 * 60_000
        : Math.min(NOW - (SCRIPT.length - index) * 1_000, START_OF_TODAY + (index - todayFrom + 1) * 20_000);
    return {
      id: `00000000-0000-7000-8000-00000000d${String(seq).padStart(3, '0')}`,
      channelId: CHANNEL,
      seq,
      hlcTs: seq,
      hlcCount: 0,
      authorMemberId: entry.author,
      type: 'text',
      body: entry.body,
      state: 'sent',
      createdAtMs,
      ...(entry.rootSeq === undefined
        ? {}
        : {rootId: `00000000-0000-7000-8000-00000000d${String(entry.rootSeq).padStart(3, '0')}`}),
      ...(entry.file === undefined
        ? {}
        : {
            attachments: [
              {
                id: big ? 'video-big' : 'video-small',
                name: entry.file,
                mime: 'video/mp4',
                sizeBytes: big ? 61_235_000 : 6_291_456,
              },
            ],
          }),
    } as Message;
  });
}

// ---- 기록과 probe 한 줄 -----------------------------------------------------------
// Maestro 는 계층에 보이는 글만 읽는다. 시트가 서 있는 동안 앱이 아는 것(앱 상태·시트 단계·스레드·터치·목록의 y)을 한 줄로 적는다. 저장소는 모듈 수준이라 표면을 다시 그리지
// 않는다 — 한 줄만 갱신되고 재는 대상(목록)은 이 줄 때문에 달라지지 않는다.
interface Probe {
  app: string;
  flips: number;
  share: 'never' | 'open' | 'closed';
  thread: number;
  touch: number;
  base: number | null;
  y: number | null;
  drift: number;
  moves: number;
  /** 끝난 연결 흔들림(끊겼다 이어짐) 수. `flip` 이 아니면 늘 0 이다. */
  flaps: number;
}
let probe: Probe = {app: 'active', flips: 0, share: 'never', thread: 0, touch: 0, base: null, y: null, drift: 0, moves: 0, flaps: 0};
/** 기준선이 잡힌 자리(`y`)와 그때 마지막 보고의 시각(`at`). 표면이 서면 비운다. */
let baseline: {y: number; at: number} | null = null;
const probeListeners = new Set<() => void>();
function probeSet(patch: Partial<Probe>): void {
  probe = {...probe, ...patch};
  probeListeners.forEach(listener => listener());
}

type Sink = (record: Record<string, unknown>) => void;

function makeSink(): Sink {
  const host = stubHost();
  const t0 = Date.now();
  return record => {
    const line = JSON.stringify({t: Date.now() - t0, ...record});
    fetch(`http://${host}/log`, {method: 'POST', body: line}).catch(() => {
      // 받는 쪽이 없으면 기록만 못 남는다. 계측이 앱을 죽이지 않는다.
    });
  };
}

const styles = StyleSheet.create({
  fill: {flex: 1},
  probeBox: {position: 'absolute', top: 0, left: 0, right: 0, zIndex: 999},
  probeText: {fontSize: 9, lineHeight: 11, color: '#ffffff', backgroundColor: 'rgba(0,0,0,0.65)'},
  threadBanner: {position: 'absolute', top: 120, left: 0, right: 0, zIndex: 998, alignItems: 'center'},
  threadBannerText: {fontSize: 14, color: '#ffffff', backgroundColor: 'rgba(200,40,40,0.9)', paddingHorizontal: 10, paddingVertical: 4},
});

function ProbeLine({log, sink, show}: {log: React.MutableRefObject<ScrollLogEntry[] | null>; sink: Sink; show: boolean}): React.JSX.Element | null {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump(count => count + 1);
    probeListeners.add(listener);
    let sent = 0;
    const poll = setInterval(() => {
      const entries = log.current ?? [];
      const scrolls = entries.filter((entry): entry is Extract<ScrollLogEntry, {k: 's'}> => entry.k === 's');
      for (let at = sent; at < entries.length; at += 1) {
        const entry = entries[at];
        sink(
          entry.k === 's'
            ? {k: 'scroll', y: Math.round(entry.y), content: Math.round(entry.content), view: Math.round(entry.view), user: entry.user, pin: entry.pin}
            : {k: 'scrollmode', mode: entry.k, on: entry.on},
        );
      }
      sent = entries.length;
      const last = scrolls[scrolls.length - 1];
      if (last === undefined) return;
      // 기준선은 **터치가 시작될 때** 잡힌다(아래 `touch`) — 시트가 열려 있지 않을 때의 터치만이다. 그 뒤의 스크롤 보고만 센다: 카드를 누르고 시트를 열고 닫는 동안 목록이 움직이면 여기 쌓인다.
      if (baseline === null) {
        if (probe.y !== Math.round(last.y)) probeSet({y: Math.round(last.y)});
        return;
      }
      const {y: baseY, at: baseAt} = baseline;
      let drift = 0;
      let moves = 0;
      scrolls.forEach(entry => {
        if (entry.t > baseAt) {
          drift = Math.max(drift, Math.abs(entry.y - baseY));
          moves += 1;
        }
      });
      const next = {y: Math.round(last.y), drift: Math.round(drift), moves};
      if (next.y !== probe.y || next.drift !== probe.drift || next.moves !== probe.moves) probeSet(next);
    }, 150);
    return () => {
      probeListeners.delete(listener);
      clearInterval(poll);
    };
  }, [log, sink]);
  if (!show) return null;
  return (
    <View pointerEvents="none" style={styles.probeBox}>
      <Text style={styles.probeText} testID="share-probe">
        {`app=${probe.app} flips=${probe.flips} share=${probe.share} thread=${probe.thread} touch=${probe.touch} base=${probe.base ?? '-'} y=${probe.y ?? '-'} drift=${probe.drift} moves=${probe.moves} flaps=${probe.flaps}`}
      </Text>
    </View>
  );
}

export function ShareAttachSurface({which}: {which: string}): React.JSX.Element {
  const flags = new Set(which.split('+'));
  const has = (name: string) => flags.has(name);
  const sinkRef = useRef<Sink | null>(null);
  if (sinkRef.current === null) sinkRef.current = makeSink();
  const sink = sinkRef.current;
  const scrollLog = useRef<ScrollLogEntry[] | null>([]);
  const [messages] = useState<Message[]>(() => build(has('big')));
  const [connected, setConnected] = useState(true);
  const [threads, setThreads] = useState(0);
  // 막이가 서고 거두어지는 때를 기록에 남긴다 — 시트가 닫힌 **뒤** 유예(400ms)만큼 늦게 거두어지는 것이 보여야 한다.
  const shieldUp = useShareSheetHeld();
  useEffect(() => {
    sink({k: 'shield', up: shieldUp});
  }, [shieldUp, sink]);

  // 첫 렌더 전에 한 번: 파일 카드는 눌릴 때 내려받기를 시작한다. 서버 주소를 스텁으로 가리킨다(주소는 MMKV 에 남으므로 표면이 내려갈 때 지운다).
  useState(() => {
    setServerBase(`http://${stubHost()}`);
    probe = {app: AppState.currentState, flips: 0, share: 'never', thread: 0, touch: 0, base: null, y: null, drift: 0, moves: 0, flaps: 0};
    baseline = null;
    return null;
  });
  useEffect(() => () => setServerBase(null), []);

  // 연결 흔들림 한 번 = 끊겼다(복구 시작) 이어짐(복구 끝) — `realtimeConnected` 가 두 번 뒤집힌다. 목록은 이력이 더 남은 방(`reachedStart` 거짓)이라 이 값을 따라 당김 문이 열렸다 닫힌다(#4783·#4949).
  // `flip` 일 때만, 시뮬레이터의 시트는 앱 상태를 바꾸지 않으므로(flips=0) 실기기에서 일어날 수 있는 흔들림을 **모형으로 얹는다**: 시트가 닫힐 때와 앱이 비활성→활성으로 돌아올 때
  // (`centrifugeTransport` 가 그때 `resume()` 으로 소켓을 다시 연다). 이 모형이 재는 것은 흔들림이 목록을 흔드는가이지 시트가 흔들림을 만드는가가 아니다.
  const flapTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const flap = useCallback(() => {
    if (!flags.has('flip')) return;
    sink({k: 'flap', phase: 'start'});
    flapTimers.current.push(
      setTimeout(() => {
        sink({k: 'connected', value: false});
        setConnected(false);
      }, 50),
      setTimeout(() => {
        sink({k: 'connected', value: true});
        setConnected(true);
        probeSet({flaps: probe.flaps + 1});
        sink({k: 'flap', phase: 'end'});
      }, 650),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sink]);
  useEffect(() => {
    const timers = flapTimers.current;
    return () => timers.forEach(clearTimeout);
  }, []);

  // 앱 상태 전이를 그대로 남긴다 — 시트가 앱을 `inactive` 로 만드는가의 증거다.
  useEffect(() => {
    sink({k: 'app', state: AppState.currentState, initial: true});
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', next => {
      sink({k: 'app', state: next, from: previous});
      probeSet({app: next, flips: probe.flips + 1});
      if (previous === 'inactive' && next === 'active') flap();
      previous = next;
    });
    return () => subscription.remove();
  }, [sink, flap]);

  // 공유 시트가 열리고 닫히는 순간을 남긴다 — 원본은 그대로 부른다. 이 표면은 `__DEV__` 의 `-momoMeasure` 에서만 선다(`measure/root.ts`)라 앱에는 이 덮어쓰기가 없고,
  // 표면이 사라지면 원래대로 돌려 놓는다.
  useEffect(() => {
    const original = Share.share;
    Share.share = (content, options) => {
      sink({k: 'share', phase: 'open', held: isShareSheetHeld()});
      probeSet({share: 'open'});
      return original.call(Share, content, options).then(
        result => {
          sink({k: 'share', phase: 'closed', action: result.action});
          probeSet({share: 'closed'});
          flap();
          return result;
        },
        (error: unknown) => {
          sink({k: 'share', phase: 'failed'});
          probeSet({share: 'closed'});
          throw error;
        },
      );
    };
    return () => {
      Share.share = original;
    };
  }, [sink, flap]);

  // 시트가 열리고 닫힐 때 앱이 받는 **다른** 시스템 신호를 같은 기록에 남긴다 — 앱 상태 말고도 목록을 다시 그리게 할 만한 것(창 크기·색 모드·자판·접근성·망)이 같이 오는지의 증거다.
  useEffect(() => {
    const subscriptions = [
      Dimensions.addEventListener('change', ({window}) => sink({k: 'dimensions', width: window.width, height: window.height})),
      Appearance.addChangeListener(({colorScheme}) => sink({k: 'appearance', colorScheme})),
      ...(['keyboardWillShow', 'keyboardDidShow', 'keyboardWillHide', 'keyboardDidHide', 'keyboardWillChangeFrame'] as const).map(name =>
        Keyboard.addListener(name, event => sink({k: 'keyboard', name, h: Math.round(event.endCoordinates.height)})),
      ),
      AccessibilityInfo.addEventListener('reduceMotionChanged', value => sink({k: 'a11y', reduceMotion: value})),
      AccessibilityInfo.addEventListener('screenReaderChanged', value => sink({k: 'a11y', screenReader: value})),
    ];
    const unsubscribeNet = NetInfo.addEventListener(state =>
      sink({k: 'net', type: state.type, connected: state.isConnected, reachable: state.isInternetReachable}),
    );
    return () => {
      subscriptions.forEach(subscription => subscription.remove());
      unsubscribeNet();
    };
  }, [sink]);

  const actions = useRef<MessageRowActions>({
    myMemberId: SELF,
    onToggleReaction: async () => {},
    onEdit: async () => {},
    onDelete: async () => {},
    onOpenThread: m => {
      sink({k: 'thread', seq: m.seq});
      probeSet({thread: probe.thread + 1});
      setThreads(count => count + 1);
    },
    onOpenProfile: () => {},
  }).current;

  const onRefresh = useRef(async (): Promise<void> => {}).current;

  const touch = (kind: 'start' | 'end') => (event: GestureResponderEvent) => {
    sink({k: 'touch', kind, x: Math.round(event.nativeEvent.pageX), y: Math.round(event.nativeEvent.pageY)});
    if (kind !== 'start') return;
    // 시트가 열려 있지 않을 때 시작한 터치가 새 주기의 시작이다 — 그 순간의 목록 자리가 기준이다. 시트가 열린 동안 RN 이 받은 터치(닫는 탭이 샌 것)는 기준을 옮기지 않는다.
    if (probe.share !== 'open') {
      baseline = {y: probe.y ?? 0, at: Date.now()};
      probeSet({touch: probe.touch + 1, base: probe.y, drift: 0, moves: 0});
    } else {
      probeSet({touch: probe.touch + 1});
    }
  };

  return (
    <Screen style={NO_TOP}>
      <ConversationHeader
        title="박서연"
        kind="dm"
        peerId={PEER}
        directory={DIRECTORY}
        onBack={() => {}}
        onOpenMenu={() => {}}
        onOpenInfo={() => {}}
        railStatus="connected"
      />
      <ConversationLayout
        list={
          <View style={styles.fill} onTouchStart={touch('start')} onTouchEnd={touch('end')} testID="share-list">
            <Timeline
              messages={messages}
              directory={DIRECTORY}
              status="ready"
              channelKind="dm"
              channelId={CHANNEL}
              myMemberId={SELF}
              nowMs={NOW}
              actions={actions}
              tailGap={CONV.conversationTail}
              jumpPills
              reachedStart={false}
              onRefresh={onRefresh}
              realtimeConnected={connected}
              scrollLogRef={scrollLog}
            />
          </View>
        }
        composer={
          <View collapsable={false}>
            <Composer
              recipient="person"
              channelLabel="박서연"
              directory={DIRECTORY}
              draftKey="measure:share-attach"
              attachmentTarget={{workspaceId: WS, channelId: CHANNEL}}
              onSend={() => {}}
            />
          </View>
        }
      />
      {threads > 0 ? (
        <View pointerEvents="none" style={styles.threadBanner}>
          <Text style={styles.threadBannerText} testID="share-thread-opened">
            {`하네스: 스레드가 열렸다 (${threads})`}
          </Text>
        </View>
      ) : null}
      {/* 앱의 셸(`AppShell`)이 세우는 막이를 이 표면도 세운다 — 하네스에는 셸이 없다. `noshield` 이면 세우지 않는다(고치기 전과 같은 모양을 재는 대조군). */}
      {has('noshield') ? null : <ShareSheetTouchShield />}
      <ProbeLine log={scrollLog} sink={sink} show={has('probe')} />
    </Screen>
  );
}
