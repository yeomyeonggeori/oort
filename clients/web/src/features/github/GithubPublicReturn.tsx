import { useLayoutEffect } from "react";
import {
  githubPublicReturnSentence,
  searchWithoutGithubReturn,
  type GithubReturnKind,
} from "@momo/core/features/github/model";
import { expressionForState, type GuideState } from "@momo/core/features/onboarding/guide";
import { KomettoGuide } from "@/features/onboarding/guide/KomettoGuide";
import { OnboardingColumn, OnboardingFrame } from "@/features/onboarding/guide/OnboardingFrame";
import { PublicExit } from "./GithubPublicExit";
import { usePublicTitle } from "./usePublicTitle";

// Reading this as: a one-purpose public page (no sign-in) that tells the instance operator how the
// GitHub round trip ended, density 3/10, motion 2/10.

// =============================================================================
// GitHub 에서 돌아온 로그인 안 된 브라우저의 착지 (ADR-0205 D3, #4220).
//
// 서버는 앱 등록(콜백)과 설치(setup URL)가 끝나면 `<공개 주소>/?githubApp=<단어>` 또는
// `?githubInstall=<단어>` 로 303 을 보낸다. 데스크탑에서 시작한 일은 시스템 브라우저에서 끝나고,
// 그 브라우저는 oort 에 로그인돼 있지 않을 수 있다. 그래서 결과 문장과 「oort 앱으로 돌아가세요」만
// 말한다. 로그인된 브라우저는 이 문을 지나지 않는다: 지금처럼 `GithubReturnLanding` 이 GitHub 알림
// 화면으로 보낸다(웹 동작은 그대로다).
//
// 닫힌 세계다: 아는 단어(`githubPublicReturnSentence`)만 문장이 되고, 단어 말고는 주소의 어떤 값도
// 화면에 올리지 않는다. 비밀은 없다. 문장은 로그인된 화면의 것과 판정이 같고, 「이 화면」「새로고침」처럼
// 앱 화면을 가리키는 말만 이 페이지에 맞게 바꿨다(core 가 소유한다). 단어는 읽는 즉시 주소창에서
// 지운다(새로고침이 낡은 결과를 되풀이하지 않게, `GithubReturnLanding` 과 같다): 이 페이지가 하는 말에
// 「새로고침」은 없다.
// =============================================================================

export function GithubPublicReturn({ returned }: { returned: { kind: GithubReturnKind; word: string } }) {
  const sentence = githubPublicReturnSentence(returned.kind, returned.word);
  usePublicTitle("GitHub · oort");

  useLayoutEffect(() => {
    try {
      const search = searchWithoutGithubReturn(window.location.search);
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${search}${window.location.hash}`
      );
    } catch {
      // 주소를 못 고치는 환경이어도 문장은 그대로 보인다.
    }
  }, []);

  if (sentence === null) return null;
  // 아직 한 걸음 남은 말은 「확인 중」 얼굴이다: 기다리는 것은 이 사람의 대답이 아니라 일이 끝나는 것이다.
  const state: GuideState = sentence.tone === "ok" ? "success" : sentence.tone === "stop" ? "trouble" : "checking";
  return (
    <OnboardingFrame>
      <OnboardingColumn testId="github-public-return">
        <KomettoGuide
          as="h1"
          expression={expressionForState(state)}
          line={sentence.sentence}
          detail={sentence.next}
          lineTestId="github-public-return-title"
        />
        <div
          className="flex min-w-0 flex-col gap-2"
          data-testid="github-public-return-body"
          data-return-word={returned.word}
          data-return-tone={sentence.tone}
        >
          <p className="break-keep text-body font-semibold text-ink" data-testid="github-public-return-back">
            oort 앱으로 돌아가세요.
          </p>
        </div>
        <PublicExit />
      </OnboardingColumn>
    </OnboardingFrame>
  );
}
