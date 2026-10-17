import { useEffect, useId, useRef, useState } from "react";
import {
  customPauseUntil,
  customPauseUntilMessage,
  PAUSE_UNTIL_OFFLINE_REASON,
  pauseUntilAtMs,
  pauseUntilConfirmLabel,
  pauseUntilDescription,
  pauseUntilHint,
  pauseUntilLabel,
  pauseUntilOptions,
  pauseUntilTitle,
  type PauseUntilChoice,
  type PauseUntilKind,
} from "@momo/core/features/presence/pauseUntil";
import {
  localDateInputValue,
  localTimeInputValue,
} from "@momo/core/features/presence/customStatus";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  type DialogFocusTarget,
} from "@/design/ui/dialog";
import { Input } from "@/design/ui/input";
import { Select } from "@/design/ui/select";
import { InlineBanner } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";

// Reading this as: confirm dialog for a notification pause, opened from settings and
// from the sidebar profile menu, internal team users on web+Tauri, density 7/10,
// motion 2/10.

// =============================================================================
// 멈춤의 기한을 고르는 다이얼로그 (ADR-0204 D2, #2899).
//
// 알림 일시 중지(설정 › 알림)와 방해 금지(사이드바 프로필 메뉴)가 **같은 모양**으로
// 기한을 받는다. 두 스위치는 기한을 고르고 나서야 켜지고, 「직접 끌 때까지」는 목록에
// 없다. 이 다이얼로그는 쓰지 않는다 — 고른 끝 시각을 `onConfirm` 으로 올릴 뿐이고,
// 쓰기 길(방해 금지는 `PUT /presence`, 일시 중지는 `PATCH /notification-rules`)은
// 부르는 쪽이 갖는다. 길이 다르기 때문이다: 서버는 방해 금지를 고를 때 일시 중지를
// 같은 트랜잭션에서 묶어 켜므로, 방해 금지 쪽이 규칙을 따로 쓰면 묶음이 끊긴다.
//
// ## 왜 `Select` 인가 (시각 결정의 근거)
//
// 상태 글의 만료(`SetStatusDialog`)가 이미 이 문법이다: 「만료」 `Select` 에
// 30분·1시간·오늘까지가 있고, 「시각 고르기」를 고를 때만 날짜·시간 칸이 선다. 같은
// 제품에서 「언제까지」를 고르는 두 자리가 다른 모양이면 사람이 한쪽을 배운 것이 다른
// 쪽에 안 통한다. 그래서 라디오 목록을 새로 만들지 않고 같은 `Select` + 날짜·시간
// `Input` 을 쓴다. 대신 옵션 글에 끝 시각을 붙여(「30분 · 오후 9:37까지」) 누르기 전에
// 틀린 선택이 읽히게 한다.
//
// ## 시계
//
// 「30분」은 **확인을 누른 시각**부터 센다(열어 둔 시간이 아니다). 옵션 글의 끝 시각은
// 그리는 때의 시계라, 열어 둔 채 오래 있으면 몇 분 어긋날 수 있다 — 서버에 가는 값은
// 언제나 확인 때의 시계로 새로 센다.
// =============================================================================

const SELECT_PLACEHOLDER = "기한을 고르세요";
const SAVING_LABEL = "저장 중…";
const CANCEL_LABEL = "취소";

export function PauseUntilDialog({
  kind,
  open,
  onOpenChange,
  opener,
  running,
  currentUntilMs,
  pending,
  failure,
  offline: offlineProp,
  onConfirm,
  nowMs,
}: {
  kind: PauseUntilKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  opener: DialogFocusTarget | null;
  /** 지금 이 멈춤이 켜져 있는가. 켜져 있으면 설명 아래에 진행 중인 기한 한 줄이 선다. */
  running: boolean;
  /** 켜져 있는 멈춤의 끝 시각. 없으면 기한 없는 행이다. */
  currentUntilMs?: number;
  /** 쓰기가 날고 있다. 확인은 잠기고, 이 동안은 Esc·바깥 누름으로 닫히지 않는다. */
  pending: boolean;
  /** 쓰기가 실패했을 때 부르는 쪽이 넘기는 문장. 다이얼로그가 열린 채 이유를 말한다. */
  failure: string | null;
  /** 생략하면 연결 상태를 스스로 읽는다. 설정 화면은 자기가 아는 값을 넘긴다. */
  offline?: boolean;
  onConfirm: (untilMs: number) => void;
  /** 시험이 시계를 고정한다. 생략하면 `Date.now()`. */
  nowMs?: number;
}) {
  const hookOffline = useOffline();
  const offline = offlineProp ?? hookOffline;
  const selectId = useId();
  const dateId = useId();
  const timeId = useId();
  const seededRef = useRef(false);
  const [choice, setChoice] = useState<PauseUntilChoice | "">("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);

  const now = nowMs ?? Date.now();
  const busy = pending || offline;

  useEffect(() => {
    if (!open) {
      // 닫히면 고른 것도 접는다. 다음에 열 때 지난번 선택이 이미 눌려 있으면 사람이
      // 확인만 눌러 같은 기한을 다시 거는 쪽이 사고다.
      seededRef.current = false;
      setChoice("");
      setCustomError(null);
      return;
    }
    if (seededRef.current) return;
    seededRef.current = true;
    // 「직접 고르기」를 열면 한 시간 뒤의 날짜·시각이 미리 채워져 있다(`SetStatusDialog`
    // 와 같은 씨앗). 자정을 넘는 한 시간 뒤면 날짜도 함께 넘어간다.
    const placeholder = (nowMs ?? Date.now()) + 60 * 60_000;
    setDate(localDateInputValue(placeholder));
    setTime(localTimeInputValue(placeholder));
  }, [open, nowMs]);

  const options = pauseUntilOptions(now);

  const confirm = () => {
    if (busy || choice === "") return;
    const clock = nowMs ?? Date.now();
    if (choice === "custom") {
      const parsed = customPauseUntil(date, time, clock);
      if (!parsed.ok) {
        setCustomError(customPauseUntilMessage(parsed.reason));
        return;
      }
      setCustomError(null);
      onConfirm(parsed.atMs);
      return;
    }
    onConfirm(pauseUntilAtMs(choice, clock));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        opener={opener}
        data-testid="pause-until-dialog"
        className="gap-3 p-4"
      >
        <DialogTitle>{pauseUntilTitle(kind)}</DialogTitle>
        <DialogDescription className="break-keep">{pauseUntilDescription(kind)}</DialogDescription>

        {running ? (
          <p className="text-meta text-ink-muted" data-testid="pause-until-current">
            {currentUntilMs === undefined
              ? "지금은 기한이 없어요."
              : `지금은 ${pauseUntilLabel(currentUntilMs, now)}예요.`}
          </p>
        ) : null}

        {offline && (
          <InlineBanner
            tone="neutral"
            message={PAUSE_UNTIL_OFFLINE_REASON}
            testId="pause-until-offline"
          />
        )}
        {failure && <InlineBanner message={failure} testId="pause-until-error" />}

        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={selectId} className="text-meta text-ink-muted">
            기한
          </label>
          <Select
            id={selectId}
            value={choice}
            disabled={busy}
            data-testid="pause-until-select"
            onChange={(event) => {
              setChoice(event.currentTarget.value as PauseUntilChoice);
              setCustomError(null);
            }}
          >
            <option value="" disabled>
              {SELECT_PLACEHOLDER}
            </option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.id === "custom"
                  ? option.label
                  : `${option.label} · ${pauseUntilHint(option.id, now)}`}
              </option>
            ))}
          </Select>
        </div>

        {choice === "custom" ? (
          <div className="flex flex-wrap gap-2">
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor={dateId} className="text-meta text-ink-muted">
                날짜
              </label>
              <Input
                id={dateId}
                type="date"
                value={date}
                min={localDateInputValue(now)}
                disabled={busy}
                onChange={(event) => {
                  setDate(event.target.value);
                  setCustomError(null);
                }}
                data-testid="pause-until-custom-date"
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor={timeId} className="text-meta text-ink-muted">
                시간
              </label>
              <Input
                id={timeId}
                type="time"
                value={time}
                disabled={busy}
                onChange={(event) => {
                  setTime(event.target.value);
                  setCustomError(null);
                }}
                data-testid="pause-until-custom-time"
              />
            </div>
          </div>
        ) : null}
        {customError ? (
          <p
            className="text-meta text-danger"
            role="alert"
            data-testid="pause-until-custom-error"
          >
            {customError}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {/* 저장 중에는 닫는 모든 길을 같은 규칙으로 막는다(Esc·바깥 누름·취소). 취소만 열려 있으면
              사람이 「취소」를 눌렀는데 쓰기는 나가서 방해 금지·일시 중지가 켜지고, 늦게 온 실패는 닫힌 창
              대신 다음에 여는 창에 먼저 보인다(design-review H1). */}
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            data-testid="pause-until-cancel"
            onClick={() => {
              if (pending) return;
              onOpenChange(false);
            }}
          >
            {CANCEL_LABEL}
          </Button>
          <Button
            type="button"
            disabled={busy || choice === ""}
            data-testid="pause-until-confirm"
            onClick={confirm}
          >
            {pending ? SAVING_LABEL : pauseUntilConfirmLabel(kind)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
