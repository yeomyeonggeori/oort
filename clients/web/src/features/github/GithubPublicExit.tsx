// =============================================================================
// 로그인 전 공개 두 화면(핸드오프 `GithubHandoffPage`, 착지 `GithubPublicReturn`, #4220)이 나눠 쓰는 것.
//
// 두 화면은 시스템 브라우저에서 한 가지 일만 하고 끝난다. 그래서 어느 쪽 끝에서든 같은 말로 끝낸다:
// 「이 창은 닫아도 돼요」와 이 브라우저에서 oort 에 로그인하는 길 하나. 막힌 화면(거절)도 같은 출구를
// 갖는다: 앱 밖(폰 브라우저, 다른 PC)에서 연 사람도 갈 곳이 있어야 한다(design-review M3).
// =============================================================================

/** 닫아도 된다는 말과 로그인 길. 로그인 길은 단어도 조각도 싣지 않는 `/` 다. */
export function PublicExit() {
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="github-public-exit">
      <p className="break-keep text-meta text-ink-muted">이 창은 닫아도 돼요.</p>
      {/* 인라인 링크라 가로 패딩이 없으면 안쪽으로 그려지는 초점 링이 첫·끝 글자를 덮는다(design-review L3).
          `px-1 -mx-1` 은 글자 자리를 그대로 두고 링이 앉을 자리만 더한다. */}
      <a
        href="/"
        className="tap-target press -mx-1 inline-flex w-fit items-center rounded-sm px-1 text-meta font-semibold text-signal-text underline underline-offset-4 focus-visible:focus-ring"
        data-testid="github-public-return-login"
      >
        이 브라우저에서 로그인
      </a>
    </div>
  );
}
