import { forwardRef, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import {
  COHOSTED_MODEL_COPY as COPY,
  fetchCohostedModels,
  hasHiddenModels,
  modelLabel,
  modelOptions,
  modelsLoadErrorMessage,
  modelSaveErrorMessage,
  modelValue,
  providerLabel,
  putCohostedModel,
  splitModelValue,
  type CohostedModelRef,
  type CohostedModels,
  type CohostedModelsRead,
} from "@momo/core/features/settings/cohostedModels";
import { Button } from "@/design/ui/button";
import { ListboxSelect } from "@/design/ui/listbox-select";
import { InlineBanner } from "@/features/common/States";
import { AiLineRow } from "./aiAccountsParts";

// Reading this as: AI hub › 같은 서버의 Hermes › 모델 (instance operator only) for internal team users on
// web+Tauri, density 6/10, motion 1/10.

const HEADING_ID = "ai-cohosted-model-title";
const SAVED_NOTICE_MS = 4000;
const LEAD_ID = "ai-cohosted-model-lead";

export const cohostedModelsKey = (workspaceId: string) => ["cohosted-models", workspaceId] as const;

/** 허브 카드와 이 구획이 같은 질문을 나눈다(한 번 읽은 답을 다시 부르지 않는다). */
export function useCohostedModels(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: cohostedModelsKey(workspaceId),
    queryFn: () => fetchCohostedModels(workspaceId),
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** 로그인된 제공자 슬러그(서버는 Hermes가 `authenticated` 로 표시한 제공자만 보낸다). 못 읽었으면 null. */
export function loggedInFrom(read: CohostedModelsRead | undefined): ReadonlySet<string> | null {
  return read?.kind === "ready" ? new Set(read.models.providers.map((entry) => entry.provider)) : null;
}

/**
 * 「모델」 구획 (#4145 / ADR-0203 증보 2026-10-20). 연결된 Hermes가 지금 어느 모델로 답하는지 한 줄로 말하고,
 * 로그인된 제공자의 추린 모델에서 바꿀 수 있다. 저장은 고르는 즉시다(`PUT …/cohosted-agent/model`): 서버가 목록을 다시 읽어
 * 확인하므로 화면은 서버가 돌려준 값을 쓴다. 목록 밖 값은 서버가 422 로 막는다.
 *
 * 보임은 서버 답이다: 운영자가 아니면(403) 아무것도 그리지 않는다.
 * `invite` 는 방금 연결한 직후다: 제목 대신 「어떤 모델로 쓸까요?」 를 묻는다.
 */
export const CohostedModelSection = forwardRef<HTMLDivElement, { workspaceId: string; offline: boolean; invite: boolean }>(
  function CohostedModelSection({ workspaceId, offline, invite }, ref) {
    const models = useCohostedModels(workspaceId);
    const read = models.data;
    // 이 서버에서 보이지 않는 구획(운영자 아님·길 없음)은 초점을 받을 빈 상자도 남기지 않는다.
    if (read?.kind === "hidden") return null;
    return (
      <div
        ref={ref}
        tabIndex={-1}
        role="group"
        aria-labelledby={HEADING_ID}
        className="focus-visible:focus-ring"
        data-testid="ai-cohosted-model-anchor"
      >
        {models.isPending ? (
          <Shell invite={invite}>
            <div role="status" aria-live="polite" className="px-2 py-3 text-body text-ink-muted" data-testid="ai-cohosted-model-loading">
              {COPY.loading}
            </div>
          </Shell>
        ) : models.isError || read?.kind === "unknown" ? (
          <Shell invite={invite}>
            <InlineBanner
              message={modelsLoadErrorMessage(read?.kind === "unknown" ? read.code : null)}
              actionLabel={COPY.retry}
              onAction={() => void models.refetch()}
              testId="ai-cohosted-model-error"
            />
          </Shell>
        ) : read?.kind === "ready" ? (
          <ModelBody workspaceId={workspaceId} models={read.models} offline={offline} invite={invite} />
        ) : null}
      </div>
    );
  }
);

function Shell({ invite, children }: { invite: boolean; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col pt-4" aria-labelledby={HEADING_ID} data-testid="ai-cohosted-model">
      <h4 id={HEADING_ID} className="border-b border-line pb-2 text-body font-bold text-ink">
        {invite ? COPY.askFirst : COPY.title}
      </h4>
      {children}
    </section>
  );
}

function ModelBody({
  workspaceId,
  models,
  offline,
  invite,
}: {
  workspaceId: string;
  models: CohostedModels;
  offline: boolean;
  invite: boolean;
}) {
  const client = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const [savedOn, setSavedOn] = useState(false);
  const current = models.current;

  const save = useMutation({
    mutationFn: (choice: CohostedModelRef) => putCohostedModel(workspaceId, choice),
    onSuccess: (saved) => {
      // 서버가 돌려준 값이 정본이다. 목록은 같은 모양에서 현재만 바꿔 제자리에 둔다.
      client.setQueryData<CohostedModelsRead>(cohostedModelsKey(workspaceId), (old) =>
        old?.kind === "ready"
          ? {
              kind: "ready",
              models: {
                ...old.models,
                current: saved,
                pinned: true,
                providers: old.models.providers.map((entry) => ({
                  ...entry,
                  models: entry.models.map((m) => ({ ...m, current: entry.provider === saved.provider && m.id === saved.model })),
                })),
              },
            }
          : old
      );
      setSavedOn(true);
    },
    onError: () => {
      // 422 는 목록이 낡았다는 뜻이다: 다시 읽어 서버의 지금 모양으로 돌아온다.
      void client.invalidateQueries({ queryKey: cohostedModelsKey(workspaceId) });
    },
  });

  useEffect(() => {
    if (!savedOn) return;
    const timer = window.setTimeout(() => setSavedOn(false), SAVED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [savedOn]);

  const shown = save.isPending && save.variables ? save.variables : current;
  const options = useMemo(
    () =>
      modelOptions(models, showAll, shown).map((option) => ({
        value: option.value,
        label: modelLabel(option.model),
        hint: providerLabel(option.provider),
      })),
    [models, showAll, shown]
  );
  const hidden = hasHiddenModels(models, shown);
  const locked = offline || save.isPending;

  if (models.providers.length === 0) {
    return (
      <Shell invite={invite}>
        <AiLineRow last testId="ai-cohosted-model-none">
          <span className="text-meta text-ink-muted">{COPY.noneLoggedIn}</span>
        </AiLineRow>
      </Shell>
    );
  }

  return (
    <Shell invite={invite}>
      <AiLineRow last testId="ai-cohosted-model-current">
        <span id={LEAD_ID} className="text-meta text-ink-muted">
          {COPY.currentLead}
        </span>
        {/* 고른 모델은 선택 칸이 한 번만 말한다(#4161). 정한 모델이 없을 때만 문장이 선다. */}
        {!shown && (
          <span className="font-semibold" data-testid="ai-cohosted-model-now">
            {COPY.followingHermes}
          </span>
        )}
        <span className="flex min-w-0 flex-col items-start gap-2 pt-1">
          {/* 저장 알림 자리는 늘 있다: 나타나도 아래 줄이 밀리지 않고, 읽는 영역이 처음부터 마운트돼 있어야 스크린리더가 말한다. */}
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 self-stretch">
            <span className="min-w-0 flex-1 sm:max-w-sm sm:flex-none">
              <ListboxSelect
                aria-labelledby={LEAD_ID}
                data-testid="ai-cohosted-model-select"
                value={shown ? modelValue(shown) : ""}
                placeholder={COPY.placeholder}
                options={options}
                disabled={locked}
                onValueChange={(next) => {
                  const choice = splitModelValue(next);
                  if (choice === null || locked) return;
                  if (current && current.provider === choice.provider && current.model === choice.model) return;
                  setSavedOn(false);
                  save.mutate(choice);
                }}
              />
            </span>
            <span role="status" className="flex min-h-6 min-w-0 items-center text-meta" data-testid="ai-cohosted-model-status">
              {save.isPending ? (
                <span className="flex items-center gap-2 text-ink-muted" data-testid="ai-cohosted-model-saving">
                  <Loader2 aria-hidden="true" className="spinner-busy size-4" />
                  {COPY.saving}
                </span>
              ) : savedOn ? (
                <span className="flex items-center gap-2 font-semibold text-ok" data-testid="ai-cohosted-model-saved">
                  <Check aria-hidden="true" className="size-4 shrink-0" />
                  {COPY.saved}
                </span>
              ) : null}
            </span>
          </span>
          {(hidden || showAll) && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="tap-target -ml-3 underline underline-offset-4"
              aria-pressed={showAll}
              onClick={() => setShowAll((on) => !on)}
              data-testid="ai-cohosted-model-toggle"
            >
              {showAll ? COPY.showFeatured : COPY.showAll}
            </Button>
          )}
        </span>
        {save.isError && <InlineBanner message={modelSaveErrorMessage(save.error)} testId="ai-cohosted-model-save-error" />}
        {offline && <InlineBanner tone="neutral" message={COPY.offline} testId="ai-cohosted-model-offline" />}
        <span className="text-meta text-ink-muted">{COPY.teamNote}</span>
      </AiLineRow>
    </Shell>
  );
}
