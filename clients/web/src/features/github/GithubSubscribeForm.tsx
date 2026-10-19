import { useId, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { cn } from "@/design/lib/cn";
import { subscribeGithub } from "@momo/core/features/github/api";
import {
  GITHUB_FEATURES,
  REPOSITORY_NAME_HINT,
  githubFailureMessage,
  installationSelectionSentence,
  isPrivateConfirmationRequired,
  needsPrivateConfirmation,
  normalizeRepositoryName,
  privateConfirmationSentence,
  repositoryInputMode,
  type GithubFeatureId,
  type GithubRepository,
  type GithubSubscription,
  type GithubWorkspaceOverview,
} from "@momo/core/features/github/model";
import { Field, SelectField } from "@/features/settings/SettingsFields";
import { githubOverviewPrefix } from "./githubQueries";

// =============================================================================
// 채널에 저장소를 구독하는 폼 (ADR-0205 D5·D6, 수용 11, #3955).
//
// 지키는 것 셋:
//   1. 비공개 확인 없이는 구독 요청 자체를 보내지 않는다. 판정은 코어의 `needsPrivateConfirmation`
//      이고, 서버가 마지막 말을 한다(같은 식이다). 확인 단계는 폼 아래 한 장면으로 서고,
//      그 장면에서만 `confirmPrivate: true` 가 나간다. 서버가 먼저 409 로 막으면(우리 눈에는
//      공개로 보였는데 서버는 아니라고 한 경우) 같은 확인 장면으로 간다.
//   2. 「모든 저장소」 설치에서는 저장소 목록을 믿지 않는다. `owner/repo` 를 직접 받고, 목록에 없는
//      이름은 공개 여부를 알 수 없어 비공개로 취급한다.
//   3. 받을 알림을 하나도 안 고른 채 보내지 않는다.
// =============================================================================

type Step = "form" | "confirm";

export function GithubSubscribeForm({
  workspaceId,
  channel,
  channelTitle,
  overview,
  offline,
  onSubscribed,
}: {
  workspaceId: string;
  channel: { id: string; kind: string };
  channelTitle: string;
  overview: GithubWorkspaceOverview;
  offline: boolean;
  onSubscribed?: (subscription: GithubSubscription) => void;
}) {
  const client = useQueryClient();
  const formId = useId();
  const usable = overview.installations.filter((installation) => !installation.suspended);
  const [installationId, setInstallationId] = useState<number | null>(usable[0]?.installationId ?? null);
  const installation =
    usable.find((candidate) => candidate.installationId === installationId) ?? usable[0];
  const mode = repositoryInputMode(installation);
  const [picked, setPicked] = useState("");
  const [typed, setTyped] = useState("");
  const [features, setFeatures] = useState<ReadonlySet<GithubFeatureId>>(
    () => new Set(overview.defaultFeatures)
  );
  const [step, setStep] = useState<Step>("form");
  const [message, setMessage] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  const repositories = installation?.repositories ?? [];
  const repositoryName =
    mode === "pick" ? (picked === "" ? null : picked) : normalizeRepositoryName(typed);
  // 목록에 있는 저장소만 공개 여부를 안다. 직접 친 이름이 목록에 있으면 그 사실을 쓴다.
  const known: GithubRepository | null =
    repositoryName === null
      ? null
      : (repositories.find((repo) => repo.fullName.toLowerCase() === repositoryName.toLowerCase()) ?? null);

  const subscribe = useMutation({
    mutationFn: (confirmPrivate: boolean) =>
      subscribeGithub(workspaceId, {
        channelId: channel.id,
        installationId: installation?.installationId ?? 0,
        repository: repositoryName ?? "",
        features: [...features],
        ...(confirmPrivate ? { confirmPrivate: true } : {}),
      }),
    onSuccess: (subscription) => {
      void client.invalidateQueries({ queryKey: githubOverviewPrefix(workspaceId) });
      setStep("form");
      setMessage(null);
      setPicked("");
      setTyped("");
      setDone(`${subscription.repository} 구독을 추가했어요.`);
      onSubscribed?.(subscription);
    },
    onError: (error) => {
      if (isPrivateConfirmationRequired(error)) {
        // 서버가 먼저 막았다: 같은 확인 장면으로 간다. 오류 문장을 따로 세우지 않는다.
        setStep("confirm");
        setMessage(null);
        return;
      }
      setMessage(githubFailureMessage("subscribe", error));
    },
  });

  const busy = subscribe.isPending;

  function toggle(id: GithubFeatureId, on: boolean) {
    setDone(null);
    setFeatures((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function submit() {
    if (busy || offline || installation === undefined) return;
    setDone(null);
    setMessage(null);
    if (repositoryName === null) {
      setFieldError(mode === "pick" ? "구독할 저장소를 골라 주세요." : REPOSITORY_NAME_HINT);
      return;
    }
    setFieldError(null);
    if (features.size === 0) {
      setMessage("받을 알림을 하나 이상 골라 주세요.");
      return;
    }
    if (needsPrivateConfirmation(channel.kind, known)) {
      // 요청을 보내지 않는다. 확인 장면으로만 간다 (수용 11).
      setStep("confirm");
      requestAnimationFrame(() => confirmRef.current?.focus({ preventScroll: false }));
      return;
    }
    subscribe.mutate(false);
  }

  if (installation === undefined) return null;

  const optional = overview.features.filter((id) => GITHUB_FEATURES[id].optional);
  const regular = overview.features.filter((id) => !GITHUB_FEATURES[id].optional);

  return (
    <form
      className="flex min-w-0 flex-col gap-3"
      data-testid="github-subscribe-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (step === "form") submit();
      }}
    >
      {usable.length > 1 && (
        <SelectField
          id={`${formId}-installation`}
          label="GitHub 계정"
          value={String(installation.installationId)}
          choices={usable.map((candidate) => ({
            id: String(candidate.installationId),
            label: `${candidate.accountLogin} (${installationSelectionSentence(candidate.repositorySelection)})`,
          }))}
          onChange={(id) => {
            setInstallationId(Number(id));
            setPicked("");
            setTyped("");
            setStep("form");
          }}
          disabled={busy || step === "confirm"}
          testId="github-subscribe-installation"
        />
      )}

      {mode === "pick" ? (
        <SelectField
          id={`${formId}-repo`}
          label="저장소"
          value={picked}
          choices={[
            { id: "", label: "저장소를 골라 주세요" },
            ...repositories.map((repo) => ({
              id: repo.fullName,
              label: repo.private ? `${repo.fullName} (비공개)` : repo.fullName,
            })),
          ]}
          onChange={(id) => {
            setPicked(id);
            setStep("form");
            setFieldError(null);
            setDone(null);
          }}
          disabled={busy || step === "confirm"}
          hint={fieldError ?? undefined}
          hintTone={fieldError ? "danger" : "muted"}
          testId="github-subscribe-repo"
        />
      ) : (
        <Field
          label="저장소 (owner/repo)"
          htmlFor={`${formId}-repo`}
          hint={
            installation.repositorySelection === "all"
              ? "「모든 저장소」로 설치돼 있어서 목록 대신 이름을 직접 적어요. 공개인지 알 수 없어 비공개로 취급해요."
              : "이 설치가 알려 준 저장소 목록이 비어 있어요. 이름을 직접 적어 주세요."
          }
          error={fieldError}
        >
          <Input
            id={`${formId}-repo`}
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value);
              setStep("form");
              setFieldError(null);
              setDone(null);
            }}
            placeholder="yeomyeonggeori/oort"
            autoComplete="off"
            spellCheck={false}
            disabled={busy || step === "confirm"}
            data-testid="github-subscribe-repo-input"
          />
        </Field>
      )}

      <fieldset className="flex min-w-0 flex-col gap-2" disabled={busy || step === "confirm"}>
        <legend className="pb-1 text-meta text-ink-muted">받을 알림</legend>
        <ul className="flex min-w-0 flex-col" data-testid="github-subscribe-features">
          {[...regular, ...optional].map((id) => {
            const copy = GITHUB_FEATURES[id];
            const inputId = `${formId}-feature-${id}`;
            return (
              <li key={id} className="border-b border-line last:border-b-0">
                <label
                  htmlFor={inputId}
                  className="tap-target press flex min-w-0 cursor-pointer items-start gap-2 py-2 hover:bg-surface-hover"
                >
                  <input
                    id={inputId}
                    type="checkbox"
                    checked={features.has(id)}
                    onChange={(event) => toggle(id, event.target.checked)}
                    className="mt-1 accent-accent focus-visible:focus-ring"
                    data-testid={`github-feature-${id}`}
                  />
                  <span className="flex min-w-0 flex-col gap-px">
                    <span className="text-body text-ink">
                      {copy.label}
                      {copy.optional && (
                        <span className="ml-2 text-meta text-ink-muted">선택</span>
                      )}
                    </span>
                    <span className="break-keep text-meta text-ink-muted">{copy.detail}</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      {step === "confirm" && repositoryName !== null && (
        <div
          className="flex min-w-0 flex-col gap-3 rounded-md border border-warn p-3"
          role="alertdialog"
          aria-labelledby={`${formId}-confirm-title`}
          aria-describedby={`${formId}-confirm-body`}
          data-testid="github-private-confirm"
        >
          <p id={`${formId}-confirm-title`} className="text-body font-semibold text-ink">
            공개 채널에 비공개일 수 있는 저장소를 연결해요
          </p>
          <p id={`${formId}-confirm-body`} className="break-keep text-body text-ink">
            {privateConfirmationSentence(channelTitle, repositoryName)}
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setStep("form");
                setMessage(null);
              }}
              disabled={busy}
              data-testid="github-private-cancel"
            >
              취소
            </Button>
            <Button
              ref={confirmRef}
              type="button"
              size="sm"
              aria-busy={busy || undefined}
              onClick={() => {
                if (busy || offline) return;
                subscribe.mutate(true);
              }}
              data-testid="github-private-accept"
            >
              {busy ? "저장 중" : "확인했어요, 구독하기"}
            </Button>
          </div>
        </div>
      )}

      {message !== null && (
        <p className="break-keep text-meta text-danger" role="alert" data-testid="github-subscribe-error">
          {message}
        </p>
      )}
      {done !== null && (
        <p className="break-keep text-meta text-ink" role="status" data-testid="github-subscribe-done">
          {done}
        </p>
      )}

      {step === "form" && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {offline && <p className="text-meta text-ink-muted">연결이 끊겨 있어서 지금은 구독할 수 없어요.</p>}
          <Button
            type="submit"
            size="sm"
            aria-disabled={offline || undefined}
            aria-busy={busy || undefined}
            className={cn(offline && "opacity-50")}
            data-testid="github-subscribe-submit"
          >
            {busy ? "저장 중" : "구독하기"}
          </Button>
        </div>
      )}
    </form>
  );
}
