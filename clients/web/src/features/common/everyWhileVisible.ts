/**
 * 창이 보이는 동안만 `ms`마다 `run`을 부른다 (#5660). 숨은 동안 돌아온 차례는 건너뛰고, 다시 보이는 순간 한 번 부른다(건너뛴 차례가
 * 있었을 때만). 돌려주는 함수가 멈춤이다.
 *
 * 데스크탑 웹뷰는 창을 치워도 계속 돈다(`backgroundThrottling: "disabled"`). 변경 신호가 따로 있고 주기 읽기는 그물일 뿐인 것(표현 목록,
 * 로컬 칸의 git 읽기)은 아무도 보지 않는 창에서까지 돌릴 까닭이 없다. 「숨음」은 `visibilityState`다: 초점만 잃은 창은 여전히 보인다.
 */
export function everyWhileVisible(run: () => void, ms: number): () => void {
  const hidden = () => document.visibilityState === "hidden";
  let missed = false;
  const timer = window.setInterval(() => {
    if (hidden()) missed = true;
    else run();
  }, ms);
  const onVisibility = () => {
    if (hidden() || !missed) return;
    missed = false;
    run();
  };
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
