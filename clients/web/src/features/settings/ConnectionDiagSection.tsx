import { useSyncExternalStore } from "react";
import { RenderErrorBoundary } from "@/features/common/RenderErrorBoundary";
import {
  clearConnectionDiag,
  readConnectionDiag,
  subscribeConnectionDiag,
} from "@/features/common/connectionDiag";
import { CopyTextButton } from "@/features/recovery/CopyTextButton";
import { SettingsRow } from "@/features/settings/shell/SettingsRow";
import { SettingsSection } from "@/features/settings/shell/SettingsSection";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import {
  connectionDiagToday,
  formatConnectionDiag,
  type ConnectionDiagGroup,
} from "@momo/core/features/connection/diagnosticLog";
import type { PlainMessageKey } from "./settingsNav";

// =============================================================================
// 설정 > 업데이트 > 연결 기록 (#5587). 읽기 전용이다.
//
// 연결 판정이 흔들린 까닭을 owner 기기에서 가려내려고 남기는 기기 안 기록(`connectionDiag.ts`)을 꺼내 보는 가장 작은 자리다. 오늘의 횟수를
// 묶음별로 보이고(묶음은 코어 `CONNECTION_DIAG_GROUPS`가 종류 이름으로 정한다), 기록 전체(UTC 시각 + 종류 낱말, 한 줄에 한 건)를 복사하는
// 단추 하나를 둔다. 「연결에 문제가 있어요」 카드가 이미 「연결 기록을 복사해 알려 주세요」라고 말하므로 단추 이름이 그 문장과 같다.
//
// - 복사 결과(복사됨·실패)는 읽기 도구에도 알린다: 같은 나무의 `CopyTextButton`(알림 자리 `role="status"`)을 쓴다(수리 1회차 M2).
// - 기록이 가득 차 오늘 기록의 앞쪽이 빠졌을 수 있으면 횟수가 「최근 500건 기준」이라고 말한다(M3).
// - 이 카드 하나가 그리다 무너져도 설정 > 업데이트 페이지는 서 있다: 카드만 따로 감싸고, 서버 탓이 아니라 이 기기의 기록을 읽지 못했다고
//   말하며 「기록 비우기」로 나갈 길을 준다(H1).
//
// 데스크탑에서만 선다(이 페이지가 데스크탑 전용이고, 기록도 데스크탑에서만 남는다).
// =============================================================================

/** 오늘의 횟수를 보이는 줄. 순서(사람이 먼저 물을 것부터)는 이 표의 순서다. 모든 묶음이 줄을 가진다(타입이 빠진 묶음을 막는다). */
const ROWS: Readonly<Record<ConnectionDiagGroup, { readonly labelKey: PlainMessageKey; readonly testId: string }>> = {
  sendBlocked: { labelKey: "settings.connectionLog.sendBlocked", testId: "connection-log-send-blocked" },
  deviceOffline: { labelKey: "settings.connectionLog.deviceOffline", testId: "connection-log-device-offline" },
  serverNoAnswer: { labelKey: "settings.connectionLog.restFailed", testId: "connection-log-rest-failed" },
  socketDown: { labelKey: "settings.connectionLog.socketDown", testId: "connection-log-socket-down" },
  appRested: { labelKey: "settings.connectionLog.wakeLate", testId: "connection-log-wake-late" },
  cutWhileResting: { labelKey: "settings.connectionLog.cutWhileResting", testId: "connection-log-cut-while-resting" },
  windowHidden: { labelKey: "settings.connectionLog.windowHidden", testId: "connection-log-window-hidden" },
  // 새 버전 확인이 피드에 닿지 못한 횟수(#5661). 확인하지 않는 판(`update.check.off`)은 묶음에 들지 않고 복사 글에만 남는다.
  updateCheckFailed: { labelKey: "settings.connectionLog.updateCheckFailed", testId: "connection-log-update-check-failed" },
};
const ROW_ORDER = Object.keys(ROWS) as ConnectionDiagGroup[];

export function ConnectionDiagSection({ appVersion }: { appVersion: string | null }) {
  const formatMessage = useFormatMessage();
  return (
    <RenderErrorBoundary
      title={formatMessage("settings.connectionLog.readFailedTitle")}
      message={formatMessage("settings.connectionLog.readFailedMessage")}
      retryLabel={formatMessage("settings.connectionLog.clear")}
      onRetry={clearConnectionDiag}
      padded={false}
    >
      <ConnectionDiagCard appVersion={appVersion} />
    </RenderErrorBoundary>
  );
}

function ConnectionDiagCard({ appVersion }: { appVersion: string | null }) {
  const formatMessage = useFormatMessage();
  const log = useSyncExternalStore(subscribeConnectionDiag, readConnectionDiag, readConnectionDiag);
  const today = connectionDiagToday(log, Date.now());
  // 첫 줄은 앱 버전(알 때만)이다. 나머지는 한 줄에 한 건(UTC 시각 + 종류 낱말).
  const text = [appVersion, formatConnectionDiag(log)].filter((line) => line !== null).join("\n");

  return (
    <SettingsSection
      title={formatMessage("settings.connectionLog.title")}
      description={formatMessage("settings.connectionLog.description")}
      testId="connection-log"
    >
      {today.cappedToday && (
        <SettingsRow label={formatMessage("settings.connectionLog.cappedToday")} plain testId="connection-log-capped" />
      )}
      {ROW_ORDER.map((group) => (
        <SettingsRow key={group} label={formatMessage(ROWS[group].labelKey)} testId={ROWS[group].testId}>
          <span className="font-mono text-body text-ink" data-numeric>
            {formatMessage("settings.connectionLog.count", { count: today.counts[group] })}
          </span>
        </SettingsRow>
      ))}
      <SettingsRow
        label={formatMessage("settings.connectionLog.copyLabel")}
        description={formatMessage("settings.connectionLog.copyDescription")}
      >
        <div className="flex items-center gap-2">
          <CopyTextButton
            value={text}
            label={formatMessage("settings.connectionLog.copy")}
            copiedLabel={formatMessage("settings.connectionLog.copied")}
            failedLabel={formatMessage("settings.connectionLog.copyFailed")}
            testId="connection-log-copy"
          />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
