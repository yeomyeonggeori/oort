import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { WireShapeError } from "../../lib/wire";
import { isSurfaceProvided, serverSaysAbsent, serverSurface } from "../capabilities/serverSurfaces";
import {
  GITHUB_DEFAULT_FEATURES,
  GITHUB_DOWNTIME_SENTENCE,
  GITHUB_FACES,
  GITHUB_FEATURES,
  GITHUB_FEATURE_IDS,
  GITHUB_RECEIVE_FAILED_SENTENCE,
  featuresSummary,
  githubErrorCode,
  githubFailureMessage,
  githubNoticeFor,
  githubNoticeLabel,
  githubReturnFromSearch,
  githubReturnSentence,
  isPrivateConfirmationRequired,
  needsPrivateConfirmation,
  normalizeRepositoryName,
  parseAppStatus,
  parseLinkStart,
  parseManifestStart,
  parseSubscription,
  parseWorkspaceOverview,
  permissionLabels,
  repositoryInputMode,
  safeHttpsUrl,
  searchWithoutGithubReturn,
} from "./model";

const GITHUB_AUTHOR = { kind: "agent", displayName: "GitHub" };

describe("비공개 저장소 확인 (ADR-0205 수용 11)", () => {
  it("공개 채널에 비공개 저장소는 확인이 필요하다", () => {
    expect(needsPrivateConfirmation("public", { private: true })).toBe(true);
  });

  it("공개 채널에 공개 저장소는 확인이 필요 없다", () => {
    expect(needsPrivateConfirmation("public", { private: false })).toBe(false);
  });

  it("공개인지 알 수 없는 저장소(목록에 없음)는 비공개로 취급한다", () => {
    expect(needsPrivateConfirmation("public", null)).toBe(true);
  });

  it("비공개 채널은 저장소가 비공개여도 확인이 필요 없다", () => {
    expect(needsPrivateConfirmation("private", { private: true })).toBe(false);
    expect(needsPrivateConfirmation("private", null)).toBe(false);
  });

  it("서버의 409 코드를 코드로만 알아본다", () => {
    expect(
      isPrivateConfirmationRequired(new ApiError(409, "x", "private_repository_requires_confirmation"))
    ).toBe(true);
    // 같은 409라도 다른 코드이거나 코드가 없으면 확인 단계로 가지 않는다.
    expect(isPrivateConfirmationRequired(new ApiError(409, "x", "github_app_already_registered"))).toBe(false);
    expect(isPrivateConfirmationRequired(new ApiError(409, "x"))).toBe(false);
    expect(isPrivateConfirmationRequired(new ApiError(400, "x", "private_repository_requires_confirmation"))).toBe(false);
  });
});

describe("owner/repo 입력", () => {
  it("서버의 모양과 같은 것만 받는다", () => {
    expect(normalizeRepositoryName("  yeomyeonggeori/oort ")).toBe("yeomyeonggeori/oort");
    expect(normalizeRepositoryName("a/b.c_d-e")).toBe("a/b.c_d-e");
    expect(normalizeRepositoryName("oort")).toBeNull();
    expect(normalizeRepositoryName("a/b/c")).toBeNull();
    expect(normalizeRepositoryName("a/..")).toBeNull();
    expect(normalizeRepositoryName("/oort")).toBeNull();
    expect(normalizeRepositoryName("bad owner/oort")).toBeNull();
    expect(normalizeRepositoryName(`${"a".repeat(40)}/x`)).toBeNull();
  });

  it("모든 저장소 설치이거나 목록이 비면 직접 입력, 선택 설치이고 목록이 있으면 고른다", () => {
    const base = {
      installationId: 1,
      accountLogin: "acme",
      accountType: "Organization",
      suspended: false,
    };
    const repo = { repoId: 1, fullName: "acme/web", private: false };
    expect(repositoryInputMode({ ...base, repositorySelection: "all", repositories: [repo] })).toBe("type");
    expect(repositoryInputMode({ ...base, repositorySelection: "selected", repositories: [] })).toBe("type");
    expect(repositoryInputMode({ ...base, repositorySelection: "selected", repositories: [repo] })).toBe("pick");
    expect(repositoryInputMode(undefined)).toBe("pick");
  });
});

describe("기능 목록", () => {
  it("서버와 같은 일곱이고 커밋·릴리스는 선택, 기본은 PR·이슈다", () => {
    expect(GITHUB_FEATURE_IDS).toEqual(["pulls", "issues", "reviews", "comments", "checks", "commits", "releases"]);
    expect(GITHUB_DEFAULT_FEATURES).toEqual(["pulls", "issues"]);
    expect(GITHUB_FEATURES.commits.optional).toBe(true);
    expect(GITHUB_FEATURES.releases.optional).toBe(true);
    expect(GITHUB_FEATURES.pulls.optional).toBe(false);
  });

  it("모르는 기능은 요약에서 빠지고, 비면 받는 알림이 없다고 말한다", () => {
    expect(featuresSummary(["issues", "wat", "pulls"])).toBe("PR, 이슈");
    expect(featuresSummary(["wat"])).toBe("받는 알림이 없어요");
  });
});

describe("와이어 읽기", () => {
  const status = {
    masterKeyConfigured: true,
    publicAddressConfigured: false,
    configured: true,
    app: {
      appId: 7,
      slug: "oort-team",
      clientId: "Iv1.abc",
      ownerLogin: "yeomyeonggeori",
      ownerType: "Organization",
      source: "manifest",
      createdAtMs: 1,
      rotationWindowOpen: false,
      installUrl: "https://github.com/apps/oort-team/installations/new",
    },
    permissions: { metadata: "read", issues: "read", pull_requests: "read", checks: "read", contents: "read" },
    events: ["pull_request"],
  };

  it("앱 상태를 칸마다 옮기고 권한 이름을 사람 말로 바꾼다", () => {
    const parsed = parseAppStatus(status);
    expect(parsed.configured).toBe(true);
    expect(parsed.publicAddressConfigured).toBe(false);
    expect(parsed.app?.slug).toBe("oort-team");
    expect(permissionLabels(parsed.permissions)).toEqual(["메타데이터", "이슈", "PR", "체크", "코드(contents)"]);
  });

  it("모르는 권한 이름은 화면에 나가지 않는다", () => {
    expect(permissionLabels([{ name: "secrets", access: "write" }])).toEqual([]);
  });

  it("필수 칸이 없으면 읽지 못한 응답이다", () => {
    expect(() => parseAppStatus({ configured: true })).toThrow(WireShapeError);
    expect(() => parseAppStatus("nope")).toThrow(WireShapeError);
  });

  it("앱이 없는 상태는 app이 null이다", () => {
    const parsed = parseAppStatus({ ...status, configured: false, app: undefined });
    expect(parsed.app).toBeNull();
  });

  it("작업 공간 개요는 알 수 없는 공개 여부를 비공개로 읽는다", () => {
    const overview = parseWorkspaceOverview({
      appRegistered: true,
      installations: [
        {
          installationId: 5,
          accountLogin: "acme",
          accountType: "Organization",
          repositorySelection: "selected",
          suspended: false,
          repositories: [{ repoId: 1, fullName: "acme/web" }],
        },
      ],
      subscriptions: [
        {
          id: "s1",
          channelId: "c1",
          installationId: 5,
          repository: "acme/web",
          repoId: 1,
          features: ["pulls"],
          active: true,
          privateConfirmed: false,
        },
      ],
      features: ["pulls", "issues", "mystery"],
      defaultFeatures: ["pulls", "issues"],
    });
    expect(overview.installations[0].repositories[0].private).toBe(true);
    expect(overview.features).toEqual(["pulls", "issues"]);
    expect(overview.subscriptions[0].repoId).toBe(1);
  });

  it("옛 서버가 기능 목록을 안 주면 아는 일곱과 기본 둘로 돌아간다", () => {
    const overview = parseWorkspaceOverview({ appRegistered: false, installations: [], subscriptions: [] });
    expect(overview.features).toEqual([...GITHUB_FEATURE_IDS]);
    expect(overview.defaultFeatures).toEqual(["pulls", "issues"]);
  });

  it("구독 한 줄은 id·채널·설치·저장소가 있어야 한다", () => {
    expect(() => parseSubscription({ id: "x" })).toThrow(WireShapeError);
  });

  it("등록 폼 주소는 github.com 의 https 만 받는다", () => {
    const ok = parseManifestStart({
      registrationUrl: "https://github.com/settings/apps/new?state=abc",
      manifest: { name: "oort" },
      expiresInSeconds: 3600,
    });
    expect(ok.registrationUrl.startsWith("https://github.com/")).toBe(true);
    for (const registrationUrl of [
      "http://github.com/settings/apps/new",
      "https://evil.example/settings/apps/new",
      "https://user:pw@github.com/x",
      "javascript:alert(1)",
    ]) {
      expect(() => parseManifestStart({ registrationUrl, manifest: {} })).toThrow(WireShapeError);
    }
  });

  it("설치 주소도 github.com 의 https 만 받는다", () => {
    expect(parseLinkStart({ installUrl: "https://github.com/apps/x/installations/new?state=t" }).installUrl).toContain("state=t");
    expect(() => parseLinkStart({ installUrl: "https://github.com.evil.example/apps/x" })).toThrow(WireShapeError);
    expect(() => parseLinkStart({ installUrl: "ftp://github.com/x" })).toThrow(WireShapeError);
  });

  it("https 가 아니거나 계정 정보가 든 주소는 링크가 되지 않는다", () => {
    expect(safeHttpsUrl("https://github.com/a/b/pull/1")).toBe("https://github.com/a/b/pull/1");
    expect(safeHttpsUrl("http://github.com/a")).toBeNull();
    expect(safeHttpsUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpsUrl("https://u:p@github.com/a")).toBeNull();
    expect(safeHttpsUrl(undefined)).toBeNull();
    expect(safeHttpsUrl("not a url")).toBeNull();
  });
});

describe("돌아온 상태 단어 (닫힌 세계)", () => {
  it("설치 쪽 단어 일곱 모두에 문장이 있고 state_missing 은 운영자 목록을 가리킨다", () => {
    for (const word of ["linked", "pending", "requested", "state_missing", "state_invalid", "not_admin", "invalid_request"]) {
      expect(githubReturnSentence("install", word)?.sentence).toBeTruthy();
    }
    expect(githubReturnSentence("install", "state_missing")?.next).toContain("연결 안 된 설치");
    expect(githubReturnSentence("install", "requested")?.next).toContain("연결 안 된 설치");
  });

  it("앱 쪽 단어 열 가지 모두에 문장이 있다", () => {
    for (const word of [
      "created",
      "already_registered",
      "not_operator",
      "state_invalid",
      "invalid_request",
      "owner_mismatch",
      "convert_code_rejected",
      "convert_unreachable",
      "convert_invalid_response",
      "seal_failed",
      "store_failed",
    ]) {
      expect(githubReturnSentence("app", word)?.sentence).toBeTruthy();
    }
  });

  it("모르는 단어와 프로토타입 키는 문장이 없다", () => {
    expect(githubReturnSentence("install", "hacked")).toBeNull();
    expect(githubReturnSentence("install", "constructor")).toBeNull();
    expect(githubReturnSentence("app", "__proto__")).toBeNull();
    // 설치 쪽 단어가 앱 쪽 표로 새지 않는다.
    expect(githubReturnSentence("app", "linked")).toBeNull();
  });

  it("주소의 단어는 아는 것 하나만 꺼내고 지울 수 있다", () => {
    expect(githubReturnFromSearch("?githubInstall=linked")).toEqual({ kind: "install", word: "linked" });
    expect(githubReturnFromSearch("?githubApp=created")).toEqual({ kind: "app", word: "created" });
    expect(githubReturnFromSearch("?githubInstall=evil")).toBeNull();
    expect(githubReturnFromSearch("?x=1")).toBeNull();
    expect(searchWithoutGithubReturn("?githubInstall=linked&keep=1")).toBe("?keep=1");
    expect(searchWithoutGithubReturn("?githubApp=created")).toBe("");
  });
});

describe("오류 문장", () => {
  it("코드가 있으면 코드의 문장을 쓰고 서버의 문장을 옮기지 않는다", () => {
    const linked = githubFailureMessage(
      "operatorLink",
      new ApiError(409, "server wording", "github_installation_linked_elsewhere")
    );
    expect(linked).toContain("다른 워크스페이스");
    expect(linked).not.toContain("server wording");
  });

  it("공개 주소 오류는 doctor 와 같은 말이다", () => {
    const message = githubFailureMessage("register", new ApiError(409, "x", "public_address_required"));
    expect(message).toContain(GITHUB_RECEIVE_FAILED_SENTENCE);
  });

  it("503 은 운영자가 서버 설정을 마쳐야 한다는 말이다", () => {
    expect(githubFailureMessage("load", new ApiError(503, "x"))).toContain("GITHUB_APP_MASTER_KEY");
  });

  it("코드 없는 상태 오류와 전송 오류와 모양 오류를 가른다", () => {
    expect(githubFailureMessage("subscribe", new ApiError(403, "x"))).toContain("소유자나 관리자");
    expect(githubFailureMessage("subscribe", new ApiError(404, "x"))).toContain("찾지 못했어요");
    expect(githubFailureMessage("subscribe", new ApiError(500, "boom"))).not.toContain("boom");
    expect(githubFailureMessage("load", new WireShapeError())).toContain("확인하지 못했어요");
    expect(githubFailureMessage("load", new NetworkError("timeout", 15_000))).toContain("GitHub 정보를 읽지 못했어요");
    expect(githubFailureMessage("load", new Error("secret-bearing text"))).not.toContain("secret-bearing");
    expect(githubErrorCode(new ApiError(409, "x", "abc"))).toBe("abc");
    expect(githubErrorCode(new Error("x"))).toBeUndefined();
  });

  it("다운 중 사라지는 알림을 숨기지 않는다", () => {
    expect(GITHUB_DOWNTIME_SENTENCE).toContain("사라지고");
  });
});

describe("앱 카드의 두 얼굴", () => {
  it("알림과 도구, 두 칩이 정해진 문장이다", () => {
    expect(GITHUB_FACES.map((face) => face.chip)).toEqual([
      "알림 · 팀 전체 · oort 서버가 받아요",
      "도구 · 각자 에이전트",
    ]);
  });
});

describe("serverSurfaces: githubNotifications", () => {
  it("표에 있고 문구가 채워져 있다", () => {
    const surface = serverSurface("githubNotifications");
    expect(surface.label).toBe("GitHub 알림");
    expect(surface.absentReason).not.toBe("");
    expect(surface.fallback).not.toBe("");
    expect(isSurfaceProvided("githubNotifications")).toBe(true);
  });

  it("옛 서버의 404·405·501 은 「없다」로 접히고 503·403 은 접히지 않는다", () => {
    for (const status of [404, 405, 501]) expect(serverSaysAbsent(new ApiError(status, "x"))).toBe(true);
    for (const status of [401, 403, 500, 503]) expect(serverSaysAbsent(new ApiError(status, "x"))).toBe(false);
  });
});

describe("알림 메시지 줄", () => {
  const props = {
    source: "github",
    github_event: "pull_request",
    github_action: "opened",
    github_repository: "yeomyeonggeori/oort",
    github_url: "https://github.com/yeomyeonggeori/oort/pull/12",
  };

  it("서버가 보낸 GitHub 알림이면 줄의 재료를 만든다", () => {
    const notice = githubNoticeFor({ props }, GITHUB_AUTHOR);
    expect(notice).toEqual({
      repository: "yeomyeonggeori/oort",
      eventLabel: "PR",
      actionLabel: "열림",
      url: "https://github.com/yeomyeonggeori/oort/pull/12",
    });
    expect(githubNoticeLabel(notice!)).toBe("GitHub 알림, yeomyeonggeori/oort, PR 열림");
  });

  it("사람이 props 를 흉내 내도 줄이 서지 않는다 (작성자가 에이전트 GitHub 가 아님)", () => {
    expect(githubNoticeFor({ props }, { kind: "human", displayName: "GitHub" })).toBeNull();
    expect(githubNoticeFor({ props }, { kind: "agent", displayName: "Hermes" })).toBeNull();
    expect(githubNoticeFor({ props }, null)).toBeNull();
  });

  it("옛 서버에는 칸이 없어서 줄이 없다", () => {
    expect(githubNoticeFor({}, GITHUB_AUTHOR)).toBeNull();
    expect(githubNoticeFor({ props: { source: "hermes_gateway" } }, GITHUB_AUTHOR)).toBeNull();
  });

  it("모르는 이벤트와 모양이 틀린 저장소는 줄을 세우지 않는다", () => {
    expect(githubNoticeFor({ props: { ...props, github_event: "deployment" } }, GITHUB_AUTHOR)).toBeNull();
    expect(githubNoticeFor({ props: { ...props, github_repository: "no-slash" } }, GITHUB_AUTHOR)).toBeNull();
    expect(githubNoticeFor({ props: { ...props, github_repository: "a/b c" } }, GITHUB_AUTHOR)).toBeNull();
  });

  it("모르는 action 은 낱말 없이 서고, https 가 아닌 주소는 링크가 없다", () => {
    const notice = githubNoticeFor(
      { props: { ...props, github_action: "synchronize", github_url: "javascript:alert(1)" } },
      GITHUB_AUTHOR
    );
    expect(notice?.actionLabel).toBeNull();
    expect(notice?.url).toBeNull();
    expect(githubNoticeLabel(notice!)).toBe("GitHub 알림, yeomyeonggeori/oort, PR");
  });
});
