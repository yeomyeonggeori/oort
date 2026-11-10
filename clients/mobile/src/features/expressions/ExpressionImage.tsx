import type {Expression} from '@momo/core/features/expressions/types';
import {
  expressionAltText,
  expressionToken,
} from '@momo/core/features/expressions/message';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  AppState,
  Image,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import {useStyles} from '../../design/theme';
import {font, line, radius, space, type Palette} from '../../design/tokens';
import {useReduceMotion} from '../../lib/useReduceMotion';
import {
  EXPRESSION_REPEATS,
  expressionBoxOf,
  expressionVariantFor,
  isAnimatedMedia,
  keepsMoving,
  nameOf,
  type PhoneExpressionSize,
} from './expressionBox';
import {useExpressions} from './ExpressionProvider';
import {IMAGE_MISS} from './store';
import {useExpressionMessages} from './useExpressionMessages';

export type {PhoneExpressionSize} from './expressionBox';

// =============================================================================
// 한 표현의 그림 (#5451). 대화 줄의 큰 이모티콘·GIF·인라인·반응 칩과 표현 고르개의 칸이 모두 이 부품이다.
//
// 「높이가 바뀌지 않는다」가 이 부품의 계약이다. 앞 판은 받는 중·변형이 바뀌는 사이에 칸을 0x0 + 글자 `:이름:` 으로 접었다가 폈다
// (`ready` 가 거짓인 동안). 대화에 들어올 때마다 이모티콘 줄이 160pt → 글자 한 줄 → 160pt 로 뛰었고(변형이 thumb → large 로 바뀔 때마다),
// 눌렀을 때도 정지 그림까지 키(`key`)가 바뀌어 다시 마운트되며 사라졌다 돌아왔다. 지금은:
//
//   1. **칸은 그림이 정해지면 바뀌지 않는다.** 크기 표(ADR-0218 D1)의 점 수와 등록의 비율(`expressionBoxOf`)로 첫 프레임부터 선다.
//      받는 중에는 빈 칸이다(글자를 세우지 않는다). 글자 `:이름:` 은 이 표현을 지금 쓸 수 없을 때(숨김·삭제·못 받음)만 선다.
//   2. **그림은 앞 것을 둔 채 새것을 위에 얹는다.** 변형이 바뀔 때(thumb → large, 4번 돈 뒤 large → thumb, 눌러서 다시 재생)
//      새 그림이 그려지고(`onLoad`) 난 뒤에야 앞 그림을 걷는다 — 빈 프레임이 없다.
//   3. **정지 그림은 눌러도 아무 일도 없다.** 누름을 받지 않으니 부모 줄이 받는다(다시 마운트·깜빡임·이동 없음).
//   4. **움직이는 그림을 누르면 첫 장면부터 다시 돈다.** 이미 받은 파일을 새 층으로 얹을 뿐이다(`store.image` 는 받은 파일을 돌려준다) —
//      다시 재생에 네트워크가 없다.
//
// ADR-0218 의 약속은 그대로다: 움직임은 총 `EXPRESSION_REPEATS` 번 뒤 정지하고 탭으로 다시 시작한다. 고르개의 칸(`grid`·`tile`)·화면 밖·동작 줄이기·
// 앱이 뒤에 있는 동안은 정지 thumb 이다. **반응 칩(`reaction`)만 예외**다(#5504, owner 2026-11-07 「계속 움직임」, ADR-0218 증보 §13): 4번 뒤에도 멈추지 않는다 -
// 다만 동작 줄이기·화면 밖·앱이 뒤에 있는 동안은 같은 정지 thumb 이다.
// =============================================================================

/** 그려지는 층 하나. 같은 변형·같은 그림이면 키가 같다(`play` 는 다시 재생할 때만 오른다). */
interface Layer {
  key: string;
  uri: string;
  /** 움직이는 변형인가 — 이 층이 그려지기 시작하면 정지 시계를 건다. */
  moving: boolean;
}

/** 새 층을 얹는다: 이미 그려진 층(맨 앞)은 두고, 아직 못 그린 옛 후보는 버린다. */
function addLayer(layers: Layer[], layer: Layer): Layer[] {
  if (layers.some(candidate => candidate.key === layer.key)) return layers;
  return layers.length === 0 ? [layer] : [layers[0], layer];
}

/** 층은 칸 안에 포개 선다 — 크기는 칸(`box`)이 정한다. */
const LAYER = StyleSheet.absoluteFill;
/** 알림 뒤 목록이 적용되기 전에 그리는 층: 없다(칸만 선다). */
const NO_LAYERS: Layer[] = [];

/** 받기에 실패한 그림. `transient` 면 같은 크기 칸으로 기다렸다 다시 받고, 아니면(정말로 깨짐) 글자로 내린다. `exhausted` 는 다시 받기를 다 쓴 지나가는 실패다. */
interface Failed {
  key: string;
  transient: boolean;
  exhausted: boolean;
}
/** 지나가는 실패 뒤 다시 받기까지 기다리는 시간: 1.5초부터 두 배씩(웹 #5575 와 같은 사다리), 30초에서 멈춘다. */
const RETRY_FIRST_MS = 1_500;
const RETRY_MAX_MS = 30_000;
/** 스스로 다시 받는 횟수의 끝(웹 #5575 M2): 1.5 · 3 · 6초 뒤 세 번. 서버가 같은 그림에 계속 5xx 를 내는 영구 실패가 끝없는 받기가 되지 않게 한다. */
const RETRY_LIMIT = 3;
/**
 * 빈 칸이 이만큼 이어지면 칸 안에 이름을 세운다(#5627, 웹 #5575 M1 과 같은 값). 첫 자동 재시도(1.5초)가 한 번 돌고 그 받기가 끝날 시간이라, 보내기
 * 게이트의 짧은 흔들림(오프라인 ↔ 온라인 1~2초)에는 이름이 깜빡이지 않고, 정말로 오래 못 받는 동안에는 3초 안에 「무슨 이모티콘이었는지」가 보인다.
 * 다시 받기를 다 쓴 실패(`exhausted`)는 기다리지 않고 곧바로 세운다(M2).
 */
const LABEL_DELAY_MS = 2 * RETRY_FIRST_MS;
/**
 * 칸 안 이름 글자가 서는 칸과 그 줄 수(웹 `LABEL_FIT` 과 같은 규칙). 큰 칸은 한 줄로 자르고(끝 말줄임), 중간 칸과 시트의 큰 칸(`tile`)은 두 줄까지 —
 * 이름은 띄어쓰기 없는 한 낱말이라 줄에 안 들어가면 글자 단위로 끊긴다(웹 `break-all`). 여기 없는 칸(반응 칩 20 · 글 사이 · 고르개 32)은 글자 두세 개도
 * 안 들어가 이름이 잘린 조각이 되므로 같은 칸에 정지 자리표시(옅은 그릇 + 짙은 테두리)만 세우고, 이름은 읽기 도우미 이름이 진다(웹은 `title`).
 */
const LABEL_LINES: Partial<Record<PhoneExpressionSize, number>> = {large: 1, medium: 2, tile: 2};
/** 스타일의 낱말 값도 표의 키에서 꺼낸다 — 이 파일에 낱말 글자를 새로 쓰면 직접 문구 장부가 는다(`expressionBox.ts` 머리말). */
const WORD = nameOf<'center' | 'hidden'>({center: 0, hidden: 0});
/** 칸 안 이름 글자의 시험 표지. #5585 시험의 「칸 안 이름 표지는 세지 않는다」 거르개가 이 앞머리를 본다. */
const labelMark = (name: string, size: PhoneExpressionSize) => `expression-label-${name}-${size}`;
/** 칸 높이에 온전히 들어가는 줄 수: 글자 배율이 크면 두 줄 칸도 한 줄이 된다(반쯤 잘린 줄을 세우지 않는다). 적어도 한 줄. */
const fitLines = (most: number, height: number, fontScale: number) =>
  Math.max(1, Math.min(most, Math.floor(height / (line.meta * fontScale))));

/** Animated files never enter the picker grid/tile or an offscreen/reduced-motion cell. */
export function ExpressionImage({
  expression,
  size,
  visible,
}: {
  expression: Expression;
  size: PhoneExpressionSize;
  visible?: boolean;
}) {
  const {store, shelf, state, changePending} = useExpressions();
  const styles = useStyles(buildStyles);
  const formatMessage = useExpressionMessages();
  const {
    fontScale,
    height: windowHeight,
    width: windowWidth,
  } = useWindowDimensions();
  const reduceMotion = useReduceMotion();
  const native = useRef<View>(null);
  // 고르개의 칸(`grid`·`tile`)은 늘 정지 그림이다 — 움직이는 것은 미리보기와 대화의 줄만.
  const still = size === 'grid' || size === 'tile';
  const [onScreen, setOnScreen] = useState(still);
  const [foreground, setForeground] = useState(
    AppState.currentState === 'active',
  );
  const [stopped, setStopped] = useState(false);
  const [play, setPlay] = useState(0);
  const [seen, setSeen] = useState(still);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [failed, setFailed] = useState<Failed | null>(null);
  // 지나가는 실패 뒤 다시 받은 횟수와, 다시 받기를 부르는 수(오를 때마다 아래 효과가 같은 그림을 다시 묻는다).
  const retries = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const layersRef = useRef(layers);
  layersRef.current = layers;
  // 그리기(칸·토큰)는 보관함(`shelf`)을 따른다 — 처음 읽는 동안에도 칸이 서고, 그림 파일은 목록이 확인된 뒤(`state === 'ready'`)에 받는다.
  const live = shelf.find(
    item =>
      item.id === expression.id &&
      item.name === expression.name &&
      item.status === 'active',
  );
  // 목록에 있고(`live`) 그림 정보(`media`)가 있어야 쓸 수 있다. 정보가 없는 등록은 글자로 내린다(아래).
  const media = (live ?? expression).media;
  const isLive = live !== undefined && media !== null;
  const animated = media !== null && isAnimatedMedia(media);
  // 반응 칩의 움직이는 그림은 4번 돌고 멈추지 않고 계속 돈다(owner 2026-11-07, ADR-0218 증보 §13). 서버 GIF 의 반복 횟수는 4번이라 타이머만 빼서는 iOS 도 마지막 장면에서 멈추므로
  // 반응 칩은 반복 횟수만 무한으로 바꾼 파일을 그린다(`store.image(…, loop)`). 동작 줄이기·화면 밖·앱이 뒤에 있는 동안은 아래 `animate` 가 그대로 정지 thumb 다.
  const endless = keepsMoving(size);
  const showing = visible ?? onScreen;
  const animate =
    animated && !still && showing && foreground && !reduceMotion && !stopped;
  const variant = expressionVariantFor({
    size,
    still,
    animated,
    animate,
    seen,
  });
  const rendition = media?.[variant];
  const moving = animated && variant !== 'thumb';
  const targetKey = `${variant}/${rendition?.sha256 ?? ''}/${play}`;
  // 칸은 그림이 정해지면 바뀌지 않는다: 어느 변형을 그리든, 받았든 못 받았든 같다(`expressionBoxOf`).
  const box =
    media === null
      ? null
      : expressionBoxOf(size, media, font.body * fontScale);

  useEffect(() => {
    if (showing) setSeen(true);
  }, [showing]);
  useEffect(() => {
    if (still) return;
    const check = () =>
      native.current?.measureInWindow?.((x, y, w, h) => {
        setOnScreen(
          w > 0 &&
            h > 0 &&
            y + h > 0 &&
            y < windowHeight &&
            x + w > 0 &&
            x < windowWidth,
        );
      });
    check();
    const timer = setInterval(check, 500);
    const subscription = AppState.addEventListener('change', next =>
      setForeground(next === 'active'),
    );
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [still, windowHeight, windowWidth]);

  const storeReady = state === 'ready';
  // 숨김·삭제 알림이 왔고 그 뒤 목록이 아직 적용되지 않았다(#5473): 어느 등록이 숨겨졌는지 모르는 동안은 그림 층을 그리지 않고 칸만 둔다.
  const held = changePending === true;
  // 지금 그림 바이트를 그리지 않는다: 알림 뒤(`held`)와, 확인된 목록이 없는 동안(읽는 중·오프라인·목록 읽기 오류 — ADR-0218 D3 「offline에서는 문자열/정지
  // 자리표시만」). 칸은 그대로 선다(같은 크기의 정지 자리표시, #5585): 앞 판은 오프라인·오류에서 글자로 내려 대화 높이가 바뀌었다. 저장소는 이때 세션의
  // 임시 파일을 지우므로, 층을 남기면 지워진 파일을 가리킨다.
  const closed = held || !storeReady;
  useEffect(() => {
    if (!store) return undefined;
    if (!isLive) {
      // 목록에서 빠졌다(숨김·삭제·세션 끝): 그렸던 층·실패·재생 시계를 버린다. 걷힌 파일 주소를 그린 층이 남지 않고, 다시 쓸 수 있게 되면 새로 받아 선다.
      setLayers(previous => (previous.length === 0 ? previous : []));
      setFailed(null);
      setPlayingKey(null);
      return undefined;
    }
    if (closed) {
      // 걷힌 파일을 가리키던 층·재생 시계를 버린다. 목록이 확인되면(`ready`) 이 효과가 다시 돌아 받아 선다(칸은 그대로라 줄이 뛰지 않는다).
      // 다시 받은 횟수(`retries`)는 두어서, 다시 받기를 다 쓴 실패가 돌아온 뒤 새로 세 번을 기다리지 않는다(웹과 같다).
      setLayers(previous => (previous.length === 0 ? previous : []));
      setFailed(null);
      setPlayingKey(null);
      return undefined;
    }
    // 이미 이 그림을 그리고 있거나 얹은 층이 있으면 다시 받지 않는다.
    if (layersRef.current.some(layer => layer.key === targetKey)) {
      return undefined;
    }
    let alive = true;
    void store
      .load({id: expression.id, name: expression.name}, variant, endless && moving)
      .then(result => {
        if (!alive) return;
        const uri = result.uri;
        if (uri !== null) {
          retries.current = 0;
          setFailed(null);
          setLayers(previous =>
            addLayer(previous, {key: targetKey, uri, moving}),
          );
          return;
        }
        // 저장소가 지금 그림을 내주지 않는다(받는 사이 닫혔다): 상태가 바뀌면 이 효과가 다시 묻는다. 칸은 그대로다.
        if (result.miss === IMAGE_MISS.closed) return;
        const transient = result.miss === IMAGE_MISS.transient;
        setFailed({
          key: targetKey,
          transient,
          exhausted: transient && retries.current >= RETRY_LIMIT,
        });
      });
    return () => {
      alive = false;
    };
  }, [store, isLive, closed, targetKey, attempt, expression.id, expression.name, variant, moving, endless]);
  // 지나가는 실패(응답 없음·서버 재시작·받는 도중 걷힘): 같은 크기 칸으로 기다렸다가 같은 그림을 다시 받는다. 닫힌 동안은 기다리지 않는다 — 목록이 확인되면
  // 위 효과가 다시 받는다. 다시 받기를 다 쓴 실패(`exhausted`)는 더 기다리지 않고 칸으로 남는다.
  useEffect(() => {
    if (
      failed === null ||
      !failed.transient ||
      failed.exhausted ||
      failed.key !== targetKey ||
      closed
    )
      return undefined;
    const timer = setTimeout(() => {
      retries.current += 1;
      setAttempt(value => value + 1);
    }, Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** retries.current));
    return () => clearTimeout(timer);
  }, [failed, targetKey, closed]);
  // 정말로 깨진 그림의 key(지나가는 실패는 깨진 것이 아니다).
  const broken = failed !== null && !failed.transient ? failed.key : null;

  // 새 층이 그려지면(`onLoad`) 앞 층을 걷는다. 한 프레임 쉬고 걷어서, 새 층이 화면에 올라오기 전에 앞 층이 사라지는 일이 없게 한다.
  const onLayerLoad = useCallback((layer: Layer) => {
    if (layer.moving) setPlayingKey(layer.key);
    requestAnimationFrame(() => {
      setLayers(previous =>
        previous.length === 2 && previous[1].key === layer.key
          ? [previous[1]]
          : previous,
      );
    });
  }, []);
  const onLayerError = useCallback((layer: Layer) => {
    setLayers(previous => previous.filter(item => item.key !== layer.key));
    // 받은 파일을 그리지 못했다(디코드 실패·형식이 다름): 다시 받아도 같다.
    setFailed({key: layer.key, transient: false, exhausted: false});
  }, []);

  // 움직이는 그림은 한 번 그려지기 시작한 뒤 `EXPRESSION_REPEATS` 번 돌고 정지한다(정지 thumb 으로 층이 바뀐다).
  const durationMs = rendition?.durationMs ?? 0;
  useEffect(() => {
    if (!moving || playingKey === null || endless) return undefined;
    const timer = setTimeout(() => {
      setStopped(true);
      setPlayingKey(null);
    }, durationMs * EXPRESSION_REPEATS);
    return () => clearTimeout(timer);
  }, [moving, playingKey, durationMs, endless]);

  // 누름: 움직이는 그림은 첫 장면부터 다시 돌고, 정지 그림은 **누름을 받기만 하고 아무것도 하지 않는다**(다시 마운트·깜빡임·이동 없음).
  // 받기만 하는 까닭: 눌러도 화면이 그대로여야 한다 — 부모 줄에 넘기면 줄의 탭(스레드 열기)이 화면을 바꾼다. 누름을 받는 조건은 앞 판과 같다
  // (동작 줄이기를 켜지 않았고, 고르개의 칸·반응 칩이 아닐 때): 동작 줄이기에서는 움직임이 없으니 누름도 줄이 받고, 고르개의 칸·반응 칩은
  // 바깥 `Pressable` 이 받는다.
  const replay = useCallback(() => {
    setStopped(false);
    setPlayingKey(null);
    setPlay(value => value + 1);
  }, []);
  const swallow = useCallback(() => {}, []);
  const takesPress = !still && size !== 'reaction' && !reduceMotion;
  const onPress = takesPress ? (animated ? replay : swallow) : undefined;

  // 닫힌 동안(알림 뒤·읽는 중·오프라인·오류)에는 그림 층을 그리지 않는다(위 효과가 상태도 비운다 — 효과가 돌기 전 한 프레임에 옛 층이 비치지 않게 여기서도 거른다).
  const drawn = closed ? NO_LAYERS : layers;
  // 같은 크기의 빈 칸이 서 있는가(받는 중 · 닫힌 동안 · 지나가는 실패 · 다시 받기를 다 쓴 실패). 아래에서 글자로 내리는 경우는 빈 칸이 아니다.
  const waiting = isLive && box !== null && drawn.length === 0 && broken !== targetKey;
  // 빈 칸이 `LABEL_DELAY_MS` 넘게 이어졌는가(#5627, 웹 M1). 짧은 빈 칸은 투명한 그대로다: 흔들림마다 모든 칸이 회색으로 깜빡이지 않는다.
  const [lingering, setLingering] = useState(false);
  useEffect(() => {
    if (!waiting) {
      setLingering(false);
      return undefined;
    }
    const timer = setTimeout(() => setLingering(true), LABEL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [waiting]);
  // 다시 받기를 다 쓴 실패는 늦추지 않고 바로 말한다(웹 M2).
  const exhausted = waiting && failed !== null && failed.exhausted && failed.key === targetKey;
  // 칸 안에 이름이 서 있는가: 그림이 오면(층이 서면) 같은 자리에서 그림으로 바뀌고 칸의 크기는 그대로다.
  const labelled = waiting && (lingering || exhausted);

  // 읽기 도우미 이름: 서버가 확인한 목록(`ready`, 알림 뒤 목록이 적용된 뒤)일 때만 표시 이름·태그를 읽는다. 읽는 중·알림 뒤에는 그 사이 숨겨졌을 수 있는
  // 표현의 이름을 읽어 주지 않고 토큰 글(`:이름:`)을 읽는다(#5473 L-5451-1). 칸 안에 이름이 선 동안은 보이는 것과 같은 고정 이름으로 「<이름> 이모티콘」을
  // 읽는다(#5627) — 고정 이름은 본문에 이미 적힌 글이라 확인되지 않은 목록의 표시 이름·태그를 읽어 주지 않는다는 위 약속도 그대로다.
  const label = labelled
    ? formatMessage('expressions.image.waitingA11y', {name: expression.name})
    : live && storeReady && !held
      ? expressionAltText(live)
      : expressionToken(expression.name);
  // 이 표현을 지금 쓸 수 없다(숨김·삭제·목록 밖) 또는 그림이 정말로 깨졌다 — 그때만 글자다. 받는 중·닫힌 동안·지나가는 실패에는 같은 크기 칸이 비어 있다(#5585).
  if (!isLive || box === null || (drawn.length === 0 && broken === targetKey)) {
    return (
      <Text accessibilityLabel={label}>{expressionToken(expression.name)}</Text>
    );
  }
  const top = drawn.length - 1;
  const lines = LABEL_LINES[size];
  return (
    <Text accessibilityLabel={label} onPress={onPress}>
      <View
        ref={native}
        collapsable={false}
        pointerEvents="none"
        style={[
          {width: box.width, height: box.height},
          // 칸 자신이 옅은 그릇과 테두리를 입는다(웹 `[data-expression-lingering]`). RN 의 테두리는 상자 안쪽에 그려져 칸의 크기가 그대로다.
          labelled && (lines === undefined ? styles.placeholderSmall : styles.placeholder),
        ]}
        testID={`expression-box-${expression.name}-${size}`}>
        {labelled && lines !== undefined ? (
          // 이름 글자는 칸 위에 얹는다(절대 위치, 칸 안에서 잘린다) — 칸의 크기를 바꾸지 않는다. 낭독은 바깥 글자의 이름이 지므로 읽기 도우미에서는 숨긴다(웹 `aria-hidden`).
          <View
            style={[LAYER, styles.labelFrame]}
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants">
            <Text
              style={styles.labelText}
              numberOfLines={fitLines(lines, box.height, fontScale)}
              ellipsizeMode="tail"
              testID={labelMark(expression.name, size)}>
              {expressionToken(expression.name)}
            </Text>
          </View>
        ) : null}
        {drawn.map((layer, index) => (
          <Image
            key={layer.key}
            source={{uri: layer.uri}}
            accessible={false}
            resizeMode="contain"
            style={[LAYER, {width: box.width, height: box.height}]}
            onLoad={() => onLayerLoad(layer)}
            onError={() => onLayerError(layer)}
            testID={
              index === top
                ? `expression-image-${expression.name}-${size}`
                : `expression-image-${expression.name}-${size}-prev`
            }
          />
        ))}
      </View>
    </Text>
  );
}

/**
 * 오래 비어 있는 칸의 모양(#5627). 웹 `expressions.css` 의 `[data-expression-lingering]` 을 폰 역할로 옮겼다: 그릇 `surface-muted` → `surfaceMuted`,
 * 테두리 `line` → `border`, 작은 칸의 테두리 `line-strong` → `textFaint`(반응 칩처럼 바탕이 이미 그릇 색인 자리에서도 칸이 보인다), 모서리
 * `radius-sm`, 글자 `text-meta`·`ink-muted` → `font.meta`·`line.meta`·`textMuted`. 테두리는 상자 안쪽이라 칸의 크기를 바꾸지 않는다.
 */
const buildStyles = (color: Palette) =>
  StyleSheet.create({
    placeholder: {
      backgroundColor: color.surfaceMuted,
      borderColor: color.border,
      borderRadius: radius.sm,
      borderWidth: 1,
    },
    placeholderSmall: {
      backgroundColor: color.surfaceMuted,
      borderColor: color.textFaint,
      borderRadius: radius.sm,
      borderWidth: 1,
    },
    labelFrame: {
      alignItems: WORD.center,
      justifyContent: WORD.center,
      overflow: WORD.hidden,
      paddingHorizontal: space.xs,
    },
    labelText: {
      color: color.textMuted,
      fontSize: font.meta,
      lineHeight: line.meta,
      textAlign: WORD.center,
    },
  });
