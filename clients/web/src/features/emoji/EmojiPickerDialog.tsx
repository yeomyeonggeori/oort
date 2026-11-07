import {PICKER_EMOJI} from "@momo/core/features/emoji/choices";
import type { MessageKey } from "@momo/core/i18n";
import { DEFAULT_EXPRESSION_PICKER_TAB, EXPRESSION_PICKER_TABS, expressionViewOfPickerTab, type ExpressionPickerTab } from "@momo/core/features/expressions/kind";
import type { Expression } from "@momo/core/features/expressions/types";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DialogFocusTarget } from "@/design/ui/dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/design/ui/popover";
import { Button } from "@/design/ui/button";
import { useExpressions } from "@/features/expressions/context";
import { TeamExpressionsPanel } from "@/features/expressions/TeamExpressionsPanel";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import type { CatalogEmoji } from "./catalog";
import { loadCatalog } from "./catalog";
import { EmojiPickerPanel } from "./EmojiPickerPanel";
import { TeamEmojiStrip } from "./TeamEmojiStrip";
import { recordEmojiUse } from "./frequencyStore";
import { useHoverNone } from "./useHoverNone";

// =============================================================================
// 컴포저와 메시지 반응이 함께 쓰는 이모지 표면 (#1742, supersede #1688).
//
// 피커 라이브러리를 쓰지 않는 결정은 유지한다. 라이브러리는 폰트나 스프라이트를
// 싣기 쉽고, 이 앱은 외부 호스트가 막힌 CSP와 오프라인 Tauri 셸을 함께 낸다.
// 데이터는 emojibase compact(en)+iamcal shortcode를 빌드타임에 추출한
// same-origin 번들이다.
//
// 32종 고정 어휘와 중앙 Dialog는 2026-08-24 성재 지시로 supersede됐다.
// PICKER_EMOJI는 빈 Frequently used의 큐레이션 시드(그리고 UX-HT 슬롯 시드)로
// 남는다. 포인터는 트리거 기준 anchored popover, 터치(`hover: none`)는 바텀시트.
//
// DialogTrigger/PopoverTrigger는 두지 않는다. 두 소비자는 열기 전에 각각
// 메시지 행 또는 textarea의 선택 범위를 기록해야 하므로, 실제 button onClick이
// open을 올리고 그 button을 `anchor`, 포커스 복귀 대상을 `opener`로 넘기는
// 정본 프로그래매틱 패턴을 쓴다.
// =============================================================================

export {PICKER_EMOJI} from "@momo/core/features/emoji/choices";

/**
 * 고르개의 세 탭은 폰 창과 같은 코어의 목록이다: 이모티콘 · 이모지 · GIF (owner 2026-11-07, #5453). 우리 팀이 올린 것과 기본을 탭으로 가르지 않는다.
 * 이모티콘·GIF 는 팀 보관함의 큰 그림(`TeamExpressionsPanel` 의 두 보기)이고, 이모지는 표준 유니코드 표에 팀의 작은 이모지를 한 탭으로 합친 것이다
 * (`TeamEmojiStrip`, 코어 `EXPRESSION_TAB_SHELVES`). 처음 여는 탭은 이모티콘이다(코어 `DEFAULT_EXPRESSION_PICKER_TAB`, owner 탭 순서·planner 결정 #5482 - 폰 창도 같은 상수로 열린다). 「이모지」라는 말은 이 탭의 이름에만 쓴다.
 * 이름은 폰 창과 같은 사전 키다.
 */
const TAB_NAME = {
  emoticon: "expressions.sheet.tabEmoticon",
  emoji: "expressions.sheet.tabEmoji",
  gif: "expressions.sheet.tabGif",
} as const satisfies Record<ExpressionPickerTab, MessageKey>;

// 사용자에게 보이는 이름은 「이모티콘」 하나다(owner 2026-11-05, #5330). 반응·넣기 고르개의 글에서 「이모지」를 지웠다. 상태 고르개는 표준
// 그림 문자만 고르므로(보관함이 없다) 「상태 이모지」 그대로다.
const COPY = {
  reaction: {
    title: "반응 고르기",
    description: "이 메시지에 남길 이모티콘을 고르세요.",
    itemPrefix: "picker-react",
  },
  insert: {
    title: "이모티콘 넣기",
    description: "메시지에 넣을 이모티콘을 고르세요.",
    itemPrefix: "picker-insert",
  },
  status: {
    title: "상태 이모지",
    description: "상태에 붙일 이모지를 고르세요.",
    itemPrefix: "picker-status",
  },
} as const;

export function EmojiPickerDialog({
  open,
  onOpenChange,
  onPick,
  opener,
  anchor,
  purpose,
  testId,
  side = "top",
  onPickExpression,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (emoji: string) => void;
  opener: DialogFocusTarget | null;
  /** Popover 위치의 기준. 생략하면 opener가 HTMLElement일 때 그것을 쓴다. */
  anchor?: HTMLElement | null;
  purpose: keyof typeof COPY;
  testId: string;
  /** 포인터 팝오버가 앵커의 어느 쪽에 뜨는지. 아래에 다른 칸이 없는 자리(컴포저)는 위, 폼 안은 아래. */
  side?: "top" | "bottom";
  /**
   * 메인 컴포저만 준다(#5453): 이모티콘·GIF 를 고르면 `:이름:` 글을 넣는 대신 표현 자체를 넘기고 고르개를 닫는다 - 컴포저가 입력창 위에 크게 미리 보여 주고
   * 보내기 한 번에 글과 함께 보낸다. 작은 이모지(이모지 탭)는 계속 `onPick`으로 글에 들어간다. 주지 않는 곳(스레드 입력칸·반응)은 예전 그대로다.
   */
  onPickExpression?: (expression: Expression) => void;
}) {
  const copy = COPY[purpose];
  const formatMessage = useFormatMessage();
  const { store: expressions } = useExpressions();
  // 넣기(컴포저·스레드 입력칸)는 첫 탭 「이모티콘」, 반응은 예전처럼 작은 「이모지」부터 연다(#5482 planner 결정).
  const [tab, setTab] = useState<ExpressionPickerTab>(purpose === "insert" ? DEFAULT_EXPRESSION_PICKER_TAB : "emoji");
  // 팀 보관함 탭(이모티콘·GIF)은 상태 고르개에 없다: 거기서는 표준 그림 문자만 고른다.
  const view = expressionViewOfPickerTab(tab);
  // 상태 고르개에는 탭도 팀 이모지 줄도 없다(표준 그림 문자만 고른다). 탭 줄과 줄 둘이 같은 조건이다.
  const tabbed = purpose !== "status" && expressions;
  const team = view !== null && tabbed;
  const isTouch = useHoverNone();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  // 우리 팀 패널의 확인 단계(삭제·신고)가 서 있는 동안 Esc는 그 단계의 것이다. 패널이 취소 함수를 여기에 올려 둔다(#4986).
  const escapeClaim = useRef<(() => void) | null>(null);
  const [entries, setEntries] = useState<CatalogEmoji[] | null>(null);
  const [error, setError] = useState(false);
  const [loadNonce, setLoadNonce] = useState(0);
  const [skinOpen, setSkinOpen] = useState(false);
  const positionRef = useMemo(
    () => ({
      current: (anchor ?? (opener instanceof HTMLElement ? opener : null)) ?? null,
    }),
    [anchor, opener]
  );

  useEffect(() => {
    if (!open) setSkinOpen(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(false);
    loadCatalog().then(
      (catalog) => {
        if (live) setEntries(catalog);
      },
      () => {
        if (live) {
          setEntries(null);
          setError(true);
        }
      }
    );
    return () => {
      live = false;
    };
  }, [open, loadNonce]);

  const handlePick = (emoji: string, base: string) => {
    recordEmojiUse(base);
    onPick(emoji);
    onOpenChange(false);
  };

  const retry = () => {
    setError(false);
    setEntries(null);
    setLoadNonce((n) => n + 1);
  };

  const onEscapeKeyDown = (event: KeyboardEvent) => {
    // React portal bubbling reaches ThreadPanel's aside onKeyDown. Stop it
    // here so one Escape dismisses only this overlay (or the skin list).
    event.stopPropagation();
    if (escapeClaim.current) {
      event.preventDefault();
      escapeClaim.current();
      return;
    }
    if (!skinOpen) return;
    event.preventDefault();
    setSkinOpen(false);
  };

  const panel = (
    <div ref={panelRef} tabIndex={-1} className="flex min-h-0 flex-col gap-3 focus-visible:focus-ring">
    {tabbed && <div role="group" className="flex flex-wrap gap-2" aria-label={formatMessage("expressions.sheet.tabs")}>
      {EXPRESSION_PICKER_TABS.map((id) => <Button key={id} type="button" variant={tab === id ? "secondary" : "ghost"} size="sm" aria-pressed={tab === id} onClick={() => { setSkinOpen(false); setTab(id); }}>{formatMessage(TAB_NAME[id])}</Button>)}
    </div>}
    {team && view !== null ? <TeamExpressionsPanel view={view} purpose={purpose} escapeClaim={escapeClaim} onPick={(token) => { onPick(token); onOpenChange(false); }} {...(onPickExpression ? { onPickExpression: (expression: Expression) => { onPickExpression(expression); onOpenChange(false); } } : {})} onClose={() => onOpenChange(false)} /> : <EmojiPickerPanel
      itemPrefix={copy.itemPrefix}
      entries={entries}
      loading={open && !error && entries === null}
      error={error}
      onRetry={retry}
      onPick={handlePick}
      seed={PICKER_EMOJI}
      searchRef={searchRef}
      skinOpen={skinOpen}
      onSkinOpenChange={setSkinOpen}
      autoFocusSearch={!isTouch}
      {...(tabbed ? { renderTeam: (query: string) => <TeamEmojiStrip tab={tab} query={query} onPick={(token) => { onPick(token); onOpenChange(false); }} /> } : {})}
    />}
    </div>
  );

  if (isTouch) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          ref={sheetRef}
          tabIndex={-1}
          opener={opener}
          data-testid={testId}
          className="safe-area-bottom bottom-0 left-0 top-auto max-h-pane-lg max-w-none translate-x-0 gap-2 rounded-lg p-3"
          onEscapeKeyDown={onEscapeKeyDown}
          onOpenAutoFocus={(event) => {
            // 검색창을 포커스하면 소프트 키보드가 fixed 시트를 덮는다. 그렇다고
            // 포커스를 트리거(시트 뒤, aria-hidden 서브트리)에 남기면 Tab이 눈에
            // 안 보이는 컨트롤에 닿는다(ADR-0112 D6). 시트 자신에게 옮긴다.
            event.preventDefault();
            sheetRef.current?.focus();
          }}
        >
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription className="sr-only">
            {copy.description}
          </DialogDescription>
          {panel}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange} modal>
      <PopoverAnchor virtualRef={positionRef} />
      <PopoverContent
        opener={opener}
        data-testid={testId}
        side={side}
        align="start"
        aria-label={copy.title}
        onEscapeKeyDown={onEscapeKeyDown}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (team) panelRef.current?.focus();
          else searchRef.current?.focus();
        }}
        className="flex max-h-pane-md flex-col"
      >
        <p className="sr-only">{copy.description}</p>
        {panel}
      </PopoverContent>
    </Popover>
  );
}
