import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { RosterMember } from "@momo/core/lib/api";
import {
  passwordResetIssueMessage,
  type PasswordResetIssueFailure,
} from "@momo/core/features/directory/passwordResetIssue";
import { resetExpiryWhen } from "@momo/core/features/auth/passwordHelp";
import type { MessageKey } from "@momo/core/i18n";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { InlineBanner } from "@/features/common/States";
import { useLocaleService } from "@/i18n/useLocaleService";
import { CopyTextButton } from "./CopyTextButton";
import { PasswordResetPhase, type IssuePasswordResetHandle } from "./useIssuePasswordReset";

// Reading this as: member-profile admin stage for internal team users on web+Tauri,
// density 5/10, motion 2/10.

// =============================================================================
// 멤버 프로필 안의 「재설정 링크 만들기」 단계 (ADR-0215 D6, #4603).
//
// 겹쳐 뜬 확인 창이 아니라 **표면 안의 단계**다(디자인 시스템 §3.4, #4986): 프로필이 이미 떠 있는
// 층이라 그 위에 두 번째 대화상자를 세우면 스크림이 한 장 더 깔리고 앞의 표면이 가려진다. 그래서
// 프로필 본문이 이 단계로 바뀌고, 취소하면 프로필로 돌아간다.
//
// 확인 단계는 서버가 보는 세 가지를 사람에게 먼저 보인다: 이전 링크가 못 쓰게 되고, 한 번만
// 쓰이고, 받는 사람이 정하면 모든 기기가 로그아웃된다. 그리고 서버가 강제하지 못하는 한 가지 —
// **본인 확인은 관리자가 한다** — 를 말한다. 다섯 줄 모두가 사전 문장이고 하나라도 빠지면 시험이
// 빨개진다(수용 12c).
//
// 링크가 선 뒤에는 되돌릴 수 없다: 서버가 원문을 보관하지 않으므로 닫으면 다시 볼 길이 없다.
// 그래서 그 단계에서는 Esc·바깥 누름이 닫지 않고 「닫기」 단추만 닫는다(`MemberProfilePanel`).
// =============================================================================

const CONFIRM_LINES = [
  "recovery.issue.lineReplace",
  "recovery.issue.lineOnce",
  "recovery.issue.lineLogout",
  "recovery.issue.lineVerify",
  "recovery.issue.lineOrder",
] as const satisfies readonly MessageKey[];

function ConfirmForm({
  member,
  reset,
  offline,
  offlineReasonId,
}: {
  member: RosterMember;
  reset: IssuePasswordResetHandle;
  offline: boolean;
  offlineReasonId: string | undefined;
}) {
  const locale = useLocaleService();
  const { formatMessage } = locale;
  const titleId = useId();
  const passwordId = useId();
  const hintId = useId();
  const errorId = useId();
  const groupRef = useRef<HTMLDivElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const busy = reset.phase === PasswordResetPhase.Issuing;
  const failure = reset.failure;
  const atField = failure?.atPasswordField === true;

  // 단계가 서면 초점이 그룹으로 들어온다: 제목과 다섯 줄이 먼저 읽히고, 다음 Tab이 비밀번호 칸이다.
  // 칸에 바로 앉히면 읽는 도구가 확인할 내용을 듣기 전에 「내 비밀번호」부터 듣는다.
  useEffect(() => {
    groupRef.current?.focus({ preventScroll: true });
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy || offline) return;
    const refused = await reset.submit(member, password);
    if (refused === null) return;
    // 서버가 비밀번호를 판정했으면 그 값은 남기지 않고 칸에서 다시 받는다. 다른 사유(사다리·속도·
    // 네트워크)는 입력을 그대로 두어 다시 시도할 수 있게 한다.
    if (refused.clearPassword) setPassword("");
    if (refused.atPasswordField) passwordRef.current?.focus();
  }

  const message = (refused: PasswordResetIssueFailure) =>
    passwordResetIssueMessage(refused, formatMessage);

  return (
    <form
      onSubmit={(event) => void onSubmit(event)}
      noValidate
      className="flex min-h-0 flex-col"
      data-testid="member-profile-reset-stage"
    >
      <div
        ref={groupRef}
        role="group"
        tabIndex={-1}
        aria-labelledby={titleId}
        className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4 focus-visible:focus-ring"
      >
        <div className="flex flex-col gap-1">
          <h3 id={titleId} className="text-title font-semibold text-ink">
            {formatMessage("recovery.issue.confirmTitle")}
          </h3>
          <p className="break-keep text-body text-ink-muted">
            {formatMessage("recovery.issue.confirmLead", { name: member.displayName })}
          </p>
        </div>

        <ul
          className="flex list-disc flex-col gap-2 pl-4 text-body text-ink marker:text-ink-muted"
          data-testid="member-profile-reset-lines"
        >
          {CONFIRM_LINES.map((key) => (
            <li key={key} className="break-keep">
              {formatMessage(key)}
            </li>
          ))}
        </ul>

        {failure !== null && !atField ? (
          <InlineBanner
            tone="error"
            message={message(failure)}
            separator={false}
            testId="member-profile-reset-error"
          />
        ) : null}

        <div className="flex flex-col gap-1">
          <label htmlFor={passwordId} className="text-body text-ink-muted">
            {formatMessage("recovery.issue.passwordLabel")}
          </label>
          <Input
            id={passwordId}
            ref={passwordRef}
            type="password"
            name="currentPassword"
            autoComplete="current-password"
            maxLength={1024}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            readOnly={busy}
            aria-invalid={atField || undefined}
            aria-describedby={atField ? `${hintId} ${errorId}` : hintId}
            data-testid="member-profile-reset-password"
          />
          {atField && failure !== null ? (
            <p
              id={errorId}
              role="alert"
              className="text-meta text-danger"
              data-testid="member-profile-reset-password-error"
            >
              {message(failure)}
            </p>
          ) : null}
          <p id={hintId} className="break-keep text-meta text-ink-muted">
            {formatMessage("recovery.issue.passwordHint")}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap justify-end gap-2 border-t border-line p-4">
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={reset.cancel}
          data-testid="member-profile-reset-cancel"
        >
          {formatMessage("recovery.issue.cancel")}
        </Button>
        <Button
          type="submit"
          disabled={offline}
          aria-busy={busy || undefined}
          aria-describedby={offline ? offlineReasonId : undefined}
          data-testid="member-profile-reset-submit"
        >
          {busy ? formatMessage("recovery.issue.submitBusy") : formatMessage("recovery.issue.submit")}
        </Button>
      </div>
    </form>
  );
}

function IssuedLink({
  issued,
  close,
}: {
  issued: NonNullable<IssuePasswordResetHandle["issued"]>;
  close: () => void;
}) {
  const locale = useLocaleService();
  const { formatMessage } = locale;
  const titleId = useId();
  const leadId = useId();
  const cardRef = useRef<HTMLDivElement>(null);

  // 링크가 서는 순간 초점이 카드로 온다(`LinkOnce`와 같은 규칙): 확인 단계의 폼이 사라지면서
  // 초점이 문서 맨 위로 떨어지면 키보드 사용자가 링크가 나타난 바로 그 순간 처음부터 Tab으로
  // 되돌아와야 한다. 카드가 받으면 제목과 「지금만 볼 수 있어요」가 먼저 읽힌다.
  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true });
  }, []);

  const when = resetExpiryWhen(locale, issued.expiresAtMs);

  return (
    <div className="flex min-h-0 flex-col">
      <div
        ref={cardRef}
        role="group"
        tabIndex={-1}
        aria-labelledby={titleId}
        aria-describedby={leadId}
        className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4 focus-visible:focus-ring"
        data-testid="member-profile-reset-issued"
      >
        <h3 id={titleId} className="text-title font-semibold text-ink">
          {formatMessage("recovery.issue.issuedTitle")}
        </h3>
        <p id={leadId} className="break-keep text-body text-ink">
          {formatMessage("recovery.issue.issuedLead")}
        </p>

        <div className="flex flex-col gap-1">
          <span className="text-meta text-ink-muted">
            {formatMessage("recovery.issue.issuedLinkLabel")}
          </span>
          {/* 잘린 1회 값은 잘린 것이다: 라틴 URL 한 덩어리라 `break-all`로 끝까지 보이고, 복사가
              막혀도(클립보드 권한) `select-all` 한 번으로 전체를 고른다(`LinkOnce`의 근거와 같다). */}
          <div className="flex flex-wrap items-center gap-2">
            <span
              data-numeric
              className="min-w-0 flex-1 select-all break-all font-mono text-meta text-ink"
              data-testid="member-profile-reset-link"
            >
              {issued.claimUrl}
            </span>
            <CopyTextButton
              value={issued.claimUrl}
              label={formatMessage("recovery.issue.issuedCopy")}
              copiedLabel={formatMessage("recovery.issue.issuedCopied")}
              className="tap-target"
              testId="member-profile-reset-copy"
            />
          </div>
        </div>

        <p className="break-keep text-meta text-ink-muted" data-testid="member-profile-reset-expires">
          {formatMessage("recovery.issue.issuedExpires", { when })}
        </p>
        {issued.claimUrlSecure === false ? (
          <InlineBanner
            tone="neutral"
            message={formatMessage("recovery.issue.issuedLocalOnly")}
            separator={false}
            testId="member-profile-reset-local-only"
          />
        ) : null}
        <p className="break-keep text-meta text-ink-muted">
          {formatMessage("recovery.issue.issuedDeliver")}
        </p>
      </div>

      <div className="flex flex-wrap justify-end gap-2 border-t border-line p-4">
        <Button type="button" onClick={close} data-testid="member-profile-reset-close">
          {formatMessage("recovery.issue.issuedClose")}
        </Button>
      </div>
    </div>
  );
}

export function PasswordResetStage({
  member,
  reset,
  offline,
  offlineReasonId,
  close,
}: {
  member: RosterMember;
  reset: IssuePasswordResetHandle;
  offline: boolean;
  offlineReasonId?: string;
  close: () => void;
}) {
  if (reset.phase === PasswordResetPhase.Issued && reset.issued !== null) {
    return <IssuedLink issued={reset.issued} close={close} />;
  }
  return (
    <ConfirmForm member={member} reset={reset} offline={offline} offlineReasonId={offlineReasonId} />
  );
}
