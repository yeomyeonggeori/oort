import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";

// =============================================================================
// 사이드바 끌어다 놓기 (BT-5 / #1933, ADR-0177 D5).
//
// 두 가지를 끈다: **채널 행**(어느 섹션에 속하는가)과 **커스텀 섹션 머리글**
// (섹션끼리의 차례). 둘 다 payload 를 바꾸므로 저장은 언제나 `useSidebarPrefs`
// 의 변경 함수를 지나간다 — 이 파일은 「무엇이 어디에 떨어졌는가」만 답한다.
//
// ## 라이브러리를 들이지 않는다
//
// 훔쳐 온 원본(buzz `desktop/src/features/sidebar/ui/SidebarDnd.tsx`)은
// `@dnd-kit/core` + `@dnd-kit/sortable` 위에 서 있다. 여기서는 그 구조만 가져오고
// 라이브러리는 가져오지 않는다: 이 레포에는 dnd 의존성이 하나도 없고
// (`clients/web/package.json`), 사이드바 재정렬 하나 때문에 새 런타임 의존성과
// 그것의 시각 언어를 통째로 들이는 것은 값이 맞지 않는다. dnd-kit 이 파는 것은
// **좌표 충돌 판정**(포인터가 지금 어느 상자 위인가)인데, 여기서 필요한 답은
// 브라우저가 이미 `dragover`/`drop` 의 **대상 요소**로 공짜로 준다.
//
// 그래서 HTML5 네이티브 드래그다. 결과가 하나 더 따라온다: 판정의 정본이
// 좌표가 아니라 요소라서 **jsdom 에서 그대로 시험된다** — 실 DOM 에 이벤트를
// 쏘면 같은 코드가 같은 답을 낸다(`elementFromPoint` 도 `getBoundingClientRect`
// 도 jsdom 에서는 0을 돌려주므로, 좌표 기반이었다면 이 계약은 브라우저에서만
// 참인 계약이 됐을 것이다).
//
// ## 키보드가 같은 결과에 닿는다
//
// 끌어다 놓기는 **두 번째** 문이다(BT-5 계약 3항). 배치는 행 메뉴의 「섹션으로
// 이동」 라디오 무리가, 섹션 차례는 섹션 ⋮ 의 「위로/아래로」가 같은 코어 변경
// 함수를 부른다. 이 파일이 사라져도 두 기능은 전부 도달 가능하다 — 그것이
// 포인터 전용 기능을 만들지 않는다는 뜻이다.
//
// 터치(`hover: none`)에는 이 문이 없다. HTML5 드래그는 손가락에 발화하지 않고,
// 서랍의 세로 스크롤이 행을 누른 채 시작하기 때문이다(BT-1 이 행 컨텍스트
// 메뉴를 같은 이유로 닫아 둔 자리). 그 사실은 이미 표면이 말하고 있다 —
// `sidebarEmptySectionHint(false)`: 「채널은 넓은 화면에서 옮길 수 있습니다.」
// =============================================================================

/** 지금 끌고 있는 것. */
export type SidebarDragSubject =
  | {
      kind: "channel";
      channelId: string;
      /** 지금 속한 커스텀 섹션. 기본 「채널」이면 `null`. */
      sectionId: string | null;
    }
  | { kind: "section"; sectionId: string };

/**
 * 떨어뜨릴 수 있는 자리 하나. 섹션이 자기 몫으로 하나씩 이고 있다.
 *
 * `kind` 가 코어의 `SidebarSectionKind` 와 같은 낱말인 것은 우연이 아니다 —
 * 이 구역이 무엇을 뜻하는지는 그 섹션이 무엇인지가 정한다. DM 섹션은 이 목록에
 * 없다: DM 은 커스텀 섹션에 들어가지 않고(ADR-0177 D4), 받을 수 없는 자리를
 * 드롭 대상으로 세우면 「떨어뜨렸는데 아무 일도 없다」가 된다.
 */
export interface SidebarDropZone {
  kind: "starred" | "channels" | "custom";
  /** 커스텀 섹션이면 그 id. 기본 「채널」·「별표」는 `null`. */
  sectionId: string | null;
}

/** 떨어진 결과. 전부 코어 변경 함수 하나에 대응한다. */
export type SidebarDropAction =
  | { type: "place"; channelId: string; sectionId: string | null }
  | { type: "star"; channelId: string }
  | { type: "reorder"; sectionId: string; targetId: string };

/** 표지가 어느 구역에 서 있는지 세는 열쇠. 커스텀은 id 로 갈린다. */
export function sidebarDropZoneKey(zone: SidebarDropZone): string {
  return zone.kind === "custom" ? `custom:${zone.sectionId}` : zone.kind;
}

/**
 * 이 드롭이 뜻하는 일. **없으면 `null`** 이고, `null` 인 자리는 표지도 서지
 * 않는다 — 받지 않는 자리가 받을 것처럼 보이면 그 드래그는 실패로 끝난다.
 *
 * 판정 넷:
 *
 *   1. 채널 → 「별표」 = 별표를 붙인다. 배치는 그대로 두고 렌더 순위만 올린다
 *      (`toggleStarredChannel`).
 *   2. 채널 → 기본/커스텀 섹션 = 배치를 바꾼다. **이미 그 섹션이면 `null`** -
 *      같은 자리에 다시 넣는 것은 payload 상 「뺐다가 맨 뒤에 붙이기」라 차례가
 *      말없이 바뀌고 저장 한 번이 헛나간다.
 *   3. 섹션 → 커스텀 섹션 = 그 섹션이 서 있던 자리로 옮긴다. 기본·별표 섹션은
 *      차례가 고정이라 자리를 내주지 않는다.
 *   4. 그 밖(섹션을 별표 위로, 자기 자신 위로) = `null`.
 */
export function resolveSidebarDrop(
  subject: SidebarDragSubject | null,
  zone: SidebarDropZone | null
): SidebarDropAction | null {
  if (subject === null || zone === null) return null;
  if (subject.kind === "channel") {
    if (zone.kind === "starred") {
      return { type: "star", channelId: subject.channelId };
    }
    if (zone.sectionId === subject.sectionId) return null;
    return {
      type: "place",
      channelId: subject.channelId,
      sectionId: zone.sectionId,
    };
  }
  if (zone.kind !== "custom" || zone.sectionId === null) return null;
  if (zone.sectionId === subject.sectionId) return null;
  return {
    type: "reorder",
    sectionId: subject.sectionId,
    targetId: zone.sectionId,
  };
}

/** 끄는 쪽이 요소에 다는 것. */
export interface SidebarDragHandleProps {
  draggable: true;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}

/** 받는 쪽이 요소에 다는 것. */
export interface SidebarDropZoneProps {
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  /** 표지. 있는 동안 그 구역이 「여기에 놓인다」고 말한다. */
  "data-drop-target"?: "";
}

export interface SidebarDragController {
  /** 끌고 있는 것. `null` 이면 아무 일도 일어나고 있지 않다. */
  subject: SidebarDragSubject | null;
  dragProps: (subject: SidebarDragSubject) => SidebarDragHandleProps | undefined;
  dropProps: (zone: SidebarDropZone) => SidebarDropZoneProps | undefined;
}

/**
 * 드래그 한 번의 수명. 상태는 둘뿐이다 — 무엇을 끄는가, 어느 구역 위인가.
 *
 * `enabled` 가 거짓이면 **프롭 자체를 내주지 않는다**(`undefined`). 속성을 달고
 * 핸들러에서 무시하는 길도 있지만, 그러면 `draggable` 이 DOM 에 남아 손잡이가
 * 있는 것처럼 보인다 — 배치를 읽지 못한 상태와 터치 표면이 정확히 그 자리다.
 */
export function useSidebarDrag({
  enabled,
  onDrop,
}: {
  enabled: boolean;
  onDrop: (action: SidebarDropAction) => void;
}): SidebarDragController {
  const [subject, setSubject] = useState<SidebarDragSubject | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  const clear = useCallback(() => {
    setSubject(null);
    setOverKey(null);
  }, []);

  // 문이 닫히면 들고 있던 것도 내려놓는다. 배치를 못 읽게 된 순간(부트스트랩
  // 실패 뒤 재조회)에 드래그가 살아 있으면, 그 드롭은 쓰기가 막힌 훅에 닿는다.
  useEffect(() => {
    if (!enabled) clear();
  }, [enabled, clear]);

  // **Esc 는 드래그의 것이다.** 브라우저도 네이티브 드래그를 Esc 로 취소하고
  // `dragend` 를 쏘지만, 그 신호가 오지 않는 경로(드래그가 창을 벗어난 채 끝나는
  // 것)가 있어 상태가 남는다. 잡아 두고 `stopPropagation` 하는 이유는 그 한 번의
  // Esc 가 아래 층(폰 서랍·다이얼로그)까지 내려가면 취소 하나가 두 가지 일을
  // 하기 때문이다 — `escapeLayer.ts` 의 층 문법과 같은 규율이고, 여기서는 층을
  // 세우는 대신 드래그가 살아 있는 동안만 캡처한다.
  useEffect(() => {
    if (subject === null) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      clear();
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [subject, clear]);

  const dragProps = useCallback(
    (next: SidebarDragSubject): SidebarDragHandleProps | undefined => {
      if (!enabled) return undefined;
      return {
        draggable: true,
        onDragStart: (event) => {
          // Firefox 는 `setData` 없이는 드래그를 시작하지 않는다. 옵셔널 체이닝인
          // 이유는 jsdom 에 `DataTransfer` 가 없기 때문이고, 그것이 이 파일의
          // 시험이 실 DOM 에서 도는 값이다.
          event.dataTransfer?.setData(
            "text/plain",
            next.kind === "channel" ? next.channelId : next.sectionId
          );
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
          setSubject(next);
        },
        onDragEnd: clear,
      };
    },
    [enabled, clear]
  );

  const dropProps = useCallback(
    (zone: SidebarDropZone): SidebarDropZoneProps | undefined => {
      if (!enabled) return undefined;
      const key = sidebarDropZoneKey(zone);
      const accepts = resolveSidebarDrop(subject, zone) !== null;
      return {
        onDragOver: (event) => {
          if (!accepts) return;
          // `preventDefault` 가 곧 「여기는 받는다」다. 이것이 없으면 브라우저는
          // 금지 커서를 그리고 `drop` 을 쏘지 않는다.
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
          setOverKey((current) => (current === key ? current : key));
        },
        onDragLeave: (event) => {
          // 자식 요소로 옮겨 간 것은 이 구역을 떠난 것이 아니다. 행 하나를
          // 지날 때마다 표지가 깜빡이면 그것은 표지가 아니라 잡음이다.
          const next = event.relatedTarget;
          if (next instanceof Node && event.currentTarget.contains(next)) return;
          setOverKey((current) => (current === key ? null : current));
        },
        onDrop: (event) => {
          const action = resolveSidebarDrop(subject, zone);
          clear();
          if (action === null) return;
          event.preventDefault();
          onDrop(action);
        },
        ...(accepts && overKey === key ? { "data-drop-target": "" as const } : {}),
      };
    },
    [enabled, subject, overKey, clear, onDrop]
  );

  return useMemo(
    () => ({ subject, dragProps, dropProps }),
    [subject, dragProps, dropProps]
  );
}
