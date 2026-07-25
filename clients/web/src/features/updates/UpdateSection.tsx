import { Button } from "@/design/ui/button";
import { InlineBanner } from "@/features/common/States";
import {
  KeyValueRows,
  SectionShell,
  StatusChip,
} from "@/features/settings/SettingsFields";
import {
  formatPublishedAt,
  progressLabel,
  progressPercent,
  type UpdateState,
} from "./model";
import {
  checkForUpdate,
  installUpdate,
  relaunchIntoUpdate,
  useAppVersion,
  useUpdateState,
} from "./store";

// =============================================================================
// 설정 > 업데이트 (ADR-0133 P2, MOMO-606).
//
// The alpha channel asked a tester to download a zip, drag it over the old app
// and relaunch. Three manual steps is three chances to end up running a build
// nobody can identify from the bug report that follows. This panel replaces all
// three with one button, and then a second button for the restart, because
// restarting is the only part that costs the person anything.
//
// Rendered ONLY inside the desktop shell. A browser tab has no app bundle to
// replace: reloading already gets the newest bundle, so a section explaining
// that would be a panel whose entire content is "not applicable".
// =============================================================================

/** Status chip vocabulary, text-first: colour never carries the meaning alone. */
function StateChip({ state }: { state: UpdateState }) {
  switch (state.kind) {
    case "checking":
      return <StatusChip tone="muted">확인 중</StatusChip>;
    case "current":
      return <StatusChip tone="ok">최신</StatusChip>;
    case "available":
      return <StatusChip tone="accent">새 버전 있음</StatusChip>;
    case "installing":
      return <StatusChip tone="accent">받는 중</StatusChip>;
    case "installed":
      return <StatusChip tone="ok">재시작 대기</StatusChip>;
    case "failed":
      return <StatusChip tone="danger">확인 실패</StatusChip>;
    default:
      return null;
  }
}

export function UpdateSection() {
  const state = useUpdateState();
  const version = useAppVersion();

  const rows = [{ key: "지금 버전", value: version ?? "확인 중", numeric: true }];
  if (state.kind === "available" || state.kind === "installing" || state.kind === "installed") {
    rows.push({ key: "새 버전", value: state.update.version, numeric: true });
    const published = formatPublishedAt(state.update.publishedAt);
    if (published) rows.push({ key: "공개일", value: published, numeric: false });
  }

  const busy = state.kind === "checking" || state.kind === "installing";

  return (
    <SectionShell
      title="업데이트"
      lines={[
        "앱이 스스로 새 버전으로 바꿉니다. 내려받은 파일은 서명을 검증한 뒤에만 설치됩니다.",
        "설치는 지금 하고 재시작은 나중에 해도 됩니다. 쓰던 화면은 그대로 있습니다.",
      ]}
    >
      <div className="flex items-center gap-2" data-testid="update-status">
        <StateChip state={state} />
      </div>

      <KeyValueRows rows={rows} />

      {state.kind === "failed" && (
        <div className="flex flex-col gap-1">
          <InlineBanner
            message={state.message}
            actionLabel="다시 시도"
            onAction={() => void checkForUpdate()}
            testId="update-error"
          />
          {state.detail && (
            <p className="break-all text-meta text-ink-muted">{state.detail}</p>
          )}
        </div>
      )}

      {state.kind === "available" && state.update.notes && (
        <p className="whitespace-pre-line text-body text-ink-muted" data-testid="update-notes">
          {state.update.notes}
        </p>
      )}

      {state.kind === "installing" && <InstallProgress state={state} />}

      {state.kind === "installed" && (
        <p className="text-body text-ink" data-testid="update-installed">
          새 버전이 설치됐습니다. 재시작하면 {state.update.version} 으로 열립니다.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {state.kind === "available" && (
          <Button size="sm" onClick={() => void installUpdate()} data-testid="update-install">
            지금 업데이트
          </Button>
        )}
        {state.kind === "installed" && (
          <Button size="sm" onClick={() => void relaunchIntoUpdate()} data-testid="update-relaunch">
            지금 재시작
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void checkForUpdate()}
          data-testid="update-check"
        >
          {state.kind === "checking" ? "확인 중" : "업데이트 확인"}
        </Button>
      </div>
    </SectionShell>
  );
}

/**
 * Download progress. The bar is a native `<progress>` driven by value/max
 * attributes: CSP forbids the inline width an ordinary div bar would need, and
 * the platform control already announces itself to a screen reader. It is only
 * drawn when a length is known; an indeterminate bar that never fills is the
 * kind of perpetual motion that says nothing.
 */
function InstallProgress({
  state,
}: {
  state: Extract<UpdateState, { kind: "installing" }>;
}) {
  const percent = progressPercent(state.downloaded, state.total);
  return (
    <div className="flex flex-col gap-1" data-testid="update-progress">
      {percent !== null && state.total !== null && (
        <progress
          className="progress-bar"
          value={state.downloaded}
          max={state.total}
          aria-label="업데이트 내려받는 중"
        />
      )}
      <p className="font-mono text-meta text-ink-muted" data-numeric>
        {progressLabel(state.downloaded, state.total)}
        {percent !== null ? ` (${percent}%)` : ""}
      </p>
    </div>
  );
}
