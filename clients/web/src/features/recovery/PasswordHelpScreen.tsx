import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  ENTRY_KIND_CLAIM,
  ENTRY_KIND_EMPTY,
  PASSWORD_HELP_EXPRESSION,
  passwordHelpRequestText,
} from "@momo/core/features/auth/passwordHelp";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { ServerChip, OnboardingFieldBlock } from "@/features/auth/connectParts";
import { classifyEntry } from "@/features/auth/entryInput";
import { KomettoGuide } from "@/features/onboarding/guide/KomettoGuide";
import {
  ONBOARDING_ACTION_CLASS,
  ONBOARDING_FIELD_CLASS,
  OnboardingColumn,
} from "@/features/onboarding/guide/OnboardingFrame";
import { useMessages } from "@/i18n/useMessages";
import { CopyTextButton } from "./CopyTextButton";

// Reading this as: onboarding sign-in help for internal team users on web+Tauri,
// density 5/10, motion 2/10.

// =============================================================================
// 「비밀번호를 잊으셨나요?」 안내 화면 (ADR-0215 D5, #4601).
//
// **서버를 부르지 않는다.** 로그인 전에 멤버·관리자 명단을 보이려면 공개 엔드포인트가 필요하고 그것은
// 계정 열거다(OWASP). 그래서 이 화면이 건네는 것은 둘뿐이다: 관리자에게 보낼 요청 문구 하나(담기는
// 것은 입력해 둔 이메일과 서버 호스트뿐, `passwordHelpRequestText`)와 링크를 받은 뒤의 입구.
// 화면 어디에도 멤버 이름·핸들이 없고, 이 컴포넌트는 그것을 받을 props도 없다.
//
// 링크 입구는 D0의 한 칸과 **같은 판별 함수**(`classifyEntry`)를 쓴다: 두 번째 파서는 없다. 재설정
// 링크가 아닌 것(서버 주소·초대 링크)은 이 칸에서 받지 않고 이유를 말한다. 붙여넣은 링크의 서버가
// 맞는지는 이 화면이 아니라 claim 화면이 확인한다(주소창이 없는 셸에서는 서버 확인 단계, D8).
//
// D5의 다른 두 항목은 아직 그리지 않는다: 「로그인된 기기가 있다면」(D7 서명 재설정, E-3·U-1·U-8
// 착륙 전이라 가리킬 화면이 없다)과 「서버를 직접 운영한다면」(E-6이 머지될 때까지 숨긴다, 수용 12b).
// =============================================================================

export function PasswordHelpScreen({
  serverBase,
  email,
  onBack,
  onOpenClaimLink,
}: {
  /** 이 화면이 향하는 서버(로그인 화면 칩과 같은 값). */
  serverBase: string;
  /** 로그인 칸에 입력해 둔 이메일. 비어 있을 수 있다. */
  email: string;
  onBack: () => void;
  /** 붙여넣은 링크가 재설정 링크로 읽혔다. 서버 선택과 이동은 호출한 쪽이 한다. */
  onOpenClaimLink: (link: { origin: string; token: string }) => void;
}) {
  const { formatMessage } = useMessages();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  const adminTitleId = useId();
  const receivedTitleId = useId();
  const linkInputId = useId();
  // 문구 장부는 JSX 속 템플릿 조각(`-hint`)을 직접 문구로 센다: id는 JSX 밖에서 이름으로 만든다.
  const hintDomId = `${linkInputId}-hint`;
  const errorDomId = `${linkInputId}-error`;
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);

  // 화면이 서면 초점이 제목 줄로 들어온다: 제목이 먼저 읽히고 다음 Tab이 요청 문구의 복사 단추다. 묶음
  // 상자(`display: contents`)는 상자가 없어서 초점을 받지 못한다(브라우저 실측): 받는 쪽은 제목 줄이다.
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  const requestText = passwordHelpRequestText({ serverBase, email }, formatMessage);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const decision = classifyEntry(link);
    if (decision.kind === ENTRY_KIND_CLAIM) {
      setError(null);
      onOpenClaimLink({ origin: decision.origin, token: decision.token });
      return;
    }
    setError(
      decision.kind === ENTRY_KIND_EMPTY
        ? formatMessage("recovery.help.receivedEmpty")
        : formatMessage("recovery.help.receivedInvalid")
    );
    linkRef.current?.focus();
  }

  return (
    <OnboardingColumn testId="onboarding-password-help">
      <div data-onboarding-screen="password-help" className="contents">
        <KomettoGuide
          as="h1"
          expression={PASSWORD_HELP_EXPRESSION}
          line={formatMessage("recovery.help.guideLine")}
          detail={formatMessage("recovery.help.guideDetail")}
          lineTestId="password-help-title"
          lineRef={titleRef}
        />
        <ServerChip base={serverBase} />

        <section
          aria-labelledby={adminTitleId}
          className="flex flex-col gap-3"
          data-testid="password-help-admin"
        >
          <h2 id={adminTitleId} className="text-body font-semibold text-ink">
            {formatMessage("recovery.help.adminTitle")}
          </h2>
          <p className="break-keep text-body text-ink-muted">
            {formatMessage("recovery.help.adminBody")}
          </p>
          <div className="flex flex-col gap-2">
            <span className="text-meta font-semibold text-ink-muted">
              {formatMessage("recovery.help.requestLabel")}
            </span>
            <p
              className="select-all break-words rounded-lg bg-surface-muted p-3 text-body text-ink"
              data-testid="password-help-request"
            >
              {requestText}
            </p>
            <div className="flex items-center gap-2">
              <CopyTextButton
                value={requestText}
                label={formatMessage("recovery.help.requestCopy")}
                copiedLabel={formatMessage("recovery.help.requestCopied")}
                testId="password-help-copy"
              />
            </div>
          </div>
        </section>

        <section
          aria-labelledby={receivedTitleId}
          className="flex flex-col gap-3"
          data-testid="password-help-received"
        >
          <h2 id={receivedTitleId} className="text-body font-semibold text-ink">
            {formatMessage("recovery.help.receivedTitle")}
          </h2>
          <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
            <OnboardingFieldBlock
              id={linkInputId}
              label={formatMessage("recovery.help.receivedLabel")}
              hint={formatMessage("recovery.help.receivedHint")}
              hintId={hintDomId}
              error={error}
              errorId={errorDomId}
              errorTestId="password-help-link-error"
            >
              <Input
                id={linkInputId}
                ref={linkRef}
                className={ONBOARDING_FIELD_CLASS}
                value={link}
                onChange={(event) => {
                  setLink(event.target.value);
                  if (error !== null) setError(null);
                }}
                autoComplete="off"
                spellCheck={false}
                placeholder={formatMessage("recovery.help.receivedPlaceholder")}
                aria-invalid={error !== null || undefined}
                aria-describedby={error !== null ? errorDomId : hintDomId}
                data-testid="password-help-link"
              />
            </OnboardingFieldBlock>
            <Button
              type="submit"
              className={ONBOARDING_ACTION_CLASS}
              data-testid="password-help-open"
            >
              {formatMessage("recovery.help.receivedSubmit")}
            </Button>
          </form>
        </section>

        <Button
          type="button"
          variant="ghost"
          className={ONBOARDING_ACTION_CLASS}
          data-variant="secondary"
          onClick={onBack}
          data-testid="password-help-back"
        >
          {formatMessage("recovery.help.back")}
        </Button>
      </div>
    </OnboardingColumn>
  );
}
