import { Button } from "@/design/ui/button";
import { InlineBanner } from "@/features/common/States";
import { StatusChip } from "@/features/settings/SettingsFields";
import { SettingsRow } from "@/features/settings/shell/SettingsRow";
import { SettingsSection } from "@/features/settings/shell/SettingsSection";
import { CardBody } from "@/features/settings/workTierPolicy";
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

/** 상태 칩 옆에 붙는 한 문장. 칩은 낱말이라 지금 무엇을 기다리는지는 이 줄이 말한다. */
function stateSentence(state: UpdateState): string {
  switch (state.kind) {
    case "checking":
      return "새 버전이 있는지 확인하고 있어요.";
    case "current":
      return "지금 쓰는 버전이 가장 최신이에요.";
    case "available":
      return "받을 수 있는 새 버전이 있어요.";
    case "installing":
      return "새 버전을 받고 있어요. 앱은 그대로 쓸 수 있어요.";
    case "installed":
      return "설치를 마쳤어요. 재시작하면 새 버전으로 열려요.";
    case "failed":
      return "확인하지 못했어요. 아래 안내를 따라 다시 시도하세요.";
    default:
      return "아직 확인하지 않았어요.";
  }
}

export function UpdateSection() {
  const state = useUpdateState();
  const version = useAppVersion();

  const hasUpdate =
    state.kind === "available" || state.kind === "installing" || state.kind === "installed";
  const published = hasUpdate ? formatPublishedAt(state.update.publishedAt) : null;
  const busy = state.kind === "checking" || state.kind === "installing";

  return (
    <div className="flex min-w-0 flex-col gap-8" data-testid="updates-page">
      <SettingsSection
        title="앱 업데이트"
        description="앱이 스스로 새 버전으로 바꿔요. 내려받은 파일은 서명을 검증한 뒤에만 설치해요. 설치는 지금 하고 재시작은 나중에 해도 돼요. 쓰던 화면은 그대로 있어요."
      >
        <SettingsRow label="지금 버전">
          <span className="font-mono text-body text-ink" data-numeric>
            {version ?? "확인 중"}
          </span>
        </SettingsRow>
        {hasUpdate && (
          <SettingsRow label="새 버전">
            <span className="font-mono text-body text-ink" data-numeric>
              {state.update.version}
            </span>
          </SettingsRow>
        )}
        {published && (
          <SettingsRow label="공개일">
            <span className="text-body text-ink">{published}</span>
          </SettingsRow>
        )}
        <SettingsRow label="상태" description={stateSentence(state)} keep>
          <div className="flex items-center gap-2" data-testid="update-status">
            <StateChip state={state} />
          </div>
        </SettingsRow>

        {state.kind === "failed" && (
          <CardBody>
            <InlineBanner
              message={state.message}
              actionLabel="다시 시도"
              onAction={() => void checkForUpdate()}
              separator={false}
              className="px-0"
              testId="update-error"
            />
            {state.detail && (
              <p className="break-all text-meta text-ink-muted">{state.detail}</p>
            )}
          </CardBody>
        )}

        {state.kind === "available" && state.update.notes && (
          <SettingsRow label="변경 내용" stack>
            <p className="whitespace-pre-line text-body text-ink-muted" data-testid="update-notes">
              {state.update.notes}
            </p>
          </SettingsRow>
        )}

        {state.kind === "installing" && (
          <CardBody>
            <InstallProgress state={state} />
          </CardBody>
        )}

        {state.kind === "installed" && (
          <CardBody>
            <p className="text-body text-ink" data-testid="update-installed">
              새 버전이 설치됐어요. 재시작하면 {state.update.version}(으)로 열려요.
            </p>
          </CardBody>
        )}

        {(state.kind === "available" || state.kind === "installed") && (
          <SettingsRow
            label={state.kind === "available" ? "새 버전 설치" : "재시작"}
            description={
              state.kind === "available"
                ? "설치는 지금 하고 재시작은 나중에 해도 돼요."
                : "지금 재시작하거나, 쓰던 일을 마친 뒤에 열어도 돼요."
            }
          >
            {state.kind === "available" ? (
              <Button size="sm" onClick={() => void installUpdate()} data-testid="update-install">
                지금 업데이트
              </Button>
            ) : (
              <Button size="sm" onClick={() => void relaunchIntoUpdate()} data-testid="update-relaunch">
                지금 재시작
              </Button>
            )}
          </SettingsRow>
        )}
        <SettingsRow label="직접 확인" description="새 버전이 나왔는지 바로 물어봐요.">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void checkForUpdate()}
            data-testid="update-check"
          >
            {state.kind === "checking" ? "확인 중" : "업데이트 확인"}
          </Button>
        </SettingsRow>
      </SettingsSection>
    </div>
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
