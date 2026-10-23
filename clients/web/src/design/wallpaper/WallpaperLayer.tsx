import { useLayoutEffect, useRef } from "react";
import { wallpaperRuntime } from "./runtime";

// 배경화면 층 (ADR-0189 증보 3 D4, AP-4 #4191). 창 바닥(`.app-shell`) 맨 아래, 사이드바 뒤에 깔리는 그림 한 장이다.
// 이 요소는 늘 DOM에 있지만 CSS가 `data-wallpaper-live`가 켜진 동안에만 보인다(`design/appearance/wallpaper.css`).
// 칠하는 일(색·그림)은 런타임이 CSSOM으로 한다: 사진은 약 2MB 문자열이라 JSX `style=`도, 상속되는 커스텀
// 프로퍼티도 아니다. 이 컴포넌트가 하는 일은 요소를 런타임에 붙이고 셸이 사라질 때(로그아웃) 떼는 것뿐이다.
export function WallpaperLayer() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const runtime = wallpaperRuntime();
    runtime.attach(element);
    return () => runtime.detach();
  }, []);
  return <div ref={ref} data-wallpaper-layer="" aria-hidden="true" />;
}
