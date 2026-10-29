import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ZOOM_CHIP_LINGER_MS } from "@/design/motion";
import {
  LIGHTBOX_FIT_VIEW,
  clampLightboxView,
  isLightboxFit,
  lightboxActualSizeZoom,
  lightboxWheelFactor,
  lightboxZoomKeyAction,
  lightboxZoomLabel,
  stepLightboxZoom,
  zoomLightboxViewAt,
  type LightboxGeometry,
  type LightboxView,
} from "@/features/attachments/imageLightboxModel";

// =============================================================================
// 이미지 미리보기의 확대 (#4770).
//
// 배율·이동의 정본은 `ref`(`view`)다. 매 사건마다 React를 다시 그리지 않으려고, 사진의 변환은 CSS 변수(`--lightbox-zoom`,
// `--lightbox-pan-x`, `--lightbox-pan-y`)로 직접 꽂는다(CSSOM이라 CSP·프리플라이트의 `inline_style`에 걸리지 않는다:
// `slider.tsx`의 `--slider-fraction`과 같은 길). 변수를 읽는 규칙은 tokens.css의 `lightbox-photo` 유틸이다. React 상태는
// 화면 결정에 필요한 것만 든다: 확대 중인가(`zoomed`: 바깥 클릭·←/→·Esc·커서), 끄는 중인가(`dragging`), 칩 글자.
//
// 입력은 네 갈래다.
//   · 휠: `ctrlKey`(트랙패드 오므리기·벌리기는 이 모양으로 온다) 또는 `metaKey`(⌘+스크롤). 커서가 중심이다. React의 `onWheel`은
//     수동(passive) 리스너라 `preventDefault`가 안 먹으므로 뷰어 노드에 네이티브로 단다(브라우저 쪽 확대를 막아야 한다).
//   · `gesture*`: 데스크탑 셸(WKWebView)과 사파리는 핀치를 `wheel`이 아니라 이 WebKit 전용 사건으로 준다. `scale`은 시작
//     대비 누적값이다. 두 갈래가 함께 오는 환경이 있어도 이중으로 확대하지 않도록, 제스처 중에는 `ctrlKey` 휠을 무시한다.
//   · 포인터: 확대 중에 사진을 끈다. `setPointerCapture`로 사진 밖에서 놓아도 끝이 온다.
//   · 두 번 클릭·키(⌘+ ⌘- ⌘0): 띄엄띄엄한 단계라 변환을 부드럽게 잇는다(`data-smooth`). 연속 입력(휠·핀치·끌기)은 이행이
//     손가락을 따라가지 못하게 하므로 끈다.
// =============================================================================

/** WebKit 전용 `gesture*` 사건. `lib.dom`에 없어서 쓰는 칸만 적는다. */
interface WebKitGestureEvent extends Event {
  scale: number;
  clientX?: number;
  clientY?: number;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  base: LightboxView;
  geometry: LightboxGeometry;
}

/** `<img>`에 펼치는 묶음. */
export interface LightboxPhotoBindings {
  ref: (node: HTMLImageElement | null) => void;
  zoomed: boolean;
  dragging: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLImageElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLImageElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLImageElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLImageElement>) => void;
  onDoubleClick: (event: ReactMouseEvent<HTMLImageElement>) => void;
}

export interface ImageLightboxZoom {
  /** 뷰어(대화상자 패널)에 단다: 휠·제스처를 여기서 받고, 이동 한계는 이 상자의 크기를 쓴다. */
  viewerRef: (node: HTMLElement | null) => void;
  photo: LightboxPhotoBindings;
  /** 렌더에 쓰는 값. 사건 처리 안에서는 `isZoomed()`를 읽는다(방금 바뀐 값을 바로 본다). */
  zoomed: boolean;
  isZoomed: () => boolean;
  /** 칩에 적을 글자. 없으면 칩이 서지 않는다. */
  chip: string | null;
  /** 맞춤으로 돌아간다(Esc·⌘0). */
  reset: () => void;
  /** ⌘+ ⌘- ⌘0. 먹었으면 `true`: 호출자가 `preventDefault`한다. */
  handleKey: (event: {
    key: string;
    code?: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
  }) => boolean;
}

/**
 * @param resetKey 이 값이 바뀌면 맞춤으로 돌아간다. 열린 사진의 id(닫혀 있으면 `null`)를 넘기면 다른 장으로 넘길 때도,
 *   닫았다 다시 열 때도 맞춤에서 시작한다.
 */
export function useImageLightboxZoom({ resetKey }: { resetKey: string | null }): ImageLightboxZoom {
  const viewerNode = useRef<HTMLElement | null>(null);
  const [viewer, setViewer] = useState<HTMLElement | null>(null);
  const photoNode = useRef<HTMLImageElement | null>(null);
  const view = useRef<LightboxView>(LIGHTBOX_FIT_VIEW);
  const drag = useRef<DragState | null>(null);
  const gesture = useRef<{ baseZoom: number } | null>(null);
  const chipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [chip, setChip] = useState<string | null>(null);

  const viewerRef = useCallback((node: HTMLElement | null) => {
    viewerNode.current = node;
    setViewer(node);
  }, []);

  const isZoomed = useCallback(() => !isLightboxFit(view.current.zoom), []);

  /** 맞춤 상태에서 그려진 너비 / 자연 너비. 자연 크기를 모르면(아직 디코드 전) `null`. */
  const fitScale = useCallback((): number | null => {
    const photo = photoNode.current;
    if (photo === null || photo.naturalWidth <= 0 || photo.offsetWidth <= 0) return null;
    return photo.offsetWidth / photo.naturalWidth;
  }, []);

  /**
   * 지금 치수. 사진 중심의 맞춤 자리는 변환된 상자의 중심에서 지금 이동량을 뺀 값이다(변환이 중심을 축으로 하므로
   * 배율은 중심을 옮기지 않는다). 레이아웃 크기(`offsetWidth`)는 변환의 영향을 받지 않는다.
   */
  const measure = useCallback((): { geometry: LightboxGeometry; left: number; top: number } | null => {
    const area = viewerNode.current?.getBoundingClientRect();
    const photo = photoNode.current;
    if (area === undefined || photo === null) return null;
    const box = photo.getBoundingClientRect();
    return {
      left: area.left,
      top: area.top,
      geometry: {
        photoWidth: photo.offsetWidth,
        photoHeight: photo.offsetHeight,
        centerX: box.left - area.left + box.width / 2 - view.current.x,
        centerY: box.top - area.top + box.height / 2 - view.current.y,
        viewWidth: area.width,
        viewHeight: area.height,
      },
    };
  }, []);

  const hideChip = useCallback(() => {
    if (chipTimer.current !== null) {
      clearTimeout(chipTimer.current);
      chipTimer.current = null;
    }
    setChip(null);
  }, []);

  const showChip = useCallback(
    (text: string) => {
      if (chipTimer.current !== null) clearTimeout(chipTimer.current);
      setChip(text);
      chipTimer.current = setTimeout(() => {
        chipTimer.current = null;
        setChip(null);
      }, ZOOM_CHIP_LINGER_MS);
    },
    []
  );

  /** 사진에 변환을 꽂는다. `smooth`일 때만 이행이 켜진다(띄엄띄엄한 단계). */
  const applyView = useCallback((node: HTMLImageElement, next: LightboxView, smooth: boolean) => {
    if (smooth) node.setAttribute("data-smooth", "");
    else node.removeAttribute("data-smooth");
    node.style.setProperty("--lightbox-zoom", String(next.zoom));
    node.style.setProperty("--lightbox-pan-x", `${next.x}px`);
    node.style.setProperty("--lightbox-pan-y", `${next.y}px`);
  }, []);

  const paint = useCallback(
    (next: LightboxView, smooth: boolean) => {
      view.current = next;
      if (photoNode.current !== null) applyView(photoNode.current, next, smooth);
      setZoomed(!isLightboxFit(next.zoom));
    },
    [applyView]
  );

  const photoRef = useCallback(
    (node: HTMLImageElement | null) => {
      photoNode.current = node;
      // 같은 사진의 노드가 다시 서도(불러오기 상태가 바뀔 때) 지금 변환을 그대로 입힌다.
      if (node !== null) applyView(node, view.current, false);
    },
    [applyView]
  );

  /** 배율을 바꾼다. `anchor`는 화면(client) 좌표이고, `null`이면 뷰어 한가운데다(키보드). */
  const zoomTo = useCallback(
    (nextZoom: number, anchor: { x: number; y: number } | null, smooth: boolean) => {
      const measured = measure();
      if (measured === null) return;
      const { geometry, left, top } = measured;
      const before = view.current;
      const point =
        anchor === null
          ? { x: geometry.viewWidth / 2, y: geometry.viewHeight / 2 }
          : { x: anchor.x - left, y: anchor.y - top };
      const next = zoomLightboxViewAt(before, nextZoom, point, geometry);
      if (next.zoom === before.zoom && next.x === before.x && next.y === before.y) return;
      paint(next, smooth);
      if (next.zoom !== before.zoom) showChip(lightboxZoomLabel(next.zoom, fitScale()));
    },
    [fitScale, measure, paint, showChip]
  );

  /** 맞춤으로. `announce`면 칩이 「맞춤」을 말한다. 이미 맞춤이어도 칩은 선다(키를 눌렀다는 답이다). */
  const fit = useCallback(
    (smooth: boolean, announce: boolean) => {
      const before = view.current;
      if (before.zoom !== LIGHTBOX_FIT_VIEW.zoom || before.x !== 0 || before.y !== 0) paint(LIGHTBOX_FIT_VIEW, smooth);
      if (announce) showChip(lightboxZoomLabel(LIGHTBOX_FIT_VIEW.zoom, fitScale()));
    },
    [fitScale, paint, showChip]
  );

  const reset = useCallback(() => fit(true, true), [fit]);

  const handleKey = useCallback<ImageLightboxZoom["handleKey"]>(
    (event) => {
      if (photoNode.current === null) return false;
      const action = lightboxZoomKeyAction(event);
      if (action === null) return false;
      if (action === "fit") fit(true, true);
      else zoomTo(stepLightboxZoom(view.current.zoom, action === "in" ? 1 : -1), null, true);
      return true;
    },
    [fit, zoomTo]
  );

  // 다른 장으로 넘기거나 닫았다 다시 열면 맞춤에서 시작한다. 사진 노드는 장마다 새로 서므로(`key`) 옛 변수가 남지 않는다.
  useLayoutEffect(() => {
    drag.current = null;
    gesture.current = null;
    paint(LIGHTBOX_FIT_VIEW, false);
    setDragging(false);
    hideChip();
  }, [resetKey, paint, hideChip]);

  useEffect(
    () => () => {
      if (chipTimer.current !== null) clearTimeout(chipTimer.current);
    },
    []
  );

  // 휠·제스처는 네이티브로 뷰어에 단다(위 머리말: React의 `onWheel`은 passive라 브라우저 확대를 못 막는다).
  useEffect(() => {
    if (viewer === null) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      if (gesture.current !== null) return;
      zoomTo(
        view.current.zoom * lightboxWheelFactor(event.deltaY, event.deltaMode),
        { x: event.clientX, y: event.clientY },
        false
      );
    };
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gesture.current = { baseZoom: view.current.zoom };
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const active = gesture.current;
      if (active === null) return;
      const { scale, clientX, clientY } = event as WebKitGestureEvent;
      if (!Number.isFinite(scale)) return;
      const anchor =
        typeof clientX === "number" && typeof clientY === "number" ? { x: clientX, y: clientY } : null;
      zoomTo(active.baseZoom * scale, anchor, false);
    };
    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      gesture.current = null;
    };
    viewer.addEventListener("wheel", onWheel, { passive: false });
    viewer.addEventListener("gesturestart", onGestureStart);
    viewer.addEventListener("gesturechange", onGestureChange);
    viewer.addEventListener("gestureend", onGestureEnd);
    return () => {
      viewer.removeEventListener("wheel", onWheel);
      viewer.removeEventListener("gesturestart", onGestureStart);
      viewer.removeEventListener("gesturechange", onGestureChange);
      viewer.removeEventListener("gestureend", onGestureEnd);
    };
  }, [viewer, zoomTo]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLImageElement>) => {
      if (event.button !== 0 || !isZoomed()) return;
      const measured = measure();
      if (measured === null) return;
      drag.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        base: view.current,
        geometry: measured.geometry,
      };
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // 이미 사라진 포인터이거나 합성 사건이면 캡처 없이 끈다: 사진 위에서 움직이는 동안은 그대로 된다.
      }
      setDragging(true);
    },
    [isZoomed, measure]
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLImageElement>) => {
      const active = drag.current;
      if (active === null || event.pointerId !== active.pointerId) return;
      paint(
        clampLightboxView(
          {
            zoom: active.base.zoom,
            x: active.base.x + (event.clientX - active.startX),
            y: active.base.y + (event.clientY - active.startY),
          },
          active.geometry
        ),
        false
      );
    },
    [paint]
  );

  const endDrag = useCallback((event: ReactPointerEvent<HTMLImageElement>) => {
    const active = drag.current;
    if (active === null || event.pointerId !== active.pointerId) return;
    drag.current = null;
    setDragging(false);
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // 캡처가 이미 풀렸다: 할 일이 없다.
    }
  }, []);

  const onDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLImageElement>) => {
      if (isZoomed()) {
        fit(true, true);
        return;
      }
      zoomTo(lightboxActualSizeZoom(fitScale()), { x: event.clientX, y: event.clientY }, true);
    },
    [fit, fitScale, isZoomed, zoomTo]
  );

  return {
    viewerRef,
    zoomed,
    isZoomed,
    chip,
    reset,
    handleKey,
    photo: {
      ref: photoRef,
      zoomed,
      dragging,
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onDoubleClick,
    },
  };
}
