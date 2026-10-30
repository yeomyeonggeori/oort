import React, {useState} from 'react';
import {Image, StyleSheet, View} from 'react-native';

import {usePalette, useStyles, useTheme} from '../theme';
import type {Palette} from '../tokens';
import {PRESETS, SOLIDS} from '@momo/core/design/mobileBackground';
import {backgroundPhotoUri} from './store';

// =============================================================================
// 사용자 배경 — 홈·대화 바닥 **뒤**에 까는 한 장 (ADR-0189 증보 2, #3907).
//
// 이 컴포넌트는 두 층이다: 고른 그림(단색·그라데이션·사진)과 그 위의 scrim. scrim 이
// 없는 배경은 이 앱에 없다 — 글자 대비를 지키는 것이 scrim 이고(`scrim.ts`), 그림은
// 취향이다. 접근성 설정(투명도 줄이기·대비 높이기)이 켜져 있으면 프로바이더가
// `backgroundActive` 를 거짓으로 내리고 이 컴포넌트는 아무것도 그리지 않는다 — 그때는
// 화면의 바닥 스타일이 기본 그라데이션으로 돌아와 있다(`palette.backdrop === 'canvas'`).
//
// 터치를 가로채지 않는다. 사진 파일이 사라졌거나 못 읽으면(`onError`) 바닥색 한 장으로
// 접는다: 글자 색은 이미 이미지 모드 기준이라, 바닥색 위에서는 대비가 더 높을 뿐이다.
// =============================================================================

export function AppBackground(): React.JSX.Element | null {
  const {background, backgroundActive} = useTheme();
  const palette = usePalette();
  const styles = useStyles(buildStyles);
  const [failedFile, setFailedFile] = useState<string | null>(null);
  if (!backgroundActive) return null;

  let source: React.ReactNode = null;
  switch (background.kind) {
    case 'solid':
      source = (
        <View
          style={[StyleSheet.absoluteFill, {backgroundColor: SOLIDS[background.id].hex}]}
          testID="app-background-solid"
        />
      );
      break;
    case 'preset':
      source = (
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: PRESETS[background.id].fallback,
              experimental_backgroundImage: PRESETS[background.id].gradient,
            },
          ]}
          testID="app-background-preset"
        />
      );
      break;
    case 'photo':
      source =
        failedFile === background.file ? (
          <View
            style={[StyleSheet.absoluteFill, {backgroundColor: palette.bg}]}
            testID="app-background-missing"
          />
        ) : (
          <Image
            source={{uri: backgroundPhotoUri(background.file)}}
            resizeMode="cover"
            style={StyleSheet.absoluteFill}
            onError={() => setFailedFile(background.file)}
            accessible={false}
            testID="app-background-photo"
          />
        );
      break;
    default:
      return null;
  }

  return (
    <View pointerEvents="none" style={styles.layer} testID="app-background">
      {source}
      <View
        style={[StyleSheet.absoluteFill, {backgroundColor: palette.backdropScrim}]}
        testID="app-background-scrim"
      />
    </View>
  );
}

const buildStyles = (_color: Palette) =>
  StyleSheet.create({
    layer: {position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, overflow: 'hidden'},
  });
