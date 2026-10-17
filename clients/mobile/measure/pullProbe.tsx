import React, {useRef, useState} from 'react';
import {FlatList, RefreshControl, StyleSheet, Text, View} from 'react-native';

// 계측용: 표준 `RefreshControl` 이 새로고침을 세우는 오프셋을 잰다(`design/pullRefresh.ts` 의
// `PULL_TRIGGER` 의 출처). `-momoMeasure PULL-PROBE`.
//
// 손가락은 시뮬레이터 창에 `cliclick` 으로 주입한다. 이 기기의 창이 (1077,162)에 있고 기기 화면이
// 창 안에서 (31,84)에서 시작하는 배율 1이었다(상태 줄 HUD 의 `touch=` 로 보정). 예: 화면 (1303,380)에서
// `cliclick dd:1303,380 w:60 dm:1303,410 ... dm:1303,680 w:500` 으로 300pt 를 끌어 `fired=` 를 읽는다.
// 같은 300pt 당김을 세 번 되풀이해 세 번 모두 `fired=at lastY=-147.3` 이었다(손가락이 닿은 채로).
export function PullProbe(): React.JSX.Element {
  const [hud, setHud] = useState('touch=- minY=0 fired=-');
  const [refreshing, setRefreshing] = useState(false);
  const lastY = useRef(0);
  const minY = useRef(0);
  const touch = useRef('-');
  const fired = useRef('-');
  const update = () =>
    setHud(`touch=${touch.current} minY=${minY.current.toFixed(1)} lastY=${lastY.current.toFixed(1)} fired=${fired.current}`);
  return (
    <View style={styles.screen}>
      <Text style={styles.hud} testID="probe-hud">{hud}</Text>
      <FlatList
        data={Array.from({length: 30}, (_, i) => `행 ${i + 1}`)}
        keyExtractor={item => item}
        renderItem={({item}) => <Text style={styles.row}>{item}</Text>}
        scrollEventThrottle={16}
        onTouchStart={e => {
          touch.current = `${Math.round(e.nativeEvent.pageX)},${Math.round(e.nativeEvent.pageY)}`;
          update();
        }}
        onScrollBeginDrag={() => {
          minY.current = 0;
          fired.current = '-';
        }}
        onScroll={e => {
          lastY.current = e.nativeEvent.contentOffset.y;
          if (lastY.current < minY.current) minY.current = lastY.current;
          update();
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              fired.current = `at lastY=${lastY.current.toFixed(1)} minY=${minY.current.toFixed(1)}`;
              setRefreshing(true);
              update();
              setTimeout(() => setRefreshing(false), 2500);
            }}
          />
        }
        testID="probe-list"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: '#ffffff', paddingTop: 70},
  hud: {fontSize: 12, color: '#000000', paddingHorizontal: 8, height: 36},
  row: {fontSize: 16, color: '#000000', paddingVertical: 14, paddingHorizontal: 16},
});
