import {
  FIXTURE_EXPRESSIONS,
  FIXTURE_MEMBER_ID,
  FIXTURE_WORKSPACE_ID,
} from '@momo/core/features/expressions/fixtures';
import {
  createExpressionFixtureServer,
  type ExpressionFixtureResponse,
} from '@momo/core/features/expressions/fixtureServer';
import React, {useEffect, useMemo} from 'react';
import {StyleSheet, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {useStyles} from '../src/design/theme';
import {space, type Palette} from '../src/design/tokens';
import {MessageBody} from '../src/features/conversation/MessageBody';
import {ExpressionImage} from '../src/features/expressions/ExpressionImage';
import {PhoneExpressions} from '../src/features/expressions/ExpressionProvider';
import {
  createPhoneExpressionStore,
  type ExpressionFiles,
} from '../src/features/expressions/store';
import type {ExpressionTransport} from '../src/features/expressions/transport';

// =============================================================================
// #5627 캡처 표면 — 그림을 못 받은 이모티콘 칸 안의 이름. **배송되는 `MessageBody`·`ExpressionImage` 가 그대로 서고**, 서버 자리만 코어 가짜 서버
// (`fixtureServer.ts`, 합성 그림·가상 이름)다. 한 화면에 큰 칸(160) · 중간 칸 둘(48) · 글 사이 · 시트 칸(tile 64) · 반응 크기(20)를 세운다.
//
//   -momoMeasure EXPRESSIONNAME-WAITING        그림이 선 뒤 기기가 오프라인이 되고(1.5초 뒤) 3초가 지난 모습: 칸 안 이름 · 작은 칸은 정지 자리표시
//   -momoMeasure EXPRESSIONNAME-BACK           같은 조각, 그림이 선 모습(칸의 자리·크기가 위와 같다)
//   앞에 `LIGHT-` 를 붙이면 밝게(`measure/root.ts`).
// =============================================================================

/** 그림이 한 번 선 뒤 오프라인으로 바꾸기까지(목록·그림을 받는 시간). 그 뒤 3초가 지나야 칸 안에 이름이 선다. */
const OFFLINE_AFTER_MS = 1_500;

function base64Of(bytes: Uint8Array): string {
  let text = '';
  bytes.forEach(byte => {
    text += String.fromCharCode(byte);
  });
  return btoa(text);
}
const FILES: ExpressionFiles = {
  write: (key, bytes) =>
    `data:${key.endsWith('.gif') ? 'image/gif' : 'image/png'};base64,${base64Of(bytes)}`,
  remove: () => {},
};

function sceneTransport(): ExpressionTransport {
  const server = createExpressionFixtureServer();
  return {
    async request(request): Promise<ExpressionFixtureResponse> {
      return server.request(request);
    },
  };
}

export function ExpressionNameSurface({which}: {which: string}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const waiting = which !== 'back';
  const store = useMemo(
    () => createPhoneExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, sceneTransport(), FILES),
    [],
  );
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    store.start();
    void store.refresh(true).then(() => {
      // 기기 오프라인(#5585 D3): 그림 바이트를 내리고 같은 크기 칸만 둔다. 3초 뒤 칸 안에 이름이 선다(#5627).
      if (live && waiting) timer = setTimeout(() => store.setOnline(false), OFFLINE_AFTER_MS);
    });
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
      store.dispose();
    };
  }, [store, waiting]);
  return (
    <PhoneExpressions.Provider value={store}>
      <View style={[styles.page, {paddingTop: insets.top + space.lg}]} testID={waiting ? 'expressionname-waiting' : 'expressionname-back'}>
        <MessageBody body=":party_parrot:" />
        <MessageBody body=":ki_jeol: :thumbs_up:" />
        <MessageBody body="회의 끝났어요 :party_parrot: 다들 수고했어요" />
        <View style={styles.row}>
          {FIXTURE_EXPRESSIONS.map(item => (
            <ExpressionImage key={item.id} expression={item} size="tile" visible />
          ))}
        </View>
        <View style={styles.row}>
          {FIXTURE_EXPRESSIONS.map(item => (
            <ExpressionImage key={item.id} expression={item} size="reaction" visible />
          ))}
        </View>
      </View>
    </PhoneExpressions.Provider>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    page: {
      flex: 1,
      backgroundColor: color.bg,
      paddingHorizontal: space.lg,
      gap: space.lg,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
    },
  });
