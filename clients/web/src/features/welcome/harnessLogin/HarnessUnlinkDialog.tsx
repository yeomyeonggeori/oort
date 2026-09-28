import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import {
  UNLINK_BUSY_LABEL,
  UNLINK_DONE_STATUS,
  UNLINK_REMOVING_DETAIL,
  UNLINK_REMOVING_LINE,
  UNLINK_SIGNING_OUT_LINE,
  destructiveActionLabel,
  unlinkDialogBody,
  unlinkDialogTitle,
  unlinkFailedDetail,
  unlinkFailedLine,
  unlinkSigningOutDetail,
  type HarnessProfileRef,
  type MyAccountRow,
  type UnlinkPhase,
} from "@momo/core/features/settings/harnessProfiles";
import {
  LOGIN_CANCEL_LABEL,
  LOGIN_CLOSE_LABEL,
  LOGIN_RETRY_LABEL,
  LOGIN_TERMINAL_HIDE_LABEL,
  LOGIN_TERMINAL_SHOW_LABEL,
} from "@momo/core/features/onboarding/harnessLogin";
import { keyPlatformOf } from "@momo/core/features/workbench/keymap";
import {
  impactLine,
  unlinkImpactLead,
  type AiDefaultImpact,
} from "@momo/core/features/settings/aiDefaults";
import { Button } from "@/design/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/design/ui/dialog";
import { loadBrowserMirror } from "@/features/workbench/local/localSessions";
import { LocalTerminalPane } from "@/features/workbench/local/LocalTerminalPane";
import { desktopPty, harnessProfileRemove } from "@/lib/tauri";
import { createUnlinkController, type UnlinkController } from "./unlinkController";

// Reading this as: settings (AI 연결 · 내 계정) for internal team users on Tauri
// desktop, density 5/10, motion 1/10 (the dialog's own enter/exit only).

/** design 캡처가 세우는 상태. 캡처는 PTY를 만들지 않는다. */
export interface HarnessUnlinkFixture {
  status: UnlinkPhase;
}

/**
 * 내 계정 줄의 파괴적 행동 확인 창 (#2878 AA-4, 시안 §3 왼쪽).
 *
 * - oort 프로필: 「연결 해제」 → 숨은 PTY에서 공식 CLI 로그아웃 → 셸이 확인한 뒤
 *   폴더 삭제. 진행·실패를 이 창 안에서 말하고, 실패면 폴더가 남았다고 쓴다.
 * - 이 맥의 기본 로그인: 「목록에서 빼기」만. PTY도 셸 호출도 없다(Q2).
 *
 * 팀 키 「연결 끊기」(`TeamUnlinkDialog`)와 같은 모양(alertdialog, 위험 단추 오른쪽).
 */
export function HarnessUnlinkDialog({
  row,
  opener,
  onClose,
  onRemoveFromList,
  onUnlinked,
  fixture,
  impact = [],
}: {
  /**
   * 이 계정을 기본으로 고른 기본 AI 칸과 넘어갈 곳(#2881, 코어 `rowsUsingAccount`).
   * 비어 있으면 아무 줄도 그리지 않는다.
   */
  impact?: readonly AiDefaultImpact[];
  /** 대상 줄. null이면 닫혀 있다. */
  row: Pick<MyAccountRow, "harness" | "profile"> | null;
  opener: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** 기본 로그인 줄의 「목록에서 빼기」. 이 기기 설정만 바꾼다. */
  onRemoveFromList: (row: Pick<MyAccountRow, "harness">) => void;
  /**
   * 해제가 끝났거나(`done` = 폴더 삭제) 폴더 상태가 바뀌었을 수 있다: 목록을 다시
   * 묻는다.
   */
  onUnlinked: (done: boolean) => void;
  fixture?: HarnessUnlinkFixture | null;
}) {
  // 셸이 폴더를 정리하는 동안에는 창을 닫지 않는다(멈출 수 없는 일이다).
  const [locked, setLocked] = useState(false);
  return (
    <Dialog
      open={row !== null}
      onOpenChange={(open) => {
        if (!open && !locked) onClose();
      }}
    >
      {row !== null && (
        <DialogContent
          role="alertdialog"
          opener={opener.current}
          className="gap-3 p-4"
          onEscapeKeyDown={(event) => {
            if (locked) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (locked) event.preventDefault();
          }}
          data-testid="my-account-unlink-dialog"
        >
          {row.profile === null ? (
            <RemoveFromListBody
              row={row}
              impact={impact}
              onCancel={onClose}
              onConfirm={() => {
                onRemoveFromList(row);
                onClose();
              }}
            />
          ) : (
            <UnlinkProfileBody
              key={`${row.harness}/${row.profile}`}
              profile={{ harness: row.harness, label: row.profile }}
              onClose={onClose}
              onUnlinked={onUnlinked}
              onLockChange={setLocked}
              fixture={fixture ?? null}
              impact={impact}
            />
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}

/**
 * 해제 영향: 「기본 AI에서 이 계정을 쓰던 칸」과 그 칸이 넘어갈 곳(brief §3.4). 확인
 * 단계에만 선다. 조용히 폴백으로 바뀌지 않게 이름으로 먼저 말한다.
 */
function ImpactList({ impact }: { impact: readonly AiDefaultImpact[] }) {
  const lead = unlinkImpactLead(impact);
  if (lead === null) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg bg-surface-muted px-3 py-2" data-testid="my-account-unlink-impact">
      <p className="break-keep text-meta text-ink">{lead}</p>
      <ul className="flex flex-col gap-1">
        {impact.map((item) => (
          <li key={item.rowId} className="break-keep text-meta text-ink-muted">
            {impactLine(item)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RemoveFromListBody({
  row,
  impact,
  onCancel,
  onConfirm,
}: {
  row: Pick<MyAccountRow, "harness" | "profile">;
  impact: readonly AiDefaultImpact[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <>
      <DialogTitle className="text-title font-bold [overflow-wrap:anywhere]">
        {unlinkDialogTitle(row)}
      </DialogTitle>
      <DialogDescription className="break-keep text-body text-ink-muted" data-testid="my-account-unlink-body">
        {unlinkDialogBody(row)}
      </DialogDescription>
      <ImpactList impact={impact} />
      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" className="tap-target" onClick={onCancel} data-testid="my-account-unlink-cancel">
          {LOGIN_CANCEL_LABEL}
        </Button>
        {/* 되돌릴 수 있는 이 기기 숨김이라 파괴 빨강이 아니다(「다시 보이기」가 있다). */}
        <Button
          type="button"
          size="sm"
          className="tap-target"
          onClick={onConfirm}
          data-testid="my-account-unlink-confirm"
        >
          {destructiveActionLabel(row)}
        </Button>
      </div>
    </>
  );
}

const IDLE: { status: UnlinkPhase; paneId: string } = { status: { phase: "confirm" }, paneId: "" };

function noopSubscribe(): () => void {
  return () => undefined;
}

function UnlinkProfileBody({
  profile,
  onClose,
  onUnlinked,
  onLockChange,
  fixture,
  impact,
}: {
  profile: HarnessProfileRef;
  impact: readonly AiDefaultImpact[];
  onClose: () => void;
  onUnlinked: (done: boolean) => void;
  onLockChange: (locked: boolean) => void;
  fixture: HarnessUnlinkFixture | null;
}) {
  const controller: UnlinkController | null = useMemo(
    () =>
      fixture
        ? null
        : createUnlinkController(profile, {
            pty: desktopPty,
            loadMirror: loadBrowserMirror,
            remove: harnessProfileRemove,
          }),
    // 한 번 열린 창은 한 컨트롤러를 쓴다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  useEffect(() => () => controller?.dispose(), [controller]);
  const live = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getState ?? (() => IDLE),
    () => IDLE
  );
  const status = fixture?.status ?? live.status;
  const row = { harness: profile.harness, profile: profile.label };
  const lineId = useId();
  const [terminalOpen, setTerminalOpen] = useState(false);
  const primaryRef = useRef<HTMLButtonElement>(null);

  // 상태가 바뀌면 키보드의 첫 자리도 옮긴다: 확인 = 취소(위험 단추가 기본이 아니다),
  // 진행 = 취소, 실패 = 다시 시도.
  useEffect(() => {
    primaryRef.current?.focus();
  }, [status.phase]);

  // 끝났다: 목록을 다시 묻고 닫는다. 실패도 폴더 상태가 바뀌었을 수 있어 목록을
  // 다시 묻는다(로그아웃은 됐는데 삭제가 안 된 경우 등).
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (fixture) return;
    if (status.phase !== "done" && status.phase !== "failed") return;
    const key = status.phase === "failed" ? `failed:${status.reason}:${live.paneId}` : "done";
    if (reported.current === key) return;
    reported.current = key;
    onUnlinked(status.phase === "done");
    if (status.phase === "done") onClose();
  }, [fixture, status, live.paneId, onUnlinked, onClose]);

  const busy = status.phase === "signing-out" || status.phase === "removing";
  const removing = status.phase === "removing";
  useEffect(() => {
    onLockChange(removing);
    return () => onLockChange(false);
  }, [removing, onLockChange]);
  const failed = status.phase === "failed";
  const canShowTerminal =
    (busy || (failed && status.reason !== "spawn")) && (controller === null || live.paneId !== "");

  let heading = unlinkDialogTitle(row);
  let body = unlinkDialogBody(row);
  if (status.phase === "signing-out") {
    heading = UNLINK_SIGNING_OUT_LINE;
    body = unlinkSigningOutDetail(profile.harness);
  } else if (status.phase === "removing") {
    heading = UNLINK_REMOVING_LINE;
    body = UNLINK_REMOVING_DETAIL;
  } else if (status.phase === "failed") {
    heading = unlinkFailedLine(status.reason);
    body = unlinkFailedDetail(profile.harness, status.reason);
  } else if (status.phase === "done") {
    heading = UNLINK_DONE_STATUS;
  }

  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      data-testid="my-account-unlink-profile"
      data-phase={status.phase}
      aria-busy={busy || undefined}
    >
      <DialogTitle className="text-title font-bold [overflow-wrap:anywhere]" data-testid="my-account-unlink-title">
        {heading}
      </DialogTitle>
      <DialogDescription
        id={lineId}
        className="break-keep text-body text-ink-muted"
        role={busy || failed ? "status" : undefined}
        data-testid="my-account-unlink-body"
      >
        {body}
      </DialogDescription>
      {status.phase === "confirm" && <ImpactList impact={impact} />}

      {canShowTerminal && (
        <div className="flex min-w-0 flex-col gap-2">
          <button
            type="button"
            className="harness-login-disclosure press focus-visible:focus-ring self-start"
            aria-expanded={terminalOpen}
            aria-controls={terminalOpen ? `${lineId}-terminal` : undefined}
            onClick={() => setTerminalOpen((open) => !open)}
            data-testid="my-account-unlink-terminal-toggle"
          >
            {terminalOpen ? LOGIN_TERMINAL_HIDE_LABEL : LOGIN_TERMINAL_SHOW_LABEL}
          </button>
          {terminalOpen && controller !== null && (
            <div id={`${lineId}-terminal`} className="harness-login-terminal" data-testid="my-account-unlink-terminal">
              <LocalTerminalPane
                key={live.paneId}
                pane={{ id: live.paneId, index: 1, focused: true, maximized: false }}
                platform={keyPlatformOf(navigator.platform || navigator.userAgent)}
                sessions={controller.sessions}
                label={`${unlinkDialogTitle(row)} 터미널`}
                restartable={false}
              />
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        {status.phase === "confirm" ? (
          <>
            <Button
              ref={primaryRef}
              type="button"
              variant="ghost"
              size="sm"
              className="tap-target"
              onClick={onClose}
              data-testid="my-account-unlink-cancel"
            >
              {LOGIN_CANCEL_LABEL}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="tap-target"
              onClick={() => controller?.confirm()}
              data-testid="my-account-unlink-confirm"
            >
              {destructiveActionLabel(row)}
            </Button>
          </>
        ) : failed ? (
          <>
            <Button
              ref={primaryRef}
              type="button"
              variant="ghost"
              size="sm"
              className="tap-target"
              onClick={onClose}
              data-testid="my-account-unlink-close"
            >
              {LOGIN_CLOSE_LABEL}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="tap-target"
              onClick={() => controller?.confirm()}
              data-testid="my-account-unlink-retry"
            >
              {LOGIN_RETRY_LABEL}
            </Button>
          </>
        ) : (
          <>
            {/* 로그아웃 중의 취소는 공식 CLI를 멈추고 폴더를 남긴다. 폴더 정리는 셸이
                이미 하고 있어 멈출 수 없으므로 그 단계에는 취소가 없다. */}
            {status.phase === "signing-out" && (
              <Button
                ref={primaryRef}
                type="button"
                variant="ghost"
                size="sm"
                className="tap-target"
                onClick={onClose}
                data-testid="my-account-unlink-cancel"
              >
                {LOGIN_CANCEL_LABEL}
              </Button>
            )}
            <Button
              ref={removing ? primaryRef : undefined}
              type="button"
              variant="destructive"
              size="sm"
              className="tap-target opacity-50 hover:opacity-50"
              aria-disabled
              aria-busy
              data-testid="my-account-unlink-busy"
            >
              {UNLINK_BUSY_LABEL}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
