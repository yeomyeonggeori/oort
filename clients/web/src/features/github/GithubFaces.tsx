import { Link, useInRouterContext } from "react-router-dom";
import { GITHUB_PANE_PATH, githubFacesFor } from "@momo/core/features/github/model";
import { StatusChip } from "@/features/settings/SettingsFields";

// =============================================================================
// 「앱」 화면 GitHub 카드의 얼굴 둘 (ADR-0205 D10, #3955).
//
//   알림 · 팀 전체 · oort 서버가 받아요   (서버가 GitHub 앱으로 받아 채널에 쓴다)
//   도구 · 각자 에이전트                  (각자의 에이전트가 자기 권한으로 GitHub를 부른다)
//
// 판정(`githubFacesFor`)은 코어에 있어 폰과 같다. 같은 앱 이름 아래 **누가 일하는가**가 다른 두 길이 있다는 말이다. 레지스트리 매니페스트는 바꾸지
// 않는다: 두 칩은 화면이 그린다. 알림 얼굴은 서버가 GitHub 알림 표면을 실을 때만 선다
// (`githubNotifications`). 도구 얼굴은 알림 표면과 무관하게 이 카드의 원래 모습이라 늘 있다.
// =============================================================================

/** 목록 줄의 두 칩. */
export function GithubFacesChips({ pluginId }: { pluginId: string }) {
  const faces = githubFacesFor(pluginId);
  if (faces.length === 0) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2" data-testid="github-faces-chips">
      {faces.map((face) => (
        <StatusChip key={face.id} tone="muted">
          {face.chip}
        </StatusChip>
      ))}
    </span>
  );
}

/** 상세의 두 얼굴: 칩 + 한 줄 설명, 알림 쪽에는 설정 화면으로 가는 길. */
export function GithubFacesBlock({ pluginId }: { pluginId: string }) {
  // 라우터 밖에서 그려지는 자리(시험·미리보기)는 길 없이 문장만 선다.
  const routed = useInRouterContext();
  const faces = githubFacesFor(pluginId);
  if (faces.length === 0) return null;
  return (
    <ul className="flex min-w-0 flex-col" data-testid="github-faces">
      {faces.map((face) => (
        <li
          key={face.id}
          className="flex min-w-0 flex-col gap-1 border-b border-line py-3 first:border-t"
          data-testid={`github-face-${face.id}`}
        >
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <StatusChip tone="muted">{face.chip}</StatusChip>
          </span>
          <p className="break-keep text-meta text-ink-muted">{face.detail}</p>
          {face.id === "notify" && routed && (
            <Link
              to={GITHUB_PANE_PATH}
              className="press inline-flex w-fit items-center rounded-sm py-1 text-meta text-signal-text underline decoration-line-strong underline-offset-2 hover:text-ink focus-visible:focus-ring"
              data-testid="github-faces-open"
            >
              GitHub 알림 열기
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}
