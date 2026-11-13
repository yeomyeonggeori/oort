import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ArrowDownToLine, Check, CircleAlert, RefreshCw } from "lucide-react";
import { applyKeyboardModality } from "@/design/focusModality";
import { Button } from "@/design/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/design/ui/popover";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import {
  pillTooltip,
  pillWorthShowing,
  RAIL_CARD_GAP,
  railCardBottomPadding,
  progressLabel,
  progressPercent,
  restartCutLine,
  type UpdateState,
} from "./model";
import {
  checkForUpdate,
  deferRelaunch,
  installUpdate,
  noteUpdateCardClosed,
  registerUpdateNoticeSurface,
  relaunchIntoUpdate,
  updateCardDismissed,
  useRelaunchCountdown,
  useRelaunchDeferrable,
  useRelaunchHold,
  useUpdateState,
} from "./store";

// =============================================================================
// 프로필 줄의 「업데이트」 알약 + 진행 카드 (성재 결재 2026-10-16, Cursor 방식).
//
// 새 버전이 있는 동안만 서는 작은 알약 하나다. 점·배너·X·나중에는 없다: 업데이트가
// 있으면 단추가 있고, 없으면 없다. 펼친 사이드바에서는 프로필 줄 오른쪽(`placement="row"`),
// 접힘(⌘B)에서는 레일 아래 프로필 아바타 위(`placement="rail"`, owner 2026-11-11 「접힌
// 사이드바에서도 보이게」)에 같은 알약이 작은 모양(레일 글자 크기, 같은 이름·툴팁·카드)으로
// 선다. 둘은 동시에 마운트되지 않는다. 브라우저 탭에서는 업데이트 상태가 생기지
// 않아(`startUpdateWatch` 는 데스크탑 전용) 아무것도 그리지 않는다.
//
// 누르면: 새 버전이면 받기를 시작하고, 어떤 상태든 줄 위에 카드가 열린다. 받는
// 동안은 게이지, 끝나면 3초 뒤 자동으로 다시 시작(카운트다운은 store 가 들고 있어
// 카드를 닫아도 계속된다), 실패하면 이유와 「다시 확인」. 이 맥에서 로컬 작업이 돌면
// 카운트다운 대신 「이 맥의 작업이 끝나면 다시 시작해요」와 「지금 다시 시작」, 그리고 지금 누르면
// 무엇이 끊기는지 한 줄을 보인다(#5661, 판정은 코어 `localWork.ts`).
//
// 툴팁은 이 앱의 관례(`title`)가 아니라 직접 그린다. 네이티브 `title` 은 0.7초
// 뒤에야 뜨고, 문구가 상태마다 바뀌는 이 단추의 설명을 캡처·시험으로 확인할 수
// 없다. 호버와 키보드 포커스에서 같은 문장이 서고, `aria-describedby` 로 읽힌다.
// 게이지는 `<progress>` 의 value/max 속성이라 인라인 스타일이 필요 없다.
// =============================================================================

function cardTitle(state: UpdateState, countdown: number | null): string {
  switch (state.kind) {
    case "available":
      return `새 버전 ${state.update.version}`;
    case "installing":
      return "새 버전을 받는 중";
    case "installed":
      return countdown === null ? "다시 시작해 주세요" : "곧 다시 시작돼요";
    case "failed":
      return "업데이트하지 못했어요";
    case "checking":
      return "새 버전을 찾고 있어요";
    case "current":
      return "가장 최신 버전이에요";
    default:
      return "업데이트";
  }
}

function cardSubline(state: UpdateState, countdown: number | null): string | null {
  switch (state.kind) {
    case "available":
      return "받는 동안에도 앱은 그대로 쓸 수 있어요";
    case "installing":
      return "앱은 그대로 쓸 수 있어요";
    case "installed":
      return countdown === null
        ? "쓰던 글은 그대로 남아 있어요"
        : `${countdown}초 뒤에 새 버전으로 열려요. 쓰던 글은 그대로 남아요`;
    case "failed":
      return state.message;
    default:
      return null;
  }
}

/** 레일 카드의 아래 여백을 지금 화면에서 잰다(순수 판정은 `model.ts` `railCardBottomPadding`). */
function readRailCardBottomPadding(pill: HTMLElement | null): number {
  if (typeof window === "undefined" || pill === null) return RAIL_CARD_GAP;
  const composers = Array.from(document.querySelectorAll<HTMLElement>("[data-composer-shell]"), (el) => el.getBoundingClientRect());
  return railCardBottomPadding(pill.getBoundingClientRect().right, window.innerHeight, composers);
}

function CardIcon({ state }: { state: UpdateState }) {
  const cls = "size-4";
  if (state.kind === "installed") return <Check className={cls} aria-hidden="true" />;
  if (state.kind === "failed")
    return <CircleAlert className={`${cls} text-danger`} aria-hidden="true" />;
  return <ArrowDownToLine className={`${cls} text-signal-text`} aria-hidden="true" />;
}

/**
 * 카드 안에서 Tab은 카드가 직접 옮긴다(#5708): 틀(초점은 여기서 시작) → 첫 단추 → … → 마지막 단추 → 첫 단추, Shift+Tab은 거꾸로(틀에서는
 * 마지막 단추). WebKit 기본 설정은 Tab이 단추에 서지 않아(맥 「키보드 탐색」 꺼짐) 브라우저 순서에 맡기면 초점이 `body`로 나가 카드가 닫힌다.
 */
function moveCardFocus(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== "Tab" || event.ctrlKey || event.metaKey) return;
  const stops = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled)"));
  if (stops.length === 0) return;
  event.preventDefault();
  const at = stops.indexOf(document.activeElement as HTMLElement);
  const step = event.shiftKey ? -1 : 1;
  const next = at === -1 ? (event.shiftKey ? stops.length - 1 : 0) : (at + step + stops.length) % stops.length;
  // Radix 초점 범위(`FocusScope`, 끝에서 도는 규칙)도 같은 키를 읽고 끝 단추에서 스스로 옮긴다. 같은 자리로 가지만 우리가 먼저 옮기면
  // 그 뒤 범위가 옮긴 자리를 끝으로 읽고 한 번 더 옮겨 버린다 — 그 처리가 끝난 뒤에 옮긴다.
  queueMicrotask(() => stops[next]?.focus());
}

export function UpdateButton({ placement = "row" }: { placement?: "row" | "rail" }) {
  const state = useUpdateState();
  const countdown = useRelaunchCountdown();
  const hold = useRelaunchHold();
  const deferrable = useRelaunchDeferrable();
  const formatMessage = useFormatMessage();
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  // 사람이 누르지 않았는데 열린 카드인가(#5661 H2). 그 카드는 초점을 가져가지 않는다: 받기가 끝나거나 카운트다운이 시작되는
  // 순간 입력창에서 글을 쓰던 사람의 다음 Space·Enter가 카드 단추(「지금 다시 시작」)를 누르게 된다. 알약을 눌러 연 카드만 초점이 들어간다.
  const autoOpened = useRef(false);
  // 카드 바깥을 눌러(또는 초점을 바깥으로 옮겨) 닫았나(수리 2회차 H1). 그렇게 닫힌 카드는 초점을 알약으로 되돌리지 않는다: 사람은
  // 누른 곳(입력창)으로 갔고, 알약에 남은 초점은 다음 Enter·Space 두 번을 묻지 않는 「지금 다시 시작」으로 바꾼다. Esc로 닫을 때만 연 곳으로.
  const closedFromOutside = useRef(false);
  const countdownWas = useRef(countdown);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipId = useId();
  const cutId = useId();
  const textId = useId();
  const actionsId = useId();
  const rail = placement === "rail";
  // 이 알약이 마운트돼 있는 동안 다시 시작 예고를 보일 곳이 있다(수리 3회차): 하나도 없으면 저장소는 카운트다운을 시작하지 않는다.
  useEffect(() => registerUpdateNoticeSurface(), []);
  // 접힌 레일의 카드는 입력창 독 위에 선다. 초안이 자라 독이 커지면 그 자리에서 다시 잰다(수리 3회차 M2 — 다음 그리기를 기다리지 않음).
  const [, remeasure] = useState(0);
  useEffect(() => {
    if (!rail || !open || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => remeasure((n) => n + 1));
    for (const dock of document.querySelectorAll("[data-composer-shell]")) observer.observe(dock);
    return () => observer.disconnect();
  }, [rail, open]);
  // 카드는 알약이 아니라 프로필 **줄 전체**에 붙는다: 알약 오른쪽 끝에 맞추면 줄보다 넓은
  // 카드가 왼쪽으로 삐져 워크스페이스 레일 위에 걸친다(design-review M2). 레일의 알약은
  // 줄이 없으므로 알약 자신에 붙고, 카드는 오른쪽(대화 쪽)으로 연다.
  const rowRef = useRef<Element | null>(null);
  rowRef.current = rail
    ? buttonRef.current
    : (buttonRef.current?.closest('[data-testid="sidebar-profile-foot"]') ?? buttonRef.current);

  // 설치가 끝나 카운트다운이 돌기 시작하면 카드를 연다: 곧 앱이 사라질 것이므로
  // 어디서 시작했든(설정 화면 포함) 이 알약이 마지막 안내다. 로컬 작업 때문에 기다릴 때도
  // 열린다: 왜 다시 시작하지 않는지가 이 카드에 있다. 펼침·접힘 어느 쪽이든 마운트된 쪽이 연다.
  // 기다린 뒤 카운트다운이 시작될 때도 다시 연다(H3): 그 사이 카드를 닫았으면 예고 없이 앱이 꺼진다. 카운트다운이 **시작될 때만**
  // 연다 — 「지금 말고」·다시 기다림으로 멈출 때 다시 열면 방금 닫은 카드가 되살아난다.
  // 사람이 닫은 뒤에는 새로 마운트된 알약(목록 열 접기·펴기, 설정 화면)이 다시 열지 않는다(수리 2회차).
  useEffect(() => {
    if (state.kind === "installed" && !openRef.current && !updateCardDismissed()) {
      autoOpened.current = true;
      setOpen(true);
    }
  }, [state.kind]);
  useEffect(() => {
    const started = countdownWas.current === null && countdown !== null;
    countdownWas.current = countdown;
    if (started && state.kind === "installed" && !openRef.current) {
      autoOpened.current = true;
      setOpen(true);
    }
  }, [countdown, state.kind]);

  // 설치를 마쳤는데 이 맥의 작업이 끝나기를 기다린다(카운트다운 없음).
  const holding = state.kind === "installed" && hold !== null && countdown === null;
  const cutLine = holding && hold.cut !== null ? restartCutLine(hold.cut, formatMessage) : null;

  // 카드가 열려 있는 동안은 상태가 확인 중·최신·확인 실패로 바뀌어도 단추를 유지한다.
  // 「다시 확인」을 누른 사람이 결과를 보기 전에 줄이 사라지면 아무 일도 없었던 것처럼 읽힌다.
  if (!pillWorthShowing(state) && !open) return null;

  // 자동 다시 시작이 멈췄다(「지금 말고」·다시 시작 실패): 「곧 다시 시작돼요」는 거짓이다(수리 2회차).
  const stopped = state.kind === "installed" && hold === null && countdown === null;
  const tooltip = holding
    ? formatMessage("settings.updates.holdTitle")
    : stopped
      ? formatMessage("settings.updates.stoppedSentence")
      : pillTooltip(state);
  const label = tooltip ? `업데이트. ${tooltip}` : "업데이트";
  const percent =
    state.kind === "installing" ? progressPercent(state.downloaded, state.total) : null;
  // 단추 줄은 설치를 마친 카드에만 이름을 단다(낭독 설명에 이어 붙임). 다른 상태의 단추는 그대로.
  const cardHasActions = state.kind === "installed";

  const onPill = (event: MouseEvent<HTMLButtonElement>) => {
    autoOpened.current = false;
    // 키보드(Enter·Space)로 눌렀으면 표지를 올려 틀의 초점 고리가 서게 한다(#5708): Enter·Space는 표지를 올리지 않아 `pointer`인 채면 링이 걷힌다.
    // 마우스로 누르면 `detail`이 1 이상이라 표지가 그대로(`pointer`) 링이 뜨지 않는다.
    if (event.detail === 0) applyKeyboardModality(document);
    setOpen(true);
    if (state.kind === "available") void installUpdate();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // 사람이 닫았다: 다시 마운트돼도 저절로 열지 않고, 기다린 뒤의 예고였으면 「지금 말고」와 같다(수리 2회차).
        if (!next) noteUpdateCardClosed();
      }}
      modal={false}
    >
      <PopoverAnchor virtualRef={rowRef} />
      <div className="group relative shrink-0" data-testid="update-pill-wrap">
          <Button
            ref={buttonRef}
            type="button"
            size="sm"
            variant="secondary"
            onClick={onPill}
            aria-label={label}
            aria-describedby={tooltip && !open && !rail ? tooltipId : undefined}
            // 레일은 가로로 넘친 것을 자른다(`overflow-x-hidden`): 직접 그린 툴팁이 잘리므로 레일의 다른 타일처럼 `title`을 쓴다.
            // 같은 문장은 접근 가능한 이름(`label`)에도 있다.
            title={rail && tooltip ? tooltip : undefined}
            aria-expanded={open}
            aria-haspopup="dialog"
            data-testid="update-pill"
            data-placement={placement}
            data-update-state={state.kind}
            // 레일(56px)에서는 같은 채움 알약·같은 낱말을 레일 글자 크기(11px, 목적지 이름과 같다)로 줄여 세운다. 아이콘만 두면
            // 창 오른쪽 위의 「내려받기」(같은 화살표)와 헷갈린다.
            className={rail ? "h-control-sm px-1.5 text-timestamp" : "tap-target"}
          >
            업데이트
          </Button>
          {tooltip && !open && !rail && (
            <span
              id={tooltipId}
              role="tooltip"
              data-testid="update-pill-tooltip"
              className="pointer-events-none invisible absolute bottom-full right-0 mb-2 w-max max-w-pane-sm rounded-md bg-primary px-3 py-2 break-keep text-meta text-on-primary shadow-lg layer-overlay-surface group-hover:visible group-focus-within:visible"
            >
              {tooltip}
            </span>
          )}
      </div>
      <PopoverContent
        side={rail ? "right" : "top"}
        align={rail ? "end" : "start"}
        sideOffset={8}
        opener={buttonRef.current}
        // 다시 시작을 실행하는 단추는 어떤 길로 열려도 첫 초점을 받지 않는다(수리 3회차 H1): 알약으로 연 카드는 카드 틀에 초점을 두고
        // (단추는 Tab으로 가야 닿는다), 저절로 연 카드는 초점을 옮기지 않는다. 닫힐 때도 초점이 카드 밖 어딘가(입력창)에 있으면 알약으로
        // 끌어오지 않는다. 틀에 초점이 오면 낭독은 카드 이름 · 제목 · 부제 · 단추 이름을 읽는다(`aria-describedby`).
        onOpenAutoFocus={(event) => {
          closedFromOutside.current = false;
          event.preventDefault();
          if (!autoOpened.current && event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
        }}
        onInteractOutside={() => {
          closedFromOutside.current = true;
        }}
        onCloseAutoFocus={(event) => {
          if (
            closedFromOutside.current ||
            (autoOpened.current && document.activeElement && document.activeElement !== document.body)
          )
            event.preventDefault();
        }}
        // 접힌 레일: 카드는 입력창 위쪽 끝보다 위에 선다(H2). 붙은 알약에서 떨어져도 끝까지 밀어 올린다.
        {...(rail ? { collisionPadding: { top: RAIL_CARD_GAP, bottom: readRailCardBottomPadding(buttonRef.current) }, sticky: "always" as const } : {})}

        onKeyDown={moveCardFocus}
        aria-label="앱 업데이트"
        aria-describedby={cardHasActions ? `${textId} ${actionsId}` : textId}
        data-testid="update-card"
        data-update-state={state.kind}
        className="update-card flex flex-col gap-3 p-4 focus-visible:focus-ring"
      >
        <div className="flex items-start gap-3">
          <span className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-muted">
            <CardIcon state={state} />
          </span>
          <div id={textId} className="min-w-0 flex-1" aria-live="polite">
            <p className="break-keep text-body font-semibold text-ink" data-testid="update-card-title">
              {holding ? formatMessage("settings.updates.holdTitle") : cardTitle(state, countdown)}
            </p>
            {holding ? (
              cutLine && (
                <p id={cutId} className="break-keep text-meta text-ink-muted" data-testid="update-card-subline">
                  {cutLine}
                </p>
              )
            ) : (
              cardSubline(state, countdown) && (
                <p className="break-keep text-meta text-ink-muted" data-testid="update-card-subline">
                  {cardSubline(state, countdown)}
                </p>
              )
            )}
          </div>
        </div>

        {state.kind === "installing" && (
          <div className="flex flex-col gap-1" data-testid="update-card-progress">
            {/* value 를 빼면 네이티브 불확정(indeterminate) 막대다: 길이를 모르는데
                채워진 척하는 막대는 거짓이다. */}
            <progress
              className="progress-bar"
              {...(percent !== null && state.total !== null
                ? { value: state.downloaded, max: state.total }
                : {})}
              aria-label="업데이트 내려받는 중"
            />
            <p
              className={`flex justify-between ${percent !== null ? "font-mono " : ""}text-meta text-ink-muted`}
              data-numeric={percent !== null ? true : undefined}
            >
              <span>{progressLabel(state.downloaded, state.total)}</span>
              {percent !== null && <span>{percent}%</span>}
            </p>
          </div>
        )}

        {state.kind === "available" && (
          <div className="flex justify-end">
            <Button size="sm" onClick={() => void installUpdate()} data-testid="update-card-install">
              지금 받기
            </Button>
          </div>
        )}
        {state.kind === "installed" && (
          <div id={actionsId} className="flex justify-end gap-2">
            {deferrable && (
              // 자동 다시 시작 카운트다운마다 선다(H3, 수리 3회차: 설치 직후 3초도 같은 규칙). 누르면(카드를 닫아도) 이번 설치의 자동 다시 시작을 멈추고 「지금」만 남는다.
              <Button size="sm" variant="ghost" onClick={deferRelaunch} data-testid="update-card-defer">
                {formatMessage("settings.updates.notNow")}
              </Button>
            )}
            {holding ? (
              // 기다리는 동안 「지금 다시 시작」은 무엇이 끊기는지 한 줄(위 부제)을 읽힌 뒤 묻지 않고 진행한다.
              <Button
                size="sm"
                onClick={() => void relaunchIntoUpdate()}
                aria-describedby={cutLine ? cutId : undefined}
                data-testid="update-card-now"
                data-hold="true"
              >
                <RefreshCw aria-hidden="true" />
                {formatMessage("settings.updates.restartNow")}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => void relaunchIntoUpdate()}
                aria-label="지금 다시 시작"
                data-testid="update-card-now"
              >
                <RefreshCw aria-hidden="true" />
                지금
              </Button>
            )}
          </div>
        )}
        {state.kind === "failed" && (
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => void checkForUpdate()}
              data-testid="update-card-recheck"
            >
              다시 확인
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
