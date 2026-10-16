import {useEffect, useState} from 'react';
import {nativeBuildVersion} from 'expo-application';

import {loadIosFeed, offerFor, parseBuild, type AppUpdateOffer} from './feed';

/**
 * 새 판 제안. 아직 읽는 중이거나 읽지 못했거나 이미 최신이면 `null` 이다: 화면은
 * 「없음」과 「모름」을 구별하지 않는다(`feed.ts` 머리말). 홈 배너와 프로필 배너가
 * 같은 값을 읽고, 요청은 `loadIosFeed` 의 캐시가 하나로 모은다.
 */
export function useAppUpdateOffer(): AppUpdateOffer | null {
  const [offer, setOffer] = useState<AppUpdateOffer | null>(null);
  useEffect(() => {
    let live = true;
    void loadIosFeed().then(feed => {
      if (live) setOffer(offerFor(feed, parseBuild(nativeBuildVersion)));
    });
    return () => {
      live = false;
    };
  }, []);
  return offer;
}
