// @vitest-environment jsdom

import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import type { GithubWorkspaceOverview } from "@momo/core/features/github/model";
import { click, flush, mount, type as typeInto, unmount } from "../memory/memoryTestKit";
import { GithubSubscribeForm } from "./GithubSubscribeForm";
import { GH_PRIVATE_CH, GH_PUBLIC_CH, GH_WS, allReposOverview, choose, overview, q } from "./githubTestKit";

const subscribeGithub = vi.hoisted(() => vi.fn());
vi.mock("@momo/core/features/github/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/github/api")>();
  return { ...actual, subscribeGithub: (...a: unknown[]) => subscribeGithub(...a) as unknown };
});

const SAVED = {
  id: "s1",
  channelId: GH_PUBLIC_CH,
  installationId: 4001,
  repository: "yeomyeonggeori/oort",
  repoId: 11,
  features: ["pulls", "issues"],
  active: true,
  privateConfirmed: false,
  needsReconfirm: false,
};

beforeEach(() => {
  subscribeGithub.mockReset();
  subscribeGithub.mockResolvedValue(SAVED);
});
afterEach(() => {
  unmount();
  document.body.innerHTML = "";
});

function render(options: { kind?: string; data?: GithubWorkspaceOverview; offline?: boolean } = {}) {
  const kind = options.kind ?? "public";
  mount(
    createElement(GithubSubscribeForm, {
      workspaceId: GH_WS,
      channel: { id: kind === "public" ? GH_PUBLIC_CH : GH_PRIVATE_CH, kind },
      channelTitle: kind === "public" ? "마케팅" : "결제-개발",
      overview: options.data ?? overview(),
      offline: options.offline ?? false,
    }),
    { role: "owner" }
  );
}

const submit = () => click(q("github-subscribe-submit"));
const pickRepo = (name: string) => choose(q<HTMLElement>("github-subscribe-repo"), name);
// SelectField 의 testId 는 combobox 단추 자신에게 달린다(#4126).

describe("비공개 저장소 확인 (ADR-0205 수용 11)", () => {
  it("공개 채널에 비공개 저장소: 확인 장면만 서고 구독 요청은 0번이다", async () => {
    render();
    pickRepo("yeomyeonggeori/billing-internal");
    submit();
    await flush();
    expect(q("github-private-confirm")).not.toBeNull();
    expect(q("github-private-confirm")?.textContent).toContain("마케팅 채널은 공개 채널");
    // 확인 장면은 어느 계정의 저장소인지, 알려진 비공개인지 말한다.
    expect(q("github-private-confirm")?.textContent).toContain("yeomyeonggeori 계정의 저장소예요");
    expect(q("github-private-confirm")?.textContent).toContain("비공개 저장소예요");
    expect(q("github-private-confirm")?.textContent).toContain("PR, 이슈 소식");
    expect(subscribeGithub).toHaveBeenCalledTimes(0);
  });

  it("취소하면 요청은 여전히 0번이고 폼으로 돌아온다", async () => {
    render();
    pickRepo("yeomyeonggeori/billing-internal");
    submit();
    click(q("github-private-cancel"));
    await flush();
    expect(q("github-private-confirm")).toBeNull();
    expect(q("github-subscribe-submit")).not.toBeNull();
    expect(subscribeGithub).toHaveBeenCalledTimes(0);
  });

  it("확인한 뒤에야 confirmPrivate: true 로 한 번 보낸다", async () => {
    render();
    pickRepo("yeomyeonggeori/billing-internal");
    submit();
    click(q("github-private-accept"));
    await flush();
    expect(subscribeGithub).toHaveBeenCalledTimes(1);
    expect(subscribeGithub).toHaveBeenCalledWith(GH_WS, {
      channelId: GH_PUBLIC_CH,
      installationId: 4001,
      repository: "yeomyeonggeori/billing-internal",
      features: ["pulls", "issues"],
      confirmPrivate: true,
    });
  });

  it("공개 저장소는 확인 없이 confirmPrivate 없이 보낸다", async () => {
    render();
    pickRepo("yeomyeonggeori/oort");
    submit();
    await flush();
    expect(q("github-private-confirm")).toBeNull();
    expect(subscribeGithub).toHaveBeenCalledTimes(1);
    expect(subscribeGithub.mock.calls[0][1]).not.toHaveProperty("confirmPrivate");
    expect(q("github-subscribe-done")?.textContent).toContain("yeomyeonggeori/oort");
  });

  it("비공개 채널에는 비공개 저장소도 확인 없이 간다", async () => {
    render({ kind: "private" });
    pickRepo("yeomyeonggeori/billing-internal");
    submit();
    await flush();
    expect(q("github-private-confirm")).toBeNull();
    expect(subscribeGithub).toHaveBeenCalledTimes(1);
    expect(subscribeGithub.mock.calls[0][1]).not.toHaveProperty("confirmPrivate");
  });

  it("「모든 저장소」 설치에서 직접 적은 이름은 공개인지 알 수 없어 확인을 요구한다", async () => {
    render({ data: allReposOverview() });
    typeInto(q<HTMLInputElement>("github-subscribe-repo-input"), "dawn-labs/landing");
    submit();
    await flush();
    expect(q("github-private-confirm")).not.toBeNull();
    expect(subscribeGithub).toHaveBeenCalledTimes(0);
    click(q("github-private-accept"));
    await flush();
    expect(subscribeGithub).toHaveBeenCalledTimes(1);
    expect(subscribeGithub.mock.calls[0][1]).toMatchObject({
      repository: "dawn-labs/landing",
      confirmPrivate: true,
    });
  });

  it("우리 눈에는 공개였는데 서버가 409 로 막으면 같은 확인 장면으로 간다", async () => {
    subscribeGithub.mockRejectedValueOnce(
      new ApiError(409, "wording", "private_repository_requires_confirmation")
    );
    render();
    pickRepo("yeomyeonggeori/oort");
    submit();
    await flush();
    expect(q("github-private-confirm")).not.toBeNull();
    expect(q("github-subscribe-error")).toBeNull();
    click(q("github-private-accept"));
    await flush();
    expect(subscribeGithub).toHaveBeenCalledTimes(2);
    expect(subscribeGithub.mock.calls[1][1]).toMatchObject({ confirmPrivate: true });
  });
});

describe("입력 검사", () => {
  it("저장소를 안 골랐거나 이름 모양이 틀리면 요청이 나가지 않는다", async () => {
    render();
    submit();
    await flush();
    expect(q("github-subscribe-repo")?.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.body.textContent).toContain("구독할 저장소를 골라 주세요.");
    expect(subscribeGithub).toHaveBeenCalledTimes(0);
    unmount();
    render({ data: allReposOverview() });
    typeInto(q<HTMLInputElement>("github-subscribe-repo-input"), "not a repo");
    submit();
    await flush();
    expect(document.body.textContent).toContain("owner/repo 모양으로");
    expect(subscribeGithub).toHaveBeenCalledTimes(0);
  });

  it("받을 알림을 모두 끄면 요청이 나가지 않는다", async () => {
    render();
    pickRepo("yeomyeonggeori/oort");
    click(q("github-feature-pulls"));
    click(q("github-feature-issues"));
    submit();
    await flush();
    expect(q("github-subscribe-error")?.textContent).toContain("하나 이상");
    expect(subscribeGithub).toHaveBeenCalledTimes(0);
  });

  it("기본은 PR·이슈만 켜져 있고 커밋·릴리스는 「선택」이라고 적혀 꺼져 있다", () => {
    render();
    const checked = (id: string) => q<HTMLInputElement>(`github-feature-${id}`)?.checked;
    expect(checked("pulls")).toBe(true);
    expect(checked("issues")).toBe(true);
    expect(checked("commits")).toBe(false);
    expect(checked("releases")).toBe(false);
    const commitsRow = q("github-feature-commits")?.closest("label");
    expect(commitsRow?.textContent).toContain("선택");
  });

  it("커밋을 켜면 features 에 실려 간다", async () => {
    render({ kind: "private" });
    pickRepo("yeomyeonggeori/oort");
    click(q("github-feature-commits"));
    submit();
    await flush();
    expect(subscribeGithub.mock.calls[0][1]).toMatchObject({ features: ["pulls", "issues", "commits"] });
  });

  it("서버 오류는 서버 문장을 옮기지 않고 우리 문장으로 말한다", async () => {
    subscribeGithub.mockRejectedValueOnce(
      new ApiError(404, "server wording leaks", "repository_not_in_installation")
    );
    render();
    pickRepo("yeomyeonggeori/oort");
    submit();
    await flush();
    expect(q("github-subscribe-error")?.textContent).toContain("이 설치에서 볼 수 있는 저장소가 아니에요");
    expect(document.body.textContent).not.toContain("server wording leaks");
  });

  it("연결이 끊겨 있으면 요청이 나가지 않는다", async () => {
    render({ offline: true });
    pickRepo("yeomyeonggeori/oort");
    submit();
    await flush();
    expect(subscribeGithub).toHaveBeenCalledTimes(0);
    expect(q("github-subscribe-submit")?.getAttribute("aria-disabled")).toBe("true");
  });
});
