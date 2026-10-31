import type {Expression} from '@momo/core/features/expressions/types';
import {
  expressionAltText,
  expressionToken,
} from '@momo/core/features/expressions/message';
import React, {useEffect, useRef, useState} from 'react';
import {AppState, Image, Text, useWindowDimensions} from 'react-native';
import {font} from '../../design/tokens';
import {useReduceMotion} from '../../lib/useReduceMotion';
import {useExpressions} from './ExpressionProvider';

export type PhoneExpressionSize =
  | 'reaction'
  | 'inline'
  | 'medium'
  | 'large'
  | 'grid'
  | 'tile';
// `tile` 은 표현 시트의 이모티콘·GIF 탭이 쓰는 큰 칸이다(#4942) — `grid` 와 같은 정지 그림(thumb)이고 크기만 다르다.
const POINTS = {
  reaction: 20,
  medium: 48,
  large: 160,
  grid: 32,
  tile: 64,
} as const;
const REPEATS = 4;

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
  const {store, items, revision} = useExpressions();
  const {
    fontScale,
    height: windowHeight,
    width: windowWidth,
  } = useWindowDimensions();
  const reduceMotion = useReduceMotion();
  const native = useRef<Image>(null);
  // 고르개의 칸(`grid`·`tile`)은 늘 정지 그림이다 — 움직이는 것은 미리보기와 대화의 줄만.
  const still = size === 'grid' || size === 'tile';
  const [onScreen, setOnScreen] = useState(still);
  const [foreground, setForeground] = useState(
    AppState.currentState === 'active',
  );
  const [stopped, setStopped] = useState(false);
  const [play, setPlay] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [source, setSource] = useState<{uri: string; key: string} | null>(null);
  const live = items.find(
    item =>
      item.id === expression.id &&
      item.name === expression.name &&
      item.status === 'active',
  );
  const media = live?.media;
  const animate =
    !still &&
    (visible ?? onScreen) &&
    foreground &&
    !reduceMotion &&
    !stopped;
  const variant = animate ? (size === 'large' ? 'large' : 'small') : 'thumb';
  const rendition = media?.[variant];
  const key = `${revision}/${expression.id}/${variant}/${rendition?.sha256}/${play}`;
  const animated = rendition?.mime === 'image/gif' && animate;
  const points = size === 'inline' ? font.body * fontScale : POINTS[size];
  const ratio = rendition ? rendition.width / rendition.height : 1;
  const width = points * Math.min(1, ratio);
  const height = points / Math.max(1, ratio);

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
    const subscription = AppState.addEventListener('change', state =>
      setForeground(state === 'active'),
    );
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [still, windowHeight, windowWidth]);
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    if (store)
      void store
        .image({id: expression.id, name: expression.name}, variant)
        .then(uri => {
          if (alive) setSource(uri ? {uri, key} : null);
        });
    return () => {
      alive = false;
    };
  }, [store, key, expression.id, expression.name, variant]);
  useEffect(() => {
    if (!animated || !loaded || !rendition) return;
    const timer = setTimeout(
      () => setStopped(true),
      rendition.durationMs * REPEATS,
    );
    return () => clearTimeout(timer);
  }, [animated, loaded, rendition, play]);

  const ready = source?.key === key && live && rendition;
  const geometry = {width: ready ? width : 0, height: ready ? height : 0};
  const label = live
    ? expressionAltText(live)
    : expressionToken(expression.name);
  // Image remains mounted while loading so viewport measurement can complete.
  return (
    <Text
      accessibilityLabel={label}
      onPress={
        !still && size !== 'reaction' && !reduceMotion
          ? () => {
              setStopped(false);
              setPlay(value => value + 1);
            }
          : undefined
      }
    >
      {!ready ? expressionToken(expression.name) : null}
      <Image
        ref={native}
        key={key}
        source={ready ? {uri: source.uri} : undefined}
        accessible={false}
        resizeMode="contain"
        style={geometry}
        onLoad={() => setLoaded(true)}
        onError={() => setSource(null)}
        testID={`expression-image-${expression.name}-${size}`}
      />
    </Text>
  );
}
