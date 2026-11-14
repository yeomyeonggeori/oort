import * as React from "react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/design/ui/dialog";

// Reading this as: a destructive-or-weighty confirmation for internal team users on web + the
// Tauri shell, density 6/10, motion 2/10.

// =============================================================================
// 확인 창 (#5780). 「누르면 되돌리기 어려운 일」 앞의 한 걸음을 한 부품으로 세운다.
//
// 이 앱에는 `AlertDialog` 의존이 없어서 확인 창을 쓰는 곳마다 `DialogContent role="alertdialog"` 를 손으로
// 조립했다(팀 키 끊기·하니스 끊기·GitHub 구독·개인 키 회수). 생김새·초점·잠김이 조금씩 달랐다. 이 파일이 그
// 문법 하나다:
//
//   [대상 줄] · 제목(무엇을 할지 묻는 한 문장) · 설명 · [경고 한 줄] · [오류] · [잠긴 까닭] · 취소 | 확정 단추
//
// ## 두 그릇, 한 몸
//
// - `ConfirmDialog`: 화면 위에 처음 뜨는 확인 창. `Dialog` + `role="alertdialog"`.
// - `ConfirmStage`: **이미 떠 있는 표면 안의 단계**. 표면(층 300) 위에 두 번째 대화상자를 세우면 그 스크림(층 200)이
//   앞 표면 아래에 깔려 앞 표면만 밝게 남는다 — 디자인 시스템 §3.4(#4986)가 그 결함을 적고 「확인은 표면 안의 단계로
//   선다」고 정했다. 멤버 프로필의 역할 바꾸기가 이 그릇을 쓴다(`PasswordResetStage` 와 같은 자리).
//
// 두 그릇의 몸(`ConfirmBody`)은 같다. 차이는 제목이 대화상자의 제목(`DialogTitle`)인지 단계의 머리(`h3` + `role="group"`)인지,
// 그리고 Esc·바깥 누름을 누가 받는지(대화상자는 Radix, 단계는 그 표면)뿐이다.
//
// ## 계약
//
// - 초점은 열리면 **안전한 쪽(취소)** 으로 들어간다(§3.4). 확정은 한 번 더 Tab 이다.
// - `tone="destructive"` 면 확정 단추가 위험 채움이다(파괴 > 주 > 보조, §3.1). 기본은 주 단추(잉크).
// - `busy` 면 확정 단추가 `aria-busy` + 진행 낱말이고 다시 눌러도 아무 일 없다. **취소도 `aria-disabled` 이고 눌러도
//   아무 일 없다**: 요청이 이미 나갔으면 취소는 아무것도 되돌리지 못하니, 취소된 것처럼 물러서면 안 된다(#5780 검수 r1 H1).
//   초점은 남는다(`disabled` 가 아니다). 두 그릇 모두 같다 — 대화상자는 Esc·바깥 누름도 같은 가드(`requestClose`)를 거친다.
// - `lockedReason` 이 있으면 확정이 `aria-disabled` 로 잠기고 그 문장을 가리킨다(오프라인 등). 초점은 남는다.
// - **확정은 서고 나서 `CONFIRM_ARM_MS`(500ms) 동안 눌림을 받지 않는다**(#5781, #5818 검수 High): 메뉴 줄·관리 줄을 누른
//   자리에 위험 확정 단추가 서면, 더블클릭이나 떨리는 손의 둘째 누름(250~400ms 뒤)이 그대로 확정을 누른다. 그동안의 누름·
//   Enter·Space 는 아무 일도 하지 않고, 모양은 그대로다(깜빡임·흐림 없음 — 사람이 읽고 누르는 데는 500ms 보다 오래 걸린다).
//   취소는 처음부터 받는다. 줄인 움직임 설정과 무관하게 같은 시간이다(움직임이 아니라 입력의 문제다).
// - 문구는 이 파일에 없다. 부르는 쪽이 사전 키로 넘긴다(직접 문구 장부).
// =============================================================================

export type ConfirmTone = "default" | "destructive";

/** 확인이 선 뒤 확정 단추가 눌림을 받지 않는 시간(ms). 사람의 더블클릭 간격(대개 500ms 안)을 덮는다. */
export const CONFIRM_ARM_MS = 500;

export interface ConfirmBodyProps {
  /** 제목 위의 「누구에 대한」 줄(작은 얼굴 + 이름 등). 단계가 본문을 덮어도 대상이 남게 한다. */
  subject?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  /** 확정이 되돌릴 수 없을 때 등, 설명 뒤에 위험색으로 서는 한 줄. */
  warning?: string;
  confirmLabel: string;
  /** 요청이 도는 동안 확정 단추의 낱말. */
  busyLabel: string;
  cancelLabel: string;
  tone?: ConfirmTone;
  busy?: boolean;
  /** 실패를 그 자리에서 말한다(토스트가 아니다). */
  error?: string | null;
  /** 확정을 잠그는 까닭(오프라인 등). 주면 확정이 `aria-disabled` 가 되고 이 문장을 가리킨다. */
  lockedReason?: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  /** `data-testid` 접두사: `<id>`·`<id>-confirm`·`<id>-cancel`·`<id>-error`·`<id>-warning`. */
  testId?: string;
}

function ConfirmBody({
  subject,
  title,
  description,
  warning,
  confirmLabel,
  busyLabel,
  cancelLabel,
  tone = "default",
  busy = false,
  error = null,
  lockedReason,
  onConfirm,
  onCancel,
  testId,
  host,
  cancelRef,
  titleId,
  descriptionId,
}: ConfirmBodyProps & {
  host: "dialog" | "stage";
  cancelRef: React.RefObject<HTMLButtonElement>;
  titleId: string;
  descriptionId: string;
}) {
  const lockedId = React.useId();
  const locked = busy || lockedReason !== undefined;
  // 선 순간부터 `CONFIRM_ARM_MS` 동안 확정은 눌림을 받지 않는다(머리말). 다시 그려져도 시계는 다시 걸리지 않는다(서는 순간 한 번).
  const [armed, setArmed] = React.useState(false);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setArmed(true), CONFIRM_ARM_MS);
    return () => window.clearTimeout(timer);
  }, []);
  const holdKey = (event: React.KeyboardEvent) => {
    if (!armed && (event.key === "Enter" || event.key === " ")) event.preventDefault();
  };
  const id = (suffix: string) => (testId ? `${testId}-${suffix}` : undefined);
  return (
    <>
      {subject !== undefined ? subject : null}
      <div className="flex min-w-0 flex-col gap-1">
        {host === "dialog" ? (
          <DialogTitle id={titleId} className="[overflow-wrap:anywhere]">
            {title}
          </DialogTitle>
        ) : (
          <h3 id={titleId} className="text-title font-semibold text-ink [overflow-wrap:anywhere]">
            {title}
          </h3>
        )}
        {description !== undefined ? (
          host === "dialog" ? (
            <DialogDescription id={descriptionId} className="break-keep" asChild>
              <div>{description}</div>
            </DialogDescription>
          ) : (
            <div id={descriptionId} className="break-keep text-body text-ink-muted">
              {description}
            </div>
          )
        ) : null}
      </div>
      {warning ? (
        <p className="break-keep text-body font-semibold text-danger" data-testid={id("warning")}>
          {warning}
        </p>
      ) : null}
      {error ? (
        <p className="break-keep text-meta text-danger" role="alert" data-testid={id("error")}>
          {error}
        </p>
      ) : null}
      {lockedReason !== undefined ? (
        <p id={lockedId} className="break-keep text-meta text-ink-muted">
          {lockedReason}
        </p>
      ) : null}
      {/* 단추 줄은 내용 바로 아래에 붙는다: 단계가 앞 본문의 높이를 덮어 설 때도 바닥으로 떼지 않는다(#5780 검수 r2 N2 — 내용과
          단추 사이가 비지 않게). 남는 높이는 단추 줄 아래에 남는다. */}
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 pt-1">
        <Button
          ref={cancelRef}
          type="button"
          variant="ghost"
          size="sm"
          className={cn("tap-target", busy && "opacity-50 hover:opacity-50")}
          aria-disabled={busy || undefined}
          onClick={() => {
            if (!busy) onCancel();
          }}
          data-testid={id("cancel")}
        >
          {cancelLabel}
        </Button>
        <Button
          type="button"
          variant={tone === "destructive" ? "destructive" : "default"}
          size="sm"
          className={cn("tap-target", lockedReason !== undefined && !busy && "opacity-50 hover:opacity-50")}
          aria-disabled={locked || undefined}
          aria-busy={busy || undefined}
          aria-describedby={lockedReason !== undefined ? lockedId : undefined}
          onClick={() => {
            if (armed && !locked) onConfirm();
          }}
          onKeyDown={holdKey}
          onKeyUp={holdKey}
          data-testid={id("confirm")}
          data-tone={tone}
          data-armed={armed ? "true" : "false"}
        >
          {busy ? busyLabel : confirmLabel}
        </Button>
      </div>
    </>
  );
}

/**
 * 화면 위에 처음 뜨는 확인 창. 닫히면 초점이 `opener` 로 돌아간다(`DialogContent`).
 * 요청이 도는 동안(`busy`)에는 Esc·바깥 누름이 닫지 않는다.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  opener,
  ...body
}: Omit<ConfirmBodyProps, "onCancel"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  opener?: HTMLElement | null;
}) {
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const titleId = React.useId();
  const descriptionId = React.useId();
  // 닫는 길(Esc·바깥 누름·취소)은 하나의 가드를 거친다: 요청이 도는 동안에는 닫히지 않는다.
  const requestClose = (next: boolean) => {
    if (body.busy && !next) return;
    onOpenChange(next);
  };
  return (
    <Dialog open={open} onOpenChange={requestClose}>
      {open && (
        <DialogContent
          role="alertdialog"
          opener={opener ?? null}
          // 제목이 자기 id 를 쓰므로(`titleId`) Radix 가 자동으로 거는 이름 연결은 없는 요소를 가리킨다 → 창의 이름이 비었다(#5818 검수 r2).
          aria-labelledby={titleId}
          aria-describedby={body.description !== undefined ? descriptionId : undefined}
          className="gap-3 p-4"
          data-testid={body.testId}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus();
          }}
        >
          <ConfirmBody
            {...body}
            host="dialog"
            cancelRef={cancelRef}
            titleId={titleId}
            descriptionId={descriptionId}
            onCancel={() => requestClose(false)}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}

/**
 * 떠 있는 표면 **안의** 확인 단계(§3.4). 부르는 쪽이 자기 본문 자리에 이것을 세우고, Esc·바깥 누름은 그 표면이
 * 받아 `onCancel` 로 보낸다. 서면 초점이 취소로 들어간다.
 */
export function ConfirmStage({
  className,
  autoFocus = true,
  ...body
}: ConfirmBodyProps & {
  className?: string;
  /** 서면 초점을 취소로 옮길지. 기본은 옮긴다(§3.4). 견본(갤러리)처럼 사람이 부르지 않은 단계만 끈다. */
  autoFocus?: boolean;
}) {
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const titleId = React.useId();
  const descriptionId = React.useId();
  React.useEffect(() => {
    if (autoFocus) cancelRef.current?.focus({ preventScroll: true });
    // 서는 순간 한 번만: 다시 그려질 때 초점을 빼앗지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      aria-describedby={body.description !== undefined ? descriptionId : undefined}
      className={cn("flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto p-4", className)}
      data-testid={body.testId}
    >
      <ConfirmBody {...body} host="stage" cancelRef={cancelRef} titleId={titleId} descriptionId={descriptionId} />
    </div>
  );
}
