import { useId, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import { SCHEDULED_COPY } from "@momo/core/features/scheduled/copy";
import type { ScheduleGate } from "@momo/core/features/scheduled/gate";
import type { ScheduledPreset } from "@momo/core/features/scheduled/presets";
import { cn } from "@/design/lib/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";

// =============================================================================
// 보내기 옆 ▾ 반쪽과 예약 메뉴 (UI 명세 1.1·1.3, ADR-0208 D16, #4215).
//
// 알약 하나로 보인다: 보내기 반쪽(호출부의 단추, 그대로)과 같은 잉크 채움의 ▾ 반쪽이 1px 틈을 두고 붙고, 바깥
// 모서리만 둥글다. 메뉴는 프리미티브 `DropdownMenu`다(`side="top" align="end"`). 항목은 둘과 「직접 고르기…」이고,
// 일요일에는 둘째가 없다(코어 `scheduledPresets`). 시간대 줄은 항목이 아닌 안내 줄이다.
//
// ## 막힌 ▾는 눌러서 이유를 듣는다
//
// 이 클라이언트는 툴팁을 쓰지 않는다(`dropdown-menu.tsx`: 문장은 포인터 없이 읽히는 자리에 둔다). 그래서 막힌 단추는
// `disabled`가 아니라 `aria-disabled="true"`로 **포커스를 받고**, 누르면(포인터·Enter·Space·↓) 메뉴가 열리는 대신
// 호출부가 이유를 말한다(`onBlockedPress`: 채널 입력창은 메타 슬롯의 3초 줄, 스레드는 안 보이는 낭독 노드).
// `title`과 `aria-describedby`는 이유 줄과 다음 행동 줄을 합친 문장을 싣는다. Radix의 트리거는 `aria-disabled`여도
// 열려 하므로 열림을 `onOpenChange`가 막는다(`open`은 이 컴포넌트가 쥔 제어 값이라 거기서 `return`하면 열리지 않는다):
// 눌러도 아무 일 없는 단추는 만들지 않는다.
//
// ## 한도(50개)
//
// 메뉴는 열리고 항목이 흐려지며 한도 문장이 맨 위에 선다. **흐린 항목은 `disabled`가 아니라 `aria-disabled`**다:
// Radix는 `disabled` 항목을 키보드 이동에서 건너뛰어 한도 문장을 못 듣게 된다. 항목마다 `aria-describedby`가 그
// 문장을 가리키고 `onSelect`에서 `preventDefault`한다(메뉴가 열린 채 남는다).
//
// ## 프리셋 요청이 실패하면
//
// 이 컴포넌트는 모른다: 호출부가 대화상자를 연다. 여기서는 선택이 끝났다는 것까지만 말하고(`onPickPreset`), 메뉴가
// 닫힌 **뒤에** 직접 고르기를 열어(`onCloseAutoFocus`) 메뉴와 대화상자의 초점이 싸우지 않는다. 선택하면 초점은
// 입력창으로 돌아가고, Esc로 닫으면 ▾로 돌아간다(Radix 기본).
// =============================================================================

export interface ScheduleSendMenuProps {
  gate: ScheduleGate;
  /** 요청이 나는 중: `aria-busy`이고 눌러도 열리지 않는다. */
  busy: boolean;
  /** 메뉴가 열릴 때 호출부가 새로 계산한 프리셋. */
  presets: readonly ScheduledPreset[];
  /** 「Asia/Seoul (UTC+9) 기준이에요」. */
  zoneLine: string;
  /** 메뉴가 열리려는 순간(프리셋을 새로 계산하라). `opener`는 ▾ 단추다. */
  onOpen: (opener: HTMLElement | null) => void;
  onPickPreset: (preset: ScheduledPreset) => void;
  /** 「직접 고르기…」: 메뉴가 닫힌 뒤에 부른다. `opener`는 ▾ 단추다(대화상자가 닫힐 때 초점이 돌아갈 곳). */
  onPickCustom: (opener: HTMLElement | null) => void;
  /** 막힌 ▾를 눌렀다. 호출부가 이유를 말한다. */
  onBlockedPress: () => void;
  /** 프리셋을 고른 뒤 초점이 돌아갈 곳(입력창). */
  returnFocus: () => void;
  /**
   * 막힌 사유의 한 문장 「이유. 다음 행동.」. `title`과 낭독(`aria-describedby`)이 싣는다. 이유가 없는 사유
   * (오프라인)는 호출부가 앱의 오프라인 문장을 넘긴다: 예약용 문장을 따로 만들지 않는다.
   */
  blockedTitle: string | null;
  /** `composer` 또는 `thread-composer`. */
  testIdPrefix: string;
}

/**
 * ▾ 반쪽: 폭 24 · 높이 34(`h-icon-button`), 600px 미만에서는 `tap-target`으로 44까지 자란다. 바깥(오른쪽) 모서리만 둥글다.
 *
 * `Button` 프리미티브가 아니라 손으로 그린 이유(웹 스킬 §1): (1) 막힌 ▾는 `disabled` 속성이 아니라 `aria-disabled`로
 * **포커스를 받아야** 한다(누르면 이유를 말한다. `disabled`는 포커스와 클릭을 없앤다). (2) 보내기 반쪽에 1px 틈으로 붙은
 * 24px 폭의 반쪽 알약이라 `Button`의 크기·모양 변형에 없다. 색·눌림·포커스 링은 같은 토큰(`bg-primary`·`press`·
 * `focus-ring-on-primary`)을 쓴다.
 */
const triggerClass =
  "tap-target flex h-icon-button w-6 shrink-0 items-center justify-center rounded-r-full bg-primary text-on-primary press hover:opacity-90 focus-visible:focus-ring focus-ring-on-primary aria-disabled:opacity-50";

export function ScheduleSendMenu({
  gate,
  busy,
  presets,
  zoneLine,
  onOpen,
  onPickPreset,
  onPickCustom,
  onBlockedPress,
  returnFocus,
  blockedTitle,
  testIdPrefix,
}: ScheduleSendMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const chosen = useRef<"preset" | "custom" | null>(null);
  const reasonId = useId();
  const limitId = `${reasonId}-limit`;

  if (gate.entry === "hidden") return null;
  const blocked = gate.block !== null;
  const locked = blocked || busy;
  const limit = gate.limitReached;

  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          if (next) {
            if (locked) return;
            onOpen(triggerRef.current);
          }
          setOpen(next);
        }}
        modal={false}
      >
        <DropdownMenuTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            className={triggerClass}
            aria-label={SCHEDULED_COPY.trigger.label}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-disabled={blocked || undefined}
            aria-busy={busy || undefined}
            aria-describedby={blocked ? reasonId : undefined}
            title={blocked ? (blockedTitle ?? undefined) : undefined}
            data-testid={`${testIdPrefix}-schedule-trigger`}
            onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
              // 키보드의 누름이 이유를 말한다(Radix가 같은 키로 열려 하지만 `onOpenChange`가 막았다).
              if (!blocked) return;
              if (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowDown") return;
              onBlockedPress();
            }}
            onClick={(event) => {
              // 마우스·손가락의 누름만 센다. 키보드의 클릭(detail 0)은 위 `onKeyDown`이 이미 말했다.
              if (blocked && event.detail > 0) onBlockedPress();
            }}
          >
            <ChevronDown className="size-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          ref={contentRef}
          side="top"
          align="end"
          data-testid={`${testIdPrefix}-schedule-menu`}
          // 메뉴는 포털에 서지만 React 이벤트는 입력창 그릇까지 올라간다. 그릇은 빈 면적의 누름에 캐럿을 입력창으로
          // 돌려주는데(`Composer.tsx`의 `composer-frame`), 그러면 흐린 항목을 눌렀을 때 초점이 메뉴 밖으로 나가 메뉴가
          // 닫힌다(「흐린 항목을 눌러도 메뉴가 열린 채 남는다」가 깨진다). 메뉴 안의 누름은 여기서 멈춘다.
          onClick={(event) => event.stopPropagation()}
          // 메뉴가 열리면 초점은 **첫 항목**이다(UI 명세 1.10). Radix는 마우스로 열면 항목이 아니라 상자에 초점을
          // 두므로, 어떻게 열었든 같은 자리에서 시작하게 맞춘다.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
          }}
          onCloseAutoFocus={(event) => {
            const how = chosen.current;
            chosen.current = null;
            if (how === "preset") {
              event.preventDefault();
              returnFocus();
            } else if (how === "custom") {
              // 메뉴가 닫혔다: 이제 대화상자를 연다. 초점은 대화상자가 가져간다.
              event.preventDefault();
              onPickCustom(triggerRef.current);
            }
          }}
        >
          {limit && (
            <p
              id={limitId}
              className="max-w-pane break-keep px-2 py-1 text-meta text-ink-muted"
              data-testid={`${testIdPrefix}-schedule-limit`}
            >
              {SCHEDULED_COPY.disabled.limit}
            </p>
          )}
          {presets.map((preset) => (
            <DropdownMenuItem
              key={preset.id}
              aria-label={preset.aria}
              aria-disabled={limit || undefined}
              aria-describedby={limit ? limitId : undefined}
              className={cn("gap-3", limit && "opacity-50")}
              data-testid={`${testIdPrefix}-schedule-preset-${preset.id}`}
              onSelect={(event) => {
                if (limit) {
                  event.preventDefault();
                  return;
                }
                chosen.current = "preset";
                onPickPreset(preset);
              }}
            >
              <span className="min-w-0 flex-1 truncate" data-numeric>
                {preset.label} {preset.time}
              </span>
              <span className="shrink-0 text-meta text-ink-muted" data-numeric>
                {preset.date}
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            aria-disabled={limit || undefined}
            aria-describedby={limit ? limitId : undefined}
            className={cn(limit && "opacity-50")}
            data-testid={`${testIdPrefix}-schedule-custom`}
            onSelect={(event) => {
              if (limit) {
                event.preventDefault();
                return;
              }
              chosen.current = "custom";
            }}
          >
            {SCHEDULED_COPY.menu.custom}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {gate.routingNote && (
            <p
              className="max-w-pane break-keep px-2 py-1 text-meta text-ink-muted"
              data-testid={`${testIdPrefix}-schedule-routing-note`}
            >
              {SCHEDULED_COPY.menu.routingNote}
            </p>
          )}
          <p className="px-2 py-1 text-meta text-ink-muted" data-testid={`${testIdPrefix}-schedule-zone`}>
            {zoneLine}
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
      {blocked && blockedTitle !== null && (
        // 막힌 이유를 낭독이 읽는 자리. 눈에는 보이지 않는다(보이는 이유는 호출부의 입력창 줄이 말한다).
        <span id={reasonId} className="sr-only" data-testid={`${testIdPrefix}-schedule-reason`}>
          {blockedTitle}
        </span>
      )}
    </>
  );
}
