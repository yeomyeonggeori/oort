import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  GITHUB_PANE_PATH,
  githubReturnFromSearch,
  searchWithoutGithubReturn,
} from "@momo/core/features/github/model";
import type { GithubReturnState } from "./GithubPane";

// =============================================================================
// GitHub 에서 돌아오는 문 (ADR-0205 D3, #3955).
//
// 서버는 설치(setup URL)와 앱 등록(콜백)이 끝나면 `<공개 주소>/?githubInstall=<단어>` 또는
// `?githubApp=<단어>` 로 303 을 보낸다. 단어는 닫힌 집합이고(`githubReturnSentence`), 비밀은 없다.
// 이 문은 아는 단어 하나를 꺼내 주소창에서 지우고(새로고침이 같은 말을 되풀이하지 않게),
// GitHub 알림 화면으로 라우터 상태에 실어 보낸다. 모르는 단어는 아무 일도 하지 않는다.
//
// HashRouter 라 `?query` 는 해시 밖(`window.location.search`)에 산다. 한 번만 읽는다.
// =============================================================================

export function GithubReturnLanding() {
  const navigate = useNavigate();
  useEffect(() => {
    const returned = githubReturnFromSearch(window.location.search);
    if (returned === null) return;
    try {
      const search = searchWithoutGithubReturn(window.location.search);
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}${window.location.hash}`);
    } catch {
      // 주소를 못 고치는 환경이어도 화면 이동은 한다.
    }
    const state: GithubReturnState = { githubReturn: returned };
    navigate(GITHUB_PANE_PATH, { replace: true, state });
  }, [navigate]);
  return null;
}
