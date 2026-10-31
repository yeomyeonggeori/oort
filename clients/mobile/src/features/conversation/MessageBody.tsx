import {useExpressionItems} from '../expressions/ExpressionProvider';
import {ExpressionImage} from '../expressions/ExpressionImage';
import {
  ExpressionText,
  ExpressionTextContext,
  prepareExpressionBody,
  useExpressionLiteral,
} from '../expressions/ExpressionText';
import {
  isPlainText,
  parseMarkdown,
  safeHref,
  type Block,
  type Inline,
} from '@momo/core/features/timeline/markdown';
import {
  memberFor,
  type Directory,
} from '@momo/core/features/workspace/directory';
import {mentionableNames} from '@momo/core/features/routing/helperAliases';
import React, {useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type TextLayoutEventData,
} from 'react-native';
import {font, line, radius, space, type Palette} from '../../design/tokens';
import {useBubbleChoice, usePalette, useStyles} from '../../design/theme';
import {bubbleFor} from './bubble';
import {COPY_RECEIPT_MS, copyText} from './copy';

// =============================================================================
// 메시지 본문 — 웹 `MessageBody.tsx` 의 RN 판 (goal U4-a / #1048, BL-1·BL-3).
//
// ## 무엇이 고장나 있었나
//
// 이 파일 이전의 폰은 본문을 이렇게 그렸다:
//
//   body.includes('```') ? <CodeBlock text={body} /> : <Text>{body}</Text>
//
// 두 갈래 다 결함이고, **앞엣것이 지배적**이다. 에이전트가 답 안에 코드 조각을
// 하나라도 넣으면 그 분기가 **답 전체를 코드 상자로 만든다** — 설명 문장까지
// 통째로 모노스페이스가 되어 가로 스크롤 상자 안에 들어간다. 사람이 읽으려던
// 산문이 로그처럼 보이고, 정작 코드는 그 안에서 구별되지 않는다.
//
// 뒤엣것은 「**결론**: 실패」를 별표까지 그대로 출력한다. 웹이 같은 결함을 두고
// 적어 둔 문장이 그대로 여기에도 해당한다: *"그것은 스타일 문제가 아니라 사람이
// 업무 채널 안에서 마크업을 눈으로 파싱해야 하는 것이다."*
//
// ## 파서는 코어의 것이다 — 여기서 한 글자도 해석하지 않는다
//
// `@momo/core/features/timeline/markdown` 이 정본이고, 이 파일은 그 트리를
// **그리기만** 한다. 새 파서도, 서드파티 마크다운 라이브러리도 없다(패킷 금지
// 조항이자 코어 머리말의 결정: 라이브러리는 신뢰해야 할 문자열과 신뢰해야 할
// 새니타이저를 함께 들여온다).
//
// 안전은 구조로 온다. 여기에는 HTML 이 없고 모든 잎이 RN `Text` 노드이므로
// `<img onerror=…>` 를 담은 본문은 그 글자들을 그대로 그린다. 공격자가 값을
// 넣을 수 있는 유일한 **속성**이 링크 대상이고, 그 값은 코어 `safeHref` 의
// 스킴 허용목록을 이미 통과한 것이다.
//
// ## 그래도 여는 자리에서 한 번 더 본다
//
// `Linking.openURL` 은 웹의 `<a href>` 와 성질이 다르다: iOS 는 기기가 핸들러를
// 가진 **모든** 스킴을 연다(`tel:`·`sms:`·설치된 앱의 커스텀 스킴). 그래서 누르는
// 순간 **코어의 같은 함수**로 한 번 더 확인한다. 두 번째 허용목록을 만드는 것이
// 아니다 — 판정하는 함수는 하나뿐이고, 이것은 그 함수를 두 번 부르는 것이다.
// 이 클라이언트가 「작성 중」에서 이미 고른 모양이기도 하다(서버가 403 으로 막아도
// 화면이 한 번 더 거른다).
// =============================================================================

/**
 * 「기울임」을 라틴 글자에만 건다.
 *
 * 웹은 이것을 CSS 한 줄로 한다 — `em-latin-only { font-style: italic;
 * font-synthesis-style: none; }`. 뜻은 **"기울임을 요청하되, 폰트에 진짜 이탤릭
 * 페이스가 없으면 만들어내지 말라"** 이고, 한글 폰트에는 이탤릭 페이스가 없으므로
 * 한글은 똑바로 선다. 저자가 긋지 않은 획을 기계가 그리지 않는다는 결정이다.
 *
 * RN 에는 `fontSynthesis` 가 없다. `fontStyle: 'italic'` 을 한글에 걸면 Core Text
 * 가 그대로 기울여 버리므로, 웹이 거부한 그 결과가 폰에서만 나온다. 그래서 같은
 * **결과**를 다른 기계로 만든다: 글자를 스크립트별로 끊어 라틴 구간에만 기울임을
 * 건다. 끊는 기준은 「이탤릭 페이스가 있을 만한 글자인가」 하나뿐이라 목록이
 * 자라지 않는다.
 */
const LATIN_ITALIC = /[A-Za-z0-9À-ɏ]/;

export function splitItalicRuns(
  text: string,
): {text: string; italic: boolean}[] {
  const runs: {text: string; italic: boolean}[] = [];
  for (const char of text) {
    // 공백은 앞 구간에 붙는다. 따로 떼면 「hello 세계」에서 공백 하나가 구간을
    // 셋으로 쪼개고, RN 이 구간마다 줄바꿈 기회를 주면서 글이 다르게 접힌다.
    const italic = LATIN_ITALIC.test(char);
    const last = runs[runs.length - 1];
    if (last !== undefined && (last.italic === italic || /\s/.test(char))) {
      last.text += char;
      continue;
    }
    runs.push({text: char, italic});
  }
  return runs;
}

/**
 * 링크 하나를 연다. **이 앱에서 밖으로 나가는 문은 이것 하나뿐이다.**
 *
 * 본문의 링크와 아티팩트 카드의 주소가 같은 함수를 지난다 — 둘 다 BL-3 이 지목한
 * 자리이고, 「눌리는가」와 「무엇을 열어도 되는가」를 두 벌로 두면 그 둘이 갈리는
 * 날이 온다.
 */
export function openLink(href: string): void {
  // 코어의 판정을 한 번 더. 여기서 null 이면 애초에 링크가 아니었어야 하는 값이다.
  const safe = safeHref(href);
  if (safe === null) return;
  void Linking.openURL(safe).catch(() => {
    // 열 수 있는 앱이 없다. 조용히 아무 일도 안 하는 것이 맞다 — 사람이 누른 것은
    // 링크이고, 실패한 것은 이 기기의 사정이며, 그 사정에 대해 이 행이 할 말은 없다.
  });
}

/**
 * 이 본문이 품고 있는 **행 안의 컨트롤들** (design-review H-1).
 *
 * 행은 접근성 원소 **하나**여야 한다(이 클라이언트가 웹에서 6→1 로 줄인 그
 * 규칙). 그런데 이번 배치가 행 안에 누를 것을 넷 더 넣었고 — 인용 점프·코드
 * 복사·본문 링크·아티팩트 주소 — 그중 셋은 **본문 안**에 있다. 손가락은 닿지만
 * VoiceOver 는 못 닿는 상태였다.
 *
 * 답은 「원소를 늘린다」가 아니라 **로터 액션으로 등재한다**이다. 그러려면 행이
 * 자기 본문에 무엇이 들었는지 알아야 하는데, 파싱은 이 파일 안에서 일어난다.
 * 그래서 파서를 한 번 더 도는 **순수 함수**를 내준다 — 행이 `useMemo(body)` 로
 * 부르고, 행 자체가 memo 되어 있으므로 이 비용은 프레임당이 아니라 **메시지당**
 * 이다.
 *
 * 링크가 여럿이면 **첫 개만** 로터에 올린다. 스무 개짜리 답에 액션 스무 개를
 * 얹으면 로터가 그 자체로 못 쓸 물건이 되고, 그것은 「하나의 원소」 규칙을 다른
 * 방식으로 깨는 것이다. 대신 라벨이 총 개수를 말한다 — 첫 개만 준다는 사실을
 * 숨기지 않는다.
 */
export interface BodyAffordances {
  firstLink: string | null;
  linkCount: number;
  firstCode: string | null;
  codeCount: number;
}

function walkInline(
  nodes: Inline[],
  out: {links: string[]},
): void {
  for (const node of nodes) {
    if (node.kind === 'link') out.links.push(node.href);
    if (node.kind === 'link' || node.kind === 'strong' || node.kind === 'em') {
      walkInline(node.children, out);
    }
  }
}

export function bodyAffordances(body: string): BodyAffordances {
  const empty: BodyAffordances = {
    firstLink: null,
    linkCount: 0,
    firstCode: null,
    codeCount: 0,
  };
  if (body === '' || isPlainText(body)) return empty;
  const out = {links: [] as string[]};
  const codes: string[] = [];
  for (const block of parseMarkdown(body)) {
    if (block.kind === 'code') {
      codes.push(block.text);
      continue;
    }
    if (block.kind === 'list') {
      for (const item of block.items) walkInline(item, out);
      continue;
    }
    for (const line of block.lines) walkInline(line, out);
  }
  return {
    firstLink: out.links[0] ?? null,
    linkCount: out.links.length,
    firstCode: codes[0] ?? null,
    codeCount: codes.length,
  };
}

/**
 * 멘션을 누르면 그 멤버의 프로필을 연다 (#4319, owner 10-27 — 프로필 문은 얼굴과 멘션뿐이다).
 * 길게 누르기와 그 뒤 따라 울리는 탭은 행의 제스처(`useLongPress`)가 받는다: 멘션이 시트를 여는 손가락을 가로채지 않는다.
 */
export interface MentionTap {
  onOpen: (memberId: string) => void;
  onLongPress?: () => void;
  consumeTap?: () => boolean;
}

interface MentionRendering {
  activeHandles: ReadonlySet<string>;
  selfHandle: string | null;
  /** 핸들(소문자) → 멤버 id. 모르면 `null` — 별칭처럼 멤버가 아닌 이름은 누를 수 없다. */
  memberIdOf: (handle: string) => string | null;
  tap: MentionTap | undefined;
}

const NO_MENTIONS: MentionRendering = {
  activeHandles: new Set<string>(),
  selfHandle: null,
  memberIdOf: () => null,
  tap: undefined,
};

/**
 * 말풍선 안에서 글자가 입는 잉크. 중첩 `Text` 는 색을 상속하지만 링크·멘션·인라인 코드는
 * 자기 색을 박고 있어(채움이 바닥 기준으로 정해진 값) 말풍선 채움 위에서 깨진다 — 그 셋만
 * 이 맥락을 읽어 말풍선 잉크로 갈아입는다. 말풍선 밖(`null`)은 예전 그대로다.
 */
/** 말풍선 안 인라인 코드 칩의 채움 — 말풍선 글자색 위 알파 18%(0x2e). */
const INLINE_CODE_ALPHA_HEX = '2e';
const BubbleInk = React.createContext<{fg: string; mine: boolean} | null>(null);

// =============================================================================
// 측정 seam (#4894) — 말풍선·문단이 **네이티브에서 실제로 받은 틀**을 하네스가 읽는 문.
//
// 「긴 글이 말풍선에서 잘린다」는 jest 로 못 잰다: jest 에는 Yoga 도 TextKit 도 없어 폭이 전부 0 이다.
// 재는 곳은 시뮬레이터이고, 잴 것은 세 숫자다 — 말풍선 틀, 그 안 글 상자 틀, 글 상자가 실제로 그린 줄들
// (`onTextLayout`). 하네스(`measure/bubbleClip.tsx`)가 이 Provider 로 함수를 꽂을 때만 보고한다.
// 앱에서는 값이 `null` 이라 핸들러가 **아예 붙지 않는다**(`probe === null` → 상수 빈 객체).
// =============================================================================
export interface ProbeFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}
/**
 * `key` 는 어느 말풍선·어느 문단인지다: 말풍선 `"<n>"`(코드 블록 앞뒤로 갈리면 n 이 는다), 그 안 문단 `"<n>.<블록>"`,
 * 목록 항목 `"<n>.<블록>.<항목>"`. 한 문단의 `text`(틀)와 `lines`(그린 줄)는 같은 key 로 짝지어 읽는다.
 */
export type BubbleProbeEvent =
  | {kind: 'bubble'; key: string; frame: ProbeFrame}
  | {kind: 'text'; key: string; frame: ProbeFrame}
  | {kind: 'lines'; key: string; lines: (ProbeFrame & {text: string})[]};
/** 두 번째 인자는 이 말풍선이 담은 **메시지 본문**이다 — 목록 한가운데서 한 Provider 가 여러 행의 보고를 받을 때(`dmConversation.tsx`) 행을 가리는 표지다. */
export type BubbleProbe = (event: BubbleProbeEvent, body: string) => void;
export const BubbleProbeContext = React.createContext<BubbleProbe | null>(null);

const NO_PROBE_PROPS = {} as const;

/** 문단 `Text` 에 펼치는 핸들러. 하네스가 없으면 상수 빈 객체라 앱의 Text 에는 아무것도 붙지 않는다. */
function paragraphProbeProps(
  probe: BubbleProbe | null,
  key: string,
  body: string,
): {
  onLayout?: (event: LayoutChangeEvent) => void;
  onTextLayout?: (event: NativeSyntheticEvent<TextLayoutEventData>) => void;
} {
  if (probe === null) return NO_PROBE_PROPS;
  return {
    onLayout: event => probe({kind: 'text', key, frame: event.nativeEvent.layout}, body),
    onTextLayout: event =>
      probe(
        {
          kind: 'lines',
          key,
          lines: event.nativeEvent.lines.map(({x, y, width, height, text}) => ({x, y, width, height, text})),
        },
        body,
      ),
  };
}

function InlineNodes({
  nodes,
  mentions,
}: {
  nodes: Inline[];
  mentions: MentionRendering;
}): React.JSX.Element {
  return (
    <>
      {nodes.map((node, index) => (
        <InlineNode key={index} node={node} mentions={mentions} />
      ))}
    </>
  );
}

function InlineNode({
  node,
  mentions,
}: {
  node: Inline;
  mentions: MentionRendering;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const ink = useContext(BubbleInk);
  const literal = useExpressionLiteral();
  if (node.kind === 'text') return <ExpressionText text={node.text} />;
  if (node.kind === 'strong') {
    return (
      <Text style={styles.strong}>
        <InlineNodes nodes={node.children} mentions={mentions} />
      </Text>
    );
  }
  if (node.kind === 'em') {
    return (
      <Text testID="message-em">
        <EmphasisNodes nodes={node.children} mentions={mentions} />
      </Text>
    );
  }
  if (node.kind === 'code') {
    return (
      <Text
        style={[
          styles.inlineCode,
          // 내 말풍선(신호색 채움) 위에서는 바닥 기준 채움이 안 읽힌다 — 같은 잉크의 옅은 막.
          ink?.mine && {backgroundColor: ink.fg + INLINE_CODE_ALPHA_HEX},
        ]}
        testID="message-inline-code">
        {literal(node.text)}
      </Text>
    );
  }
  if (node.kind === 'mention') {
    if (!mentions.activeHandles.has(node.handle)) return <>{node.raw}</>;
    const self = mentions.selfHandle === node.handle;
    const tap = mentions.tap;
    const openId = tap ? mentions.memberIdOf(node.handle) : null;
    return (
      <Text
        // 내 말풍선 위의 「나를 부름」 칩은 신호색 채움이 말풍선과 같아 사라진다 — 그때는 남의
        // 멘션과 같은 칩(옅은 채움)에 굵기로만 갈린다.
        style={[styles.mention, self && !ink?.mine && styles.mentionSelf, self && ink?.mine && styles.mentionSelfOnMine]}
        // 링크와 같은 문법이다: 행은 접근성 원소 하나이고 멘션은 그 문장 안의 낱말로 읽힌다. 멤버를 알 때만 눌린다.
        accessibilityRole={openId !== null ? 'link' : undefined}
        onPress={
          tap && openId !== null
            ? () => {
                // 길게 눌러 시트를 연 손가락을 떼면 따라 울리는 탭은 그 제스처의 것이다.
                if (tap.consumeTap?.()) return;
                tap.onOpen(openId);
              }
            : undefined
        }
        onLongPress={tap && openId !== null ? tap.onLongPress : undefined}
        testID={self ? 'message-self-mention' : 'message-mention'}>
        {node.raw}
      </Text>
    );
  }
  return (
    <Text
      accessibilityRole="link"
      // 링크 하나가 행의 탭 스톱을 하나 늘리지 않는다: 행은 접근성 원소 하나이고
      // (`MessageRow` 의 규칙), 링크는 그 문장 안의 낱말로 읽힌다. 누르는 것은
      // `onPress` 가 받는다.
      onPress={() => openLink(literal(node.href))}
      style={[styles.link, ink?.mine && {color: ink.fg}]}
      testID="message-link">
      <InlineNodes nodes={node.children} mentions={mentions} />
    </Text>
  );
}

/** `em` 안쪽. 텍스트 잎만 스크립트별로 끊고, 나머지는 그대로 내려간다. */
function EmphasisNodes({
  nodes,
  mentions,
}: {
  nodes: Inline[];
  mentions: MentionRendering;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <>
      {nodes.map((node, index) => {
        if (node.kind !== 'text') {
          return <InlineNode key={index} node={node} mentions={mentions} />;
        }
        return (
          <React.Fragment key={index}>
            {node.text
              .split(/(\uE000+\d+\uE001)/)
              .flatMap(part => /^\uE000/.test(part)
                ? [{text: part, italic: false}]
                : splitItalicRuns(part))
              .map((run, runIndex) => (
              <Text key={runIndex} style={run.italic ? styles.em : undefined}>
                <ExpressionText text={run.text} />
              </Text>
            ))}
          </React.Fragment>
        );
      })}
    </>
  );
}

/**
 * RN 은 `View` 를 통해 글자 색을 상속시키지 않는다 — 웹이 컨테이너 한 곳에
 * `text-ink-muted` 를 걸어 끝낸 자리가 여기서는 각 텍스트 컨테이너로 내려가야
 * 한다. **중첩된 `Text` 끼리는 상속되므로**(그래서 인라인 코드는 색을 안 박는다)
 * 내려보낼 자리는 문단·목록 두 곳뿐이다.
 */
/**
 * 코드 한 상자를 클립보드로.
 *
 * 상태를 자기가 든다(「복사됨」 한 순간). 부모에 올리면 코드 블록 하나가 바뀔
 * 때마다 본문 전체가 다시 그려지고, 그것은 이 배치가 계속 피해 온 전파다.
 */
function CodeCopyButton({text}: {text: string}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const [done, setDone] = useState(false);
  // 되돌리는 타이머. **끄는 자리가 필요하다** — 사람이 복사하고 바로 스크롤하면
  // 이 행은 가상화에서 빠지는데, 1.5초 뒤 타이머는 살아 있다. 그 자체로 큰 해는
  // 아니지만 타임라인에서 코드 블록은 흔하고, 끄지 않는 타이머가 흔한 컴포넌트에
  // 붙어 있는 것은 이 클라이언트가 「작성 중」에서 통째로 거부한 모양이다.
  // (제스트가 이것을 먼저 말해 줬다: "Jest did not exit one second after…".)
  const revertRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (revertRef.current !== null) clearTimeout(revertRef.current);
    },
    [],
  );
  const onPress = useCallback(() => {
    void copyText(text).then(ok => {
      if (!ok) return;
      setDone(true);
      // 한 순간의 영수증이다. 안 되돌리면 그 상자는 영원히 「복사됨」이라고
      // 말하는 상자가 된다.
      if (revertRef.current !== null) clearTimeout(revertRef.current);
      revertRef.current = setTimeout(() => setDone(false), COPY_RECEIPT_MS);
    });
  }, [text]);
  return (
    <Pressable
      accessibilityRole="button"
      // -----------------------------------------------------------------
      // 액션 이름은 `~기` 서술형이다 (design-review N-1).
      //
      // 이 규칙은 발명한 것이 아니라 **이미 이 앱을 지배하고 있던 것**이다:
      // 답글 달기 · 인용해서 답하기 · 메시지 복사하기 · 고치기 · 지우기 ·
      // 닫기 · 스레드 열기 · 링크 열기 · 다시 보내기 · 오류 닫기. 복사만
      // 두 형태로 갈라져 있었다 — 시트에서는 「메시지 복사하기」인데 코드
      // 상자에서는 「복사」, 로터에서는 「코드 복사」.
      //
      // **한 메시지 안에서 사람이 그 둘을 다 만난다.** 마크다운 답 하나에
      // 코드 상자가 있으면 시트의 「메시지 복사하기」와 상자의 「복사」가 같은
      // 화면에 있고, 이름이 다르면 다른 일이라고 읽는다.
      //
      // 영수증은 완료형 `~됨` 이다(복사됨 · 코드 복사됨) — 이미 일관적이라
      // 그대로 둔다. 이름과 영수증은 다른 종류의 문장이다.
      // -----------------------------------------------------------------
      accessibilityLabel={done ? '코드 복사됨' : '코드 복사하기'}
      // 24pt 의 시각 높이에 위아래 10pt 씩 — 엄지에게는 **44pt**, 레이아웃에는
      // 24pt (design-review M-9: 첫 판은 8pt 라 40pt 였다). 실제 높이를 44 로
      // 올리지 않는 이유는 반응 칩에서 이미 고른 거래와 같다: 코드 상자마다
      // 머리줄이 그만큼 두꺼워지고, 답 하나에 상자가 셋이면 화면 한 뼘이 사라진다.
      hitSlop={{top: 10, bottom: 10, left: 8, right: 8}}
      onPress={onPress}
      style={({pressed}) => [styles.codeCopy, pressed && styles.pressed]}
      testID="code-copy">
      <Text style={styles.codeCopyLabel}>{done ? '복사됨' : '복사하기'}</Text>
    </Pressable>
  );
}

function BlockNode({
  block,
  muted,
  selectable,
  mentions,
  probeKey,
  probeBody,
}: {
  block: Block;
  muted: boolean;
  selectable: boolean;
  mentions: MentionRendering;
  /** 측정 seam 의 문단 이름(`BubbleProbeEvent.key`)과 메시지 본문. 하네스가 없으면 쓰이지 않는다. */
  probeKey: string;
  probeBody: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const ink = useContext(BubbleInk);
  const probe = useContext(BubbleProbeContext);
  const literal = useExpressionLiteral();
  // 말풍선 안 글자는 말풍선 잉크다 — `muted` 보다 뒤에 놓여 이긴다(보내는 중 흐림은 말풍선이 진다).
  const inkStyle = ink ? {color: ink.fg} : null;
  if (block.kind === 'code') {
    return (
      <View style={styles.codeWrap} testID="message-code-block">
        {/* 머리줄: 언어 라벨(왼쪽)과 복사(오른쪽). */}
        <View style={styles.codeHead}>
          {block.lang ? (
            // 언어 라벨. 웹은 이것을 `data-lang` 과 `aria-label` 로만 들고 있지만
            // 폰에는 hover 도 개발자도구도 없으므로 보이게 적는다 — 그리고 그것이
            // 「이 상자는 코드다」를 말하는 가장 싼 방법이다.
            <Text style={styles.codeLang} testID="message-code-lang">
              {literal(block.lang)}
            </Text>
          ) : (
            <View />
          )}
          {/* 코드 블록만 자기 복사를 갖는다 (H-9). 시트의 「메시지 복사」는 답
              전체를 주는데, 사람이 터미널에 붙여 넣으려는 것은 **이 상자 안의
              것**이고 그 둘은 다르다 — 답 전체를 붙이면 산문까지 따라간다.
              펜스 마커도 안 들어간다: 붙여 넣을 곳은 마크다운을 모른다. */}
          <CodeCopyButton text={literal(block.text)} />
        </View>
        <ScrollView
          horizontal
          // 가로로 끌리는 것이 이 상자의 일이다. 긴 로그 한 줄이 대화 전체를
          // 옆으로 끌고 가면 안 되므로, 스크롤은 여기서 끝난다.
          style={styles.codeScroll}
          contentContainerStyle={styles.codeContent}
          showsHorizontalScrollIndicator>
          <Text
            selectable={selectable}
            style={[styles.code, muted && styles.muted]}>
            {literal(block.text)}
          </Text>
        </ScrollView>
      </View>
    );
  }

  if (block.kind === 'list') {
    return (
      <View style={styles.list} testID="message-list">
        {block.items.map((item, index) => (
          <View key={index} style={styles.listItem}>
            {/* 마커가 자기 칸을 갖는다(웹의 `list-outside`). 같은 `Text` 안에
                넣으면 접힌 한글 둘째 줄이 마커 **밑**에서 시작해, 항목 경계가
                눈으로 사라진다. */}
            {block.ordered ? (
              <Text style={[styles.listMarker, muted && styles.muted, inkStyle]}>
                {`${block.start + index}.`}
              </Text>
            ) : (
              // 불릿은 **글자가 아니라 도형**이다 (design-review M-4).
              //
              // 칸을 좁히는 것(`minWidth: 18 → 10`)만으로 빈칸은 17.0pt →
              // 10.0pt 가 됐다(실측). 남은 것은 칸이 아니라 **글리프**였다:
              // `'•'` 의 잉크는 자기 advance 안에서 2.0~4.7pt 에 앉는다 — 폭도
              // 위치도 서체가 정하고, 우리는 그것을 못 고른다. 게다가 줄의
              // 세로 중심이 아니라 **베이스라인**에 선다(22pt 행간에서 눈에
              // 띈다).
              //
              // 도형으로 그리면 셋 다 우리 값이 된다: 점 4pt, 칸 10pt 안의
              // 정중앙, 세로도 중앙. 사진에서 빈칸 **8.0pt**.
              //
              // (첫 판정은 「서체가 전각으로 준다」였는데 **그건 틀렸다** —
              // 캡처를 2x 로 환산해서 나온 오독이었다. 이 기기는 3x 다.)
              <View style={styles.listBulletCell} testID="list-bullet">
                <View
                  style={[
                    styles.listBulletDot,
                    muted && styles.listBulletDotMuted,
                    ink && {backgroundColor: ink.fg},
                  ]}
                />
              </View>
            )}
            <Text
              selectable={selectable}
              style={[styles.listText, muted && styles.muted, inkStyle]}
              {...paragraphProbeProps(probe, `${probeKey}.${index}`, probeBody)}>
              <InlineNodes nodes={item} mentions={mentions} />
            </Text>
          </View>
        ))}
      </View>
    );
  }

  return (
    <Text
      selectable={selectable}
      style={[styles.paragraph, muted && styles.muted, inkStyle]}
      {...paragraphProbeProps(probe, probeKey, probeBody)}>
      {block.lines.map((line, index) => (
        <React.Fragment key={index}>
          {index > 0 ? '\n' : null}
          <InlineNodes nodes={line} mentions={mentions} />
        </React.Fragment>
      ))}
    </Text>
  );
}

/**
 * 한 메시지의 본문.
 *
 * `muted` 는 보내는 중인 메아리의 유일한 차이다 — 같은 해부, 흐린 색. 서버 사본이
 * 이 행을 대체할 때 글이 다시 흐르면 안 되므로 모양은 하나뿐이다.
 *
 * ## 평문 경로는 예전 그대로다
 *
 * 마크업이 없는 본문은 **예전과 같은 `Text` 하나**로 그려진다. 이 타임라인의
 * 대부분이 그런 메시지이므로, 그 자리에서 밀도가 바뀌면 이 배치는 고친 것보다
 * 많은 것을 바꾼 셈이 된다. `isPlainText` 가 그 갈림을 판정하고, 그것도 코어의
 * 함수다.
 */
export function MessageBody({
  body,
  muted = false,
  selectable = false,
  directory,
  selfMemberId,
  bubble = null,
  mentionTap,
}: {
  body: string;
  /**
   * 말풍선 (#4300). `'mine'`·`'other'` 면 **산문**(문단·목록)을 그 사람의 말풍선에 담고,
   * 코드 블록은 말풍선 밖 **전체 폭**에 둔다(에이전트 출력은 넓게 — 긴 로그 한 줄이 말풍선을
   * 늘리지 않는다). `null`(기본)이나 외양 토큰 `bubble.layout === 'row'` 면 예전 평면 행이다.
   */
  bubble?: 'mine' | 'other' | null;
  muted?: boolean;
  /** Active roster members are the authority for whether a token is a mention. */
  directory?: Directory;
  /** Current member, used only for the stronger self-mention treatment. */
  selfMemberId?: string;
  /**
   * 본문 텍스트를 손가락으로 고를 수 있나.
   *
   * iOS 의 텍스트 선택은 그 자체가 길게 누르기라 메시지 액션 시트와 같은 제스처를
   * 다툰다. 그 판정은 행이 들고 있으므로(행만이 자기에게 시트가 있는지 안다)
   * 여기서는 받기만 한다.
   *
   * **마크다운 경로에도 내려간다** (design-review M-1). 첫 판은 평문 경로에만
   * 걸어서, 마크다운을 담은 낙관적 메아리(시트가 없는 행 — 그래서 선택이 텍스트를
   * 꺼내는 **유일한** 길인 행)에서 그 길이 사라졌다. BL-2 의 잔여였다.
   */
  selectable?: boolean;
  /** 주면 멘션이 그 멤버의 프로필로 가는 문이 된다(#4319). 안 주면 멘션은 예전처럼 글자 스타일뿐이다. */
  mentionTap?: MentionTap;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const expressions = useExpressionItems();
  const expressionBody = useMemo(
    () => prepareExpressionBody(body, expressions),
    [body, expressions],
  );
  const blocks = useMemo(
    () => (isPlainText(expressionBody.markdown) ? null : parseMarkdown(expressionBody.markdown)),
    [expressionBody.markdown],
  );
  const palette = usePalette();
  const probe = useContext(BubbleProbeContext);
  const bubbleChoice = useBubbleChoice();
  // 개인 덮어쓰기(#4383): 줄 보기(`layout: 'row'`)·색·모서리. 대비가 모자란 색은 `bubbleFor` 가 버린다.
  const tokens = useMemo(() => bubbleFor(palette, bubbleChoice), [palette, bubbleChoice]);
  const tone = bubble !== null && tokens.layout === 'bubble' ? tokens[bubble] : null;
  const ink = useMemo(
    () => (tone !== null && bubble !== null ? {fg: tone.fg, mine: bubble === 'mine'} : null),
    [tone, bubble],
  );
  const wrapProse = (children: React.ReactNode, key?: number): React.JSX.Element =>
    tone === null ? (
      <React.Fragment key={key}>{children}</React.Fragment>
    ) : (
      <View
        key={key}
        testID="message-bubble"
        onLayout={
          probe === null
            ? undefined
            : event => probe({kind: 'bubble', key: String(key ?? 0), frame: event.nativeEvent.layout}, body)
        }
        style={[
          styles.bubble,
          {
            backgroundColor: tone.bg,
            borderRadius: tokens.radius,
            paddingHorizontal: tokens.padX,
            paddingVertical: tokens.padY,
          },
          // 보내는 중 흐림은 글자색이 아니라 말풍선 전체의 막이다(채움 위 잉크 대비를 지킨다).
          muted && styles.bubbleMuted,
        ]}>
        {children}
      </View>
    );
  const mentions = useMemo<MentionRendering>(() => {
    // Keep the pre-markdown path cheap: ordinary prose neither walks the
    // directory nor changes its rendered shape just because this prop exists.
    if (blocks === null || directory === undefined) return NO_MENTIONS;
    // 핸들 + 서버가 등록한 ASCII 별칭(ADR-0201 v2 H2). 웹과 같은 코어 함수다.
    const activeHandles = mentionableNames(directory.members);
    const self = memberFor(directory, selfMemberId);
    return {
      activeHandles,
      selfHandle: self?.handle.toLowerCase() ?? null,
      memberIdOf: handle =>
        directory.members.find(candidate => candidate.handle.toLowerCase() === handle)?.id ?? null,
      tap: mentionTap,
    };
  }, [blocks, directory, selfMemberId, mentionTap]);

  if (expressionBody.replacements.size > 0 && expressionBody.size !== 'inline') {
    return (
      <View style={styles.expressionRow} testID={`expression-body-${expressionBody.size}`}>
        {expressionBody.tokens.map((token, index) => token.type === 'expression'
          ? <ExpressionImage key={index} expression={token.expression} size={expressionBody.size} />
          : null)}
      </View>
    );
  }

  if (blocks === null || blocks.length === 0) {
    return (
      <ExpressionTextContext.Provider value={expressionBody.replacements}>
      <BubbleInk.Provider value={ink}>
        {wrapProse(
          <Text
            style={[styles.paragraph, muted && styles.muted, ink && {color: ink.fg}]}
            selectable={selectable}
            {...paragraphProbeProps(probe, '0.0', body)}>
            <ExpressionText text={expressionBody.markdown} />
          </Text>,
        )}
      </BubbleInk.Provider>
      </ExpressionTextContext.Provider>
    );
  }

  if (tone === null) {
    return (
      <ExpressionTextContext.Provider value={expressionBody.replacements}>
      <View style={styles.markdown} testID="message-markdown">
        {blocks.map((block, index) => (
          <BlockNode
            key={index}
            block={block}
            muted={muted}
            selectable={selectable}
            mentions={mentions}
            probeKey={`0.${index}`}
            probeBody={body}
          />
        ))}
      </View>
      </ExpressionTextContext.Provider>
    );
  }

  // 산문 블록은 이어진 것끼리 한 말풍선에, 코드 블록은 말풍선 밖에서 끊는다.
  const nodes: React.JSX.Element[] = [];
  let run: React.JSX.Element[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    nodes.push(
      wrapProse(<View style={styles.markdown}>{run}</View>, nodes.length),
    );
    run = [];
  };
  blocks.forEach((block, index) => {
    const node = (
      <BlockNode
        key={index}
        block={block}
        muted={muted}
        selectable={selectable}
        mentions={mentions}
        // 이 블록이 앉을 말풍선의 이름: 코드 블록이나 앞 말풍선이 `nodes` 에 이미 들어간 만큼이다.
        probeKey={`${nodes.length}.${index}`}
        probeBody={body}
      />
    );
    if (block.kind === 'code') {
      flush();
      nodes.push(<React.Fragment key={`c${index}`}>{node}</React.Fragment>);
    } else {
      run.push(node);
    }
  });
  flush();

  return (
    <ExpressionTextContext.Provider value={expressionBody.replacements}>
    <BubbleInk.Provider value={ink}>
      <View style={styles.markdown} testID="message-markdown">
        {nodes}
      </View>
    </BubbleInk.Provider>
    </ExpressionTextContext.Provider>
  );
}

const buildStyles = (color: Palette) => StyleSheet.create({
  expressionRow: {flexDirection: 'row', flexWrap: 'wrap', gap: space.xs},
  markdown: {gap: space.sm},
  // 말풍선은 내용 폭까지만 — 짧은 글(「네네」)은 좁다. 가장 넓어도 행 칸(본문 열)을 넘지 않는다.
  bubble: {alignSelf: 'flex-start', maxWidth: '100%'},
  bubbleMuted: {opacity: 0.6},
  paragraph: {fontSize: font.body, color: color.text, lineHeight: line.body},
  muted: {color: color.textMuted},
  strong: {fontWeight: '700'},
  em: {fontStyle: 'italic'},
  // 인라인 코드와 코드 블록은 한 얼굴을 쓴다: 인용된 글자이지 카드가 아니다.
  // 색을 따로 박지 않는다 — **상속**되어야 보내는 중인 행의 흐린 색이 그 안의
  // 코드까지 닿는다(웹이 같은 이유로 색을 뺐다).
  inlineCode: {
    fontFamily: 'Menlo',
    fontSize: font.label,
    backgroundColor: color.surfacePressed,
  },
  link: {color: color.accentText, textDecorationLine: 'underline'},
  /**
   * 멘션 칩 — 시안 `.a-mention{color:var(--accentText);background:var(--accentSoft);
   * border-radius:6px;padding:0 4px;font-weight:600}` (DS2-4, 이슈 Goal 「멘션 칩
   * signal-soft」). 옛 판은 남의 멘션을 글자색만, 내 멘션만 채움으로 그렸다.
   *
   * 반경과 좌우 4 는 **없다**: 폰의 글 안 조각(중첩 `Text`)은 배경은 칠하지만
   * 모서리·여백을 받지 않는다(PR 「시안과의 차이」). 내 멘션은 신호색 채움 +
   * on-signal 글자 + 굵기로 여전히 갈린다 — 「나를 불렀다」는 남의 멘션과 같은 옷이면
   * 안 된다. 한 단 진한 soft 채움(accentSurfaceStrong)은 라이트에서 3.8:1 이라
   * 본문 AA 를 못 지나 버렸다(`conversationDs2.test.tsx` 대비 절).
   */
  mention: {
    color: color.accentText,
    backgroundColor: color.accentSurface,
    fontWeight: '600',
  },
  mentionSelfOnMine: {fontWeight: '700'},
  mentionSelf: {
    color: color.onAccent,
    backgroundColor: color.accent,
    fontWeight: '700',
  },
  // N-1: `#0b0d11` 은 토큰이 아니었고 **앱 배경보다 더 어두웠다**. 웹은 반대
  // 방향으로 한 단 **올린다**(`bg-surface-hover`) — 코드 상자는 파묻히는 것이
  // 아니라 떠 있는 것이다. 폰의 그 한 단이 `surface` 이고, 이 파일의 카드들이
  // 이미 쓰는 값이다.
  codeWrap: {
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
    overflow: 'hidden',
  },
  codeHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: space.sm,
    paddingRight: space.xs,
    paddingTop: space.xs,
  },
  codeLang: {fontSize: font.meta, color: color.textFaint},
  // 44pt 는 `hitSlop` 으로 만든다 — 실제 높이를 44 로 올리면 코드 상자마다 머리줄이
  // 그만큼 두꺼워지고, 답 하나에 상자가 셋이면 화면 한 뼘이 사라진다.
  codeCopy: {minHeight: 24, justifyContent: 'center', paddingHorizontal: space.sm},
  codeCopyLabel: {fontSize: font.meta, color: color.textMuted, fontWeight: '600'},
  pressed: {opacity: 0.6},
  codeScroll: {},
  codeContent: {padding: space.sm},
  // ===========================================================================
  // 색을 박지 않는다 (design-review H-4).
  //
  // 첫 판은 `color: textMuted` 를 박았는데, 그 값이 **`muted` 와 같은 값**이었다
  // — 즉 확정된 코드 블록과 「보내는 중」 본문이 같은 잉크였다. 그리고 낙관적
  // 메아리가 흐려질 때 그 안의 코드만 안 흐려졌다: 자기 상태에 대해 두 가지를
  // 말하는 행이다.
  //
  // 같은 파일이 인라인 코드에 대해 이미 그 규칙을 적어 뒀는데(「색을 따로 박지
  // 않는다 — 상속되어야 …」) 블록이 그것을 깨고 있었다. 웹도 `CODE_CLASS` 에
  // 색이 없고 같은 문장을 적어 뒀다.
  //
  // RN 은 `View` 를 통해 색을 상속시키지 않으므로 「안 박는다」가 곧 「부모를
  // 따라간다」가 아니다 — 그래서 `muted` 를 명시적으로 내려보낸다(이 파일이
  // 문단·목록에서 이미 하는 것과 같은 배선). 기본은 본문과 **같은 잉크**다:
  // 사람이 꺼내러 온 것(명령어·해시·경로)이 산문보다 한 급 아래일 이유가 없다.
  // ===========================================================================
  code: {fontFamily: 'Menlo', fontSize: font.meta, color: color.text, lineHeight: line.code},
  list: {gap: space.xs},
  listItem: {flexDirection: 'row', gap: space.xs},
  // ===========================================================================
  // 마커 칸 (design-review M-4)
  //
  // 첫 판은 불릿과 숫자에 **같은 칸**(`minWidth: 18`)을 줬다. 그 하나의 값은 둘
  // 다에게 틀렸다:
  //
  // - 불릿 `•` 는 1.5 글자쯤 되는 칸 안에서 왼쪽에 붙고, 글머리와 본문 사이가
  //   이유 없이 벌어진다.
  // - 숫자는 `1.` 과 `10.` 의 폭이 다른데 왼쪽 정렬이라 **마침표가 어긋난다** —
  //   9번과 10번 사이에서 본문 시작점이 한 글자씩 밀린다.
  //
  // 그래서 칸을 가른다. 불릿은 글자 하나만큼, 숫자는 두 자리 + 마침표만큼 잡고
  // **오른쪽 정렬**한다(마침표가 한 줄에 선다 = 본문 시작점이 한 줄에 선다).
  // ===========================================================================
  listMarker: {
    fontSize: font.body,
    lineHeight: line.body,
    color: color.textMuted,
    // 두 자리 + 마침표만큼. **오른쪽 정렬**이라 마침표가 한 줄에 서고, 그래서
    // 9번과 10번의 본문 시작점도 한 줄에 선다.
    minWidth: 22,
    textAlign: 'right',
  },
  // 불릿 칸. 글자가 아니라 도형이므로 폭이 서체와 무관하다.
  listBulletCell: {width: 10, height: 22, alignItems: 'center', justifyContent: 'center'},
  listBulletDot: {width: 4, height: 4, borderRadius: 2, backgroundColor: color.textMuted},
  listBulletDotMuted: {backgroundColor: color.textFaint},
  // ===========================================================================
  // 목록 글은 `flex: 1` 이 아니라 `flexShrink: 1` 이다 (#4894).
  //
  // 말풍선은 **내용 폭**(`alignSelf: 'flex-start'` + `maxWidth: '100%'`)이고, 그 안쪽 폭은 자식들의 자연 폭 중 가장 넓은
  // 것이다. `flex: 1` 은 `flexBasis: 0` 이라 자연 폭에 **0 을 낸다** — 목록 글은 말풍선 폭에 아무 몫도 못 하고, 폭은
  // 다른 형제(앞 문단)나 마커 칸만으로 정해졌다. 시뮬레이터에서 잰 결과(수리 전, 폭 375~430 모두):
  //
  //   - 목록만 있는 글: 말풍선 폭 38pt(= 안쪽 여백 24 + 불릿 칸 14), 글 상자 폭 0pt — 글이 **아예 안 보인다**.
  //   - 문단 + 목록: 말풍선이 문단 폭(115pt)으로 접히고, 목록 글은 그 77pt 에서 줄바꿈하는데 말풍선 높이(170pt)는
  //     넓은 폭으로 쟀던 첫 판의 값이라, 글 높이 합 345pt 가 **말풍선 아래로 넘쳐 다음 행을 덮는다**.
  //
  // `flexShrink: 1` 은 자연 폭(`AtMost` 로 잰 줄바꿈 폭)을 몫으로 내고, 모자랄 때만 줄어든다. 줄어든 폭에서의 높이는
  // 가로줄의 교차축이라 마지막 판에서 다시 재어지므로, 말풍선 폭과 글 높이가 같은 폭을 본다.
  // ===========================================================================
  listText: {flexShrink: 1, fontSize: font.body, color: color.text, lineHeight: line.body},
});
