import { useEffect, useId, useRef, useState } from "react";
import { ArrowDownToLine, Check, CircleAlert, RefreshCw } from "lucide-react";
import { Button } from "@/design/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/design/ui/popover";
import {
  pillTooltip,
  pillWorthShowing,
  progressLabel,
  progressPercent,
  type UpdateState,
} from "./model";
import {
  checkForUpdate,
  installUpdate,
  relaunchIntoUpdate,
  useRelaunchCountdown,
  useUpdateState,
} from "./store";

// =============================================================================
// 프로필 줄의 「업데이트」 알약 + 진행 카드 (성재 결재 2026-10-16, Cursor 방식).
//
// 새 버전이 있는 동안만 서는 작은 알약 하나다. 점·배너·X·나중에는 없다: 업데이트가
// 있으면 단추가 있고, 없으면 없다. 펼친 사이드바의 프로필 줄 오른쪽에만 마운트되므로
// 접힘(⌘B)에서는 이 컴포넌트가 아예 없다. 브라우저 탭에서는 업데이트 상태가 생기지
// 않아(`startUpdateWatch` 는 데스크탑 전용) 아무것도 그리지 않는다.
//
// 누르면: 새 버전이면 받기를 시작하고, 어떤 상태든 줄 위에 카드가 열린다. 받는
// 동안은 게이지, 끝나면 3초 뒤 자동으로 다시 실행(카운트다운은 store 가 들고 있어
// 카드를 닫아도 계속된다), 실패하면 이유와 「다시 확인」.
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
      return countdown === null ? "다시 실행해 주세요" : "곧 다시 실행돼요";
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

function CardIcon({ state }: { state: UpdateState }) {
  const cls = "size-4";
  if (state.kind === "installed") return <Check className={cls} aria-hidden="true" />;
  if (state.kind === "failed")
    return <CircleAlert className={`${cls} text-danger`} aria-hidden="true" />;
  return <ArrowDownToLine className={`${cls} text-signal-text`} aria-hidden="true" />;
}

export function UpdateButton() {
  const state = useUpdateState();
  const countdown = useRelaunchCountdown();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipId = useId();
  // 카드는 알약이 아니라 프로필 **줄 전체**에 붙는다: 알약 오른쪽 끝에 맞추면 줄보다 넓은
  // 카드가 왼쪽으로 삐져 워크스페이스 레일 위에 걸친다(design-review M2).
  const rowRef = useRef<Element | null>(null);
  rowRef.current =
    buttonRef.current?.closest('[data-testid="sidebar-profile-foot"]') ?? buttonRef.current;

  // 설치가 끝나 카운트다운이 돌기 시작하면 카드를 연다: 곧 앱이 사라질 것이므로
  // 어디서 시작했든(설정 화면 포함) 이 줄이 마지막 안내다. 이 줄이 안 보이는
  // (접힘) 경우에는 마운트되지 않으므로 해당 없음.
  useEffect(() => {
    if (state.kind === "installed") setOpen(true);
  }, [state.kind]);

  // 카드가 열려 있는 동안은 상태가 확인 중·최신·확인 실패로 바뀌어도 단추를 유지한다.
  // 「다시 확인」을 누른 사람이 결과를 보기 전에 줄이 사라지면 아무 일도 없었던 것처럼 읽힌다.
  if (!pillWorthShowing(state) && !open) return null;

  const tooltip = pillTooltip(state);
  const label = tooltip ? `업데이트. ${tooltip}` : "업데이트";
  const percent =
    state.kind === "installing" ? progressPercent(state.downloaded, state.total) : null;

  const onPill = () => {
    setOpen(true);
    if (state.kind === "available") void installUpdate();
  };

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverAnchor virtualRef={rowRef} />
      <div className="group relative shrink-0" data-testid="update-pill-wrap">
          <Button
            ref={buttonRef}
            type="button"
            size="sm"
            variant="secondary"
            onClick={onPill}
            aria-label={label}
            aria-describedby={tooltip && !open ? tooltipId : undefined}
            aria-expanded={open}
            aria-haspopup="dialog"
            data-testid="update-pill"
            data-update-state={state.kind}
            className="tap-target"
          >
            업데이트
          </Button>
          {tooltip && !open && (
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
        side="top"
        align="start"
        sideOffset={8}
        opener={buttonRef.current}
        aria-label="앱 업데이트"
        data-testid="update-card"
        data-update-state={state.kind}
        className="update-card flex flex-col gap-3 p-4"
      >
        <div className="flex items-start gap-3">
          <span className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-muted">
            <CardIcon state={state} />
          </span>
          <div className="min-w-0 flex-1" aria-live="polite">
            <p className="break-keep text-body font-semibold text-ink" data-testid="update-card-title">
              {cardTitle(state, countdown)}
            </p>
            {cardSubline(state, countdown) && (
              <p className="break-keep text-meta text-ink-muted" data-testid="update-card-subline">
                {cardSubline(state, countdown)}
              </p>
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
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => void relaunchIntoUpdate()}
              aria-label="지금 다시 실행"
              data-testid="update-card-now"
            >
              <RefreshCw aria-hidden="true" />
              지금
            </Button>
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
