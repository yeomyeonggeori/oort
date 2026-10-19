import { useId, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { InlineBanner, Skeleton } from "@/features/common/States";
import {
  linkInstallationToWorkspace,
  pasteGithubApp,
  startGithubManifest,
  type GithubOwnerChoice,
} from "@momo/core/features/github/api";
import {
  GITHUB_DOWNTIME_SENTENCE,
  GITHUB_PERMISSIONS_SENTENCE,
  GITHUB_RECEIVE_FAILED_NEXT,
  GITHUB_RECEIVE_FAILED_SENTENCE,
  githubFailureMessage,
  installationSelectionSentence,
  isGithubUnavailable,
  permissionLabels,
  type GithubAppStatus,
  type GithubManifestStart,
  type GithubUnlinkedInstallation,
} from "@momo/core/features/github/model";
import { formatDay, isOperatorDenied } from "@momo/core/features/settings/model";
import { serverSaysAbsent } from "@momo/core/features/capabilities/serverSurfaces";
import { isDesktop } from "@/lib/tauri";
import {
  ChoiceRadios,
  ConfirmButton,
  Field,
  KeyValueRows,
  SelectField,
  StatusChip,
  Subsection,
} from "@/features/settings/SettingsFields";
import {
  githubAppStatusKey,
  githubOverviewPrefix,
  githubUnlinkedKey,
  useGithubAppStatus,
  useUnlinkedInstallations,
} from "./githubQueries";

// =============================================================================
// 운영자 구역 (ADR-0205 D2·D3·D7, #3955): 이 인스턴스의 GitHub 앱 하나와 「연결 안 된 설치」.
//
// 인스턴스 운영자(PLATFORM_ADMIN_EMAILS)만 서버가 열어 준다. 운영자가 아니면 403 이고, 이 구역은
// 아무것도 그리지 않는다(다른 계정의 설치 이름이 새지 않게 하는 것도 서버 몫이다). 이 구역이
// 자기 자리를 비우는 것은 「권한 없음」을 오류처럼 보이지 않게 하려는 것이다.
//
// 비밀은 두 가지가 지나간다. 둘 다 이 화면에서 한 번 쓰이고 사라진다:
//   · 앱 개인키·웹훅 비밀(붙여 넣기 폼): 상태에만 있고, 저장하면 비운다. 저장한 뒤에는 서버도
//     다시 보여 주지 않는다.
//   · 등록 폼의 매니페스트: 비밀이 아니다(앱 이름·권한·주소). GitHub로 보내는 일회용 폼이다.
// =============================================================================

export function GithubOperatorBlock({
  workspaceId,
  offline,
}: {
  workspaceId: string;
  offline: boolean;
}) {
  const status = useGithubAppStatus();
  if (status.isPending) {
    return <Skeleton ready={false} rows={2} />;
  }
  // 운영자가 아니거나(403) 이 서버에 표면이 없으면(404) 이 구역은 서지 않는다.
  if (isOperatorDenied(status.error) || serverSaysAbsent(status.error)) return null;
  // 키가 없는 서버(503)는 허브 머리가 이미 한 번 말한다. 두 번 말하지 않는다.
  if (isGithubUnavailable(status.error)) return null;
  if (status.isError || status.data === undefined) {
    return (
      <Subsection title="GitHub 앱">
        <InlineBanner
          message={githubFailureMessage("load", status.error)}
          actionLabel="다시 시도"
          onAction={() => void status.refetch()}
          testId="github-operator-error"
        />
      </Subsection>
    );
  }
  const data = status.data;
  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="github-operator">
      <Subsection
        title="GitHub 앱"
        lines={["인스턴스 운영자만 보여요. 서버마다 앱은 하나이고, 워크스페이스마다 이 앱을 설치해서 연결해요."]}
      >
        {data.configured && data.app !== null ? (
          <RegisteredApp status={data} />
        ) : (
          <RegisterApp status={data} offline={offline} />
        )}
      </Subsection>
      {data.configured && (
        <UnlinkedInstallations workspaceId={workspaceId} offline={offline} />
      )}
    </div>
  );
}

// ---- 등록된 앱 -----------------------------------------------------------------

function RegisteredApp({ status }: { status: GithubAppStatus }) {
  const app = status.app;
  if (app === null) return null;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="github-app-registered">
      <KeyValueRows
        rows={[
          { key: "앱", value: app.slug },
          { key: "만든 계정", value: `${app.ownerLogin} (${app.ownerType === "Organization" ? "조직" : "개인"})` },
          ...(app.createdAtMs > 0 ? [{ key: "만든 날", value: formatDay(app.createdAtMs) }] : []),
          { key: "받는 권한", value: permissionLabels(status.permissions).join(", "), prose: true },
        ]}
      />
      <p className="break-keep text-meta text-ink-muted">{GITHUB_PERMISSIONS_SENTENCE}</p>
      {status.publicAddressConfigured ? (
        <p className="break-keep text-meta text-ink-muted" data-testid="github-receive-ok">
          GitHub가 이 서버로 알림을 보낼 수 있어요. {GITHUB_DOWNTIME_SENTENCE}
        </p>
      ) : (
        <ReceiveFailed />
      )}
    </div>
  );
}

/** 「GitHub 수신 실패」 줄. 공개 주소가 없으면 GitHub 가 이 서버에 닿지 못한다(doctor 와 같은 말). */
export function ReceiveFailed() {
  return (
    <div
      className="flex min-w-0 flex-col gap-1 rounded-md border border-warn p-3"
      role="status"
      data-testid="github-receive-failed"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <StatusChip tone="warn">GitHub 수신 실패</StatusChip>
        <p className="min-w-0 break-keep text-body font-semibold text-ink">
          {GITHUB_RECEIVE_FAILED_SENTENCE}
        </p>
      </div>
      <p className="break-keep text-meta text-ink-muted">{GITHUB_RECEIVE_FAILED_NEXT}</p>
      <p className="break-keep text-meta text-ink-muted">{GITHUB_DOWNTIME_SENTENCE}</p>
    </div>
  );
}

// ---- 앱 만들기 -----------------------------------------------------------------

function RegisterApp({ status, offline }: { status: GithubAppStatus; offline: boolean }) {
  const formId = useId();
  const [ownerType, setOwnerType] = useState<"user" | "organization">("organization");
  const [organization, setOrganization] = useState("");
  const [orgError, setOrgError] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<GithubManifestStart | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const noAddress = !status.publicAddressConfigured;

  const start = useMutation({
    mutationFn: (owner: GithubOwnerChoice) => startGithubManifest(owner),
    onSuccess: (started) => {
      setMessage(null);
      setHandoff(started);
    },
    onError: (error) => setMessage(githubFailureMessage("register", error)),
  });

  function submit() {
    if (start.isPending || offline || noAddress) return;
    setMessage(null);
    if (ownerType === "organization") {
      const org = organization.trim();
      if (!/^[A-Za-z0-9-]{1,39}$/.test(org)) {
        setOrgError("조직 이름은 영문, 숫자, 하이픈으로 적어 주세요. 예: yeomyeonggeori");
        return;
      }
      setOrgError(null);
      start.mutate({ ownerType: "organization", organization: org });
      return;
    }
    setOrgError(null);
    start.mutate({ ownerType: "user" });
  }

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="github-app-register">
      {noAddress && <ReceiveFailed />}
      <p className="break-keep text-body text-ink-muted">
        아직 이 서버에는 GitHub 앱이 없어요. 만들면 GitHub 화면이 열리고, 이름과 권한이 미리 채워져 있어요.
        {" "}{GITHUB_PERMISSIONS_SENTENCE}
      </p>
      <form
        className="flex min-w-0 flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <ChoiceRadios
          name={`${formId}-owner`}
          legend="앱을 만들 계정"
          value={ownerType}
          onChange={(id) => {
            setOwnerType(id === "user" ? "user" : "organization");
            setHandoff(null);
          }}
          choices={[
            { id: "organization", label: "조직", detail: "팀이 쓰는 GitHub 조직 아래에 만들어요. 권장해요." },
            { id: "user", label: "개인 계정", detail: "내 GitHub 계정 아래에 만들어요." },
          ]}
          busy={start.isPending}
          testId="github-owner-choice"
        />
        {ownerType === "organization" && (
          <Field label="조직 이름" htmlFor={`${formId}-org`} error={orgError}>
            <Input
              id={`${formId}-org`}
              value={organization}
              onChange={(event) => {
                setOrganization(event.target.value);
                setOrgError(null);
                setHandoff(null);
              }}
              placeholder="yeomyeonggeori"
              autoComplete="off"
              spellCheck={false}
              data-testid="github-org-input"
            />
          </Field>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="submit"
            size="sm"
            aria-disabled={offline || noAddress || undefined}
            aria-busy={start.isPending || undefined}
            className={offline || noAddress ? "opacity-50" : undefined}
            data-testid="github-register-start"
          >
            {start.isPending ? "준비 중" : "GitHub 앱 만들기"}
          </Button>
        </div>
      </form>
      {message !== null && <InlineBanner message={message} testId="github-register-error" />}
      {handoff !== null && <ManifestHandoff handoff={handoff} />}
      <PasteApp offline={offline} />
    </div>
  );
}

/**
 * GitHub 로 넘어가는 일회용 폼. 매니페스트는 비밀이 아니다. 서버가 준 주소(github.com 의 https)
 * 로만 POST 하고(코어가 검증한다), 새 탭에서 열어 이 화면을 지키지 않는다: GitHub 가 끝나면
 * 서버가 이 앱으로 돌려보낸다.
 */
function ManifestHandoff({ handoff }: { handoff: GithubManifestStart }) {
  const minutes = Math.max(1, Math.round(handoff.expiresInSeconds / 60));
  // 데스크탑 셸은 새 창으로 POST 폼을 열 수 없다(`target="_blank"` 가 죽은 컨트롤). 브라우저에서 한다.
  if (isDesktop()) {
    return (
      <p
        className="break-keep rounded-md border border-line p-3 text-body text-ink"
        data-testid="github-manifest-desktop"
        role="status"
      >
        데스크탑 앱에서는 GitHub 앱 만들기를 열 수 없어요. 웹 브라우저로 이 서버에 들어와 같은 화면에서 만들어 주세요.
      </p>
    );
  }
  return (
    <form
      method="post"
      action={handoff.registrationUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex min-w-0 flex-col gap-2 rounded-md border border-line p-3"
      data-testid="github-manifest-handoff"
    >
      <input type="hidden" name="manifest" value={JSON.stringify(handoff.manifest)} />
      <p className="break-keep text-body text-ink">
        준비됐어요. GitHub에서 「Create GitHub App」을 눌러 마치면 이 서버로 돌아와요.
      </p>
      <p className="break-keep text-meta text-ink-muted">{minutes}분 안에 마쳐야 해요.</p>
      <div className="flex justify-end">
        <Button type="submit" size="sm" data-testid="github-manifest-submit">
          GitHub에서 앱 만들기
        </Button>
      </div>
    </form>
  );
}

// ---- 이미 만든 앱 붙여 넣기 ------------------------------------------------------

function PasteApp({ offline }: { offline: boolean }) {
  const client = useQueryClient();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [ownerType, setOwnerType] = useState<"User" | "Organization">("Organization");
  const appId = useRef<HTMLInputElement | null>(null);
  const slug = useRef<HTMLInputElement | null>(null);
  const clientId = useRef<HTMLInputElement | null>(null);
  const ownerLogin = useRef<HTMLInputElement | null>(null);
  const privateKey = useRef<HTMLTextAreaElement | null>(null);
  const webhookSecret = useRef<HTMLInputElement | null>(null);

  const paste = useMutation({
    mutationFn: pasteGithubApp,
    onSuccess: () => {
      // 비밀 칸을 비운다. 서버도 다시 보여 주지 않는다.
      if (privateKey.current) privateKey.current.value = "";
      if (webhookSecret.current) webhookSecret.current.value = "";
      setMessage(null);
      void client.invalidateQueries({ queryKey: githubAppStatusKey });
    },
    onError: (error) => setMessage(githubFailureMessage("paste", error)),
  });

  function submit() {
    if (paste.isPending || offline) return;
    const id = Number((appId.current?.value ?? "").trim());
    const values = {
      slug: (slug.current?.value ?? "").trim(),
      clientId: (clientId.current?.value ?? "").trim(),
      ownerLogin: (ownerLogin.current?.value ?? "").trim(),
      privateKey: privateKey.current?.value ?? "",
      webhookSecret: webhookSecret.current?.value ?? "",
    };
    if (!Number.isInteger(id) || id <= 0) {
      setFieldError("앱 ID는 숫자로 적어 주세요.");
      return;
    }
    if (Object.values(values).some((value) => value.trim() === "")) {
      setFieldError("모든 칸을 채워 주세요.");
      return;
    }
    setFieldError(null);
    setMessage(null);
    paste.mutate({ appId: id, ownerType, ...values });
  }

  return (
    <details
      className="min-w-0 rounded-md border border-line"
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      data-testid="github-paste"
    >
      <summary className="tap-target cursor-pointer px-3 py-2 text-body text-ink hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring">
        이미 만든 앱이 있어요
      </summary>
      <form
        className="flex min-w-0 flex-col gap-3 border-t border-line p-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p className="break-keep text-meta text-ink-muted">
          GitHub에서 직접 만든 앱의 정보를 붙여 넣어요. 개인키와 웹훅 비밀은 저장한 뒤에는 다시 볼 수 없어요.
        </p>
        <Field label="앱 ID" htmlFor={`${formId}-appid`}>
          <Input id={`${formId}-appid`} ref={appId} inputMode="numeric" autoComplete="off" data-testid="github-paste-app-id" />
        </Field>
        <Field label="앱 주소 이름 (slug)" htmlFor={`${formId}-slug`} hint="github.com/apps/ 뒤에 오는 이름이에요.">
          <Input id={`${formId}-slug`} ref={slug} autoComplete="off" spellCheck={false} data-testid="github-paste-slug" />
        </Field>
        <Field label="클라이언트 ID" htmlFor={`${formId}-client`}>
          <Input id={`${formId}-client`} ref={clientId} autoComplete="off" spellCheck={false} data-testid="github-paste-client-id" />
        </Field>
        <Field label="앱을 만든 계정" htmlFor={`${formId}-owner`}>
          <Input id={`${formId}-owner`} ref={ownerLogin} autoComplete="off" spellCheck={false} data-testid="github-paste-owner" />
        </Field>
        <SelectField
          id={`${formId}-owner-type`}
          label="계정 종류"
          value={ownerType}
          choices={[
            { id: "Organization", label: "조직" },
            { id: "User", label: "개인" },
          ]}
          onChange={(id) => setOwnerType(id === "User" ? "User" : "Organization")}
        />
        <Field label="개인키 (PEM)" htmlFor={`${formId}-pem`} hint="-----BEGIN ... 로 시작하는 전체를 붙여 넣어요.">
          <textarea
            id={`${formId}-pem`}
            ref={privateKey}
            rows={4}
            autoComplete="off"
            spellCheck={false}
            className="w-full min-w-0 rounded-lg border border-line-strong bg-surface-raised px-3 py-2 font-mono text-meta text-ink focus-visible:focus-ring"
            data-testid="github-paste-pem"
          />
        </Field>
        <Field label="웹훅 비밀" htmlFor={`${formId}-secret`}>
          <Input id={`${formId}-secret`} ref={webhookSecret} type="password" autoComplete="off" data-testid="github-paste-secret" />
        </Field>
        {fieldError !== null && (
          <p className="text-meta text-danger" role="alert">
            {fieldError}
          </p>
        )}
        {message !== null && <InlineBanner message={message} testId="github-paste-error" />}
        <div className="flex justify-end">
          <Button
            type="submit"
            size="sm"
            aria-disabled={offline || undefined}
            aria-busy={paste.isPending || undefined}
            data-testid="github-paste-submit"
          >
            {paste.isPending ? "저장 중" : "앱 저장"}
          </Button>
        </div>
      </form>
    </details>
  );
}

// ---- 연결 안 된 설치 -------------------------------------------------------------

function UnlinkedInstallations({ workspaceId, offline }: { workspaceId: string; offline: boolean }) {
  const client = useQueryClient();
  const unlinked = useUnlinkedInstallations(true);
  const [message, setMessage] = useState<string | null>(null);
  const attach = useMutation({
    mutationFn: (installationId: number) => linkInstallationToWorkspace(installationId, workspaceId),
    onSuccess: () => {
      setMessage(null);
      void client.invalidateQueries({ queryKey: githubUnlinkedKey });
      void client.invalidateQueries({ queryKey: githubOverviewPrefix(workspaceId) });
    },
    onError: (error) => setMessage(githubFailureMessage("operatorLink", error)),
  });

  return (
    <Subsection
      title="연결 안 된 설치"
      lines={[
        "GitHub에는 설치됐지만 어느 워크스페이스에도 붙지 않은 계정이에요. 한 GitHub 계정은 한 워크스페이스에만 붙어요.",
      ]}
    >
      {unlinked.isPending ? (
        <Skeleton ready={false} rows={2} />
      ) : unlinked.isError || unlinked.data === undefined ? (
        <InlineBanner
          message={githubFailureMessage("load", unlinked.error)}
          actionLabel="다시 시도"
          onAction={() => void unlinked.refetch()}
          testId="github-unlinked-error"
        />
      ) : unlinked.data.length === 0 ? (
        <p className="break-keep text-meta text-ink-muted" data-testid="github-unlinked-empty">
          연결을 기다리는 설치가 없어요.
        </p>
      ) : (
        <ul className="flex min-w-0 flex-col" data-testid="github-unlinked">
          {unlinked.data.map((installation) => (
            <UnlinkedRow
              key={installation.installationId}
              installation={installation}
              busy={attach.isPending && attach.variables === installation.installationId}
              offline={offline}
              onAttach={() => attach.mutate(installation.installationId)}
            />
          ))}
        </ul>
      )}
      {message !== null && <InlineBanner message={message} testId="github-unlinked-attach-error" />}
    </Subsection>
  );
}

function UnlinkedRow({
  installation,
  busy,
  offline,
  onAttach,
}: {
  installation: GithubUnlinkedInstallation;
  busy: boolean;
  offline: boolean;
  onAttach: () => void;
}) {
  return (
    <li
      className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line py-3 first:border-t"
      data-testid="github-unlinked-row"
    >
      <div className="flex min-w-0 basis-pane-sm flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 break-all text-body font-semibold text-ink">{installation.accountLogin}</span>
          <StatusChip tone="muted">{installation.accountType === "Organization" ? "조직" : "개인"}</StatusChip>
          {installation.suspended && <StatusChip tone="warn">멈춤</StatusChip>}
        </div>
        <p className="break-keep text-meta text-ink-muted">
          {installationSelectionSentence(installation.repositorySelection)} · 저장소 {installation.repositoryCount}개
        </p>
      </div>
      <ConfirmButton
        label="이 워크스페이스에 붙이기"
        subject={installation.accountLogin}
        question={`${installation.accountLogin} 계정을 이 워크스페이스에 붙일까요? 한 번 붙이면 다른 워크스페이스에서는 쓸 수 없어요.`}
        confirmLabel="붙이기"
        confirmDestructive={false}
        busy={busy}
        busyLabel="붙이는 중"
        disabled={offline}
        onConfirm={onAttach}
        testId="github-unlinked-attach"
      />
    </li>
  );
}
