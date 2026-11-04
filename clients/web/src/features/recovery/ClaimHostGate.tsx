import { useEffect, useId, useRef } from "react";
import { Button } from "@/design/ui/button";
import { ServerChip } from "@/features/auth/connectParts";
import { ONBOARDING_ACTION_CLASS } from "@/features/onboarding/guide/OnboardingFrame";
import { useMessages } from "@/i18n/useMessages";

// Reading this as: onboarding claim screen for desktop (Tauri) users, density 5/10, motion 2/10.

// =============================================================================
// claim 화면의 서버 확인 (ADR-0215 D8, 수용 9b, #4601).
//
// 링크는 **링크의 서버로** 새 비밀번호를 보낸다. 공격자가 `https://evil.example/claim/<아무 값>`을
// 「관리자가 보낸 링크」라며 보내면, 사용자가 다른 곳에서도 쓰는 비밀번호를 공격자 서버에 넣게
// 된다. 웹 브라우저는 주소창이 이 확인을 하고, 주소창이 없는 데스크탑(Tauri)에는 이 단계가 필요하다:
// 서버 호스트를 칩으로 보이고 **사용자가 확인한 뒤에만** 비밀번호 칸이 열린다.
//
// 칩의 호스트는 `POST /v1/claim`이 실제로 가는 주소(`absoluteApiBase()`)다. 다른 값을 보이면
// 확인이 거짓이 된다: 호출한 쪽이 그 값을 넘기고, 같은 값으로 요청이 나간다.
// =============================================================================

export function ClaimHostGate({
  base,
  onConfirm,
  onReject,
}: {
  /** 새 비밀번호가 가는 서버 주소(`absoluteApiBase()`). */
  base: string;
  onConfirm: () => void;
  onReject: () => void;
}) {
  const { formatMessage } = useMessages();
  const titleId = useId();
  const groupRef = useRef<HTMLElement>(null);

  // 단계가 서면 초점이 이 묶음으로 들어와 서버와 질문이 먼저 읽힌다. 확인 단추에 바로 앉히면 읽는
  // 도구가 어느 서버인지 듣기 전에 「맞아요」부터 듣는다.
  useEffect(() => {
    groupRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <section
      ref={groupRef}
      tabIndex={-1}
      aria-labelledby={titleId}
      className="flex flex-col gap-4 focus-visible:focus-ring"
      data-testid="claim-host-gate"
    >
      <ServerChip base={base} />
      <div className="flex flex-col gap-1">
        <h2 id={titleId} className="text-body font-semibold text-ink">
          {formatMessage("recovery.claim.hostTitle")}
        </h2>
        <p className="break-keep text-body text-ink-muted">
          {formatMessage("recovery.claim.hostBody")}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          className={ONBOARDING_ACTION_CLASS}
          onClick={onConfirm}
          data-testid="claim-host-confirm"
        >
          {formatMessage("recovery.claim.hostConfirm")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={ONBOARDING_ACTION_CLASS}
          data-variant="secondary"
          onClick={onReject}
          data-testid="claim-host-reject"
        >
          {formatMessage("recovery.claim.hostReject")}
        </Button>
      </div>
    </section>
  );
}
