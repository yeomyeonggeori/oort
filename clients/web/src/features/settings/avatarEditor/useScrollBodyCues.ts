import { useLayoutEffect, useState } from "react";

// 편집기의 스크롤 본문이 CSS 에 알려 주는 두 가지 (#4261 design-review B-1 · M-7).
//
//   · `--avatar-editor-sticky-height`: 큰 창에서 본문 위에 붙는 미리보기 띠의 높이. 초점이 가서 본문이 스크롤될 때 대상이 띠 밑에
//     깔리지 않도록 `scroll-padding-block-start` 가 이 값만큼 위를 비워 둔다(`avatarEditor.css`). 띠의 높이는 글자 크기·확대에 따라
//     달라지므로 상수로 두지 않고 잰다.
//   · `data-scrollable`: 내용이 본문보다 긴가. 그러면 CSS 가 아래 가장자리를 녹여(`mask-image`, 사이드바 목록과 같은 단서) 「더
//     있다」를 말한다. macOS 의 겹침 스크롤바는 스크롤하기 전까지 숨어서, 반쯤 잘린 칸과 빈 줄이 렌더 오류처럼 읽혔다.
//
// 노드는 ref 객체가 아니라 **상태**로 받는다. Radix 의 Portal 은 첫 렌더 뒤에 내용을 세우므로(layout effect 에서 `mounted`), 부모의
// `useLayoutEffect([])` 는 노드가 서기 전에 돌고 다시 돌지 않는다. 콜백 ref 가 상태를 바꾸면 노드가 설 때 효과가 다시 돈다.
//
// 측정은 `ResizeObserver` 가 없는 환경(jsdom)에서는 한 번만 한다. 관찰자의 알림은 한 프레임 미룬다: 알림 안에서 속성을 바꿔
// 관찰 대상의 크기를 또 바꾸면 브라우저가 「ResizeObserver loop」 오류를 낸다.

const STICKY_HEIGHT_VAR = "--avatar-editor-sticky-height";

export function useScrollBodyCues() {
  const [body, setBody] = useState<HTMLElement | null>(null);
  const [inner, setInner] = useState<HTMLElement | null>(null);
  const [sticky, setSticky] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!body || !inner) return;
    const measure = () => {
      if (sticky) body.style.setProperty(STICKY_HEIGHT_VAR, `${sticky.offsetHeight}px`);
      // `inner` 는 본문의 유일한 자식이고 자기 패딩이 없다. 단서가 켜지면 본문이 아래 패딩을 얻는데, 그 패딩은 `body.clientHeight` 에
      // 들어가고 `inner.offsetHeight` 에는 안 들어가므로 이 비교는 단서가 켜져 있든 꺼져 있든 같은 답을 낸다(켜졌다 꺼졌다 하지 않는다).
      body.toggleAttribute("data-scrollable", inner.offsetHeight > body.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(body);
    observer.observe(inner);
    if (sticky) observer.observe(sticky);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [body, inner, sticky]);

  return { bodyRef: setBody, innerRef: setInner, stickyRef: setSticky } as const;
}
