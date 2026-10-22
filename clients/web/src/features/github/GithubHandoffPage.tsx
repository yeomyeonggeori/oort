import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { expressionForState, type GuideState } from "@momo/core/features/onboarding/guide";
import { Button } from "@/design/ui/button";
import { KeyValueRows } from "@/features/settings/SettingsFields";
import { KomettoGuide } from "@/features/onboarding/guide/KomettoGuide";
import {
  ONBOARDING_ACTION_CLASS,
  OnboardingColumn,
  OnboardingFrame,
} from "@/features/onboarding/guide/OnboardingFrame";
import {
  readGithubHandoff,
  type GithubHandoff,
  type GithubHandoffRead,
  type GithubHandoffRefusal,
} from "./handoff";

// Reading this as: a one-purpose public page (no sign-in) for the instance operator, opened by the
// desktop app in the system browser, density 4/10, motion 2/10.

// =============================================================================
// GitHub 앱 만들기의 브라우저 쪽 문 (ADR-0205 D2, #4220).
//
// 데스크탑 앱이 시스템 브라우저로 연 이 서버의 `/github/handoff#<payload>` 가 여기로 온다.
// 로그인은 필요 없다: 서버 콜백은 1회용 state 가 권한이라 GitHub 로 가는 POST 만 이 브라우저에서
// 일어나면 된다. 주소의 조각(`handoff.ts`)에서 등록 주소와 매니페스트를 읽어 GitHub 로 POST 한다.
//
// 지키는 것:
//   · 조각은 읽는 즉시 주소창에서 지운다(`history.replaceState`). 읽은 값은 아래 state 에만 있고
//     저장소(localStorage·sessionStorage)·로그·쿼리스트링에는 어디에도 쓰지 않는다. 새로고침하면
//     「한 번만 열 수 있어요」가 서는 것이 의도다.
//   · 이 서버의 것이 아닌 매니페스트는 폼을 만들기 전에 거절한다(`readGithubHandoff`).
//   · 자동 제출은 번들 코드가 한다(CSP 가 인라인 스크립트를 막는다). 막히면 같은 폼의 버튼이 폴백이다.
//   · GitHub 에 이 페이지 주소를 알리지 않는다: 폼 `rel="noreferrer"` + 문서 `referrer` 정책(no-referrer).
//
// 인라인 스타일도 `location` 쓰기도 없다. 이 페이지는 네트워크 요청을 하지 않는다.
// =============================================================================

const REFUSAL_COPY: Readonly<Record<GithubHandoffRefusal, { line: string; detail: string }>> = {
  empty: {
    line: "이 주소는 한 번만 열 수 있어요.",
    detail: "oort 앱에서 「GitHub 앱 만들기」를 다시 눌러 주세요.",
  },
  foreign: {
    line: "이 서버에서 만든 주소가 아니에요.",
    detail: "GitHub로는 아무것도 보내지 않았어요. oort 앱에서 「GitHub 앱 만들기」를 다시 눌러 주세요.",
  },
  unreadable: {
    line: "이 주소를 읽지 못했어요.",
    detail: "oort 앱에서 「GitHub 앱 만들기」를 다시 눌러 주세요.",
  },
  registration: {
    line: "이 주소를 읽지 못했어요.",
    detail: "oort 앱에서 「GitHub 앱 만들기」를 다시 눌러 주세요.",
  },
  manifest: {
    line: "이 주소를 읽지 못했어요.",
    detail: "oort 앱에서 「GitHub 앱 만들기」를 다시 눌러 주세요.",
  },
};

/** 조각을 주소창에서 지운다. 경로와 쿼리는 그대로 두고, 기록 항목 하나를 덮어쓴다(새 항목을 만들지 않는다). */
function scrubFragment(): void {
  try {
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  } catch {
    // 주소를 못 고치는 환경이어도 폼은 그대로 쓴다.
  }
}

function targetLabel(handoff: GithubHandoff): string {
  return handoff.target.kind === "organization" ? `${handoff.target.login} 조직` : "내 GitHub 계정";
}

export function GithubHandoffPage() {
  // 읽기는 순수하다(렌더 중에 주소를 고치지 않는다). 지우기는 아래 레이아웃 효과가 한다.
  const [read] = useState<GithubHandoffRead>(() => readGithubHandoff(window.location.hash, window.location.origin));
  const formRef = useRef<HTMLFormElement>(null);
  const submitted = useRef(false);

  // 첫 페인트 전에 조각을 지운다. 두 번 불려도 같은 결과다.
  useLayoutEffect(() => {
    scrubFragment();
  }, []);

  // GitHub 로 가는 이동에 이 페이지의 주소를 실어 보내지 않는다. 폼의 `rel="noreferrer"` 를 모르는
  // 엔진이 있어(실측: 캡처의 Chromium 은 오리진만 보냈다) 문서 정책으로도 한 번 더 건다.
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "referrer";
    meta.content = "no-referrer";
    document.head.append(meta);
    return () => meta.remove();
  }, []);

  // 자동 제출은 한 번뿐이다(뒤로 가기로 돌아와도 다시 쏘지 않는다: 그때는 버튼이 폴백이다).
  useEffect(() => {
    if (!read.ok || submitted.current) return;
    submitted.current = true;
    formRef.current?.submit();
  }, [read]);

  const state: GuideState = read.ok ? "checking" : "trouble";
  const line = read.ok ? "GitHub 앱 만들기 화면으로 이동해요." : REFUSAL_COPY[read.refusal].line;
  const detail = read.ok
    ? "GitHub에서 「Create GitHub App」을 누르면 이 서버로 돌아와요."
    : REFUSAL_COPY[read.refusal].detail;

  return (
    <OnboardingFrame>
      <OnboardingColumn testId="github-handoff-page">
        <KomettoGuide
          as="h1"
          expression={expressionForState(state)}
          line={line}
          detail={detail}
          lineTestId="github-handoff-title"
        />
        {read.ok && <HandoffForm handoff={read.handoff} formRef={formRef} />}
      </OnboardingColumn>
    </OnboardingFrame>
  );
}

function HandoffForm({
  handoff,
  formRef,
}: {
  handoff: GithubHandoff;
  formRef: RefObject<HTMLFormElement>;
}) {
  const minutes = Math.max(1, Math.round(handoff.expiresInSeconds / 60));
  return (
    <form
      ref={formRef}
      method="post"
      action={handoff.registrationUrl}
      rel="noopener noreferrer"
      className="flex min-w-0 flex-col gap-4"
      data-testid="github-handoff-form"
    >
      <input type="hidden" name="manifest" value={handoff.manifestJson} />
      <KeyValueRows
        rows={[
          { key: "만들 곳", value: targetLabel(handoff), prose: true },
          { key: "받는 서버", value: handoff.host },
          ...(handoff.appName === null ? [] : [{ key: "앱 이름", value: handoff.appName }]),
        ]}
      />
      <p className="break-keep text-meta text-ink-muted">
        {minutes}분 안에 마쳐야 해요. 화면이 넘어가지 않으면 아래 버튼을 눌러 주세요.
      </p>
      <Button type="submit" className={ONBOARDING_ACTION_CLASS} data-testid="github-handoff-submit">
        GitHub에서 앱 만들기
      </Button>
    </form>
  );
}
