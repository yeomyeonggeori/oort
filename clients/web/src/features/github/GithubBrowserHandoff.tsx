import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import { InlineBanner } from "@/features/common/States";
import type { GithubManifestStart } from "@momo/core/features/github/model";
import { openExternalUrl } from "@/lib/tauri";
import { NoBreak } from "./NoBreak";
import { buildGithubHandoffUrl, type GithubHandoffBuildFailure } from "./handoff";
import { githubAppStatusKey, githubOverviewAll } from "./githubQueries";
import { useReturnRefresh } from "./useReturnRefresh";

// =============================================================================
// 데스크탑 셸에서 GitHub 앱 만들기 (ADR-0205 D2, #4220). 운영자 구역 `ManifestHandoff` 의 데스크탑 분기.
//
// 셸에는 GitHub 로 POST 하는 폼을 열 길이 없다. 그래서 이 서버의 웹 SPA 핸드오프 경로
// (`handoff.ts`)를 기본 브라우저로 연다: 거기서 매니페스트가 GitHub 로 POST 되고, GitHub 가 끝나면
// 서버가 그 브라우저를 `?githubApp=` 으로 돌려보낸다(로그인 없이 결과 문장). 이 앱은 창 포커스가
// 돌아오면 상태를 다시 읽어 「등록됨」으로 바뀐다.
//
// 비밀(1회용 state)은 브라우저로 가는 주소의 조각에만 있다. 여기서는 그 주소를 만들어 opener
// 에 넘길 뿐 로그·저장소·화면 어디에도 쓰지 않는다. 셸 쪽 `open_external_url` 명령은 이미 있고
// capability 도 이미 있다(`capabilities/default.json`): 범위를 넓히지 않는다.
// =============================================================================

const UNAVAILABLE_COPY: Readonly<Record<GithubHandoffBuildFailure, string>> = {
  origin:
    "이 서버가 보낸 등록 정보를 브라우저로 넘길 수 없어요. 웹 브라우저로 이 서버에 로그인해 같은 화면에서 만들어 주세요.",
  shape:
    "이 서버가 보낸 등록 정보를 브라우저로 넘길 수 없어요. 웹 브라우저로 이 서버에 로그인해 같은 화면에서 만들어 주세요.",
  length:
    "이 서버의 공개 주소가 너무 길어서 브라우저로 넘길 수 없어요. 웹 브라우저로 이 서버에 로그인해 같은 화면에서 만들어 주세요.",
};

type Outcome = "opened" | "failed";

export function BrowserHandoff({ handoff }: { handoff: GithubManifestStart }) {
  const client = useQueryClient();
  const built = useMemo(() => buildGithubHandoffUrl(handoff), [handoff]);
  const [outcome, setOutcome] = useState<Outcome>("opened");
  const launchedFor = useRef<GithubManifestStart | null>(null);
  const minutes = Math.max(1, Math.round(handoff.expiresInSeconds / 60));

  const launch = useCallback(async () => {
    if (!built.ok) return;
    setOutcome((await openExternalUrl(built.url)) ? "opened" : "failed");
  }, [built]);

  // 「GitHub 앱 만들기」 한 번이 곧 브라우저 열기다. 같은 등록 상태로는 한 번만 자동으로 연다.
  useEffect(() => {
    if (!built.ok || launchedFor.current === handoff) return;
    launchedFor.current = handoff;
    void launch();
  }, [built, handoff, launch]);

  // 브라우저에서 돌아오면 다시 읽는다. 등록이 끝났으면 이 카드 자리에 「등록된 앱」이 선다.
  useReturnRefresh(built.ok, () => {
    void client.invalidateQueries({ queryKey: githubAppStatusKey });
    void client.invalidateQueries({ queryKey: githubOverviewAll });
  });

  if (!built.ok) {
    return <InlineBanner message={UNAVAILABLE_COPY[built.reason]} testId="github-manifest-browser-unavailable" />;
  }

  const failed = outcome === "failed";
  return (
    <div
      className="flex min-w-0 flex-col gap-2 rounded-md border border-line p-3"
      data-testid="github-manifest-browser"
      data-outcome={outcome}
    >
      {/* 알림 영역은 글줄만 감싼다: 단추까지 안에 두면 결과가 바뀔 때 단추 글자가 같이 다시 읽힌다(design-review L6). */}
      <div className="flex min-w-0 flex-col gap-2" role="status">
        <p className="break-keep text-body text-ink">
          {failed ? "기본 브라우저를 열지 못했어요." : "기본 브라우저에서 GitHub를 열었어요."}
        </p>
        <p className="break-keep text-meta text-ink-muted">
          {failed ? (
            "다시 열어 보세요. 계속 안 되면 웹 브라우저로 이 서버에 로그인해 같은 화면에서 만들어 주세요."
          ) : (
            <>
              GitHub에서 <NoBreak>「Create GitHub App」을</NoBreak> 눌러 마친 뒤 이 앱으로 돌아와 주세요. 돌아오면
              이 화면이 알아서 바뀌어요. {minutes}분 안에 <NoBreak>마쳐야 해요.</NoBreak>
            </>
          )}
        </p>
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant={failed ? "default" : "secondary"}
          onClick={() => void launch()}
          data-testid="github-manifest-browser-open"
        >
          브라우저에서 다시 열기
        </Button>
      </div>
    </div>
  );
}
