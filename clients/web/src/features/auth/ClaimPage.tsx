import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { claimOwnerPassword, type LoginResponse, type Member } from "@momo/core/lib/api";
import {
  claimFailureCopy,
  claimRefusesPassword,
  type ClaimFailure,
} from "@momo/core/features/auth/claimModel";
import {
  NEW_PASSWORD_MAX_BYTES,
  NEW_PASSWORD_MAX_HANGUL,
  NEW_PASSWORD_MIN_CHARS,
} from "@momo/core/features/auth/passwordRuleCopy";
import {
  expressionForState,
  onboardingDots,
  type GuideState,
} from "@momo/core/features/onboarding/guide";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { titlebarDragProps } from "@/app/sidebarPane";
import { IS_TAURI } from "@/lib/env";
import { absoluteApiBase, setServerBase } from "@/lib/serverBase";
import { useMessages } from "@/i18n/useMessages";
import { ClaimHostGate } from "@/features/recovery/ClaimHostGate";
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
import { replacePersistedMember } from "@/lib/session";
import { readClaimToken } from "./claimPath";
import { takeServerBeforeClaim } from "./claimHandoff";
import { ServerChip } from "./connectParts";
import {
  holdSessionRestore,
  releaseSessionRestore,
} from "./onboardingSessionHold";
import { useBlockedReason } from "@/features/common/BlockedReason";

// Reading this as: onboarding claim-password form for self-host operators on
// web+Tauri, density 5/10, motion 2/10.
//
// 온보딩 2.0 D1″(ADR-0193 D11, #2811): 카드와 C2-04 락업 대신 새벽하늘 바닥 위에
// 코메토 머리 + 한 문장. 점은 claim 경로 넷의 첫 칸이다(ADR-0185 증보 §5-2).
// 비밀번호 규칙·실패 착지·세션 보류 순서는 그대로다.
//
// 링크의 종류(`claimKind`, ADR-0215 D6)는 **응답을 받은 뒤에야** 안다(404·400·429에는 서버가 싣지
// 않는다). 그래서 입력 전 머리는 두 종류에 중립이고(「새 비밀번호를 정해요」), 종류가 갈리는 곳은
// 응답 뒤다: 재설정 링크는 소유자 온보딩으로 가지 않고 바로 앱으로 들어가며, 막힌 링크(409·410)의
// 안내가 종류별이다. 종류를 말하지 않은 서버(E-4 전)는 예전 그대로 소유자 경로다.
// 데스크탑(Tauri)은 주소창이 없어서 비밀번호 칸 앞에 서버 확인 단계가 선다(`ClaimHostGate`, D8).

// 입력칸이 설명을 가리키는 id. JSX 안에 문자열로 적지 않고 이름으로 쓴다(문구 장부가 JSX 속의 문자열을
// 직접 문구로 센다). 규칙을 어긴 400이 서 있으면 칸이 규칙 안내와 그 오류 문장을 함께 가리킨다.
const PASSWORD_HINT_ID = "claim-password-hint";
const CLAIM_ERROR_TEXT_ID = "claim-error-text";
const PASSWORD_DESCRIBED_BY = PASSWORD_HINT_ID;
const PASSWORD_DESCRIBED_BY_REFUSED = `${PASSWORD_HINT_ID} ${CLAIM_ERROR_TEXT_ID}`;

const CLAIM_BLOCKED_LINE = "이 링크로는 비밀번호를 정할 수 없어요.";
const CLAIM_TROUBLE_LINE = "비밀번호를 아직 정하지 못했어요.";

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
  isTauri = IS_TAURI,
}: {
  onLoggedIn: (session: LoginResponse) => void;
  /** 주소창이 없는 셸인가. 시험이 갈아 끼운다(`IS_TAURI`는 모듈 상수다). */
  isTauri?: boolean;
}) {
  const messages = useMessages();
  const token = readClaimToken(window.location.pathname);
  const [claimed, setClaimed] = useState<LoginResponse | null>(null);
  const claimedRef = useRef<LoginResponse | null>(null);
  // 같은 틱에 겹친 두 제출을 막는 동기 자물쇠(#3267). `busy` state는 다음 렌더에 선다.
  const attemptLockRef = useRef(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const [failure, setFailure] = useState<ClaimFailure | null>(null);
  // 주소창이 없는 셸에서는 사용자가 서버를 확인하기 전에 비밀번호 칸이 닫혀 있다(수용 9b).
  const [hostConfirmed, setHostConfirmed] = useState(!isTauri);
  const offline = useBrowserOffline();
  // 막은 원인을 말하는 문장(#5260). 이 화면의 게이트는 브라우저 오프라인이라 원인은 기기 오프라인이다.
  const offlineLine = useBlockedReason("waitAMoment");
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
    if (token === null || attemptLockRef.current) return;
    if (password !== confirm) {
      setMismatch(true);
      setFailure(null);
      return;
    }
    setMismatch(false);
    setFailure(null);
    attemptLockRef.current = true;
    setBusy(true);
    try {
      // applyLogin fires inside claimOwnerPassword. Hold restore BEFORE the
      // await so App does not unmount this page into `restoring` (ConnectPage
      // join → S3, same order).
      holdSessionRestore();
      const session = await claimOwnerPassword(token, password);
      // 재설정 링크는 이미 있는 멤버의 비밀번호를 정한다: 소유자 온보딩도 첫 실행 표지도 없다.
      if (session.claimKind === "password_reset") {
        finishPasswordReset(session);
        return;
      }
      recordFreshSignupFirstRun(session);
      markOwnerOnboardingPending();
      claimedRef.current = session;
      setClaimed(session);
    } catch (err) {
      releaseSessionRestore();
      setFailure(claimFailureCopy(err));
    } finally {
      attemptLockRef.current = false;
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
    // The member only: `current` carries the claim's first token pair, which
    // the bind refresh right after the claim (#3106) has already rotated —
    // re-applying it would put a spent token back in the store.
    replacePersistedMember(member);
    setClaimed(next);
  }

  function finishPasswordReset(session: LoginResponse) {
    window.history.replaceState(null, "", "/");
    onLoggedIn(session);
    releaseSessionRestore();
  }

  /** 「아니에요」: 링크가 저장해 둔 서버를 버리고(전의 선택으로 되돌리고) 로그인 화면으로 간다. */
  function rejectHost() {
    const before = takeServerBeforeClaim();
    setServerBase(before.found ? before.base : null);
    openConnectScreen();
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
        ? offlineLine
        : messages.formatMessage("recovery.claim.title");
  const failureText =
    failure === null
      ? ""
      : failure.messageKey !== undefined
        ? messages.formatMessage(failure.messageKey)
        : failure.message;
  const showGate = showForm && !hostConfirmed;
  const serverBase = absoluteApiBase();
  const passwordRuleRefused = claimRefusesPassword(failure);
  const passwordDescribedBy = passwordRuleRefused
    ? PASSWORD_DESCRIBED_BY_REFUSED
    : PASSWORD_DESCRIBED_BY;

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
          lineTestId="claim-title"
        />
        {isTauri && token !== null && hostConfirmed && serverBase !== "" && (
          <ServerChip base={serverBase} />
        )}
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

        {showGate ? (
          <ClaimHostGate
            base={serverBase}
            onConfirm={() => setHostConfirmed(true)}
            onReject={rejectHost}
          />
        ) : showForm ? (
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
                  message={failureText}
                  messageId={CLAIM_ERROR_TEXT_ID}
                  testId="claim-error"
                />
              </div>
            )}
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
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
                      // 규칙을 어겼다는 말은 그 칸을 고치기 시작하면 걷는다(다음 제출까지 남지 않는다).
                      setFailure((current) => (claimRefusesPassword(current) ? null : current));
                    }}
                    required
                    aria-invalid={passwordRuleRefused || undefined}
                    aria-describedby={passwordDescribedBy}
                    data-testid="claim-password"
                  />
                </label>
                <p
                  id={PASSWORD_HINT_ID}
                  className="break-keep text-meta text-ink-muted"
                  data-testid="claim-password-hint"
                >
                  {messages.formatMessage("recovery.claim.passwordHint", {
                    min: NEW_PASSWORD_MIN_CHARS,
                    maxBytes: NEW_PASSWORD_MAX_BYTES,
                    maxHangul: NEW_PASSWORD_MAX_HANGUL,
                  })}
                </p>
              </div>
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
                  message={failureText}
                  messageId={CLAIM_ERROR_TEXT_ID}
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
