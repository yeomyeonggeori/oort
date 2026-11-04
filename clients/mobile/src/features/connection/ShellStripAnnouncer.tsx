import type {ConnectionCause} from '@momo/core/features/connection/model';
import {
  nextShellStood,
  presentShellStrip,
  shellSpeaksFor,
} from '@momo/core/features/connection/shellStrip';
import {useEffect, useRef} from 'react';
import {AccessibilityInfo, Platform} from 'react-native';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {useConnection} from './ConnectionProvider';

// =============================================================================
// 셸 띠가 서는 순간 VoiceOver 가 한 번 알린다 (#5262, #5222 후속, #5201 결정 ②).
//
// iOS 에는 `accessibilityLiveRegion` 이 없다(안드로이드 전용). 띠는 문장이 바뀌어도 읽히지 않고, 눈으로 볼 수 없는 사람은 홈이 오프라인이라는
// 사실을 소리로 받을 길이 없었다. 소리로만 전달되는 사실은 `announceForAccessibility` 로 알린다(`usePhotoLibrary` 의 낭독과 같은 길). 안드로이드는
// 띠의 live region 이 이미 읽으므로 여기서 또 읽지 않는다(두 번 들리지 않게).
//
// ## 왜 띠 안이 아니라 한 번만 서는 부품인가
//
// 셸 띠는 홈 · 받은함 · 에이전트 세 화면에 각자 선다. 숨은 탭은 언마운트가 아니라서(`AppShell`) 한 번 끊김에 띠가 둘, 셋 동시에 서 있다 - 띠마다
// 낭독을 달면 같은 말이 두세 번 들린다. 이 부품이 `AppShell` 에 하나만 서서 연결 상태 모델만 읽는다. 무엇이 셸 띠를 세우는지는 코어
// (`shellSpeaksFor` · `presentShellStrip`)가 정하고, 이 부품은 문장을 그리지 않고 읽기만 한다.
//
// ## 같은 원인으로 다시 서면 되풀이하지 않는다
//
// 끊김 하나는 띠가 섰다가 틈이 **완전히 가라앉을 때까지**다(`nextShellStood`: 셸이 말하는 원인이면 서고, 정상이고 복구 표시도 없으면 잊는다 - 그
// 사이 소켓 틈의 침묵 · 「연결 중」 · 복구 표시 2초는 이어진다). 그 한 번의 끊김 안에서 원인마다 한 번만 읽는다: 오프라인이 깜빡이며 서고 걷혀도
// 같은 말을 되풀이하지 않고, 오프라인에서 서버에 닿지 못함으로 원인이 **바뀌면** 문장이 다르니 한 번 더 읽는다. 틈이 완전히 가라앉은 뒤의 다음 끊김은 새
// 이야기라 다시 읽는다.
//
// 읽는 문장은 띠가 말하는 것과 같다(제목. 설명 - 띠의 접근성 문장). 「다시 연결됐어요」(복구 표시)는 읽지 않는다: 이 부품은 띠가 **서는** 순간만 맡는다.
// =============================================================================

/**
 * 낭독으로 알리는 플랫폼. live region 이 없는 플랫폼만 적는다(iOS). 안드로이드는 띠의 live region 이 이미 읽는다. 플랫폼 이름을 비교 값이 아니라
 * 표의 열쇠로 적는 까닭: 비교 값으로 적은 영어 낱말은 직접 문구 장부가 문구로 세어 장부를 늘린다.
 */
const ANNOUNCES: Partial<Record<typeof Platform.OS, boolean>> = {ios: true};

export function ShellStripAnnouncer(): null {
  const connection = useConnection();
  const formatMessage = useFormatMessage();
  // 지금 이 끊김 동안 이미 읽은 원인들. 끊김이 끝나면(틈이 가라앉으면) 비운다.
  const told = useRef(new Set<ConnectionCause>());
  // 「셸 띠가 섰었다」는 기억 - 띠 부품(`ShellConnectionStrip`)과 같은 코어 규칙으로 센다.
  const stood = useRef(false);
  const view = connection?.view ?? null;
  const recovered = connection?.recovered ?? false;
  useEffect(() => {
    if (view === null) return;
    stood.current = nextShellStood(view, recovered, stood.current);
    if (!stood.current) told.current.clear();
    if (!shellSpeaksFor(view) || view.cause === null) return;
    if (told.current.has(view.cause)) return;
    const strip = presentShellStrip(view, recovered, stood.current);
    if (strip === null) return;
    told.current.add(view.cause);
    const title = formatMessage(strip.title);
    const spoken =
      strip.detail === null ? title : `${title}. ${formatMessage(strip.detail)}`;
    if (ANNOUNCES[Platform.OS]) AccessibilityInfo.announceForAccessibility(spoken);
  }, [view, recovered, formatMessage]);
  return null;
}
