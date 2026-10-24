// =============================================================================
// GitHub 알림: 와이어 모양, 문장, 그리고 두 가지 규칙 (ADR-0205 D10, U-GH1 #3955).
//
// 서버는 #3954(E-GH2)가 올린다. 이 파일은 그 라우트들의 계약을 옮긴 클라이언트 쪽 판정이고,
// 서버가 track/uxui에 아직 없는 동안에는 mock으로 맞춘다(runtime-unverified).
//
// ## 이 파일이 막으려는 것
//
//   1. 비공개 저장소가 공개 채널로 새는 것 (ADR-0205 수용 11). `needsPrivateConfirmation` 이
//      서버의 판정과 같은 식이다: 공개 채널이고, 비공개이거나 **공개라고 알 수 없으면** 확인이
//      필요하다. 확인 없이는 구독 요청 자체를 보내지 않는다(`confirmPrivate` 를 몰래 켜지 않는다).
//   2. 서버가 하지 않은 말을 화면이 지어내는 것. 상태 단어(`?githubInstall=`)와 오류 코드는
//      닫힌 세계다. 모르는 값은 문장을 만들지 않고 null/일반 문장으로 돌아간다.
//   3. 사람인 척하는 알림. 알림 줄은 「GitHub가 보낸 알림」이라고 말하고, 메시지의 작성자 id가
//      서버가 props 에 적은 `github_author_member_id` 와 같지 않으면 줄을 그리지 않는다(이름이 아니라 id다).
//
// 순수 모듈이다. 웹과 폰이 같은 함수를 부른다.
// =============================================================================

import { AI_EXTERNAL_BASE_PATH } from "../ai/aiHubModel";
import { isSurfaceProvided } from "../capabilities/serverSurfaces";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { arrayField, bool, num, record, str, WireShapeError } from "../../lib/wire";

/** 채널 ⋮ 메뉴의 항목 이름이자 구독 다이얼로그의 제목. */
export const CHANNEL_GITHUB_LABEL = "GitHub 알림";

/** AI › 외부 연결 › GitHub 알림 화면의 경로. 다른 곳에서 문자열로 다시 쓰지 않는다. */
export const GITHUB_PANE_PATH = `${AI_EXTERNAL_BASE_PATH}/github`;

// ---- 기능(알림 종류) ---------------------------------------------------------

export type GithubFeatureId =
  | "pulls"
  | "issues"
  | "reviews"
  | "comments"
  | "checks"
  | "commits"
  | "releases";

export interface GithubFeatureCopy {
  label: string;
  detail: string;
  /** 기본으로 꺼져 있는 선택 알림(ADR-0205 D6). */
  optional: boolean;
}

/** 서버 `GITHUB_FEATURES` 와 같은 일곱. 순서는 화면 순서다. */
export const GITHUB_FEATURES: Readonly<Record<GithubFeatureId, GithubFeatureCopy>> = {
  pulls: { label: "PR", detail: "열림, 닫힘, 병합, 리뷰 준비", optional: false },
  issues: { label: "이슈", detail: "열림, 닫힘", optional: false },
  reviews: { label: "리뷰", detail: "리뷰가 제출됐을 때", optional: true },
  comments: { label: "댓글", detail: "이슈와 PR의 새 댓글", optional: true },
  checks: { label: "체크 결과", detail: "체크가 끝났을 때", optional: true },
  commits: { label: "커밋", detail: "기본 브랜치에 push됐을 때", optional: true },
  releases: { label: "릴리스", detail: "릴리스가 게시됐을 때", optional: true },
};

export const GITHUB_FEATURE_IDS: readonly GithubFeatureId[] = [
  "pulls",
  "issues",
  "reviews",
  "comments",
  "checks",
  "commits",
  "releases",
];

export const GITHUB_DEFAULT_FEATURES: readonly GithubFeatureId[] = ["pulls", "issues"];

export function isGithubFeature(value: string): value is GithubFeatureId {
  return Object.prototype.hasOwnProperty.call(GITHUB_FEATURES, value);
}

/** 서버가 준 목록에서 아는 기능만 남긴다(닫힌 세계). 순서는 화면 순서로 바로잡는다. */
export function knownFeatures(values: readonly string[]): GithubFeatureId[] {
  const set = new Set(values);
  return GITHUB_FEATURE_IDS.filter((id) => set.has(id));
}

/** 구독 한 줄의 기능 요약: 「PR, 이슈, 커밋」. 비어 있으면 알림이 가지 않는다는 말이다. */
export function featuresSummary(features: readonly string[]): string {
  const known = knownFeatures(features);
  if (known.length === 0) return "받는 알림이 없어요";
  return known.map((id) => GITHUB_FEATURES[id].label).join(", ");
}

// ---- 와이어 -------------------------------------------------------------------

export interface GithubAppInfo {
  appId: number;
  slug: string;
  clientId: string;
  ownerLogin: string;
  ownerType: string;
  source: string;
  createdAtMs: number;
  rotationWindowOpen: boolean;
  installUrl: string;
}

export interface GithubAppStatus {
  masterKeyConfigured: boolean;
  /** false 면 GitHub 가 이 서버에 알림을 보낼 수 없다(공개 HTTPS 없음). */
  publicAddressConfigured: boolean;
  configured: boolean;
  app: GithubAppInfo | null;
  /** 권한 이름 → `read`. 서버가 매니페스트에 넣는 그대로다. */
  permissions: ReadonlyArray<{ name: string; access: string }>;
  events: readonly string[];
}

export interface GithubRepository {
  repoId: number;
  fullName: string;
  private: boolean;
}

export interface GithubInstallation {
  installationId: number;
  accountLogin: string;
  accountType: string;
  /** `all` 은 「모든 저장소」, `selected` 는 「선택한 저장소만」. */
  repositorySelection: string;
  suspended: boolean;
  repositories: GithubRepository[];
}

export interface GithubSubscription {
  id: string;
  channelId: string;
  installationId: number;
  repository: string;
  repoId: number | null;
  features: string[];
  active: boolean;
  privateConfirmed: boolean;
  /**
   * 채널이 공개가 됐고 저장소가 비공개일 수 있어서, 소유자·관리자가 다시 `confirmPrivate` 로 구독할
   * 때까지 서버가 알림을 보내지 않는다(#4084, ADR-0205 H-1). 옛 서버에는 칸이 없어 false 다.
   */
  needsReconfirm: boolean;
}

export interface GithubWorkspaceOverview {
  appRegistered: boolean;
  installations: GithubInstallation[];
  subscriptions: GithubSubscription[];
  features: GithubFeatureId[];
  defaultFeatures: GithubFeatureId[];
}

export interface GithubUnlinkedInstallation {
  installationId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  suspended: boolean;
  repositoryCount: number;
}

export interface GithubManifestStart {
  registrationUrl: string;
  manifest: Record<string, unknown>;
  expiresInSeconds: number;
}

export interface GithubLinkStart {
  installUrl: string;
  expiresInSeconds: number;
}

function requireString(source: unknown, key: string): string {
  const value = str(source, key);
  if (value === undefined) throw new WireShapeError();
  return value;
}

function requireNumber(source: unknown, key: string): number {
  const value = num(source, key);
  if (value === undefined) throw new WireShapeError();
  return value;
}

function requireBool(source: unknown, key: string): boolean {
  const value = bool(source, key);
  if (value === undefined) throw new WireShapeError();
  return value;
}

function strings(source: unknown, key: string): string[] {
  const values = arrayField(source, key) ?? [];
  return values.filter((value): value is string => typeof value === "string");
}

function own<T>(table: Readonly<Record<string, T>>, key: string | undefined): T | undefined {
  return key !== undefined && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** 알림 링크가 열 수 있는 곳: github.com 과 그 하위 호스트의 https 뿐이다(서버 props 를 흉내 내도 낯선 호스트로 가지 않게). */
export function safeGithubUrl(value: string | undefined | null): string | null {
  const url = safeHttpsUrl(value);
  if (url === null) return null;
  const host = new URL(url).hostname;
  return host === "github.com" || host.endsWith(".github.com") ? url : null;
}

/** https 로 시작하고 계정 정보가 없는 주소만 사람 눈앞의 링크가 된다. */
export function safeHttpsUrl(value: string | undefined | null): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  return parsed.toString();
}

export function parseAppStatus(raw: unknown): GithubAppStatus {
  const source = record(raw);
  if (source === null) throw new WireShapeError();
  const appSource = record(source.app);
  const app: GithubAppInfo | null =
    appSource === null
      ? null
      : {
          appId: requireNumber(appSource, "appId"),
          slug: requireString(appSource, "slug"),
          clientId: requireString(appSource, "clientId"),
          ownerLogin: requireString(appSource, "ownerLogin"),
          ownerType: requireString(appSource, "ownerType"),
          source: str(appSource, "source") ?? "",
          createdAtMs: num(appSource, "createdAtMs") ?? 0,
          rotationWindowOpen: bool(appSource, "rotationWindowOpen") ?? false,
          installUrl: str(appSource, "installUrl") ?? "",
        };
  const permissions = Object.entries(record(source.permissions) ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, access]) => ({ name, access }));
  return {
    masterKeyConfigured: requireBool(source, "masterKeyConfigured"),
    publicAddressConfigured: requireBool(source, "publicAddressConfigured"),
    configured: requireBool(source, "configured"),
    app,
    permissions,
    events: strings(source, "events"),
  };
}

function parseRepository(raw: unknown): GithubRepository {
  return {
    repoId: requireNumber(raw, "repoId"),
    fullName: requireString(raw, "fullName"),
    // 모르면 비공개로 읽는다. 서버 판정(알 수 없으면 비공개)과 같은 방향이다.
    private: bool(raw, "private") ?? true,
  };
}

function parseInstallation(raw: unknown): GithubInstallation {
  return {
    installationId: requireNumber(raw, "installationId"),
    accountLogin: requireString(raw, "accountLogin"),
    accountType: str(raw, "accountType") ?? "",
    repositorySelection: str(raw, "repositorySelection") ?? "selected",
    suspended: bool(raw, "suspended") ?? false,
    repositories: (arrayField(raw, "repositories") ?? []).map(parseRepository),
  };
}

export function parseSubscription(raw: unknown): GithubSubscription {
  return {
    id: requireString(raw, "id"),
    channelId: requireString(raw, "channelId"),
    installationId: requireNumber(raw, "installationId"),
    repository: requireString(raw, "repository"),
    repoId: num(raw, "repoId") ?? null,
    features: strings(raw, "features"),
    active: bool(raw, "active") ?? true,
    privateConfirmed: bool(raw, "privateConfirmed") ?? false,
    needsReconfirm: bool(raw, "needsReconfirm") ?? false,
  };
}

export function parseWorkspaceOverview(raw: unknown): GithubWorkspaceOverview {
  const source = record(raw);
  if (source === null) throw new WireShapeError();
  const features = knownFeatures(strings(source, "features"));
  const defaults = knownFeatures(strings(source, "defaultFeatures"));
  return {
    appRegistered: requireBool(source, "appRegistered"),
    installations: (arrayField(source, "installations") ?? []).map(parseInstallation),
    subscriptions: (arrayField(source, "subscriptions") ?? []).map(parseSubscription),
    // 서버가 목록을 안 주면(옛 빌드) 우리가 아는 일곱과 기본 둘로 돌아간다.
    features: features.length > 0 ? features : [...GITHUB_FEATURE_IDS],
    defaultFeatures: defaults.length > 0 ? defaults : [...GITHUB_DEFAULT_FEATURES],
  };
}

export function parseUnlinkedInstallations(raw: unknown): GithubUnlinkedInstallation[] {
  return (arrayField(raw, "installations") ?? []).map((item) => ({
    installationId: requireNumber(item, "installationId"),
    accountLogin: requireString(item, "accountLogin"),
    accountType: str(item, "accountType") ?? "",
    repositorySelection: str(item, "repositorySelection") ?? "selected",
    suspended: bool(item, "suspended") ?? false,
    repositoryCount: num(item, "repositoryCount") ?? 0,
  }));
}

/**
 * 매니페스트 등록 폼을 GitHub 로 보낼 주소. 서버가 `https://github.com/...` 을 준다.
 * 다른 호스트나 http 를 주면 폼을 만들지 않는다: 운영자의 브라우저가 낯선 곳으로 POST 하지 않게.
 */
export function parseManifestStart(raw: unknown): GithubManifestStart {
  const source = record(raw);
  if (source === null) throw new WireShapeError();
  const registrationUrl = safeHttpsUrl(str(source, "registrationUrl"));
  const manifest = record(source.manifest);
  if (registrationUrl === null || manifest === null) throw new WireShapeError();
  if (new URL(registrationUrl).hostname !== "github.com") throw new WireShapeError();
  return {
    registrationUrl,
    manifest,
    expiresInSeconds: num(source, "expiresInSeconds") ?? 3600,
  };
}

export function parseLinkStart(raw: unknown): GithubLinkStart {
  const source = record(raw);
  if (source === null) throw new WireShapeError();
  const installUrl = safeHttpsUrl(str(source, "installUrl"));
  if (installUrl === null || new URL(installUrl).hostname !== "github.com") {
    throw new WireShapeError();
  }
  return { installUrl, expiresInSeconds: num(source, "expiresInSeconds") ?? 600 };
}

// ---- 비공개 저장소 확인 (수용 11) ----------------------------------------------

export type GithubChannelKind = "public" | "private" | "dm";

/**
 * 이 구독에 「비공개 저장소를 공개 채널에 연결해요」 확인이 필요한가.
 *
 * 서버의 식과 같다: 공개 채널이고, 저장소가 비공개이거나 **목록에 없어서 공개인지 알 수 없을
 * 때**. `repo === null` 이 그 경우다(「모든 저장소」 설치에서 직접 `owner/repo` 를 친 저장소).
 * 알 수 없으면 비공개로 취급한다.
 */
export function needsPrivateConfirmation(
  channelKind: GithubChannelKind | string,
  repo: Pick<GithubRepository, "private"> | null
): boolean {
  return channelKind === "public" && (repo === null || repo.private);
}

/**
 * 확인 단계에서 읽어 주는 경고 문장. 알려진 비공개와 「공개인지 알 수 없음」을 가르고, 고른 알림 종류를
 * 그대로 말한다(PR·이슈만이 아니라 커밋·댓글·릴리스도 채널의 모든 사람에게 간다).
 */
export function privateConfirmationSentence(
  channelName: string,
  repository: string,
  knownPrivate: boolean,
  features: readonly string[]
): string {
  const kinds = knownFeatures(features).map((id) => GITHUB_FEATURES[id].label).join(", ");
  const status = knownPrivate
    ? "비공개 저장소예요."
    : "공개인지 확인되지 않은 저장소라서 비공개로 봐요.";
  return (
    `${repository}는 ${status} ` +
    `${channelName} 채널은 공개 채널이라, 이 채널의 모든 사람이 ${kinds} 소식을 보게 돼요.`
  );
}

// ---- `owner/repo` 입력 ---------------------------------------------------------

const OWNER_PATTERN = /^[A-Za-z0-9-]{1,39}$/;
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** 서버의 `is_repository_name` 과 같은 모양. 맞으면 다듬은 이름, 아니면 null. */
export function normalizeRepositoryName(raw: string): string | null {
  const value = raw.trim();
  const parts = value.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!OWNER_PATTERN.test(owner) || !NAME_PATTERN.test(name)) return null;
  if (name === "." || name === "..") return null;
  return value;
}

export const REPOSITORY_NAME_HINT = "owner/repo 모양으로 적어 주세요. 예: yeomyeonggeori/oort";

/**
 * 구독 화면이 저장소를 어떻게 받는가.
 *
 * - 「선택한 저장소만」 설치이고 목록이 있으면: 목록에서 고른다.
 * - 「모든 저장소」 설치이거나 목록이 비어 있으면: `owner/repo` 를 입력받는다. 서버가 첫 이벤트에서
 *   `repo_id` 를 채우고, 그 전까지는 공개 여부를 알 수 없어 비공개로 취급한다.
 */
export type RepositoryInputMode = "pick" | "type";

export function repositoryInputMode(installation: GithubInstallation | undefined): RepositoryInputMode {
  if (installation === undefined) return "pick";
  if (installation.repositorySelection === "all") return "type";
  return installation.repositories.length === 0 ? "type" : "pick";
}

export function installationSelectionSentence(selection: string): string {
  return selection === "all" ? "모든 저장소" : "선택한 저장소만";
}

// ---- 흩어진 문장 ---------------------------------------------------------------

/** doctor 와 같은 말. 공개 HTTPS 가 없으면 GitHub 가 이 서버로 알림을 보낼 수 없다. */
export const GITHUB_RECEIVE_FAILED_SENTENCE = "공개 주소가 없어 GitHub 알림을 받을 수 없어요";

/** 숨기지 않는 사실: GitHub 는 놓친 알림을 다시 보내 주지 않는다(ADR-0205 귀결). */
export const GITHUB_DOWNTIME_SENTENCE =
  "서버가 내려가 있는 동안 GitHub가 보낸 알림은 사라지고, 다시 오지 않아요.";

export const GITHUB_RECEIVE_FAILED_NEXT =
  "MOMO_PUBLIC_BASE_URL에 이 서버의 공개 HTTPS 주소를 정하면 받을 수 있어요.";

/**
 * 권한 한 문장. 코드 읽기(contents)를 받는 까닭과 oort 가 코드를 읽지 않는 것을 같은 줄에서 말한다:
 * 「받아요」와 「읽지 않아요」를 따로 두면 서로 어긋나 보인다(#4333). 서버 매니페스트의 description
 * (`momo-settings` `build_manifest`)과 같은 뜻이다.
 */
export const GITHUB_PERMISSIONS_SENTENCE =
  "읽기 권한 다섯 줄을 받아요: 메타데이터, 이슈, PR, 체크, 코드(contents). 쓰기 권한은 없어요. 코드 읽기는 push·release 알림을 받으려는 것이고, oort 서버는 알림을 위해 코드를 읽지 않아요.";

/** GitHub 앱 만들기 안내 곳곳에서 같은 말로 예고한다(GitHub 의 sudo mode, #4333). */
export const GITHUB_IDENTITY_CHECK_SENTENCE =
  "GitHub가 본인 확인을 한 번 요구할 수 있어요. GitHub Mobile, 인증 앱, 이메일 코드 중 하나로 확인해 주세요.";

/** 조직 이름 칸의 예시. 칸 안에서는 「예: 」가 붙어 값이 아니라 예시로 읽힌다. */
export const GITHUB_ORG_EXAMPLE = "my-team";

export const GITHUB_ORG_EMPTY_SENTENCE = "조직 이름을 적어 주세요.";

/**
 * 조직 이름(GitHub 로그인)이 무엇이 틀렸는지 한 줄로. 맞으면 null. 서버 `is_valid_org_login` 과 같은
 * 규칙(영문·숫자·하이픈, 1~39자, 하이픈으로 시작·끝 금지)이다. 오류 문장에는 예시를 쓰지 않는다:
 * 예시가 칸의 예시 글자와 같으면 무엇이 틀렸는지 알 수 없다(#4333).
 */
export function githubOrgProblem(raw: string): string | null {
  const org = raw.trim();
  if (org === "") return GITHUB_ORG_EMPTY_SENTENCE;
  if (org.length > 39) {
    return `조직 이름은 39자까지예요. 지금 ${org.length}자예요.`;
  }
  const bad = org.match(/[^A-Za-z0-9-]/u);
  if (bad !== null) {
    const shown = bad[0] === " " ? "공백" : `「${bad[0]}」`;
    return `조직 이름에 ${shown}은 쓸 수 없어요. 영문, 숫자, 하이픈(-)만 쓸 수 있어요. 주소가 아니라 이름만 적어 주세요.`;
  }
  if (org.startsWith("-") || org.endsWith("-")) {
    return "조직 이름은 하이픈(-)으로 시작하거나 끝날 수 없어요.";
  }
  return null;
}

export const GITHUB_SELECTED_ONLY_ADVICE =
  "설치할 때 「선택한 저장소만」을 고르길 권해요. 알림이 필요한 저장소만 이 앱에 보여요.";

const PERMISSION_LABEL: Readonly<Record<string, string>> = {
  metadata: "메타데이터",
  issues: "이슈",
  pull_requests: "PR",
  checks: "체크",
  contents: "코드(contents)",
};

/** 서버가 보낸 권한 이름을 사람 말로. 모르는 이름은 그대로 두지 않고 버린다(닫힌 세계). */
export function permissionLabels(
  permissions: ReadonlyArray<{ name: string; access: string }>
): string[] {
  return permissions
    .flatMap((permission) => {
      const label = own(PERMISSION_LABEL, permission.name);
      return label === undefined ? [] : [label];
    });
}

// ---- 돌아오는 길의 상태 단어 ----------------------------------------------------

export type GithubReturnKind = "install" | "app";

export interface GithubReturnSentence {
  /** `ok` 는 끝났다는 말, `wait` 는 아직 한 걸음 남았다는 말, `stop` 은 막혔다는 말. */
  tone: "ok" | "wait" | "stop";
  sentence: string;
  /** 사람이 이어서 할 일이 있으면 어디서 하는지. */
  next?: string;
}

const INSTALL_WORDS: Readonly<Record<string, GithubReturnSentence>> = {
  linked: { tone: "ok", sentence: "GitHub 계정이 이 워크스페이스에 연결됐어요." },
  pending: {
    tone: "wait",
    sentence: "설치를 받았어요. GitHub 쪽 확인이 끝나면 연결돼요.",
    next: "잠시 뒤 이 화면을 새로고침해 보세요.",
  },
  requested: {
    tone: "wait",
    sentence: "조직 소유자에게 설치를 요청했어요.",
    next: "소유자가 설치하면 서버를 관리하는 분이 이 워크스페이스에 붙여요. GitHub 화면의 「연결 안 된 설치」에서 해요.",
  },
  linked_elsewhere: {
    tone: "stop",
    sentence: "이 GitHub 계정의 설치는 이미 다른 워크스페이스에 연결돼 있어요.",
    next: "한 계정은 한 워크스페이스에만 연결돼요. 그 워크스페이스에서 연결을 끊거나, 다른 GitHub 계정으로 설치해 주세요.",
  },
  state_missing: {
    tone: "wait",
    sentence: "GitHub가 연결 정보를 돌려주지 않았어요.",
    next: "서버를 관리하는 분이 「연결 안 된 설치」에서 이 워크스페이스에 붙여 줘야 해요.",
  },
  state_invalid: {
    tone: "stop",
    sentence: "연결 시간이 지났거나 이미 쓴 연결이에요.",
    next: "「GitHub 연결」을 다시 눌러 주세요.",
  },
  not_admin: {
    tone: "stop",
    sentence: "소유자와 관리자만 GitHub를 연결할 수 있어요.",
  },
  invalid_request: {
    tone: "stop",
    sentence: "GitHub에서 돌아온 주소를 읽지 못했어요.",
    next: "「GitHub 연결」을 다시 눌러 주세요.",
  },
};

const APP_WORDS: Readonly<Record<string, GithubReturnSentence>> = {
  created: { tone: "ok", sentence: "GitHub 앱을 만들었어요. 이제 워크스페이스마다 연결할 수 있어요." },
  already_registered: { tone: "ok", sentence: "이 서버에는 이미 GitHub 앱이 있어요." },
  not_operator: {
    tone: "stop",
    sentence: "인스턴스 운영자만 GitHub 앱을 만들 수 있어요.",
  },
  state_invalid: {
    tone: "stop",
    sentence: "등록 시간이 지났거나 이미 쓴 등록이에요.",
    next: "「GitHub 앱 만들기」를 다시 눌러 주세요.",
  },
  invalid_request: {
    tone: "stop",
    sentence: "GitHub에서 돌아온 주소를 읽지 못했어요.",
    next: "「GitHub 앱 만들기」를 다시 눌러 주세요.",
  },
  owner_mismatch: {
    tone: "stop",
    sentence: "고른 계정과 다른 계정으로 앱이 만들어졌어요. 앱을 저장하지 않았어요.",
    next: "GitHub에서 만든 앱을 지우고, 올바른 계정으로 다시 만들어 주세요.",
  },
  convert_code_rejected: {
    tone: "stop",
    sentence: "GitHub가 등록 코드를 받아 주지 않았어요. 한 시간 안에 마쳐야 해요.",
    next: "「GitHub 앱 만들기」를 다시 눌러 주세요.",
  },
  convert_unreachable: {
    tone: "stop",
    sentence: "서버가 GitHub에 닿지 못했어요.",
    next: "서버의 바깥 연결을 확인한 뒤 다시 만들어 주세요.",
  },
  convert_invalid_response: {
    tone: "stop",
    sentence: "GitHub의 답을 읽지 못했어요.",
    next: "잠시 뒤 다시 만들어 주세요.",
  },
  seal_failed: {
    tone: "stop",
    sentence: "앱 정보를 안전하게 저장하지 못했어요.",
    next: "서버의 GITHUB_APP_MASTER_KEY 설정을 확인해 주세요.",
  },
  store_failed: {
    tone: "stop",
    sentence: "앱 정보를 저장하지 못했어요.",
    next: "잠시 뒤 다시 만들어 주세요.",
  },
};

/** 닫힌 세계: 모르는 단어는 null 이고, 화면은 아무 말도 하지 않는다. */
export function githubReturnSentence(
  kind: GithubReturnKind,
  word: string
): GithubReturnSentence | null {
  const table = kind === "install" ? INSTALL_WORDS : APP_WORDS;
  return Object.prototype.hasOwnProperty.call(table, word) ? table[word] : null;
}

/**
 * 로그인 안 된 브라우저의 착지(#4220)가 바꿔 읽는 말. 데스크탑에서 시작한 일이 시스템 브라우저에서
 * 끝나면 그 브라우저에는 앱 화면도 워크스페이스도 없다. 로그인된 화면을 가리키는 말(「이 화면」
 * 「새로고침」「이 워크스페이스」)만 이 페이지에서도 맞는 말로 바꾸고, 판정(톤)과 닫힌 단어 집합은
 * 건드리지 않는다.
 *
 * 앱 쪽 `seal_failed` 는 일부러 그대로 둔다: 데스크탑에서 시작한 등록은 이 브라우저에서 끝나서, 운영자가
 * 그 이유(서버 키 설정)를 알 곳이 여기뿐이다. 환경 변수 이름은 비밀이 아니다.
 */
const PUBLIC_OVERRIDES: Readonly<
  Record<GithubReturnKind, Readonly<Record<string, { sentence?: string; next?: string }>>>
> = {
  install: {
    linked: { sentence: "GitHub 계정이 워크스페이스에 연결됐어요." },
    pending: { next: "잠시 뒤 oort 앱의 GitHub 화면에서 연결됐는지 확인해 보세요." },
    requested: {
      next: "소유자가 설치하면 서버를 관리하는 분이 oort 앱 GitHub 화면의 「연결 안 된 설치」에서 워크스페이스에 붙여요.",
    },
    state_missing: {
      next: "서버를 관리하는 분이 oort 앱 GitHub 화면의 「연결 안 된 설치」에서 워크스페이스에 붙여 줘야 해요.",
    },
  },
  app: {},
};

/**
 * 로그인 안 된 브라우저의 착지가 읽는 문장. 모르는 단어는 `githubReturnSentence` 와 같이 null 이다.
 * 판정(톤)은 늘 같다.
 */
export function githubPublicReturnSentence(
  kind: GithubReturnKind,
  word: string
): GithubReturnSentence | null {
  const base = githubReturnSentence(kind, word);
  if (base === null) return null;
  const table = PUBLIC_OVERRIDES[kind];
  const changed = Object.prototype.hasOwnProperty.call(table, word) ? table[word] : undefined;
  return changed === undefined ? base : { ...base, ...changed };
}

/**
 * 주소에서 돌아온 단어를 꺼낸다. 아는 단어 하나만 돌려주고, 나머지는 null.
 * `search` 는 `window.location.search` 의 값이다.
 */
export function githubReturnFromSearch(
  search: string
): { kind: GithubReturnKind; word: string } | null {
  const params = new URLSearchParams(search);
  const install = params.get("githubInstall");
  if (install !== null && githubReturnSentence("install", install) !== null) {
    return { kind: "install", word: install };
  }
  const app = params.get("githubApp");
  if (app !== null && githubReturnSentence("app", app) !== null) {
    return { kind: "app", word: app };
  }
  return null;
}

/** 돌아온 단어를 주소에서 지운 `search` (문서 주소를 깨끗하게 되돌릴 때). */
export function searchWithoutGithubReturn(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("githubInstall");
  params.delete("githubApp");
  const rest = params.toString();
  return rest === "" ? "" : `?${rest}`;
}

// ---- 오류 문장 ------------------------------------------------------------------

export type GithubAction =
  | "load"
  | "register"
  | "paste"
  | "operatorLink"
  | "link"
  | "subscribe"
  | "unsubscribe";

const ACTION_PREFIX: Readonly<Record<GithubAction, string>> = {
  load: "GitHub 정보를 읽지 못했어요.",
  register: "GitHub 앱 만들기를 시작하지 못했어요.",
  paste: "GitHub 앱을 저장하지 못했어요.",
  operatorLink: "설치를 연결하지 못했어요.",
  link: "GitHub 연결을 시작하지 못했어요.",
  subscribe: "구독을 저장하지 못했어요.",
  unsubscribe: "구독을 해제하지 못했어요.",
};

const CODE_SENTENCE: Readonly<Record<string, string>> = {
  public_address_required: `${GITHUB_RECEIVE_FAILED_SENTENCE}. ${GITHUB_RECEIVE_FAILED_NEXT}`,
  github_app_not_registered:
    "이 서버에는 아직 GitHub 앱이 없어요. 서버를 관리하는 분이 먼저 앱을 만들어야 해요.",
  github_app_already_registered: "이 서버에는 이미 GitHub 앱이 있어요.",
  github_installation_linked_elsewhere:
    "이 GitHub 계정의 설치는 이미 다른 워크스페이스에 연결돼 있어요. 한 계정은 한 워크스페이스에만 연결돼요.",
  repository_not_in_installation:
    "이 설치에서 볼 수 있는 저장소가 아니에요. GitHub에서 설치에 저장소를 더한 뒤 다시 골라 주세요.",
};

/** 서버가 막았다고 이름 붙여 답한 코드인가. */
export function githubErrorCode(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code : undefined;
}

/** 비공개 저장소 확인이 필요하다고 서버가 답한 409 인가. */
export function isPrivateConfirmationRequired(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.code === "private_repository_requires_confirmation"
  );
}

/** 이 서버에 GitHub 연결 키가 없다(503). 운영자가 서버 설정을 마쳐야 한다. */
export function isGithubUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 503;
}

export const GITHUB_UNAVAILABLE_SENTENCE =
  "이 서버는 GitHub 연결 설정이 아직 끝나지 않았어요. 서버를 관리하는 분께 알려 주세요.";

/** 운영자 구역에서만 쓰는 같은 말: 무엇을 해야 하는지까지 적는다. */
export const GITHUB_UNAVAILABLE_OPERATOR_SENTENCE =
  "이 서버에는 GITHUB_APP_MASTER_KEY가 없어서 GitHub 연결을 쓸 수 없어요. 서버 설정에 키를 넣어 주세요.";

/**
 * 오류를 한 문장으로. 서버가 준 문장은 옮기지 않는다: 코드는 우리 문장으로, 상태는 일반 문장으로.
 * `NetworkError` 의 문장만 그대로 쓴다(이 패키지가 쓴 문장이고 전송 쪽 말만 담는다).
 */
export function githubFailureMessage(action: GithubAction, error: unknown): string {
  const prefix = ACTION_PREFIX[action];
  if (error instanceof NetworkError) return `${prefix} ${error.message}`;
  if (error instanceof ApiError) {
    const named = own(CODE_SENTENCE, error.code);
    if (named !== undefined) return named;
    if (error.status === 403) return `${prefix} 소유자나 관리자만 할 수 있어요.`;
    if (error.status === 503) return GITHUB_UNAVAILABLE_SENTENCE;
    if (error.status === 400) return `${prefix} 입력한 값을 확인해 주세요.`;
    if (error.status === 404) return `${prefix} 대상을 찾지 못했어요. 목록을 새로 불러 주세요.`;
    if (error.status === 429) return `${prefix} 잠시 뒤에 다시 시도해 주세요.`;
    return `${prefix} 서버가 답하지 못했어요. 잠시 뒤에 다시 시도해 주세요.`;
  }
  if (error instanceof WireShapeError) {
    return `${prefix} 서버 응답을 확인하지 못했어요. 다시 불러 주세요.`;
  }
  return `${prefix} 잠시 뒤에 다시 시도해 주세요.`;
}

// ---- 앱 카드의 두 얼굴 ------------------------------------------------------------

export interface GithubFace {
  id: "notify" | "tools";
  /** 칩에 쓰는 문장. Drive 두 칩과 같은 문법: 「이름 · 범위 · 누가 하는가」. */
  chip: string;
  /** 칩 아래 한 줄 설명. */
  detail: string;
}

/**
 * 「앱」 화면의 GitHub 카드가 말하는 두 얼굴 (ADR-0205 D10). 레지스트리 매니페스트는 바꾸지 않는다:
 * 이 두 칩은 화면이 그리는 것이고, 알림 쪽은 서버가 GitHub 알림 표면을 싣는지에 달려 있다.
 */
export const GITHUB_FACES: readonly GithubFace[] = [
  {
    id: "notify",
    chip: "알림 · 팀 전체 · oort 서버가 받아요",
    detail: "저장소의 PR, 이슈, 체크 소식이 채널로 와요. 앱은 서버에 한 번만 설치해요.",
  },
  {
    id: "tools",
    chip: "도구 · 각자 에이전트",
    detail: "GitHub를 읽고 쓰는 일은 각자의 에이전트가 자기 권한으로 해요.",
  },
];

export const GITHUB_PLUGIN_ID = "com.momo.plugins.github";

export function isGithubPlugin(pluginId: string): boolean {
  return pluginId.toLowerCase() === GITHUB_PLUGIN_ID;
}

/**
 * 이 앱 카드가 말할 얼굴들. GitHub 가 아니면 없다. 알림 얼굴은 서버가 GitHub 알림 표면을 실을 때만
 * 서고(`githubNotifications`), 도구 얼굴은 알림 표면과 무관하게 이 카드의 원래 모습이라 늘 있다.
 */
export function githubFacesFor(pluginId: string): readonly GithubFace[] {
  if (!isGithubPlugin(pluginId)) return [];
  return isSurfaceProvided("githubNotifications")
    ? GITHUB_FACES
    : GITHUB_FACES.filter((face) => face.id !== "notify");
}

/** 폰은 알림 구독을 하지 않는다(웹의 일). 알림 얼굴 곁에 그 사실을 한 문장으로 말한다. */
export const GITHUB_PHONE_NOTE = "알림 연결과 구독은 웹이나 데스크탑에서 해요.";

// ---- 알림 메시지 -------------------------------------------------------------------

export interface GithubNotice {
  repository: string;
  /** 「PR」 「이슈」 처럼 어떤 소식인가. */
  eventLabel: string;
  /** 「열림」 처럼 무슨 일이 있었나. 모르는 action 이면 null. */
  actionLabel: string | null;
  /** 열 수 있는 https 주소. 없으면 null. */
  url: string | null;
}

const EVENT_LABEL: Readonly<Record<string, string>> = {
  pull_request: "PR",
  pull_request_review: "리뷰",
  issues: "이슈",
  issue_comment: "댓글",
  check_suite: "체크",
  push: "커밋",
  release: "릴리스",
};

const ACTION_LABEL: Readonly<Record<string, string>> = {
  opened: "열림",
  reopened: "다시 열림",
  closed: "닫힘",
  ready_for_review: "리뷰 준비",
  submitted: "제출",
  created: "새 댓글",
  completed: "끝남",
  published: "게시",
};

const REPOSITORY_SHAPE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * 메시지가 서버가 보낸 GitHub 알림이면 그 줄의 재료, 아니면 null.
 *
 * `props` 는 사람이 보낸 메시지에도 실을 수 있어서 `source` 만으로는 알림이 아니다. 서버가 줄과 함께
 * 내려 주는 `github_author_member_id`(워크스페이스의 시스템 작성자 「GitHub」)가 메시지의 작성자 id와
 * 같을 때만 줄이 선다(#4084). 표시 이름은 증거가 아니다: 누구나 「GitHub」라는 이름을 쓸 수 있다.
 * 서버가 내려 주지 않은 칸(옛 서버)에서는 늘 null이라 화면 변화 0이다.
 */
export function githubNoticeFor(message: {
  authorMemberId?: string | null | undefined;
  props?: Record<string, unknown> | undefined;
}): GithubNotice | null {
  const props = message.props;
  if (props === undefined || props === null) return null;
  if (props.source !== "github") return null;
  const authorId = message.authorMemberId;
  const claimed = str(props, "github_author_member_id");
  if (typeof authorId !== "string" || authorId === "") return null;
  if (claimed === undefined || claimed.toLowerCase() !== authorId.toLowerCase()) return null;
  const repository = str(props, "github_repository");
  if (repository === undefined || !REPOSITORY_SHAPE.test(repository)) return null;
  const event = str(props, "github_event");
  const eventLabel = own(EVENT_LABEL, event);
  if (eventLabel === undefined) return null;
  const action = str(props, "github_action");
  return {
    repository,
    eventLabel,
    actionLabel: own(ACTION_LABEL, action) ?? null,
    url: safeGithubUrl(str(props, "github_url")),
  };
}

/** 줄의 낭독 문장: 「GitHub 알림, yeomyeonggeori/oort, PR 열림」. */
export function githubNoticeLabel(notice: GithubNotice): string {
  const what = notice.actionLabel === null ? notice.eventLabel : `${notice.eventLabel} ${notice.actionLabel}`;
  return `GitHub 알림, ${notice.repository}, ${what}`;
}

/**
 * 다시 확인이 필요한 구독의 확인 문장. 채널이 공개가 됐고 저장소가 비공개일 수 있다는 사실과,
 * 확인하기 전까지 알림이 가지 않는다는 사실을 함께 말한다.
 */
export function reconfirmSentence(
  channelName: string,
  repository: string,
  features: readonly string[]
): string {
  const kinds = knownFeatures(features).map((id) => GITHUB_FEATURES[id].label).join(", ");
  return (
    `${channelName} 채널이 공개 채널이 됐어요. 비공개일 수 있는 저장소: ${repository}. ` +
    `다시 확인하면 이 채널의 모든 사람이 ${kinds === "" ? "알림" : kinds} 소식을 보게 돼요.`
  );
}

/** 다시 확인을 받은 구독을 `confirmPrivate` 로 다시 구독하는 요청. 고른 것을 그대로 옮긴다. */
export function reconfirmInput(subscription: GithubSubscription): {
  channelId: string;
  installationId: number;
  repository: string;
  features: string[];
  confirmPrivate: true;
} {
  return {
    channelId: subscription.channelId,
    installationId: subscription.installationId,
    repository: subscription.repository,
    features: [...subscription.features],
    confirmPrivate: true,
  };
}
