import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  PixelRatio,
  ScrollView,
  Settings,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type TextLayoutEventData,
} from 'react-native';
import {Screen, Sentence} from '../src/design/atoms';
import {LINE_HEADROOM} from '../src/design/lineHeadroom';
import {font, line} from '../src/design/tokens';

// =============================================================================
// 줄바꿈 전략별 「잰 줄 수 ↔ 그린 줄 수」 측정 표면 (#5288, #4894).
//
//   measure/run-sentence-wrap.sh <udid> <태그> SENTENCE-WRAP <Metro 포트> <결과 폴더> [content_size] [appearance] [앱 인자 …]
//     (구동기가 받는 쪽 `bubble-clip-check.mjs serve` 를 띄우고 앱을 `-momoGapSink` 로 이어, 끝나면 `sentence-wrap-check.mjs` 로 단정한다.
//      시뮬레이터를 쓰므로 `~/.cache/momo-scratch/bin/sim-locked.sh` 로 감싸 부른다)
//   앱 이름: SENTENCE-WRAP (숫자 표) | SENTENCE-WRAP-VISUAL (사람이 눈으로 보는 캡처 면)
//
//   (선택) -momoWrapWidths 338,300-402/1   칸 폭(pt) — 낱개 또는 `시작-끝/걸음`. 기본 338
//   (선택) -momoWrapStrategies hangul-word,standard,push-out,none,unset,sentence   줄바꿈 전략. 기본 전부.
//          `unset` = `lineBreakStrategyIOS` 를 아예 주지 않는다 · `sentence` = 실제 `Sentence` 부품(고치는 대상)
//   (선택) -momoWrapSet en|ko|mix|ctx|all|<칸 id 앞부분>   글 묶음. 기본 all
//   (선택) -momoWrapBase 0,2500,2500.3333,16000   칸 위에 깔 빈 공간(pt) 목록 — 칸의 **절대 y** 를 키운다(아래 「원인」). 기본 0
//   (선택) -momoWrapReps 48   같은 칸을 48번 쌓는다. 칸마다 위 간격에 (0·1/3·2/3)pt 를 번갈아 더해 y 의 소수 부분을 훑는다. 기본 1
//          쪽은 전략별로 따로 서고(전략마다 같은 쌓기 순서), 그래서 **같은 절대 y 에서 전략끼리 맞댈 수 있다**.
//
// ## 무엇을 재나
//
// 칸 하나 = 폭 W 인 `View` 안에 같은 글 하나. 두 숫자를 같은 글에서 따로 받는다.
//   · `onLayout` 높이 = Yoga 가 글 상자에 준 높이 = **잰** 줄 수 (측정 단계는 폭 W · 높이 ∞ 로 TextKit 에 묻는다)
//   · `onTextLayout` 줄들 = **그릴** 줄. 최종 틀(폭 W · 높이 H)로 `drawRect` 와 같은 `NSLayoutManager` 구성을 다시 만들어 낸 줄이다
// 두 줄 수가 다르면 말풍선·카드는 N 줄 높이로 서는데 글은 M 줄로 그려진다 — 오른쪽에서 잘리고 아래 줄이 빈다.
// 이름·문구는 가상이다(영어 문장은 v0.1.42 소식 상세의 실제 글이다).
// =============================================================================

type TextCase = {id: string; set: string; text: string};

/** v0.1.42 소식 상세(영어)에서 보인 문장들. `en-hyphen` 만 오른쪽에서 잘렸다(INDEX §5). */
const EN_NOTES: [string, string][] = [
  ['en-notif-3', 'An approval alert is one question, and a one-line receipt stays after you decide.'],
  ['en-notif-3-nohyphen', 'An approval alert is one question, and a short receipt stays after you decide.'],
  ['en-notif-1', 'Opening a notification clears stacked sheets and dialogs and goes straight to that message, keeping your draft.'],
  ['en-notif-2', 'Threads you reply in or are mentioned in are followed on their own, and notification settings can turn their alerts off.'],
  ['en-notif-4', 'On the Mac, clicking a notification banner now opens the right message.'],
  ['en-attach-1', 'Wide screenshots use more of the conversation column, so their text is readable before you open them.'],
  ['en-attach-2', 'On the phone, the tap that closes the share sheet no longer opens the thread underneath.'],
  ['en-attach-3', 'Pinch anywhere in the phone photo viewer; very long pictures can fill the screen, and a double tap shows full size.'],
  ['en-thread-1', 'Check “Also send to the conversation” on a thread reply and it shows there too, with a link back to the thread.'],
];

const EN_LONG =
  'Please review the design doc before Wednesday and leave a comment in the thread if anything looks off to you, thanks a lot.';
const KO_SENTENCE =
  '오늘 오후 세 시에 디자인 리뷰가 있어요. 자료는 공유 폴더에 올려 두었으니 미리 한번 훑어보시고, 막히는 부분이 있으면 스레드에 남겨 주세요.';
/** 5a(L5d)의 말풍선 글. 영어 + 멘션이라 한글이 없다. */
const L5D = '@kim-intern MAESTRO TEXT MAESTRO SLOW phone lane stop check';

/** 앞 n 낱말씩 잘라 길이를 훑는다 — 글이 달라지는 만큼 줄 나뉨이 달라져 반올림 경계에 걸리는 길이를 찾는다. */
function wordPrefixes(text: string, from: number): string[] {
  const words = text.split(' ');
  const out: string[] = [];
  for (let n = from; n <= words.length; n += 1) out.push(words.slice(0, n).join(' '));
  return out;
}

const CASES: TextCase[] = [
  ...EN_NOTES.map(([id, text]) => ({id, set: 'en', text})),
  ...wordPrefixes(EN_LONG, 6).map((text, i) => ({id: `enp-${String(i).padStart(2, '0')}`, set: 'enp', text})),
  {id: 'l5d', set: 'en', text: L5D},
  {id: 'ko-sentence', set: 'ko', text: KO_SENTENCE},
  ...wordPrefixes(KO_SENTENCE, 5).map((text, i) => ({id: `kop-${String(i).padStart(2, '0')}`, set: 'kop', text})),
  {id: 'ko-notfound', set: 'ko', text: '서버에서 이 대화를 찾지 못했습니다. 이미 지워졌거나 접근 권한이 없을 수 있어요.'},
  {id: 'mix-1', set: 'mix', text: '김인턴 mock reply: MOMO-004 SSE path verified. 이어서 배포 리허설도 한 번 더 돌려 볼게요.'},
  {id: 'mix-2', set: 'mix', text: 'PR #4894 리뷰 부탁드려요. 배포는 10/31 오전 9시 30분에 시작하고 롤백 기준은 에러율 2% 이상이에요 (v0.1.40 기준).'},
  {id: 'mix-3', set: 'mix', text: 'The 승인 alert keeps a one-line 영수증 after you decide, 그리고 설정에서 끌 수 있어요.'},
];

/**
 * 한 칸을 그리는 방식. 앞의 여섯은 줄바꿈 전략이고, 뒤의 둘은 고침 후보다:
 *   `padded`   = `hangul-word` + `paddingBottom: 0.01` (글 상자를 키워 보려는 후보 — 글 노드는 올림이 아니라 안쪽 여백을 뺀 높이를 쓴다)
 *   `headroom` = `hangul-word` + 줄 높이를 `LINE_HEADROOM` 만큼 낮춘 글 (`Sentence` 가 하는 일을 날 `Text` 로)
 *   `slack`    = `hangul-word` + 정수 줄 높이 그대로 + `minHeight` 로 컨테이너를 줄 수보다 훨씬 높게 — **진단용**이다. 줄 높이를 낮추지 않고
 *                컨테이너에 여유만 줘도 줄바꿈 전략이 켜지는가(켜진다 — 아래 「두 번째 발견」). 글 상자 높이가 줄 수와 무관해서 단정 A·B 는 이 전략을 세지 않는다.
 *
 * ## 두 번째 발견 — 컨테이너에 여유가 없으면 줄바꿈 전략이 **꺼진다** (#5288, 시뮬레이터 실측)
 *
 * 줄 높이가 화소의 정수배(23)인 여러 줄 글은 컨테이너 높이가 줄 수가 요구하는 높이와 **정확히 같다**. 이때 날 `Text` 의
 * `hangul-word`·`standard`·`push-out` 은 `none` 과 **같은 줄**을 낸다(한국어 779칸 모두). 같은 글에 컨테이너 여유만 주거나(`slack`) 줄 높이를
 * 0.01pt 낮추면(`headroom`·`sentence`) 어절 우선 줄바꿈이 켜져 「자료/는」 같은 한 글자 고아 줄이 사라진다(`sentence` 779칸 중 0, 나머지 25).
 * 즉 `Sentence` 의 `hangul-word` 는 정수 줄 높이 본문(23·18…)에서 그동안 **켜지지 않았고**, 깎여서 컨테이너가 모자란 경우는 마지막 줄이 잘린다 —
 * 둘 다 「컨테이너에 여유가 없다」의 두 얼굴이다. 줄 높이 여유(`LINE_HEADROOM`)가 둘을 함께 푼다.
 */
type Strategy = 'hangul-word' | 'standard' | 'push-out' | 'none' | 'unset' | 'sentence' | 'padded' | 'headroom' | 'slack';
const ALL_STRATEGIES: Strategy[] = ['hangul-word', 'standard', 'push-out', 'none', 'unset', 'sentence', 'padded', 'headroom', 'slack'];
/** `slack` 전략의 최소 높이(pt) — 23pt 줄 여섯 줄. 한국어 문장이 접히는 줄 수보다 늘 크다. */
const SLACK_MIN_HEIGHT = 138;

function sinkAddress(): string | undefined {
  const sink = Settings.get('momoGapSink');
  return typeof sink === 'string' && sink !== '' ? sink : undefined;
}

function launchList(key: string): string[] | undefined {
  const raw = Settings.get(key);
  return typeof raw === 'string' && raw !== '' ? raw.split(',').map(s => s.trim()) : undefined;
}

/** `338` · `300-402/1` · `337.5` 을 수 목록으로 푼다(`allowZero` 면 0 도 받는다 — 폭이 아니라 위쪽 공간일 때). */
function parseNumbers(items: string[], allowZero = false): number[] {
  const out: number[] = [];
  for (const item of items) {
    const range = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(item);
    if (range === null) {
      out.push(Number(item));
      continue;
    }
    const [from, to, step] = [Number(range[1]), Number(range[2]), Number(range[3])];
    for (let w = from; w <= to + 1e-9; w += step) out.push(Math.round(w * 10000) / 10000);
  }
  return out.filter(w => Number.isFinite(w) && (allowZero ? w >= 0 : w > 0));
}
const parseWidths = (items: string[]): number[] => parseNumbers(items);

/** 받는 쪽이 없으면 조용히 버린다 — 계측이 앱을 죽이지 않는다. */
function post(record: Record<string, unknown>): void {
  const sink = sinkAddress();
  const lineRecord = {surface: 'sentence-wrap', ...record};
  console.log(`WRAP5288 ${JSON.stringify(lineRecord)}`);
  if (sink === undefined) return;
  void fetch(`http://${sink}/probe`, {method: 'POST', body: JSON.stringify(lineRecord)}).catch(() => {});
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

type Frame = {width: number; height: number};
type Drawn = {x: number; y: number; width: number; height: number; text: string}[];
type Seen = {frame: Frame | null; lines: Drawn | null; y: number | null};

const PAGE = 24;

/** 칸 하나의 글 상자. 전략 이름이 곧 `lineBreakStrategyIOS` 값이다(`unset` 은 주지 않고 `sentence` 는 실제 부품). */
function Cell({
  cell,
  onFrame,
  onLines,
}: {
  cell: {c: TextCase; strategy: Strategy};
  onFrame: (event: LayoutChangeEvent) => void;
  onLines: (event: NativeSyntheticEvent<TextLayoutEventData>) => void;
}): React.JSX.Element {
  const {strategy, c} = cell;
  if (strategy === 'sentence') {
    return (
      <Sentence style={styles.text} onLayout={onFrame} onTextLayout={onLines}>
        {c.text}
      </Sentence>
    );
  }
  const raw = strategy === 'padded' || strategy === 'headroom' || strategy === 'slack' ? 'hangul-word' : strategy;
  const style =
    strategy === 'padded'
      ? [styles.text, {paddingBottom: 0.01}]
      : strategy === 'headroom'
        ? [styles.text, {lineHeight: line.body - LINE_HEADROOM}]
        : strategy === 'slack'
          ? [styles.text, {minHeight: SLACK_MIN_HEIGHT}]
          : styles.text;
  return (
    <Text
      style={style}
      lineBreakStrategyIOS={raw === 'unset' ? undefined : raw}
      onLayout={onFrame}
      onTextLayout={onLines}>
      {c.text}
    </Text>
  );
}

export function SentenceWrapSurface({which}: {which: string}): React.JSX.Element {
  if (which.startsWith('visual')) return <VisualPage which={which} />;
  return <SweepPage />;
}

function SweepPage(): React.JSX.Element {
  const widths = useMemo(() => parseWidths(launchList('momoWrapWidths') ?? ['338']), []);
  const bases = useMemo(() => parseNumbers(launchList('momoWrapBase') ?? ['0'], true), []);
  const strategies = useMemo(
    () => (launchList('momoWrapStrategies') ?? ALL_STRATEGIES).filter((s): s is Strategy => (ALL_STRATEGIES as string[]).includes(s)),
    [],
  );
  const set = (launchList('momoWrapSet') ?? ['all'])[0];
  const cases = useMemo(() => CASES.filter(c => set === 'all' || c.set === set || c.id.startsWith(set)), [set]);
  const reps = Math.max(1, Number((launchList('momoWrapReps') ?? ['1'])[0]) || 1);
  // 쪽 하나 = 위쪽 공간(base) 하나 + 전략 하나 + 칸 최대 PAGE 개. 같은 쪽의 칸은 모두 절대 y 가 base 이상이고,
  // 전략마다 쌓는 순서가 같아 (줄 수가 같은 한) 같은 칸이 같은 y 에 선다.
  const pageList = useMemo(() => {
    const out: {base: number; cells: {key: string; c: TextCase; strategy: Strategy; width: number; rep: number}[]}[] = [];
    for (const base of bases) {
      for (const strategy of strategies) {
        const all = cases.flatMap(c =>
          widths.flatMap(width =>
            Array.from({length: reps}, (_, rep) => ({key: `${c.id}|${strategy}|${width}|${base}|${rep}`, c, strategy, width, rep})),
          ),
        );
        for (let i = 0; i < all.length; i += PAGE) out.push({base, cells: all.slice(i, i + PAGE)});
      }
    }
    return out;
  }, [bases, cases, strategies, widths, reps]);
  const total = pageList.reduce((sum, p) => sum + p.cells.length, 0);
  const pages = pageList.length;
  const [page, setPage] = useState(0);
  const [bad, setBad] = useState(0);
  const seen = useRef(new Map<string, Seen>());
  const badRef = useRef(0);

  const entry = useCallback((key: string): Seen => {
    let existing = seen.current.get(key);
    if (existing === undefined) {
      existing = {frame: null, lines: null, y: null};
      seen.current.set(key, existing);
    }
    return existing;
  }, []);

  const current = pageList[page] ?? {base: 0, cells: []};
  const slice = current.cells;

  // 한 쪽을 세우고 보고가 가라앉을 때까지 기다린 뒤 적고 다음 쪽으로 간다.
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const cell of slice) {
        const s = seen.current.get(cell.key);
        const frame = s?.frame ?? null;
        const lines = s?.lines ?? [];
        // 줄 높이는 TextKit 이 낸 줄 상자의 높이다(고침 후보는 0.01pt 낮은 줄 높이를 쓴다).
        const lineH = lines[0]?.height ?? line.body;
        // `slack` 은 글 상자가 줄 수와 무관하게 높아서 「잰 줄 수」를 높이에서 구할 수 없다 — 검사기가 A·B 를 세지 않는다.
        const expected = frame === null ? null : Math.round(frame.height / lineH);
        const maxRight = lines.length > 0 ? round(Math.max(...lines.map(l => l.x + l.width))) : null;
        const record = {
          kind: 'case',
          id: cell.c.id,
          set: cell.c.set,
          strategy: cell.strategy,
          W: cell.width,
          rep: cell.rep,
          base: current.base,
          wrapY: s?.y == null ? null : round(s.y),
          len: cell.c.text.length,
          lineH,
          fontScale: round(PixelRatio.getFontScale()),
          pixelRatio: PixelRatio.get(),
          layoutW: frame === null ? null : round(frame.width),
          layoutH: frame === null ? null : round(frame.height),
          // 줄 수가 요구하는 높이보다 글 상자가 얼마나 낮은가(양수 = 깎임). 1e-4 단위를 남기려고 6자리까지 적는다.
          shave: frame === null || expected === null ? null : Math.round((expected * lineH - frame.height) * 1e6) / 1e6,
          expected,
          n: lines.length,
          maxRight,
          lines: lines.map(l => ({w: round(l.width), t: l.text})),
        };
        post(record);
        if (frame === null || lines.length === 0 || (cell.strategy !== 'slack' && expected !== lines.length)) badRef.current += 1;
      }
      setBad(badRef.current);
      if (page + 1 < pages) setPage(page + 1);
      else post({kind: 'done', total, bad: badRef.current, fontScale: round(PixelRatio.getFontScale())});
    }, 900);
    return () => clearTimeout(timer);
  }, [page, pages, slice, total, current.base]);

  return (
    <Screen>
      <View style={styles.hud} pointerEvents="none" testID="wrap-hud">
        <Text style={styles.hudText}>{`sentence-wrap p${page + 1}/${pages} · 칸 ${total} · 어긋남 ${bad} · base ${current.base}`}</Text>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        <View style={{height: current.base}} />
        {slice.map(cell => (
          <View
            key={cell.key}
            style={[styles.cell, {width: cell.width, marginTop: (cell.rep % 3) / 3}]}
            testID={`wrap-cell-${cell.key}`}
            onLayout={event => {
              entry(cell.key).y = event.nativeEvent.layout.y;
            }}>
            <Cell
              cell={cell}
              onFrame={event => {
                const {width, height} = event.nativeEvent.layout;
                entry(cell.key).frame = {width, height};
              }}
              onLines={event => {
                entry(cell.key).lines = event.nativeEvent.lines.map(({x, y, width, height, text}) => ({x, y, width, height, text}));
              }}
            />
          </View>
        ))}
      </ScrollView>
    </Screen>
  );
}

/**
 * 눈으로 보는 캡처 면: 같은 글을 전략마다 한 칸씩 쌓고, 칸 틀(옅은 배경)과 이름표를 붙인다.
 * 폭은 소식 상세의 글 폭(402pt 기기에서 338pt)이다. `-momoWrapSet`·`-momoWrapStrategies` 로 거른다.
 */
function VisualPage({which}: {which: string}): React.JSX.Element {
  const width = parseWidths(launchList('momoWrapWidths') ?? ['338'])[0] ?? 338;
  const strategies = (launchList('momoWrapStrategies') ?? ['hangul-word', 'standard', 'none', 'sentence']).filter(
    (s): s is Strategy => (ALL_STRATEGIES as string[]).includes(s),
  );
  const set = (launchList('momoWrapSet') ?? ['en'])[0];
  const cases = CASES.filter(c => c.set === set || c.id.startsWith(set)).slice(0, 4);
  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.visualBody} testID={`wrap-${which}`}>
        {cases.flatMap(c =>
          strategies.map(strategy => (
            <View key={`${c.id}|${strategy}`} style={styles.visualBlock}>
              <Text style={styles.visualLabel}>{`${c.id} · ${strategy} · ${width}pt`}</Text>
              <View style={[styles.visualFrame, {width}]}>
                <Cell cell={{c, strategy}} onFrame={() => {}} onLines={() => {}} />
              </View>
            </View>
          )),
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hud: {position: 'absolute', top: 54, left: 8, right: 8, zIndex: 10, backgroundColor: '#000000cc', padding: 4},
  hudText: {color: '#ffffff', fontSize: 11},
  body: {paddingTop: 80, paddingBottom: 40, gap: 6},
  cell: {alignSelf: 'flex-start'},
  text: {fontSize: font.body, lineHeight: line.body, color: '#222222'},
  visualBody: {paddingTop: 64, paddingHorizontal: 16, paddingBottom: 40, gap: 10},
  visualBlock: {gap: 2},
  visualLabel: {fontSize: 11, lineHeight: 14, color: '#666666'},
  visualFrame: {backgroundColor: '#e8e4dc'},
});
