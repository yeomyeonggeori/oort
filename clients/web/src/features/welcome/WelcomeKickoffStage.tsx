import { useEffect, useState, type AnimationEvent } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/design/lib/cn";
import {
  WELCOME_KICKOFF_EXIT_ANIMATION_NAME,
  WELCOME_KICKOFF_EXIT_CLASS,
} from "@/design/motion";
import { KomettoFace } from "@/features/onboarding/guide/KomettoFace";
import {
  WELCOME_BACKSTOP_AFTER,
  WELCOME_BACKSTOP_BEFORE,
  WELCOME_BACKSTOP_HREF,
  WELCOME_BACKSTOP_LINK_LABEL,
  WELCOME_BACKSTOP_TITLE,
  WELCOME_BAND_EXPRESSION,
  WELCOME_BAND_JOY_COPY,
  WELCOME_BAND_JOY_HOLD_MS,
  WELCOME_BAND_SLEEPY_COPY,
  decideWelcomeBand,
  welcomeBandWorkingCopy,
  type WelcomeBandSpeaker,
  type WelcomeKickoffPhase,
} from "./welcomeKickoff";

// Reading this as: first-conversation channel band for internal team users on
// web+Tauri, density 6/10, motion 2/10.

// =============================================================================
// 첫 대화 코메토 띠 (#2817, ADR-0193 D5·D11, ADR-0181 D7).
//
// 예전 킥오프 스테이지(타임라인 머리 행의 별자리)를 시안 D5 `.kband`로 바꿨다.
// 자리는 타임라인 아래·컴포저 바로 위이고 「폰에서도」 카드(#2818)와 같은
// 자리다. 둘은 겹치지 않는다: 이 띠는 킥오프 phase가 stage·backstop·exiting일
// 때만, 카드는 hidden이고 정착한 뒤에만 선다(`shouldMountPhoneLinkCard`).
//
// 상태와 표정은 1:1이고 문장이 함께 간다(D11).
//   - 오기 전: 작업 중 + 「{에이전트}가 인사하러 오고 있어요.」
//   - CLI 세션 대기(내 에이전트가 잠들어 있음): 졸림 + 「터미널에서 Claude Code를…」
//   - 120s 백스톱: 작업 중 + 「아직 준비하고 있어요.」 + 에이전트 허브 링크
//   - 첫 말 도착: 기쁨 + 「첫 대화가 시작됐어요.」 → 잠시 뒤 띠가 접힌다
// 진행 점은 없다. 토스트가 아니다(ADR-0182): 채널 안 제자리에 산다.
// reduced-motion이면 표정만 바뀌고(`KomettoFace`가 크로스페이드·흔들기를 끈다)
// 띠는 접히지 않고 바로 빠진다.
// =============================================================================

export function WelcomeKickoffStage({
  phase,
  reducedMotion,
  speaker,
  onExitComplete,
}: {
  phase: Exclude<WelcomeKickoffPhase, "hidden">;
  reducedMotion: boolean;
  speaker: WelcomeBandSpeaker;
  onExitComplete: () => void;
}) {
  const state = decideWelcomeBand({ phase, sleepy: speaker.sleepy }) ?? "working";
  const exiting = phase === "exiting";
  const [collapsing, setCollapsing] = useState(false);
  if (!exiting && collapsing) setCollapsing(false);

  useEffect(() => {
    if (!exiting) return;
    const timer = window.setTimeout(() => {
      if (reducedMotion) onExitComplete();
      else setCollapsing(true);
    }, WELCOME_BAND_JOY_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [exiting, reducedMotion, onExitComplete]);

  const handleAnimationEnd = (event: AnimationEvent<HTMLDivElement>) => {
    if (!collapsing || event.target !== event.currentTarget) return;
    if (event.animationName !== WELCOME_KICKOFF_EXIT_ANIMATION_NAME) return;
    onExitComplete();
  };

  const title =
    state === "joy"
      ? WELCOME_BAND_JOY_COPY
      : state === "sleepy"
        ? WELCOME_BAND_SLEEPY_COPY
        : state === "backstop"
          ? WELCOME_BACKSTOP_TITLE
          : welcomeBandWorkingCopy(speaker.name);

  return (
    <div
      className={cn(
        "welcome-band kometto-band",
        collapsing && WELCOME_KICKOFF_EXIT_CLASS
      )}
      data-testid={state === "backstop" ? "welcome-kickoff-backstop" : "welcome-kickoff-stage"}
      data-state={state}
      onAnimationEnd={handleAnimationEnd}
    >
      <div className="welcome-band-clip">
        <section
          className="flex items-center gap-3 rounded-lg bg-surface-muted py-2 pl-2 pr-card"
          aria-label="첫 대화"
        >
          <KomettoFace expression={WELCOME_BAND_EXPRESSION[state]} size="band" />
          <div role="status" className="min-w-0 flex-1 break-keep">
            <p className="text-body font-semibold text-ink">{title}</p>
            {state === "backstop" && (
              <p className="text-meta text-ink-muted">
                {WELCOME_BACKSTOP_BEFORE}
                <Link
                  to={WELCOME_BACKSTOP_HREF}
                  className="touch-target press rounded-sm text-ink underline underline-offset-2 hover:text-ink-muted focus-visible:focus-ring"
                >
                  {WELCOME_BACKSTOP_LINK_LABEL}
                </Link>
                {WELCOME_BACKSTOP_AFTER}
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
