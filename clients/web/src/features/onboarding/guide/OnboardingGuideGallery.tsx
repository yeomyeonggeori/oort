import { useState } from "react";
import {
  GUIDE_STATE_TABLE,
  KOMETTO_EXPRESSION_NAMES,
  expressionForState,
  onboardingDots,
  type GuideState,
} from "@momo/core/features/onboarding/guide";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { KOMETTO_ASSETS_PLACEHOLDER } from "./komettoExpressions";
import { KomettoGuide } from "./KomettoGuide";
import { OnboardingDots } from "./OnboardingDots";
import { ONBOARDING_ACTION_CLASS, ONBOARDING_FIELD_CLASS } from "./OnboardingFrame";

/** 갤러리 견본 문장. 상태마다 한 문장(해요체)이고, 실제 화면 문구는 OB2-2~5가 정한다. */
const SAMPLE_LINES: Record<GuideState, string> = {
  awaiting: "어디로 갈까요?",
  checking: "이 맥의 CLI를 확인하고 있어요.",
  success: "이 맥에서 Claude Code를 찾았어요.",
  trouble: "서버에 닿지 않았어요. 주소를 다시 볼까요?",
  preparing: "성재의 Claude가 인사하러 오고 있어요.",
  skipped: "나중에 설정 › AI 연결에서 이어가요.",
};

/**
 * 디자인 갤러리의 온보딩 2.0 틀 견본 (#2807 OB2-1). 새벽하늘 바닥 위에
 * 상태 → 표정 여섯 줄, 진행 점 세 경로, 표정 전환(크로스페이드·기쁨 흔들기)을
 * 직접 눌러 보는 칸, 히어로 크기, 입력 그릇과 행동을 둔다.
 */
export function OnboardingGuideGallery() {
  const [live, setLive] = useState<GuideState>("checking");
  return (
    <section
      data-testid="onboarding-guide-gallery"
      className="flex flex-col gap-3 border-b border-line py-6"
    >
      <h2 className="text-title font-medium text-ink">온보딩 2.0 공통 틀 (OB2-1)</h2>
      <p className="text-meta text-ink-muted">
        {KOMETTO_ASSETS_PLACEHOLDER
          ? "표정 그림은 #2806 전의 임시본(K6 플랫 배지)이다. 자산이 들어오면 매핑 한 곳이 바뀐다."
          : "표정 그림은 #2806 플랫 표정 여섯 장이다."}
      </p>

      <div
        className="onboarding-canvas relative flex flex-col gap-6 overflow-hidden rounded-2xl p-6"
        data-testid="onboarding-guide-gallery-canvas"
      >
        <div className="onboarding-canvas-stars" aria-hidden="true" />

        <div className="relative flex flex-col gap-4">
          <h3 className="text-body font-medium text-ink-muted">진행 점</h3>
          <dl className="grid grid-cols-2 items-center gap-3 text-meta text-ink-muted">
            <dt>로그인 (1)</dt>
            <dd><OnboardingDots dots={onboardingDots("login", "sign-in")} /></dd>
            <dt>로그인 + AI 연결 (2)</dt>
            <dd>
              <OnboardingDots
                dots={onboardingDots("login", "ai-connect", { aiConnect: true })}
              />
            </dd>
            <dt>초대 (2)</dt>
            <dd><OnboardingDots dots={onboardingDots("invite", "join")} /></dd>
            <dt>claim (4), 둘째 칸</dt>
            <dd><OnboardingDots dots={onboardingDots("claim", "workspace-profile")} /></dd>
            <dt>claim (4), AI 연결</dt>
            <dd><OnboardingDots dots={onboardingDots("claim", "ai-connect")} /></dd>
          </dl>
        </div>

        <div className="relative flex flex-col gap-4">
          <h3 className="text-body font-medium text-ink-muted">상태와 표정 (ADR-0193 D11)</h3>
          <ul className="grid gap-4 md:grid-cols-2">
            {GUIDE_STATE_TABLE.map((row) => (
              <li key={row.state} className="flex flex-col gap-2">
                <span className="text-meta text-ink-muted">
                  {KOMETTO_EXPRESSION_NAMES[row.expression]}: {row.meaning}
                </span>
                <KomettoGuide expression={row.expression} line={SAMPLE_LINES[row.state]} />
              </li>
            ))}
          </ul>
        </div>

        <div className="relative flex flex-col gap-4">
          <h3 className="text-body font-medium text-ink-muted">
            표정 바꿈 (제자리 크로스페이드, 기쁨 진입 때 흔들기 한 번)
          </h3>
          <div className="flex flex-wrap gap-2" role="group" aria-label="상태 고르기">
            {GUIDE_STATE_TABLE.map((row) => (
              <Button
                key={row.state}
                type="button"
                size="sm"
                variant={live === row.state ? "default" : "secondary"}
                aria-pressed={live === row.state}
                data-testid={`onboarding-guide-live-${row.state}`}
                onClick={() => setLive(row.state)}
              >
                {KOMETTO_EXPRESSION_NAMES[row.expression]}
              </Button>
            ))}
          </div>
          <div className="onboarding-frame-col" data-testid="onboarding-guide-live">
            <KomettoGuide
              expression={expressionForState(live)}
              line={SAMPLE_LINES[live]}
              detail="위 버튼으로 상태를 바꿔 본다."
            />
            <label className="flex flex-col gap-1 text-body text-ink-muted">
              팀 주소나 초대 링크
              <Input
                className={ONBOARDING_FIELD_CLASS}
                placeholder="https://team.example.com"
              />
            </label>
            <Button type="button" className={ONBOARDING_ACTION_CLASS}>
              계속
            </Button>
            <Button
              type="button"
              variant="ghost"
              className={ONBOARDING_ACTION_CLASS}
              data-variant="secondary"
            >
              다른 서버 고르기
            </Button>
          </div>
        </div>

        <div className="relative flex flex-col gap-4">
          <h3 className="text-body font-medium text-ink-muted">히어로 (첫 화면·완료·첫 대화)</h3>
          <KomettoGuide
            size="hero"
            expression="happy"
            line="안녕하세요, 저는 코메토예요."
            detail="어디로 갈까요?"
          />
        </div>
      </div>
    </section>
  );
}
