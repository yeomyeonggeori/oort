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
import {font} from '../../design/tokens';
import {useReduceMotion} from '../../lib/useReduceMotion';
import {
  EXPRESSION_REPEATS,
  expressionBoxOf,
  expressionVariantFor,
  isAnimatedMedia,
  keepsMoving,
  type PhoneExpressionSize,
} from './expressionBox';
import {useExpressions} from './ExpressionProvider';

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
  const [failedKey, setFailedKey] = useState<string | null>(null);
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
  useEffect(() => {
    if (!store) return undefined;
    if (!isLive) {
      // 목록에서 빠졌다(숨김·삭제·끊김): 그렸던 층·실패·재생 시계를 버린다. 걷힌 파일 주소를 그린 층이 남지 않고, 다시 쓸 수 있게 되면 새로 받아 선다.
      setLayers(previous => (previous.length === 0 ? previous : []));
      setFailedKey(null);
      setPlayingKey(null);
      return undefined;
    }
    if (held) {
      // 알림이 걷은 파일을 가리키던 층·실패·재생 시계를 버린다. 목록이 적용되면 이 효과가 다시 돌아 남은 표현만 받아 선다(칸은 그대로라 줄이 뛰지 않는다).
      setLayers([]);
      setFailedKey(null);
      setPlayingKey(null);
      return undefined;
    }
    // 이미 이 그림을 그리고 있거나 얹은 층이 있으면 다시 받지 않는다.
    if (layersRef.current.some(layer => layer.key === targetKey)) {
      return undefined;
    }
    let alive = true;
    void store
      .image({id: expression.id, name: expression.name}, variant, endless && moving)
      .then(uri => {
        if (!alive) return;
        if (uri === null) {
          // 목록을 읽는 중이거나 끊긴 때의 `null` 은 목록이 돌아오면(`storeReady`) 다시 묻는다. 그 밖의 실패만 글자로 내린다.
          if (storeReady) setFailedKey(targetKey);
          return;
        }
        setFailedKey(null);
        setLayers(previous =>
          addLayer(previous, {key: targetKey, uri, moving}),
        );
      });
    return () => {
      alive = false;
    };
  }, [store, isLive, storeReady, held, targetKey, expression.id, expression.name, variant, moving, endless]);

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
    setFailedKey(layer.key);
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

  // 읽기 도우미 이름: 서버가 확인한 목록(`ready`, 알림 뒤 목록이 적용된 뒤)일 때만 표시 이름·태그를 읽는다. 읽는 중·알림 뒤에는 그 사이 숨겨졌을 수 있는
  // 표현의 이름을 읽어 주지 않고 토큰 글(`:이름:`)을 읽는다(#5473 L-5451-1).
  const label =
    live && storeReady && !held
      ? expressionAltText(live)
      : expressionToken(expression.name);
  // 알림 뒤에는 그림 층을 그리지 않는다(위 효과가 상태도 비운다 — 효과가 돌기 전 한 프레임에 옛 층이 비치지 않게 여기서도 거른다).
  const drawn = held ? NO_LAYERS : layers;
  // 이 표현을 지금 쓸 수 없다(숨김·삭제·목록 밖) 또는 그림을 못 받았다 — 그때만 글자다. 받는 중에는 칸이 비어 있다.
  if (!isLive || box === null || (drawn.length === 0 && failedKey === targetKey)) {
    return (
      <Text accessibilityLabel={label}>{expressionToken(expression.name)}</Text>
    );
  }
  const top = drawn.length - 1;
  return (
    <Text accessibilityLabel={label} onPress={onPress}>
      <View
        ref={native}
        collapsable={false}
        pointerEvents="none"
        style={{width: box.width, height: box.height}}
        testID={`expression-box-${expression.name}-${size}`}>
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
