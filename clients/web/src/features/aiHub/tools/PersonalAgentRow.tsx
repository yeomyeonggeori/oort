import { useId, useState } from "react";
import type { LocalHarnessId } from "@momo/core/features/hostedAgents/detect";
import {
  PERSONAL_AGENT_COPY as COPY,
  PERSONAL_HARNESS_WIRE,
  normalizePersonalAlias,
  personalAgentErrorLine,
  personalAliasValid,
  type PersonalAgentSummary,
} from "@momo/core/features/ai/harnessCard";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { Switch } from "@/design/ui/switch";
import { PersonalAgentError, type PersonalAgentPort } from "./personalAgentPort";

/** 한 하네스의 개인 에이전트 읽기 값. 서버에 라우트가 없으면 `unavailable`, 못 읽으면 `error`. */
export type PersonalRead = "loading" | "unavailable" | "error" | "ok";

export interface PersonalAgentRowProps {
  harness: LocalHarnessId;
  /** 도구 이름(카드 제목과 같다). */
  title: string;
  read: PersonalRead;
  /** 이 하네스의 내 개인 에이전트(꺼 둔 것 포함). 없으면 null. */
  agent: PersonalAgentSummary | null;
  port: PersonalAgentPort;
  /** 켜기·끄기가 끝나면 목록을 다시 읽는다. */
  onChanged: () => void;
  offline: boolean;
}

/**
 * 「개인 에이전트로 쓰기」 (ADR-0198 증보 1 D7). 켜기: 스위치 → 별칭 입력 → 「개인
 * 에이전트 켜기」. 끄기: 스위치를 끄면 멤버가 비활성이 된다(별칭은 예약돼 있어 같은 별칭으로
 * 다시 켜면 같은 멤버가 돌아온다). 서버 거절은 그 자리에서 말한다.
 */
export function PersonalAgentRow({ harness, read, agent, port, onChanged, offline }: PersonalAgentRowProps) {
  const labelId = useId();
  const hintId = useId();
  const aliasId = useId();
  const switchId = useId();
  // 폼의 단추가 사라질 때 초점이 body로 떨어지지 않게 스위치로 돌려 준다.
  const refocusSwitch = () => window.setTimeout(() => document.getElementById(switchId)?.focus(), 0);
  const [composing, setComposing] = useState(false);
  const [alias, setAlias] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = agent?.enabled === true;
  const testId = `tool-card-${harness}`;

  const fail = (caught: unknown) => {
    const code = caught instanceof PersonalAgentError ? caught.code : null;
    setError(personalAgentErrorLine(code));
    // 이미 있다거나 못 찾았다면 화면이 낡은 것이다: 목록을 다시 읽는다.
    if (code === "personal_agent_exists" || code === "personal_agent_not_found") onChanged();
  };

  const submit = async () => {
    const normalized = normalizePersonalAlias(alias);
    if (!personalAliasValid(normalized)) {
      setError(COPY.aliasInvalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await port.enable(PERSONAL_HARNESS_WIRE[harness], normalized);
      setComposing(false);
      setAlias("");
      onChanged();
      refocusSwitch();
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    if (!agent) return;
    setBusy(true);
    setError(null);
    try {
      await port.disable(agent.id);
      onChanged();
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-2 border-t border-line pt-3" data-testid={`${testId}-personal`} data-read={read}>
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span
            id={labelId}
            className={cn("break-keep text-body", read === "unavailable" ? "text-ink-muted" : "text-ink")}
          >
            {COPY.toggleLabel}
          </span>
          <span id={hintId} className="break-keep text-meta text-ink-muted">
            {read === "unavailable"
              ? COPY.unavailable
              : read === "error"
                ? COPY.loadFailed
                : offline
                  ? COPY.offlineHint
                  : on
                    ? `${agent?.label ?? ""} ${COPY.badgeHint}`.trim()
                    : agent
                      ? COPY.off
                      : COPY.toggleHint}
          </span>
        </div>
        {read === "ok" || read === "loading" ? (
          <Switch
            checked={on || composing}
            disabled={read === "loading" || busy || offline}
            id={switchId}
            labelledBy={labelId}
            describedBy={hintId}
            testId={`${testId}-personal-switch`}
            onCheckedChange={(next) => {
              setError(null);
              if (next) {
                // 꺼 둔 에이전트가 있으면 그 별칭으로 바로 다시 켠다.
                if (agent && !agent.enabled) {
                  setBusy(true);
                  port
                    .enable(PERSONAL_HARNESS_WIRE[harness], agent.handle)
                    .then(() => onChanged())
                    .catch(fail)
                    .finally(() => setBusy(false));
                  return;
                }
                setComposing(true);
              } else if (composing && !on) {
                setComposing(false);
              } else {
                void turnOff();
              }
            }}
          />
        ) : read === "error" ? (
          <Button type="button" size="sm" variant="outline" className="tap-target" onClick={onChanged} data-testid={`${testId}-personal-retry`}>
            {COPY.retry}
          </Button>
        ) : null}
      </div>

      {composing && !on && (
        <form
          className="flex min-w-0 flex-col gap-2"
          data-testid={`${testId}-alias-form`}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor={aliasId} className="text-meta text-ink-muted">
            {COPY.aliasLabel}
          </label>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Input
              id={aliasId}
              value={alias}
              onChange={(event) => {
                setAlias(event.target.value);
                setError(null);
              }}
              placeholder={harness === "claude" ? "my-claude" : "my-codex"}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={error !== null}
              aria-describedby={error ? `${aliasId}-hint ${aliasId}-error` : `${aliasId}-hint`}
              autoFocus
              className="min-w-0 flex-1 font-mono sm:max-w-xs"
              data-testid={`${testId}-alias-input`}
            />
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              className="tap-target"
              disabled={busy || alias.trim() === ""}
              data-testid={`${testId}-alias-submit`}
            >
              {COPY.enable}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="tap-target"
              disabled={busy}
              onClick={() => {
                setComposing(false);
                setError(null);
                refocusSwitch();
              }}
              data-testid={`${testId}-alias-cancel`}
            >
              {COPY.cancel}
            </Button>
          </div>
          <p id={`${aliasId}-hint`} className="break-keep text-meta text-ink-muted">
            {COPY.aliasHint}
          </p>
        </form>
      )}

      {error && (
        <p
          id={`${aliasId}-error`}
          className="break-keep text-meta text-danger"
          role="alert"
          data-testid={`${testId}-personal-error`}
        >
          {error}
        </p>
      )}
    </div>
  );
}
