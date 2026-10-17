import React, {useState} from 'react';
import {Animated, FlatList, RefreshControl, StyleSheet, Text, View} from 'react-native';

// =============================================================================
// 계측: 목록 위 당김 머리를 어떻게 달아야 표준 `UIRefreshControl` 의 열린 자리(약 60pt)에 머리가 서는가.
// (`design/refresh.tsx` 의 `layout.header` 주석의 근거.) `-momoMeasure PULL-HOLD-<변형>`.
//
//   plain   머리 없음 (표준 컨트롤만)
//   neg     머리를 `top: -64` 에 둔다 (내용 좌표의 음수 자리)
//   neg1    1×1 짜리 형제를 `top: -64` 에 둔다 (크기가 아니라 음수 원점이 문제인지)
//   lift    머리를 `top: 0` 에 두고 `transform: translateY(-64)` 로 올린다 (현행)
//   zero    높이 0 의 머리를 `top: 0` 에 둔다
//
// 읽는 법: 시뮬레이터 창에 같은 당김(약 340pt)을 주입하고 **스크린샷의 첫 행 위치**를 잰다.
//   ① 당기기 전(idle): 첫 행이 `행 1` 인가
//   ② 손을 뗀 1.5초 뒤: 첫 행이 ①보다 얼마나 내려가 있는가(열린 자리 약 60pt)
// 숫자는 띄우지 않는다: 스크롤 이벤트의 `contentOffset` 은 다섯 변형 모두 -60.3 으로 같게 나와서 내용이
// 실제로 어디 서는지를 말해 주지 못했다(neg 류는 내용 원점이 밀려 있다). 스크린샷만 본다.
//
// 2026-10-17 iOS 26.5 시뮬레이터(iPhone 16e) 결과(첫 행 위쪽 y, 3x 픽셀):
//   plain·lift·zero  ① 367  ② 548  (+181px = +60pt: 열린 자리만큼 내려가고, ①에서 첫 행은 제자리)
//   neg·neg1         ① `행 2` 가 맨 위(첫 행이 위로 밀려 가려짐)  ② 356  (-4pt: 열린 +60pt 에서 밀림 -64pt 를 뺀 값)
// 음수 자식은 내용 경계 상자의 원점을 그만큼 위로 밀어 맨 위 행을 가리고, 열린 자리에서도 머리가
// 보이는 자리 밖으로 밀려난다. `transform` 은 레이아웃 프레임에 들어가지 않아 이 둘이 없다.
// =============================================================================

export function PullHold({which}: {which: string}): React.JSX.Element {
  const [refreshing, setRefreshing] = useState(false);
  const header = (
    <Animated.View pointerEvents="none" style={styles[which === 'lift' ? 'lift' : which === 'zero' ? 'zero' : which === 'neg1' ? 'neg1' : 'neg']}>
      <Text style={styles.headText}>HEAD</Text>
    </Animated.View>
  );
  return (
    <View style={styles.screen}>
      <Text style={styles.hud}>{`PULL-HOLD-${which}`}</Text>
      <FlatList
        data={Array.from({length: 30}, (_, i) => `행 ${i + 1}`)}
        keyExtractor={item => item}
        renderItem={({item}) => <Text style={styles.row}>{item}</Text>}
        refreshControl={
          <>
            <RefreshControl
              refreshing={refreshing}
              tintColor="transparent"
              onRefresh={() => {
                setRefreshing(true);
                setTimeout(() => setRefreshing(false), 60000);
              }}
            />
            {which === 'plain' ? null : header}
          </>
        }
      />
    </View>
  );
}

const band = {left: 0, right: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: '#ffe0e0'} as const;
const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: '#ffffff', paddingTop: 70},
  hud: {fontSize: 12, color: '#000000', paddingHorizontal: 8, height: 36},
  row: {fontSize: 16, color: '#000000', paddingVertical: 14, paddingHorizontal: 16},
  neg: {...band, position: 'absolute', top: -64, height: 64},
  neg1: {position: 'absolute', top: -64, left: 0, width: 1, height: 1, backgroundColor: '#ffe0e0'},
  lift: {...band, position: 'absolute', top: 0, height: 64, transform: [{translateY: -64}]},
  zero: {...band, position: 'absolute', top: 0, height: 0},
  headText: {fontSize: 14, color: '#c00000'},
});
