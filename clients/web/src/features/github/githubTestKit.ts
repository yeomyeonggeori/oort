import { act } from "react";
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

/** `<select>` 의 값을 바꾸고 change 를 보낸다. */
export function choose(select: HTMLSelectElement | null, value: string): void {
  if (!select) throw new Error("select to change is missing");
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  act(() => {
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

export function q<T extends HTMLElement = HTMLElement>(id: string, scope: ParentNode = document.body): T | null {
  return scope.querySelector<T>(`[data-testid="${id}"]`);
}
