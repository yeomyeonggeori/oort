import { chooseListbox } from "@/design/ui/listboxTestKit";
import type { GithubWorkspaceOverview } from "@momo/core/features/github/model";

// GitHub 알림 화면 시험의 공용 재료. 실제 같은 한국어 팀 내용을 쓴다.

export const GH_WS = "00000000-0000-7000-8000-000000000001";
export const GH_PUBLIC_CH = "00000000-0000-7000-8000-000000000201";
export const GH_PRIVATE_CH = "00000000-0000-7000-8000-000000000202";

export function overview(over: Partial<GithubWorkspaceOverview> = {}): GithubWorkspaceOverview {
  return {
    appRegistered: true,
    installations: [
      {
        installationId: 4001,
        accountLogin: "yeomyeonggeori",
        accountType: "Organization",
        repositorySelection: "selected",
        suspended: false,
        repositories: [
          { repoId: 11, fullName: "yeomyeonggeori/oort", private: false },
          { repoId: 12, fullName: "yeomyeonggeori/billing-internal", private: true },
        ],
      },
    ],
    subscriptions: [],
    features: ["pulls", "issues", "reviews", "comments", "checks", "commits", "releases"],
    defaultFeatures: ["pulls", "issues"],
    ...over,
  };
}

export function allReposOverview(): GithubWorkspaceOverview {
  return overview({
    installations: [
      {
        installationId: 4002,
        accountLogin: "dawn-labs",
        accountType: "Organization",
        repositorySelection: "all",
        suspended: false,
        repositories: [],
      },
    ],
  });
}

/** 앱이 그린 선택 칸(`ListboxSelect`)을 열어 `value` 항목을 고른다(#4126). */
export function choose(trigger: HTMLElement | null, value: string): void {
  chooseListbox(trigger, value);
}

export function q<T extends HTMLElement = HTMLElement>(id: string, scope: ParentNode = document.body): T | null {
  return scope.querySelector<T>(`[data-testid="${id}"]`);
}
