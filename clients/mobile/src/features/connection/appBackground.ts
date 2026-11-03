import {AppState} from 'react-native';

// =============================================================================
// 앱이 뒤로 갈 때 부른다 (#5222). 보내는 중이던 글을 이 기기에 남길 때(`useTimeline`) 쓴다 - iOS 는 뒤로 간 앱의 프로세스를 언제든 죽일 수
// 있고, 그러면 나갈 때 돌 코드가 없다(`drafts.ts` 머리말과 같은 이유). 앞에 있는 동안의 `inactive`(알림 센터를 당긴 순간 등)는 뒤로 간 것이
// 아니다. 돌려주는 함수가 구독을 푼다.
// =============================================================================
export function onAppBackground(callback: () => void): () => void {
  const subscription = AppState.addEventListener('change', status => {
    if (status === 'background') callback();
  });
  return () => subscription.remove();
}
