import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { claimOwnerPassword, type LoginResponse, type Member } from "@momo/core/lib/api";
import { claimFailureCopy, type ClaimFailure } from "@momo/core/features/auth/claimModel";
import {
  expressionForState,
  onboardingDots,
  type GuideState,
} from "@momo/core/features/onboarding/guide";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { titlebarDragProps } from "@/app/sidebarPane";
import { IS_TAURI } from "@/lib/env";
import { InlineBanner } from "@/features/common/States";
import { useBrowserOffline } from "@/features/common/useOffline";
import { recordFreshSignupFirstRun } from "@/features/welcome/freshSignupFirstRun";
import { OwnerOnboarding } from "@/features/onboarding/OwnerOnboarding";
import { KomettoGuide } from "@/features/onboarding/guide/KomettoGuide";
import { OnboardingDots } from "@/features/onboarding/guide/OnboardingDots";
import {
  ONBOARDING_ACTION_CLASS,
  ONBOARDING_FIELD_CLASS,
  OnboardingColumn,
  OnboardingFrame,
} from "@/features/onboarding/guide/OnboardingFrame";
import {
  finishOwnerOnboardingInvite,
  markOwnerOnboardingPending,
} from "@/features/onboarding/ownerOnboardingStore";
import { applyLogin } from "@/lib/session";
import { readClaimToken } from "./claimPath";
import {
  holdSessionRestore,
  releaseSessionRestore,
} from "./onboardingSessionHold";

// Reading this as: onboarding claim-password form for self-host operators on
// web+Tauri, density 5/10, motion 2/10.
//
// 온보딩 2.0 D1″(ADR-0193 D11, #2811): 카드와 C2-04 락업 대신 새벽하늘 바닥 위에
// 코메토 머리 + 한 문장. 점은 claim 경로 넷의 첫 칸이다(ADR-0185 증보 §5-2).
// 비밀번호 규칙·실패 착지·세션 보류 순서는 그대로다.

const CLAIM_LINE = "이 서버의 첫 주인이에요.";
const CLAIM_DETAIL = "비밀번호를 정해요.";
const CLAIM_BLOCKED_LINE = "이 링크로는 비밀번호를 정할 수 없어요.";
const CLAIM_TROUBLE_LINE = "비밀번호를 아직 정하지 못했어요.";
const CLAIM_OFFLINE_LINE = "연결이 끊겨서 잠깐 기다려요.";

function FieldLabel({
  children,
  optional = false,
}: {
  children: ReactNode;
  optional?: boolean;
}) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="text-ink-muted">{children}</span>
      <span className="text-meta text-ink-muted">
        {optional ? "선택" : "필수"}
      </span>
    </span>
  );
}

function openConnectScreen() {
  window.location.replace("/");
}

export function ClaimPage({
  onLoggedIn,
}: {
  onLoggedIn: (session: LoginResponse) => void;
}) {
  const token = readClaimToken(window.location.pathname);
  const [claimed, setClaimed] = useState<LoginResponse | null>(null);
  const claimedRef = useRef<LoginResponse | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const [failure, setFailure] = useState<ClaimFailure | null>(null);
  const offline = useBrowserOffline();
  const landingRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => {
      releaseSessionRestore();
    };
  }, []);

  const missingToken = token === null;
  const showForm = !missingToken && (failure === null || failure.keepForm);

  // 종단(404/410/409)은 폼이 언마운트되며 제출 버튼이 사라지고, 재시도형은
  // 버튼이 남아 있어도 오류가 그 위에 선다. 둘 다 배너로 포커스를 옮긴다.
  useEffect(() => {
    if (!failure && !missingToken) return;
    landingRef.current?.focus({ preventScroll: true });
  }, [failure, missingToken]);

  async function attempt() {
    if (token === null) return;
    if (password !== confirm) {
      setMismatch(true);
      setFailure(null);
      return;
    }
    setMismatch(false);
    setFailure(null);
    setBusy(true);
    try {
      // applyLogin fires inside claimOwnerPassword. Hold restore BEFORE the
      // await so App does not unmount this page into `restoring` (ConnectPage
      // join → S3, same order).
      holdSessionRestore();
      const session = await claimOwnerPassword(token, password);
      recordFreshSignupFirstRun(session);
      markOwnerOnboardingPending();
      claimedRef.current = session;
      setClaimed(session);
    } catch (err) {
      releaseSessionRestore();
      setFailure(claimFailureCopy(err));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void attempt();
  }

  function replaceClaimedMember(member: Member) {
    const current = claimedRef.current;
    if (!current) return;
    const next = { ...current, member };
    claimedRef.current = next;
    applyLogin(next);
    setClaimed(next);
  }

  function finishOwnerOnboarding() {
    const session = claimedRef.current;
    if (!session) return;
    window.history.replaceState(null, "", "/");
    // Markers were written at claim success. onLoggedIn still opens the
    // first-run gate. Clear ONLY the invite flag so a skipped S1 is
    // re-offered on the next load (ADR-0185 §5-1).
    finishOwnerOnboardingInvite();
    onLoggedIn(session);
    releaseSessionRestore();
  }

  if (claimed) {
    return (
      <OwnerOnboarding
        session={claimed}
        replaceSessionMember={replaceClaimedMember}
        onFinished={finishOwnerOnboarding}
      />
    );
  }

  const guideState: GuideState =
    !showForm || failure !== null || offline ? "trouble" : "awaiting";
  const guideLine = !showForm
    ? CLAIM_BLOCKED_LINE
    : failure !== null
      ? CLAIM_TROUBLE_LINE
      : offline
        ? CLAIM_OFFLINE_LINE
        : CLAIM_LINE;

  return (
    <OnboardingFrame
      top={
        <header
          className="onboarding-step-chrome"
          data-testid="onboarding-step-chrome"
          {...titlebarDragProps(IS_TAURI)}
        >
          <span />
          <OnboardingDots dots={onboardingDots("claim", "claim")} />
          <span aria-hidden="true" />
        </header>
      }
    >
      <OnboardingColumn testId="claim-column">
        <KomettoGuide
          as="h1"
          expression={expressionForState(guideState)}
          line={guideLine}
          detail={guideState === "awaiting" ? CLAIM_DETAIL : undefined}
          lineTestId="claim-title"
        />
        {offline && (
          <InlineBanner
            tone="neutral"
            message="오프라인입니다. 네트워크가 연결되면 다시 시도하세요."
            testId="claim-offline"
          />
        )}

        {missingToken && (
          <div
            ref={landingRef}
            tabIndex={-1}
            className="focus-visible:focus-ring"
            data-landing="claim-failure"
          >
            <InlineBanner
              tone="error"
              message="이 링크는 유효하지 않습니다. 받은 주소를 그대로 여세요."
              testId="claim-missing-token"
            />
          </div>
        )}

        {showForm ? (
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            {failure && (
              <div
                ref={landingRef}
                tabIndex={-1}
                className="focus-visible:focus-ring"
                data-landing="claim-failure"
              >
                <InlineBanner
                  tone="error"
                  message={failure.message}
                  testId="claim-error"
                />
              </div>
            )}
            <div className="flex flex-col gap-4">
              <label htmlFor="claim-password" className="flex flex-col gap-1 text-body">
                <FieldLabel>새 비밀번호</FieldLabel>
                <Input
                  id="claim-password"
                  className={ONBOARDING_FIELD_CLASS}
                  type="password"
                  autoComplete="new-password"
                  maxLength={1024}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setMismatch(false);
                  }}
                  required
                  data-testid="claim-password"
                />
              </label>
              <label htmlFor="claim-confirm" className="flex flex-col gap-1 text-body">
                <FieldLabel>비밀번호 확인</FieldLabel>
                <Input
                  id="claim-confirm"
                  className={ONBOARDING_FIELD_CLASS}
                  type="password"
                  autoComplete="new-password"
                  maxLength={1024}
                  value={confirm}
                  onChange={(e) => {
                    setConfirm(e.target.value);
                    setMismatch(false);
                  }}
                  required
                  aria-invalid={mismatch || undefined}
                  aria-describedby={mismatch ? "claim-mismatch" : undefined}
                  data-testid="claim-confirm"
                />
                {mismatch && (
                  <p
                    id="claim-mismatch"
                    role="alert"
                    className="text-meta text-danger"
                    data-testid="claim-mismatch"
                  >
                    두 칸의 비밀번호가 같지 않습니다.
                  </p>
                )}
              </label>
            </div>
            <Button
              type="submit"
              className={ONBOARDING_ACTION_CLASS}
              disabled={busy || offline}
              title={offline ? "오프라인 상태에서는 연결할 수 없습니다." : undefined}
              data-testid="claim-submit"
            >
              {busy ? "설정 중…" : "비밀번호 설정"}
            </Button>
          </form>
        ) : (
          <>
            {failure && (
              <div
                ref={landingRef}
                tabIndex={-1}
                className="focus-visible:focus-ring"
                data-landing="claim-failure"
              >
                <InlineBanner
                  tone="error"
                  message={failure.message}
                  testId="claim-error"
                />
              </div>
            )}
            <Button
              type="button"
              className={ONBOARDING_ACTION_CLASS}
              onClick={openConnectScreen}
              data-testid="claim-open-connect"
            >
              로그인 화면 열기
            </Button>
          </>
        )}
      </OnboardingColumn>
    </OnboardingFrame>
  );
}
