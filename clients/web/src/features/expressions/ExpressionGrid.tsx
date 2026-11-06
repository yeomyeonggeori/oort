import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Clock, Star, type LucideIcon } from "lucide-react";
import {
  EXPRESSION_GRID_COLS,
  EXPRESSION_SECTION_NAME_KEY,
  moveGridPosition,
  RESULTS_SECTION,
  type ExpressionSection,
  type ExpressionSectionKind,
  type GridPosition,
} from "@momo/core/features/expressions/gridSections";
import type { Expression } from "@momo/core/features/expressions/types";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/design/ui/context-menu";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { ExpressionImage } from "./ExpressionImage";

// =============================================================================
// 이모티콘·GIF 탭의 그림 격자와 세트 띠 (owner 2026-11-07, #5453). 카카오톡처럼 **그림만** 보인다: 이름·`:코드:`·안내 글이 격자에 없다
// (낭독 이름과 마우스를 올렸을 때의 `title`에만 있다). 모델(구역·방향키)은 코어 `gridSections` 이고 이 파일은 화면에 세우고 키를 받는 일만 한다.
//
// 격자: 구역(최근 -> 즐겨찾기 -> 세트별 -> 기타)마다 6열. 구역이 하나뿐이면 이름줄도 없다. 칸은 누르면 고르고(`onPick`), 오른쪽 클릭·길게 누르기·메뉴 키는
// 항목 메뉴(`menu`)를 연다 - 즐겨찾기·신고·삭제는 호스트가 준다. 칸마다 `data-manage` 로 항목을 가리키므로 호스트가 닫힌 뒤 초점을 칸으로 돌려줄 수 있다.
// 키보드: 한 칸만 탭 순서에 있고(`tabIndex` 0, 나머지 -1), 방향키가 구역을 이어 붙인 격자 위에서 움직인다. Enter/Space 는 단추의 기본 동작이다.
//
// 세트 띠: 최근 · 즐겨찾기 · 세트마다 첫 그림 · 기타. 누르면 그 구역으로 스크롤한다(`aria-current` 가 지금 구역). 띠 끝의 `trailing`(＋)은 호스트가 준다.
// 검색 결과(구역 하나)에는 띠가 없다.
//
// 직접 문구 장부 때문에 이 파일의 글자와 클래스는 속성 문자열이거나 사전 열쇠다 - 상태 모양은 속성 선택자(`expressions.css`)가 입힌다.
// =============================================================================

const FIRST: GridPosition = { section: 0, index: 0 };
const SECTION_ICON: Partial<Record<ExpressionSectionKind, LucideIcon>> = { recent: Clock, favorites: Star };
const cellSelector = (position: GridPosition) => `[data-pos="${position.section}:${position.index}"]`;
const SECTION_SELECTOR = "[data-section]";
/** 단추로 건너뛴 뒤 스크롤 이벤트가 지금 구역 표시를 되돌리지 못하는 시간(ms). */
const JUMP_LOCK_MS = 600;
const sectionSelector = (id: string) => `[data-section="${id}"]`;

/** 구역이 줄어도 (예: 검색, 삭제) 가리키는 자리가 격자 안에 남게 한다. */
function clampPosition(position: GridPosition, sizes: readonly number[]): GridPosition {
  const section = Math.min(position.section, Math.max(0, sizes.length - 1));
  return { section, index: Math.min(position.index, Math.max(0, (sizes[section] ?? 1) - 1)) };
}

export function ExpressionGrid({ sections, empty, cellLabel, disabled, onPick, menu, onMenuCloseAutoFocus, containerRef, trailing }: {
  sections: readonly ExpressionSection[];
  /** 구역이 하나도 없을 때(보관함이 비었거나 검색이 아무것도 못 맞췄을 때) 격자 자리에 서는 것. 띠(＋)는 그래도 선다. */
  empty: ReactNode;
  /** 칸의 낭독 이름. */
  cellLabel: (item: Expression) => string;
  disabled: boolean;
  onPick: (item: Expression) => void;
  /** 칸의 항목 메뉴(오른쪽 클릭·길게 누르기)의 내용. */
  menu: (item: Expression) => ReactNode;
  /** 메뉴가 닫히며 초점을 돌려줄 때(Radix) 호스트가 막을 수 있다 - 고른 항목이 이 격자를 내리고 제 단계를 세우면 초점은 호스트가 정한다. */
  onMenuCloseAutoFocus?: (event: Event) => void;
  /** 스크롤하는 상자. 호스트가 닫힌 뒤 초점을 돌려주려고 읽는다. */
  containerRef: RefObject<HTMLDivElement>;
  /** 세트 띠의 끝(＋). */
  trailing: ReactNode;
}) {
  const formatMessage = useFormatMessage();
  const headId = useId();
  const [active, setActive] = useState<GridPosition>(FIRST);
  const [current, setCurrent] = useState<string | null>(null);
  const moved = useRef(false);
  const lockUntil = useRef(0);
  const sizes = sections.map((section) => section.items.length);
  const here = clampPosition(active, sizes);
  const nameOf = (section: ExpressionSection) => {
    const key = EXPRESSION_SECTION_NAME_KEY[section.kind];
    return key === null ? (section.label ?? "") : formatMessage(key);
  };
  // 이름줄은 구역이 둘 이상일 때만 선다: 구역 하나를 「기타」로 부르면 구역을 나눈 것이 아니라 이름만 붙인 것이다.
  const named = sections.length > 1;
  // 건너뛸 곳이 둘 이상일 때만 단추가 선다: 검색 결과(구역 하나)나 구역 하나에는 띠가 ＋만 갖는다(＋는 늘 선다 - 빈 보관함에서도 올리는 길이 있어야 한다).
  const stripped = sections.filter((section) => section.id !== RESULTS_SECTION);
  const jumps = stripped.length > 1 ? stripped : [];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // 항목 메뉴는 포털에 서지만 React 이벤트는 이 상자까지 올라온다 - 메뉴 안의 방향키는 격자를 움직이지 않는다.
    if (!event.currentTarget.contains(event.target as Node)) return;
    const next = moveGridPosition(sizes, here, event.key, EXPRESSION_GRID_COLS);
    if (next === null) return;
    event.preventDefault();
    moved.current = true;
    setActive(next);
  };
  useLayoutEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    containerRef.current?.querySelector<HTMLElement>(cellSelector(here))?.focus();
  }, [here, containerRef]);

  const jump = (id: string) => {
    const box = containerRef.current;
    const target = box?.querySelector<HTMLElement>(sectionSelector(id));
    if (!box || !target) return;
    box.scrollTop = target.offsetTop;
    setCurrent(id);
    // 끝까지 스크롤해도 그 구역의 윗머리가 맨 위에 못 닿으면(마지막 구역들) 뒤따르는 스크롤 이벤트가 앞 구역을 가리킨다 - 눌린 단추가 잠깐 표시를 쥔다.
    lockUntil.current = performance.now() + JUMP_LOCK_MS;
  };
  const onScroll = () => {
    const box = containerRef.current;
    if (!box || performance.now() < lockUntil.current) return;
    const nodes = [...box.querySelectorAll<HTMLElement>(SECTION_SELECTOR)];
    let at = sections[0]?.id ?? null;
    for (const node of nodes) if (node.offsetTop <= box.scrollTop + 1) at = node.dataset.section ?? at;
    // 맨 아래까지 내려왔으면 마지막 구역이 지금 구역이다.
    if (box.scrollHeight > box.clientHeight && box.scrollTop + box.clientHeight >= box.scrollHeight - 1) at = nodes.at(-1)?.dataset.section ?? at;
    setCurrent(at);
  };
  const markedId = current ?? sections[0]?.id ?? null;

  return (
    <>
      {sections.length === 0 ? empty : <div
        ref={containerRef}
        role="group"
        aria-label={formatMessage("expressions.picker.grid")}
        data-testid="expression-grid"
        className="relative flex min-h-0 max-h-pane flex-col gap-3 overflow-y-auto"
        onKeyDown={onKeyDown}
        onScroll={onScroll}
      >
        {sections.map((section, sectionIndex) => (
          <div key={section.id} role="group" data-section={section.id} aria-labelledby={named ? `${headId}${section.id}` : undefined}>
            {named && <p id={`${headId}${section.id}`} className="mb-1 px-1 text-meta text-ink-muted">{nameOf(section)}</p>}
            <div className="grid grid-cols-6 gap-1">
              {section.items.map((item, index) => {
                const position: GridPosition = { section: sectionIndex, index };
                const isHere = here.section === sectionIndex && here.index === index;
                return (
                  <ContextMenu key={item.id}>
                    <ContextMenuTrigger asChild>
                      <button
                        type="button"
                        disabled={disabled}
                        tabIndex={isHere ? 0 : -1}
                        aria-label={cellLabel(item)}
                        title={item.displayName}
                        data-manage={item.id}
                        data-pos={`${position.section}:${position.index}`}
                        className="expression-grid-cell tap-target flex aspect-square w-full items-center justify-center overflow-hidden rounded-sm p-1 press hover:bg-surface-hover focus-visible:focus-ring disabled:opacity-50"
                        onFocus={() => setActive(position)}
                        onClick={() => onPick(item)}
                      >
                        <ExpressionImage item={item} size="medium" still />
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent onCloseAutoFocus={onMenuCloseAutoFocus}>{menu(item)}</ContextMenuContent>
                  </ContextMenu>
                );
              })}
            </div>
          </div>
        ))}
      </div>}
      <div role="group" aria-label={formatMessage("expressions.picker.setStrip")} data-testid="expression-set-strip" className="flex items-center gap-1 border-t border-line pt-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {jumps.map((section) => {
            const Icon = SECTION_ICON[section.kind];
            const first = section.items[0];
            return (
              <button
                key={section.id}
                type="button"
                aria-label={nameOf(section)}
                aria-current={markedId === section.id}
                data-strip={section.id}
                className="expression-set-button tap-target flex size-control shrink-0 items-center justify-center overflow-hidden rounded-sm p-0.5 press hover:bg-surface-hover focus-visible:focus-ring"
                onClick={() => jump(section.id)}
              >
                {Icon ? <Icon aria-hidden="true" className="size-4" /> : first ? <ExpressionImage item={first} size="medium" still /> : null}
              </button>
            );
          })}
        </div>
        {trailing}
      </div>
    </>
  );
}
