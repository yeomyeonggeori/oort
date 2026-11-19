import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/design/lib/cn";
import { tooltipGroup } from "./tooltipGroup";
import { TOOLTIP_DELAY_MS, TOOLTIP_MOTION } from "@/design/motion";
import { clipRange, fitTooltipElement, TOOLTIP_EDGE_PAD } from "./tooltipFit";

// 공용 툴팁 (#4324). Buzz `shared/ui/tooltip.tsx`의 동작을 우리 토큰으로 옮긴 것이다.
//
// Radix Tooltip을 쓰지 않는 이유: 의존을 새로 들이지 않고(NOTICE·잠금 파일), 이 코드베이스의
// 줄 도구 막대는 이미 자기 로빙 그룹(`data-row-action`)을 가져 래퍼가 포커스를 가져가면 안 된다.
// 래퍼는 포커스도 탭 정거장도 만들지 않는 `span`이고, 트리거는 자식 그대로다.
//
// 동작
//   · 처음 가리키면 `TOOLTIP_DELAY_MS` 뒤에 뜬다(그 전에 나가면 안 뜬다: 지나가는 포인터를 거른다). 툴팁이 떠 있거나 방금
//     닫혔으면(`TOOLTIP_SKIP_DELAY_MS` 안) 옮겨 간 트리거는 지연 없이 바로 뜬다(`tooltipGroup.ts`). 터치 포인터는 띄우지 않는다.
//   · 키보드 초점(`:focus-visible`)은 지연 없이 즉시 뜬다. 마우스 클릭으로 간 초점은 띄우지 않는다.
//   · 눌리면·포인터가 나가면·초점이 나가면·Esc면 닫는다. **보이는 닫힘은 즉시다**(나타남만 모션이 있다).
//     눌림·나감·Esc는 노드도 그 자리에서 뗀다. **초점이 나가서 닫힐 때만** 노드를 같은 커밋에 `hidden`으로 숨기고(그 프레임부터
//     안 보인다) 한 박자 뒤(`setTimeout 0`, 초점 이동이 끝난 다음)에 뗀다(#5780 검수 r1 B1): Tab으로 초점이 옮겨 가는 도중(blur
//     안, `activeElement`는 body)에 노드가 사라지면 모달의 초점 가둠(Radix FocusScope의 MutationObserver)이 「초점을 잃었다」고
//     보고 초점을 대화상자 상자로 끌어가, Tab이 다음 컨트롤에 닿지 못한다. 속성 바꾸기는 그 관찰자가 보지 않는다.
//     숨긴 노드는 `data-testid="tooltip"`을 내려놓고 `data-tooltip-leaving`을 단다: 바깥에서 보면 툴팁은 그 순간 없다.
//   · 트리거가 이미 `aria-label`로 같은 이름을 갖는다. 툴팁은 눈으로 보는 보조라
//     `aria-hidden`이고 `aria-describedby`로 이름을 두 번 읽히게 하지 않는다.
//   · 면은 `tooltip-surface`(연회색 둥근 알약: `--muted-soft` 한 면, 선도 그림자도 없다, 12×6), 간격 4(`mb-1`/`mt-1`),
//     위/아래 두 방향이다. 대화 머리 단추는 전부 이 부품을 **아래 방향**으로 쓴다(#4591): 본문 판이 `overflow: clip`이라
//     위로는 잘린다. 단추에 네이티브 `title`을 같이 두지 않는다(둘이 같이 뜬다). 규칙의 문서는 design-system §2.9.
//   · 띠 안(셸의 상단 줄 오른쪽 자리의 다운로드 단추, #4587)에서도 같은 부품이다: 알약의 글자는 `--ink-base`라서 띠 범위가
//     `--ink`를 on-band로 다시 묶어도 면과 짝이 맞는다(`tooltip-surface`, tokens.css).
//   · 자기를 가둔 판 안에 머문다(#4230). 툴팁은 포털이 아니라 이 자리에 그려지므로 판이 `overflow: clip`이면 가장자리를 넘는 글자가
//     잘린다. 열릴 때 한 번 재서 판(과 창) 안으로 밀어 넣고, 판보다 넓으면 판 폭에서 줄바꿈한다(`tooltipFit.ts`).

/**
 * `right`는 트리거 오른쪽 바깥에 한 줄로 서고, 자르는 조상(좁은 레일의 `overflow-x-hidden` 등) 밖으로 나가려고 `document.body`로 그린다(#5779).
 * 위치는 열릴 때 한 번 재어 CSS 변수로 넘긴다(`--tooltip-x`·`--tooltip-y`, `tooltip-surface[data-fixed]`가 읽는다). `top`·`bottom`의 동작은 그대로다.
 */
export type TooltipSide = "top" | "bottom" | "right";

/** 위·아래 알약과 트리거 사이의 틈(px). 감싸개 안에 그릴 때의 `mb-1`/`mt-1`과 같은 4다. `portal`의 자리 계산이 쓴다. */
const TOOLTIP_GAP = 4;

/** 트리거 기준 가로 정렬. `end`는 오른쪽 끝을 트리거 오른쪽 끝에 맞춘다(가장자리 단추의 툴팁이 잘리지 않게). */
export type TooltipAlign = "center" | "end";

interface TooltipProps {
  /** 비었거나(`undefined`·`""`) 없으면 툴팁은 뜨지 않고 감싸개만 남는다(이유가 있을 때만 이름이 있는 단추: 막힘 사유 등). */
  label: string | undefined;
  side?: TooltipSide;
  align?: TooltipAlign;
  /**
   * `top`·`bottom`도 `right`처럼 `document.body`에 창 기준으로 그린다(#5980). 트리거가 자르는 조상 안에 있어 위로도 아래로도
   * 알약이 잘리는 자리(이모티콘 창의 가로 스크롤 묶음 띠)에만 켠다. 기본은 끔이라 다른 자리의 마크업·동작은 그대로다.
   * 켜면 알약은 떠 있는 표면(`layer-overlay-surface`, 팝오버 위)에 서고, 가로는 창 안으로 민다. 조상이 스크롤하면 다시 재고,
   * 트리거가 그 조상의 보이는 폭 밖으로 나가면 닫는다.
   */
  portal?: boolean;
  /** 처음부터 떠 있게 한다(갤러리·캡처 전용). 평소는 가리키거나 키보드 초점일 때만 뜬다. */
  defaultOpen?: boolean;
  /** 지연 덮어쓰기. 시험이 쓴다. 기본은 `TOOLTIP_DELAY_MS`. */
  delayMs?: number;
  className?: string;
  children: React.ReactNode;
}

/** 면의 클래스. `rowSurface.browser.test.ts`가 이 상수를 그대로 엔진에 먹여 계산된 값을 잰다. */
export const TOOLTIP_CLASS =
  "tooltip-surface layer-content-float absolute left-1/2 -translate-x-1/2 text-meta";

/** `align="end"`: 가운데 정렬 두 클래스를 덮는다(`cn`의 merge가 같은 그룹을 뒤 것으로 접는다). */
export const TOOLTIP_END_CLASS = "left-auto right-0 translate-x-0";

export const TOOLTIP_SIDE_CLASS: Record<TooltipSide, string> = {
  top: "bottom-full mb-1",
  bottom: "top-full mt-1",
  right: "",
};

function isKeyboardFocus(target: EventTarget): boolean {
  if (!(target instanceof HTMLElement)) return true;
  try {
    return target.matches(":focus-visible");
  } catch {
    return true;
  }
}

export function Tooltip({
  label,
  side = "top",
  align = "center",
  portal = false,
  defaultOpen = false,
  delayMs = TOOLTIP_DELAY_MS,
  className,
  children,
}: TooltipProps) {
  const enabled = label !== undefined && label !== "";
  const [open, setOpen] = React.useState(defaultOpen && enabled);
  // 초점이 나가며 닫힌 툴팁이 숨긴 채 남아 있는 한 박자(머리말 「보이는 닫힘은 즉시다」). 보이는지는 `open`만 정한다.
  const [leaving, setLeaving] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const tipRef = React.useRef<HTMLSpanElement>(null);
  const wrapRef = React.useRef<HTMLSpanElement>(null);

  // 그려진 뒤 칠하기 전에 잰다: 한 프레임도 가장자리를 넘은 채로 보이지 않는다.
  React.useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!open || tip === null) return;
    if (side !== "right" && !portal) {
      fitTooltipElement(tip, align);
      return;
    }
    const anchor = wrapRef.current;
    if (anchor === null) return;
    const pad = TOOLTIP_EDGE_PAD;
    // 창 기준 자리. 크기는 `offset*`로 읽는다(나타남 애니메이션의 축소가 상자에 섞이지 않게).
    const place = () => {
      const box = anchor.getBoundingClientRect();
      const width = tip.offsetWidth;
      const height = tip.offsetHeight;
      const x =
        side === "right"
          ? Math.min(box.right + pad, Math.max(pad, window.innerWidth - width - pad))
          : Math.min(Math.max(pad, box.left + box.width / 2 - width / 2), Math.max(pad, window.innerWidth - width - pad));
      const natural =
        side === "right"
          ? box.top + box.height / 2 - height / 2
          : side === "top"
            ? box.top - height - TOOLTIP_GAP
            : box.bottom + TOOLTIP_GAP;
      const y = Math.min(Math.max(pad, natural), Math.max(pad, window.innerHeight - height - pad));
      tip.style.setProperty("--tooltip-x", String(Math.round(x)));
      tip.style.setProperty("--tooltip-y", String(Math.round(y)));
    };
    place();
    if (!portal) return;
    // 트리거를 품은 조상이 스크롤하면(띠를 가로로 밀기, 키보드 초점이 띠를 미는 것 포함) 알약이 따라간다. 트리거의 가운데가 자르는
    // 조상의 보이는 폭 밖으로 나가면 가리킬 것이 안 보이므로 닫는다.
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node) || !event.target.contains(anchor)) return;
      const box = anchor.getBoundingClientRect();
      const middle = box.left + box.width / 2;
      const range = clipRange(anchor);
      if (middle < range.left || middle > range.right) {
        setOpen(false);
        return;
      }
      place();
    };
    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, [open, label, align, side, portal]);

  const clear = React.useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  const close = React.useCallback(() => {
    clear();
    setOpen(false);
    setLeaving(false);
  }, [clear]);
  // 초점이 나갈 때: 보이는 것은 지금 닫고, 노드는 초점 이동이 끝난 뒤에 뗀다(머리말). 그 사이 다시 열리면 `clear`가 떼기를 취소한다.
  const closeOnBlur = React.useCallback(() => {
    clear();
    // 보이던 툴팁도, 숨긴 채 남은 노드도 없으면 DOM 에는 아무 일도 없다(전과 같다: 마우스로 간 초점의 blur 등).
    // 숨긴 채 남아 있는데 다시 blur 가 오면 `clear` 가 걷은 떼기를 아래에서 다시 건다(노드가 남지 않게).
    if (!open && !leaving) return;
    setOpen(false);
    setLeaving(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setLeaving(false);
    }, 0);
  }, [clear, open, leaving]);
  React.useEffect(() => clear, [clear]);
  // 떠 있는 동안 무리에 「떠 있음」을 알린다. 정리 함수가 닫힘·언마운트를 모두 맡는다(포인터가 나가서 닫히든, 트리거가 사라져
  // 닫히든 같은 길이다). 지연 없는 옮겨 가기는 이 기록에서 나온다.
  React.useEffect(() => {
    if (!open) return undefined;
    tooltipGroup.opened();
    return () => tooltipGroup.closed();
  }, [open]);
  React.useEffect(() => tooltipGroup.attach(), []);

  const renderTip = () => {
    const fixed = side === "right" || portal;
    const tip = (
      <span
        ref={tipRef}
        hidden={!open}
        aria-hidden="true"
        // 숨긴 채 남은 한 박자의 노드는 「툴팁」으로 세지 않는다: 시험·게이트·캡처의 `[data-testid="tooltip"]`은 보이는 것만 본다.
        data-testid={open ? "tooltip" : undefined}
        data-tooltip-leaving={open ? undefined : ""}
        data-side={side}
        data-fixed={fixed ? "" : undefined}
        className={
          fixed
            ? cn("tooltip-surface text-meta", portal ? "layer-overlay-surface" : "layer-content-float", TOOLTIP_MOTION)
            : cn(TOOLTIP_CLASS, TOOLTIP_SIDE_CLASS[side], TOOLTIP_MOTION, align === "end" && TOOLTIP_END_CLASS)
        }
      >
        {label}
      </span>
    );
    return fixed ? createPortal(tip, document.body) : tip;
  };

  return (
    <span
      ref={wrapRef}
      className={cn("relative inline-flex", className)}
      onPointerEnter={(event) => {
        if (event.pointerType === "touch" || !enabled) return;
        clear();
        const wait = tooltipGroup.delayFor(delayMs);
        if (wait <= 0) {
          setOpen(true);
          return;
        }
        timer.current = setTimeout(() => {
          timer.current = null;
          setOpen(true);
        }, wait);
      }}
      onPointerLeave={close}
      onPointerDown={close}
      onFocus={(event) => {
        if (!enabled || !isKeyboardFocus(event.target)) return;
        clear();
        setOpen(true);
      }}
      onBlur={closeOnBlur}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      {children}
      {enabled && (open || leaving) && renderTip()}
    </span>
  );
}
